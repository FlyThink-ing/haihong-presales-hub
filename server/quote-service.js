import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { nowIso } from "./database.js";
import { AppError, assert, MANAGER_POSITIONS, QUOTE_APPROVAL_STAGES, QUOTE_STATUSES, ROLES } from "./domain.js";
import { canApproveCustomerQuote, canReadAllCustomersAndQuotes, canReadCustomer } from "./permissions.js";
import { sha256 } from "./security.js";
import { findCurrentQuoteManager, listQuoteHandoffs, requireCurrentQuoteManager } from "./quote-handoff-service.js";
import { cloneCurrentAttachments, freezeAttachments, listAttachmentSnapshot, listAttachments } from "./attachment-service.js";
import { listQuoteVersionFiles } from "./file-service.js";
import { quoteDetailRoundingAdjustment, quoteDetailRoundingAllocations, quoteDetailTotalsMismatch, quoteDetailTotalsMismatchMessage } from "../web/quote-math.js";
import { requireQuoteReviewForSubmit } from "./quote-review-repository.js";

export const QUOTE_COMPANY = Object.freeze({
  name: "河南海弘软件技术有限公司",
  address: "河南省鹤壁经济技术开发区渤海路 396 号",
  postalCode: "458030",
  phone: "0392-3357155",
  bankName: "",
  bankAccount: ""
});

function cleanText(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeQuoteMetadata(input, defaults = {}) {
  const merged = { ...defaults, ...(input || {}) };
  const quoteDate = cleanText(merged.quoteDate, 10) || nowIso().slice(0, 10);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(quoteDate), 400, "QUOTE_DATE_INVALID", "报价日期格式无效");
  return {
    quoteDate,
    customerName: cleanText(merged.customerName, 300),
    validity: cleanText(merged.validity, 50) || "30 天",
    customerAddress: cleanText(merged.customerAddress, 500),
    customerContactName: cleanText(merged.customerContactName, 100),
    customerPhone: cleanText(merged.customerPhone, 100),
    customerContactSource: cleanText(merged.customerContactSource, 30),
    deliveryTerms: cleanText(merged.deliveryTerms, 500) || "按双方合同约定",
    paymentTerms: cleanText(merged.paymentTerms, 500) || "按双方合同约定",
    bankName: cleanText(merged.bankName, 200) || QUOTE_COMPANY.bankName,
    bankAccount: cleanText(merged.bankAccount, 100) || QUOTE_COMPANY.bankAccount,
    sellerName: cleanText(merged.sellerName, 100),
    sellerPhone: cleanText(merged.sellerPhone, 100),
    sellerEmail: cleanText(merged.sellerEmail, 200),
    company: QUOTE_COMPANY
  };
}

function requireInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  assert(Number.isSafeInteger(value) && value >= min && value <= max, 400, "QUOTE_NUMBER_INVALID", `${name}必须是有效整数`);
  return value;
}

function requireMatchingQuoteTotals(summaryItems, detailItems) {
  const mismatch = quoteDetailTotalsMismatch(summaryItems, detailItems);
  assert(!mismatch, 422, "QUOTE_DETAIL_TOTAL_MISMATCH", mismatch ? quoteDetailTotalsMismatchMessage(mismatch) : "");
}

export function calculateQuoteItems(items) {
  assert(Array.isArray(items) && items.length > 0, 400, "QUOTE_ITEMS_REQUIRED", "报价至少需要一条明细");
  let subtotalUntaxedCents = 0;
  let subtotalTaxedCents = 0;
  const calculated = items.map((item, index) => {
    const quantityMilli = requireInteger(item.quantityMilli, `第 ${index + 1} 行数量`, { min: 1 });
    const taxRate = requireInteger(item.taxRateBps, `第 ${index + 1} 行税率`, { max: 10_000 });
    assert(item.category?.trim() && item.itemName?.trim() && item.unit?.trim(), 400, "QUOTE_ITEM_FIELD_REQUIRED", `第 ${index + 1} 行分类、项目和单位不能为空`);
    const pricingMode = item.pricingMode === "TAXED_TOTAL" ? "TAXED_TOTAL" : "UNTAXED_UNIT";
    let unitPrice;
    let untaxedAmountCents;
    let taxedAmountCents;
    if (pricingMode === "TAXED_TOTAL") {
      taxedAmountCents = requireInteger(item.taxedAmountCents, `第 ${index + 1} 行含税金额`, { min: 1 });
      untaxedAmountCents = Math.round((taxedAmountCents * 10_000) / (10_000 + taxRate));
      unitPrice = Math.round((untaxedAmountCents * 1000) / quantityMilli);
      assert([untaxedAmountCents, unitPrice].every(Number.isSafeInteger), 400, "QUOTE_AMOUNT_OVERFLOW", `第 ${index + 1} 行金额超出安全范围`);
    } else {
      unitPrice = requireInteger(item.untaxedUnitPriceCents, `第 ${index + 1} 行未税单价`);
      assert(Number.isSafeInteger(quantityMilli * unitPrice), 400, "QUOTE_AMOUNT_OVERFLOW", `第 ${index + 1} 行金额超出安全范围`);
      untaxedAmountCents = Math.round((quantityMilli * unitPrice) / 1000);
      taxedAmountCents = Math.round((untaxedAmountCents * (10_000 + taxRate)) / 10_000);
    }
    if (item.untaxedAmountCents !== undefined) {
      assert(item.untaxedAmountCents === untaxedAmountCents, 422, "QUOTE_AMOUNT_MISMATCH", `第 ${index + 1} 行未税金额与服务端计算不一致`);
    }
    if (item.taxedAmountCents !== undefined) {
      assert(item.taxedAmountCents === taxedAmountCents, 422, "QUOTE_AMOUNT_MISMATCH", `第 ${index + 1} 行含税金额与服务端计算不一致`);
    }
    subtotalUntaxedCents += untaxedAmountCents;
    subtotalTaxedCents += taxedAmountCents;
    assert(Number.isSafeInteger(subtotalUntaxedCents) && Number.isSafeInteger(subtotalTaxedCents), 400, "QUOTE_AMOUNT_OVERFLOW", "报价合计超出安全范围");
    return {
      lineNo: index + 1,
      pricingMode,
      category: item.category.trim(),
      itemName: item.itemName.trim(),
      subitemName: item.subitemName?.trim() || null,
      unit: item.unit.trim(),
      quantityMilli,
      untaxedUnitPriceCents: unitPrice,
      taxRateBps: taxRate,
      untaxedAmountCents,
      taxedAmountCents,
      notes: item.notes?.trim() || null
    };
  });
  return { items: calculated, subtotalUntaxedCents, subtotalTaxedCents };
}

