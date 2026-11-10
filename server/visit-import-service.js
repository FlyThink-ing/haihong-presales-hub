import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { createContact } from "./customer-activity-service.js";
import { createCustomer, updateCustomer } from "./customer-service.js";
import { nowIso } from "./database.js";
import { AppError, assert, CUSTOMER_STATUSES, ROLES } from "./domain.js";
import { getFileMetadata, resolveManagedPath } from "./file-service.js";
import { cellValue, readWorkbook } from "./import-service.js";
import { canReadCustomer } from "./permissions.js";
import { sha256 } from "./security.js";
import { MUNICH_VISIT_FIELDS, MUNICH_VISIT_SHEET, parseMunichVisitRow, validateMunichVisitHeaders, visitSourceIdentity } from "./visit-import-parser.js";

const BASIS_TYPES = Object.freeze(["CREDIT_CODE", "ADDRESS", "BRANCH", "OTHER"]);
const FIELD_CONFIG = Object.freeze({
  registeredOn: { column: "registered_on", candidate: "registeredOn" },
  industry: { column: "industry", candidate: "industry" },
  needSummary: { column: "need_summary", candidate: "needSummary" },
  notes: { column: "notes", candidate: "notes" }
});
const ISSUE_LABELS = {
  CUSTOMER_NAME_REQUIRED: "客户名称为空，保留整行待核对", CUSTOMER_NAME_TOO_LONG: "客户名称超过系统长度限制",
  CUSTOMER_NEED_TOO_LONG: "客户需求超过系统长度限制", CUSTOMER_INDUSTRY_TOO_LONG: "行业超过系统长度限制",
  CUSTOMER_NOTES_TOO_LONG: "备注超过系统长度限制", REGISTERED_ON_INVALID: "登记时间不是有效日历日期",
  PLANNED_VISIT_ON_INVALID: "计划拜访日期不是有效日历日期", CONTACT_NAME_REVIEW_REQUIRED: "接洽人不只是明确姓名，保留原文待核对",
  SOURCE_CONFLICT: "同一来源键的原字段与已绑定来源不一致，禁止覆盖", DUPLICATE_SCOPE_REVIEW_REQUIRED: "存在无权查看的同名主体，不能在当前账号下选择或合并"
};

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function text(value, max = 2_000) {
  return String(value ?? "").trim().slice(0, max);
}

function requireVisitJob(db, actor, jobId) {
  const job = db.prepare(`SELECT * FROM import_jobs WHERE id = ?`).get(jobId);
  const allowed = job && (actor.role === ROLES.ADMIN || (job.created_by === actor.id && [ROLES.PRESALES, ROLES.MANAGER].includes(actor.role)));
  if (!allowed) throw new AppError(404, "IMPORT_JOB_NOT_FOUND", "导入任务不存在或当前账号无权访问");
  return job;
}

function sameNameCustomers(db, actor, sourceSha256, customerName) {
  if (!customerName) return { all: [], visible: [] };
  const rows = db.prepare(`
    SELECT c.id, c.full_name, c.registered_on, c.industry, c.need_summary, c.notes, c.owner_id, u.display_name AS owner_name,
      EXISTS (SELECT 1 FROM customer_import_origins o JOIN stored_files f ON f.id = o.source_file_id WHERE o.customer_id = c.id AND f.sha256 = ?) AS source_matched
    FROM customers c JOIN users u ON u.id = c.owner_id
    WHERE LOWER(TRIM(c.full_name)) = LOWER(TRIM(?)) ORDER BY c.created_at, c.id
  `).all(sourceSha256, customerName);
  const view = row => ({
    id: row.id, fullName: row.full_name, registeredOn: row.registered_on, industry: row.industry,
    needSummary: row.need_summary, notes: row.notes, owner: { id: row.owner_id, displayName: row.owner_name }, sourceMatched: Boolean(row.source_matched)
  });
  return { all: rows, visible: rows.filter(row => canReadCustomer(db, actor, row.id)).map(view) };
}

