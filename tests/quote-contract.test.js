import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createContractDraft, preflightContract, summarizeContractBodyItems } from "../server/contract-service.js";
import { nowIso } from "../server/database.js";
import { calculateQuoteItems, createApprovedQuoteRevision, createQuote, decideQuote, getQuoteVersion, listPendingQuotes, listQuotes, submitQuote, updateQuoteDraft } from "../server/quote-service.js";
import { sha256 } from "../server/security.js";
import { addCustomerAndProject, sampleQuoteInput, setupBase } from "./test-utils.js";

test("报价金额只能由服务端计算并拒绝页面伪造金额", () => {
  const item = { category: "标准模块", itemName: "虚构模块", unit: "套", quantityMilli: 1500, untaxedUnitPriceCents: 10_000, taxRateBps: 600 };
  const result = calculateQuoteItems([item]);
  assert.equal(result.items[0].untaxedAmountCents, 15_000);
  assert.equal(result.items[0].taxedAmountCents, 15_900);
  assert.throws(() => calculateQuoteItems([{ ...item, taxedAmountCents: 15_899 }]), error => error.code === "QUOTE_AMOUNT_MISMATCH");
});

test("合同正文只精确汇总同单位、同整数分单价和同整数基点税率的报价行", () => {
  const sourceItems = [
    { category: "标准模块", itemName: "虚构模块甲", subitemName: "虚构子项一", unit: "套", quantityMilli: 1250, untaxedUnitPriceCents: 40_000, taxRateBps: 600 },
    { category: "标准模块", itemName: "虚构模块乙", subitemName: "虚构子项二", unit: "套", quantityMilli: 750, untaxedUnitPriceCents: 40_000, taxRateBps: 600 }
  ];
  const items = calculateQuoteItems(sourceItems).items;
  const summary = summarizeContractBodyItems(items);
  assert.equal(summary.ok, true);
  assert.equal(summary.productNames, "虚构模块甲（虚构子项一）、虚构模块乙（虚构子项二）");
  assert.equal(summary.unit, "套");
  assert.equal(summary.quantityMilli, 2000);
  assert.equal(summary.untaxedUnitPriceCents, 40_000);
  assert.equal(summary.untaxedAmountCents, 80_000);
  assert.equal(summary.taxRateBps, 600);
  assert.equal(summary.taxedAmountCents, 84_800);

  for (const changed of [
    { unit: "项" },
    { untaxedUnitPriceCents: 40_001 },
    { taxRateBps: 601 }
  ]) {
    const heterogeneous = calculateQuoteItems([sourceItems[0], { ...sourceItems[1], ...changed }]).items;
    const rejected = summarizeContractBodyItems(heterogeneous);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "CONTRACT_BODY_PRICE_TABLE_HETEROGENEOUS");
    assert.match(rejected.message, /支持正文多行价格表的新版合同模板/);
  }
});

