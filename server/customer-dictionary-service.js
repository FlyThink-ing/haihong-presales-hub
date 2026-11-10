import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { nowIso } from "./database.js";
import { assert } from "./domain.js";

const fields = { SOURCE: "source", TYPE: "customer_type" };
const sourceFields = { SOURCE: "source", TYPE: "customerType" };

function requireAdmin(actor) { assert(actor.role === "ADMIN", 403, "DICTIONARY_ADMIN_REQUIRED", "仅管理员可以维护字典或查看历史候选"); }
function view(row) { return { id: row.id, kind: row.kind, value: row.value, active: Boolean(row.is_active), used: Boolean(row.used_at), createdAt: row.created_at, updatedAt: row.updated_at }; }
function validValue(value) { assert(typeof value === "string" && value.trim().length > 0 && value.length <= 200, 400, "DICTIONARY_VALUE_INVALID", "字典值须为 1 至 200 字的非空文本"); return value; }

export function listCustomerDictionaryOptions(db, actor, { includeDisabled = false } = {}) {
  if (includeDisabled) requireAdmin(actor);
  return db.prepare(`SELECT * FROM customer_dictionary_options ${includeDisabled ? "" : "WHERE is_active = 1"} ORDER BY kind, created_at, id`).all().map(view);
}

function collectUsage(db) {
  const values = new Map();
  const add = (kind, value, countKey) => {
    if (typeof value !== "string" || !value.trim()) return;
    const key = JSON.stringify([kind, value]);
    if (!values.has(key)) values.set(key, { kind, value, customerCount: 0, importRowCount: 0, auditValueCount: 0 });
    values.get(key)[countKey]++;
  };
  for (const row of db.prepare(`SELECT source, customer_type FROM customers`).all()) {
    for (const [kind, field] of Object.entries(fields)) add(kind, row[field], "customerCount");
  }
  for (const row of db.prepare(`SELECT source_json FROM import_rows`).all()) {
    const source = JSON.parse(row.source_json || "{}");
    for (const [kind, field] of Object.entries(sourceFields)) add(kind, source[field], "importRowCount");
  }
  for (const row of db.prepare(`SELECT summary_json FROM audit_logs WHERE entity_type = 'CUSTOMER' AND action = 'CUSTOMER_UPDATED'`).all()) {
    const summary = JSON.parse(row.summary_json || "{}");
    for (const [kind, field] of Object.entries(fields)) {
      for (const side of [summary.before, summary.after]) add(kind, side?.[field], "auditValueCount");
    }
  }
  return [...values.values()];
}

export function listCustomerDictionaryCandidates(db, actor) {
  requireAdmin(actor);
  const options = db.prepare(`SELECT * FROM customer_dictionary_options`).all();
  return collectUsage(db).map(item => {
    const option = options.find(option => option.kind === item.kind && option.value === item.value);
    return { ...item, state: option ? (option.is_active ? "ENABLED" : "DISABLED") : "PENDING", optionId: option?.id || null };
  });
}

function hasUsage(db, row) {
  return Boolean(row.used_at) || collectUsage(db).some(item => item.kind === row.kind && item.value === row.value);
}

