import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { nowIso } from "./database.js";
import { AppError, assert, CUSTOMER_STATUSES, MANAGER_POSITIONS, ROLES } from "./domain.js";
import { canReadAllCustomersAndQuotes, canReadCustomer, managedUserIds, requireCustomerAccess } from "./permissions.js";
import { recordPendingQuoteHandoffs } from "./quote-handoff-service.js";
import { recordCustomerDictionaryUsage, validateCustomerDictionaryValue } from "./customer-dictionary-service.js";
import { validateMapResource } from "./map-resource.js";

function customerView(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    shortName: row.short_name,
    source: row.source,
    customerType: row.customer_type,
    registeredOn: row.registered_on,
    status: row.status,
    needSummary: row.need_summary,
    industry: row.industry,
    province: row.province,
    city: row.city,
    district: row.district,
    address: row.address,
    longitude: row.longitude,
    latitude: row.latitude,
    summary: row.summary,
    notes: row.notes,
    owner: { id: row.owner_id, displayName: row.owner_name },
    mapPoint: row.map_x_percent === null || row.map_y_percent === null || !row.map_asset_sha256 ? null : {
      xPercent: row.map_x_percent,
      yPercent: row.map_y_percent,
      assetSha256: row.map_asset_sha256
    },
    lastFollowupAt: row.last_followup_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function optionalText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function coordinate(value, minimum, maximum, label) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  assert(Number.isFinite(number) && number >= minimum && number <= maximum, 400, "CUSTOMER_COORDINATE_INVALID", `${label}必须在 ${minimum} 至 ${maximum} 之间`);
  return number;
}

const CUSTOMER_SELECT = `
  SELECT c.*, u.display_name AS owner_name, u.manager_id AS owner_manager_id,
    (SELECT MAX(f.occurred_at) FROM followups f WHERE f.customer_id = c.id) AS last_followup_at
  FROM customers c JOIN users u ON u.id = c.owner_id
`;

function requireAssignableOwner(db, actor, ownerId) {
  const owner = db.prepare(`SELECT id, role, manager_id, is_active FROM users WHERE id = ?`).get(ownerId);
  assert(owner?.is_active && owner.role === ROLES.PRESALES, 400, "OWNER_INVALID", "负责人必须是已启用的售前人员");
  if (actor.role === ROLES.PRESALES) assert(owner.id === actor.id, 403, "OWNER_FORBIDDEN", "售前人员只能将客户登记到本人名下");
  if (actor.role === ROLES.MANAGER) assert(owner.manager_id === actor.id, 403, "OWNER_FORBIDDEN", "只能选择本人管理范围内的售前人员");
  assert(actor.role !== ROLES.VP, 403, "CUSTOMER_CREATE_FORBIDDEN", "副总经理不直接创建或分配客户");
  return owner;
}

function normalizeCustomerFilters(filters = {}) {
  const result = {
    search: String(filters.search || "").trim(),
    ownerId: String(filters.ownerId || "").trim(),
    status: String(filters.status || "").trim(),
    source: String(filters.source || "").trim(),
    customerType: String(filters.customerType || "").trim(),
    industry: String(filters.industry || "").trim(),
    region: String(filters.region || "").trim(),
    registeredFrom: String(filters.registeredFrom || "").trim(),
    registeredTo: String(filters.registeredTo || "").trim()
  };
  if (result.status) assert(CUSTOMER_STATUSES.includes(result.status), 400, "CUSTOMER_FILTER_STATUS_INVALID", "客户状态筛选值无效");
  if (result.registeredFrom) assert(validDate(result.registeredFrom), 400, "CUSTOMER_FILTER_DATE_INVALID", "登记开始日期无效");
  if (result.registeredTo) assert(validDate(result.registeredTo), 400, "CUSTOMER_FILTER_DATE_INVALID", "登记结束日期无效");
  assert(!result.registeredFrom || !result.registeredTo || result.registeredFrom <= result.registeredTo, 400, "CUSTOMER_FILTER_DATE_RANGE_INVALID", "登记开始日期不能晚于结束日期");
  return result;
}

