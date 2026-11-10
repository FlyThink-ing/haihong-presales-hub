import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { getAttachmentPreview } from "./attachment-service.js";
import { nowIso } from "./database.js";
import { AppError, assert } from "./domain.js";
import { getQuoteVersion, QUOTE_COMPANY } from "./quote-service.js";
import { parseQuoteDocument } from "./quote-document-parser.js";
import { checkMainQuote } from "./quote-document-checks.js";
import { currentReviewSource, latestCurrentQuoteReview } from "./quote-review-repository.js";
import { inspectQuoteBinding, requireMatchingQuoteBinding, requireQuoteBindingReview } from "./quote-binding.js";
import { checkFixedQuoteFields, requireFixedQuoteFields } from "./quote-fixed-check.js";

function authorizedSource(db, actor, versionId) {
  const quote = getQuoteVersion(db, actor, versionId);
  assert(quote.sourceKind === "UPLOADED", 409, "QUOTE_REVIEW_SOURCE_INVALID", "当前报价不是上传文件报价");
  const { version, sources, transferCount } = currentReviewSource(db, versionId);
  assert(version.status === "DRAFT" && version.current_version_id === versionId, 409, "QUOTE_REVIEW_NOT_DRAFT", "仅当前未发送报价可以重新检查");
  assert(actor.role === "ADMIN" || (actor.role === "PRESALES" && version.owner_id === actor.id), 403, "QUOTE_REVIEW_FORBIDDEN", "仅管理员或客户当前负责人可以检查报价");
  const active = db.prepare(`SELECT is_active FROM users WHERE id = ?`).get(actor.id);
  assert(active?.is_active, 403, "QUOTE_REVIEW_FORBIDDEN", "当前账号不可用");
  assert(sources.length === 1 && sources[0].mime_type === "application/pdf", 422, "UPLOADED_QUOTE_SOURCE_REQUIRED", "请先上传一份 PDF 报价单");
  return { quote, version, source: sources[0], transferCount };
}

function sameSource(a, b) {
  return a.source.attachment_id === b.source.attachment_id && a.source.current_version_id === b.source.current_version_id
    && a.source.sha256 === b.source.sha256 && a.version.draft_etag === b.version.draft_etag
    && a.version.final_discount_cents === b.version.final_discount_cents && a.version.owner_id === b.version.owner_id
    && a.transferCount === b.transferCount;
}

async function loadDocument(db, config, actor, versionId) {
  const before = authorizedSource(db, actor, versionId);
  const file = getAttachmentPreview(db, config, actor, before.source.attachment_id, before.source.current_version_id);
  assert(file.sha256 === before.source.sha256, 409, "QUOTE_REVIEW_SOURCE_CHANGED", "报价文件已变化，请重新检查");
  const parsed = await parseQuoteDocument(file);
  const after = authorizedSource(db, actor, versionId);
  assert(sameSource(before, after), 409, "QUOTE_REVIEW_SOURCE_CHANGED", "报价文件、金额或负责人已变化，请重新检查");
  return { source: after, parsed };
}

export async function previewQuoteReviewBoundary(db, config, actor, versionId) {
  const { source, parsed } = await loadDocument(db, config, actor, versionId);
  return { attachmentVersionId: source.source.current_version_id, draftEtag: source.version.draft_etag,
    format: parsed.format, suggestedEndIndex: parsed.boundary.endIndex, reason: parsed.boundary.reason,
    units: parsed.units.map(unit => ({ index: unit.index, location: unit.location, text: unit.text.slice(0, 120) || (unit.image ? "图片" : unit.unresolvedFormula ? "公式结果未保存" : unit.isMerged ? "合并单元格" : "空白") })) };
}

