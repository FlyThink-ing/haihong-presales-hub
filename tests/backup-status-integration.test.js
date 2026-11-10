import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createApp } from "../server/app.js";
import { resetUserPassword } from "../server/auth-service.js";
import { createDatabase } from "../server/database.js";
import { createBackup, startDailyBackupScheduler, verifyBackupBatch } from "../server/backup-service.js";
import { getBackupStatusStore, initializeBackupStatusStore } from "../server/backup-status-service.js";
import { completeResetLogin, setupBase } from "./test-utils.js";

const admin = { role: "ADMIN", active: true, mustChangePassword: false };
function completedResult() {
  const batchId = "backup-20260903T010000000Z-ab12cd34";
  return { batchId, manifest: { batchId, status: "COMPLETE", validation: {
    completed: true, databaseReadable: true, quickCheck: "ok", foreignKeyErrors: 0, referencedFiles: 0, filesVerified: 0
  } } };
}

async function httpFixture(t) {
  const f = setupBase();
  const logs = [];
  const sessions = new Map();
  for (const actor of [f.admin, f.manager, f.salesA, f.vp]) {
    const temporary = `${randomBytes(18).toString("base64url")}aA1!`;
    resetUserPassword(f.db, f.admin, actor.id, temporary);
    sessions.set(actor.id, completeResetLogin(f.db, actor.username, temporary));
  }
  const server = createApp({ db: f.db, config: { sessionHours: 1, secureCookie: false }, logger: { error(message) { logs.push(message); } } }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); f.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...f, logs, async request(actor, route = "/api/admin/backup-status", method = "GET") {
    const session = actor ? sessions.get(actor.id) : null;
    const response = await fetch(`${base}${route}`, { method, headers: session ? {
      cookie: `hh_session=${session.token}`, "x-csrf-token": session.csrfToken
    } : {} });
    return { status: response.status, headers: response.headers, body: await response.json() };
  } };
}

test("真实 HTTP 状态只对已改密管理员开放，健康接口仍只表示存活且没有网页写入入口", async t => {
  const f = await httpFixture(t);
  const store = initializeBackupStatusStore(f.db);
  store.completeRun(store.startRun("MANUAL"), completedResult());
  const before = f.db.prepare("SELECT total_changes() AS total").get().total;
  const response = await f.request(f.admin);
  assert.equal(response.status, 200);
  assert.equal(response.body.lastSuccess.kind, "MANUAL");
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(f.db.prepare("SELECT total_changes() AS total").get().total, before);
  for (const actor of [f.manager, f.salesA, f.vp]) {
    const denied = await f.request(actor);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "BACKUP_STATUS_FORBIDDEN");
    assert.equal(denied.body.lastSuccess, undefined);
  }
  assert.equal((await f.request(null)).status, 401);
  const health = await f.request(null, "/api/health");
  assert.deepEqual(health.body, { ok: true, service: "haihong-presales-hub" });
  assert.equal((await f.request(f.admin, "/api/admin/backup-status", "POST")).status, 404);
  assert.equal((await f.request(f.admin, "/api/admin/backup-status", "DELETE")).status, 404);
  f.db.prepare("UPDATE users SET must_change_password = 1 WHERE id = ?").run(f.admin.id);
  const restricted = await f.request(f.admin);
  assert.equal(restricted.status, 403);
  assert.equal(restricted.body.error.code, "PASSWORD_CHANGE_REQUIRED");
});

test("旧库初始化失败仍能服务；只读 GET 返回明确503且不偷偷建表，后台重试后幂等恢复", async t => {
  const f = await httpFixture(t);
  f.db.pragma("query_only = ON");
  assert.throws(() => initializeBackupStatusStore(f.db), { code: "BACKUP_STATUS_WRITE_FAILED" });
  f.db.pragma("query_only = OFF");
  const tables = () => f.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'backup_%' ORDER BY name").all();
  assert.deepEqual(tables(), []);
  const uncertain = await f.request(f.admin);
  assert.equal(uncertain.status, 503);
  assert.equal(uncertain.body.error.code, "BACKUP_STATUS_UNAVAILABLE");
  assert.match(uncertain.body.error.message, /不表示备份成功/);
  assert.deepEqual(tables(), []);
  assert.equal((await f.request(f.admin, "/api/customer-dictionaries")).status, 200);
  assert.deepEqual((await f.request(null, "/api/health")).body, { ok: true, service: "haihong-presales-hub" });
  const store = initializeBackupStatusStore(f.db);
  assert.equal(initializeBackupStatusStore(f.db), store);
  assert.equal((await f.request(f.admin)).status, 200);
  f.db.exec("DROP TABLE backup_scheduler_status");
  const unreadable = await f.request(f.admin);
  assert.equal(unreadable.status, 503);
  assert.equal(unreadable.body.error.code, "BACKUP_STATUS_READ_FAILED");
  assert.doesNotMatch(JSON.stringify(unreadable.body) + f.logs.join(" "), /SQLITE|readonly|no such table|backup_scheduler_status|\.sqlite|stack/i);
});