function customerQuery(db, actor, filters = {}, { companyDirectory = false, includeVpApprovalScope = false, limit = 200 } = {}) {
  const normalized = normalizeCustomerFilters(filters);
  const companyRead = companyDirectory && canReadAllCustomersAndQuotes(actor);
  const vpApprovalScope = actor.role === ROLES.VP && !companyRead;
  if (vpApprovalScope && !includeVpApprovalScope) return [];
  const ownerIds = companyRead || vpApprovalScope || actor.role === ROLES.ADMIN ? null : managedUserIds(db, actor);
  if (ownerIds && ownerIds.length === 0) return [];
  const clauses = [];
  const params = [];
  if (vpApprovalScope) {
    clauses.push(`EXISTS (
      SELECT 1 FROM quotes q JOIN quote_versions qv ON qv.quote_id = q.id
      WHERE q.customer_id = c.id AND (qv.status = 'APPROVED' OR (qv.status = 'PENDING_VP' AND COALESCE(qv.approval_stage, 'VP') = 'VP'))
    )`);
  }
  if (ownerIds) {
    clauses.push(`c.owner_id IN (${ownerIds.map(() => "?").join(",")})`);
    params.push(...ownerIds);
  }
  if (normalized.search) {
    clauses.push(`(c.full_name LIKE ? OR c.short_name LIKE ? OR c.industry LIKE ? OR c.province LIKE ? OR c.city LIKE ?)`);
    const value = `%${normalized.search}%`;
    params.push(value, value, value, value, value);
  }
  if (normalized.ownerId) { clauses.push("c.owner_id = ?"); params.push(normalized.ownerId); }
  if (normalized.status) { clauses.push("c.status = ?"); params.push(normalized.status); }
  if (normalized.source) { clauses.push("c.source = ?"); params.push(normalized.source); }
  if (normalized.customerType) { clauses.push("c.customer_type = ?"); params.push(normalized.customerType); }
  if (normalized.industry) { clauses.push("c.industry LIKE ?"); params.push(`%${normalized.industry}%`); }
  if (normalized.region) {
    clauses.push("(c.province LIKE ? OR c.city LIKE ? OR c.district LIKE ?)");
    const value = `%${normalized.region}%`;
    params.push(value, value, value);
  }
  if (normalized.registeredFrom) { clauses.push("c.registered_on >= ?"); params.push(normalized.registeredFrom); }
  if (normalized.registeredTo) { clauses.push("c.registered_on <= ?"); params.push(normalized.registeredTo); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 5000));
  const rows = db.prepare(`${CUSTOMER_SELECT} ${where} ORDER BY c.updated_at DESC LIMIT ${safeLimit}`).all(...params);
  if (!companyDirectory) return rows.map(customerView);
  return rows.map(row => ({
    ...customerView(row),
    canSupplementRegisteredOn: !row.registered_on && (
      actor.role === ROLES.ADMIN || actor.id === row.owner_id ||
      (actor.role === ROLES.MANAGER && actor.positionCode === MANAGER_POSITIONS.GENERAL_MANAGER && row.owner_manager_id === actor.id)
    )
  }));
}

export function listCustomers(db, actor, filters = {}, options = {}) {
  return customerQuery(db, actor, filters, options);
}

export function listMapCustomers(db, actor, filters = {}, options = {}) {
  return customerQuery(db, actor, filters, { ...options, includeVpApprovalScope: true });
}