function readVersionBundle(db, versionId) {
  const version = db.prepare(`
    SELECT qv.*, q.quote_number, q.customer_id, q.project_id, q.created_by AS quote_created_by,
      c.owner_id, c.full_name AS customer_name, p.name AS project_name
    FROM quote_versions qv
    JOIN quotes q ON q.id = qv.quote_id
    JOIN customers c ON c.id = q.customer_id
    JOIN projects p ON p.id = q.project_id
    WHERE qv.id = ?
  `).get(versionId);
  if (!version) throw new AppError(404, "QUOTE_VERSION_NOT_FOUND", "报价版本不存在或当前账号无权访问");
  const storedItems = db.prepare(`SELECT * FROM quote_items WHERE quote_version_id = ? ORDER BY section, line_no`).all(versionId).map(row => ({
    lineNo: row.line_no,
    section: row.section || "SUMMARY",
    pricingMode: row.pricing_mode || "UNTAXED_UNIT",
    category: row.category,
    itemName: row.item_name,
    subitemName: row.subitem_name,
    unit: row.unit,
    quantityMilli: row.quantity_milli,
    untaxedUnitPriceCents: row.untaxed_unit_price_cents,
    taxRateBps: row.tax_rate_bps,
    untaxedAmountCents: row.untaxed_amount_cents,
    taxedAmountCents: row.taxed_amount_cents,
    notes: row.notes
  }));
  return {
    version,
    items: storedItems.filter(item => item.section === "SUMMARY").map(({ section: _section, ...item }, index) => ({ ...item, lineNo: index + 1 })),
    detailItems: storedItems.filter(item => item.section === "DETAIL").map(({ section: _section, ...item }, index) => ({ ...item, lineNo: index + 1 }))
  };
}

function canViewVersion(actor, ownerId) {
  return canReadAllCustomersAndQuotes(actor) || (actor.role === ROLES.PRESALES && ownerId === actor.id);
}

