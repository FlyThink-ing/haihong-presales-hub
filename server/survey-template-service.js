import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { nowIso } from "./database.js";
import { AppError, assert, ROLES } from "./domain.js";
import { sha256 } from "./security.js";

const FIELD_TYPES = new Set(["text", "number", "select"]);
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

function cleanText(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function requireAdmin(actor) {
  assert(actor?.role === ROLES.ADMIN, 403, "SURVEY_TEMPLATE_ADMIN_FORBIDDEN", "仅系统管理员可以维护调研模板");
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function uniqueKey(value, prefix) {
  const cleaned = cleanText(value, 100);
  return cleaned || `${prefix}-${randomUUID()}`;
}

function ensureUniqueKeys(items, label) {
  const keys = new Set();
  for (const item of items) {
    assert(KEY_PATTERN.test(item.key), 422, "SURVEY_TEMPLATE_SCHEMA_INVALID", `${label}标识无效`);
    assert(!keys.has(item.key), 422, "SURVEY_TEMPLATE_SCHEMA_INVALID", `${label}标识不能重复：${item.key}`);
    keys.add(item.key);
  }
}

function normalizeSchema(input, { strict = false } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const modules = (Array.isArray(source.modules) ? source.modules : []).slice(0, 30).map(module => ({
    key: uniqueKey(module?.key, "module"),
    name: cleanText(module?.name, 120),
    description: cleanText(module?.description, 1_000),
    questions: (Array.isArray(module?.questions) ? module.questions : []).slice(0, 200).map(question => ({
      id: uniqueKey(question?.id, "question"),
      prompt: cleanText(question?.prompt, 2_000),
      help: cleanText(question?.help, 2_000),
      required: Boolean(question?.required)
    }))
  }));
  const tables = (Array.isArray(source.tables) ? source.tables : []).slice(0, 20).map(table => ({
    key: uniqueKey(table?.key, "table"),
    name: cleanText(table?.name, 120),
    requiredAtLeastOne: Boolean(table?.requiredAtLeastOne),
    fields: (Array.isArray(table?.fields) ? table.fields : []).slice(0, 40).map(field => {
      const type = cleanText(field?.type, 20);
      return {
        key: uniqueKey(field?.key, "field"),
        label: cleanText(field?.label, 120),
        type: FIELD_TYPES.has(type) ? type : "text",
        required: Boolean(field?.required),
        ...(type === "select" ? { options: [...new Set((Array.isArray(field?.options) ? field.options : []).map(option => cleanText(option, 120)).filter(Boolean))].slice(0, 50) } : {})
      };
    })
  }));

  ensureUniqueKeys(modules, "模块");
  ensureUniqueKeys(modules.flatMap(module => module.questions.map(question => ({ key: question.id }))), "问题");
  ensureUniqueKeys(tables, "专项清单");
  for (const table of tables) ensureUniqueKeys(table.fields, `${table.name || "专项清单"}字段`);
  assert(modules.reduce((sum, module) => sum + module.questions.length, 0) <= 500, 422, "SURVEY_TEMPLATE_SCHEMA_INVALID", "单个模板最多允许 500 个问题");

  if (strict) {
    assert(modules.length > 0, 422, "SURVEY_TEMPLATE_INCOMPLETE", "发布前至少需要一个问题模块");
    for (const [moduleIndex, module] of modules.entries()) {
      assert(module.name, 422, "SURVEY_TEMPLATE_INCOMPLETE", `第 ${moduleIndex + 1} 个模块名称不能为空`);
      assert(module.questions.length > 0, 422, "SURVEY_TEMPLATE_INCOMPLETE", `“${module.name}”至少需要一个问题`);
      for (const [questionIndex, question] of module.questions.entries()) assert(question.prompt, 422, "SURVEY_TEMPLATE_INCOMPLETE", `“${module.name}”第 ${questionIndex + 1} 个问题不能为空`);
    }
    for (const [tableIndex, table] of tables.entries()) {
      assert(table.name, 422, "SURVEY_TEMPLATE_INCOMPLETE", `第 ${tableIndex + 1} 张专项清单名称不能为空`);
      assert(table.fields.length > 0, 422, "SURVEY_TEMPLATE_INCOMPLETE", `“${table.name}”至少需要一个字段`);
      for (const [fieldIndex, field] of table.fields.entries()) {
        assert(field.label, 422, "SURVEY_TEMPLATE_INCOMPLETE", `“${table.name}”第 ${fieldIndex + 1} 个字段名称不能为空`);
        if (field.type === "select") assert(field.options.length > 0, 422, "SURVEY_TEMPLATE_INCOMPLETE", `“${table.name}”字段“${field.label}”至少需要一个选项`);
      }
    }
  }
  return { modules, tables };
}

function normalizedMetadata(input) {
  const code = cleanText(input?.code, 60).toUpperCase();
  const version = cleanText(input?.version, 30);
  const name = cleanText(input?.name, 160);
  assert(/^[A-Z0-9][A-Z0-9._-]{1,59}$/.test(code), 422, "SURVEY_TEMPLATE_CODE_INVALID", "模板编码只能使用大写字母、数字、点、横线或下划线");
  assert(version && /^[A-Za-z0-9._/-]{1,30}$/.test(version), 422, "SURVEY_TEMPLATE_VERSION_INVALID", "版本号只能使用字母、数字、点、横线、下划线或斜线");
  assert(name, 422, "SURVEY_TEMPLATE_NAME_REQUIRED", "模板名称不能为空");
  return { code, version, name };
}

function buildStoredSchema(metadata, content) {
  const base = { ...metadata, ...content };
  const sourceSha256 = sha256(Buffer.from(JSON.stringify(base), "utf8"));
  return { ...base, sourceSha256 };
}

function templateView(row) {
  const schema = parseJson(row.schema_json, { modules: [], tables: [] });
  const questionCount = (schema.modules || []).reduce((sum, module) => sum + (module.questions || []).length, 0);
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    name: row.name,
    sourceSha256: row.source_sha256,
    status: row.is_active ? "PUBLISHED" : "DRAFT",
    active: Boolean(row.is_active),
    usageCount: Number(row.usage_count || 0),
    moduleCount: (schema.modules || []).length,
    questionCount,
    tableCount: (schema.tables || []).length,
    schema,
    createdAt: row.created_at
  };
}

function readAdminTemplate(db, actor, templateId) {
  requireAdmin(actor);
  const row = db.prepare(`
    SELECT t.*, COUNT(s.id) AS usage_count
    FROM survey_templates t LEFT JOIN surveys s ON s.template_id = t.id
    WHERE t.id = ? GROUP BY t.id
  `).get(templateId);
  if (!row) throw new AppError(404, "SURVEY_TEMPLATE_NOT_FOUND", "调研模板不存在");
  return row;
}

export function listAdminSurveyTemplates(db, actor) {
  requireAdmin(actor);
  return db.prepare(`
    SELECT t.*, COUNT(s.id) AS usage_count
    FROM survey_templates t LEFT JOIN surveys s ON s.template_id = t.id
    GROUP BY t.id ORDER BY t.created_at DESC, t.code, t.version
  `).all().map(templateView);
}

export function getAdminSurveyTemplate(db, actor, templateId) {
  return templateView(readAdminTemplate(db, actor, templateId));
}

export function createSurveyTemplateDraft(db, actor, input) {
  requireAdmin(actor);
  const metadata = normalizedMetadata(input);
  assert(!db.prepare(`SELECT 1 FROM survey_templates WHERE code = ? AND version = ?`).get(metadata.code, metadata.version), 409, "SURVEY_TEMPLATE_VERSION_EXISTS", "相同编码和版本的调研模板已经存在");
  let content;
  if (cleanText(input?.baseTemplateId, 100)) {
    const base = readAdminTemplate(db, actor, cleanText(input.baseTemplateId, 100));
    const schema = parseJson(base.schema_json, {});
    content = normalizeSchema(schema);
  } else {
    content = normalizeSchema({ modules: [{ key: `module-${randomUUID()}`, name: "基础信息", description: "", questions: [{ id: `question-${randomUUID()}`, prompt: "", help: "", required: true }] }], tables: [] });
  }
  const schema = buildStoredSchema(metadata, content);
  const id = randomUUID();
  const createdAt = nowIso();
  db.prepare(`INSERT INTO survey_templates (id, code, version, name, source_sha256, schema_json, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(id, metadata.code, metadata.version, metadata.name, schema.sourceSha256, JSON.stringify(schema), createdAt);
  audit(db, { actorId: actor.id, action: "SURVEY_TEMPLATE_DRAFT_CREATED", entityType: "SURVEY_TEMPLATE", entityId: id, summary: { code: metadata.code, version: metadata.version, baseTemplateId: cleanText(input?.baseTemplateId, 100) || null } });
  return getAdminSurveyTemplate(db, actor, id);
}

export function updateSurveyTemplateDraft(db, actor, templateId, input) {
  const row = readAdminTemplate(db, actor, templateId);
  assert(!row.is_active && Number(row.usage_count) === 0, 409, "SURVEY_TEMPLATE_IMMUTABLE", "已发布或已被使用的调研模板不能直接修改，请复制为新版本");
  const metadata = normalizedMetadata(input);
  const duplicate = db.prepare(`SELECT id FROM survey_templates WHERE code = ? AND version = ? AND id <> ?`).get(metadata.code, metadata.version, templateId);
  assert(!duplicate, 409, "SURVEY_TEMPLATE_VERSION_EXISTS", "相同编码和版本的调研模板已经存在");
  const content = normalizeSchema(input?.schema);
  const schema = buildStoredSchema(metadata, content);
  db.prepare(`UPDATE survey_templates SET code = ?, version = ?, name = ?, source_sha256 = ?, schema_json = ? WHERE id = ?`)
    .run(metadata.code, metadata.version, metadata.name, schema.sourceSha256, JSON.stringify(schema), templateId);
  audit(db, { actorId: actor.id, action: "SURVEY_TEMPLATE_DRAFT_UPDATED", entityType: "SURVEY_TEMPLATE", entityId: templateId, summary: { code: metadata.code, version: metadata.version, moduleCount: content.modules.length, questionCount: content.modules.reduce((sum, module) => sum + module.questions.length, 0), tableCount: content.tables.length } });
  return getAdminSurveyTemplate(db, actor, templateId);
}

export function publishSurveyTemplate(db, actor, templateId) {
  const row = readAdminTemplate(db, actor, templateId);
  assert(!row.is_active && Number(row.usage_count) === 0, 409, "SURVEY_TEMPLATE_IMMUTABLE", "该模板已发布或已被使用");
  const metadata = { code: row.code, version: row.version, name: row.name };
  const content = normalizeSchema(parseJson(row.schema_json, {}), { strict: true });
  const schema = buildStoredSchema(metadata, content);
  db.prepare(`UPDATE survey_templates SET source_sha256 = ?, schema_json = ?, is_active = 1 WHERE id = ?`).run(schema.sourceSha256, JSON.stringify(schema), templateId);
  audit(db, { actorId: actor.id, action: "SURVEY_TEMPLATE_PUBLISHED", entityType: "SURVEY_TEMPLATE", entityId: templateId, summary: { code: row.code, version: row.version, sourceSha256: schema.sourceSha256 } });
  return getAdminSurveyTemplate(db, actor, templateId);
}

export const __test = { normalizeSchema, normalizedMetadata };