export function getCustomer(db, actor, customerId, { companyDirectory = false } = {}) {
  const scoped = canReadCustomer(db, actor, customerId);
  if (!scoped && !(companyDirectory && canReadAllCustomersAndQuotes(actor))) {
    throw new AppError(404, "CUSTOMER_NOT_FOUND", "客户不存在或当前账号无权访问");
  }
  const row = db.prepare(`${CUSTOMER_SELECT} WHERE c.id = ?`).get(customerId);
  if (!row) throw new AppError(404, "CUSTOMER_NOT_FOUND", "客户不存在或当前账号无权访问");
  const customer = customerView(row);
  if (!scoped) return customer;
  customer.importOrigins = db.prepare(`
    SELECT o.*, f.original_name, u.display_name AS operated_by_name
    FROM customer_import_origins o
    JOIN stored_files f ON f.id = o.source_file_id
    JOIN users u ON u.id = o.operated_by
    WHERE o.customer_id = ? ORDER BY o.imported_at DESC
  `).all(customerId).map(item => ({
    id: item.id,
    batchId: item.import_job_id,
    sourceFileName: item.original_name,
    sheetName: item.sheet_name,
    sourceRowNumber: item.source_row_number,
    originalRegisteredOn: item.original_registered_on,
    originalStatus: item.original_status,
    mappedStatus: item.mapped_status,
    disposition: item.disposition,
    operatedBy: { id: item.operated_by, displayName: item.operated_by_name },
    importedAt: item.imported_at,
    forceReason: item.force_reason,
    distinguishingBasisType: item.distinguishing_basis_type,
    distinguishingBasis: item.distinguishing_basis
  }));
  customer.visitImportOrigins = db.prepare(`
    SELECT o.*, u.display_name AS operated_by_name
    FROM visit_import_origins o JOIN users u ON u.id = o.operated_by
    WHERE o.customer_id = ? ORDER BY o.imported_at DESC
  `).all(customerId).map(item => ({
    sourceKey: item.source_key,
    batchId: item.import_job_id,
    sourceSha256: item.source_sha256,
    sheetName: item.sheet_name,
    sourceRowNumber: item.source_row_number,
    source: JSON.parse(item.source_json),
    normalized: JSON.parse(item.normalized_json),
    disposition: item.disposition,
    operatedBy: { id: item.operated_by, displayName: item.operated_by_name },
    importedAt: item.imported_at
  }));
  customer.weeklyReportOrigins = db.prepare(`
    SELECT o.*, u.display_name AS first_confirmed_by_name
    FROM weekly_report_origins o
    JOIN users u ON u.id = o.first_confirmed_by
    WHERE EXISTS (
      SELECT 1 FROM weekly_report_decisions d WHERE d.source_key = o.source_key AND d.customer_id = ?
    )
    ORDER BY o.first_confirmed_at DESC
  `).all(customerId).map(item => ({
    sourceKey: item.source_key,
    batchId: item.first_import_job_id,
    sourceSha256: item.source_sha256,
    sheetName: item.sheet_name,
    sourceRowNumber: item.source_row_number,
    sourceCells: JSON.parse(item.cells_json),
    candidates: JSON.parse(item.candidates_json),
    firstConfirmedBy: { id: item.first_confirmed_by, displayName: item.first_confirmed_by_name },
    firstConfirmedAt: item.first_confirmed_at,
    decisions: db.prepare(`SELECT * FROM weekly_report_decisions WHERE source_key = ? AND customer_id = ? ORDER BY operated_at, id`).all(item.source_key, customerId).map(decision => ({
      id: decision.id,
      businessType: decision.business_type,
      dateHandling: decision.date_handling,
      dateCellReference: decision.date_cell_reference,
      contentHandling: decision.content_handling,
      contentCellReferences: JSON.parse(decision.content_cell_references_json),
      operatedBy: decision.operated_by,
      operatedAt: decision.operated_at,
      createdBusinessRecords: [],
      amountTransferred: false
    }))
  }));
  customer.duplicateRelations = db.prepare(`
    SELECT r.*, c.full_name AS related_customer_name
    FROM customer_duplicate_relations r
    JOIN customers c ON c.id = r.related_customer_id
    WHERE r.customer_id = ? ORDER BY r.created_at DESC
  `).all(customerId).filter(item => canReadCustomer(db, actor, item.related_customer_id)).map(item => ({
    id: item.id,
    relatedCustomer: { id: item.related_customer_id, name: item.related_customer_name },
    type: item.relation_type,
    reason: item.reason,
    distinguishingBasisType: item.distinguishing_basis_type,
    distinguishingBasis: item.distinguishing_basis,
    createdAt: item.created_at
  }));
  return customer;
}