function exactOwnerCandidates(db, actor, salesText) {
  if (!salesText) return [];
  return db.prepare(`SELECT id, username, display_name, manager_id FROM users WHERE role = 'PRESALES' AND is_active = 1 ORDER BY display_name`).all()
    .filter(row => row.username.toLocaleLowerCase("zh-CN") === salesText.toLocaleLowerCase("zh-CN") || row.display_name.toLocaleLowerCase("zh-CN") === salesText.toLocaleLowerCase("zh-CN"))
    .filter(row => actor.role === ROLES.ADMIN || (actor.role === ROLES.PRESALES && row.id === actor.id) || (actor.role === ROLES.MANAGER && row.manager_id === actor.id))
    .map(row => ({ id: row.id, username: row.username, displayName: row.display_name }));
}

function contactCandidates(db, normalized, customers) {
  if (!normalized.contactName) return {};
  return Object.fromEntries(customers.map(customer => [customer.id, db.prepare(`
    SELECT id, name FROM contacts WHERE customer_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?)) ORDER BY created_at, id
  `).all(customer.id, normalized.contactName)]));
}

function entryView(db, actor, entry) {
  const source = parseJson(entry.source_json, {});
  const normalized = parseJson(entry.normalized_json, {});
  const errors = parseJson(entry.errors_json, []);
  const warnings = parseJson(entry.warnings_json, []);
  const origin = db.prepare(`SELECT * FROM visit_import_origins WHERE source_key = ?`).get(entry.source_key);
  const matches = sameNameCustomers(db, actor, entry.source_sha256, normalized.customerName);
  const visible = actor.role === ROLES.ADMIN || (origin ? canReadCustomer(db, actor, origin.customer_id) : matches.visible.length > 0);
  if (!visible) return { visible: false };
  const issues = [...errors];
  if (origin && (origin.source_json !== entry.source_json || origin.normalized_json !== entry.normalized_json)) issues.push("SOURCE_CONFLICT");
  if (actor.role !== ROLES.ADMIN && matches.all.length !== matches.visible.length) issues.push("DUPLICATE_SCOPE_REVIEW_REQUIRED");
  const decisions = origin ? db.prepare(`SELECT * FROM visit_import_decisions WHERE source_key = ? ORDER BY operated_at, id`).all(entry.source_key).map(row => ({
    id: row.id, decision: parseJson(row.decision_json, {}), result: parseJson(row.result_json, {}), operatedBy: row.operated_by, operatedAt: row.operated_at
  })) : [];
  const customer = origin ? matches.all.find(row => row.id === origin.customer_id) || db.prepare(`SELECT c.*, u.display_name AS owner_name FROM customers c JOIN users u ON u.id = c.owner_id WHERE c.id = ?`).get(origin.customer_id) : null;
  const boundCustomer = customer ? {
    id: customer.id, fullName: customer.full_name, registeredOn: customer.registered_on, industry: customer.industry,
    needSummary: customer.need_summary, notes: customer.notes, owner: { id: customer.owner_id, displayName: customer.owner_name }
  } : null;
  const candidateCustomers = matches.visible;
  const contactCustomerCandidates = boundCustomer && !candidateCustomers.some(item => item.id === boundCustomer.id)
    ? [...candidateCustomers, boundCustomer]
    : candidateCustomers;
  const confirmedFields = new Set(decisions.flatMap(item => Object.keys(item.decision.fieldActions || {})));
  const candidateFields = Object.entries(FIELD_CONFIG).map(([key, config]) => ({
    key,
    label: { registeredOn: "登记时间", industry: "行业", needSummary: "客户需求", notes: "备注" }[key],
    value: normalized[config.candidate],
    confirmed: confirmedFields.has(key)
  })).filter(item => item.value !== null && item.value !== undefined && String(item.value).trim() !== "");
  const canConfirm = issues.length === 0 && (actor.role === ROLES.ADMIN || (actor.role === ROLES.PRESALES && (boundCustomer ? boundCustomer.owner.id === actor.id : candidateCustomers.some(item => item.owner.id === actor.id))));
  return {
    visible: true, id: entry.id, sourceKey: entry.source_key, sourceSha256: entry.source_sha256, sheetName: entry.sheet_name,
    rowNumber: entry.source_row_number, source, normalized, status: issues.length ? "REVIEW_REQUIRED" : origin ? "PROCESSED" : "AWAITING_CONFIRMATION",
    issues: [...new Set(issues)].map(code => ({ code, message: ISSUE_LABELS[code] || (code.startsWith("FORMULA_REVIEW_REQUIRED:") ? `字段“${code.split(":")[1]}”为公式，保留原文待核对` : code) })),
    warnings: warnings.map(code => ({ code, message: ISSUE_LABELS[code] || code })), candidateCustomers,
    candidateFields, contactCandidates: contactCandidates(db, normalized, contactCustomerCandidates), ownerCandidates: exactOwnerCandidates(db, actor, normalized.salesText),
    boundCustomer, disposition: origin?.disposition || null, decisions, canConfirm,
    safeguards: { createsFollowup: false, createsReminder: false, mapsIntentionToStatus: false, mapsVisitStatusToStatus: false, plannedVisitIsActual: false }
  };
}

