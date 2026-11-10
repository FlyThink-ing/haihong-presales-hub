import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { audit } from "./audit.js";
import { createCustomer } from "./customer-service.js";
import { nowIso } from "./database.js";
import { AppError, assert, CUSTOMER_STATUSES, ROLES } from "./domain.js";
import { getFileMetadata, storeFile, validateUploadedFile } from "./file-service.js";
import { canReadCustomer, canReadImportJob, canReadImportSource } from "./permissions.js";
import { sha256 } from "./security.js";

const LEGACY_STATUS_MAPPINGS = Object.freeze({
  "签订合同中": "报价完成&商务洽谈"
});

const DISTINGUISHING_BASIS_TYPES = Object.freeze(["CREDIT_CODE", "ADDRESS", "BRANCH", "OTHER"]);

export const CUSTOMER_IMPORT_FIELDS = Object.freeze([
  { key: "source", label: "客户来源", aliases: ["客户来源", "来源"] },
  { key: "fullName", label: "客户名称", aliases: ["客户名称", "客户全称", "公司名称"], required: true },
  { key: "customerType", label: "客户类型", aliases: ["客户类型", "新老客户"] },
  { key: "registeredOn", label: "登记时间", aliases: ["登记时间", "登记日期", "创建日期"] },
  { key: "status", label: "状态", aliases: ["状态", "客户状态"], required: true },
  { key: "needSummary", label: "客户需求", aliases: ["客户需求", "需求", "需求概要"], required: true },
  { key: "summary", label: "客户情况总结", aliases: ["客户情况总结", "客户总结", "情况总结"] },
  { key: "notes", label: "备注", aliases: ["备注", "说明"] }
]);

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function text(value, max = 2_000) {
  return String(value ?? "").trim().slice(0, max);
}

export function cellValue(cell) {
  const value = cell.value;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    if (Object.hasOwn(value, "formula") || Object.hasOwn(value, "sharedFormula")) return { formula: true, value: value.result ?? "" };
    if (Object.hasOwn(value, "text")) return { formula: false, value: value.text };
    if (Array.isArray(value.richText)) return { formula: false, value: value.richText.map(item => item.text).join("") };
  }
  return { formula: false, value };
}

function normalizeHeader(value) {
  return text(value, 200).replace(/[\s（）()：:]/g, "").toLowerCase();
}

function autoMapping(headers) {
  const result = {};
  for (const field of CUSTOMER_IMPORT_FIELDS) {
    const column = headers.find(header => field.aliases.some(alias => normalizeHeader(alias) === normalizeHeader(header.label)));
    if (column) result[field.key] = column.column;
  }
  return result;
}

function detectHeaderRow(worksheet) {
  let best = { row: 1, score: -1, headers: [] };
  const limit = Math.min(20, worksheet.actualRowCount || worksheet.rowCount || 1);
  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const headers = [];
    row.eachCell({ includeEmpty: false }, (cell, column) => {
      const value = cellValue(cell).value;
      if (text(value, 200)) headers.push({ column, label: text(value, 200) });
    });
    const normalized = new Set(headers.map(header => normalizeHeader(header.label)));
    const score = CUSTOMER_IMPORT_FIELDS.reduce((sum, field) => sum + (field.aliases.some(alias => normalized.has(normalizeHeader(alias))) ? 1 : 0), 0);
    if (score > best.score || (score === best.score && headers.length > best.headers.length)) best = { row: rowNumber, score, headers };
  }
  return best;
}

export async function readWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer, { ignoreNodes: ["drawing", "legacyDrawing", "picture", "extLst"] });
  } catch {
    throw new AppError(422, "XLSX_PARSE_FAILED", "Excel 文件无法解析，请确认文件未损坏且为 .xlsx 格式");
  }
  assert(workbook.worksheets.length > 0 && workbook.worksheets.length <= 20, 422, "XLSX_SHEET_LIMIT", "Excel 工作表数量必须在 1 至 20 之间");
  for (const worksheet of workbook.worksheets) {
    assert((worksheet.actualRowCount || 0) <= 5_000 && (worksheet.actualColumnCount || 0) <= 100, 422, "XLSX_DIMENSION_LIMIT", "单个工作表最多允许 5000 行、100 列");
  }
  return workbook;
}

