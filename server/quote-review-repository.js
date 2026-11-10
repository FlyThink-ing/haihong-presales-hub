import { AppError, assert } from "./domain.js";

export function currentReviewSource(db, versionId) {
  const version = db.prepare(`SELECT qv.id, qv.status, qv.draft_etag, qv.final_discount_cents, qv.metadata_json, q.current_version_id, q.customer_id, c.owner_id
    FROM quote_versions qv JOIN quotes q ON q.id = qv.quote_id JOIN customers c ON c.id = q.customer_id WHERE qv.id = ?`).get(versionId);
  if (!version) throw new AppError(404, "QUOTE_VERSION_NOT_FOUND", "报价版本不存在或当前账号无权访问");
  const sources = db.prepare(`SELECT a.id AS attachment_id, a.current_version_id, f.sha256, f.mime_type
    FROM business_attachments a JOIN business_attachment_versions v ON v.id = a.current_version_id
    JOIN stored_files f ON f.id = v.file_id WHERE a.target_type = 'QUOTE_VERSION' AND a.target_id = ? AND a.target_key = '' AND a.is_deleted = 0`).all(versionId);
  const transferCount = db.prepare(`SELECT COUNT(*) AS count FROM customer_transfers WHERE customer_id = ?`).get(version.customer_id).count;
  return { version, sources, transferCount };
}

export function latestCurrentQuoteReview(db, versionId) {
  const { version, sources, transferCount } = currentReviewSource(db, versionId);
  if (sources.length !== 1 || sources[0].mime_type !== "application/pdf") return null;
  const source = sources[0];
  const row = db.prepare(`SELECT r.*, u.display_name AS reviewer_name FROM quote_document_reviews r JOIN users u ON u.id = r.reviewed_by WHERE r.quote_version_id = ? AND r.attachment_version_id = ? AND r.attachment_sha256 = ? AND r.draft_etag = ? AND r.amount_cents = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`)
    .get(versionId, source.current_version_id, source.sha256, version.draft_etag, version.final_discount_cents);
  if (!row) return null;
  const result = JSON.parse(row.result_json);
  if (result.customerOwnerId !== version.owner_id || result.transferCount !== transferCount) return null;
  return { id: row.id, boundaryIndex: row.boundary_index, boundaryLocation: row.boundary_location, attachmentVersionId: row.attachment_version_id,
    attachmentSha256: row.attachment_sha256, reviewedBy: row.reviewed_by, reviewerName: row.reviewer_name, createdAt: row.created_at, ...result };
}

export function requireQuoteReviewForSubmit(db, versionId, input) {
  const review = latestCurrentQuoteReview(db, versionId);
  assert(review && input.reviewId === review.id, 422, "QUOTE_REVIEW_REQUIRED", "请先检查当前报价文件；文件或金额变化后需重新检查");
  assert(review.errorCount === 0, 422, "QUOTE_REVIEW_ERRORS", "报价检查发现明确问题，请修正后重新检查");
  assert(review.reviewCount === 0 || input.reviewConfirmed === true, 422, "QUOTE_REVIEW_CONFIRM_REQUIRED", "请先确认已人工核对待核对项目");
  return review;
}