function versionView(db, versionId, actor = null) {
  const { version, items, detailItems } = readVersionBundle(db, versionId);
  const sourceKind = JSON.parse(version.metadata_json || "{}").sourceKind === "UPLOADED" ? "UPLOADED" : "SYSTEM";
  // 负责人失效不阻断有权用户读取历史；提交、交接和审批仍使用强校验。
  const pendingManager = version.status === QUOTE_STATUSES.PENDING_MANAGER ? findCurrentQuoteManager(db, version.customer_id) : null;
  const approvals = db.prepare(`
    SELECT qa.stage, qa.decision, qa.comment, qa.created_at, u.id AS approver_id, u.display_name AS approver_name
    FROM quote_approvals qa JOIN users u ON u.id = qa.approver_id
    WHERE qa.quote_version_id = ? ORDER BY qa.created_at, qa.rowid
  `).all(versionId).map(row => ({
    stage: row.stage,
    decision: row.decision,
    comment: row.comment,
    createdAt: row.created_at,
    approver: { id: row.approver_id, displayName: row.approver_name }
  }));
  const submittedContent = version.snapshot_json ? JSON.parse(version.snapshot_json) : null;
  const approvalWorkflow = Array.isArray(submittedContent?.approvalWorkflow)
    ? submittedContent.approvalWorkflow
    : version.snapshot_json
      ? [QUOTE_APPROVAL_STAGES.MANAGER, QUOTE_APPROVAL_STAGES.VP]
      : [QUOTE_APPROVAL_STAGES.MANAGER, QUOTE_APPROVAL_STAGES.GENERAL_MANAGER, QUOTE_APPROVAL_STAGES.VP];
  const versionHistory = db.prepare(`
    SELECT id, revision, status, approval_stage, created_at, submitted_at
    FROM quote_versions
    WHERE quote_id = ? AND revision < ?
    ORDER BY revision
  `).all(version.quote_id, version.revision).map(item => ({
    id: item.id,
    revision: item.revision,
    versionLabel: `V${item.revision}.0`,
    status: item.status,
    createdAt: item.created_at,
    submittedAt: item.submitted_at,
    ...(actor ? { canView: canViewVersion(actor, version.owner_id) } : {}),
    approvals: db.prepare(`
      SELECT qa.stage, qa.decision, qa.comment, qa.created_at, u.id AS approver_id, u.display_name AS approver_name
      FROM quote_approvals qa JOIN users u ON u.id = qa.approver_id
      WHERE qa.quote_version_id = ? ORDER BY qa.created_at, qa.rowid
    `).all(item.id).map(row => ({
      stage: row.stage,
      decision: row.decision,
      comment: row.comment,
      createdAt: row.created_at,
      approver: { id: row.approver_id, displayName: row.approver_name }
    }))
  }));
  const result = {
    id: version.id,
    quoteId: version.quote_id,
    quoteNumber: version.quote_number,
    customer: { id: version.customer_id, name: version.customer_name },
    project: { id: version.project_id, name: version.project_name },
    revision: version.revision,
    draftEtag: version.draft_etag,
    draftSavedAt: version.draft_saved_at,
    versionLabel: `V${version.revision}.0`,
    status: version.status,
    roundingPolicy: version.snapshot_json ? (submittedContent?.roundingPolicy || "LEGACY") : "ALLOCATE_V2",
    approvalWorkflow,
    currentApprovalStage: version.approval_stage || (version.status === QUOTE_STATUSES.PENDING_MANAGER ? QUOTE_APPROVAL_STAGES.MANAGER : version.status === QUOTE_STATUSES.PENDING_VP ? QUOTE_APPROVAL_STAGES.VP : null),
    notes: version.notes,
    metadata: normalizeQuoteMetadata(JSON.parse(version.metadata_json || "{}")),
    sourceKind,
    // 上传文件仅人工登记含税总额，不能推断税率或未税金额。
    subtotalUntaxedCents: sourceKind === "UPLOADED" ? null : version.subtotal_untaxed_cents,
    subtotalTaxedCents: version.subtotal_taxed_cents,
    finalDiscountCents: version.final_discount_cents,
    discountAmountCents: version.subtotal_taxed_cents - version.final_discount_cents,
    items,
    detailItems,
    detailRoundingAdjustmentCents: version.snapshot_json ? (submittedContent?.detailRoundingAdjustmentCents || 0) : quoteDetailRoundingAdjustment(items, detailItems),
    detailRoundingAllocationsCents: version.snapshot_json ? (submittedContent?.detailRoundingAllocationsCents || []) : quoteDetailRoundingAllocations(items, detailItems),
    detailSubtotalUntaxedCents: detailItems.reduce((sum, item) => sum + item.untaxedAmountCents, 0)
      + (version.snapshot_json ? (submittedContent?.detailRoundingAdjustmentCents || 0) : quoteDetailRoundingAdjustment(items, detailItems)),
    detailSubtotalTaxedCents: detailItems.reduce((sum, item) => sum + item.taxedAmountCents, 0),
    approvals,
    versionHistory,
    pendingManager,
    pendingManagerIssue: version.status === QUOTE_STATUSES.PENDING_MANAGER && !pendingManager
      ? { code: "QUOTE_MANAGER_REQUIRED", message: "当前研发经理配置无效或不唯一，待调整后才能处理一级审批。" }
      : null,
    handoffs: listQuoteHandoffs(db, versionId),
    submittedAt: version.submitted_at,
    lockedAt: version.locked_at,
    snapshotHash: version.snapshot_hash,
    createdBy: version.created_by,
    createdAt: version.created_at
  };
  if (actor) {
    result.attachments = version.status === QUOTE_STATUSES.DRAFT
      ? listAttachments(db, actor, { targetType: "QUOTE_VERSION", targetId: versionId })
      : { mode: "SNAPSHOT", items: listAttachmentSnapshot(db, actor, "QUOTE_SUBMISSION", versionId) };
    result.exportedFiles = listQuoteVersionFiles(db, actor, versionId);
  }
  return result;
}

export function getQuoteVersion(db, actor, versionId) {
  const bundle = readVersionBundle(db, versionId);
  if (!canViewVersion(actor, bundle.version.owner_id)) throw new AppError(404, "QUOTE_VERSION_NOT_FOUND", "报价版本不存在或当前账号无权访问");
  return versionView(db, versionId, actor);
}