export function createCustomer(db, actor, input, { allowUnknownRegisteredOn = false, allowDuplicate = false, allowHistoricalDictionaryValues = false, auditSource = "MANUAL", requireCompleteManual = false } = {}) {
  assert(input?.fullName?.trim(), 400, "CUSTOMER_NAME_REQUIRED", "客户名称不能为空");
  assert(input?.needSummary?.trim(), 400, "CUSTOMER_NEED_REQUIRED", "客户需求不能为空");
  const ownerId = input.ownerId || (actor.role === ROLES.PRESALES ? actor.id : null);
  if (requireCompleteManual) {
    const fields = [["ownerId", "当前负责人"], ["source", "客户来源"], ["customerType", "客户类型"], ["industry", "行业"], ["province", "省份"], ["city", "城市"]];
    const missing = fields.filter(([key]) => !String(key === "ownerId" ? ownerId ?? "" : input?.[key] ?? "").trim()).map(([, label]) => label);
    assert(!missing.length, 400, "CUSTOMER_REQUIRED_FIELDS_MISSING", `请填写：${missing.join("、")}`);
  }
  assert(CUSTOMER_STATUSES.includes(input.status), 400, "CUSTOMER_STATUS_INVALID", "客户状态无效");
  const registeredOn = input.registeredOn || null;
  if (registeredOn === null) assert(allowUnknownRegisteredOn, 400, "CUSTOMER_REGISTERED_ON_REQUIRED", "登记时间不能为空");
  else assert(validDate(registeredOn), 400, "CUSTOMER_REGISTERED_ON_INVALID", "登记时间必须是有效日期");
  const duplicate = db.prepare(`SELECT id FROM customers WHERE LOWER(TRIM(full_name)) = LOWER(TRIM(?)) LIMIT 1`).get(input.fullName);
  assert(!duplicate || allowDuplicate, 409, "CUSTOMER_NAME_DUPLICATE", "系统内已存在同名客户，请确认主体后处理历史明细");
  requireAssignableOwner(db, actor, ownerId || actor.id);
  if (!allowHistoricalDictionaryValues) {
    validateCustomerDictionaryValue(db, "SOURCE", input.source || null);
    validateCustomerDictionaryValue(db, "TYPE", input.customerType || null);
  }
  const id = randomUUID();
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO customers (
      id, full_name, short_name, source, customer_type, registered_on, status, need_summary,
      industry, province, city, district, address, longitude, latitude, summary, notes,
      owner_id, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.fullName.trim(), input.shortName?.trim() || null, input.source || null, input.customerType || null,
    registeredOn, input.status, input.needSummary.trim(), input.industry || null,
    input.province || null, input.city || null, input.district || null, input.address || null,
    input.longitude ?? null, input.latitude ?? null, input.summary || null, input.notes || null,
    ownerId || actor.id, actor.id, timestamp, timestamp
  );
  audit(db, { actorId: actor.id, action: "CUSTOMER_CREATED", entityType: "CUSTOMER", entityId: id, summary: { ownerId: ownerId || actor.id, source: auditSource, registeredOnKnown: registeredOn !== null } });
  recordCustomerDictionaryUsage(db, input.source, input.customerType);
  return getCustomer(db, actor, id);
}

