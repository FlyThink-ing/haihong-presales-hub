import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { validateAttachmentFormat } from "./attachment-format.js";
import { nowIso } from "./database.js";
import { AppError, assert, QUOTE_STATUSES, ROLES } from "./domain.js";
import { removeManagedFile, resolveManagedPath, safeDownloadName, storeManagedBuffer } from "./file-service.js";
import { canReadAllCustomersAndQuotes, canReadCustomer } from "./permissions.js";
import { sha256 } from "./security.js";
import { parseQuoteDocument } from "./quote-document-parser.js";
import { inspectQuoteBinding, requireMatchingQuoteBinding, requireQuoteBindingReview } from "./quote-binding.js";
import { requireFixedQuoteFields } from "./quote-fixed-check.js";

export const ATTACHMENT_TARGETS = Object.freeze(["CUSTOMER", "FOLLOWUP", "SURVEY", "SURVEY_QUESTION", "QUOTE_VERSION"]);
export const ATTACHMENT_SNAPSHOT_KINDS = Object.freeze(["SURVEY_COMPLETION", "QUOTE_SUBMISSION"]);

export async function validateQuoteAttachmentFormat(file, extension = ".docx") {
  if (file && Buffer.isBuffer(file.buffer)) {
    assert(path.extname(String(file.originalname || "")).toLowerCase() === extension, 415, "QUOTE_ATTACHMENT_FORMAT_INVALID", extension === ".pdf" ? "正式报价单仅支持 PDF" : "Word 源文件仅支持 DOCX");
  }
  const result = await validateAttachmentFormat(file);
  if (extension === ".pdf") result.quotePdfParsed = await parseQuoteDocument({ buffer: file.buffer, mimeType: "application/pdf" });
  return result;
}

