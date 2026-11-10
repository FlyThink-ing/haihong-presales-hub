import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { nowIso } from "./database.js";
import { AppError, assert, ROLES } from "./domain.js";
import { getFileMetadata, resolveManagedPath } from "./file-service.js";
import { cellValue, readWorkbook } from "./import-service.js";
import { canReadCustomer } from "./permissions.js";
import { sha256 } from "./security.js";
import { parseWeeklyReportRow, WEEKLY_REPORT_HEADER_ROW, WEEKLY_REPORT_SHEET, weeklyReportSourceIdentity } from "./weekly-report-parser.js";

const DATE_HANDLINGS = Object.freeze(["SOURCE_CELL", "NOT_RECORDED", "NOT_REQUIRED"]);
const CONTENT_HANDLINGS = Object.freeze(["SOURCE_CELLS", "NOT_RECORDED", "NOT_REQUIRED"]);

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function text(value, max) {
  const raw = String(value ?? "").trim();
  assert(raw.length <= max, 400, "WEEKLY_TEXT_TOO_LONG", `文本长度不能超过${max}字`);
  return raw;
}

function requireWeeklyJob(db, actor, jobId) {
  const job = db.prepare(`SELECT * FROM import_jobs WHERE id = ?`).get(jobId);
  const allowed = job && (actor.role === ROLES.ADMIN || (job.created_by === actor.id && [ROLES.PRESALES, ROLES.MANAGER].includes(actor.role)));
  if (!allowed) throw new AppError(404, "IMPORT_JOB_NOT_FOUND", "导入任务不存在或当前账号无权访问");
  return job;
}

function exactCustomerCandidates(db, actor, sourceCells) {
  const values = [...new Set(sourceCells.filter(cell => cell.valueType !== "FORMULA").map(cell => cell.rawText.trim()).filter(value => value && value.length <= 200))];
  if (!values.length) return { all: [], visible: [] };
  const rows = db.prepare(`
    SELECT c.id, c.full_name, c.owner_id, u.display_name AS owner_name
    FROM customers c JOIN users u ON u.id = c.owner_id
    WHERE LOWER(TRIM(c.full_name)) IN (${values.map(() => "LOWER(TRIM(?))").join(",")})
    ORDER BY c.created_at, c.id
  `).all(...values);
  const view = row => ({
    id: row.id,
    fullName: row.full_name,
    owner: { id: row.owner_id, displayName: row.owner_name },
    matchedCells: sourceCells.filter(cell => cell.valueType !== "FORMULA" && cell.rawText.trim().toLocaleLowerCase("zh-CN") === row.full_name.trim().toLocaleLowerCase("zh-CN")).map(cell => cell.cellReference)
  });
  return { all: rows, visible: rows.filter(row => canReadCustomer(db, actor, row.id)).map(view) };
}

function decisionView(row) {
  const decision = parseJson(row.decision_json, {});
  return {
    id: row.id,
    action: decision.action,
    customerId: row.customer_id,
    businessType: row.business_type,
    dateHandling: row.date_handling,
    dateCellReference: row.date_cell_reference,
    contentHandling: row.content_handling,
    contentCellReferences: parseJson(row.content_cell_references_json, []),
    createdBusinessRecords: [],
    amountTransferred: false,
    operatedBy: row.operated_by,
    operatedAt: row.operated_at
  };
}

function linkedCustomerIds(db, sourceKey) {
  return db.prepare(`SELECT DISTINCT customer_id FROM weekly_report_decisions WHERE source_key = ? AND customer_id IS NOT NULL`).all(sourceKey).map(row => row.customer_id);
}