test("调度按服务器本地02点安排，真实备份成功后记录实际完成时间并保留同批校验", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-status-daily-"));
  const config = { databasePath: path.join(root, "runtime", "data", "virtual.db"), storagePath: path.join(root, "runtime", "storage"), backupPath: path.join(root, "backups"), backupHour: 2 };
  fs.mkdirSync(config.storagePath, { recursive: true });
  const db = createDatabase(config.databasePath);
  let current = new Date(2026, 8, 3, 1, 0, 0);
  const callbacks = [];
  const logs = [];
  let controller;
  try {
    controller = startDailyBackupScheduler({ db, config, clock: () => current, logger: { log: text => logs.push(text), error: text => logs.push(text) },
      setTimer: (callback, delay) => { const timer = { callback, delay, unref() {} }; callbacks.push(timer); return timer; }, clearTimer() {},
      backupRunner: async options => {
        const result = await createBackup({ ...options, now: current });
        current = new Date(2026, 8, 3, 2, 7, 0);
        return result;
      }
    });
    assert.equal(callbacks[0].delay, 60 * 60 * 1000);
    assert.equal(controller.nextRunAt, new Date(2026, 8, 3, 2, 0, 0).toISOString());
    current = new Date(2026, 8, 3, 2, 0, 0);
    await callbacks[0].callback();
    const status = getBackupStatusStore(db).getStatus(admin);
    assert.equal(status.lastSuccess.kind, "AUTOMATIC");
    assert.equal(status.lastSuccess.completedAt, current.toISOString());
    assert.equal(status.scheduler.nextRunAt, new Date(2026, 8, 4, 2, 0, 0).toISOString());
    const verified = await verifyBackupBatch(path.join(config.backupPath, status.lastSuccess.batchId));
    assert.equal(verified.validation.quickCheck, "ok");
    assert.equal(status.incompleteCount, 0);
    assert.equal(logs.filter(message => message.includes("每日备份完成")).length, 1);
    assert.ok(!logs.join(" ").includes(root));
  } finally { controller?.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("调度状态写入失败不退出业务或取消下次尝试，恢复写入后可正常运行", async () => {
  const db = new Database(":memory:");
  const callbacks = [];
  const errors = [];
  let runs = 0;
  let controller;
  try {
    db.pragma("query_only = ON");
    controller = startDailyBackupScheduler({ db, config: { backupHour: 2 }, logger: { log() {}, error: message => errors.push(message) },
      setTimer: callback => { callbacks.push(callback); return { unref() {} }; }, clearTimer() {},
      backupRunner: async () => { runs += 1; return completedResult(); }
    });
    await callbacks[0]();
    assert.equal(runs, 0);
    assert.equal(callbacks.length, 2);
    assert.throws(() => getBackupStatusStore(db), { code: "BACKUP_STATUS_UNAVAILABLE" });
    db.pragma("query_only = OFF");
    await callbacks[1]();
    assert.equal(runs, 1);
    assert.equal(getBackupStatusStore(db).getStatus(admin).lastSuccess.kind, "AUTOMATIC");
    assert.equal(callbacks.length, 3);
    assert.doesNotMatch(errors.join(" "), /SQLITE|readonly|CREATE TABLE/);
    assert.ok(errors.every(message => message.includes("BACKUP_STATUS_WRITE_FAILED")));
  } finally { controller?.stop(); db.close(); }
});

test("定时器登记失败以安全码持久记录并安排重试，重试不清除失败历史", () => {
  const db = new Database(":memory:");
  const callbacks = [];
  const errors = [];
  let attempts = 0;
  let controller;
  try {
    controller = startDailyBackupScheduler({ db, config: { backupHour: 2 }, logger: { log() {}, error: text => errors.push(text) },
      setTimer(callback, delay) {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("virtual-private-path"), { code: "toString" });
        callbacks.push({ callback, delay }); return { unref() {} };
      }, clearTimer() {}
    });
    assert.equal(getBackupStatusStore(db).getStatus(admin).scheduler.status, "FAILED");
    assert.equal(callbacks[0].delay, 60_000);
    callbacks[0].callback();
    const state = getBackupStatusStore(db).getStatus(admin);
    assert.equal(state.scheduler.status, "SCHEDULED");
    assert.equal(state.lastFailure.kind, "SCHEDULER");
    assert.equal(state.lastFailure.code, "BACKUP_SCHEDULER_FAILED");
    assert.doesNotMatch(errors.join(" "), /private|toString/);
  } finally { controller?.stop(); db.close(); }
});

test("实际手工 CLI 在校验及状态落库后才输出成功，失败日志不含原始异常或路径", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-status-cli-"));
  const databasePath = path.join(root, "runtime", "data", "virtual.db");
  const storagePath = path.join(root, "runtime", "storage");
  const backupPath = path.join(root, "backups");
  const script = fileURLToPath(new URL("../scripts/backup.js", import.meta.url));
  fs.mkdirSync(storagePath, { recursive: true });
  const run = reason => execFileSync(process.execPath, [script, "--reason", reason], { cwd: root, encoding: "utf8", timeout: 20_000, stdio: "pipe", env: {
    HH_DATABASE_PATH: databasePath, HH_STORAGE_PATH: storagePath, HH_BACKUP_PATH: backupPath
  } });
  let db;
  try {
    const output = run("虚构升级前手工备份");
    assert.match(output, /备份完成：批次 backup-/);
    assert.ok(!output.includes(root));
    db = new Database(databasePath);
    const status = initializeBackupStatusStore(db).getStatus(admin);
    assert.equal(status.lastSuccess.kind, "MANUAL");
    assert.equal((await verifyBackupBatch(path.join(backupPath, status.lastSuccess.batchId))).validation.quickCheck, "ok");
    assert.throws(() => run("virtual\ninvalid"), error => {
      assert.equal(error.status, 1);
      assert.doesNotMatch(error.stdout, /备份完成/);
      assert.match(error.stderr, /BACKUP_REASON_INVALID/);
      assert.ok(!error.stderr.includes(root));
      return true;
    });
    assert.equal(getBackupStatusStore(db).getStatus(admin).lastFailure.code, "BACKUP_REASON_INVALID");
    db.exec(`CREATE TRIGGER reject_virtual_success BEFORE UPDATE OF status ON backup_run_status
      WHEN NEW.status = 'SUCCEEDED' BEGIN SELECT RAISE(ABORT, 'virtual-private-path'); END;`);
    const batchesBefore = fs.readdirSync(backupPath).length;
    assert.throws(() => run("虚构状态写入失败"), error => {
      assert.equal(error.status, 1);
      assert.doesNotMatch(error.stdout, /备份完成/);
      assert.match(error.stderr, /BACKUP_STATUS_WRITE_FAILED/);
      assert.doesNotMatch(error.stderr, /virtual-private-path|SQLITE|ABORT/);
      return true;
    });
    assert.equal(fs.readdirSync(backupPath).length, batchesBefore + 1);
    assert.equal(getBackupStatusStore(db).getStatus(admin).lastFailure.code, "BACKUP_STATUS_WRITE_FAILED");
  } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("设置状态卡警示较新失败及不确定调度，不把历史成功当实时恢复保证", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const functionText = ["escapeHtml", "backupStatusSection"].map(name => source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0]).join("\n");
  const status = {
    checkedAt: "2026-09-03T04:00:00.000Z", freshness: "CURRENT", incompleteCount: 1,
    incompleteRuns: [{ kind: "MANUAL", status: "UNCONFIRMED", startedAt: "2026-09-03T03:00:00.000Z" }],
    lastSuccess: { ...completedResult(), kind: "MANUAL", completedAt: "2026-09-03T01:00:00.000Z", validation: completedResult().manifest.validation },
    lastFailure: { kind: "AUTOMATIC", failedAt: "2026-09-03T02:00:00.000Z", code: "<script>virtual</script>" },
    scheduler: { status: "FAILED", nextRunAt: null }, storageFailure: null
  };
  const context = vm.createContext({ status, formatTime: value => value, Intl });
  vm.runInContext(functionText, context);
  const html = vm.runInContext("backupStatusSection(status)", context);
  assert.match(html, /notice warning/);
  assert.match(html, /最近一次失败晚于最近成功/);
  assert.match(html, /恢复前须重新校验备份清单/);
  assert.match(html, /调度失败/);
  assert.match(html, /可能仍在其他进程执行或已中断/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|<button|<form|实时可恢复|备份正常/);
  assert.match(vm.runInContext("backupStatusSection(null)", context), /无法确认/);
});

