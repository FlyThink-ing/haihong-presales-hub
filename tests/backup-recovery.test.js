import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createBackup, restoreBackup, startDailyBackupScheduler, verifyBackupBatch } from "../server/backup-service.js";
import { createUser } from "../server/auth-service.js";
import { loadConfig } from "../server/config.js";
import { createCustomer } from "../server/customer-service.js";
import { createDatabase, nowIso } from "../server/database.js";
import { createQuote } from "../server/quote-service.js";
import { sha256 } from "../server/security.js";
import { shutdownApplication } from "../server/lifecycle.js";

function password() {
  return `${randomBytes(18).toString("base64url")}aA1!`;
}

function writeStored(storagePath, storageKey, contents) {
  const absolute = path.join(storagePath, ...storageKey.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const buffer = Buffer.from(contents);
  fs.writeFileSync(absolute, buffer);
  return { storageKey, sizeBytes: buffer.length, sha256: sha256(buffer) };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-backup-"));
  const runtimePath = path.join(root, "runtime");
  const databasePath = path.join(runtimePath, "data", "presales-hub.db");
  const storagePath = path.join(runtimePath, "storage");
  const backupPath = path.join(root, "backups");
  fs.mkdirSync(storagePath, { recursive: true });
  fs.writeFileSync(path.join(runtimePath, ".env"), "HH_BOOTSTRAP_PASSWORD=<REDACTED>\n");
  fs.writeFileSync(path.join(storagePath, ".env"), "SHOULD_NOT_BE_BACKED_UP=true\n");
  const db = createDatabase(databasePath);
  const admin = createUser(db, { username: `admin-${randomUUID()}`, displayName: "虚构备份管理员", password: password(), role: "ADMIN" });
  const manager = createUser(db, { username: `manager-${randomUUID()}`, displayName: "虚构备份负责人", password: password(), role: "MANAGER" }, admin.id);
  const sales = createUser(db, { username: `sales-${randomUUID()}`, displayName: "虚构备份售前", password: password(), role: "PRESALES", managerId: manager.id }, admin.id);
  const customer = createCustomer(db, sales, { fullName: "虚构备份客户有限公司", registeredOn: "2026-08-26", status: "初期接洽", needSummary: "虚构备份演练需求" });
  const projectId = randomUUID();
  db.prepare(`INSERT INTO projects (id, customer_id, name, summary, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(projectId, customer.id, "虚构备份项目", "仅用于自动化测试", nowIso());
  const quote = createQuote(db, sales, {
    quoteNumber: `Q-BACKUP-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    projectId,
    items: [{ category: "标准模块", itemName: "虚构模块", unit: "套", quantityMilli: 1000, untaxedUnitPriceCents: 100_000, taxRateBps: 600 }]
  });

  const ordinary = writeStored(storagePath, "survey/ordinary.docx", "virtual ordinary archive");
  db.prepare(`
    INSERT INTO stored_files (id, entity_type, entity_id, category, original_name, storage_key, mime_type, size_bytes, sha256, uploaded_by, created_at)
    VALUES (?, 'SURVEY', ?, 'SURVEY_REPORT_DOCX', '虚构调研报告.docx', ?, 'application/octet-stream', ?, ?, ?, ?)
  `).run(randomUUID(), randomUUID(), ordinary.storageKey, ordinary.sizeBytes, ordinary.sha256, sales.id, nowIso());

  const currentAttachment = writeStored(storagePath, "attachments/current.pdf", "%PDF-1.4 current virtual attachment");
  const deletedAttachment = writeStored(storagePath, "attachments/deleted.pdf", "%PDF-1.4 deleted virtual attachment");
  const currentFileId = randomUUID();
  const deletedFileId = randomUUID();
  db.prepare(`INSERT INTO stored_files VALUES (?, 'CUSTOMER', ?, 'BUSINESS_ATTACHMENT', '虚构当前附件.pdf', ?, 'application/pdf', ?, ?, ?, ?)`)
    .run(currentFileId, customer.id, currentAttachment.storageKey, currentAttachment.sizeBytes, currentAttachment.sha256, sales.id, nowIso());
  db.prepare(`INSERT INTO stored_files VALUES (?, 'CUSTOMER', ?, 'BUSINESS_ATTACHMENT', '虚构已删除附件.pdf', ?, 'application/pdf', ?, ?, ?, ?)`)
    .run(deletedFileId, customer.id, deletedAttachment.storageKey, deletedAttachment.sizeBytes, deletedAttachment.sha256, sales.id, nowIso());
  const currentAttachmentId = randomUUID();
  const deletedAttachmentId = randomUUID();
  const currentVersionId = randomUUID();
  const deletedVersionId = randomUUID();
  db.prepare(`INSERT INTO business_attachments (id, customer_id, target_type, target_id, current_version_id, created_by, created_at, updated_at) VALUES (?, ?, 'QUOTE_VERSION', ?, ?, ?, ?, ?)`)
    .run(currentAttachmentId, customer.id, quote.id, currentVersionId, sales.id, nowIso(), nowIso());
  db.prepare(`INSERT INTO business_attachments (id, customer_id, target_type, target_id, current_version_id, is_deleted, deleted_by, deleted_at, deletion_reason, created_by, created_at, updated_at) VALUES (?, ?, 'CUSTOMER', ?, ?, 1, ?, ?, '虚构受控删除', ?, ?, ?)`)
    .run(deletedAttachmentId, customer.id, customer.id, deletedVersionId, sales.id, nowIso(), sales.id, nowIso(), nowIso());
  db.prepare(`INSERT INTO business_attachment_versions (id, attachment_id, revision, file_id, uploaded_by, created_at) VALUES (?, ?, 1, ?, ?, ?)`)
    .run(currentVersionId, currentAttachmentId, currentFileId, sales.id, nowIso());
  db.prepare(`INSERT INTO business_attachment_versions (id, attachment_id, revision, file_id, uploaded_by, created_at) VALUES (?, ?, 1, ?, ?, ?)`)
    .run(deletedVersionId, deletedAttachmentId, deletedFileId, sales.id, nowIso());
  db.prepare(`INSERT INTO business_attachment_snapshots (id, snapshot_kind, snapshot_owner_id, customer_id, attachment_id, attachment_version_id, target_type, target_id, original_name, mime_type, size_bytes, sha256, created_at) VALUES (?, 'QUOTE_SUBMISSION', ?, ?, ?, ?, 'QUOTE_VERSION', ?, '虚构当前附件.pdf', 'application/pdf', ?, ?, ?)`)
    .run(randomUUID(), quote.id, customer.id, currentAttachmentId, currentVersionId, quote.id, currentAttachment.sizeBytes, currentAttachment.sha256, nowIso());

  const template = writeStored(storagePath, "contract-templates/template.docx", "virtual contract template");
  const templateId = randomUUID();
  db.prepare(`
    INSERT INTO contract_templates (id, version, original_name, storage_key, size_bytes, sha256, status, is_published, uploaded_by, uploaded_at, published_by, published_at)
    VALUES (?, 'VIRTUAL-BACKUP-1', '虚构合同模板.docx', ?, ?, ?, 'PUBLISHED', 1, ?, ?, ?, ?)
  `).run(templateId, template.storageKey, template.sizeBytes, template.sha256, admin.id, nowIso(), admin.id, nowIso());

  const contractId = randomUUID();
  db.prepare(`
    INSERT INTO contracts (id, contract_number, customer_id, project_id, quote_version_id, template_id, amount_cents, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 106000, 'DRAFT', ?, ?, ?)
  `).run(contractId, `HT-BACKUP-${randomUUID().slice(0, 8)}`, customer.id, projectId, quote.id, templateId, sales.id, nowIso(), nowIso());
  const contractFile = writeStored(storagePath, "contracts/contract.docx", "virtual contract archive");
  db.prepare(`
    INSERT INTO contract_files (id, contract_id, category, original_name, storage_key, size_bytes, sha256, uploaded_by, created_at)
    VALUES (?, ?, 'WORD_EDITED', '虚构外部修改版.docx', ?, ?, ?, ?, ?)
  `).run(randomUUID(), contractId, contractFile.storageKey, contractFile.sizeBytes, contractFile.sha256, sales.id, nowIso());

  writeStored(storagePath, "maps/china-standard-map.json", JSON.stringify({ reviewNumber: "GS（虚构测试）0000号" }));
  writeStored(storagePath, "maps/china-standard-map.png", "virtual map image");
  return { root, databasePath, storagePath, backupPath, db, ordinary, currentAttachment, deletedAttachment, template, contractFile };
}

