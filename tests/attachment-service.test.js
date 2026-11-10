import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Document, Packer, Paragraph } from "docx";
import { deleteAttachment, getAttachmentDownload, getAttachmentSnapshotDownload, listAttachments, uploadAttachment } from "../server/attachment-service.js";
import { createSurvey, completeSurvey, updateSurvey } from "../server/survey-service.js";
import { createApprovedQuoteRevision, createQuote, decideQuote, submitQuote } from "../server/quote-service.js";
import { transferCustomer } from "../server/customer-service.js";
import { createFollowup } from "../server/customer-activity-service.js";
import { getCustomerWorkspace } from "../server/customer-workspace-service.js";
import { addCustomerAndProject, completeSurveyResponse, sampleQuoteInput, setupBase } from "./test-utils.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const PDF2 = Buffer.from("%PDF-1.4\n1 0 obj\n<</Type/Catalog>>\nendobj\n%%EOF\n");
const file = (name = "虚构附件.pdf", buffer = PDF) => ({ originalname: name, mimetype: "application/pdf", buffer });
const quoteFile = async (name = "虚构报价附件.docx") => ({
  originalname: name,
  mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  buffer: await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("虚构报价附件内容")] }] }))
});

function fixture() {
  const base = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-attachments-"));
  return { ...base, storagePath, config: { storagePath }, close() { base.db.close(); fs.rmSync(storagePath, { recursive: true, force: true }); } };
}

test("客户附件上传、幂等、并发替换、版本下载和软删除均留住不可变字节", async t => {
  const f = fixture(); t.after(() => f.close());
  const { customer } = addCustomerAndProject(f.db, f.salesA);
  const requestKey = randomUUID();
  const first = await uploadAttachment(f.db, f.config, f.salesA, { targetType: "CUSTOMER", targetId: customer.id, requestKey }, file("很长的虚构客户需求附件.pdf"));
  const repeated = await uploadAttachment(f.db, f.config, f.salesA, { targetType: "CUSTOMER", targetId: customer.id, requestKey }, file("很长的虚构客户需求附件.pdf"));
  assert.equal(repeated.id, first.id);
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM stored_files WHERE category = 'BUSINESS_ATTACHMENT'`).get().count, 1);

  const second = await uploadAttachment(f.db, f.config, f.salesA, { targetType: "CUSTOMER", targetId: customer.id, attachmentId: first.id, expectedCurrentVersionId: first.currentVersionId, requestKey: randomUUID() }, file("虚构附件-v2.pdf", PDF2));
  assert.equal(second.versions.length, 2);
  await assert.rejects(() => uploadAttachment(f.db, f.config, f.salesA, { targetType: "CUSTOMER", targetId: customer.id, attachmentId: first.id, expectedCurrentVersionId: first.currentVersionId }, file()), error => error.code === "ATTACHMENT_VERSION_CHANGED");
  assert.deepEqual(getAttachmentDownload(f.db, f.config, f.salesA, first.id, first.currentVersionId).buffer, PDF);
  assert.deepEqual(getAttachmentDownload(f.db, f.config, f.salesA, first.id).buffer, PDF2);

  deleteAttachment(f.db, f.salesA, first.id, { reason: "虚构需求附件已由正式版本替代" });
  assert.equal(listAttachments(f.db, f.salesA, { targetType: "CUSTOMER", targetId: customer.id }).items.length, 0);
  assert.throws(() => getAttachmentDownload(f.db, f.config, f.salesA, first.id), error => error.code === "ATTACHMENT_NOT_FOUND");
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM stored_files WHERE category = 'BUSINESS_ATTACHMENT'`).get().count, 2);
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action IN ('ATTACHMENT_UPLOADED','ATTACHMENT_VERSION_UPLOADED','ATTACHMENT_DELETED')`).get().count, 3);
});

test("已保存跟进附件进入客户工作区且操作日志按客户汇聚", async t => {
  const f = fixture(); t.after(() => f.close());
  const { customer } = addCustomerAndProject(f.db, f.salesA, "跟进附件");
  const followup = createFollowup(f.db, f.salesA, customer.id, { method: "PHONE", occurredAt: "2026-10-13T08:00:00.000Z", content: "虚构已保存跟进", nextAction: "虚构下一步" }).followup;
  const attached = await uploadAttachment(f.db, f.config, f.salesA, { targetType: "FOLLOWUP", targetId: followup.id }, file("跟进现场资料.pdf"));
  const workspace = getCustomerWorkspace(f.db, f.salesA, customer.id);
  assert.equal(workspace.businessAttachments.customer.items.length, 0);
  assert.equal(workspace.businessAttachments.followups[followup.id].items[0].id, attached.id);
  assert.ok(workspace.auditLogs.some(log => log.entityType === "BUSINESS_ATTACHMENT" && log.entityId === attached.id && log.action === "ATTACHMENT_UPLOADED"));
  assert.throws(() => listAttachments(f.db, f.salesB, { targetType: "FOLLOWUP", targetId: followup.id }), error => error.code === "ATTACHMENT_NOT_FOUND");
});

test("调研整体和每题附件随完成确认冻结，新修订复制当前关联而不改历史快照", async t => {
  const f = fixture(); t.after(() => f.close());
  const { customer, project } = addCustomerAndProject(f.db, f.salesA);
  const survey = createSurvey(f.db, f.salesA, { customerId: customer.id, projectId: project.id, templateId: "MES-PRESALES-SURVEY:A/0", title: "虚构附件调研" });
  const questionId = survey.template.schema.modules[0].questions[0].id;
  await uploadAttachment(f.db, f.config, f.salesA, { targetType: "SURVEY", targetId: survey.id }, file("调研整体.pdf"));
  await uploadAttachment(f.db, f.config, f.salesA, { targetType: "SURVEY_QUESTION", targetId: survey.id, targetKey: questionId }, file("问题证据.pdf", PDF2));
  updateSurvey(f.db, f.salesA, survey.id, { title: survey.title, response: completeSurveyResponse(survey.template.schema) });
  const completed = completeSurvey(f.db, f.salesA, survey.id);
  assert.equal(completed.attachments.mode, "SNAPSHOT");
  assert.equal(completed.attachments.items.length, 2);
  await assert.rejects(() => uploadAttachment(f.db, f.config, f.salesA, { targetType: "SURVEY", targetId: survey.id }, file()), error => error.code === "ATTACHMENT_TARGET_LOCKED");

  const successor = updateSurvey(f.db, f.salesA, survey.id, { title: survey.title, reason: "虚构调研补充", response: completeSurveyResponse(survey.template.schema) });
  assert.equal(successor.attachments.mode, "CURRENT");
  assert.equal(successor.attachments.items.length, 2);
  const target = addCustomerAndProject(f.db, f.salesA, "调研复用目标");
  const reused = createSurvey(f.db, f.salesA, { customerId: target.customer.id, projectId: target.project.id, templateId: survey.template.id, reuseFromSurveyId: survey.id, title: "复用内容但不复用附件" });
  assert.deepEqual(reused.response, completed.response);
  assert.equal(reused.attachments.items.length, 0);
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM business_attachment_snapshots WHERE snapshot_kind = 'SURVEY_COMPLETION' AND snapshot_owner_id = ?`).get(survey.id).count, 2);
});