export function createCustomerDictionaryOption(db, actor, input) {
  requireAdmin(actor);
  assert(Object.hasOwn(fields, input.kind), 400, "DICTIONARY_KIND_INVALID", "字典类型无效");
  const value = validValue(input.value);
  assert(!db.prepare(`SELECT id FROM customer_dictionary_options WHERE kind = ? AND value = ?`).get(input.kind, value), 409, "DICTIONARY_VALUE_EXISTS", "同类型字典值已存在，请启用或维护已有项");
  const id = randomUUID();
  const timestamp = nowIso();
  const usedAt = hasUsage(db, { kind: input.kind, value }) ? timestamp : null;
  db.transaction(() => {
    db.prepare(`INSERT INTO customer_dictionary_options (id, kind, value, used_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.kind, value, usedAt, actor.id, timestamp, timestamp);
    audit(db, { actorId: actor.id, action: "CUSTOMER_DICTIONARY_CREATED", entityType: "CUSTOMER_DICTIONARY", entityId: id, summary: { kind: input.kind, value, historicalValueConfirmed: Boolean(usedAt) } });
  })();
  return view(db.prepare(`SELECT * FROM customer_dictionary_options WHERE id = ?`).get(id));
}

export function updateCustomerDictionaryOption(db, actor, id, input) {
  requireAdmin(actor);
  const row = db.prepare(`SELECT * FROM customer_dictionary_options WHERE id = ?`).get(id);
  assert(row, 404, "DICTIONARY_NOT_FOUND", "字典项不存在");
  const value = input.value === undefined ? row.value : validValue(input.value);
  const active = input.active === undefined ? Boolean(row.is_active) : input.active;
  assert(typeof active === "boolean", 400, "DICTIONARY_STATUS_INVALID", "启用状态无效");
  // 值即稳定业务键：已使用文本不原地改名，可停用后新增，历史主档/快照不联动改写。
  assert(value === row.value || !hasUsage(db, row), 409, "DICTIONARY_VALUE_IN_USE", "已使用字典值不可改写，可停用后新增选项");
  assert(!db.prepare(`SELECT id FROM customer_dictionary_options WHERE kind = ? AND value = ? AND id <> ?`).get(row.kind, value, id), 409, "DICTIONARY_VALUE_EXISTS", "同类型字典值已存在");
  db.transaction(() => {
    db.prepare(`UPDATE customer_dictionary_options SET value = ?, is_active = ?, updated_at = ? WHERE id = ?`).run(value, Number(active), nowIso(), id);
    audit(db, { actorId: actor.id, action: "CUSTOMER_DICTIONARY_UPDATED", entityType: "CUSTOMER_DICTIONARY", entityId: id, summary: { before: { value: row.value, active: Boolean(row.is_active) }, after: { value, active } } });
  })();
  return view(db.prepare(`SELECT * FROM customer_dictionary_options WHERE id = ?`).get(id));
}

export function deleteCustomerDictionaryOption(db, actor, id) {
  requireAdmin(actor);
  const row = db.prepare(`SELECT * FROM customer_dictionary_options WHERE id = ?`).get(id);
  assert(row, 404, "DICTIONARY_NOT_FOUND", "字典项不存在");
  assert(!hasUsage(db, row), 409, "DICTIONARY_VALUE_IN_USE", "已使用或历史引用的字典项不能删除，请停用");
  db.transaction(() => {
    db.prepare(`DELETE FROM customer_dictionary_options WHERE id = ?`).run(id);
    audit(db, { actorId: actor.id, action: "CUSTOMER_DICTIONARY_DELETED", entityType: "CUSTOMER_DICTIONARY", entityId: id, summary: { kind: row.kind, value: row.value } });
  })();
}

export function validateCustomerDictionaryValue(db, kind, value, previousValue = null) {
  assert(value === null || typeof value === "string", 400, "DICTIONARY_VALUE_INVALID", "来源和类型须选择字典项");
  if (value === previousValue || value === null || value === "") return;
  assert(db.prepare(`SELECT id FROM customer_dictionary_options WHERE kind = ? AND value = ? AND is_active = 1`).get(kind, value), 400, "DICTIONARY_VALUE_NOT_ENABLED", "正常新增或更改来源/类型只能选择启用项；历史原值可保持不变");
}

export function recordCustomerDictionaryUsage(db, source, customerType) {
  for (const [kind, value] of [["SOURCE", source], ["TYPE", customerType]]) {
    db.prepare(`UPDATE customer_dictionary_options SET used_at = COALESCE(used_at, ?) WHERE kind = ? AND value = ?`).run(nowIso(), kind, value ?? null);
  }
}