export function updateCustomer(db, actor, customerId, input) {
  requireCustomerAccess(db, actor, customerId);
  const current = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId);
  assert(actor.role === ROLES.ADMIN || (actor.role === ROLES.PRESALES && current.owner_id === actor.id), 403, "CUSTOMER_UPDATE_FORBIDDEN", "仅客户当前负责人或管理员可以修改客户主档");
  const value = { ...customerView({ ...current, owner_name: "" }), ...(input || {}) };
  assert(value.fullName?.trim(), 400, "CUSTOMER_NAME_REQUIRED", "客户名称不能为空");
  assert(value.needSummary?.trim(), 400, "CUSTOMER_NEED_REQUIRED", "客户需求不能为空");
  assert(CUSTOMER_STATUSES.includes(value.status), 400, "CUSTOMER_STATUS_INVALID", "客户状态无效");
  const registeredOn = value.registeredOn || null;
  if (registeredOn === null) assert(current.registered_on === null, 400, "CUSTOMER_REGISTERED_ON_REQUIRED", "已有登记时间不能清空");
  else assert(validDate(registeredOn), 400, "CUSTOMER_REGISTERED_ON_INVALID", "登记时间必须是有效日期");
  if (value.fullName.trim() !== current.full_name) {
    const duplicate = db.prepare(`SELECT id FROM customers WHERE id <> ? AND LOWER(TRIM(full_name)) = LOWER(TRIM(?)) LIMIT 1`).get(customerId, value.fullName);
    assert(!duplicate, 409, "CUSTOMER_NAME_DUPLICATE", "系统内已存在同名客户，请确认主体后处理历史明细");
  }

  const next = {
    full_name: value.fullName.trim(),
    short_name: optionalText(value.shortName),
    source: value.source || null,
    customer_type: value.customerType || null,
    registered_on: registeredOn,
    status: value.status,
    need_summary: value.needSummary.trim(),
    industry: optionalText(value.industry),
    province: optionalText(value.province),
    city: optionalText(value.city),
    district: optionalText(value.district),
    address: optionalText(value.address),
    longitude: coordinate(value.longitude, -180, 180, "经度"),
    latitude: coordinate(value.latitude, -90, 90, "纬度"),
    summary: optionalText(value.summary),
    notes: optionalText(value.notes)
  };
  validateCustomerDictionaryValue(db, "SOURCE", next.source, current.source);
  validateCustomerDictionaryValue(db, "TYPE", next.customer_type, current.customer_type);
  const changedFields = Object.keys(next).filter(field => !Object.is(current[field], next[field]));
  if (!changedFields.length) return getCustomer(db, actor, customerId);

  const before = Object.fromEntries(changedFields.map(field => [field, current[field]]));
  const after = Object.fromEntries(changedFields.map(field => [field, next[field]]));
  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare(`
      UPDATE customers SET full_name = ?, short_name = ?, source = ?, customer_type = ?, registered_on = ?, status = ?, need_summary = ?,
        industry = ?, province = ?, city = ?, district = ?, address = ?, longitude = ?, latitude = ?, summary = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.full_name, next.short_name, next.source, next.customer_type, next.registered_on, next.status, next.need_summary,
      next.industry, next.province, next.city, next.district, next.address, next.longitude, next.latitude,
      next.summary, next.notes, timestamp, customerId
    );
    audit(db, {
      actorId: actor.id,
      action: "CUSTOMER_UPDATED",
      entityType: "CUSTOMER",
      entityId: customerId,
      summary: { changedFields, before, after }
    });
    recordCustomerDictionaryUsage(db, next.source, next.customer_type);
    if (current.status !== next.status) {
      audit(db, {
        actorId: actor.id,
        action: "CUSTOMER_STATUS_CHANGED",
        entityType: "CUSTOMER",
        entityId: customerId,
        summary: { before: current.status, after: next.status }
      });
    }
    if (current.registered_on !== next.registered_on) {
      audit(db, { actorId: actor.id, action: current.registered_on ? "CUSTOMER_REGISTERED_ON_CHANGED" : "CUSTOMER_REGISTERED_ON_SUPPLEMENTED", entityType: "CUSTOMER", entityId: customerId, summary: { before: current.registered_on, after: next.registered_on } });
    }
  })();
  return getCustomer(db, actor, customerId);
}

export function updateCustomerMapPoint(db, storagePath, actor, customerId, input) {
  requireCustomerAccess(db, actor, customerId);
  const current = db.prepare(`SELECT owner_id, map_x_percent, map_y_percent, map_asset_sha256 FROM customers WHERE id = ?`).get(customerId);
  assert(actor.role === ROLES.ADMIN || (actor.role === ROLES.PRESALES && current.owner_id === actor.id), 403, "CUSTOMER_MAP_POINT_FORBIDDEN", "仅客户当前负责人或管理员可以人工修改客户点位");
  const resource = validateMapResource(storagePath);
  assert(resource.status === "READY", 409, "MAP_RESOURCE_UNAVAILABLE", "中国标准地图原图缺失或未通过校验，禁止保存业务点位");
  const expectedAssetSha256 = String(input?.expectedAssetSha256 || "").trim().toLowerCase();
  assert(expectedAssetSha256 === resource.sha256, 409, "MAP_RESOURCE_CHANGED", "地图原图已变化，请刷新地图后重新选择点位");
  const reason = String(input?.reason || "").trim();
  assert(reason, 400, "CUSTOMER_MAP_POINT_REASON_REQUIRED", "人工选点或修改点位必须填写原因");
  const xPercent = coordinate(input?.xPercent, 0, 100, "地图横向百分比");
  const yPercent = coordinate(input?.yPercent, 0, 100, "地图纵向百分比");
  assert(xPercent !== null && yPercent !== null, 400, "CUSTOMER_MAP_POINT_REQUIRED", "人工选点必须同时提供图片横纵百分比坐标");
  if (Object.is(current.map_x_percent, xPercent) && Object.is(current.map_y_percent, yPercent) && current.map_asset_sha256 === resource.sha256) return getCustomer(db, actor, customerId);
  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE customers SET map_x_percent = ?, map_y_percent = ?, map_asset_sha256 = ?, updated_at = ? WHERE id = ?`).run(xPercent, yPercent, resource.sha256, timestamp, customerId);
    audit(db, {
      actorId: actor.id,
      action: "CUSTOMER_MAP_POINT_UPDATED",
      entityType: "CUSTOMER",
      entityId: customerId,
      summary: {
        before: { xPercent: current.map_x_percent, yPercent: current.map_y_percent, assetSha256: current.map_asset_sha256 },
        after: { xPercent, yPercent, assetSha256: resource.sha256 },
        reason
      }
    });
  })();
  return getCustomer(db, actor, customerId);
}

