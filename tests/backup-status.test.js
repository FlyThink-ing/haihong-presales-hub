import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createBackupStatusStore, getBackupStatusStore, initializeBackupStatusStore, runBackupWithStatus, safeBackupErrorCode } from "../server/backup-status-service.js";

const admin = { role: "ADMIN", active: true, mustChangePassword: false };
const start = "2026-09-03T01:00:00.000Z";
const batchId = "backup-20260903T010000000Z-ab12cd34";
function result() {
  return {
    batchId,
    batchPath: "virtual-private-path",
    manifest: {
      batchId, status: "COMPLETE", reason: "virtual private reason",
      files: [{ path: "virtual-private-file" }],
      validation: { completed: true, databaseReadable: true, quickCheck: "ok", foreignKeyErrors: 0, referencedFiles: 2, filesVerified: 3, privateDetail: "not-for-status" }
    }
  };
}

function fixture(options = {}) {
  const db = new Database(":memory:");
  let current = new Date(start);
  const store = createBackupStatusStore(db, { processId: "virtual-service-one", clock: () => current, ...options });
  return { db, store, advance(value) { current = new Date(value); }, close() { db.close(); } };
}

test("新状态默认没有成功记录；管理员才能读取，改密受限管理员同样拒绝", () => {
  const f = fixture();
  try {
    const state = f.store.getStatus(admin);
    assert.equal(state.lastSuccess, null);
    assert.equal(state.lastFailure, null);
    assert.equal(state.scheduler.status, "NOT_STARTED");
    assert.equal(state.freshness, "NO_SUCCESS");
    for (const actor of [null, {}, { role: "PRESALES" }, { role: "MANAGER" }, { role: "VP" }, { ...admin, active: false }]) {
      assert.throws(() => f.store.getStatus(actor), { code: "BACKUP_STATUS_FORBIDDEN" });
    }
    assert.throws(() => f.store.getStatus({ ...admin, mustChangePassword: true }), { code: "PASSWORD_CHANGE_REQUIRED" });
  } finally { f.close(); }
});

test("手工与自动运行使用相同记录，实际完成时间和固定校验字段才可进入最近成功", async () => {
  const f = fixture();
  try {
    for (const kind of ["MANUAL", "AUTOMATIC"]) {
      const expected = result();
      const actual = await runBackupWithStatus({ kind, statusStore: f.store, backup: async () => {
        const during = f.store.getStatus(admin);
        assert.equal(during.incompleteCount, 1);
        assert.equal(during.incompleteRuns[0].status, "RUNNING");
        f.advance("2026-09-03T01:05:00.000Z");
        return expected;
      } });
      assert.equal(actual, expected);
      const state = f.store.getStatus(admin);
      assert.equal(state.lastSuccess.kind, kind);
      assert.equal(state.lastSuccess.completedAt, "2026-09-03T01:05:00.000Z");
      assert.equal(state.lastSuccess.batchId, batchId);
      assert.deepEqual(state.lastSuccess.validation, { completed: true, databaseReadable: true, quickCheck: "ok", foreignKeyErrors: 0, referencedFiles: 2, filesVerified: 3 });
      assert.equal(state.incompleteCount, 0);
      assert.doesNotMatch(JSON.stringify(state), /private|not-for-status|virtual-service/);
    }
  } finally { f.close(); }
});

