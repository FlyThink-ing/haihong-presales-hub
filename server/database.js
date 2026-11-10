import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
const surveyTemplatePath = fileURLToPath(new URL("./templates/mes-survey-a0.json", import.meta.url));
const sopTemplatePath = fileURLToPath(new URL("./templates/presales-sop-v1.json", import.meta.url));

export function createDatabase(filename) {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  if (filename !== ":memory:") db.pragma("journal_mode = WAL");
  db.exec(fs.readFileSync(schemaPath, "utf8"));
  ensureColumn(db, "users", "must_change_password", "INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1))");
  ensureColumn(db, "users", "position_code", "TEXT CHECK (position_code IS NULL OR position_code IN ('RND_MANAGER','GENERAL_MANAGER'))");
  ensureColumn(db, "users", "email", "TEXT");
  db.prepare(`UPDATE users SET position_code = 'RND_MANAGER' WHERE role = 'MANAGER' AND position_code IS NULL`).run();
  ensureColumn(db, "followups", "occurred_precision", "TEXT NOT NULL DEFAULT 'DATETIME' CHECK (occurred_precision IN ('DATETIME','DAY'))");
  ensureColumn(db, "followups", "is_historical", "INTEGER NOT NULL DEFAULT 0 CHECK (is_historical IN (0,1))");
  ensureColumn(db, "visit_import_entries", "previewed_by", "TEXT REFERENCES users(id)");
  migrateStoredFiles(db);
  migrateReminderResolution(db);
  migrateCustomersRegisteredOnNullable(db);
  ensureColumn(db, "customers", "map_x_percent", "REAL CHECK (map_x_percent >= 0 AND map_x_percent <= 100)");
  ensureColumn(db, "customers", "map_y_percent", "REAL CHECK (map_y_percent >= 0 AND map_y_percent <= 100)");
  ensureColumn(db, "customers", "map_asset_sha256", "TEXT");
  ensureColumn(db, "surveys", "series_id", "TEXT");
  ensureColumn(db, "surveys", "version_number", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "surveys", "previous_survey_id", "TEXT REFERENCES surveys(id)");
  ensureColumn(db, "surveys", "draft_etag", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "surveys", "draft_saved_at", "TEXT");
  ensureColumn(db, "quote_versions", "draft_etag", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "quote_versions", "draft_saved_at", "TEXT");
  ensureColumn(db, "quote_versions", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "quote_versions", "approval_stage", "TEXT CHECK (approval_stage IS NULL OR approval_stage IN ('MANAGER','GENERAL_MANAGER','VP'))");
  migrateQuoteApprovalStages(db);
  db.prepare(`UPDATE quote_versions SET approval_stage = 'MANAGER' WHERE status = 'PENDING_MANAGER' AND approval_stage IS NULL`).run();
  db.prepare(`UPDATE quote_versions SET approval_stage = 'VP' WHERE status = 'PENDING_VP' AND approval_stage IS NULL`).run();
  ensureColumn(db, "quote_items", "section", "TEXT NOT NULL DEFAULT 'SUMMARY' CHECK (section IN ('SUMMARY','DETAIL'))");
  ensureColumn(db, "quote_items", "pricing_mode", "TEXT NOT NULL DEFAULT 'UNTAXED_UNIT' CHECK (pricing_mode IN ('UNTAXED_UNIT','TAXED_TOTAL'))");
  db.prepare(`UPDATE surveys SET series_id = id WHERE series_id IS NULL OR series_id = ''`).run();
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS surveys_series_version_idx ON surveys(series_id, version_number)`);
  ensureColumn(db, "contract_attachment_versions", "subtotal_cents", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "contract_attachment_versions", "final_discount_cents", "INTEGER NOT NULL DEFAULT 0");
  migrateLegacyContractAttachmentTotals(db);
  ensureContractColumns(db);
  seedSurveyTemplate(db);
  seedSopKnowledge(db);
  return db;
}

function ensureContractColumns(db) {
  ensureColumn(db, "contract_templates", "original_name", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "contract_templates", "mime_type", "TEXT NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'");
  ensureColumn(db, "contract_templates", "size_bytes", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "contract_templates", "status", "TEXT NOT NULL DEFAULT 'UPLOADED'");
  ensureColumn(db, "contract_templates", "validation_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "contract_templates", "fixed_fingerprint", "TEXT");
  ensureColumn(db, "contract_templates", "uploaded_by", "TEXT REFERENCES users(id)");
  ensureColumn(db, "contract_templates", "uploaded_at", "TEXT");
  ensureColumn(db, "contracts", "maintenance_fee_cents", "INTEGER");
  ensureColumn(db, "contracts", "signed_location", "TEXT NOT NULL DEFAULT '鹤壁'");
  ensureColumn(db, "contracts", "signed_on", "TEXT");
  ensureColumn(db, "contracts", "party_a_name", "TEXT");
  ensureColumn(db, "contracts", "license_scope", "TEXT");
  ensureColumn(db, "contracts", "party_a_legal_representative", "TEXT");
  ensureColumn(db, "contracts", "party_a_representative", "TEXT");
  ensureColumn(db, "contracts", "party_a_zip", "TEXT");
  ensureColumn(db, "contracts", "party_a_address", "TEXT");
  ensureColumn(db, "contracts", "party_a_phone", "TEXT");
  ensureColumn(db, "contracts", "confirmations_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "contracts", "signing_notes", "TEXT");
  ensureColumn(db, "contracts", "notes_updated_by", "TEXT REFERENCES users(id)");
  ensureColumn(db, "contracts", "notes_updated_at", "TEXT");
  ensureColumn(db, "contracts", "generation_snapshot_json", "TEXT");
  ensureColumn(db, "contracts", "generation_snapshot_hash", "TEXT");
  ensureColumn(db, "contracts", "generated_at", "TEXT");
  ensureColumn(db, "contracts", "updated_at", "TEXT");
  ensureColumn(db, "contracts", "draft_etag", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "contracts", "draft_saved_at", "TEXT");
  ensureColumn(db, "contract_files", "mime_type", "TEXT NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'");
  ensureColumn(db, "contract_files", "size_bytes", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "contract_files", "declaration_json", "TEXT NOT NULL DEFAULT '{}'");
  db.prepare(`UPDATE contracts SET maintenance_fee_cents = ROUND(amount_cents * 0.1) WHERE maintenance_fee_cents IS NULL`).run();
  db.prepare(`UPDATE contracts SET updated_at = created_at WHERE updated_at IS NULL`).run();
  db.prepare(`UPDATE contract_templates SET status = 'PUBLISHED' WHERE is_published = 1 AND status <> 'PUBLISHED'`).run();
}

function migrateStoredFiles(db) {
  if (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'stored_files'`).get().sql.includes("BUSINESS_ATTACHMENT")) return;
  const definition = fs.readFileSync(schemaPath, "utf8").match(/CREATE TABLE IF NOT EXISTS stored_files \([\s\S]*?\n\);/)[0];
  const replacementDefinition = definition.replace("CREATE TABLE IF NOT EXISTS stored_files", "CREATE TABLE stored_files_attachment_new");
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.transaction(() => {
      db.exec(replacementDefinition);
      db.exec(`INSERT INTO stored_files_attachment_new SELECT * FROM stored_files;
        DROP TABLE stored_files;
        ALTER TABLE stored_files_attachment_new RENAME TO stored_files;
        CREATE INDEX IF NOT EXISTS stored_files_entity_idx ON stored_files(entity_type, entity_id, created_at)`);
      if (db.pragma("foreign_key_check").length) throw new Error("存储文件迁移外键校验失败");
    })();
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }
}

