import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDatabase, __test as databaseTest } from "../server/database.js";

test("旧合同附件总价迁移为原合计和最终优惠价两个明确字段", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "presales-hub-migration-"));
  const filename = path.join(directory, "legacy.db");
  const attachmentId = randomUUID();
  try {
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE contract_attachment_versions (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        total_cents INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (contract_id, kind, revision)
      )
    `);
    legacy.prepare(`
      INSERT INTO contract_attachment_versions
        (id, contract_id, revision, kind, snapshot_json, total_cents, created_by, created_at)
      VALUES (?, 'legacy-contract', 1, 'PRICE_DETAIL', ?, 12600000, 'legacy-user', '2026-08-24T00:00:00.000Z')
    `).run(attachmentId, JSON.stringify({ items: [{ taxedAmountCents: 12_720_000 }] }));
    legacy.close();

    const migrated = createDatabase(filename);
    const row = migrated.prepare(`
      SELECT total_cents, subtotal_cents, final_discount_cents
      FROM contract_attachment_versions WHERE id = ?
    `).get(attachmentId);
    assert.deepEqual(row, { total_cents: 12_600_000, subtotal_cents: 12_720_000, final_discount_cents: 12_600_000 });
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("旧客户表迁移后允许历史登记时间为 NULL 且外键保持有效", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "presales-hub-customer-migration-"));
  const filename = path.join(directory, "legacy-customer.db");
  try {
    const legacy = new Database(filename);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL, manager_id TEXT, phone TEXT,
        regions_json TEXT NOT NULL DEFAULT '[]', home_city TEXT, is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE customers (
        id TEXT PRIMARY KEY, full_name TEXT NOT NULL, short_name TEXT, source TEXT, customer_type TEXT,
        registered_on TEXT NOT NULL, status TEXT NOT NULL, need_summary TEXT NOT NULL, industry TEXT,
        province TEXT, city TEXT, district TEXT, address TEXT, longitude REAL, latitude REAL, summary TEXT,
        notes TEXT, owner_id TEXT NOT NULL REFERENCES users(id), created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO users (id, username, display_name, password_hash, role, created_at)
      VALUES ('legacy-user', 'legacy-user', '虚构旧用户', 'not-a-real-password-hash', 'PRESALES', '2026-08-01T00:00:00.000Z');
      INSERT INTO customers (
        id, full_name, registered_on, status, need_summary, owner_id, created_by, created_at, updated_at
      ) VALUES (
        'legacy-customer', '虚构旧客户有限公司', '2026-07-01', '初期接洽', '虚构需求',
        'legacy-user', 'legacy-user', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const migrated = createDatabase(filename);
    const column = migrated.pragma("table_info(customers)").find(item => item.name === "registered_on");
    assert.equal(column.notnull, 0);
    assert.deepEqual(
      migrated.pragma("table_info(customers)").filter(item => ["map_x_percent", "map_y_percent", "map_asset_sha256"].includes(item.name)).map(item => item.name),
      ["map_x_percent", "map_y_percent", "map_asset_sha256"]
    );
    migrated.prepare(`UPDATE customers SET registered_on = NULL WHERE id = 'legacy-customer'`).run();
    assert.equal(migrated.prepare(`SELECT registered_on FROM customers WHERE id = 'legacy-customer'`).get().registered_on, null);
    assert.deepEqual(migrated.pragma("foreign_key_check"), []);
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("旧文件表可重复迁移到通用附件类别且保留原归档记录", () => {
  const fileId = randomUUID();
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES ('legacy-user');
      CREATE TABLE stored_files (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('IMPORT_JOB','SURVEY','QUOTE_VERSION','CUSTOMER')),
        entity_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('SOURCE_XLSX','SURVEY_REPORT_DOCX','APPROVED_QUOTE_DOCX','FOLLOWUPS_DOCX')),
        original_name TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, uploaded_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE business_attachment_versions_legacy_probe (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES stored_files(id)
      );
    `);
    db.prepare(`INSERT INTO stored_files VALUES (?, 'IMPORT_JOB', 'legacy-job', 'SOURCE_XLSX', '虚构旧来源.xlsx', 'imports/legacy.xlsx', 'application/octet-stream', 12, ?, 'legacy-user', '2026-08-01T00:00:00.000Z')`)
      .run(fileId, "a".repeat(64));
    db.prepare(`INSERT INTO business_attachment_versions_legacy_probe VALUES ('probe-version', ?)`).run(fileId);

    databaseTest.migrateStoredFiles(db);
    databaseTest.migrateStoredFiles(db);
    assert.match(db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'stored_files'`).get().sql, /BUSINESS_ATTACHMENT/);
    assert.equal(db.prepare(`SELECT category FROM stored_files WHERE id = ?`).get(fileId).category, "SOURCE_XLSX");
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM stored_files WHERE id = ?`).get(fileId).count, 1);
    assert.equal(db.prepare(`SELECT file_id FROM business_attachment_versions_legacy_probe WHERE id = 'probe-version'`).get().file_id, fileId);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});