test("错误码使用固定白名单，不持久化或返回原异常、原因和路径", async () => {
  const f = fixture();
  try {
    await runBackupWithStatus({ statusStore: f.store, backup: async () => result() });
    const failure = Object.assign(new Error("virtual-private-path and private content"), { code: "ENOSPC", path: "virtual-private-path" });
    await assert.rejects(() => runBackupWithStatus({ kind: "AUTOMATIC", statusStore: f.store, backup: async () => { throw failure; } }), error => error.code === "BACKUP_STORAGE_FULL" && !error.message.includes("private"));
    const state = f.store.getStatus(admin);
    assert.equal(state.lastSuccess.batchId, batchId);
    assert.equal(state.lastFailure.kind, "AUTOMATIC");
    assert.equal(state.lastFailure.code, "BACKUP_STORAGE_FULL");
    assert.equal(state.incompleteCount, 0);
    assert.doesNotMatch(JSON.stringify(f.db.prepare("SELECT * FROM backup_run_status").all()), /private/);
    assert.equal(safeBackupErrorCode({ code: "BACKUP_private_content" }), "BACKUP_FAILED");
    assert.equal(safeBackupErrorCode({ code: "__proto__" }), "BACKUP_FAILED");
    assert.equal(safeBackupErrorCode({ code: "constructor" }), "BACKUP_FAILED");
    assert.equal(safeBackupErrorCode({ code: "toString" }), "BACKUP_FAILED");
    assert.equal(safeBackupErrorCode({ code: "BACKUP_REFERENCED_FILE_MISSING" }), "BACKUP_REFERENCED_FILE_MISSING");
    assert.equal(safeBackupErrorCode(new Error("private"), "private"), "BACKUP_FAILED");
  } finally { f.close(); }
});

test("未完成和无效结果不能成为成功，终态不能被重复调用覆盖", async () => {
  const f = fixture();
  try {
    for (const mutate of [
      value => { value.manifest.status = "PARTIAL"; },
      value => { value.manifest.validation.completed = false; },
      value => { value.manifest.validation.quickCheck = "private"; },
      value => { value.manifest.validation.foreignKeyErrors = 1; },
      value => { value.manifest.validation.filesVerified = 1; },
      value => { value.batchId = "backup-private-content"; }
    ]) {
      const value = result(); mutate(value);
      await assert.rejects(() => runBackupWithStatus({ statusStore: f.store, backup: async () => value }), { code: "BACKUP_RESULT_INVALID" });
      assert.equal(f.store.getStatus(admin).lastSuccess, null);
      assert.equal(f.store.getStatus(admin).incompleteCount, 0);
    }
    const id = f.store.startRun("MANUAL");
    f.store.completeRun(id, result());
    assert.throws(() => f.store.failRun(id, new Error("private")), { code: "BACKUP_RUN_STATE_INVALID" });
    assert.equal(f.store.getStatus(admin).lastSuccess.batchId, batchId);
  } finally { f.close(); }
});