function cleanup(value) {
  value.db?.close();
  fs.rmSync(value.root, { recursive: true, force: true });
}

test("在线快照把普通附件、合同模板、合同文件和地图资源纳入同一批次并生成正确摘要", async () => {
  const f = fixture();
  try {
    const result = await createBackup({ ...f, reason: "虚构升级前手工备份" });
    assert.equal(fs.existsSync(path.join(result.batchPath, "database.sqlite3")), true);
    assert.deepEqual(result.manifest.files.map(item => item.path).sort(), [
      "storage/attachments/current.pdf",
      "storage/attachments/deleted.pdf",
      "storage/contract-templates/template.docx",
      "storage/contracts/contract.docx",
      "storage/maps/china-standard-map.json",
      "storage/maps/china-standard-map.png",
      "storage/survey/ordinary.docx"
    ]);
    assert.equal(result.manifest.validation.referencedFiles, 5);
    assert.equal(result.manifest.validation.filesVerified, 7);
    assert.equal(result.manifest.database.sha256, sha256(fs.readFileSync(path.join(result.batchPath, "database.sqlite3"))));
    for (const item of result.manifest.files) {
      const filename = path.join(result.batchPath, ...item.path.split("/"));
      assert.equal(item.sizeBytes, fs.statSync(filename).size);
      assert.equal(item.sha256, sha256(fs.readFileSync(filename)));
    }
    assert.equal(fs.existsSync(path.join(result.batchPath, ".env")), false);
    assert.equal(fs.existsSync(path.join(result.batchPath, "storage", ".env")), false);
    const manifestText = fs.readFileSync(path.join(result.batchPath, "manifest.json"), "utf8");
    assert.equal(manifestText.includes(f.root), false);
    assert.doesNotMatch(manifestText, /(?:password|token|\.env)/i);
    assert.equal(fs.readdirSync(f.backupPath).some(name => name.startsWith(".partial-")), false);
    const verified = await verifyBackupBatch(result.batchPath);
    assert.equal(verified.validation.quickCheck, "ok");
    assert.equal(verified.validation.foreignKeyErrors, 0);
  } finally {
    cleanup(f);
  }
});