function workbookSummary(workbook) {
  return workbook.worksheets.map(worksheet => {
    const detected = detectHeaderRow(worksheet);
    return { name: worksheet.name, state: worksheet.state || "visible", rowCount: worksheet.actualRowCount, columnCount: worksheet.actualColumnCount, detectedHeaderRow: detected.row, detectedHeaders: detected.headers };
  });
}

function chooseWorksheet(workbook) {
  const candidates = workbook.worksheets.map(worksheet => ({ worksheet, detected: detectHeaderRow(worksheet) }));
  return candidates.sort((a, b) => Number(b.worksheet.state === "visible") - Number(a.worksheet.state === "visible") || b.detected.score - a.detected.score)[0];
}

function excelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86_400_000));
    if (!Number.isNaN(date.valueOf())) return date.toISOString().slice(0, 10);
  }
  const raw = text(value, 50).replace(/[年/.]/g, "-").replace(/月/g, "-").replace(/日/g, "");
  const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const normalized = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const date = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== normalized ? null : normalized;
}

function validateMappedRow(db, values, formulas, seenNames) {
  const errors = [];
  for (const field of CUSTOMER_IMPORT_FIELDS) if (field.required && !text(values[field.key])) errors.push(`${field.label}不能为空`);
  for (const key of formulas) errors.push(`${CUSTOMER_IMPORT_FIELDS.find(field => field.key === key)?.label || key}不接受公式，请先转换为值`);
  const registeredOn = excelDate(values.registeredOn);
  if (text(values.registeredOn) && !registeredOn) errors.push("登记时间格式无效，应为有效日期");
  const originalStatus = text(values.status, 100);
  const status = LEGACY_STATUS_MAPPINGS[originalStatus] || originalStatus;
  if (status && !CUSTOMER_STATUSES.includes(status)) errors.push(`状态“${originalStatus}”不在系统允许范围内`);
  // 历史来源/类型原文不套固定枚举、不静默截断或合并，交管理员候选确认。
  const customerType = String(values.customerType ?? "");
  const customerSource = String(values.source ?? "");
  const fullName = text(values.fullName, 200);
  if (String(values.fullName ?? "").trim().length > 200) errors.push("客户名称不能超过 200 个字符");
  if (String(values.needSummary ?? "").trim().length > 2_000) errors.push("客户需求不能超过 2000 个字符");
  const nameKey = fullName.toLocaleLowerCase("zh-CN");
  const existingCount = fullName ? db.prepare(`SELECT COUNT(*) AS count FROM customers WHERE LOWER(TRIM(full_name)) = LOWER(?)`).get(fullName).count : 0;
  const withinFile = fullName && seenNames.has(nameKey) ? 1 : 0;
  if (fullName) seenNames.add(nameKey);
  return {
    normalized: {
      source: customerSource.trim() ? customerSource : null,
      fullName,
      customerType: customerType.trim() ? customerType : null,
      registeredOn,
      status,
      originalStatus,
      statusMapping: status !== originalStatus ? { from: originalStatus, to: status } : null,
      needSummary: text(values.needSummary),
      summary: text(values.summary) || null,
      notes: text(values.notes) || null
    },
    errors,
    duplicateCount: existingCount + withinFile
  };
}

export function requireJob(db, actor, jobId) {
  const row = db.prepare(`SELECT * FROM import_jobs WHERE id = ?`).get(jobId);
  if (!row || !canReadImportJob(db, actor, jobId)) throw new AppError(404, "IMPORT_JOB_NOT_FOUND", "导入任务不存在或当前账号无权访问");
  return row;
}