function entryView(db, actor, entry) {
  const sourceCells = parseJson(entry.cells_json, []);
  const candidates = parseJson(entry.candidates_json, {});
  const warnings = parseJson(entry.warnings_json, []);
  const matches = exactCustomerCandidates(db, actor, entry.source_row_number === WEEKLY_REPORT_HEADER_ROW ? [] : sourceCells);
  const linkedIds = linkedCustomerIds(db, entry.source_key);
  const linkedId = linkedIds.length === 1 ? linkedIds[0] : null;
  const linkedRow = linkedId ? db.prepare(`SELECT c.id, c.full_name, c.owner_id, u.display_name AS owner_name FROM customers c JOIN users u ON u.id = c.owner_id WHERE c.id = ?`).get(linkedId) : null;
  const linkedCustomer = linkedRow ? { id: linkedRow.id, fullName: linkedRow.full_name, owner: { id: linkedRow.owner_id, displayName: linkedRow.owner_name } } : null;
  const visible = actor.role === ROLES.ADMIN || (linkedId ? canReadCustomer(db, actor, linkedId) : matches.visible.length > 0);
  if (!visible) return { visible: false };
  const decisions = db.prepare(`SELECT * FROM weekly_report_decisions WHERE source_key = ? ORDER BY operated_at, id`).all(entry.source_key).map(decisionView);
  const issues = [];
  if (linkedIds.length > 1) issues.push({ code: "WEEKLY_MULTIPLE_CUSTOMERS", message: "该来源存在多个客户关联，禁止继续确认并请管理员核对" });
  if (actor.role !== ROLES.ADMIN && matches.all.length !== matches.visible.length) issues.push({ code: "WEEKLY_CUSTOMER_SCOPE_AMBIGUOUS", message: "存在当前账号无权核对的同名主体，本行须由管理员处理" });
  const candidateCustomers = matches.visible;
  const canConfirm = issues.length === 0 && (actor.role === ROLES.ADMIN || (actor.role === ROLES.PRESALES && (linkedCustomer ? linkedCustomer.owner.id === actor.id : candidateCustomers.some(item => item.owner.id === actor.id))));
  return {
    visible: true,
    id: entry.id,
    sourceKey: entry.source_key,
    sourceSha256: entry.source_sha256,
    sheetName: entry.sheet_name,
    rowNumber: entry.source_row_number,
    sourceCells,
    candidates,
    candidateCustomers,
    linkedCustomer,
    decisions,
    status: linkedCustomer ? "LINKED_SOURCE" : decisions.length ? "CLASSIFIED_ONLY" : "AWAITING_CLASSIFICATION",
    issues,
    warnings: warnings.map(code => ({ code, message: code.startsWith("FORMULA_REVIEW_REQUIRED:") ? `${code.split(":")[1]} 为公式，只保留公式原文供人工分类` : `${code.split(":")[1]} 内容较长，原文完整保留` })),
    canConfirm,
    safeguards: { createsFollowup: false, createsReminder: false, createsQuote: false, createsContract: false, transfersAmount: false, guessesCustomer: false, guessesDate: false }
  };
}

function previewView(db, actor, jobId, { search = "" } = {}) {
  requireWeeklyJob(db, actor, jobId);
  const stored = db.prepare(`SELECT * FROM weekly_report_entries WHERE job_id = ? ORDER BY source_row_number`).all(jobId);
  let entries = stored.map(entry => entryView(db, actor, entry)).filter(entry => entry.visible);
  if (actor.role !== ROLES.ADMIN && stored.length > 0 && entries.length === 0) throw new AppError(404, "WEEKLY_ROWS_NOT_FOUND", "当前任务没有可查看的本人客户周报来源行");
  const keyword = String(search || "").trim().toLocaleLowerCase("zh-CN");
  if (keyword) entries = entries.filter(entry => JSON.stringify({ cells: entry.sourceCells, decisions: entry.decisions, customer: entry.linkedCustomer }).toLocaleLowerCase("zh-CN").includes(keyword));
  return {
    jobId,
    sheetName: WEEKLY_REPORT_SHEET,
    entries,
    counts: {
      total: entries.length,
      awaiting: entries.filter(entry => entry.status === "AWAITING_CLASSIFICATION").length,
      classified: entries.filter(entry => entry.status === "CLASSIFIED_ONLY").length,
      linked: entries.filter(entry => entry.status === "LINKED_SOURCE").length
    }
  };
}