test("设置请求离页、换账号或进入强制改密后不回写备份状态；503不阻断其他设置", async () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const functionText = ["isCoreLaunch", "renderSettings"]
    .map(name => source.match(new RegExp(`${name === "renderSettings" ? "async " : ""}function ${name}\\([\\s\\S]*?\\n\\}`))[0])
    .join("\n");
  for (const action of ["navigate", "logout", "password", "unavailable"]) {
    let finish;
    const state = { user: { id: "virtual-admin", role: "ADMIN", mustChangePassword: false }, page: "settings" };
    const content = { innerHTML: "unchanged", isConnected: true };
    const context = vm.createContext({ state, content, pageHead: () => "settings", dictionarySettingsSection: () => "dictionaries", surveyTemplateSettingsSection: () => "survey-templates", roleLabels: {},
      backupStatusSection: value => value ? "backup-ready" : "backup-uncertain",
      api: url => url.includes("backup-status") ? new Promise((resolve, reject) => { finish = () => action === "unavailable" ? reject(new Error("private")) : resolve({}); }) : Promise.resolve({ items: [] })
    });
    vm.runInContext(functionText, context);
    const pending = vm.runInContext("renderSettings(content)", context);
    if (action === "navigate") state.page = "customers";
    if (action === "logout") state.user = null;
    if (action === "password") state.user.mustChangePassword = true;
    finish(); await pending;
    if (action === "unavailable") {
      assert.match(content.innerHTML, /backup-uncertain/);
      assert.match(content.innerHTML, /dictionaries/);
      assert.doesNotMatch(content.innerHTML, /private/);
    } else assert.equal(content.innerHTML, "unchanged");
  }
});