function refreshJobCounts(db, jobId) {
  const counts = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS count FROM import_rows WHERE job_id = ? GROUP BY status`).all(jobId).map(row => [row.status, row.count]));
  const totalRows = Object.values(counts).reduce((sum, count) => sum + count, 0);
  db.prepare(`
    UPDATE import_jobs SET total_rows = ?, valid_rows = ?, duplicate_rows = ?, failed_rows = ?, imported_rows = ?, updated_at = ? WHERE id = ?
  `).run(totalRows, counts.VALID || 0, counts.DUPLICATE || 0, counts.FAILED || 0, counts.IMPORTED || 0, nowIso(), jobId);
}

function duplicateCandidates(db, actor, fullName) {
  if (!actor || !fullName) return [];
  return db.prepare(`
    SELECT c.id, c.full_name, c.registered_on, c.address, c.owner_id, u.display_name AS owner_name
    FROM customers c JOIN users u ON u.id = c.owner_id
    WHERE LOWER(TRIM(c.full_name)) = LOWER(TRIM(?)) ORDER BY c.created_at
  `).all(fullName).filter(item => canReadCustomer(db, actor, item.id)).map(item => ({
    id: item.id,
    fullName: item.full_name,
    registeredOn: item.registered_on,
    address: item.address,
    owner: { id: item.owner_id, displayName: item.owner_name }
  }));
}

function jobView(db, jobId, { includeRows = true, actor = null } = {}) {
  const row = db.prepare(`SELECT * FROM import_jobs WHERE id = ?`).get(jobId);
  const mappingLocked = Boolean(db.prepare(`SELECT 1 FROM customer_import_origins WHERE import_job_id = ? UNION ALL SELECT 1 FROM followup_import_origins WHERE import_job_id = ? UNION ALL SELECT 1 FROM visit_import_origins WHERE import_job_id = ? UNION ALL SELECT 1 FROM weekly_report_decisions WHERE import_job_id = ? LIMIT 1`).get(jobId, jobId, jobId, jobId));
  const value = { id: row.id, fileId: row.file_id, targetType: row.target_type, status: row.status, sheetName: row.sheet_name, headerRow: row.header_row, fieldMapping: parseJson(row.field_mapping_json, {}), counts: { total: row.total_rows, valid: row.valid_rows, duplicate: row.duplicate_rows, failed: row.failed_rows, imported: row.imported_rows }, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
  if (includeRows) value.rows = db.prepare(`SELECT row_number, source_json, normalized_json, status, errors_json, duplicate_count, imported_customer_id FROM import_rows WHERE job_id = ? ORDER BY row_number LIMIT 500`).all(jobId).map(item => {
    const normalized = parseJson(item.normalized_json, null);
    return { rowNumber: item.row_number, source: parseJson(item.source_json, {}), normalized, status: item.status, errors: parseJson(item.errors_json, []), duplicateCount: item.duplicate_count, importedCustomerId: item.imported_customer_id, duplicateCandidates: item.status === "DUPLICATE" ? duplicateCandidates(db, actor, normalized?.fullName) : [] };
  });
  return { ...value, mappingLocked };
}

async function rebuildPreview(db, config, actor, job, { sheetName, headerRow, fieldMapping }) {
  const requireUncommitted = () => {
    requireJob(db, actor, job.id);
    assert(!db.prepare(`SELECT 1 FROM customer_import_origins WHERE import_job_id = ? LIMIT 1`).get(job.id)
      && !db.prepare(`SELECT 1 FROM followup_import_origins WHERE import_job_id = ? LIMIT 1`).get(job.id)
      && !db.prepare(`SELECT 1 FROM visit_import_origins WHERE import_job_id = ? LIMIT 1`).get(job.id)
      && !db.prepare(`SELECT 1 FROM weekly_report_decisions WHERE import_job_id = ? LIMIT 1`).get(job.id), 409, "IMPORT_PREVIEW_LOCKED", "已有提交来源的任务不可重新映射，请保留原任务并新建预览");
  };
  requireUncommitted();
  const file = getFileMetadata(db, job.file_id);
  const absolutePath = path.resolve(config.storagePath, ...file.storageKey.split("/"));
  const workbook = await readWorkbook(fs.readFileSync(absolutePath));
  const worksheet = workbook.getWorksheet(sheetName);
  assert(worksheet, 400, "IMPORT_SHEET_INVALID", "选择的工作表不存在");
  assert(Number.isInteger(headerRow) && headerRow >= 1 && headerRow <= Math.min(20, worksheet.rowCount), 400, "IMPORT_HEADER_ROW_INVALID", "表头行必须在前 20 行内");
  const headers = [];
  worksheet.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, column) => headers.push({ column, label: text(cellValue(cell).value, 200) }));
  const headerColumns = new Set(headers.map(header => header.column));
  const mapping = {};
  for (const field of CUSTOMER_IMPORT_FIELDS) {
    const column = Number(fieldMapping?.[field.key]);
    if (Number.isInteger(column) && headerColumns.has(column)) mapping[field.key] = column;
    if (field.required) assert(mapping[field.key], 400, "IMPORT_MAPPING_REQUIRED", `必须映射“${field.label}”字段`);
  }
  const timestamp = nowIso();
  const rows = [];
  const seenNames = new Set();
  for (let rowNumber = headerRow + 1; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = {};
    const formulas = [];
    for (const field of CUSTOMER_IMPORT_FIELDS) {
      if (!mapping[field.key]) continue;
      const result = cellValue(row.getCell(mapping[field.key]));
      values[field.key] = result.value;
      if (result.formula) formulas.push(field.key);
    }
    if (Object.values(values).every(value => text(value) === "")) continue;
    const checked = validateMappedRow(db, values, formulas, seenNames);
    const status = checked.errors.length ? "FAILED" : checked.duplicateCount ? "DUPLICATE" : "VALID";
    rows.push({ id: randomUUID(), rowNumber, values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : String(value ?? "")])), ...checked, status });
  }
  assert(rows.length <= 5_000, 422, "IMPORT_ROW_LIMIT", "单次导入最多允许 5000 行数据");
  db.transaction(() => {
    requireUncommitted();
    db.prepare(`DELETE FROM import_rows WHERE job_id = ?`).run(job.id);
    const insert = db.prepare(`
      INSERT INTO import_rows (id, job_id, row_number, source_json, normalized_json, status, errors_json, duplicate_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of rows) insert.run(item.id, job.id, item.rowNumber, JSON.stringify(item.values), JSON.stringify(item.normalized), item.status, JSON.stringify(item.errors), item.duplicateCount, timestamp, timestamp);
    db.prepare(`UPDATE import_jobs SET status = 'PREVIEWED', sheet_name = ?, header_row = ?, field_mapping_json = ?, updated_at = ? WHERE id = ?`).run(sheetName, headerRow, JSON.stringify(mapping), timestamp, job.id);
    refreshJobCounts(db, job.id);
    audit(db, { actorId: actor.id, action: "CUSTOMER_IMPORT_PREVIEWED", entityType: "IMPORT_JOB", entityId: job.id, summary: { sheetName, headerRow, mapping, rowCount: rows.length } });
  })();
  return { ...jobView(db, job.id, { actor }), workbook: { sheets: workbookSummary(workbook), headers } };
}