export function getWeeklyReportPreview(db, actor, jobId, options = {}) {
  return previewView(db, actor, jobId, options);
}

export async function previewWeeklyReport(db, config, actor, jobId) {
  const job = requireWeeklyJob(db, actor, jobId);
  const file = getFileMetadata(db, job.file_id);
  const buffer = fs.readFileSync(resolveManagedPath(config, file.storageKey));
  assert(sha256(buffer) === file.sha256, 409, "SOURCE_HASH_MISMATCH", "归档来源文件摘要不一致，禁止解析");
  const workbook = await readWorkbook(buffer);
  requireWeeklyJob(db, actor, jobId);
  const sheet = workbook.getWorksheet(WEEKLY_REPORT_SHEET);
  assert(sheet, 422, "WEEKLY_SHEET_MISSING", `工作簿缺少“${WEEKLY_REPORT_SHEET}”工作表`);
  const headerCells = [];
  for (let column = 1; column <= sheet.actualColumnCount; column += 1) {
    const cell = sheet.getRow(WEEKLY_REPORT_HEADER_ROW).getCell(column);
    const result = cellValue(cell);
    if (String(result.value ?? "").trim()) headerCells.push({ columnNumber: column, value: result.value });
  }
  const rows = [];
  for (let rowNumber = 1; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const cells = [];
    for (let column = 1; column <= sheet.actualColumnCount; column += 1) {
      const cell = row.getCell(column);
      const result = cellValue(cell);
      const formula = result.formula ? cell.value.formula || cell.value.sharedFormula || "" : null;
      if (!formula && String(result.value ?? "").trim() === "") continue;
      cells.push({ cellReference: cell.address, columnNumber: column, value: result.value, formula, formulaResult: result.formula ? cell.value.result : null });
    }
    if (!cells.length) continue;
    const parsed = parseWeeklyReportRow({ rowNumber, cells, headerCells });
    rows.push({ ...parsed, sourceKey: weeklyReportSourceIdentity({ sourceSha256: file.sha256, sheetName: sheet.name, rowNumber }) });
  }
  assert(rows.length <= 5_000, 422, "WEEKLY_ROW_LIMIT", "周汇报最多允许5000个非空来源行");
  db.transaction(() => {
    requireWeeklyJob(db, actor, jobId);
    const insert = db.prepare(`INSERT OR IGNORE INTO weekly_report_entries (
      id, job_id, source_key, source_sha256, sheet_name, source_row_number, cells_json, candidates_json, warnings_json, previewed_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) insert.run(randomUUID(), jobId, row.sourceKey, file.sha256, sheet.name, row.rowNumber, JSON.stringify(row.sourceCells), JSON.stringify(row.candidates), JSON.stringify(row.warnings), actor.id, nowIso());
    audit(db, { actorId: actor.id, action: "WEEKLY_REPORT_PREVIEWED", entityType: "IMPORT_JOB", entityId: jobId, summary: { sourceSha256: file.sha256, sheetName: sheet.name, rows: rows.length } });
  })();
  return previewView(db, actor, jobId);
}

function normalizedDecision(requested, sourceCells) {
  const refs = new Set(sourceCells.map(cell => cell.cellReference));
  const action = requested?.action;
  assert(["CLASSIFY_ONLY", "LINK_CUSTOMER"].includes(action), 400, "WEEKLY_ACTION_REQUIRED", "必须选择仅分类归档或关联现有客户来源");
  const businessType = text(requested?.businessType, 100);
  assert(businessType, 400, "WEEKLY_BUSINESS_TYPE_REQUIRED", "必须人工填写业务类型");
  const dateHandling = requested?.dateHandling;
  assert(DATE_HANDLINGS.includes(dateHandling), 400, "WEEKLY_DATE_CONFIRM_REQUIRED", "必须确认日期来自哪个单元格、原文未记录或该类型无需日期");
  let dateCellReference = null;
  if (dateHandling === "SOURCE_CELL") {
    dateCellReference = String(requested?.dateCellReference || "");
    assert(refs.has(dateCellReference), 400, "WEEKLY_DATE_CELL_INVALID", "确认的日期单元格不属于该来源行");
  }
  const contentHandling = requested?.contentHandling;
  assert(CONTENT_HANDLINGS.includes(contentHandling), 400, "WEEKLY_CONTENT_CONFIRM_REQUIRED", "必须确认内容来自哪些单元格、原文未记录或该类型无需内容");
  let contentCellReferences = [];
  if (contentHandling === "SOURCE_CELLS") {
    assert(Array.isArray(requested?.contentCellReferences), 400, "WEEKLY_CONTENT_CELLS_INVALID", "内容单元格参数无效");
    contentCellReferences = [...new Set(requested.contentCellReferences.map(String))];
    assert(contentCellReferences.length > 0 && contentCellReferences.length <= 20 && contentCellReferences.every(ref => refs.has(ref)), 400, "WEEKLY_CONTENT_CELLS_INVALID", "内容单元格必须来自该行且不超过20个");
  }
  assert(requested?.noBusinessRecordConfirmed === true, 400, "WEEKLY_NO_RECORD_CONFIRM_REQUIRED", "必须确认本期只归档分类/关联来源且不生成跟进、提醒、报价或合同");
  return {
    action,
    customerId: action === "LINK_CUSTOMER" ? String(requested?.customerId || "") : null,
    businessType,
    dateHandling,
    dateCellReference,
    contentHandling,
    contentCellReferences,
    noBusinessRecordConfirmed: true
  };
}

function confirmOne(db, actor, job, entry, requested) {
  const view = entryView(db, actor, entry);
  assert(view.visible, 404, "WEEKLY_ENTRY_NOT_FOUND", "周报来源行不存在或当前账号无权访问");
  assert(view.issues.length === 0, 409, "WEEKLY_REVIEW_REQUIRED", view.issues.map(issue => issue.message).join("；"));
  const sourceCells = parseJson(entry.cells_json, []);
  const decision = normalizedDecision(requested, sourceCells);
  assert(actor.role === ROLES.ADMIN || actor.role === ROLES.PRESALES, 403, "WEEKLY_WRITE_FORBIDDEN", "部门负责人只读，只有管理员或客户当前负责人可确认周报来源");
  const requestHash = sha256(JSON.stringify(decision));
  const prior = db.prepare(`SELECT result_json FROM weekly_report_decisions WHERE source_key = ? AND request_hash = ?`).get(entry.source_key, requestHash);
  if (prior) return { id: entry.id, status: "ALREADY_CONFIRMED", ...parseJson(prior.result_json, {}) };
  const matches = exactCustomerCandidates(db, actor, entry.source_row_number === WEEKLY_REPORT_HEADER_ROW ? [] : sourceCells);
  const existingLinked = linkedCustomerIds(db, entry.source_key);
  let customerId = null;
  if (decision.action === "LINK_CUSTOMER") {
    assert(decision.customerId, 400, "WEEKLY_CUSTOMER_REQUIRED", "必须人工选择现有客户主体");
    const target = matches.all.find(item => item.id === decision.customerId)
      || (existingLinked.includes(decision.customerId) ? db.prepare(`SELECT id, owner_id FROM customers WHERE id = ?`).get(decision.customerId) : null);
    assert(target && canReadCustomer(db, actor, target.id), 403, "WEEKLY_CUSTOMER_FORBIDDEN", "只能关联该行精确候选且当前有权访问的客户");
    assert(existingLinked.length === 0 || (existingLinked.length === 1 && existingLinked[0] === target.id), 409, "WEEKLY_CUSTOMER_CHANGED", "该来源已关联其他客户，禁止覆盖；请保留原决定并由管理员核对");
    assert(actor.role === ROLES.ADMIN || target.owner_id === actor.id, 403, "WEEKLY_WRITE_FORBIDDEN", "只有管理员或客户当前负责人可确认周报来源");
    customerId = target.id;
  } else {
    assert(actor.role === ROLES.ADMIN, 403, "WEEKLY_CLASSIFY_ONLY_FORBIDDEN", "未关联客户的来源仅管理员可分类归档");
  }
  let origin = db.prepare(`SELECT * FROM weekly_report_origins WHERE source_key = ?`).get(entry.source_key);
  if (!origin) {
    db.prepare(`INSERT INTO weekly_report_origins (
      source_key, first_import_job_id, source_file_id, source_sha256, sheet_name, source_row_number, cells_json, candidates_json, first_confirmed_by, first_confirmed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entry.source_key, job.id, job.file_id, entry.source_sha256, entry.sheet_name, entry.source_row_number, entry.cells_json, entry.candidates_json, actor.id, nowIso());
    origin = db.prepare(`SELECT * FROM weekly_report_origins WHERE source_key = ?`).get(entry.source_key);
  }
  assert(origin.cells_json === entry.cells_json && origin.candidates_json === entry.candidates_json, 409, "WEEKLY_SOURCE_CONFLICT", "已归档来源与当前原文不一致，禁止覆盖");
  const result = {
    sourceKey: entry.source_key,
    disposition: customerId ? "LINKED_SOURCE" : "CLASSIFIED_ONLY",
    customerId,
    businessType: decision.businessType,
    createdBusinessRecords: [],
    amountTransferred: false
  };
  db.prepare(`INSERT INTO weekly_report_decisions (
    id, source_key, import_job_id, request_hash, customer_id, business_type, date_handling, date_cell_reference,
    content_handling, content_cell_references_json, decision_json, result_json, operated_by, operated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), entry.source_key, job.id, requestHash, customerId, decision.businessType, decision.dateHandling, decision.dateCellReference, decision.contentHandling, JSON.stringify(decision.contentCellReferences), JSON.stringify(decision), JSON.stringify(result), actor.id, nowIso());
  audit(db, {
    actorId: actor.id,
    action: "WEEKLY_REPORT_SOURCE_CONFIRMED",
    entityType: customerId ? "CUSTOMER" : "IMPORT_JOB",
    entityId: customerId || job.id,
    summary: { sourceKey: entry.source_key, disposition: result.disposition, businessType: decision.businessType, createdBusinessRecords: [], amountTransferred: false }
  });
  return { id: entry.id, status: "CONFIRMED", ...result };
}

export function confirmWeeklyReportSources(db, actor, jobId, input) {
  const job = requireWeeklyJob(db, actor, jobId);
  assert([ROLES.ADMIN, ROLES.PRESALES].includes(actor.role), 403, "WEEKLY_WRITE_FORBIDDEN", "部门负责人只读，只有管理员或客户当前负责人可确认周报来源");
  assert(input?.confirmed === true, 400, "WEEKLY_CONFIRM_REQUIRED", "请明确确认来源、客户、业务类型、日期和内容后再处理");
  assert(Array.isArray(input.entries) && input.entries.length > 0 && input.entries.length <= 50, 400, "WEEKLY_BATCH_INVALID", "每次确认1至50个周报来源行");
  const results = [];
  for (const requested of input.entries) {
    const entryId = typeof requested?.id === "string" ? requested.id : null;
    try {
      const result = db.transaction(() => {
        requireWeeklyJob(db, actor, jobId);
        assert(entryId, 400, "WEEKLY_ENTRY_INVALID", "周报来源行参数无效");
        const entry = db.prepare(`SELECT * FROM weekly_report_entries WHERE id = ? AND job_id = ?`).get(entryId, jobId);
        assert(entry, 404, "WEEKLY_ENTRY_NOT_FOUND", "周报来源行不存在");
        return confirmOne(db, actor, job, entry, requested);
      })();
      results.push(result);
    } catch (error) {
      results.push({ id: entryId, status: "FAILED", code: error instanceof AppError ? error.code : "WEEKLY_CONFIRM_FAILED", message: error instanceof AppError ? error.message : "本行处理失败，已回滚，可重试" });
    }
  }
  return { ...previewView(db, actor, jobId), results };
}