function cleanKey(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function readTarget(db, targetType, targetId, targetKey = "") {
  assert(ATTACHMENT_TARGETS.includes(targetType), 400, "ATTACHMENT_TARGET_INVALID", "附件业务类型无效");
  assert(cleanKey(targetId), 400, "ATTACHMENT_TARGET_INVALID", "附件业务记录不能为空");
  let row;
  if (targetType === "CUSTOMER") {
    row = db.prepare(`SELECT id, id AS customer_id, owner_id FROM customers WHERE id = ?`).get(targetId);
  } else if (targetType === "FOLLOWUP") {
    row = db.prepare(`SELECT f.id, f.customer_id, c.owner_id FROM followups f JOIN customers c ON c.id = f.customer_id WHERE f.id = ?`).get(targetId);
  } else if (targetType === "SURVEY" || targetType === "SURVEY_QUESTION") {
    row = db.prepare(`SELECT s.id, s.customer_id, s.status, s.response_json, t.schema_json, c.owner_id FROM surveys s JOIN survey_templates t ON t.id = s.template_id JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`).get(targetId);
    if (row && targetType === "SURVEY_QUESTION") {
      const key = cleanKey(targetKey);
      const schema = JSON.parse(row.schema_json || "{}");
      const exists = (schema.modules || []).some(module => (module.questions || []).some(question => question.id === key));
      assert(key && exists, 400, "ATTACHMENT_QUESTION_INVALID", "调研问题不存在或不属于当前模板");
    }
  } else if (targetType === "QUOTE_VERSION") {
    row = db.prepare(`
      SELECT qv.id, qv.quote_id, qv.status, qv.approval_stage, qv.metadata_json, qv.draft_etag, qv.final_discount_cents,
        q.current_version_id, q.customer_id, c.owner_id, c.full_name, c.short_name
      FROM quote_versions qv JOIN quotes q ON q.id = qv.quote_id JOIN customers c ON c.id = q.customer_id
      WHERE qv.id = ?
    `).get(targetId);
  }
  if (!row) throw new AppError(404, "ATTACHMENT_TARGET_NOT_FOUND", "业务记录不存在或当前账号无权访问");
  return row;
}

function requireTargetRead(db, actor, targetType, targetId, targetKey = "") {
  const target = readTarget(db, targetType, targetId, targetKey);
  if (targetType === "QUOTE_VERSION" && canReadAllCustomersAndQuotes(actor)) return target;
  if (canReadCustomer(db, actor, target.customer_id)) return target;
  throw new AppError(404, "ATTACHMENT_NOT_FOUND", "附件不存在或当前账号无权访问");
}

function requireTargetWrite(db, actor, targetType, targetId, targetKey = "") {
  const target = readTarget(db, targetType, targetId, targetKey);
  assert(actor.role === ROLES.ADMIN || (actor.role === ROLES.PRESALES && target.owner_id === actor.id), 403, "ATTACHMENT_WRITE_FORBIDDEN", "仅管理员或客户当前负责人可以维护附件");
  if (targetType === "SURVEY" || targetType === "SURVEY_QUESTION") {
    assert(target.status === "DRAFT", 409, "ATTACHMENT_TARGET_LOCKED", "已完成确认的调研附件已冻结，请先创建调研新版本");
  }
  if (targetType === "QUOTE_VERSION") {
    assert(target.status === QUOTE_STATUSES.DRAFT && target.current_version_id === targetId, 409, "ATTACHMENT_TARGET_LOCKED", "只有当前报价草稿可以维护附件");
  }
  return target;
}

function versionView(row) {
  return {
    id: row.version_id,
    revision: row.revision,
    fileId: row.file_id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    uploadedBy: { id: row.uploaded_by, displayName: row.uploaded_by_name },
    createdAt: row.version_created_at
  };
}

function attachmentRows(db, where, values = []) {
  return db.prepare(`
    SELECT a.*, v.id AS version_id, v.revision, v.file_id, v.created_at AS version_created_at,
      f.original_name, f.mime_type, f.size_bytes, f.sha256, v.uploaded_by,
      u.display_name AS uploaded_by_name
    FROM business_attachments a
    JOIN business_attachment_versions v ON v.attachment_id = a.id
    JOIN stored_files f ON f.id = v.file_id
    JOIN users u ON u.id = v.uploaded_by
    WHERE ${where}
    ORDER BY a.created_at, v.revision
  `).all(...values);
}

function groupAttachments(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.id)) grouped.set(row.id, {
      id: row.id,
      customerId: row.customer_id,
      targetType: row.target_type,
      targetId: row.target_id,
      targetKey: row.target_key || null,
      currentVersionId: row.current_version_id,
      deleted: Boolean(row.is_deleted),
      deletionReason: row.deletion_reason,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      versions: []
    });
    grouped.get(row.id).versions.push(versionView(row));
  }
  return [...grouped.values()].map(item => ({
    ...item,
    currentVersion: item.versions.find(version => version.id === item.currentVersionId) || null
  }));
}

function snapshotRows(db, snapshotKind, snapshotOwnerId) {
  return db.prepare(`
    SELECT s.*, v.file_id, v.revision, u.display_name AS uploaded_by_name, v.uploaded_by
    FROM business_attachment_snapshots s
    JOIN business_attachment_versions v ON v.id = s.attachment_version_id
    JOIN users u ON u.id = v.uploaded_by
    WHERE s.snapshot_kind = ? AND s.snapshot_owner_id = ?
    ORDER BY s.target_type, s.target_key, s.created_at, s.id
  `).all(snapshotKind, snapshotOwnerId).map(row => ({
    id: row.id,
    snapshotKind: row.snapshot_kind,
    snapshotOwnerId: row.snapshot_owner_id,
    attachmentId: row.attachment_id,
    attachmentVersionId: row.attachment_version_id,
    targetType: row.target_type,
    targetId: row.target_id,
    targetKey: row.target_key || null,
    revision: row.revision,
    fileId: row.file_id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    uploadedBy: { id: row.uploaded_by, displayName: row.uploaded_by_name },
    createdAt: row.created_at
  }));
}