export async function uploadCustomerWorkbook(db, config, actor, file) {
  assert([ROLES.PRESALES, ROLES.MANAGER, ROLES.ADMIN].includes(actor.role), 403, "IMPORT_FORBIDDEN", "当前角色不能导入客户数据");
  validateUploadedFile(file, "SOURCE_XLSX");
  const workbook = await readWorkbook(file.buffer);
  assert(canReadImportSource(db, actor, sha256(file.buffer)), 404, "IMPORT_SOURCE_NOT_FOUND", "来源不存在或当前账号无权读取");
  const selected = chooseWorksheet(workbook);
  const mapping = autoMapping(selected.detected.headers);
  const id = randomUUID();
  const timestamp = nowIso();
  db.prepare(`INSERT INTO import_jobs (id, target_type, status, created_by, created_at, updated_at) VALUES (?, 'CUSTOMER', 'UPLOADED', ?, ?, ?)`)
    .run(id, actor.id, timestamp, timestamp);
  try {
    const stored = storeFile(db, config, actor, { entityType: "IMPORT_JOB", entityId: id, category: "SOURCE_XLSX", originalName: file.originalname, mimeType: file.mimetype, buffer: file.buffer, validateUpload: true });
    db.prepare(`UPDATE import_jobs SET file_id = ?, sheet_name = ?, header_row = ?, field_mapping_json = ?, updated_at = ? WHERE id = ?`)
      .run(stored.id, selected.worksheet.name, selected.detected.row, JSON.stringify(mapping), nowIso(), id);
    const requiredMapped = CUSTOMER_IMPORT_FIELDS.filter(field => field.required).every(field => mapping[field.key]);
    if (!requiredMapped) {
      audit(db, { actorId: actor.id, action: "CUSTOMER_IMPORT_UPLOADED", entityType: "IMPORT_JOB", entityId: id, summary: { sheetName: selected.worksheet.name, headerRow: selected.detected.row, mappingComplete: false } });
      return { ...jobView(db, id, { actor }), workbook: { sheets: workbookSummary(workbook), headers: selected.detected.headers } };
    }
    return await rebuildPreview(db, config, actor, requireJob(db, actor, id), { sheetName: selected.worksheet.name, headerRow: selected.detected.row, fieldMapping: mapping });
  } catch (error) {
    db.prepare(`DELETE FROM import_jobs WHERE id = ? AND file_id IS NULL`).run(id);
    throw error;
  }
}