test("报价提交冻结精确附件，审批沿用同一快照，退回草稿复制关联", async t => {
  const f = fixture(); t.after(() => f.close());
  const { customer, project } = addCustomerAndProject(f.db, f.salesA);
  const quote = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id, "ATT"));
  await assert.rejects(
    () => uploadAttachment(f.db, f.config, f.salesA, { targetType: "QUOTE_VERSION", targetId: quote.id }, file("报价附件.pdf")),
    error => error.code === "QUOTE_ATTACHMENT_FORMAT_INVALID"
  );
  const quoteAttachment = await quoteFile("报价范围说明.docx");
  const attached = await uploadAttachment(f.db, f.config, f.salesA, { targetType: "QUOTE_VERSION", targetId: quote.id }, quoteAttachment);
  const submitted = submitQuote(f.db, f.salesA, quote.id);
  assert.equal(submitted.attachments.mode, "SNAPSHOT");
  assert.equal(submitted.attachments.items[0].attachmentVersionId, attached.currentVersionId);
  const storedSnapshot = JSON.parse(f.db.prepare(`SELECT snapshot_json FROM quote_versions WHERE id = ?`).get(quote.id).snapshot_json);
  assert.equal(storedSnapshot.attachments[0].sha256, attached.currentVersion.sha256);
  decideQuote(f.db, f.manager, quote.id, { decision: "APPROVED", comment: "虚构部门审批通过" });
  decideQuote(f.db, f.generalManager, quote.id, { decision: "APPROVED", comment: "虚构综合部审批通过" });
  decideQuote(f.db, f.vp, quote.id, { decision: "APPROVED", comment: "虚构副总审批通过" });
  const approvals = f.db.prepare(`SELECT snapshot_json FROM quote_approval_snapshots WHERE quote_version_id = ? ORDER BY created_at`).all(quote.id).map(row => JSON.parse(row.snapshot_json));
  assert.equal(approvals.length, 3);
  assert.deepEqual(approvals[0].content.attachments, storedSnapshot.attachments);
  assert.deepEqual(approvals[1].content.attachments, storedSnapshot.attachments);
  assert.deepEqual(getAttachmentSnapshotDownload(f.db, f.config, f.vp, submitted.attachments.items[0].id).buffer, quoteAttachment.buffer);

  const adjusted = createApprovedQuoteRevision(f.db, f.salesA, quote.id, { reason: "虚构客户调整范围，重新核价" });
  const adjustedFiles = listAttachments(f.db, f.salesA, { targetType: "QUOTE_VERSION", targetId: adjusted.id });
  assert.equal(adjustedFiles.items.length, 1);
  assert.equal(adjustedFiles.items[0].currentVersion.sha256, attached.currentVersion.sha256);
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM business_attachment_snapshots WHERE snapshot_kind = 'QUOTE_SUBMISSION' AND snapshot_owner_id = ?`).get(quote.id).count, 1);
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM quote_approvals WHERE quote_version_id = ?`).get(quote.id).count, 3);

  const returnedQuote = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id, "RETURN"));
  await uploadAttachment(f.db, f.config, f.salesA, { targetType: "QUOTE_VERSION", targetId: returnedQuote.id }, await quoteFile("退回复制.docx"));
  submitQuote(f.db, f.salesA, returnedQuote.id);
  const rejected = decideQuote(f.db, f.manager, returnedQuote.id, { decision: "REJECTED", comment: "虚构退回修改" });
  const copied = listAttachments(f.db, f.salesA, { targetType: "QUOTE_VERSION", targetId: rejected.successorVersionId });
  assert.equal(copied.items.length, 1);
  assert.equal(copied.items[0].currentVersion.sha256, (await getAttachmentSnapshotDownload(f.db, f.config, f.salesA, f.db.prepare(`SELECT id FROM business_attachment_snapshots WHERE snapshot_owner_id = ?`).get(returnedQuote.id).id)).sha256);
});