test("重开真实 SQLite 文件保留成败与未完成记录，不全局清理其他手工 CLI 的运行", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-status-"));
  const filename = path.join(root, "virtual-status.sqlite3");
  let db = new Database(filename);
  let cliDb;
  try {
    const first = createBackupStatusStore(db, { processId: "virtual-service-old", clock: () => new Date(start) });
    first.completeRun(first.startRun("MANUAL"), result());
    first.failRun(first.startRun("AUTOMATIC"), { code: "BACKUP_STORAGE_FULL" });
    const interrupted = first.startRun("AUTOMATIC");
    first.setScheduler({ status: "SCHEDULED", nextRunAt: "2026-09-03T02:00:00.000Z" });
    cliDb = new Database(filename);
    const cli = createBackupStatusStore(cliDb, { processId: "virtual-cli", clock: () => new Date(start) });
    const cliRun = cli.startRun("MANUAL");
    db.close();
    db = new Database(filename);
    const restarted = createBackupStatusStore(db, { processId: "virtual-service-new", clock: () => new Date("2026-09-04T03:00:00.000Z") });
    const state = restarted.getStatus(admin);
    assert.equal(state.lastSuccess.batchId, batchId);
    assert.equal(state.lastFailure.code, "BACKUP_STORAGE_FULL");
    assert.equal(state.freshness, "OVERDUE");
    assert.equal(state.scheduler.status, "UNCONFIRMED");
    assert.equal(state.incompleteCount, 2);
    assert.ok(state.incompleteRuns.every(run => run.status === "UNCONFIRMED"));
    assert.throws(() => restarted.failRun(cliRun, new Error("private")), { code: "BACKUP_RUN_STATE_INVALID" });
    cli.completeRun(cliRun, result());
    assert.equal(restarted.getStatus(admin).incompleteCount, 1);
    assert.equal(db.prepare("SELECT status FROM backup_run_status WHERE id = ?").get(interrupted).status, "RUNNING");
  } finally {
    cliDb?.close(); db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("调度失败独立保留，恢复计划后仍能看到最近失败，过期计划不假装正常", () => {
  const f = fixture();
  try {
    f.store.setScheduler({ status: "FAILED", error: { code: "untrusted-private-code", message: "virtual-private-path" } });
    assert.equal(f.store.getStatus(admin).scheduler.status, "FAILED");
    assert.equal(f.store.getStatus(admin).lastFailure.code, "BACKUP_SCHEDULER_FAILED");
    f.store.setScheduler({ status: "SCHEDULED", nextRunAt: "2026-09-03T02:00:00.000Z" });
    assert.equal(f.store.getStatus(admin).scheduler.status, "SCHEDULED");
    assert.equal(f.store.getStatus(admin).lastFailure.kind, "SCHEDULER");
    f.advance("2026-09-03T02:00:00.000Z");
    assert.equal(f.store.getStatus(admin).scheduler.status, "OVERDUE");
    f.store.setScheduler({ status: "RUNNING" });
    assert.equal(f.store.getStatus(admin).scheduler.nextRunAt, null);
    f.store.setScheduler({ status: "STOPPED" });
    assert.equal(f.store.getStatus(admin).scheduler.status, "STOPPED");
    assert.equal(f.store.getStatus(admin).lastSuccess, null);
    assert.doesNotMatch(JSON.stringify(f.store.getStatus(admin)), /private/);
  } finally { f.close(); }
});

test("开始记录失败不运行备份；最终记录失败不返回成功并保留未确认状态", async () => {
  const f = fixture();
  try {
    let calls = 0;
    f.db.pragma("query_only = ON");
    await assert.rejects(() => runBackupWithStatus({ statusStore: f.store, backup: async () => { calls += 1; return result(); } }), { code: "BACKUP_STATUS_WRITE_FAILED" });
    assert.equal(calls, 0);
    f.db.pragma("query_only = OFF");
    await assert.rejects(() => runBackupWithStatus({ statusStore: f.store, backup: async () => {
      calls += 1;
      f.db.pragma("query_only = ON");
      return result();
    } }), { code: "BACKUP_STATUS_WRITE_FAILED" });
    const state = f.store.getStatus(admin);
    assert.equal(calls, 1);
    assert.equal(state.lastSuccess, null);
    assert.equal(state.incompleteCount, 1);
    assert.equal(state.incompleteRuns[0].status, "UNCONFIRMED");
    assert.equal(state.storageFailure.code, "BACKUP_STATUS_WRITE_FAILED");
    assert.doesNotMatch(JSON.stringify(state), /readonly|SQLITE|private/);
  } finally { f.close(); }
});

test("默认状态存储按数据库复用，数据库不可读时只抛安全错误", () => {
  const db = new Database(":memory:");
  assert.throws(() => getBackupStatusStore(db), { code: "BACKUP_STATUS_UNAVAILABLE" });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get().count, 0);
  const store = initializeBackupStatusStore(db);
  assert.equal(initializeBackupStatusStore(db), store);
  assert.equal(getBackupStatusStore(db), store);
  db.close();
  assert.throws(() => store.getStatus(admin), error => error.code === "BACKUP_STATUS_READ_FAILED" && !error.message.includes("closed"));
  assert.throws(() => store.getStatus({ role: "PRESALES" }), { code: "BACKUP_STATUS_FORBIDDEN" });
});