export async function remapCustomerImport(db, config, actor, jobId, input) {
  return rebuildPreview(db, config, actor, requireJob(db, actor, jobId), input);
}

function requireImportOwner(db, actor, ownerId) {
  const owner = db.prepare(`SELECT id, role, manager_id, is_active FROM users WHERE id = ?`).get(ownerId);
  assert(owner?.is_active && owner.role === ROLES.PRESALES, 400, "OWNER_INVALID", "导入负责人必须是已启用的售前人员");
  if (actor.role === ROLES.PRESALES) assert(owner.id === actor.id, 403, "IMPORT_OWNER_FORBIDDEN", "售前只能导入到本人名下");
  if (actor.role === ROLES.MANAGER) assert(owner.manager_id === actor.id, 403, "IMPORT_OWNER_FORBIDDEN", "部门负责人只能导入到直属售前名下");
  assert(actor.role !== ROLES.VP, 403, "IMPORT_FORBIDDEN", "副总经理不能导入客户数据");
  return owner;
}

export function importCustomerBatch(db, actor, jobId, input) {
  const job = requireJob(db, actor, jobId);
  const owner = requireImportOwner(db, actor, input.ownerId || actor.id);
  const requested = Array.isArray(input.rowNumbers) ? [...new Set(input.rowNumbers.map(Number).filter(Number.isInteger))] : [];
  assert(requested.length > 0 && requested.length <= 50, 400, "IMPORT_BATCH_INVALID", "每批必须选择 1 至 50 行数据");
  const placeholders = requested.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM import_rows WHERE job_id = ? AND row_number IN (${placeholders}) ORDER BY row_number`).all(job.id, ...requested);
  assert(rows.length === requested.length, 400, "IMPORT_ROWS_INVALID", "部分导入行不存在");
  const duplicateActions = input.duplicateActions && typeof input.duplicateActions === "object" ? input.duplicateActions : {};
  const results = [];
  for (const row of rows) {
    if (!["VALID", "DUPLICATE"].includes(row.status)) {
      results.push({ rowNumber: row.row_number, status: row.status, message: "该行不是可导入状态" });
      continue;
    }
    const normalized = parseJson(row.normalized_json, {});
    const source = parseJson(row.source_json, {});
    const existing = db.prepare(`SELECT id FROM customers WHERE LOWER(TRIM(full_name)) = LOWER(TRIM(?)) ORDER BY created_at`).all(normalized.fullName);
    const action = duplicateActions[String(row.row_number)] || duplicateActions[row.row_number] || null;
    try {
      if (existing.length) {
        if (action?.action === "MERGE") {
          const target = existing.find(item => item.id === action.existingCustomerId);
          assert(target && canReadCustomer(db, actor, target.id), 403, "IMPORT_MERGE_FORBIDDEN", "只能合并到当前账号有权访问的同名客户");
          db.transaction(() => {
            insertImportOrigin(db, { actor, job, row, source, normalized, customerId: target.id, disposition: "MERGED" });
            markRowImported(db, row.id, target.id);
          })();
          results.push({ rowNumber: row.row_number, status: "IMPORTED", customerId: target.id, disposition: "MERGED" });
          continue;
        }
        if (action?.action === "FORCE_CREATE") {
          assert(actor.role === ROLES.ADMIN, 403, "IMPORT_FORCE_FORBIDDEN", "仅系统管理员可以强制新建同名客户");
          const reason = text(action.reason, 500);
          const basisType = text(action.basisType, 50);
          const basis = text(action.basis, 1_000);
          assert(reason, 400, "IMPORT_FORCE_REASON_REQUIRED", "强制新建同名客户必须填写原因");
          assert(DISTINGUISHING_BASIS_TYPES.includes(basisType) && basis, 400, "IMPORT_DISTINGUISHING_BASIS_REQUIRED", "必须填写统一社会信用代码、地址、分支机构或其他可审计主体区分依据");
          let customer;
          db.transaction(() => {
            customer = createCustomer(db, actor, { ...normalized, ownerId: owner.id }, { allowUnknownRegisteredOn: true, allowDuplicate: true, allowHistoricalDictionaryValues: true, auditSource: "HISTORICAL_IMPORT_FORCE" });
            const originId = insertImportOrigin(db, { actor, job, row, source, normalized, customerId: customer.id, disposition: "FORCED_CREATED", forceReason: reason, basisType, basis });
            const insertRelation = db.prepare(`
              INSERT INTO customer_duplicate_relations (
                id, customer_id, related_customer_id, relation_type, import_origin_id, reason,
                distinguishing_basis_type, distinguishing_basis, created_by, created_at
              ) VALUES (?, ?, ?, 'SAME_NAME_DISTINCT', ?, ?, ?, ?, ?, ?)
            `);
            for (const item of existing) insertRelation.run(randomUUID(), customer.id, item.id, originId, reason, basisType, basis, actor.id, nowIso());
            markRowImported(db, row.id, customer.id);
          })();
          results.push({ rowNumber: row.row_number, status: "IMPORTED", customerId: customer.id, disposition: "FORCED_CREATED" });
          continue;
        }
        db.prepare(`UPDATE import_rows SET status = 'DUPLICATE', duplicate_count = ?, errors_json = ?, updated_at = ? WHERE id = ?`).run(existing.length, JSON.stringify(["系统内已存在同名客户，须确认合并；仅管理员可凭依据强制新建"]), nowIso(), row.id);
        results.push({ rowNumber: row.row_number, status: "DUPLICATE", message: "系统内已存在同名客户" });
        continue;
      }
      let customer;
      db.transaction(() => {
        customer = createCustomer(db, actor, { ...normalized, ownerId: owner.id }, { allowUnknownRegisteredOn: true, allowHistoricalDictionaryValues: true, auditSource: "HISTORICAL_IMPORT" });
        insertImportOrigin(db, { actor, job, row, source, normalized, customerId: customer.id, disposition: "CREATED" });
        markRowImported(db, row.id, customer.id);
      })();
      results.push({ rowNumber: row.row_number, status: "IMPORTED", customerId: customer.id, disposition: "CREATED" });
    } catch (error) {
      const message = error instanceof AppError ? error.message : "导入失败";
      const keepDuplicate = row.status === "DUPLICATE" || existing.length > 0;
      db.prepare(`UPDATE import_rows SET status = ?, errors_json = ?, updated_at = ? WHERE id = ?`).run(keepDuplicate ? "DUPLICATE" : "FAILED", JSON.stringify([message]), nowIso(), row.id);
      results.push({ rowNumber: row.row_number, status: keepDuplicate ? "DUPLICATE" : "FAILED", message });
    }
  }
  refreshJobCounts(db, job.id);
  const counts = jobView(db, job.id, { includeRows: false }).counts;
  const status = counts.valid === 0 && counts.duplicate === 0 ? "COMPLETED" : "PARTIAL";
  db.prepare(`UPDATE import_jobs SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), job.id);
  audit(db, { actorId: actor.id, action: "CUSTOMER_IMPORT_BATCH", entityType: "IMPORT_JOB", entityId: job.id, summary: { ownerId: owner.id, requestedRows: requested.length, importedRows: results.filter(item => item.status === "IMPORTED").length, dispositions: results.filter(item => item.disposition).map(item => ({ rowNumber: item.rowNumber, disposition: item.disposition })), statusMappings: rows.map(row => ({ rowNumber: row.row_number, mapping: parseJson(row.normalized_json, {}).statusMapping })).filter(item => item.mapping) } });
  return { job: jobView(db, job.id, { actor }), results };
}