test("权限随客户转让即时重算，副总可查看报价附件，客户通用附件维持原范围", async t => {
  const f = fixture(); t.after(() => f.close());
  const { customer, project } = addCustomerAndProject(f.db, f.salesA);
  const customerAttachment = await uploadAttachment(f.db, f.config, f.salesA, { targetType: "CUSTOMER", targetId: customer.id }, file("客户私有.pdf"));
  assert.throws(() => getAttachmentDownload(f.db, f.config, f.vp, customerAttachment.id), error => error.code === "ATTACHMENT_NOT_FOUND");
  const quote = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id, "VP"));
  const quoteAttachment = await quoteFile("副总可审阅.docx");
  await uploadAttachment(f.db, f.config, f.salesA, { targetType: "QUOTE_VERSION", targetId: quote.id }, quoteAttachment);
  submitQuote(f.db, f.salesA, quote.id);
  const snapshotId = f.db.prepare(`SELECT id FROM business_attachment_snapshots WHERE snapshot_owner_id = ?`).get(quote.id).id;
  assert.deepEqual(getAttachmentSnapshotDownload(f.db, f.config, f.vp, snapshotId).buffer, quoteAttachment.buffer);
  decideQuote(f.db, f.manager, quote.id, { decision: "APPROVED", comment: "进入终审" });
  decideQuote(f.db, f.generalManager, quote.id, { decision: "APPROVED", comment: "综合部审核通过" });
  assert.deepEqual(getAttachmentSnapshotDownload(f.db, f.config, f.vp, snapshotId).buffer, quoteAttachment.buffer);

  transferCustomer(f.db, f.admin, customer.id, { newOwnerId: f.salesB.id, reason: "虚构区域调整" });
  assert.throws(() => getAttachmentDownload(f.db, f.config, f.salesA, customerAttachment.id), error => error.code === "ATTACHMENT_NOT_FOUND");
  assert.deepEqual(getAttachmentDownload(f.db, f.config, f.salesB, customerAttachment.id).buffer, PDF);
});

test("归档字节被篡改时当前附件和快照下载都阻断", async t => {
  const f = fixture(); t.after(() => f.close());
  const { customer, project } = addCustomerAndProject(f.db, f.salesA);
  const quote = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id, "TAMPER"));
  const attachment = await uploadAttachment(f.db, f.config, f.salesA, { targetType: "QUOTE_VERSION", targetId: quote.id }, await quoteFile());
  submitQuote(f.db, f.salesA, quote.id);
  const storageKey = f.db.prepare(`SELECT storage_key FROM stored_files WHERE id = ?`).get(attachment.currentVersion.fileId).storage_key;
  fs.writeFileSync(path.join(f.storagePath, ...storageKey.split("/")), PDF2);
  assert.throws(() => getAttachmentDownload(f.db, f.config, f.salesA, attachment.id), error => error.code === "ATTACHMENT_FILE_TAMPERED");
  const snapshotId = f.db.prepare(`SELECT id FROM business_attachment_snapshots WHERE snapshot_owner_id = ?`).get(quote.id).id;
  assert.throws(() => getAttachmentSnapshotDownload(f.db, f.config, f.salesA, snapshotId), error => error.code === "ATTACHMENT_FILE_TAMPERED");
});