export async function runQuoteReview(db, config, actor, versionId, input = {}) {
  const { source, parsed } = await loadDocument(db, config, actor, versionId);
  assert(input.attachmentVersionId === source.source.current_version_id && input.draftEtag === source.version.draft_etag, 409, "QUOTE_REVIEW_SOURCE_CHANGED", "报价文件或金额已变化，请重新选择检查范围");
  assert(Number.isInteger(input.endIndex) && input.endIndex >= 0 && input.endIndex < parsed.units.length, 400, "QUOTE_REVIEW_BOUNDARY_REQUIRED", "请选择主报价结束位置");
  if (parsed.format === "PDF" && parsed.boundary.endIndex !== null) assert(input.endIndex >= parsed.boundary.endIndex, 422, "QUOTE_REVIEW_BOUNDARY_INVALID", "已识别报价人邮箱，请将主报价结束位置选至邮箱行");
  const customer = db.prepare(`SELECT full_name, short_name FROM customers WHERE id = ?`).get(source.version.customer_id);
  const sellers = db.prepare(`SELECT display_name AS displayName, phone, email FROM users WHERE is_active = 1`).all();
  const result = checkMainQuote(parsed, input.endIndex, { company: QUOTE_COMPANY, customerName: customer.full_name, customerShortName: customer.short_name,
    declaredAmountCents: source.version.final_discount_cents, sellers });
  const latest = authorizedSource(db, actor, versionId);
  assert(sameSource(source, latest), 409, "QUOTE_REVIEW_SOURCE_CHANGED", "报价文件、金额或负责人已变化，请重新检查");
  const id = randomUUID(), timestamp = nowIso(), location = parsed.units[input.endIndex].location;
  db.transaction(() => {
    const current = authorizedSource(db, actor, versionId);
    assert(sameSource(source, current), 409, "QUOTE_REVIEW_SOURCE_CHANGED", "报价文件、金额或负责人已变化，请重新检查");
    db.prepare(`INSERT INTO quote_document_reviews (id, quote_version_id, attachment_version_id, attachment_sha256, draft_etag, amount_cents, boundary_index, boundary_location, result_json, reviewed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, versionId, source.source.current_version_id, source.source.sha256, source.version.draft_etag, source.version.final_discount_cents,
        input.endIndex, location, JSON.stringify({ ...result, format: parsed.format, customerOwnerId: source.version.owner_id, transferCount: source.transferCount }), actor.id, timestamp);
    audit(db, { actorId: actor.id, action: "QUOTE_DOCUMENT_REVIEWED", entityType: "QUOTE_VERSION", entityId: versionId,
      summary: { reviewId: id, attachmentVersionId: source.source.current_version_id, errorCount: result.errorCount, reviewCount: result.reviewCount } });
  })();
  return latestCurrentQuoteReview(db, versionId);
}

// Automatically verify only the requested fields when an uploaded quotation is sent for approval.
export async function runAutomaticQuoteReview(db, config, actor, versionId) {
  const { source, parsed } = await loadDocument(db, config, actor, versionId);
  const customer = db.prepare(`SELECT full_name, short_name FROM customers WHERE id = ?`).get(source.version.customer_id);
  const binding = inspectQuoteBinding(parsed, { customerName: customer.full_name, customerShortName: customer.short_name, amountCents: source.version.final_discount_cents });
  requireMatchingQuoteBinding(binding);
  const fixed = checkFixedQuoteFields(parsed);
  requireFixedQuoteFields(fixed);
  requireQuoteBindingReview(binding);
  assert(Number.isInteger(parsed.boundary.endIndex), 422, "QUOTE_BOUNDARY_UNRECOGNIZED", "无法定位报价人邮箱，请检查报价单后重新上传");
  const latest = authorizedSource(db, actor, versionId);
  assert(sameSource(source, latest), 409, "QUOTE_REVIEW_SOURCE_CHANGED", "报价文件、金额或负责人已变化，请重新上传");
  const id = randomUUID(), timestamp = nowIso(), endIndex = parsed.boundary.endIndex, location = parsed.units[endIndex].location;
  const result = { issues: [], errorCount: 0, reviewCount: 0, checkedThrough: location, inspectionMode: "AUTO_FIXED_FIELDS",
    amountVerification: binding.amount.status, format: parsed.format, customerOwnerId: source.version.owner_id, transferCount: source.transferCount };
  db.transaction(() => {
    const current = authorizedSource(db, actor, versionId);
    assert(sameSource(source, current), 409, "QUOTE_REVIEW_SOURCE_CHANGED", "报价文件、金额或负责人已变化，请重新上传");
    db.prepare(`INSERT INTO quote_document_reviews (id, quote_version_id, attachment_version_id, attachment_sha256, draft_etag, amount_cents, boundary_index, boundary_location, result_json, reviewed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, versionId, source.source.current_version_id, source.source.sha256, source.version.draft_etag, source.version.final_discount_cents,
        endIndex, location, JSON.stringify(result), actor.id, timestamp);
    audit(db, { actorId: actor.id, action: "QUOTE_DOCUMENT_REVIEWED", entityType: "QUOTE_VERSION", entityId: versionId,
      summary: { reviewId: id, attachmentVersionId: source.source.current_version_id, errorCount: 0, reviewCount: 0, mode: "AUTO_FIXED_FIELDS" } });
  })();
  return latestCurrentQuoteReview(db, versionId);
}

export function getQuoteReview(db, actor, versionId) {
  const quote = getQuoteVersion(db, actor, versionId);
  if (quote.sourceKind !== "UPLOADED") throw new AppError(404, "QUOTE_REVIEW_SOURCE_INVALID", "当前报价没有上传文件检查记录");
  if (quote.status !== "DRAFT") {
    const row = db.prepare(`SELECT snapshot_json FROM quote_versions WHERE id = ?`).get(versionId);
    return { review: row?.snapshot_json ? JSON.parse(row.snapshot_json).documentReview || null : null, locked: true };
  }
  return { review: latestCurrentQuoteReview(db, versionId), locked: false };
}
