import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { createHistoricalFollowup, requireCustomerWrite } from "./customer-activity-service.js";
import { nowIso } from "./database.js";
import { AppError, assert } from "./domain.js";
import { getFileMetadata, resolveManagedPath } from "./file-service.js";
import { parseHistoricalFollowups, sourceIdentity } from "./historical-followup-parser.js";
import { cellValue, readWorkbook, requireJob } from "./import-service.js";
import { canReadCustomer } from "./permissions.js";
import { sha256 } from "./security.js";

const ERROR_LABELS = {
  DATE_YEAR_REQUIRED: "日期缺少完整年份，保留原文待核对", DATE_UNRECOGNIZED: "无法确定日期，保留原文待核对",
  DATE_INVALID: "日期不符合实际日历，保留原文待核对", MULTILINE_REVIEW_REQUIRED: "存在多行续文，归属需人工核对",
  TIME_REVIEW_REQUIRED: "存在时分或不明确时间格式，本批不自动解释", FORMULA_REVIEW_REQUIRED: "公式单元格需核对，不能当作历史原文导入",
  NO_MATCH: "尚无该文件/工作表/源行的客户来源关系，请先完成客户主档来源核对",
  AMBIGUOUS: "该源行关联多个客户主体，保留待核对，不自动选择或合并",
  FORBIDDEN: "当前账号无权访问来源客户", SOURCE_CONFLICT: "该源条目已有不同客户或内容的导入记录，禁止覆盖"
};

function matchEntry(db, actor, entry) {
  const origins = db.prepare(`SELECT o.id, o.customer_id, c.full_name FROM customer_import_origins o JOIN stored_files f ON f.id = o.source_file_id JOIN customers c ON c.id = o.customer_id WHERE f.sha256 = ? AND o.sheet_name = ? AND o.source_row_number = ? ORDER BY o.imported_at, o.id`)
    .all(entry.source_sha256, entry.sheet_name, entry.source_row_number);
  const ids = [...new Set(origins.map(row => row.customer_id))];
  if (!ids.length) return { issue: "NO_MATCH" };
  if (origins.some(row => !canReadCustomer(db, actor, row.customer_id))) return { issue: "FORBIDDEN" };
  if (ids.length > 1) return { issue: "AMBIGUOUS" };
  return { originId: origins[0].id, customer: { id: ids[0], name: origins[0].full_name } };
}

function entryView(db, actor, entry) {
  const matched = matchEntry(db, actor, entry);
  const imported = db.prepare(`SELECT o.*, f.customer_id FROM followup_import_origins o JOIN followups f ON f.id = o.followup_id WHERE o.source_key = ?`).get(entry.source_key);
  // 旧预览可能保存过错误 READY。读取/确认统一复核原文，不修改来源或已归档记录。
  const currentErrors = parseHistoricalFollowups(entry.raw_text).flatMap(row => row.errors);
  const issues = [...new Set([...JSON.parse(entry.errors_json), ...currentErrors])];
  if (matched.issue) issues.push(matched.issue);
  if (imported && (imported.customer_id !== matched.customer?.id || imported.raw_text !== entry.raw_text)) issues.push("SOURCE_CONFLICT");
  const status = issues.length ? "REVIEW_REQUIRED" : imported ? "ALREADY_IMPORTED" : "READY";
  return {
    id: entry.id, sourceKey: entry.source_key, sourceSha256: entry.source_sha256, sheetName: entry.sheet_name,
    cellReference: entry.cell_reference, rowNumber: entry.source_row_number, paragraphNumber: entry.paragraph_number,
    rawDate: entry.raw_date, rawMethod: entry.raw_method, rawText: entry.raw_text, occurredOn: currentErrors.length ? null : entry.occurred_on,
    occurredPrecision: "DAY", method: entry.method, customer: matched.customer || null, status,
    issues: issues.map(code => ({ code, message: ERROR_LABELS[code] || code })),
    followupId: status === "ALREADY_IMPORTED" ? imported.followup_id : null,
    canConfirm: status === "READY" && (actor.role === "ADMIN" || actor.role === "PRESALES")
  };
}

export function getHistoricalFollowupPreview(db, actor, jobId) {
  const job = requireJob(db, actor, jobId);
  const entries = db.prepare(`SELECT * FROM followup_import_entries WHERE job_id = ? ORDER BY source_row_number, paragraph_number`).all(jobId).map(entry => entryView(db, actor, entry));
  return { jobId, fileId: job.file_id, entries, counts: { total: entries.length, ready: entries.filter(row => row.status === "READY").length, review: entries.filter(row => row.status === "REVIEW_REQUIRED").length, imported: entries.filter(row => row.status === "ALREADY_IMPORTED").length } };
}