function migrateQuoteApprovalStages(db) {
  const approvalSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quote_approvals'`).get()?.sql || "";
  if (approvalSql.includes("GENERAL_MANAGER")) return;
  const schema = fs.readFileSync(schemaPath, "utf8");
  const approvalsDefinition = schema.match(/CREATE TABLE IF NOT EXISTS quote_approvals \([\s\S]*?\n\);/)?.[0]
    ?.replace("CREATE TABLE IF NOT EXISTS quote_approvals", "CREATE TABLE quote_approvals");
  const snapshotsDefinition = schema.match(/CREATE TABLE IF NOT EXISTS quote_approval_snapshots \([\s\S]*?\n\);/)?.[0]
    ?.replace("CREATE TABLE IF NOT EXISTS quote_approval_snapshots", "CREATE TABLE quote_approval_snapshots");
  if (!approvalsDefinition || !snapshotsDefinition) throw new Error("报价审批迁移缺少表定义");
  const foreignKeysEnabled = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE quote_approval_snapshots RENAME TO quote_approval_snapshots_stage_legacy;
        ALTER TABLE quote_approvals RENAME TO quote_approvals_stage_legacy;
        ${approvalsDefinition}
        ${snapshotsDefinition}
        INSERT INTO quote_approvals (id, quote_version_id, stage, decision, approver_id, comment, created_at)
          SELECT id, quote_version_id, stage, decision, approver_id, comment, created_at FROM quote_approvals_stage_legacy;
        INSERT INTO quote_approval_snapshots (id, quote_version_id, approval_id, snapshot_json, snapshot_hash, created_at)
          SELECT id, quote_version_id, approval_id, snapshot_json, snapshot_hash, created_at FROM quote_approval_snapshots_stage_legacy;
        DROP TABLE quote_approval_snapshots_stage_legacy;
        DROP TABLE quote_approvals_stage_legacy;
      `);
      if (db.pragma("foreign_key_check").length) throw new Error("报价审批阶段迁移外键校验失败");
    })();
  } finally {
    db.pragma("legacy_alter_table = OFF");
    if (foreignKeysEnabled) db.pragma("foreign_keys = ON");
  }
}

function migrateReminderResolution(db) {
  const schema = fs.readFileSync(schemaPath, "utf8");
  const tables = ["reminders", "reminder_events"].filter(table => {
    const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)?.sql || "";
    return !sql.includes(table === "reminders" ? "UNABLE_PENDING" : "UNABLE_REPORTED");
  });
  if (!tables.length) return;
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.transaction(() => {
      for (const table of tables) {
        const definition = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0];
        if (!definition) throw new Error("提醒迁移缺少表定义");
        db.exec(`ALTER TABLE ${table} RENAME TO ${table}_resolution_legacy`);
        db.exec(definition);
        db.exec(`INSERT INTO ${table} SELECT * FROM ${table}_resolution_legacy; DROP TABLE ${table}_resolution_legacy`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS reminders_assignee_idx ON reminders(assignee_id, status, remind_at);
        CREATE INDEX IF NOT EXISTS reminders_assigner_idx ON reminders(assigned_by, status, remind_at);
        CREATE INDEX IF NOT EXISTS reminder_events_reminder_idx ON reminder_events(reminder_id, created_at)`);
      if (db.pragma("foreign_key_check").length) throw new Error("提醒状态迁移外键校验失败");
    })();
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }
}