function visitPreviewView(db, actor, jobId) {
  const job = requireVisitJob(db, actor, jobId);
  const stored = db.prepare(`SELECT * FROM visit_import_entries WHERE job_id = ? ORDER BY source_row_number`).all(jobId);
  const entries = stored.map(entry => entryView(db, actor, entry)).filter(entry => entry.visible);
  if (actor.role !== ROLES.ADMIN && stored.length > 0 && entries.length === 0) throw new AppError(404, "VISIT_ROWS_NOT_FOUND", "当前任务没有可查看的本人客户来源行");
  return {
    jobId, fileId: job.file_id, sheetName: MUNICH_VISIT_SHEET, entries,
    counts: { total: entries.length, review: entries.filter(row => row.status === "REVIEW_REQUIRED").length, awaiting: entries.filter(row => row.status === "AWAITING_CONFIRMATION").length, processed: entries.filter(row => row.status === "PROCESSED").length }
  };
}

export function getMunichVisitPreview(db, actor, jobId) {
  return visitPreviewView(db, actor, jobId);
}

export async function previewMunichVisits(db, config, actor, jobId) {
  const job = requireVisitJob(db, actor, jobId);
  const file = getFileMetadata(db, job.file_id);
  const buffer = fs.readFileSync(resolveManagedPath(config, file.storageKey));
  assert(sha256(buffer) === file.sha256, 409, "SOURCE_HASH_MISMATCH", "归档来源文件摘要不一致，禁止解析");
  const workbook = await readWorkbook(buffer);
  requireVisitJob(db, actor, jobId);
  const sheet = workbook.getWorksheet(MUNICH_VISIT_SHEET);
  assert(sheet, 422, "VISIT_SHEET_MISSING", `工作簿缺少“${MUNICH_VISIT_SHEET}”工作表`);
  const headerValues = MUNICH_VISIT_FIELDS.map((_field, index) => cellValue(sheet.getRow(2).getCell(index + 1)).value);
  const extraHeaders = [];
  for (let column = MUNICH_VISIT_FIELDS.length + 1; column <= sheet.actualColumnCount; column += 1) {
    if (text(cellValue(sheet.getRow(2).getCell(column)).value, 200)) extraHeaders.push(column);
  }
  assert(validateMunichVisitHeaders(headerValues) && extraHeaders.length === 0, 422, "VISIT_HEADER_INVALID", "仅接受慕尼黑客户拜访记录第2行既定 A:K 表头");
  const rows = [];
  for (let rowNumber = 3; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = {};
    const formulas = [];
    for (let index = 0; index < MUNICH_VISIT_FIELDS.length; index += 1) {
      const field = MUNICH_VISIT_FIELDS[index];
      const cell = row.getCell(index + 1);
      const result = cellValue(cell);
      values[field.key] = result.formula ? `=${cell.value.formula || cell.value.sharedFormula || ""}` : result.value;
      if (result.formula) formulas.push(field.key);
    }
    if (Object.values(values).every(value => text(value) === "")) continue;
    const parsed = parseMunichVisitRow(values, formulas);
    rows.push({ ...parsed, rowNumber, sourceKey: visitSourceIdentity({ sourceSha256: file.sha256, sheetName: sheet.name, rowNumber }) });
  }
  assert(rows.length <= 5_000, 422, "VISIT_ROW_LIMIT", "慕尼黑拜访来源最多允许5000个非空行");
  db.transaction(() => {
    requireVisitJob(db, actor, jobId);
    const insert = db.prepare(`INSERT OR IGNORE INTO visit_import_entries (
      id, job_id, source_key, source_sha256, sheet_name, source_row_number, source_json, normalized_json, errors_json, warnings_json, previewed_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) insert.run(randomUUID(), jobId, row.sourceKey, file.sha256, sheet.name, row.rowNumber, JSON.stringify(row.rawFields), JSON.stringify(row.normalized), JSON.stringify(row.errors), JSON.stringify(row.warnings), actor.id, nowIso());
    audit(db, { actorId: actor.id, action: "MUNICH_VISIT_PREVIEWED", entityType: "IMPORT_JOB", entityId: jobId, summary: { sourceSha256: file.sha256, sheetName: sheet.name, rows: rows.length } });
  })();
  return visitPreviewView(db, actor, jobId);
}

function requireAssignableOwner(db, actor, ownerId) {
  const owner = db.prepare(`SELECT id, role, manager_id, is_active FROM users WHERE id = ?`).get(ownerId);
  assert(owner?.is_active && owner.role === ROLES.PRESALES, 400, "OWNER_INVALID", "负责人必须是已启用的售前人员");
  if (actor.role === ROLES.PRESALES) assert(owner.id === actor.id, 403, "VISIT_OWNER_FORBIDDEN", "售前只能确认本人负责的客户");
  if (actor.role === ROLES.MANAGER) assert(owner.manager_id === actor.id, 403, "VISIT_OWNER_FORBIDDEN", "部门负责人只能选择直属售前");
  return owner;
}

function normalizedDecision(requested) {
  const fieldActions = {};
  for (const key of Object.keys(requested?.fieldActions || {}).sort()) {
    assert(FIELD_CONFIG[key], 400, "VISIT_FIELD_INVALID", "存在不支持的字段候选");
    assert(["APPLY", "SKIP"].includes(requested.fieldActions[key]), 400, "VISIT_FIELD_ACTION_INVALID", "字段候选只能选择应用或保留原值");
    fieldActions[key] = requested.fieldActions[key];
  }
  const contact = requested?.contact ? { action: requested.contact.action, existingContactId: requested.contact.existingContactId || null } : null;
  if (contact) assert(["CREATE", "MATCH_EXISTING", "SKIP"].includes(contact.action), 400, "VISIT_CONTACT_ACTION_INVALID", "接洽人候选处理方式无效");
  return {
    action: requested?.action, customerId: requested?.customerId || null, ownerId: requested?.ownerId || null,
    customerStatus: requested?.customerStatus || null, fieldActions, contact,
    forceReason: text(requested?.forceReason, 500) || null, basisType: text(requested?.basisType, 50) || null, basis: text(requested?.basis, 1_000) || null
  };
}

function applyMergeFields(db, actor, customerId, normalized, fieldActions) {
  const current = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId);
  const patch = {};
  const appliedFields = [];
  const protectedFields = [];
  const confirmedFields = [];
  for (const [key, action] of Object.entries(fieldActions)) {
    const config = FIELD_CONFIG[key];
    const candidate = normalized[config.candidate];
    assert(candidate !== null && candidate !== undefined && String(candidate).trim() !== "", 400, "VISIT_FIELD_CANDIDATE_MISSING", `字段“${key}”没有可应用的来源候选`);
    confirmedFields.push(key);
    if (action === "SKIP") continue;
    if (current[config.column] !== null && String(current[config.column]).trim() !== "") protectedFields.push(key);
    else { patch[key] = candidate; appliedFields.push(key); }
  }
  if (Object.keys(patch).length) updateCustomer(db, actor, customerId, patch);
  return { appliedFields, protectedFields, confirmedFields };
}

function applyContactDecision(db, actor, customerId, normalized, contact) {
  if (!contact) return { action: null, contactId: null };
  if (contact.action === "SKIP") return { action: "SKIP", contactId: null };
  assert(normalized.contactName, 409, "VISIT_CONTACT_REVIEW_REQUIRED", "接洽人原文不只是明确姓名，不能自动建立联系人");
  const existing = db.prepare(`SELECT id, name FROM contacts WHERE customer_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?)) ORDER BY created_at, id`).all(customerId, normalized.contactName);
  if (contact.action === "CREATE") {
    assert(existing.length === 0, 409, "VISIT_CONTACT_DUPLICATE", "客户下已有同名联系人，请人工确认关联，不能重复创建");
    const created = createContact(db, actor, customerId, { name: normalized.contactName });
    return { action: "CREATED", contactId: created.id };
  }
  const matched = existing.find(item => item.id === contact.existingContactId);
  assert(matched, 409, "VISIT_CONTACT_MATCH_INVALID", "所选联系人不是该客户下的同名联系人");
  return { action: "MATCHED_EXISTING", contactId: matched.id };
}

function insertVisitOrigin(db, { job, entry, actor, customerId, disposition }) {
  db.prepare(`INSERT INTO visit_import_origins (
    source_key, customer_id, import_job_id, source_file_id, source_sha256, sheet_name, source_row_number,
    source_json, normalized_json, disposition, operated_by, imported_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(entry.source_key, customerId, job.id, job.file_id, entry.source_sha256, entry.sheet_name, entry.source_row_number, entry.source_json, entry.normalized_json, disposition, actor.id, nowIso());
}

function confirmOne(db, actor, job, entry, requested) {
  const view = entryView(db, actor, entry);
  assert(view.visible, 404, "VISIT_ENTRY_NOT_FOUND", "拜访来源行不存在或当前账号无权访问");
  assert(view.issues.length === 0, 409, "VISIT_REVIEW_REQUIRED", view.issues.map(issue => issue.message).join("；"));
  const decision = normalizedDecision(requested);
  assert(["MERGE", "CREATE", "FORCE_CREATE"].includes(decision.action), 400, "VISIT_CUSTOMER_ACTION_REQUIRED", "必须人工选择合并、新建或管理员强制新建");
  const requestHash = sha256(JSON.stringify(decision));
  const priorDecision = db.prepare(`SELECT result_json FROM visit_import_decisions WHERE source_key = ? AND request_hash = ?`).get(entry.source_key, requestHash);
  if (priorDecision) return { id: entry.id, status: "ALREADY_PROCESSED", ...parseJson(priorDecision.result_json, {}) };
  const normalized = parseJson(entry.normalized_json, {});
  const matches = sameNameCustomers(db, actor, entry.source_sha256, normalized.customerName);
  let origin = db.prepare(`SELECT * FROM visit_import_origins WHERE source_key = ?`).get(entry.source_key);
  let customerId = origin?.customer_id || null;
  let disposition = origin?.disposition || null;
  let createdCustomer = false;
  if (origin) {
    if (decision.customerId) assert(decision.customerId === customerId, 409, "VISIT_CUSTOMER_CHANGED", "该来源已绑定其他客户，禁止重新映射");
    assert(origin.source_json === entry.source_json && origin.normalized_json === entry.normalized_json, 409, "VISIT_SOURCE_CONFLICT", "已绑定来源与当前原文不一致");
  } else if (decision.action === "MERGE") {
    assert(decision.customerId, 400, "VISIT_CUSTOMER_REQUIRED", "必须人工选择合并客户");
    const target = matches.all.find(item => item.id === decision.customerId);
    assert(target && canReadCustomer(db, actor, target.id), 403, "VISIT_MERGE_FORBIDDEN", "只能合并到当前有权访问的同名客户");
    customerId = target.id;
    disposition = "MERGED";
  } else {
    assert(actor.role === ROLES.ADMIN, 403, "VISIT_CREATE_FORBIDDEN", "无匹配主体的拜访来源行仅管理员可新建客户");
    if (matches.all.length) {
      assert(decision.action === "FORCE_CREATE", 409, "VISIT_DUPLICATE_REVIEW_REQUIRED", "系统已有同名客户，须合并或按管理员强制同名规则处理");
      assert(decision.forceReason, 400, "IMPORT_FORCE_REASON_REQUIRED", "强制新建同名客户必须填写原因");
      assert(BASIS_TYPES.includes(decision.basisType) && decision.basis, 400, "IMPORT_DISTINGUISHING_BASIS_REQUIRED", "必须填写可审计的主体区分依据");
    } else assert(decision.action === "CREATE", 400, "VISIT_CREATE_ACTION_INVALID", "不存在同名主体时应选择新建客户");
    const owner = requireAssignableOwner(db, actor, decision.ownerId);
    assert(CUSTOMER_STATUSES.includes(decision.customerStatus), 400, "VISIT_CUSTOMER_STATUS_REQUIRED", "新建客户必须人工选择系统正式状态");
    assert(decision.fieldActions.needSummary === "APPLY" && normalized.needSummary, 400, "VISIT_CUSTOMER_NEED_REQUIRED", "新建客户必须明确应用来源中的客户需求，来源缺失时保留待核对");
    const input = { fullName: normalized.customerName, ownerId: owner.id, status: decision.customerStatus, needSummary: normalized.needSummary, registeredOn: null };
    for (const [key, action] of Object.entries(decision.fieldActions)) {
      const candidate = normalized[FIELD_CONFIG[key].candidate];
      assert(candidate !== null && candidate !== undefined && String(candidate).trim() !== "", 400, "VISIT_FIELD_CANDIDATE_MISSING", `字段“${key}”没有可应用的来源候选`);
      if (action === "APPLY") input[key] = candidate;
    }
    const customer = createCustomer(db, actor, input, { allowUnknownRegisteredOn: true, allowDuplicate: decision.action === "FORCE_CREATE", auditSource: decision.action === "FORCE_CREATE" ? "MUNICH_VISIT_IMPORT_FORCE" : "MUNICH_VISIT_IMPORT" });
    customerId = customer.id;
    disposition = decision.action === "FORCE_CREATE" ? "FORCED_CREATED" : "CREATED";
    createdCustomer = true;
  }
  const current = db.prepare(`SELECT owner_id FROM customers WHERE id = ?`).get(customerId);
  assert(current && canReadCustomer(db, actor, customerId), 404, "CUSTOMER_NOT_FOUND", "客户不存在或当前账号无权访问");
  assert(actor.role === ROLES.ADMIN || (actor.role === ROLES.PRESALES && current.owner_id === actor.id), 403, "VISIT_WRITE_FORBIDDEN", "只有管理员或客户当前负责人可以确认拜访来源");
  const owner = requireAssignableOwner(db, actor, decision.ownerId);
  assert(owner.id === current.owner_id, 409, "VISIT_OWNER_CHANGED", "所选负责人必须是客户当前已启用负责人；负责人调整须走客户转让流程");
  if (!origin) {
    insertVisitOrigin(db, { job, entry, actor, customerId, disposition });
    origin = db.prepare(`SELECT * FROM visit_import_origins WHERE source_key = ?`).get(entry.source_key);
    if (disposition === "FORCED_CREATED") {
      const insertRelation = db.prepare(`INSERT INTO customer_duplicate_relations (
        id, customer_id, related_customer_id, relation_type, reason, distinguishing_basis_type, distinguishing_basis, created_by, created_at
      ) VALUES (?, ?, ?, 'SAME_NAME_DISTINCT', ?, ?, ?, ?, ?)`);
      for (const item of matches.all) insertRelation.run(randomUUID(), customerId, item.id, decision.forceReason, decision.basisType, decision.basis, actor.id, nowIso());
    }
  }
  const fieldResult = createdCustomer
    ? { appliedFields: Object.entries(decision.fieldActions).filter(([, action]) => action === "APPLY").map(([key]) => key), protectedFields: [], confirmedFields: Object.keys(decision.fieldActions) }
    : applyMergeFields(db, actor, customerId, normalized, decision.fieldActions);
  const contactResult = applyContactDecision(db, actor, customerId, normalized, decision.contact);
  const result = { customerId, disposition, ...fieldResult, contact: contactResult, sourceKey: entry.source_key };
  db.prepare(`INSERT INTO visit_import_decisions (id, source_key, import_job_id, request_hash, decision_json, result_json, operated_by, operated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), entry.source_key, job.id, requestHash, JSON.stringify(decision), JSON.stringify(result), actor.id, nowIso());
  audit(db, { actorId: actor.id, action: "MUNICH_VISIT_ROW_CONFIRMED", entityType: "CUSTOMER", entityId: customerId, summary: { sourceKey: entry.source_key, disposition, appliedFields: fieldResult.appliedFields, protectedFields: fieldResult.protectedFields, contactAction: contactResult.action } });
  return { id: entry.id, status: "PROCESSED", ...result };
}

export function confirmMunichVisits(db, actor, jobId, input) {
  const job = requireVisitJob(db, actor, jobId);
  assert([ROLES.ADMIN, ROLES.PRESALES].includes(actor.role), 403, "VISIT_WRITE_FORBIDDEN", "只有管理员或客户当前负责人可以确认拜访来源");
  assert(input?.confirmed === true, 400, "VISIT_CONFIRM_REQUIRED", "请明确确认来源、客户、负责人和字段候选后再处理");
  assert(Array.isArray(input.entries) && input.entries.length > 0 && input.entries.length <= 50, 400, "VISIT_BATCH_INVALID", "每次确认1至50个拜访来源行");
  const results = [];
  for (const requested of input.entries) {
    const entryId = typeof requested?.id === "string" ? requested.id : null;
    try {
      const result = db.transaction(() => {
        requireVisitJob(db, actor, jobId);
        assert(entryId, 400, "VISIT_ENTRY_INVALID", "拜访来源行参数无效");
        const entry = db.prepare(`SELECT * FROM visit_import_entries WHERE id = ? AND job_id = ?`).get(entryId, jobId);
        assert(entry, 404, "VISIT_ENTRY_NOT_FOUND", "拜访来源行不存在");
        return confirmOne(db, actor, job, entry, requested);
      })();
      results.push(result);
    } catch (error) {
      results.push({ id: entryId, status: "FAILED", code: error instanceof AppError ? error.code : "VISIT_IMPORT_FAILED", message: error instanceof AppError ? error.message : "本行处理失败，已回滚，可重试" });
    }
  }
  return { ...visitPreviewView(db, actor, jobId), results };
}
