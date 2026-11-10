import assert from "node:assert/strict";
import test from "node:test";
import { createSurvey, listSurveyTemplates } from "../server/survey-service.js";
import { createSurveyTemplateDraft, getAdminSurveyTemplate, listAdminSurveyTemplates, publishSurveyTemplate, updateSurveyTemplateDraft } from "../server/survey-template-service.js";
import { addCustomerAndProject, setupBase, startTestApi } from "./test-utils.js";

test("管理员可复制、编辑并发布新调研模板，普通角色无维护权限", () => {
  const f = setupBase();
  try {
    assert.throws(() => listAdminSurveyTemplates(f.db, f.salesA), error => error.code === "SURVEY_TEMPLATE_ADMIN_FORBIDDEN");
    const draft = createSurveyTemplateDraft(f.db, f.admin, { code: "WMS-PRESALES-SURVEY", version: "A/0", name: "WMS 项目售前调研", baseTemplateId: "MES-PRESALES-SURVEY:A/0" });
    assert.equal(draft.status, "DRAFT");
    assert.equal(draft.questionCount, 49);
    assert.equal(listSurveyTemplates(f.db).some(item => item.id === draft.id), false);

    const schema = structuredClone(draft.schema);
    schema.modules[0].name = "WMS 项目负责人";
    schema.modules[0].questions[0].prompt = "WMS 建设首先需要解决什么问题？";
    schema.tables[0].name = "仓储设备对接清单";
    const saved = updateSurveyTemplateDraft(f.db, f.admin, draft.id, { code: draft.code, version: draft.version, name: draft.name, schema });
    assert.equal(saved.schema.modules[0].name, "WMS 项目负责人");
    assert.notEqual(saved.sourceSha256, draft.sourceSha256);

    const published = publishSurveyTemplate(f.db, f.admin, draft.id);
    assert.equal(published.status, "PUBLISHED");
    assert.equal(listSurveyTemplates(f.db).some(item => item.id === draft.id), true);
    assert.throws(() => updateSurveyTemplateDraft(f.db, f.admin, draft.id, { code: draft.code, version: draft.version, name: draft.name, schema }), error => error.code === "SURVEY_TEMPLATE_IMMUTABLE");

    const { customer, project } = addCustomerAndProject(f.db, f.salesA, "新模板");
    const survey = createSurvey(f.db, f.salesA, { templateId: draft.id, customerId: customer.id, projectId: project.id, title: "WMS 调研" });
    assert.equal(survey.template.id, draft.id);
    assert.equal(survey.template.schema.modules[0].questions[0].prompt, "WMS 建设首先需要解决什么问题？");
    assert.equal(getAdminSurveyTemplate(f.db, f.admin, draft.id).usageCount, 1);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type = 'SURVEY_TEMPLATE' AND entity_id = ?`).get(draft.id).count, 3);
  } finally {
    f.db.close();
  }
});

test("空白调研模板可保存草稿，但缺少完整问题时禁止发布", () => {
  const f = setupBase();
  try {
    const draft = createSurveyTemplateDraft(f.db, f.admin, { code: "APS-PRESALES-SURVEY", version: "1.0", name: "APS 调研模板" });
    assert.equal(draft.status, "DRAFT");
    assert.equal(draft.moduleCount, 1);
    assert.throws(() => publishSurveyTemplate(f.db, f.admin, draft.id), error => error.code === "SURVEY_TEMPLATE_INCOMPLETE");
    assert.throws(() => createSurveyTemplateDraft(f.db, f.admin, { code: "APS-PRESALES-SURVEY", version: "1.0", name: "重复版本" }), error => error.code === "SURVEY_TEMPLATE_VERSION_EXISTS");
  } finally {
    f.db.close();
  }
});

test("调研模板管理 HTTP 入口只向管理员开放并按草稿发布", async t => {
  const f = setupBase();
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA]);
  t.after(async () => { await api.close(); f.db.close(); });
  assert.equal((await api.request(f.salesA, "/api/admin/survey-templates")).status, 403);
  const created = await api.request(f.admin, "/api/admin/survey-templates", "POST", { code: "QMS-PRESALES-SURVEY", version: "1.0", name: "QMS 项目调研", baseTemplateId: "MES-PRESALES-SURVEY:A/0" });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, "DRAFT");
  assert.equal((await api.request(f.salesA, `/api/admin/survey-templates/${created.body.id}`)).status, 403);
  const published = await api.request(f.admin, `/api/admin/survey-templates/${created.body.id}/publish`, "POST", {});
  assert.equal(published.status, 200);
  assert.equal(published.body.status, "PUBLISHED");
  assert.equal((await api.request(f.salesA, "/api/survey-templates")).body.items.some(item => item.id === created.body.id), true);
});
