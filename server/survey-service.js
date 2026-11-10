import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { nowIso } from "./database.js";
import { AppError, assert, ROLES } from "./domain.js";
import { canReadCustomer, requireCustomerAccess } from "./permissions.js";
import { cloneCurrentAttachments, freezeAttachments, listSurveyAttachments } from "./attachment-service.js";

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function cleanText(value, max = 10_000) {
  return String(value ?? "").trim().slice(0, max);
}

function templateView(row) {
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    name: row.name,
    sourceSha256: row.source_sha256,
    schema: parseJson(row.schema_json, {}),
    active: Boolean(row.is_active)
  };
}

function readTemplate(db, templateId) {
  const row = db.prepare(`SELECT * FROM survey_templates WHERE id = ? AND is_active = 1`).get(templateId);
  if (!row) throw new AppError(404, "SURVEY_TEMPLATE_NOT_FOUND", "调研模板不存在或已停用");
  return templateView(row);
}

function readSurveyRow(db, surveyId) {
  const row = db.prepare(`
    SELECT s.*, c.full_name AS customer_name, c.owner_id, p.name AS project_name,
      u.display_name AS created_by_name, completed.display_name AS completed_by_name,
      t.code AS template_code, t.version AS template_version, t.name AS template_name,
      t.source_sha256, t.schema_json, t.is_active AS template_active
    FROM surveys s
    JOIN customers c ON c.id = s.customer_id
    JOIN projects p ON p.id = s.project_id
    JOIN users u ON u.id = s.created_by
    LEFT JOIN users completed ON completed.id = s.completed_by
    JOIN survey_templates t ON t.id = s.template_id
    WHERE s.id = ?
  `).get(surveyId);
  if (!row) throw new AppError(404, "SURVEY_NOT_FOUND", "调研记录不存在或当前账号无权访问");
  return row;
}