export async function previewHistoricalFollowups(db, config, actor, jobId) {
  const job = requireJob(db, actor, jobId);
  const file = getFileMetadata(db, job.file_id);
  const buffer = fs.readFileSync(resolveManagedPath(config, file.storageKey));
  assert(sha256(buffer) === file.sha256, 409, "SOURCE_HASH_MISMATCH", "归档来源文件摘要不一致，禁止解析");
  const workbook = await readWorkbook(buffer);
  requireJob(db, actor, jobId);
  const sheet = workbook.getWorksheet("信息收集");
  assert(sheet && String(cellValue(sheet.getCell("H2")).value).trim() === "客户情况总结" && String(cellValue(sheet.getCell("C2")).value).trim() === "客户名称", 422, "HISTORY_SHEET_INVALID", "仅支持信息收集页第2行表头、H列客户情况总结");
  assert(sheet.rowCount <= 5000, 422, "HISTORY_ROW_LIMIT", "历史来源页最多5000行");
  const rows = [];
  for (let rowNumber = 3; rowNumber <= sheet.rowCount; rowNumber++) {
    const cell = sheet.getCell(`H${rowNumber}`);
    const value = cellValue(cell);
    const raw = value.formula ? `=${cell.value.formula || cell.value.sharedFormula || ""}` : String(value.value ?? "");
    for (const parsed of parseHistoricalFollowups(raw)) {
      if (value.formula) parsed.errors.push("FORMULA_REVIEW_REQUIRED");
      rows.push({ ...parsed, rowNumber, sourceSha256: file.sha256, sheetName: sheet.name, cellReference: cell.address });
    }
  }
  assert(rows.length <= 10000, 422, "HISTORY_PARAGRAPH_LIMIT", "每批最多解析10000个历史段落");
  db.transaction(() => {
    requireJob(db, actor, jobId);
    const insert = db.prepare(`INSERT OR IGNORE INTO followup_import_entries (id, job_id, source_key, source_sha256, sheet_name, cell_reference, source_row_number, paragraph_number, raw_date, raw_method, raw_text, occurred_on, method, errors_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) insert.run(randomUUID(), jobId, sourceIdentity(row), file.sha256, row.sheetName, row.cellReference, row.rowNumber, row.paragraphNumber, row.rawDate, row.rawMethod, row.rawText, row.occurredOn, row.method, JSON.stringify(row.errors), nowIso());
    audit(db, { actorId: actor.id, action: "HISTORICAL_FOLLOWUPS_PREVIEWED", entityType: "IMPORT_JOB", entityId: jobId, summary: { sourceSha256: file.sha256, sheetName: sheet.name, paragraphs: rows.length } });
  })();
  return getHistoricalFollowupPreview(db, actor, jobId);
}

export function confirmHistoricalFollowups(db, actor, jobId, input) {
  const job = requireJob(db, actor, jobId);
  assert(["ADMIN", "PRESALES"].includes(actor.role), 403, "HISTORY_WRITE_FORBIDDEN", "只有管理员或客户当前售前负责人可以追加跟进");
  assert(input?.confirmed === true, 400, "HISTORY_CONFIRM_REQUIRED", "请明确确认源条目、日期精度和匹配客户后再追加");
  assert(Array.isArray(input.entries) && input.entries.length > 0 && input.entries.length <= 50, 400, "HISTORY_BATCH_INVALID", "每次确认1至50个历史段落");
  const results = [];
  for (const requested of input.entries) {
    const entryId = typeof requested?.id === "string" ? requested.id : null;
    try {
      const result = db.transaction(() => {
        requireJob(db, actor, jobId);
        assert(entryId, 400, "HISTORY_ENTRY_INVALID", "历史条目参数无效");
        const entry = db.prepare(`SELECT * FROM followup_import_entries WHERE id = ? AND job_id = ?`).get(entryId, jobId);
        assert(entry, 404, "HISTORY_ENTRY_NOT_FOUND", "历史预览条目不存在");
        const view = entryView(db, actor, entry);
        assert(view.status !== "REVIEW_REQUIRED", 409, "HISTORY_REVIEW_REQUIRED", view.issues.map(item => item.message).join("；"));
        assert(requested.customerId === view.customer.id, 409, "HISTORY_CUSTOMER_CHANGED", "匹配客户已改变，请重新预览并确认");
        requireCustomerWrite(db, actor, view.customer.id);
        if (view.status === "ALREADY_IMPORTED") return { id: entry.id, status: "ALREADY_IMPORTED", followupId: view.followupId };
        const matched = matchEntry(db, actor, entry);
        const followupId = createHistoricalFollowup(db, actor, view.customer.id, { occurredOn: entry.occurred_on, method: entry.method, rawText: entry.raw_text });
        db.prepare(`INSERT INTO followup_import_origins (source_key, followup_id, customer_origin_id, import_job_id, source_file_id, source_sha256, sheet_name, cell_reference, paragraph_number, raw_date, raw_method, raw_text, operated_by, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(entry.source_key, followupId, matched.originId, jobId, job.file_id, entry.source_sha256, entry.sheet_name, entry.cell_reference, entry.paragraph_number, entry.raw_date, entry.raw_method, entry.raw_text, actor.id, nowIso());
        audit(db, { actorId: actor.id, action: "FOLLOWUP_IMPORTED", entityType: "FOLLOWUP", entityId: followupId, summary: { customerId: view.customer.id, sourceKey: entry.source_key, jobId, occurredPrecision: "DAY" } });
        return { id: entry.id, status: "IMPORTED", followupId };
      })();
      results.push(result);
    } catch (error) {
      results.push({ id: entryId, status: "FAILED", code: error instanceof AppError ? error.code : "HISTORY_IMPORT_FAILED", message: error instanceof AppError ? error.message : "本条追加失败，已回滚，可重试" });
    }
  }
  return { ...getHistoricalFollowupPreview(db, actor, jobId), results };
}