test("摘要篡改和清单文件缺失都会阻止验证及恢复", async () => {
  const f = fixture();
  try {
    const tampered = await createBackup({ ...f, reason: "虚构篡改测试" });
    fs.appendFileSync(path.join(tampered.batchPath, "storage", "contracts", "contract.docx"), "tampered");
    await assert.rejects(() => verifyBackupBatch(tampered.batchPath), error => error.code === "BACKUP_FILE_SIZE_MISMATCH" || error.code === "BACKUP_FILE_SHA_MISMATCH");
    await assert.rejects(() => restoreBackup({ ...f, batchPath: tampered.batchPath, targetPath: path.join(f.root, "tampered-restore") }), error => error.code === "BACKUP_FILE_SIZE_MISMATCH" || error.code === "BACKUP_FILE_SHA_MISMATCH");
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith(".restore-partial-")), false);

    const missing = await createBackup({ ...f, reason: "虚构缺失测试" });
    fs.rmSync(path.join(missing.batchPath, "storage", "survey", "ordinary.docx"));
    await assert.rejects(() => verifyBackupBatch(missing.batchPath), error => error.code === "BACKUP_FILE_MISSING");

    const manifestTampered = await createBackup({ ...f, reason: "虚构清单篡改测试" });
    const manifestPath = path.join(manifestTampered.batchPath, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.files[0].sha256 = "0".repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    await assert.rejects(() => verifyBackupBatch(manifestTampered.batchPath), error => error.code === "BACKUP_FILE_SHA_MISMATCH");
  } finally {
    cleanup(f);
  }
});

test("备份目录与数据库或 storage 路径重叠时一律阻止", async () => {
  const f = fixture();
  try {
    await assert.rejects(() => createBackup({ ...f, backupPath: path.join(path.dirname(f.databasePath), "backups"), reason: "虚构数据库目录重叠" }), error => error.code === "BACKUP_PATH_DATABASE_OVERLAP");
    await assert.rejects(() => createBackup({ ...f, backupPath: path.join(f.storagePath, "backups"), reason: "虚构存储目录重叠" }), error => error.code === "BACKUP_PATH_STORAGE_OVERLAP");
    await assert.rejects(() => createBackup({ ...f, backupPath: f.root, reason: "虚构危险父目录" }), error => error.code === "BACKUP_PATH_DATABASE_OVERLAP");
    await assert.rejects(() => createBackup({ ...f, reason: "升级前 C:\\server\\data" }), error => error.code === "BACKUP_REASON_SENSITIVE");
  } finally {
    cleanup(f);
  }
});