function surveyView(row, { includeTemplate = true } = {}) {
  const value = {
    id: row.id,
    title: row.title,
    status: row.status,
    seriesId: row.series_id,
    versionNumber: row.version_number,
    previousSurveyId: row.previous_survey_id,
    revision: row.revision,
    draftEtag: row.draft_etag,
    draftSavedAt: row.draft_saved_at,
    response: parseJson(row.response_json, { answers: {}, tables: {} }),
    customer: { id: row.customer_id, name: row.customer_name },
    project: { id: row.project_id, name: row.project_name },
    template: { id: row.template_id, code: row.template_code, version: row.template_version, name: row.template_name, sourceSha256: row.source_sha256 },
    createdBy: { id: row.created_by, displayName: row.created_by_name },
    completedBy: row.completed_by ? { id: row.completed_by, displayName: row.completed_by_name } : null,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (includeTemplate) value.template.schema = parseJson(row.schema_json, {});
  return value;
}

function normalizeResponse(schema, input) {
  const source = input && typeof input === "object" ? input : {};
  const sourceAnswers = source.answers && typeof source.answers === "object" ? source.answers : {};
  const sourceTables = source.tables && typeof source.tables === "object" ? source.tables : {};
  const answers = {};
  for (const module of schema.modules || []) {
    for (const question of module.questions || []) {
      const answer = sourceAnswers[question.id];
      answers[question.id] = {
        record: cleanText(answer?.record),
        solution: cleanText(answer?.solution)
      };
    }
  }
  const tables = {};
  for (const table of schema.tables || []) {
    const rows = Array.isArray(sourceTables[table.key]) ? sourceTables[table.key].slice(0, 500) : [];
    tables[table.key] = rows.map(row => Object.fromEntries((table.fields || []).map(field => {
      if (field.type === "number" && row?.[field.key] !== "" && row?.[field.key] !== null && row?.[field.key] !== undefined) {
        return [field.key, Number(row[field.key])];
      }
      return [field.key, cleanText(row?.[field.key], 2_000)];
    })));
  }
  return { answers, tables };
}

export function validateSurveyResponse(schema, response, { requireComplete = false } = {}) {
  const issues = [];
  for (const module of schema.modules || []) {
    for (const question of module.questions || []) {
      if (requireComplete && question.required && !cleanText(response.answers?.[question.id]?.record)) {
        issues.push({ field: `answers.${question.id}.record`, message: `${module.name}：${question.prompt}为必填项` });
      }
    }
  }
  for (const table of schema.tables || []) {
    const rows = Array.isArray(response.tables?.[table.key]) ? response.tables[table.key] : [];
    if (requireComplete && table.requiredAtLeastOne && rows.length === 0) {
      issues.push({ field: `tables.${table.key}`, message: `${table.name}至少需要一行` });
    }
    rows.forEach((row, rowIndex) => {
      for (const field of table.fields || []) {
        const value = row[field.key];
        const blank = value === "" || value === null || value === undefined;
        if (requireComplete && field.required && blank) issues.push({ field: `tables.${table.key}.${rowIndex}.${field.key}`, message: `${table.name}第 ${rowIndex + 1} 行“${field.label}”不能为空` });
        if (!blank && field.type === "number" && (!Number.isSafeInteger(value) || value < 0 || (field.required && value === 0))) {
          issues.push({ field: `tables.${table.key}.${rowIndex}.${field.key}`, message: `${table.name}第 ${rowIndex + 1} 行“${field.label}”必须是有效整数` });
        }
        if (!blank && field.type === "select" && !(field.options || []).includes(value)) {
          issues.push({ field: `tables.${table.key}.${rowIndex}.${field.key}`, message: `${table.name}第 ${rowIndex + 1} 行“${field.label}”选项无效` });
        }
      }
    });
  }
  return issues;
}

function requireSurveyWrite(db, actor, row) {
  assert(actor.role === ROLES.ADMIN || (actor.role === ROLES.PRESALES && row.owner_id === actor.id), 403, "SURVEY_WRITE_FORBIDDEN", "仅客户当前负责人可以修改调研记录");
}

export function listSurveyTemplates(db) {
  return db.prepare(`SELECT * FROM survey_templates WHERE is_active = 1 ORDER BY code, version`).all().map(templateView);
}

export function listSurveys(db, actor) {
  return db.prepare(`
    SELECT s.*, c.full_name AS customer_name, c.owner_id, p.name AS project_name,
      u.display_name AS created_by_name, completed.display_name AS completed_by_name,
      t.code AS template_code, t.version AS template_version, t.name AS template_name,
      t.source_sha256, t.schema_json, t.is_active AS template_active
    FROM surveys s
    JOIN customers c ON c.id = s.customer_id
    JOIN projects p ON p.id = s.project_id
    JOIN users u ON u.id = s.created_by
    LEFT JOIN users completed ON completed.id = s.completed_by
    JOIN survey_templates t ON t.id = s.template_id
    ORDER BY s.updated_at DESC
  `).all().filter(row => canReadCustomer(db, actor, row.customer_id)).map(row => surveyView(row, { includeTemplate: false }));
}

export function getSurvey(db, actor, surveyId) {
  const row = readSurveyRow(db, surveyId);
  requireCustomerAccess(db, actor, row.customer_id);
  return { ...surveyView(row), attachments: listSurveyAttachments(db, actor, surveyId) };
}

export function createSurvey(db, actor, input) {
  assert(actor.role === ROLES.PRESALES || actor.role === ROLES.ADMIN, 403, "SURVEY_CREATE_FORBIDDEN", "仅售前人员可以创建软件调研");
  requireCustomerAccess(db, actor, input.customerId);
  const customer = db.prepare(`SELECT full_name, owner_id FROM customers WHERE id = ?`).get(input.customerId);
  assert(actor.role === ROLES.ADMIN || customer.owner_id === actor.id, 403, "SURVEY_CREATE_FORBIDDEN", "仅客户当前负责人可以创建软件调研");
  const project = db.prepare(`SELECT id, name FROM projects WHERE id = ? AND customer_id = ? AND is_active = 1`).get(input.projectId, input.customerId);
  assert(project, 400, "PROJECT_INVALID", "项目与客户不匹配或已停用");
  const template = readTemplate(db, input.templateId);
  const reuseFromSurveyId = cleanText(input.reuseFromSurveyId, 100);
  let responseSource = input.response;
  if (reuseFromSurveyId) {
    const source = readSurveyRow(db, reuseFromSurveyId);
    requireCustomerAccess(db, actor, source.customer_id);
    assert(source.status === "COMPLETED", 409, "SURVEY_REUSE_NOT_COMPLETED", "只能复用已完成确认的调研报告");
    assert(source.template_id === template.id, 409, "SURVEY_REUSE_TEMPLATE_MISMATCH", "只能复用相同模板版本的调研报告");
    responseSource = parseJson(source.response_json, {});
  }
  const response = normalizeResponse(template.schema, responseSource);
  const issues = validateSurveyResponse(template.schema, response);
  assert(issues.length === 0, 422, "SURVEY_RESPONSE_INVALID", "调研草稿包含无效内容", issues);
  const id = randomUUID();
  const timestamp = nowIso();
  const title = cleanText(input.title, 200) || `${customer.full_name} - ${project.name} 软件调研`;
  db.prepare(`
    INSERT INTO surveys (id, series_id, version_number, template_id, customer_id, project_id, title, status, response_json, revision, created_by, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, 'DRAFT', ?, 1, ?, ?, ?)
  `).run(id, id, template.id, input.customerId, input.projectId, title, JSON.stringify(response), actor.id, timestamp, timestamp);
  audit(db, { actorId: actor.id, action: "SURVEY_CREATED", entityType: "SURVEY", entityId: id, summary: { customerId: input.customerId, projectId: input.projectId, templateVersion: template.version, ...(reuseFromSurveyId ? { reusedFromSurveyId: reuseFromSurveyId } : {}) } });
  return getSurvey(db, actor, id);
}

export function updateSurvey(db, actor, surveyId, input) {
  const row = readSurveyRow(db, surveyId);
  requireSurveyWrite(db, actor, row);
  if (input.expectedDraftEtag !== undefined) {
    assert(Number.isSafeInteger(input.expectedDraftEtag) && input.expectedDraftEtag >= 0, 400, "DRAFT_ETAG_INVALID", "草稿版本标识无效");
    assert(input.expectedDraftEtag === row.draft_etag, 409, "DRAFT_VERSION_CHANGED", "草稿已在其他页面更新，请重新打开后继续编辑");
  }
  const schema = parseJson(row.schema_json, {});
  const response = normalizeResponse(schema, input.response);
  const issues = validateSurveyResponse(schema, response);
  assert(issues.length === 0, 422, "SURVEY_RESPONSE_INVALID", "调研草稿包含无效内容", issues);
  const reason = cleanText(input.reason, 500);
  if (row.status === "COMPLETED") assert(reason, 400, "SURVEY_CHANGE_REASON_REQUIRED", "修改已完成调研必须填写原因");
  const timestamp = nowIso();
  const before = { status: row.status, response: parseJson(row.response_json, {}) };
  const after = { status: "DRAFT", response };
  if (row.status === "COMPLETED") {
    const latestVersion = db.prepare(`SELECT MAX(version_number) AS value FROM surveys WHERE series_id = ?`).get(row.series_id).value;
    assert(row.version_number === latestVersion, 409, "SURVEY_VERSION_SUPERSEDED", "该确认版本已有后续版本，请继续填写最新版本");
    const nextId = randomUUID();
    const nextVersion = row.version_number + 1;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO surveys (
          id, series_id, version_number, previous_survey_id, template_id, customer_id, project_id,
          title, status, response_json, revision, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, 1, ?, ?, ?)
      `).run(nextId, row.series_id, nextVersion, row.id, row.template_id, row.customer_id, row.project_id, cleanText(input.title, 200) || row.title, JSON.stringify(response), actor.id, timestamp, timestamp);
      db.prepare(`INSERT INTO survey_revisions (id, survey_id, revision, before_json, after_json, changed_by, reason, changed_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), nextId, JSON.stringify(before), JSON.stringify(after), actor.id, reason, timestamp);
      cloneCurrentAttachments(db, { fromTargetType: "SURVEY", fromTargetId: row.id, toTargetType: "SURVEY", toTargetId: nextId, customerId: row.customer_id, actorId: actor.id, includeQuestions: true });
      audit(db, { actorId: actor.id, action: "SURVEY_VERSION_CREATED", entityType: "SURVEY", entityId: nextId, summary: { seriesId: row.series_id, previousSurveyId: row.id, versionNumber: nextVersion, reason } });
    })();
    return getSurvey(db, actor, nextId);
  }
  const title = cleanText(input.title, 200) || row.title;
  const responseJson = JSON.stringify(response);
  if (title === row.title && responseJson === row.response_json) return getSurvey(db, actor, surveyId);
  const revision = row.revision + 1;
  const nextDraftEtag = row.draft_etag + 1;
  const automatic = input.saveMode === "AUTO";
  db.transaction(() => {
    const result = db.prepare(`UPDATE surveys SET title = ?, status = 'DRAFT', response_json = ?, revision = ?, draft_etag = ?, draft_saved_at = ?, completed_by = NULL, completed_at = NULL, updated_at = ? WHERE id = ? AND draft_etag = ?`)
      .run(title, responseJson, automatic ? row.revision : revision, nextDraftEtag, timestamp, timestamp, surveyId, row.draft_etag);
    assert(result.changes === 1, 409, "DRAFT_VERSION_CHANGED", "草稿已在其他页面更新，请重新打开后继续编辑");
    if (automatic) return;
    db.prepare(`INSERT INTO survey_revisions (id, survey_id, revision, before_json, after_json, changed_by, reason, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), surveyId, revision, JSON.stringify(before), JSON.stringify(after), actor.id, reason || "保存草稿", timestamp);
    audit(db, { actorId: actor.id, action: "SURVEY_UPDATED", entityType: "SURVEY", entityId: surveyId, summary: { revision, previousStatus: row.status, reason: reason || "保存草稿" } });
  })();
  return getSurvey(db, actor, surveyId);
}

export function completeSurvey(db, actor, surveyId) {
  const row = readSurveyRow(db, surveyId);
  requireSurveyWrite(db, actor, row);
  assert(row.status === "DRAFT", 409, "SURVEY_NOT_DRAFT", "只有草稿调研可以完成确认");
  const schema = parseJson(row.schema_json, {});
  const response = normalizeResponse(schema, parseJson(row.response_json, {}));
  const issues = validateSurveyResponse(schema, response, { requireComplete: true });
  assert(issues.length === 0, 422, "SURVEY_INCOMPLETE", "调研仍有必填项未完成", issues);
  const revision = row.revision + 1;
  const timestamp = nowIso();
  db.transaction(() => {
    const attachments = freezeAttachments(db, { snapshotKind: "SURVEY_COMPLETION", snapshotOwnerId: surveyId, customerId: row.customer_id, targets: [{ targetType: "SURVEY", targetId: surveyId }, { targetType: "SURVEY_QUESTION", targetId: surveyId }] });
    db.prepare(`UPDATE surveys SET status = 'COMPLETED', revision = ?, completed_by = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
      .run(revision, actor.id, timestamp, timestamp, surveyId);
    db.prepare(`INSERT INTO survey_revisions (id, survey_id, revision, before_json, after_json, changed_by, reason, changed_at) VALUES (?, ?, ?, ?, ?, ?, '完成确认', ?)`)
      .run(randomUUID(), surveyId, revision, JSON.stringify({ status: "DRAFT", response }), JSON.stringify({ status: "COMPLETED", response }), actor.id, timestamp);
    audit(db, { actorId: actor.id, action: "SURVEY_COMPLETED", entityType: "SURVEY", entityId: surveyId, summary: { revision, templateVersion: row.template_version, attachmentCount: attachments.length } });
  })();
  return getSurvey(db, actor, surveyId);
}

export function listSurveyRevisions(db, actor, surveyId) {
  const row = readSurveyRow(db, surveyId);
  requireCustomerAccess(db, actor, row.customer_id);
  return db.prepare(`
    SELECT r.*, s.version_number, s.status AS survey_status, u.display_name AS changed_by_name
    FROM survey_revisions r
    JOIN surveys s ON s.id = r.survey_id
    JOIN users u ON u.id = r.changed_by
    WHERE s.series_id = ? ORDER BY s.version_number DESC, r.revision DESC
  `).all(row.series_id).map(item => ({ id: item.id, surveyId: item.survey_id, versionNumber: item.version_number, revision: item.revision, surveyStatus: item.survey_status, before: parseJson(item.before_json, {}), after: parseJson(item.after_json, {}), changedBy: { id: item.changed_by, displayName: item.changed_by_name }, reason: item.reason, changedAt: item.changed_at }));
}
