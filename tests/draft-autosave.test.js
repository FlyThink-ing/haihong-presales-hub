import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createContractDraft, updateContractDraft } from "../server/contract-service.js";
import { nowIso } from "../server/database.js";
import { createQuote, decideQuote, submitQuote, updateQuoteDraft } from "../server/quote-service.js";
import { createSurvey, updateSurvey } from "../server/survey-service.js";
import { createDraftAutosave } from "../web/draft-autosave.js";
import { addCustomerAndProject, sampleQuoteInput, setupBase } from "./test-utils.js";

function auditCount(db, action, entityId) {
  return db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = ? AND entity_id = ?`).get(action, entityId).count;
}

test("调研自动保存使用独立版本令牌且不制造业务修订历史", () => {
  const { db, salesA } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "调研自动保存");
    const draft = createSurvey(db, salesA, { templateId: "MES-PRESALES-SURVEY:A/0", customerId: customer.id, projectId: project.id, title: "虚构调研草稿" });
    assert.equal(draft.draftEtag, 0);
    const response = structuredClone(draft.response);
    response.answers.m1 = { record: "自动保存内容", solution: "" };
    const saved = updateSurvey(db, salesA, draft.id, { title: draft.title, response, expectedDraftEtag: 0, saveMode: "AUTO" });
    assert.equal(saved.draftEtag, 1);
    assert.ok(saved.draftSavedAt);
    assert.equal(saved.revision, 1);
    assert.equal(auditCount(db, "SURVEY_UPDATED", draft.id), 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM survey_revisions WHERE survey_id = ?`).get(draft.id).count, 0);
    assert.throws(() => updateSurvey(db, salesA, draft.id, { title: "过期页面", response, expectedDraftEtag: 0, saveMode: "AUTO" }), error => error.code === "DRAFT_VERSION_CHANGED");
    const noOp = updateSurvey(db, salesA, draft.id, { title: saved.title, response: saved.response, expectedDraftEtag: 1, saveMode: "AUTO" });
    assert.equal(noOp.draftEtag, 1);
    const manual = updateSurvey(db, salesA, draft.id, { title: "人工保存标题", response, expectedDraftEtag: 1 });
    assert.equal(manual.draftEtag, 2);
    assert.equal(manual.revision, 2);
    assert.equal(auditCount(db, "SURVEY_UPDATED", draft.id), 1);
  } finally {
    db.close();
  }
});

test("报价自动保存重新计算金额、拒绝旧页面覆盖且不提交审批", () => {
  const { db, salesA } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "报价自动保存");
    const draft = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "AUTO-QUOTE"));
    const createdAuditCount = auditCount(db, "QUOTE_DRAFT_UPDATED", draft.id);
    const saved = updateQuoteDraft(db, salesA, draft.id, { items: draft.items, finalDiscountCents: draft.finalDiscountCents - 10_000, notes: "自动保存报价", expectedDraftEtag: 0, saveMode: "AUTO" });
    assert.equal(saved.status, "DRAFT");
    assert.equal(saved.draftEtag, 1);
    assert.equal(saved.discountAmountCents, draft.discountAmountCents + 10_000);
    assert.equal(auditCount(db, "QUOTE_DRAFT_UPDATED", draft.id), createdAuditCount);
    assert.throws(() => updateQuoteDraft(db, salesA, draft.id, { items: draft.items, finalDiscountCents: draft.finalDiscountCents, notes: "旧页面", expectedDraftEtag: 0, saveMode: "AUTO" }), error => error.code === "DRAFT_VERSION_CHANGED");
    const noOp = updateQuoteDraft(db, salesA, draft.id, { items: saved.items, finalDiscountCents: saved.finalDiscountCents, notes: saved.notes, expectedDraftEtag: 1, saveMode: "AUTO" });
    assert.equal(noOp.draftEtag, 1);
  } finally {
    db.close();
  }
});