test("外键异常或引用文件缺失时不发布正式批次并清理 partial 目录", async () => {
  const foreignKeyFixture = fixture();
  try {
    foreignKeyFixture.db.pragma("foreign_keys = OFF");
    foreignKeyFixture.db.prepare(`INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, summary_json, created_at) VALUES (?, ?, 'VIRTUAL', 'TEST', ?, '{}', ?)`)
      .run(randomUUID(), randomUUID(), randomUUID(), nowIso());
    await assert.rejects(() => createBackup({ ...foreignKeyFixture, reason: "虚构外键失败" }), error => error.code === "BACKUP_DATABASE_FOREIGN_KEY_FAILED");
    assert.deepEqual(fs.readdirSync(foreignKeyFixture.backupPath), []);
  } finally {
    cleanup(foreignKeyFixture);
  }

  const missingFileFixture = fixture();
  try {
    fs.rmSync(path.join(missingFileFixture.storagePath, ...missingFileFixture.ordinary.storageKey.split("/")));
    await assert.rejects(() => createBackup({ ...missingFileFixture, reason: "虚构文件缺失失败" }), error => error.code === "BACKUP_REFERENCED_FILE_MISSING");
    assert.deepEqual(fs.readdirSync(missingFileFixture.backupPath), []);
  } finally {
    cleanup(missingFileFixture);
  }
});

test("同进程并发备份被阻止且只产生一个正式批次", async () => {
  const f = fixture();
  try {
    const results = await Promise.allSettled([
      createBackup({ ...f, reason: "虚构并发备份甲" }),
      createBackup({ ...f, reason: "虚构并发备份乙" })
    ]);
    assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
    const rejected = results.find(item => item.status === "rejected");
    assert.equal(rejected.reason.code, "BACKUP_IN_PROGRESS");
    assert.equal(fs.readdirSync(f.backupPath).filter(name => name.startsWith("backup-")).length, 1);
    assert.equal(fs.readdirSync(f.backupPath).some(name => name.startsWith(".partial-")), false);
  } finally {
    cleanup(f);
  }
});

test("隔离恢复拒绝危险或非空目标，成功后再次校验数据库与全部文件", async () => {
  const f = fixture();
  try {
    const backup = await createBackup({ ...f, reason: "虚构恢复演练" });
    const nonempty = path.join(f.root, "nonempty");
    fs.mkdirSync(nonempty);
    fs.writeFileSync(path.join(nonempty, "keep.txt"), "do not overwrite");
    await assert.rejects(() => restoreBackup({ ...f, batchPath: backup.batchPath, targetPath: nonempty }), error => error.code === "RESTORE_TARGET_NOT_EMPTY");
    await assert.rejects(() => restoreBackup({ ...f, batchPath: backup.batchPath, targetPath: path.dirname(f.databasePath) }), error => error.code === "RESTORE_TARGET_DANGEROUS");
    await assert.rejects(() => restoreBackup({ ...f, batchPath: backup.batchPath, targetPath: f.storagePath }), error => error.code === "RESTORE_TARGET_DANGEROUS");
    await assert.rejects(() => restoreBackup({ ...f, batchPath: backup.batchPath, targetPath: f.backupPath }), error => error.code === "RESTORE_TARGET_DANGEROUS");
    await assert.rejects(() => restoreBackup({ ...f, batchPath: backup.batchPath, targetPath: f.root }), error => error.code === "RESTORE_TARGET_DANGEROUS");

    const targetPath = path.join(f.root, "isolated-restore");
    const restored = await restoreBackup({ ...f, batchPath: backup.batchPath, targetPath });
    assert.equal(restored.validation.quickCheck, "ok");
    assert.equal(restored.validation.foreignKeyErrors, 0);
    assert.equal(restored.validation.filesVerified, 7);
    const restoredDb = new Database(restored.databasePath, { readonly: true, fileMustExist: true });
    assert.equal(restoredDb.prepare("SELECT COUNT(*) AS count FROM stored_files").get().count, 3);
    assert.equal(restoredDb.prepare("SELECT COUNT(*) AS count FROM business_attachments WHERE is_deleted = 1").get().count, 1);
    assert.equal(restoredDb.prepare("SELECT COUNT(*) AS count FROM business_attachment_snapshots").get().count, 1);
    assert.equal(restoredDb.prepare("SELECT COUNT(*) AS count FROM contract_templates").get().count, 1);
    assert.equal(restoredDb.prepare("SELECT COUNT(*) AS count FROM contract_files").get().count, 1);
    restoredDb.close();
    assert.equal(fs.readFileSync(path.join(restored.storagePath, "contracts", "contract.docx"), "utf8"), "virtual contract archive");
    assert.equal(fs.readFileSync(path.join(restored.storagePath, "attachments", "deleted.pdf"), "utf8"), "%PDF-1.4 deleted virtual attachment");
  } finally {
    cleanup(f);
  }
});

