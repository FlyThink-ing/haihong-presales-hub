import assert from "node:assert/strict";
import test from "node:test";
import { transferCustomer } from "../server/customer-service.js";
import { completeSurvey, createSurvey, getSurvey, listSurveyRevisions, updateSurvey } from "../server/survey-service.js";
import { addCustomerAndProject, completeSurveyResponse, setupBase } from "./test-utils.js";

test("软件调研按客户权限隔离、使用固定模板版本并保留完成及修改历史", () => {
  const { db, admin, manager, salesA, salesB, salesOther } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "软件调研");
    const templateId = "MES-PRESALES-SURVEY:A/0";
    const created = createSurvey(db, salesA, { templateId, customerId: customer.id, projectId: project.id, title: "虚构软件调研" });
    assert.equal(created.status, "DRAFT");
    assert.equal(created.versionNumber, 1);
    assert.equal(created.template.version, "A/0");
    assert.equal(created.template.schema.modules.length, 6);
    assert.equal(created.template.schema.modules.flatMap(module => module.questions).length, 49);
    assert.equal(created.template.schema.tables.length, 4);
    assert.equal(getSurvey(db, manager, created.id).id, created.id);
    assert.throws(() => getSurvey(db, salesOther, created.id), error => error.code === "CUSTOMER_NOT_FOUND");
    assert.throws(() => completeSurvey(db, salesA, created.id), error => error.code === "SURVEY_INCOMPLETE" && error.details.length > 0);

    const response = completeSurveyResponse(created.template.schema);
    const saved = updateSurvey(db, salesA, created.id, { response });
    assert.equal(saved.revision, 2);
    const completed = completeSurvey(db, salesA, created.id);
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.revision, 3);
    assert.throws(() => updateSurvey(db, salesA, created.id, { response }), error => error.code === "SURVEY_CHANGE_REASON_REQUIRED");
    const reopened = updateSurvey(db, salesA, created.id, { response: { ...response, answers: { ...response.answers, m1: { record: "虚构修订回答", solution: "虚构方案" } } }, reason: "虚构需求变化" });
    assert.notEqual(reopened.id, created.id);
    assert.equal(reopened.status, "DRAFT");
    assert.equal(reopened.versionNumber, 2);
    assert.equal(reopened.previousSurveyId, created.id);
    assert.equal(reopened.revision, 1);
    assert.equal(getSurvey(db, salesA, created.id).status, "COMPLETED");
    assert.equal(getSurvey(db, salesA, created.id).response.answers.m1.record, response.answers.m1.record);
    assert.throws(() => updateSurvey(db, salesA, created.id, { response, reason: "虚构重复分支" }), error => error.code === "SURVEY_VERSION_SUPERSEDED");
    const revisions = listSurveyRevisions(db, manager, created.id);
    assert.deepEqual(revisions.map(item => [item.versionNumber, item.revision]), [[2, 1], [1, 3], [1, 2]]);
    assert.equal(revisions[0].reason, "虚构需求变化");

    transferCustomer(db, manager, customer.id, { newOwnerId: salesB.id, reason: "虚构客户转交" });
    assert.throws(() => updateSurvey(db, salesA, reopened.id, { response }), error => error.code === "SURVEY_WRITE_FORBIDDEN");
    assert.equal(updateSurvey(db, salesB, reopened.id, { response }).revision, 2);
    assert.equal(getSurvey(db, admin, created.id).id, created.id);
  } finally {
    db.close();
  }
});

test("新调研只复用有权读取的同模板已完成内容并保留独立草稿", () => {
  const { db, salesA, salesOther } = setupBase();
  try {
    const templateId = "MES-PRESALES-SURVEY:A/0";
    const sourceTarget = addCustomerAndProject(db, salesA, "复用来源");
    const source = createSurvey(db, salesA, { templateId, customerId: sourceTarget.customer.id, projectId: sourceTarget.project.id, title: "已完成来源调研" });
    const sourceResponse = completeSurveyResponse(source.template.schema);
    updateSurvey(db, salesA, source.id, { response: sourceResponse });
    completeSurvey(db, salesA, source.id);

    const target = addCustomerAndProject(db, salesA, "复用目标");
    const reused = createSurvey(db, salesA, { templateId, customerId: target.customer.id, projectId: target.project.id, title: "复用后的独立调研", reuseFromSurveyId: source.id });
    assert.equal(reused.status, "DRAFT");
    assert.equal(reused.customer.id, target.customer.id);
    assert.deepEqual(reused.response, sourceResponse);
    const summary = JSON.parse(db.prepare(`SELECT summary_json FROM audit_logs WHERE action = 'SURVEY_CREATED' AND entity_id = ?`).get(reused.id).summary_json);
    assert.equal(summary.reusedFromSurveyId, source.id);

    const unfinished = createSurvey(db, salesA, { templateId, customerId: target.customer.id, projectId: target.project.id, title: "未完成来源" });
    assert.throws(() => createSurvey(db, salesA, { templateId, customerId: target.customer.id, projectId: target.project.id, reuseFromSurveyId: unfinished.id }), error => error.code === "SURVEY_REUSE_NOT_COMPLETED");

    const hiddenTarget = addCustomerAndProject(db, salesOther, "无权来源");
    const hidden = createSurvey(db, salesOther, { templateId, customerId: hiddenTarget.customer.id, projectId: hiddenTarget.project.id });
    const hiddenResponse = completeSurveyResponse(hidden.template.schema);
    updateSurvey(db, salesOther, hidden.id, { response: hiddenResponse });
    completeSurvey(db, salesOther, hidden.id);
    assert.throws(() => createSurvey(db, salesA, { templateId, customerId: target.customer.id, projectId: target.project.id, reuseFromSurveyId: hidden.id }), error => error.code === "CUSTOMER_NOT_FOUND");
  } finally {
    db.close();
  }
});