test("合同自动保存文本但不自动保存人工确认勾选", () => {
    const { db, admin, manager, generalManager, vp, salesA } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "合同自动保存");
    const quote = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "AUTO-CONTRACT"));
    submitQuote(db, salesA, quote.id);
    decideQuote(db, manager, quote.id, { decision: "APPROVED", comment: "虚构一级通过" });
    decideQuote(db, generalManager, quote.id, { decision: "APPROVED", comment: "虚构综合部二审通过" });
    decideQuote(db, vp, quote.id, { decision: "APPROVED", comment: "虚构终审通过" });
    const templateId = randomUUID();
    db.prepare(`INSERT INTO contract_templates (id, version, storage_key, sha256, is_published, published_by, published_at) VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .run(templateId, "AUTO-SAVE-TEST", "templates/auto-save-test.docx", "test-only-sha256-placeholder", admin.id, nowIso());
    const contract = createContractDraft(db, salesA, {
      contractNumber: "HT-AUTO-SAVE",
      customerId: customer.id,
      projectId: project.id,
      quoteVersionId: quote.id,
      templateId,
      partyA: { name: customer.fullName, licenseScope: customer.fullName },
      confirmations: { contractNumber: false }
    });
    const saved = updateContractDraft(db, salesA, contract.id, { signingNotes: "自动保存文本", expectedDraftEtag: 0, saveMode: "AUTO" });
    assert.equal(saved.status, "DRAFT");
    assert.equal(saved.draftEtag, 1);
    assert.equal(saved.signingNotes.value, "自动保存文本");
    assert.equal(saved.confirmations.contractNumber, false);
    assert.equal(auditCount(db, "CONTRACT_DRAFT_UPDATED", contract.id), 0);
    assert.throws(() => updateContractDraft(db, salesA, contract.id, { signingNotes: "过期页面", expectedDraftEtag: 0, saveMode: "AUTO" }), error => error.code === "DRAFT_VERSION_CHANGED");
    const manual = updateContractDraft(db, salesA, contract.id, { signingNotes: saved.signingNotes.value, confirmations: { contractNumber: true }, expectedDraftEtag: 1 });
    assert.equal(manual.draftEtag, 2);
    assert.equal(manual.confirmations.contractNumber, true);
    assert.equal(auditCount(db, "CONTRACT_DRAFT_UPDATED", contract.id), 1);
  } finally {
    db.close();
  }
});

test("数据库为三类长表单提供可重复迁移的草稿令牌字段", () => {
  const { db } = setupBase();
  try {
    for (const table of ["surveys", "quote_versions", "contracts"]) {
      const fields = db.pragma(`table_info(${table})`).map(item => item.name);
      assert.ok(fields.includes("draft_etag"));
      assert.ok(fields.includes("draft_saved_at"));
    }
  } finally {
    db.close();
  }
});

test("前端自动保存串行处理编辑、暴露状态且失败时保留待保存标记", async () => {
  const rendered = [];
  const payloads = [];
  let value = "第一版";
  const controller = createDraftAutosave({
    initialEtag: 4,
    delay: 60_000,
    collect: () => ({ value }),
    save: async payload => {
      payloads.push(payload);
      return { draftEtag: payload.expectedDraftEtag + 1, draftSavedAt: "2026-10-13T12:00:00.000Z" };
    },
    render: state => rendered.push(state.status)
  });
  controller.markDirty();
  const first = await controller.flush();
  assert.equal(first.etag, 5);
  assert.equal(first.pending, false);
  assert.deepEqual(payloads[0], { value: "第一版", expectedDraftEtag: 4, saveMode: "AUTO" });
  assert.ok(rendered.includes("DIRTY"));
  assert.ok(rendered.includes("SAVING"));
  assert.ok(rendered.includes("SAVED"));

  value = "第二版";
  controller.markDirty();
  await controller.flush();
  assert.equal(controller.getState().etag, 6);
  controller.dispose();

  const failing = createDraftAutosave({
    delay: 60_000,
    collect: () => ({ value: "失败内容" }),
    save: async () => { throw new Error("网络不可用"); }
  });
  failing.markDirty();
  await assert.rejects(() => failing.flush(), /网络不可用/);
  assert.equal(failing.getState().pending, true);
  failing.dispose();
});

test("弹出子窗口时暂停父窗口自动保存，返回后保留并继续保存修改", async () => {
  const scheduled = new Map();
  const saved = [];
  let nextTimer = 0;
  const controller = createDraftAutosave({
    collect: () => ({ value: "父窗口未保存内容" }),
    save: async payload => { saved.push(payload); return { draftEtag: 1 }; },
    setTimer: callback => { const id = ++nextTimer; scheduled.set(id, callback); return id; },
    clearTimer: id => scheduled.delete(id)
  });
  controller.markDirty();
  assert.equal(scheduled.size, 1);
  controller.suspend();
  assert.equal(scheduled.size, 0);
  assert.equal(controller.getState().pending, true);
  assert.equal(saved.length, 0);
  controller.resume();
  assert.equal(scheduled.size, 1);
  await controller.flush();
  assert.equal(saved[0].value, "父窗口未保存内容");
  assert.equal(controller.getState().pending, false);
  controller.dispose();
});