export const __test = { normalizeCustomerFilters };

export function supplementCustomerRegisteredOn(db, actor, customerId, { registeredOn }) {
  assert([ROLES.PRESALES, ROLES.MANAGER, ROLES.ADMIN].includes(actor.role), 403, "CUSTOMER_UPDATE_FORBIDDEN", "当前角色不能补录客户登记时间");
  assert(validDate(registeredOn), 400, "CUSTOMER_REGISTERED_ON_INVALID", "登记时间必须是有效日期");
  requireCustomerAccess(db, actor, customerId);
  const customer = db.prepare(`SELECT registered_on FROM customers WHERE id = ?`).get(customerId);
  if (!customer) throw new AppError(404, "CUSTOMER_NOT_FOUND", "客户不存在或当前账号无权访问");
  const timestamp = nowIso();
  db.prepare(`UPDATE customers SET registered_on = ?, updated_at = ? WHERE id = ?`).run(registeredOn, timestamp, customerId);
  audit(db, {
    actorId: actor.id,
    action: customer.registered_on ? "CUSTOMER_REGISTERED_ON_CHANGED" : "CUSTOMER_REGISTERED_ON_SUPPLEMENTED",
    entityType: "CUSTOMER",
    entityId: customerId,
    summary: { before: customer.registered_on, after: registeredOn }
  });
  return getCustomer(db, actor, customerId);
}

export function transferCustomer(db, actor, customerId, { newOwnerId, reason }) {
  assert(actor.role === ROLES.MANAGER || actor.role === ROLES.ADMIN, 403, "TRANSFER_FORBIDDEN", "仅部门负责人或管理员可以转让客户");
  assert(reason?.trim(), 400, "TRANSFER_REASON_REQUIRED", "客户转让必须填写原因");
  requireCustomerAccess(db, actor, customerId);
  const customer = db.prepare(`SELECT owner_id FROM customers WHERE id = ?`).get(customerId);
  assert(customer.owner_id !== newOwnerId, 400, "OWNER_UNCHANGED", "新负责人不能与原负责人相同");
  requireAssignableOwner(db, actor, newOwnerId);
  const previousManagerId = db.prepare(`SELECT manager_id FROM users WHERE id = ?`).get(customer.owner_id).manager_id;
  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE customers SET owner_id = ?, updated_at = ? WHERE id = ?`).run(newOwnerId, timestamp, customerId);
    recordPendingQuoteHandoffs(db, actor, [customerId], previousManagerId, { reason: reason.trim(), changeType: "CUSTOMER_TRANSFER" });
    db.prepare(`
      INSERT INTO customer_transfers (id, customer_id, previous_owner_id, new_owner_id, operated_by, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), customerId, customer.owner_id, newOwnerId, actor.id, reason.trim(), timestamp);
    audit(db, {
      actorId: actor.id,
      action: "CUSTOMER_TRANSFERRED",
      entityType: "CUSTOMER",
      entityId: customerId,
      summary: { previousOwnerId: customer.owner_id, newOwnerId, reason: reason.trim() }
    });
  })();
  return getCustomer(db, actor, customerId);
}