test("备份配置默认本地 02 点并拒绝非法小时", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-backup-config-"));
  try {
    const config = loadConfig({}, root);
    assert.equal(config.backupHour, 2);
    assert.equal(config.backupPath, path.resolve(root, "backups"));
    assert.throws(() => loadConfig({ HH_BACKUP_HOUR: "24" }, root), /0 至 23/);
    assert.equal(loadConfig({ HH_BACKUP_HOUR: "0" }, root).backupHour, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("每日调度器只创建一次，stop 后不再执行备份", async t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const callbacks = [];
  let backupRuns = 0;
  const setTimer = callback => {
    const handle = { callback, cleared: false, unref() {} };
    callbacks.push(handle);
    return handle;
  };
  const clearTimer = handle => { handle.cleared = true; };
  const options = {
    db,
    config: { databasePath: "virtual.db", storagePath: "virtual-storage", backupPath: "virtual-backups", backupHour: 2 },
    logger: { log() {}, error() {} },
    clock: () => new Date("2026-08-26T01:00:00+08:00"),
    setTimer,
    clearTimer,
    backupRunner: async () => {
      backupRuns += 1;
      const batchId = "backup-20260826T010000000Z-ab12cd34";
      return { batchId, manifest: { batchId, status: "COMPLETE", validation: { completed: true, databaseReadable: true, quickCheck: "ok", foreignKeyErrors: 0, referencedFiles: 0, filesVerified: 0 } } };
    }
  };
  const first = startDailyBackupScheduler(options);
  const second = startDailyBackupScheduler(options);
  assert.equal(first, second);
  assert.equal(callbacks.length, 1);
  await callbacks[0].callback();
  assert.equal(backupRuns, 1);
  assert.equal(callbacks.length, 2);
  first.stop();
  assert.equal(callbacks[1].cleared, true);
  await callbacks[1].callback();
  assert.equal(backupRuns, 1);
});

test("每日备份失败只写安全错误日志并继续安排下一次执行", async t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const callbacks = [];
  const errors = [];
  const controller = startDailyBackupScheduler({
    db,
    config: { databasePath: "virtual.db", storagePath: "virtual-storage", backupPath: "virtual-backups", backupHour: 2 },
    logger: { log() {}, error(message) { errors.push(message); } },
    clock: () => new Date("2026-08-26T01:00:00+08:00"),
    setTimer: callback => {
      const handle = { callback, unref() {} };
      callbacks.push(handle);
      return handle;
    },
    clearTimer() {},
    backupRunner: async () => {
      const error = new Error("虚构磁盘不可用");
      error.code = "VIRTUAL_DISK_ERROR";
      throw error;
    }
  });
  await callbacks[0].callback();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /BACKUP_FAILED/);
  assert.doesNotMatch(errors[0], /VIRTUAL_DISK_ERROR|虚构磁盘不可用/);
  assert.equal(callbacks.length, 2);
  controller.stop();
});

test("服务关停先停止备份调度，再关闭服务和数据库", () => {
  const events = [];
  shutdownApplication({
    backupScheduler: { stop: () => events.push("scheduler.stop") },
    server: { close: callback => { events.push("server.close"); callback(); } },
    db: { close: () => events.push("db.close") },
    exit: code => events.push(`exit.${code}`)
  });
  assert.deepEqual(events, ["scheduler.stop", "server.close", "db.close", "exit.0"]);
});
