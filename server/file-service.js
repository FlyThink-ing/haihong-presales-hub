import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { nowIso } from "./database.js";
import { AppError, assert, ROLES } from "./domain.js";
import { canReadAllCustomersAndQuotes, canReadCustomer, canReadImportJob } from "./permissions.js";
import { sha256 } from "./security.js";

export const FILE_LIMITS = Object.freeze({
  SOURCE_XLSX: 8 * 1024 * 1024,
  FOLLOWUPS_DOCX: 20 * 1024 * 1024,
  SURVEY_REPORT_DOCX: 20 * 1024 * 1024,
  APPROVED_QUOTE_DOCX: 20 * 1024 * 1024,
  CONTRACT_TEMPLATE_DOCX: 20 * 1024 * 1024,
  CONTRACT_EDITED_DOCX: 20 * 1024 * 1024,
  CONTRACT_SIGNED_FILE: 20 * 1024 * 1024
});

const CATEGORY_FORMATS = Object.freeze({
  SOURCE_XLSX: { extension: ".xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  FOLLOWUPS_DOCX: { extension: ".docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  SURVEY_REPORT_DOCX: { extension: ".docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  APPROVED_QUOTE_DOCX: { extension: ".docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  CONTRACT_TEMPLATE_DOCX: { extension: ".docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  CONTRACT_EDITED_DOCX: { extension: ".docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  CONTRACT_SIGNED_FILE: {
    formats: [
      { extension: ".docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      { extension: ".pdf", mimeType: "application/pdf" }
    ]
  }
});

function hasZipSignature(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2]);
}

function hasPdfSignature(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

export function validateUploadedFile(file, category) {
  const rule = CATEGORY_FORMATS[category];
  assert(rule, 400, "FILE_CATEGORY_INVALID", "文件类别无效");
  assert(file?.buffer && Buffer.isBuffer(file.buffer), 400, "FILE_REQUIRED", "请选择上传文件");
  assert(file.buffer.length > 0 && file.buffer.length <= FILE_LIMITS[category], 413, "FILE_SIZE_INVALID", `文件大小必须在 1 字节至 ${Math.floor(FILE_LIMITS[category] / 1024 / 1024)} MB 之间`);
  const extension = path.extname(String(file.originalname || "")).toLowerCase();
  const formats = rule.formats || [rule];
  const format = formats.find(item => item.extension === extension);
  assert(format, 415, "FILE_EXTENSION_INVALID", `只允许上传 ${formats.map(item => item.extension).join(" 或 ")} 文件`);
  if (format.extension === ".pdf") assert(hasPdfSignature(file.buffer), 415, "FILE_SIGNATURE_INVALID", "文件内容与 PDF 格式不匹配");
  else assert(hasZipSignature(file.buffer), 415, "FILE_SIGNATURE_INVALID", "文件内容与 Office Open XML 格式不匹配");
  const acceptedTypes = [format.mimeType, "application/octet-stream", "application/zip", ""];
  assert(acceptedTypes.includes(String(file.mimetype || "").toLowerCase()), 415, "FILE_MIME_INVALID", "文件 MIME 类型无效");
  return format;
}

export function safeDownloadName(value, fallback) {
  const raw = String(value || "");
  let normalized = raw;
  if (raw) {
    const decoded = Buffer.from(raw, "latin1").toString("utf8");
    if (!decoded.includes("\uFFFD") && Buffer.from(decoded, "utf8").toString("latin1") === raw) normalized = decoded;
  }
  const cleaned = normalized.replace(/[\r\n\\/:*?"<>|]/g, "_").trim().slice(0, 180);
  return cleaned || fallback;
}

export function storeManagedBuffer(config, { directory, extension, buffer }) {
  assert(Buffer.isBuffer(buffer) && buffer.length > 0, 500, "MANAGED_FILE_INVALID", "待归档文件为空");
  const storageKey = path.posix.join(directory, `${randomUUID()}${extension}`);
  const absolutePath = path.join(config.storagePath, ...storageKey.split("/"));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, buffer, { flag: "wx" });
  return { storageKey, absolutePath, sha256: sha256(buffer), sizeBytes: buffer.length };
}

export function resolveManagedPath(config, storageKey) {
  const absolutePath = path.resolve(config.storagePath, ...String(storageKey || "").split("/"));
  const storageRoot = path.resolve(config.storagePath);
  assert(absolutePath.startsWith(`${storageRoot}${path.sep}`), 500, "FILE_STORAGE_INVALID", "文件存储路径无效");
  return absolutePath;
}

export function removeManagedFile(config, storageKey) {
  const absolutePath = resolveManagedPath(config, storageKey);
  fs.rmSync(absolutePath, { force: true });
}

export function storeFile(db, config, actor, { entityType, entityId, category, originalName, mimeType, buffer, validateUpload = false }) {
  const rule = CATEGORY_FORMATS[category];
  assert(rule && !rule.formats, 400, "FILE_CATEGORY_INVALID", "文件类别无效");
  let format;
  if (validateUpload) {
    format = validateUploadedFile({ originalname: originalName, mimetype: mimeType, buffer }, category);
  } else {
    format = rule;
    assert(Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= FILE_LIMITS[category], 500, "GENERATED_FILE_INVALID", "生成文件为空或超出大小限制");
  }
  const id = randomUUID();
  const storageKey = path.posix.join("files", `${randomUUID()}${format.extension}`);
  const absolutePath = path.join(config.storagePath, ...storageKey.split("/"));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, buffer, { flag: "wx" });
  try {
    db.prepare(`
      INSERT INTO stored_files (id, entity_type, entity_id, category, original_name, storage_key, mime_type, size_bytes, sha256, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, entityType, entityId, category, safeDownloadName(originalName, `file${format.extension}`), storageKey, format.mimeType, buffer.length, sha256(buffer), actor.id, nowIso());
    audit(db, { actorId: actor.id, action: validateUpload ? "FILE_UPLOADED" : "FILE_GENERATED", entityType: "STORED_FILE", entityId: id, summary: { entityType, entityId, category, sizeBytes: buffer.length, sha256: sha256(buffer) } });
  } catch (error) {
    fs.rmSync(absolutePath, { force: true });
    throw error;
  }
  return getFileMetadata(db, id);
}

export function getFileMetadata(db, fileId) {
  const row = db.prepare(`SELECT * FROM stored_files WHERE id = ?`).get(fileId);
  if (!row) throw new AppError(404, "FILE_NOT_FOUND", "文件不存在或当前账号无权下载");
  return { id: row.id, entityType: row.entity_type, entityId: row.entity_id, category: row.category, originalName: row.original_name, storageKey: row.storage_key, mimeType: row.mime_type, sizeBytes: row.size_bytes, sha256: row.sha256, uploadedBy: row.uploaded_by, createdAt: row.created_at };
}

function canDownload(db, actor, file) {
  // 通用业务附件必须经过关联/软删除/快照校验入口，不能用底层文件 ID 绕过。
  if (file.category === "BUSINESS_ATTACHMENT") return false;
  if (actor.role === ROLES.ADMIN) return true;
  if (file.entityType === "CUSTOMER") return canReadCustomer(db, actor, file.entityId);
  if (file.entityType === "IMPORT_JOB") {
    const visits = db.prepare(`
      SELECT COUNT(*) AS total, COUNT(o.source_key) AS bound
      FROM visit_import_entries e LEFT JOIN visit_import_origins o ON o.source_key = e.source_key
      WHERE e.job_id = ?
    `).get(file.entityId);
    // 行尚未逐一绑定客户时，整份原文件可能包含其他负责人的来源，普通账号不得下载。
    if (visits.total > 0 && visits.bound !== visits.total) return false;
    const weekly = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM weekly_report_decisions d WHERE d.source_key = e.source_key AND d.customer_id IS NOT NULL
        ) THEN 1 ELSE 0 END) AS linked
      FROM weekly_report_entries e WHERE e.job_id = ?
    `).get(file.entityId);
    // 周报含不规则跨客户来源；存在任何未逐行关联客户的内容时，非管理员不能下载整份文件。
    if (weekly.total > 0 && Number(weekly.linked || 0) !== weekly.total) return false;
    return canReadImportJob(db, actor, file.entityId);
  }
  if (file.entityType === "SURVEY") {
    const row = db.prepare(`SELECT customer_id FROM surveys WHERE id = ?`).get(file.entityId);
    return Boolean(row && canReadCustomer(db, actor, row.customer_id));
  }
  if (file.entityType === "QUOTE_VERSION") {
    const row = db.prepare(`
      SELECT q.customer_id
      FROM quote_versions qv JOIN quotes q ON q.id = qv.quote_id
      WHERE qv.id = ?
    `).get(file.entityId);
    return Boolean(row && (canReadAllCustomersAndQuotes(actor) || canReadCustomer(db, actor, row.customer_id)));
  }
  return false;
}

export function getFileForDownload(db, config, actor, fileId) {
  const file = getFileMetadata(db, fileId);
  if (!canDownload(db, actor, file)) throw new AppError(404, "FILE_NOT_FOUND", "文件不存在或当前账号无权下载");
  const absolutePath = resolveManagedPath(config, file.storageKey);
  if (!fs.existsSync(absolutePath)) throw new AppError(404, "FILE_MISSING", "文件归档缺失，请联系管理员");
  audit(db, { actorId: actor.id, action: "FILE_DOWNLOADED", entityType: "STORED_FILE", entityId: file.id, summary: { entityType: file.entityType, entityId: file.entityId, category: file.category } });
  return { ...file, absolutePath, downloadName: safeDownloadName(file.originalName, path.basename(absolutePath)) };
}

export function listQuoteVersionFiles(db, actor, versionId) {
  return db.prepare(`SELECT id FROM stored_files WHERE entity_type = 'QUOTE_VERSION' AND entity_id = ? AND category = 'APPROVED_QUOTE_DOCX' ORDER BY created_at DESC, rowid DESC`)
    .all(versionId)
    .map(row => getFileMetadata(db, row.id))
    .filter(file => canDownload(db, actor, file))
    .map(({ id, originalName, sizeBytes, createdAt }) => ({ id, originalName, sizeBytes, createdAt }));
}
