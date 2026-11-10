import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { nowIso } from "./database.js";
import { AppError, assert, ROLES } from "./domain.js";

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanTags(value, maxItems = 20) {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map(item => cleanText(item, 100)).filter(Boolean))].slice(0, maxItems);
}

function versionView(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    code: row.code,
    versionNumber: row.version_number,
    title: row.title,
    roles: parseJson(row.roles_json, []),
    stages: parseJson(row.stages_json, []),
    keywords: parseJson(row.keywords_json, []),
    body: row.body_text,
    updateSummary: row.update_summary,
    sourceNote: row.source_note,
    publishedBy: row.published_by ? { id: row.published_by, displayName: row.published_by_name } : null,
    publishedAt: row.published_at,
    current: row.current_version_id === row.id
  };
}

const CURRENT_SELECT = `
  SELECT d.code, d.current_version_id, v.*, u.display_name AS published_by_name
  FROM sop_documents d
  JOIN sop_versions v ON v.id = d.current_version_id
  LEFT JOIN users u ON u.id = v.published_by
`;

function requireAdmin(actor) {
  assert(actor.role === ROLES.ADMIN, 403, "SOP_ADMIN_FORBIDDEN", "仅系统管理员可以维护 SOP 知识库");
}

function readCurrentRow(db, documentId) {
  const row = db.prepare(`${CURRENT_SELECT} WHERE d.id = ?`).get(documentId);
  if (!row) throw new AppError(404, "SOP_DOCUMENT_NOT_FOUND", "SOP 文档不存在");
  return row;
}

function normalizedVersion(input) {
  const value = {
    versionNumber: cleanText(input.versionNumber, 50),
    title: cleanText(input.title, 200),
    roles: cleanTags(input.roles),
    stages: cleanTags(input.stages),
    keywords: cleanTags(input.keywords, 50),
    body: cleanText(input.body, 50_000),
    updateSummary: cleanText(input.updateSummary, 500)
  };
  assert(value.versionNumber, 400, "SOP_VERSION_REQUIRED", "版本号不能为空");
  assert(value.title, 400, "SOP_TITLE_REQUIRED", "标题不能为空");
  assert(value.roles.length > 0, 400, "SOP_ROLES_REQUIRED", "至少选择或填写一个岗位");
  assert(value.stages.length > 0, 400, "SOP_STAGES_REQUIRED", "至少选择或填写一个阶段");
  assert(value.body, 400, "SOP_BODY_REQUIRED", "SOP 正文不能为空");
  assert(value.updateSummary, 400, "SOP_UPDATE_SUMMARY_REQUIRED", "更新说明不能为空");
  return value;
}

export function listSopDocuments(db, _actor, { role = "", stage = "", query = "" } = {}) {
  const roleFilter = cleanText(role, 100);
  const stageFilter = cleanText(stage, 100);
  const queryFilter = cleanText(query, 200).toLocaleLowerCase("zh-CN");
  return db.prepare(`${CURRENT_SELECT} ORDER BY v.published_at DESC, v.title`).all().map(versionView).filter(item => {
    if (roleFilter && !item.roles.includes(roleFilter)) return false;
    if (stageFilter && !item.stages.includes(stageFilter)) return false;
    if (!queryFilter) return true;
    const searchable = [item.title, item.body, ...item.roles, ...item.stages, ...item.keywords].join("\n").toLocaleLowerCase("zh-CN");
    return searchable.includes(queryFilter);
  });
}

export function listSopFilters(db, actor) {
  const items = listSopDocuments(db, actor);
  return {
    roles: [...new Set(items.flatMap(item => item.roles))].sort((a, b) => a.localeCompare(b, "zh-CN")),
    stages: [...new Set(items.flatMap(item => item.stages))].sort((a, b) => a.localeCompare(b, "zh-CN"))
  };
}

export function getSopDocument(db, _actor, documentId) {
  return versionView(readCurrentRow(db, documentId));
}

export function listSopVersions(db, _actor, documentId) {
  readCurrentRow(db, documentId);
  return db.prepare(`
    SELECT d.code, d.current_version_id, v.*, u.display_name AS published_by_name
    FROM sop_versions v
    JOIN sop_documents d ON d.id = v.document_id
    LEFT JOIN users u ON u.id = v.published_by
    WHERE v.document_id = ? ORDER BY v.published_at DESC, v.id DESC
  `).all(documentId).map(versionView);
}

function insertVersion(db, actor, documentId, input, { sourceNote = "管理员发布" } = {}) {
  const value = normalizedVersion(input);
  const duplicate = db.prepare(`SELECT 1 FROM sop_versions WHERE document_id = ? AND version_number = ?`).get(documentId, value.versionNumber);
  assert(!duplicate, 409, "SOP_VERSION_DUPLICATE", "该版本号已存在，历史版本不可覆盖");
  const id = randomUUID();
  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO sop_versions (
        id, document_id, version_number, title, roles_json, stages_json, keywords_json,
        body_text, update_summary, source_note, published_by, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, documentId, value.versionNumber, value.title, JSON.stringify(value.roles), JSON.stringify(value.stages), JSON.stringify(value.keywords), value.body, value.updateSummary, sourceNote, actor.id, timestamp);
    db.prepare(`UPDATE sop_documents SET current_version_id = ? WHERE id = ?`).run(id, documentId);
    audit(db, { actorId: actor.id, action: "SOP_VERSION_PUBLISHED", entityType: "SOP_DOCUMENT", entityId: documentId, summary: { versionId: id, versionNumber: value.versionNumber, updateSummary: value.updateSummary } });
  })();
  return getSopDocument(db, actor, documentId);
}

export function createSopDocument(db, actor, input) {
  requireAdmin(actor);
  const documentId = randomUUID();
  const code = `SOP-${documentId.slice(0, 8).toUpperCase()}`;
  db.prepare(`INSERT INTO sop_documents (id, code, created_by, created_at) VALUES (?, ?, ?, ?)`).run(documentId, code, actor.id, nowIso());
  try {
    return insertVersion(db, actor, documentId, input);
  } catch (error) {
    db.prepare(`DELETE FROM sop_documents WHERE id = ? AND current_version_id IS NULL`).run(documentId);
    throw error;
  }
}

export function publishSopVersion(db, actor, documentId, input) {
  requireAdmin(actor);
  readCurrentRow(db, documentId);
  return insertVersion(db, actor, documentId, input);
}