export function listAttachments(db, actor, { targetType, targetId, targetKey = "" }) {
  const target = requireTargetRead(db, actor, targetType, targetId, targetKey);
  if (targetType === "QUOTE_VERSION" && target.status !== QUOTE_STATUSES.DRAFT) {
    return { mode: "SNAPSHOT", items: listAttachmentSnapshot(db, actor, "QUOTE_SUBMISSION", targetId) };
  }
  const key = targetType === "SURVEY_QUESTION" ? cleanKey(targetKey) : "";
  const rows = targetType === "QUOTE_VERSION"
    ? attachmentRows(db, `a.target_type = ? AND a.target_id = ? AND a.is_deleted = 0`, [targetType, targetId])
    : attachmentRows(db, `a.target_type = ? AND a.target_id = ? AND a.target_key = ? AND a.is_deleted = 0`, [targetType, targetId, key]);
  return { mode: "CURRENT", items: groupAttachments(rows) };
}

export function listSurveyAttachments(db, actor, surveyId) {
  const target = requireTargetRead(db, actor, "SURVEY", surveyId);
  if (target.status === "COMPLETED") return { mode: "SNAPSHOT", items: listAttachmentSnapshot(db, actor, "SURVEY_COMPLETION", surveyId) };
  const rows = attachmentRows(db, `a.target_type IN ('SURVEY','SURVEY_QUESTION') AND a.target_id = ? AND a.is_deleted = 0`, [surveyId]);
  return { mode: "CURRENT", items: groupAttachments(rows) };
}

function existingRequest(db, actor, requestKey, targetType, targetId, targetKey, digest) {
  if (!requestKey) return null;
  const row = db.prepare(`
    SELECT v.id, v.uploaded_by, a.target_type, a.target_id, a.target_key, f.sha256
    FROM business_attachment_versions v JOIN business_attachments a ON a.id = v.attachment_id JOIN stored_files f ON f.id = v.file_id
    WHERE v.request_key = ?
  `).get(requestKey);
  if (!row) return null;
  assert(row.uploaded_by === actor.id && row.target_type === targetType && row.target_id === targetId && row.target_key === targetKey && row.sha256 === digest, 409, "ATTACHMENT_REQUEST_CONFLICT", "附件上传请求标识已被其他内容使用");
  const items = groupAttachments(attachmentRows(db, `a.id = (SELECT attachment_id FROM business_attachment_versions WHERE id = ?)`, [row.id]));
  return items[0];
}