function markRowImported(db, rowId, customerId) {
  db.prepare(`UPDATE import_rows SET status = 'IMPORTED', imported_customer_id = ?, errors_json = '[]', updated_at = ? WHERE id = ?`).run(customerId, nowIso(), rowId);
}

function insertImportOrigin(db, { actor, job, row, source, normalized, customerId, disposition, forceReason = null, basisType = null, basis = null }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO customer_import_origins (
      id, customer_id, import_job_id, import_row_id, source_file_id, sheet_name, source_row_number,
      original_registered_on, original_status, mapped_status, disposition, operated_by, imported_at,
      force_reason, distinguishing_basis_type, distinguishing_basis
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, customerId, job.id, row.id, job.file_id, job.sheet_name, row.row_number, String(source.registeredOn ?? ""), String(source.status ?? normalized.originalStatus ?? ""), normalized.status, disposition, actor.id, nowIso(), forceReason, basisType, basis);
  return id;
}

export function getImportJob(db, actor, jobId) {
  requireJob(db, actor, jobId);
  return jobView(db, jobId, { actor });
}

export async function getImportJobWithWorkbook(db, config, actor, jobId) {
  const job = requireJob(db, actor, jobId);
  const file = getFileMetadata(db, job.file_id);
  const absolutePath = path.resolve(config.storagePath, ...file.storageKey.split("/"));
  const workbook = await readWorkbook(fs.readFileSync(absolutePath));
  requireJob(db, actor, jobId);
  const worksheet = workbook.getWorksheet(job.sheet_name);
  const headerRow = job.header_row || 1;
  const headers = [];
  worksheet?.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, column) => headers.push({ column, label: text(cellValue(cell).value, 200) }));
  return { ...jobView(db, jobId, { actor }), workbook: { sheets: workbookSummary(workbook), headers } };
}

export function listImportJobs(db, actor) {
  const where = actor.role === ROLES.ADMIN ? "" : "WHERE created_by = ?";
  const rows = actor.role === ROLES.ADMIN ? db.prepare(`SELECT id FROM import_jobs ${where} ORDER BY created_at DESC LIMIT 50`).all() : db.prepare(`SELECT id FROM import_jobs ${where} ORDER BY created_at DESC LIMIT 50`).all(actor.id);
  return rows.filter(row => canReadImportJob(db, actor, row.id)).map(row => jobView(db, row.id, { includeRows: false, actor }));
}

export function listImportFailures(db, actor, jobId) {
  const job = requireJob(db, actor, jobId);
  return db.prepare(`SELECT row_number, source_json, status, errors_json, duplicate_count FROM import_rows WHERE job_id = ? AND status IN ('FAILED','DUPLICATE') ORDER BY row_number`).all(job.id).map(row => ({ rowNumber: row.row_number, source: parseJson(row.source_json, {}), status: row.status, reasons: parseJson(row.errors_json, []), duplicateCount: row.duplicate_count }));
}