function insertItems(db, versionId, items, section = "SUMMARY") {
  const statement = db.prepare(`
    INSERT INTO quote_items (
      id, quote_version_id, line_no, section, pricing_mode, category, item_name, subitem_name, unit,
      quantity_milli, untaxed_unit_price_cents, tax_rate_bps, untaxed_amount_cents,
      taxed_amount_cents, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) {
    // 旧版本数据库曾按 (quote_version_id, line_no) 唯一；详情行使用稳定偏移兼容原约束。
    const storedLineNo = section === "DETAIL" ? 100_000 + item.lineNo : item.lineNo;
    statement.run(
      randomUUID(), versionId, storedLineNo, section, item.pricingMode, item.category, item.itemName, item.subitemName, item.unit,
      item.quantityMilli, item.untaxedUnitPriceCents, item.taxRateBps, item.untaxedAmountCents,
      item.taxedAmountCents, item.notes
    );
  }
}

function nextQuoteNumber(db) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replaceAll("-", "");
  const prefix = `BJ-${day}-`;
  const existing = db.prepare(`SELECT quote_number FROM quotes WHERE quote_number LIKE ?`).all(`${prefix}%`);
  const highest = existing.reduce((max, row) => {
    const suffix = row.quote_number.slice(prefix.length);
    return /^\d+$/.test(suffix) ? Math.max(max, Number(suffix)) : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(4, "0")}`;
}

export function createQuote(db, actor, input) {
  assert(actor.role === ROLES.PRESALES || actor.role === ROLES.ADMIN, 403, "QUOTE_CREATE_FORBIDDEN", "仅售前人员或管理员可以创建报价草稿");
  assert(canReadCustomer(db, actor, input.customerId), 404, "CUSTOMER_NOT_FOUND", "客户不存在或当前账号无权访问");
  const project = db.prepare(`SELECT id FROM projects WHERE id = ? AND customer_id = ? AND is_active = 1`).get(input.projectId, input.customerId);
  assert(project, 400, "PROJECT_INVALID", "项目与客户不匹配或已停用");
  const calculated = calculateQuoteItems(input.items);
  const detailCalculated = Array.isArray(input.detailItems) && input.detailItems.length ? calculateQuoteItems(input.detailItems) : { items: [], subtotalUntaxedCents: 0, subtotalTaxedCents: 0 };
  requireMatchingQuoteTotals(calculated.items, detailCalculated.items);
  const finalDiscountCents = input.finalDiscountCents ?? calculated.subtotalTaxedCents;
  requireInteger(finalDiscountCents, "最终优惠价", { min: 1 });
  assert(finalDiscountCents <= calculated.subtotalTaxedCents, 422, "QUOTE_DISCOUNT_INVALID", "最终优惠价不能高于含税合计");
  const quoteId = randomUUID();
  const versionId = randomUUID();
  const timestamp = nowIso();
  const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(input.customerId);
  const creator = db.prepare(`SELECT display_name, phone, email FROM users WHERE id = ?`).get(actor.id);
  const metadata = normalizeQuoteMetadata(input.metadata, {
    customerName: customer.full_name,
    customerAddress: [customer.province, customer.city, customer.district, customer.address].filter(Boolean).join(" "),
    sellerName: creator.display_name,
    sellerPhone: creator.phone || "",
    sellerEmail: creator.email || ""
  });
  metadata.sourceKind = "SYSTEM";
  try {
    db.transaction(() => {
      const quoteNumber = input.quoteNumber?.trim() || nextQuoteNumber(db);
      db.prepare(`INSERT INTO quotes (id, quote_number, customer_id, project_id, created_by, current_version_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(quoteId, quoteNumber, input.customerId, input.projectId, actor.id, versionId, timestamp);
      db.prepare(`
        INSERT INTO quote_versions (id, quote_id, revision, status, notes, metadata_json, subtotal_untaxed_cents, subtotal_taxed_cents, final_discount_cents, created_by, created_at)
        VALUES (?, ?, 1, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)
      `).run(versionId, quoteId, input.notes || null, JSON.stringify(metadata), calculated.subtotalUntaxedCents, calculated.subtotalTaxedCents, finalDiscountCents, actor.id, timestamp);
      insertItems(db, versionId, calculated.items, "SUMMARY");
      insertItems(db, versionId, detailCalculated.items, "DETAIL");
      audit(db, { actorId: actor.id, action: "QUOTE_CREATED", entityType: "QUOTE_VERSION", entityId: versionId, summary: { quoteId, revision: 1 } });
    }).immediate();
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw new AppError(409, "QUOTE_NUMBER_EXISTS", "报价编号已存在");
    throw error;
  }
  return getQuoteVersion(db, actor, versionId);
}

export function updateQuoteDraft(db, actor, versionId, input) {
  const bundle = readVersionBundle(db, versionId);
  const { version } = bundle;
  const existingMetadata = JSON.parse(version.metadata_json || "{}");
  assert(existingMetadata.sourceKind !== "UPLOADED", 409, "UPLOADED_QUOTE_EDITOR_REQUIRED", "请使用上传报价的编辑入口");
  assert(version.status === QUOTE_STATUSES.DRAFT, 409, "QUOTE_NOT_DRAFT", "仅当前草稿版本可以修改");
  assert(version.owner_id === actor.id || actor.role === ROLES.ADMIN, 403, "QUOTE_UPDATE_FORBIDDEN", "仅客户当前负责人可以修改报价草稿");
  const current = db.prepare(`SELECT current_version_id FROM quotes WHERE id = ?`).get(version.quote_id);
  assert(current.current_version_id === versionId, 409, "QUOTE_VERSION_NOT_CURRENT", "只能修改报价的当前版本");
  if (input.expectedDraftEtag !== undefined) {
    assert(Number.isSafeInteger(input.expectedDraftEtag) && input.expectedDraftEtag >= 0, 400, "DRAFT_ETAG_INVALID", "草稿版本标识无效");
    assert(input.expectedDraftEtag === version.draft_etag, 409, "DRAFT_VERSION_CHANGED", "草稿已在其他页面更新，请重新打开后继续编辑");
  }
  const calculated = calculateQuoteItems(input.items);
  const detailCalculated = Array.isArray(input.detailItems) && input.detailItems.length ? calculateQuoteItems(input.detailItems) : { items: [], subtotalUntaxedCents: 0, subtotalTaxedCents: 0 };
  requireMatchingQuoteTotals(calculated.items, detailCalculated.items);
  const finalDiscountCents = input.finalDiscountCents ?? calculated.subtotalTaxedCents;
  requireInteger(finalDiscountCents, "最终优惠价", { min: 1 });
  assert(finalDiscountCents <= calculated.subtotalTaxedCents, 422, "QUOTE_DISCOUNT_INVALID", "最终优惠价不能高于明细含税合计");
  const notes = input.notes || null;
  const metadata = normalizeQuoteMetadata(input.metadata, existingMetadata);
  metadata.sourceKind = existingMetadata.sourceKind === "UPLOADED" ? "UPLOADED" : "SYSTEM";
  const itemsChanged = JSON.stringify(calculated.items) !== JSON.stringify(bundle.items) || JSON.stringify(detailCalculated.items) !== JSON.stringify(bundle.detailItems);
  if (!itemsChanged && notes === version.notes && JSON.stringify(metadata) === JSON.stringify(JSON.parse(version.metadata_json || "{}")) && finalDiscountCents === version.final_discount_cents) return getQuoteVersion(db, actor, versionId);
  const timestamp = nowIso();
  const nextDraftEtag = version.draft_etag + 1;
  const automatic = input.saveMode === "AUTO";
  db.transaction(() => {
    const result = db.prepare(`
      UPDATE quote_versions
      SET notes = ?, metadata_json = ?, subtotal_untaxed_cents = ?, subtotal_taxed_cents = ?, final_discount_cents = ?, draft_etag = ?, draft_saved_at = ?
      WHERE id = ? AND draft_etag = ?
    `).run(notes, JSON.stringify(metadata), calculated.subtotalUntaxedCents, calculated.subtotalTaxedCents, finalDiscountCents, nextDraftEtag, timestamp, versionId, version.draft_etag);
    assert(result.changes === 1, 409, "DRAFT_VERSION_CHANGED", "草稿已在其他页面更新，请重新打开后继续编辑");
    if (itemsChanged) {
      db.prepare(`DELETE FROM quote_items WHERE quote_version_id = ?`).run(versionId);
      insertItems(db, versionId, calculated.items, "SUMMARY");
      insertItems(db, versionId, detailCalculated.items, "DETAIL");
    }
    if (automatic) return;
    audit(db, { actorId: actor.id, action: "QUOTE_DRAFT_UPDATED", entityType: "QUOTE_VERSION", entityId: versionId, summary: { subtotalTaxedCents: calculated.subtotalTaxedCents, finalDiscountCents, discountAmountCents: calculated.subtotalTaxedCents - finalDiscountCents } });
  })();
  return getQuoteVersion(db, actor, versionId);
}

export function createUploadedQuote(db, actor, input = {}) {
  assert(actor.role === ROLES.PRESALES || actor.role === ROLES.ADMIN, 403, "QUOTE_CREATE_FORBIDDEN", "仅售前人员或管理员可以创建报价");
  assert(canReadCustomer(db, actor, input.customerId), 404, "CUSTOMER_NOT_FOUND", "客户不存在或当前账号无权访问");
  assert(db.prepare(`SELECT id FROM projects WHERE id = ? AND customer_id = ? AND is_active = 1`).get(input.projectId, input.customerId), 400, "PROJECT_INVALID", "项目与客户不匹配或已停用");
  const amount = requireInteger(input.amountCents, "文件含税总额", { min: 1 });
  const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(input.customerId);
  const creator = db.prepare(`SELECT display_name, phone, email FROM users WHERE id = ?`).get(actor.id);
  const metadata = normalizeQuoteMetadata({}, { customerName: customer.full_name, sellerName: creator.display_name, sellerPhone: creator.phone || "", sellerEmail: creator.email || "" });
  metadata.sourceKind = "UPLOADED";
  const quoteId = randomUUID();
  const versionId = randomUUID();
  const timestamp = nowIso();
  db.transaction(() => {
    const quoteNumber = nextQuoteNumber(db);
    db.prepare(`INSERT INTO quotes (id, quote_number, customer_id, project_id, created_by, current_version_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(quoteId, quoteNumber, input.customerId, input.projectId, actor.id, versionId, timestamp);
    // 未税金额不可从原文件推断：数据库 0 为占位，API 与审批快照返回 null。
    db.prepare(`INSERT INTO quote_versions (id, quote_id, revision, status, notes, metadata_json, subtotal_untaxed_cents, subtotal_taxed_cents, final_discount_cents, created_by, created_at) VALUES (?, ?, 1, 'DRAFT', ?, ?, 0, ?, ?, ?, ?)`)
      .run(versionId, quoteId, "含税金额由提交人登记，请核对原文件", JSON.stringify(metadata), amount, amount, actor.id, timestamp);
    audit(db, { actorId: actor.id, action: "UPLOADED_QUOTE_CREATED", entityType: "QUOTE_VERSION", entityId: versionId, summary: { quoteId, revision: 1, amountCents: amount } });
  })();
  return getQuoteVersion(db, actor, versionId);
}

export function updateUploadedQuote(db, actor, versionId, input = {}) {
  const bundle = readVersionBundle(db, versionId);
  if (!canViewVersion(actor, bundle.version.owner_id)) throw new AppError(404, "QUOTE_VERSION_NOT_FOUND", "报价版本不存在或当前账号无权访问");
  const version = bundle.version;
  assert(JSON.parse(version.metadata_json || "{}").sourceKind === "UPLOADED", 409, "QUOTE_SOURCE_INVALID", "此报价不是上传文件报价");
  assert(version.status === QUOTE_STATUSES.DRAFT, 409, "QUOTE_NOT_DRAFT", "仅未发送的报价可以修改");
  assert(actor.role === ROLES.ADMIN || (actor.role === ROLES.PRESALES && version.owner_id === actor.id), 403, "QUOTE_UPDATE_FORBIDDEN", "仅客户当前负责人可以修改报价");
  assert(db.prepare(`SELECT current_version_id FROM quotes WHERE id = ?`).get(version.quote_id)?.current_version_id === versionId, 409, "QUOTE_VERSION_NOT_CURRENT", "只能修改当前报价版本");
  assert(Number.isSafeInteger(input.expectedDraftEtag) && input.expectedDraftEtag === version.draft_etag, 409, "DRAFT_VERSION_CHANGED", "报价已更新，请重新打开后修改");
  const amount = requireInteger(input.amountCents, "文件含税总额", { min: 1 });
  if (amount === version.final_discount_cents) return getQuoteVersion(db, actor, versionId);
  const timestamp = nowIso();
  db.transaction(() => {
    const result = db.prepare(`UPDATE quote_versions SET subtotal_taxed_cents = ?, final_discount_cents = ?, draft_etag = draft_etag + 1, draft_saved_at = ? WHERE id = ? AND draft_etag = ?`)
      .run(amount, amount, timestamp, versionId, version.draft_etag);
    assert(result.changes === 1, 409, "DRAFT_VERSION_CHANGED", "报价已更新，请重新打开后修改");
    audit(db, { actorId: actor.id, action: "UPLOADED_QUOTE_AMOUNT_UPDATED", entityType: "QUOTE_VERSION", entityId: versionId, summary: { previousAmountCents: version.final_discount_cents, amountCents: amount } });
  })();
  return getQuoteVersion(db, actor, versionId);
}

export function makeContentSnapshot(db, versionId, attachments) {
  const view = versionView(db, versionId);
  const metadata = view.metadata;
  const legacyUserContact = !metadata.customerContactSource
    && metadata.customerContactName && metadata.customerPhone
    && metadata.customerContactName === metadata.sellerName
    && metadata.customerPhone === metadata.sellerPhone;
  return {
    schemaVersion: 4,
    roundingPolicy: "ALLOCATE_V2",
    approvalWorkflow: [QUOTE_APPROVAL_STAGES.MANAGER, QUOTE_APPROVAL_STAGES.GENERAL_MANAGER, QUOTE_APPROVAL_STAGES.VP],
    quoteVersionId: view.id,
    sourceKind: view.sourceKind,
    quoteNumber: view.quoteNumber,
    revision: view.revision,
    customer: view.customer,
    project: view.project,
    notes: view.notes,
    metadata: legacyUserContact ? { ...metadata, customerContactName: "", customerPhone: "" } : metadata,
    items: view.items,
    detailItems: view.detailItems,
    detailRoundingAdjustmentCents: view.detailRoundingAdjustmentCents,
    detailRoundingAllocationsCents: view.detailRoundingAllocationsCents,
    detailSubtotalUntaxedCents: view.detailSubtotalUntaxedCents,
    detailSubtotalTaxedCents: view.detailSubtotalTaxedCents,
    subtotalUntaxedCents: view.subtotalUntaxedCents,
    subtotalTaxedCents: view.subtotalTaxedCents,
    finalDiscountCents: view.finalDiscountCents,
    discountAmountCents: view.discountAmountCents,
    attachments: attachments.map(item => ({ id: item.id, attachmentId: item.attachmentId, attachmentVersionId: item.attachmentVersionId, targetType: item.targetType, targetKey: item.targetKey, originalName: item.originalName, mimeType: item.mimeType, sizeBytes: item.sizeBytes, sha256: item.sha256 }))
  };
}

export function submitQuote(db, actor, versionId, input = {}) {
  const bundle = readVersionBundle(db, versionId);
  const { version, items, detailItems } = bundle;
  const uploaded = JSON.parse(version.metadata_json || "{}").sourceKind === "UPLOADED";
  assert(version.status === QUOTE_STATUSES.DRAFT, 409, "QUOTE_NOT_DRAFT", "仅草稿报价可以提交审批");
  assert(version.owner_id === actor.id || actor.role === ROLES.ADMIN, 403, "QUOTE_SUBMIT_FORBIDDEN", "仅客户负责人可以提交报价");
  if (uploaded) assert(input.amountConfirmed === true, 422, "UPLOADED_QUOTE_AMOUNT_CONFIRM_REQUIRED", "请确认登记的含税总额与报价原文件一致");
  requireCurrentQuoteManager(db, version.customer_id);
  assert(db.prepare(`SELECT 1 FROM users WHERE role = 'MANAGER' AND position_code = 'GENERAL_MANAGER' AND is_active = 1 LIMIT 1`).get(), 409, "QUOTE_GENERAL_MANAGER_REQUIRED", "请先由管理员创建并启用综合部经理账号，再提交报价审批");
  assert(db.prepare(`SELECT 1 FROM users WHERE role = 'VP' AND is_active = 1 LIMIT 1`).get(), 409, "QUOTE_VP_REQUIRED", "请先由管理员创建并启用副总经理账号，再提交报价审批");
  if (uploaded) {
    assert(!items.length && !detailItems.length && Number.isSafeInteger(version.final_discount_cents) && version.final_discount_cents > 0 && version.final_discount_cents === version.subtotal_taxed_cents, 409, "UPLOADED_QUOTE_AMOUNT_INVALID", "文件报价金额记录无效，请联系管理员");
  } else {
    const calculated = calculateQuoteItems(items);
    const validatedDetails = detailItems.length ? calculateQuoteItems(detailItems).items : [];
    requireMatchingQuoteTotals(calculated.items, validatedDetails);
    assert(calculated.subtotalUntaxedCents === version.subtotal_untaxed_cents && calculated.subtotalTaxedCents === version.subtotal_taxed_cents, 409, "QUOTE_STORED_AMOUNT_INVALID", "报价存储金额校验失败，请联系管理员");
    assert(version.final_discount_cents > 0 && version.final_discount_cents <= calculated.subtotalTaxedCents, 422, "QUOTE_DISCOUNT_INVALID", "最终优惠价无效");
  }
  const timestamp = nowIso();
  db.transaction(() => {
    const attachments = freezeAttachments(db, { snapshotKind: "QUOTE_SUBMISSION", snapshotOwnerId: versionId, customerId: version.customer_id, targets: [{ targetType: "QUOTE_VERSION", targetId: versionId }] });
    const primary = attachments.filter(item => !item.targetKey);
    const sourceWord = attachments.filter(item => item.targetKey === "QUOTE_WORD");
    if (uploaded) assert(primary.length === 1 && primary[0].mimeType === "application/pdf" && sourceWord.length <= 1 && attachments.length === primary.length + sourceWord.length, 422, "UPLOADED_QUOTE_SOURCE_REQUIRED", "请上传一份 PDF 报价单后再发送审批");
    const snapshot = makeContentSnapshot(db, versionId, attachments);
    if (uploaded) {
      const review = requireQuoteReviewForSubmit(db, versionId, input);
      assert(review.attachmentVersionId === primary[0].attachmentVersionId && review.attachmentSha256 === primary[0].sha256, 409, "QUOTE_REVIEW_SOURCE_CHANGED", "报价原文件已变化，请重新检查");
      const automatic = review.inspectionMode === "AUTO_FIXED_FIELDS";
      const amountMatched = !automatic || review.amountVerification === "MATCH";
      snapshot.uploadedSource = { attachmentId: primary[0].attachmentId, attachmentVersionId: primary[0].attachmentVersionId, sha256: primary[0].sha256,
        recordedAmountCents: version.final_discount_cents, confirmedAmountCents: amountMatched ? version.final_discount_cents : null,
        amountVerification: automatic ? review.amountVerification : "MANUAL", confirmedBy: automatic ? null : actor.id, confirmedAt: automatic ? null : timestamp };
      snapshot.documentReview = { ...review, manualConfirmed: review.inspectionMode === "AUTO_FIXED_FIELDS" ? false : review.reviewCount > 0,
        confirmedBy: review.inspectionMode === "AUTO_FIXED_FIELDS" ? null : actor.id, confirmedAt: review.inspectionMode === "AUTO_FIXED_FIELDS" ? null : timestamp };
    }
    const snapshotJson = JSON.stringify(snapshot);
    db.prepare(`UPDATE quote_versions SET status = 'PENDING_MANAGER', approval_stage = 'MANAGER', snapshot_json = ?, snapshot_hash = ?, submitted_at = ?, locked_at = ? WHERE id = ?`)
      .run(snapshotJson, sha256(snapshotJson), timestamp, timestamp, versionId);
    audit(db, { actorId: actor.id, action: "QUOTE_SUBMITTED", entityType: "QUOTE_VERSION", entityId: versionId, summary: { revision: version.revision, snapshotHash: sha256(snapshotJson) } });
  })();
  return getQuoteVersion(db, actor, versionId);
}

function createReturnedSuccessor(db, version, items, detailItems, actorId, returnedStatus, timestamp) {
  const successorId = randomUUID();
  const nextRevision = version.revision + 1;
  db.prepare(`UPDATE quote_versions SET status = ?, approval_stage = NULL WHERE id = ?`).run(returnedStatus, version.id);
  db.prepare(`
    INSERT INTO quote_versions (id, quote_id, revision, status, notes, metadata_json, subtotal_untaxed_cents, subtotal_taxed_cents, final_discount_cents, created_by, created_at)
    VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)
  `).run(successorId, version.quote_id, nextRevision, version.notes, version.metadata_json, version.subtotal_untaxed_cents, version.subtotal_taxed_cents, version.final_discount_cents, version.quote_created_by, timestamp);
  insertItems(db, successorId, items, "SUMMARY");
  insertItems(db, successorId, detailItems, "DETAIL");
  cloneCurrentAttachments(db, { fromTargetType: "QUOTE_VERSION", fromTargetId: version.id, toTargetType: "QUOTE_VERSION", toTargetId: successorId, customerId: version.customer_id, actorId });
  db.prepare(`UPDATE quotes SET current_version_id = ? WHERE id = ?`).run(successorId, version.quote_id);
  audit(db, { actorId, action: "QUOTE_SUCCESSOR_CREATED", entityType: "QUOTE_VERSION", entityId: successorId, summary: { previousVersionId: version.id, revision: nextRevision } });
  return successorId;
}

export function createApprovedQuoteRevision(db, actor, versionId, { reason } = {}) {
  assert(reason?.trim(), 400, "QUOTE_REVISION_REASON_REQUIRED", "调整已审批报价必须填写原因");
  const { version, items, detailItems } = readVersionBundle(db, versionId);
  assert(version.status === QUOTE_STATUSES.APPROVED, 409, "QUOTE_REVISION_SOURCE_INVALID", "只能从已完成审批的报价创建调价版本");
  assert(version.owner_id === actor.id || actor.role === ROLES.ADMIN, 403, "QUOTE_REVISION_FORBIDDEN", "仅客户当前负责人或管理员可以发起调价版本");
  const current = db.prepare(`SELECT current_version_id FROM quotes WHERE id = ?`).get(version.quote_id);
  assert(current?.current_version_id === versionId, 409, "QUOTE_VERSION_NOT_CURRENT", "只能从当前已审批版本创建调价版本");
  const timestamp = nowIso();
  let successorId;
  db.transaction(() => {
    successorId = randomUUID();
    const nextRevision = version.revision + 1;
    db.prepare(`
      INSERT INTO quote_versions (id, quote_id, revision, status, notes, metadata_json, subtotal_untaxed_cents, subtotal_taxed_cents, final_discount_cents, created_by, created_at)
      VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)
    `).run(successorId, version.quote_id, nextRevision, version.notes, version.metadata_json, version.subtotal_untaxed_cents, version.subtotal_taxed_cents, version.final_discount_cents, actor.id, timestamp);
    insertItems(db, successorId, items, "SUMMARY");
    insertItems(db, successorId, detailItems, "DETAIL");
    cloneCurrentAttachments(db, { fromTargetType: "QUOTE_VERSION", fromTargetId: version.id, toTargetType: "QUOTE_VERSION", toTargetId: successorId, customerId: version.customer_id, actorId: actor.id });
    db.prepare(`UPDATE quotes SET current_version_id = ? WHERE id = ?`).run(successorId, version.quote_id);
    audit(db, {
      actorId: actor.id,
      action: "QUOTE_APPROVED_REVISION_CREATED",
      entityType: "QUOTE_VERSION",
      entityId: successorId,
      summary: { previousVersionId: version.id, revision: nextRevision, reason: reason.trim() }
    });
  })();
  return getQuoteVersion(db, actor, successorId);
}

export function decideQuote(db, actor, versionId, { decision, comment }) {
  assert(["APPROVED", "REJECTED"].includes(decision), 400, "APPROVAL_DECISION_INVALID", "审批结果无效");
  assert(comment == null || typeof comment === "string", 400, "APPROVAL_COMMENT_INVALID", "审批备注必须是文字");
  const enteredComment = (comment || "").trim();
  assert(decision !== "REJECTED" || enteredComment, 400, "APPROVAL_COMMENT_REQUIRED", "退回时请填写原因");
  const approvalComment = enteredComment || "通过";
  const bundle = readVersionBundle(db, versionId);
  const { version, items, detailItems } = bundle;
  const stage = version.status === QUOTE_STATUSES.PENDING_MANAGER
    ? QUOTE_APPROVAL_STAGES.MANAGER
    : version.status === QUOTE_STATUSES.PENDING_VP
      ? (version.approval_stage || QUOTE_APPROVAL_STAGES.VP)
      : null;
  assert(stage, 409, "QUOTE_NOT_PENDING", "当前报价版本不在待审批状态");
  assert(canApproveCustomerQuote(db, actor, version.customer_id, stage), 403, "QUOTE_APPROVE_FORBIDDEN", "当前账号无权处理该级审批");
  if (stage === QUOTE_APPROVAL_STAGES.MANAGER) {
    const manager = requireCurrentQuoteManager(db, version.customer_id);
    assert(actor.role === ROLES.ADMIN || manager.id === actor.id, 403, "QUOTE_APPROVE_FORBIDDEN", "待审报价已交接，请刷新待办");
  }
  const content = JSON.parse(version.snapshot_json);
  const approvalWorkflow = Array.isArray(content.approvalWorkflow)
    ? content.approvalWorkflow
    : [QUOTE_APPROVAL_STAGES.MANAGER, QUOTE_APPROVAL_STAGES.VP];
  const stageIndex = approvalWorkflow.indexOf(stage);
  assert(stageIndex >= 0, 409, "QUOTE_APPROVAL_CHAIN_INVALID", "当前审批阶段不属于该报价提交时锁定的审批流程");
  const timestamp = nowIso();
  let successorId = null;
  db.transaction(() => {
    const approvalId = randomUUID();
    db.prepare(`INSERT INTO quote_approvals (id, quote_version_id, stage, decision, approver_id, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(approvalId, versionId, stage, decision, actor.id, approvalComment, timestamp);
    if (decision === "APPROVED") {
      const nextStage = approvalWorkflow[stageIndex + 1] || null;
      const next = nextStage
        ? { status: nextStage === QUOTE_APPROVAL_STAGES.MANAGER ? QUOTE_STATUSES.PENDING_MANAGER : QUOTE_STATUSES.PENDING_VP, approvalStage: nextStage }
        : { status: QUOTE_STATUSES.APPROVED, approvalStage: null };
      db.prepare(`UPDATE quote_versions SET status = ?, approval_stage = ? WHERE id = ?`).run(next.status, next.approvalStage, versionId);
    } else {
      successorId = createReturnedSuccessor(
        db, version, items, detailItems, actor.id,
        stage === QUOTE_APPROVAL_STAGES.VP ? QUOTE_STATUSES.VP_RETURNED : QUOTE_STATUSES.MANAGER_RETURNED,
        timestamp
      );
    }
    const approvals = db.prepare(`SELECT stage, decision, approver_id AS approverId, comment, created_at AS createdAt FROM quote_approvals WHERE quote_version_id = ? ORDER BY created_at, rowid`).all(versionId);
    const approvalSnapshotJson = JSON.stringify({ schemaVersion: 1, content, approvals });
    db.prepare(`INSERT INTO quote_approval_snapshots (id, quote_version_id, approval_id, snapshot_json, snapshot_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), versionId, approvalId, approvalSnapshotJson, sha256(approvalSnapshotJson), timestamp);
    audit(db, { actorId: actor.id, action: `QUOTE_${stage}_${decision}`, entityType: "QUOTE_VERSION", entityId: versionId, summary: { comment: approvalComment, successorId } });
  })();
  return { decidedVersion: getQuoteVersion(db, actor, versionId), successorVersionId: successorId };
}

export function listPendingQuotes(db, actor) {
  let status;
  let approvalStage;
  if (actor.role === ROLES.MANAGER && actor.positionCode === MANAGER_POSITIONS.GENERAL_MANAGER) {
    status = QUOTE_STATUSES.PENDING_VP;
    approvalStage = QUOTE_APPROVAL_STAGES.GENERAL_MANAGER;
  } else if (actor.role === ROLES.MANAGER) {
    status = QUOTE_STATUSES.PENDING_MANAGER;
    approvalStage = QUOTE_APPROVAL_STAGES.MANAGER;
  } else if (actor.role === ROLES.VP) {
    status = QUOTE_STATUSES.PENDING_VP;
    approvalStage = QUOTE_APPROVAL_STAGES.VP;
  }
  else return [];
  const rows = db.prepare(`
    SELECT qv.id, q.customer_id
    FROM quote_versions qv
    JOIN quotes q ON q.id = qv.quote_id
    WHERE qv.status = ? AND COALESCE(qv.approval_stage, CASE WHEN qv.status = 'PENDING_MANAGER' THEN 'MANAGER' ELSE 'VP' END) = ?
    ORDER BY qv.submitted_at
  `).all(status, approvalStage);
  return rows.filter(row => canApproveCustomerQuote(db, actor, row.customer_id, approvalStage))
    .map(row => getQuoteVersion(db, actor, row.id));
}

export function listQuotes(db, actor) {
  let rows;
  if (canReadAllCustomersAndQuotes(actor)) {
    rows = db.prepare(`SELECT current_version_id AS id FROM quotes ORDER BY created_at DESC`).all();
  } else if (actor.role === ROLES.PRESALES) {
    rows = db.prepare(`
      SELECT q.current_version_id AS id FROM quotes q
      JOIN customers c ON c.id = q.customer_id
      WHERE c.owner_id = ? ORDER BY q.created_at DESC
    `).all(actor.id);
  } else rows = [];
  return rows.map(row => getQuoteVersion(db, actor, row.id));
}