function migrateCustomersRegisteredOnNullable(db) {
  const registeredOn = db.pragma("table_info(customers)").find(item => item.name === "registered_on");
  if (!registeredOn?.notnull) return;
  const foreignKeysEnabled = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE customers RENAME TO customers_registered_on_legacy;
      CREATE TABLE customers (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        short_name TEXT,
        source TEXT,
        customer_type TEXT,
        registered_on TEXT,
        status TEXT NOT NULL CHECK (status IN ('初期接洽','现场调研','方案&报价','报价完成&商务洽谈','合同签订完成','丢标','中止')),
        need_summary TEXT NOT NULL,
        industry TEXT,
        province TEXT,
        city TEXT,
        district TEXT,
        address TEXT,
        longitude REAL,
        latitude REAL,
        summary TEXT,
        notes TEXT,
        owner_id TEXT NOT NULL REFERENCES users(id),
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO customers SELECT * FROM customers_registered_on_legacy;
      DROP TABLE customers_registered_on_legacy;
      CREATE INDEX IF NOT EXISTS customers_owner_idx ON customers(owner_id);
      COMMIT;
    `);
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.pragma("legacy_alter_table = OFF");
    if (foreignKeysEnabled) db.pragma("foreign_keys = ON");
  }
  const violations = db.pragma("foreign_key_check");
  if (violations.length) throw new Error("客户登记时间迁移后外键校验失败");
}

function ensureColumn(db, table, column, definition) {
  const exists = db.pragma(`table_info(${table})`).some(item => item.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateLegacyContractAttachmentTotals(db) {
  const columns = db.pragma("table_info(contract_attachment_versions)");
  if (!columns.some(item => item.name === "total_cents")) return;
  const rows = db.prepare(`
    SELECT id, snapshot_json, total_cents
    FROM contract_attachment_versions
    WHERE subtotal_cents = 0 AND final_discount_cents = 0
  `).all();
  const update = db.prepare(`
    UPDATE contract_attachment_versions
    SET subtotal_cents = ?, final_discount_cents = ?
    WHERE id = ?
  `);
  db.transaction(() => {
    for (const row of rows) {
      let subtotalCents = row.total_cents;
      try {
        const snapshot = JSON.parse(row.snapshot_json);
        if (Number.isInteger(snapshot.subtotalCents)) subtotalCents = snapshot.subtotalCents;
        else if (Array.isArray(snapshot.items)) {
          subtotalCents = snapshot.items.reduce((sum, item) => sum + (Number.isInteger(item.taxedAmountCents) ? item.taxedAmountCents : 0), 0);
        }
      } catch {
        // 旧快照损坏时保留旧总价，避免启动迁移阻断服务。
      }
      update.run(subtotalCents, row.total_cents, row.id);
    }
  })();
}

function seedSurveyTemplate(db) {
  const template = JSON.parse(fs.readFileSync(surveyTemplatePath, "utf8"));
  db.prepare(`
    INSERT OR IGNORE INTO survey_templates (id, code, version, name, source_sha256, schema_json, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(`${template.code}:${template.version}`, template.code, template.version, template.name, template.sourceSha256, JSON.stringify(template), nowIso());
}

function seedSopKnowledge(db) {
  const template = JSON.parse(fs.readFileSync(sopTemplatePath, "utf8"));
  const insertDocument = db.prepare(`
    INSERT OR IGNORE INTO sop_documents (id, code, created_at)
    VALUES (?, ?, ?)
  `);
  const insertVersion = db.prepare(`
    INSERT OR IGNORE INTO sop_versions (
      id, document_id, version_number, title, roles_json, stages_json, keywords_json,
      body_text, update_summary, source_note, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const setCurrent = db.prepare(`UPDATE sop_documents SET current_version_id = COALESCE(current_version_id, ?) WHERE id = ?`);
  db.transaction(() => {
    for (const item of template.documents) {
      const documentId = `SOP:${item.code}`;
      const versionId = `${documentId}:${template.version}`;
      insertDocument.run(documentId, item.code, template.publishedAt);
      insertVersion.run(
        versionId, documentId, template.version, item.title, JSON.stringify(item.roles),
        JSON.stringify(item.stages), JSON.stringify(item.keywords || []), item.body,
        template.updateSummary, template.sourceNote, template.publishedAt
      );
      setCurrent.run(versionId, documentId);
    }
  })();
}

export function nowIso() {
  return new Date().toISOString();
}

export const __test = { migrateStoredFiles };