test("异构终审报价在合同草稿预检阶段返回服务端拒绝结论", () => {
  const { db, admin, manager, generalManager, vp, salesA } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "异构正文");
    const input = sampleQuoteInput(customer.id, project.id, "HETERO-BODY");
    input.items[1] = { ...input.items[1], unit: "项" };
    const quote = createQuote(db, salesA, input);
    submitQuote(db, salesA, quote.id);
    decideQuote(db, manager, quote.id, { decision: "APPROVED", comment: "虚构一级同意" });
    decideQuote(db, generalManager, quote.id, { decision: "APPROVED", comment: "虚构综合部二审同意" });
    decideQuote(db, vp, quote.id, { decision: "APPROVED", comment: "虚构终审同意" });
    const templateId = randomUUID();
    db.prepare(`INSERT INTO contract_templates (id, version, storage_key, sha256, is_published, published_by, published_at) VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .run(templateId, "TEST-HETERO-BODY", "templates/test-hetero.docx", "test-only-sha256-placeholder", admin.id, nowIso());
    const result = preflightContract(db, salesA, { quoteVersionId: quote.id, templateId });
    assert.equal(result.ok, false);
    assert.equal(result.bodySummary, null);
    assert.ok(result.issues.some(issue => issue.code === "CONTRACT_BODY_PRICE_TABLE_HETEROGENEOUS" && issue.message.includes("支持正文多行价格表")));
    assert.throws(
      () => createContractDraft(db, salesA, { contractNumber: "HT-HETERO-REJECT", quoteVersionId: quote.id, templateId }),
      error => error.code === "CONTRACT_PREFLIGHT_FAILED" && error.details.some(issue => issue.code === "CONTRACT_BODY_PRICE_TABLE_HETEROGENEOUS")
    );
  } finally {
    db.close();
  }
});

test("报价按研发经理、综合部经理和副总经理三级审批，快照完整且审批完成版本锁定", () => {
  const { db, manager, generalManager, vp, salesA } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "审批");
    const draft = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "APPROVE"));
    const submitted = submitQuote(db, salesA, draft.id);
    assert.equal(submitted.status, "PENDING_MANAGER");
    assert.deepEqual(submitted.approvalWorkflow, ["MANAGER", "GENERAL_MANAGER", "VP"]);
    assert.ok(submitted.snapshotHash);
    assert.throws(() => decideQuote(db, salesA, draft.id, { decision: "APPROVED", comment: "试图越权" }), error => error.code === "QUOTE_APPROVE_FORBIDDEN");
    assert.equal(getQuoteVersion(db, vp, draft.id).currentApprovalStage, "MANAGER");
    assert.deepEqual(listQuotes(db, vp).map(quote => quote.id), [draft.id]);
    assert.deepEqual(listPendingQuotes(db, manager).map(quote => quote.id), [draft.id]);
    assert.deepEqual(listPendingQuotes(db, vp), []);
    assert.throws(() => decideQuote(db, vp, draft.id, { decision: "APPROVED" }), error => error.code === "QUOTE_APPROVE_FORBIDDEN");
    assert.equal(decideQuote(db, manager, draft.id, { decision: "APPROVED", comment: "虚构一级审批同意" }).decidedVersion.status, "PENDING_VP");
    assert.equal(getQuoteVersion(db, generalManager, draft.id).currentApprovalStage, "GENERAL_MANAGER");
    assert.equal(getQuoteVersion(db, vp, draft.id).currentApprovalStage, "GENERAL_MANAGER");
    assert.deepEqual(listPendingQuotes(db, vp), []);
    assert.throws(() => decideQuote(db, vp, draft.id, { decision: "APPROVED" }), error => error.code === "QUOTE_APPROVE_FORBIDDEN");
    assert.equal(decideQuote(db, generalManager, draft.id, { decision: "APPROVED", comment: "虚构综合部二审同意" }).decidedVersion.currentApprovalStage, "VP");
    assert.equal(getQuoteVersion(db, vp, draft.id).status, "PENDING_VP");
    assert.equal(listQuotes(db, vp).length, 1);
    assert.equal(decideQuote(db, vp, draft.id, { decision: "APPROVED", comment: "虚构终审同意" }).decidedVersion.status, "APPROVED");
    const approved = getQuoteVersion(db, salesA, draft.id);
    assert.equal(approved.approvals.length, 3);
    assert.deepEqual(approved.approvals.map(item => item.stage), ["MANAGER", "GENERAL_MANAGER", "VP"]);
    assert.deepEqual(approved.approvals.map(item => item.approver.displayName), [manager.displayName, generalManager.displayName, vp.displayName]);
    assert.deepEqual(approved.approvals.map(item => item.comment), ["虚构一级审批同意", "虚构综合部二审同意", "虚构终审同意"]);
    assert.ok(approved.approvals.every(item => item.createdAt));
    assert.equal(approved.lockedAt, submitted.lockedAt);
    assert.throws(() => submitQuote(db, salesA, draft.id), error => error.code === "QUOTE_NOT_DRAFT");
    const snapshots = db.prepare(`SELECT snapshot_json, snapshot_hash FROM quote_approval_snapshots WHERE quote_version_id = ? ORDER BY created_at`).all(draft.id);
    assert.equal(snapshots.length, 3);
    const finalSnapshot = JSON.parse(snapshots.at(-1).snapshot_json);
    assert.equal(finalSnapshot.content.items.length, 3);
    assert.equal(finalSnapshot.approvals.length, 3);
    assert.equal(finalSnapshot.content.subtotalTaxedCents, 12_720_000);
    assert.equal(finalSnapshot.content.finalDiscountCents, 12_600_000);
    assert.equal(finalSnapshot.content.discountAmountCents, 120_000);
    assert.equal(finalSnapshot.content.items.reduce((sum, item) => sum + item.taxedAmountCents, 0), finalSnapshot.content.subtotalTaxedCents);
    assert.ok(snapshots.at(-1).snapshot_hash);
  } finally {
    db.close();
  }
});

test("升级前已提交的两级报价保持原审批链且不会伪造综合部经理记录", () => {
  const { db, manager, generalManager, vp, salesA } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "历史两级审批");
    const draft = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "LEGACY"));
    submitQuote(db, salesA, draft.id);
    const content = JSON.parse(db.prepare(`SELECT snapshot_json FROM quote_versions WHERE id = ?`).get(draft.id).snapshot_json);
    delete content.approvalWorkflow;
    const legacySnapshot = JSON.stringify(content);
    db.prepare(`UPDATE quote_versions SET snapshot_json = ?, snapshot_hash = ? WHERE id = ?`).run(legacySnapshot, sha256(legacySnapshot), draft.id);

    const managerResult = decideQuote(db, manager, draft.id, { decision: "APPROVED", comment: "历史一级审核" }).decidedVersion;
    assert.equal(managerResult.currentApprovalStage, "VP");
    assert.deepEqual(managerResult.approvalWorkflow, ["MANAGER", "VP"]);
    assert.throws(() => decideQuote(db, generalManager, draft.id, { decision: "APPROVED", comment: "不得补造二审" }), error => error.code === "QUOTE_APPROVE_FORBIDDEN");
    decideQuote(db, vp, draft.id, { decision: "APPROVED", comment: "历史终审" });
    const approved = getQuoteVersion(db, salesA, draft.id);
    assert.equal(approved.status, "APPROVED");
    assert.deepEqual(approved.approvals.map(item => item.stage), ["MANAGER", "VP"]);
  } finally {
    db.close();
  }
});

test("报价草稿可编辑且优惠仅保存在汇总，不改变任何明细金额", () => {
  const { db, salesA } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "优惠");
    const draft = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "DISCOUNT"));
    const originalItems = draft.items.map(item => ({ ...item }));
    const updated = updateQuoteDraft(db, salesA, draft.id, { items: originalItems, finalDiscountCents: 12_500_000, notes: "虚构汇总优惠" });
    assert.equal(updated.subtotalTaxedCents, 12_720_000);
    assert.equal(updated.finalDiscountCents, 12_500_000);
    assert.equal(updated.discountAmountCents, 220_000);
    assert.deepEqual(updated.items.map(item => item.taxedAmountCents), originalItems.map(item => item.taxedAmountCents));
  } finally {
    db.close();
  }
});

test("客户联系人及电话可留空，旧规则误填的售前信息不进入新审批快照", () => {
  const { db, salesA } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "客户联系人纠正");
    const cases = [
      { metadata: {}, expectedName: "", expectedPhone: "" },
      { metadata: { customerContactName: "虚构客户联系人", customerContactSource: "CUSTOMER_MANUAL" }, expectedName: "虚构客户联系人", expectedPhone: "" },
      { metadata: { customerPhone: "13100000000", customerContactSource: "CUSTOMER_MANUAL" }, expectedName: "", expectedPhone: "13100000000" },
      { metadata: { customerContactName: "旧规则售前姓名", customerPhone: "13000000000", sellerName: "旧规则售前姓名", sellerPhone: "13000000000" }, expectedName: "", expectedPhone: "" }
    ];
    for (const [index, entry] of cases.entries()) {
      const input = sampleQuoteInput(customer.id, project.id, `CONTACT-OPTIONAL-${index}`);
      input.metadata = entry.metadata;
      const draft = createQuote(db, salesA, input);
      assert.equal(submitQuote(db, salesA, draft.id).status, "PENDING_MANAGER");
      const stored = db.prepare(`SELECT snapshot_json, metadata_json FROM quote_versions WHERE id = ?`).get(draft.id);
      const snapshot = JSON.parse(stored.snapshot_json);
      assert.equal(snapshot.metadata.customerContactName, entry.expectedName);
      assert.equal(snapshot.metadata.customerPhone, entry.expectedPhone);
      if (index === 3) assert.equal(JSON.parse(stored.metadata_json).customerContactName, "旧规则售前姓名");
    }
  } finally {
    db.close();
  }
});

test("报价退回保留旧版本并自动创建下一版草稿", () => {
  const { db, manager, salesA } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "退回");
    const draft = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "REJECT"));
    submitQuote(db, salesA, draft.id);
    const result = decideQuote(db, manager, draft.id, { decision: "REJECTED", comment: "虚构退回意见：补充分项说明" });
    assert.equal(result.decidedVersion.status, "MANAGER_RETURNED");
    assert.ok(result.successorVersionId);
    const successor = getQuoteVersion(db, salesA, result.successorVersionId);
    assert.equal(successor.status, "DRAFT");
    assert.equal(successor.revision, 2);
    assert.equal(successor.items.length, draft.items.length);
  } finally {
    db.close();
  }
});

test("已审批报价调价时创建新版本并完整保留原审批记录", () => {
  const { db, manager, generalManager, vp, salesA } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "审批后调价");
    const draft = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "REVISE-APPROVED"));
    submitQuote(db, salesA, draft.id);
    decideQuote(db, manager, draft.id, { decision: "APPROVED", comment: "虚构研发经理通过" });
    decideQuote(db, generalManager, draft.id, { decision: "APPROVED", comment: "虚构综合部经理通过" });
    decideQuote(db, vp, draft.id, { decision: "APPROVED", comment: "虚构副总经理通过" });

    assert.throws(() => createApprovedQuoteRevision(db, salesA, draft.id, { reason: "" }), error => error.code === "QUOTE_REVISION_REASON_REQUIRED");
    const revision = createApprovedQuoteRevision(db, salesA, draft.id, { reason: "客户调整采购范围，重新核价" });
    assert.equal(revision.revision, 2);
    assert.equal(revision.status, "DRAFT");
    assert.deepEqual(revision.items, getQuoteVersion(db, salesA, draft.id).items);
    assert.equal(revision.versionHistory.length, 1);
    assert.equal(revision.versionHistory[0].status, "APPROVED");
    assert.equal(revision.versionHistory[0].approvals.length, 3);
    assert.equal(getQuoteVersion(db, salesA, draft.id).status, "APPROVED");
    assert.equal(listQuotes(db, salesA)[0].id, revision.id);
    assert.throws(() => createApprovedQuoteRevision(db, salesA, draft.id, { reason: "重复发起" }), error => error.code === "QUOTE_VERSION_NOT_CURRENT");
  } finally {
    db.close();
  }
});

test("有优惠报价分别校验附件原合计、附件最终优惠价和合同总价", () => {
  const { db, admin, manager, generalManager, vp, salesA } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "合同");
    const draft = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "CONTRACT"));
    const templateId = randomUUID();
    db.prepare(`INSERT INTO contract_templates (id, version, storage_key, sha256, is_published, published_by, published_at) VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .run(templateId, "TEST-V1", "templates/test-contract.docx", "test-only-sha256-placeholder", admin.id, nowIso());
    const base = { contractNumber: `C-TEST-${randomUUID().slice(0, 8)}`, customerId: customer.id, projectId: project.id, quoteVersionId: draft.id, templateId, contractAmountCents: draft.finalDiscountCents, attachment: { subtotalCents: draft.subtotalTaxedCents, finalDiscountCents: draft.finalDiscountCents, items: draft.items } };
    assert.throws(() => preflightContract(db, salesA, base), error => error.code === "QUOTE_NOT_APPROVED");

    submitQuote(db, salesA, draft.id);
    decideQuote(db, manager, draft.id, { decision: "APPROVED", comment: "虚构一级同意" });
    decideQuote(db, generalManager, draft.id, { decision: "APPROVED", comment: "虚构综合部二审同意" });
    decideQuote(db, vp, draft.id, { decision: "APPROVED", comment: "虚构终审同意" });
    const approved = getQuoteVersion(db, salesA, draft.id);
    const input = { ...base, contractAmountCents: approved.finalDiscountCents, attachment: { subtotalCents: approved.subtotalTaxedCents, finalDiscountCents: approved.finalDiscountCents, items: approved.items } };
    assert.equal(approved.subtotalTaxedCents, 12_720_000);
    assert.equal(approved.finalDiscountCents, 12_600_000);
    const wrongContractTotal = preflightContract(db, salesA, { ...input, contractAmountCents: approved.subtotalTaxedCents });
    assert.equal(wrongContractTotal.ok, false);
    assert.ok(wrongContractTotal.issues.some(issue => issue.field === "contractAmountCents"));
    const wrongAttachmentSubtotal = preflightContract(db, salesA, { ...input, attachment: { ...input.attachment, subtotalCents: approved.finalDiscountCents } });
    assert.equal(wrongAttachmentSubtotal.ok, false);
    assert.ok(wrongAttachmentSubtotal.issues.some(issue => issue.field === "attachment.subtotalCents"));
    const wrongAttachmentFinal = preflightContract(db, salesA, { ...input, attachment: { ...input.attachment, finalDiscountCents: approved.subtotalTaxedCents } });
    assert.equal(wrongAttachmentFinal.ok, false);
    assert.ok(wrongAttachmentFinal.issues.some(issue => issue.field === "attachment.finalDiscountCents"));
    const mismatch = preflightContract(db, salesA, { ...input, attachment: { ...input.attachment, items: approved.items.map((item, index) => index === 0 ? { ...item, quantityMilli: item.quantityMilli + 1000 } : item) } });
    assert.equal(mismatch.ok, false);
    assert.ok(mismatch.issues.some(issue => issue.field.includes("quantityMilli")));
    assert.equal(preflightContract(db, salesA, input).ok, true);
    const contract = createContractDraft(db, salesA, input);
    assert.equal(contract.status, "DRAFT");
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM contract_attachment_versions WHERE contract_id = ?`).get(contract.id).count, 1);
    const archivedSummary = db.prepare(`SELECT subtotal_cents, final_discount_cents FROM contract_attachment_versions WHERE contract_id = ?`).get(contract.id);
    assert.equal(archivedSummary.subtotal_cents, approved.subtotalTaxedCents);
    assert.equal(archivedSummary.final_discount_cents, approved.finalDiscountCents);
  } finally {
    db.close();
  }
});

test("无优惠报价的附件原合计、最终价和合同总价保持相等", () => {
  const { db, admin, manager, generalManager, vp, salesA } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "无优惠合同");
    const quoteInput = sampleQuoteInput(customer.id, project.id, "NO-DISCOUNT");
    quoteInput.finalDiscountCents = 12_720_000;
    const draft = createQuote(db, salesA, quoteInput);
    submitQuote(db, salesA, draft.id);
    decideQuote(db, manager, draft.id, { decision: "APPROVED", comment: "虚构一级同意" });
    decideQuote(db, generalManager, draft.id, { decision: "APPROVED", comment: "虚构综合部二审同意" });
    decideQuote(db, vp, draft.id, { decision: "APPROVED", comment: "虚构终审同意" });
    const approved = getQuoteVersion(db, salesA, draft.id);
    const templateId = randomUUID();
    db.prepare(`INSERT INTO contract_templates (id, version, storage_key, sha256, is_published, published_by, published_at) VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .run(templateId, `TEST-NO-DISCOUNT-${randomUUID()}`, "templates/test-no-discount.docx", "test-only-sha256-placeholder", admin.id, nowIso());
    const input = { contractNumber: `C-NO-DISCOUNT-${randomUUID().slice(0, 8)}`, customerId: customer.id, projectId: project.id, quoteVersionId: approved.id, templateId, contractAmountCents: approved.finalDiscountCents, attachment: { subtotalCents: approved.subtotalTaxedCents, finalDiscountCents: approved.finalDiscountCents, items: approved.items } };
    const result = preflightContract(db, salesA, input);
    assert.equal(result.ok, true);
    assert.equal(result.expectedSubtotalCents, result.expectedAmountCents);
    assert.equal(result.expectedDiscountAmountCents, 0);
  } finally {
    db.close();
  }
});