export async function uploadAttachment(db, config, actor, input, file) {
  const targetType = cleanKey(input.targetType);
  const targetId = cleanKey(input.targetId);
  const targetKey = targetType === "SURVEY_QUESTION" || targetType === "QUOTE_VERSION" ? cleanKey(input.targetKey) : "";
  const target = requireTargetWrite(db, actor, targetType, targetId, targetKey);
  const uploadedQuote = targetType === "QUOTE_VERSION" && JSON.parse(target.metadata_json || "{}").sourceKind === "UPLOADED";
  if (targetType === "QUOTE_VERSION") assert(targetKey === "" || (uploadedQuote && targetKey === "QUOTE_WORD"), 400, "ATTACHMENT_TARGET_INVALID", "报价文件类型无效");
  if (uploadedQuote && targetKey === "QUOTE_WORD") throw new AppError(415, "QUOTE_WORD_SOURCE_DISABLED", "报价单仅支持上传 PDF");
  const format = await (targetType === "QUOTE_VERSION" ? validateQuoteAttachmentFormat(file, uploadedQuote && targetKey === "" ? ".pdf" : ".docx") : validateAttachmentFormat(file));
  const primaryPdf = uploadedQuote && targetKey === "";
  let desiredAmount = target.final_discount_cents;
  let binding = null;
  if (primaryPdf) {
    if (input.amountCents !== undefined && input.amountCents !== "") {
      desiredAmount = Number(input.amountCents);
      assert(Number.isSafeInteger(desiredAmount) && desiredAmount > 0, 400, "QUOTE_AMOUNT_INVALID", "请填写有效的报价单含税总额");
      assert(String(input.expectedDraftEtag ?? "") !== "", 409, "DRAFT_VERSION_CHANGED", "报价已更新，请重新打开后修改");
    }
    binding = inspectQuoteBinding(format.quotePdfParsed, { customerName: target.full_name, customerShortName: target.short_name, amountCents: desiredAmount });
    requireMatchingQuoteBinding(binding);
    requireFixedQuoteFields(binding.fixedFields);
    requireQuoteBindingReview(binding, input.bindingReviewConfirmed === true || input.bindingReviewConfirmed === "true");
  }
  const digest = sha256(file.buffer);
  const requestKey = cleanKey(input.requestKey, 100) || null;
  const duplicate = existingRequest(db, actor, requestKey, targetType, targetId, targetKey, digest);
  if (duplicate) {
    if (primaryPdf) assert(target.final_discount_cents === desiredAmount, 409, "ATTACHMENT_REQUEST_CONFLICT", "本次上传请求与当前报价金额不一致，请重新选择文件");
    return duplicate;
  }
  if (primaryPdf && input.amountCents !== undefined && input.amountCents !== "")
    assert(Number(input.expectedDraftEtag) === target.draft_etag, 409, "DRAFT_VERSION_CHANGED", "报价已更新，请重新打开后修改");
  const replacingId = cleanKey(input.attachmentId) || null;
  let attachment;
  let revision = 1;
  if (replacingId) {
    attachment = db.prepare(`SELECT * FROM business_attachments WHERE id = ? AND is_deleted = 0`).get(replacingId);
    assert(attachment && attachment.target_type === targetType && attachment.target_id === targetId && attachment.target_key === targetKey && attachment.customer_id === target.customer_id, 404, "ATTACHMENT_NOT_FOUND", "待替换附件不存在或不属于当前业务记录");
    assert(cleanKey(input.expectedCurrentVersionId) && input.expectedCurrentVersionId === attachment.current_version_id, 409, "ATTACHMENT_VERSION_CHANGED", "附件已被他人更新，请刷新后重试");
    revision = db.prepare(`SELECT MAX(revision) AS value FROM business_attachment_versions WHERE attachment_id = ?`).get(replacingId).value + 1;
  }
  const stored = storeManagedBuffer(config, { directory: "attachments", extension: format.extension, buffer: file.buffer });
  const timestamp = nowIso();
  const attachmentId = attachment?.id || randomUUID();
  const versionId = randomUUID();
  const fileId = randomUUID();
  try {
    db.transaction(() => {
      const currentTarget = requireTargetWrite(db, actor, targetType, targetId, targetKey);
      assert(currentTarget.customer_id === target.customer_id, 409, "ATTACHMENT_TARGET_CHANGED", "业务记录已发生变化，请刷新后重试");
      if (primaryPdf) {
        assert(currentTarget.draft_etag === target.draft_etag && currentTarget.final_discount_cents === target.final_discount_cents && currentTarget.full_name === target.full_name && currentTarget.short_name === target.short_name, 409, "DRAFT_VERSION_CHANGED", "报价或客户资料已更新，请重新打开后修改");
        if (desiredAmount !== currentTarget.final_discount_cents) {
          const changedAmount = db.prepare(`UPDATE quote_versions SET subtotal_taxed_cents = ?, final_discount_cents = ?, draft_etag = draft_etag + 1, draft_saved_at = ? WHERE id = ? AND draft_etag = ?`).run(desiredAmount, desiredAmount, timestamp, targetId, target.draft_etag);
          assert(changedAmount.changes === 1, 409, "DRAFT_VERSION_CHANGED", "报价已更新，请重新打开后修改");
          audit(db, { actorId: actor.id, action: "UPLOADED_QUOTE_AMOUNT_UPDATED", entityType: "QUOTE_VERSION", entityId: targetId, summary: { previousAmountCents: currentTarget.final_discount_cents, amountCents: desiredAmount } });
        }
      }
      if (!attachment) {
        if (uploadedQuote) assert(!db.prepare(`SELECT 1 FROM business_attachments WHERE target_type = 'QUOTE_VERSION' AND target_id = ? AND target_key = ? AND is_deleted = 0`).get(targetId, targetKey), 409, "QUOTE_ATTACHMENT_EXISTS", "该类型文件已上传，请使用替换操作");
        db.prepare(`INSERT INTO business_attachments (id, customer_id, target_type, target_id, target_key, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(attachmentId, target.customer_id, targetType, targetId, targetKey, actor.id, timestamp, timestamp);
      }
      db.prepare(`INSERT INTO stored_files (id, entity_type, entity_id, category, original_name, storage_key, mime_type, size_bytes, sha256, uploaded_by, created_at) VALUES (?, 'CUSTOMER', ?, 'BUSINESS_ATTACHMENT', ?, ?, ?, ?, ?, ?, ?)`)
        .run(fileId, target.customer_id, safeDownloadName(file.originalname, `attachment${format.extension}`), stored.storageKey, format.mimeType, stored.sizeBytes, stored.sha256, actor.id, timestamp);
      db.prepare(`INSERT INTO business_attachment_versions (id, attachment_id, revision, file_id, request_key, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(versionId, attachmentId, revision, fileId, requestKey, actor.id, timestamp);
      const changed = db.prepare(`UPDATE business_attachments SET current_version_id = ?, updated_at = ? WHERE id = ? AND (? IS NULL OR current_version_id = ?)`)
        .run(versionId, timestamp, attachmentId, attachment?.current_version_id || null, attachment?.current_version_id || null);
      assert(changed.changes === 1, 409, "ATTACHMENT_VERSION_CHANGED", "附件已被他人更新，请刷新后重试");
      audit(db, { actorId: actor.id, action: attachment ? "ATTACHMENT_VERSION_UPLOADED" : "ATTACHMENT_UPLOADED", entityType: "BUSINESS_ATTACHMENT", entityId: attachmentId, summary: { customerId: target.customer_id, targetType, targetId, targetKey: targetKey || null, versionId, revision, fileId, sizeBytes: stored.sizeBytes, sha256: stored.sha256 } });
    })();
  } catch (error) {
    removeManagedFile(config, stored.storageKey);
    const raced = requestKey && existingRequest(db, actor, requestKey, targetType, targetId, targetKey, digest);
    if (raced) {
      if (primaryPdf) assert(readTarget(db, targetType, targetId, targetKey).final_discount_cents === desiredAmount, 409, "ATTACHMENT_REQUEST_CONFLICT", "本次上传请求与当前报价金额不一致，请重新选择文件");
      return raced;
    }
    throw error;
  }
  const result = groupAttachments(attachmentRows(db, `a.id = ?`, [attachmentId]))[0];
  if (binding) result.bindingCheck = binding;
  return result;
}

export function deleteAttachment(db, actor, attachmentId, input = {}) {
  const row = db.prepare(`SELECT * FROM business_attachments WHERE id = ? AND is_deleted = 0`).get(attachmentId);
  if (!row) throw new AppError(404, "ATTACHMENT_NOT_FOUND", "附件不存在或已删除");
  requireTargetWrite(db, actor, row.target_type, row.target_id, row.target_key);
  const reason = cleanKey(input.reason, 500);
  assert(reason, 400, "ATTACHMENT_DELETE_REASON_REQUIRED", "删除附件必须填写原因");
  const timestamp = nowIso();
  db.transaction(() => {
    const changed = db.prepare(`UPDATE business_attachments SET is_deleted = 1, deleted_by = ?, deleted_at = ?, deletion_reason = ?, updated_at = ? WHERE id = ? AND is_deleted = 0`)
      .run(actor.id, timestamp, reason, timestamp, attachmentId);
    assert(changed.changes === 1, 409, "ATTACHMENT_ALREADY_DELETED", "附件已被删除，请刷新");
    audit(db, { actorId: actor.id, action: "ATTACHMENT_DELETED", entityType: "BUSINESS_ATTACHMENT", entityId: attachmentId, summary: { customerId: row.customer_id, targetType: row.target_type, targetId: row.target_id, targetKey: row.target_key || null, reason } });
  })();
}

function verifiedFile(db, config, fileId) {
  const row = db.prepare(`SELECT id, original_name, storage_key, mime_type, size_bytes, sha256 FROM stored_files WHERE id = ? AND category = 'BUSINESS_ATTACHMENT'`).get(fileId);
  if (!row) throw new AppError(404, "ATTACHMENT_NOT_FOUND", "附件不存在或当前账号无权访问");
  const absolutePath = resolveManagedPath(config, row.storage_key);
  if (!fs.existsSync(absolutePath)) throw new AppError(409, "ATTACHMENT_FILE_MISSING", "附件归档缺失，请联系管理员");
  const buffer = fs.readFileSync(absolutePath);
  assert(buffer.length === row.size_bytes && sha256(buffer) === row.sha256, 409, "ATTACHMENT_FILE_TAMPERED", "附件归档校验失败，禁止下载");
  return { id: row.id, buffer, mimeType: row.mime_type, sizeBytes: row.size_bytes, sha256: row.sha256, downloadName: safeDownloadName(row.original_name, path.basename(absolutePath)) };
}

function getAttachmentFile(db, config, actor, attachmentId, versionId, action) {
  const attachment = db.prepare(`SELECT * FROM business_attachments WHERE id = ? AND is_deleted = 0`).get(attachmentId);
  if (!attachment) throw new AppError(404, "ATTACHMENT_NOT_FOUND", "附件不存在或当前账号无权访问");
  requireTargetRead(db, actor, attachment.target_type, attachment.target_id, attachment.target_key);
  const requested = versionId || attachment.current_version_id;
  const version = db.prepare(`SELECT id, file_id FROM business_attachment_versions WHERE id = ? AND attachment_id = ?`).get(requested, attachmentId);
  if (!version) throw new AppError(404, "ATTACHMENT_NOT_FOUND", "附件版本不存在或当前账号无权访问");
  const file = verifiedFile(db, config, version.file_id);
  audit(db, { actorId: actor.id, action, entityType: "BUSINESS_ATTACHMENT", entityId: attachmentId, summary: { versionId: version.id, fileId: file.id } });
  return file;
}

export function getAttachmentDownload(db, config, actor, attachmentId, versionId = null) {
  return getAttachmentFile(db, config, actor, attachmentId, versionId, "ATTACHMENT_DOWNLOADED");
}

export function getAttachmentPreview(db, config, actor, attachmentId, versionId = null) {
  return getAttachmentFile(db, config, actor, attachmentId, versionId, "ATTACHMENT_PREVIEWED");
}

export function freezeAttachments(db, { snapshotKind, snapshotOwnerId, customerId, targets }) {
  assert(ATTACHMENT_SNAPSHOT_KINDS.includes(snapshotKind), 500, "ATTACHMENT_SNAPSHOT_KIND_INVALID", "附件快照类型无效");
  const conditions = [];
  const values = [];
  for (const target of targets) {
    conditions.push(`(a.target_type = ? AND a.target_id = ?${target.targetKey === undefined ? "" : " AND a.target_key = ?"})`);
    values.push(target.targetType, target.targetId);
    if (target.targetKey !== undefined) values.push(target.targetKey);
  }
  if (!conditions.length) return [];
  const rows = attachmentRows(db, `a.customer_id = ? AND a.is_deleted = 0 AND v.id = a.current_version_id AND (${conditions.join(" OR ")})`, [customerId, ...values]);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO business_attachment_snapshots
      (id, snapshot_kind, snapshot_owner_id, customer_id, attachment_id, attachment_version_id, target_type, target_id, target_key, original_name, mime_type, size_bytes, sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const timestamp = nowIso();
  for (const row of rows) insert.run(randomUUID(), snapshotKind, snapshotOwnerId, customerId, row.id, row.version_id, row.target_type, row.target_id, row.target_key, row.original_name, row.mime_type, row.size_bytes, row.sha256, timestamp);
  return snapshotRows(db, snapshotKind, snapshotOwnerId);
}

export function listAttachmentSnapshot(db, actor, snapshotKind, snapshotOwnerId) {
  assert(ATTACHMENT_SNAPSHOT_KINDS.includes(snapshotKind), 400, "ATTACHMENT_SNAPSHOT_KIND_INVALID", "附件快照类型无效");
  const first = db.prepare(`SELECT target_type, target_id, target_key FROM business_attachment_snapshots WHERE snapshot_kind = ? AND snapshot_owner_id = ? LIMIT 1`).get(snapshotKind, snapshotOwnerId);
  if (!first) {
    if (snapshotKind === "QUOTE_SUBMISSION") requireTargetRead(db, actor, "QUOTE_VERSION", snapshotOwnerId);
    else requireTargetRead(db, actor, "SURVEY", snapshotOwnerId);
    return [];
  }
  const permissionTarget = snapshotKind === "QUOTE_SUBMISSION" ? { type: "QUOTE_VERSION", id: snapshotOwnerId } : { type: "SURVEY", id: snapshotOwnerId };
  requireTargetRead(db, actor, permissionTarget.type, permissionTarget.id);
  return snapshotRows(db, snapshotKind, snapshotOwnerId);
}

function getAttachmentSnapshotFile(db, config, actor, snapshotId, action) {
  const row = db.prepare(`
    SELECT s.*, v.file_id FROM business_attachment_snapshots s
    JOIN business_attachment_versions v ON v.id = s.attachment_version_id
    WHERE s.id = ?
  `).get(snapshotId);
  if (!row) throw new AppError(404, "ATTACHMENT_NOT_FOUND", "附件快照不存在或当前账号无权访问");
  const permissionTarget = row.snapshot_kind === "QUOTE_SUBMISSION" ? { type: "QUOTE_VERSION", id: row.snapshot_owner_id } : { type: "SURVEY", id: row.snapshot_owner_id };
  requireTargetRead(db, actor, permissionTarget.type, permissionTarget.id);
  const file = verifiedFile(db, config, row.file_id);
  assert(file.sizeBytes === row.size_bytes && file.sha256 === row.sha256, 409, "ATTACHMENT_SNAPSHOT_TAMPERED", "附件快照与归档文件不一致，禁止下载");
  audit(db, { actorId: actor.id, action, entityType: "BUSINESS_ATTACHMENT_SNAPSHOT", entityId: snapshotId, summary: { snapshotKind: row.snapshot_kind, snapshotOwnerId: row.snapshot_owner_id, attachmentVersionId: row.attachment_version_id } });
  return file;
}

export function getAttachmentSnapshotDownload(db, config, actor, snapshotId) {
  return getAttachmentSnapshotFile(db, config, actor, snapshotId, "ATTACHMENT_SNAPSHOT_DOWNLOADED");
}

export function getAttachmentSnapshotPreview(db, config, actor, snapshotId) {
  return getAttachmentSnapshotFile(db, config, actor, snapshotId, "ATTACHMENT_SNAPSHOT_PREVIEWED");
}

export function cloneCurrentAttachments(db, { fromTargetType, fromTargetId, toTargetType, toTargetId, customerId, actorId, includeQuestions = false }) {
  const types = includeQuestions ? [fromTargetType, "SURVEY_QUESTION"] : [fromTargetType];
  const placeholders = types.map(() => "?").join(",");
  const rows = attachmentRows(db, `a.customer_id = ? AND a.target_type IN (${placeholders}) AND a.target_id = ? AND a.is_deleted = 0 AND v.id = a.current_version_id`, [customerId, ...types, fromTargetId]);
  const timestamp = nowIso();
  for (const row of rows) {
    const attachmentId = randomUUID();
    const versionId = randomUUID();
    const targetType = row.target_type === fromTargetType ? toTargetType : row.target_type;
    db.prepare(`INSERT INTO business_attachments (id, customer_id, target_type, target_id, target_key, current_version_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(attachmentId, customerId, targetType, toTargetId, row.target_key, versionId, actorId, timestamp, timestamp);
    db.prepare(`INSERT INTO business_attachment_versions (id, attachment_id, revision, file_id, uploaded_by, created_at) VALUES (?, ?, 1, ?, ?, ?)`)
      .run(versionId, attachmentId, row.file_id, actorId, timestamp);
  }
}

export const __test = { readTarget, verifiedFile, snapshotRows };
