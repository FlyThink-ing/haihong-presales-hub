import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { Document, Packer, Paragraph } from "docx";
import ExcelJS from "exceljs";
import { addCustomerAndProject, setupBase, startTestApi } from "./test-utils.js";
import { sha256 } from "../server/security.js";
import { approvedQuoteSnapshot } from "../server/contract-service.js";
import { uploadAttachment } from "../server/attachment-service.js";
import { quotePdfFixture, quoteBindingPdfFixture } from "./pdf-fixtures.js";

test("上传原报价与人工总额共同送三级审批，退回修改保留原件及历史", async t => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-uploaded-quote-"));
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA, f.salesB, f.manager, f.generalManager, f.vp], { storagePath, dataMode: "TEST", allowUnapprovedQuoteExport: true, launchProfile: "CORE" });
  t.after(async () => {
    await api.close(); f.db.close();
    assert.ok(path.resolve(storagePath).startsWith(path.join(path.resolve(os.tmpdir()), "hh-uploaded-quote-")));
    fs.rmSync(storagePath, { recursive: true, force: true });
  });
  const { customer, project } = addCustomerAndProject(f.db, f.salesA, "上传报价");
  const input = { customerId: customer.id, projectId: project.id, amountCents: 12345678 };
  assert.equal((await api.request(f.salesB, "/api/uploaded-quotes", "POST", input)).status, 404);
  const created = await api.request(f.salesA, "/api/uploaded-quotes", "POST", input);
  assert.equal(created.status, 201);
  const quote = created.body;
  assert.equal(quote.sourceKind, "UPLOADED");
  assert.equal(quote.subtotalUntaxedCents, null);
  assert.deepEqual(quote.items, []);
  assert.equal(quote.finalDiscountCents, input.amountCents);
  const submit = `/api/quote-versions/${quote.id}/submit`;
  assert.equal((await api.request(f.salesA, submit, "POST", {})).body.error.code, "UPLOADED_QUOTE_SOURCE_REQUIRED");
  assert.equal((await api.request(f.salesA, submit, "POST", { amountConfirmed: true })).body.error.code, "UPLOADED_QUOTE_SOURCE_REQUIRED");
  assert.equal((await api.request(f.salesA, `/api/quote-versions/${quote.id}`, "PATCH", {})).body.error.code, "UPLOADED_QUOTE_EDITOR_REQUIRED");
  assert.equal((await api.request(f.salesB, `/api/uploaded-quotes/${quote.id}`, "PATCH", { amountCents: 1, expectedDraftEtag: 0 })).status, 404);
  assert.equal((await api.request(f.salesA, `/api/quote-versions/${quote.id}/preview-docx`, "POST")).body.error.code, "QUOTE_PREVIEW_DISABLED");

  const sourceWithFooter = text => new Document({ sections: [{ children: [new Paragraph(text), new Paragraph("交期：按约定"), new Paragraph("付款方式：按约定"), new Paragraph("报价人：测试售前甲"), new Paragraph("手机：13000000000"), new Paragraph("邮箱：sales@example.invalid")]}] });
  const original = quoteBindingPdfFixture({ customer: customer.fullName, gross: "123,456.78" });
  const replacement = quoteBindingPdfFixture({ customer: customer.fullName, gross: "120,000.00" });
  const wordSource = await Packer.toBuffer(sourceWithFooter("虚构可编辑源文件"));
  const upload = async (versionId, bytes, name, previous = null, targetKey = "", amount = null, etag = null) => {
    const form = new FormData();
    form.set("targetType", "QUOTE_VERSION"); form.set("targetId", versionId); form.set("requestKey", randomUUID());
    form.set("bindingReviewConfirmed", "true");
    if (targetKey) form.set("targetKey", targetKey);
    if (previous) { form.set("attachmentId", previous.id); form.set("expectedCurrentVersionId", previous.currentVersionId); }
    if (amount !== null) { form.set("amountCents", String(amount)); form.set("expectedDraftEtag", String(etag)); }
    form.set("file", new Blob([bytes]), name);
    return api.request(f.salesA, "/api/attachments/upload", "POST", form);
  };
  const attached = await upload(quote.id, original, "虚构原报价.pdf");
  assert.equal(attached.status, 201);
  const vpDraft = await api.request(f.vp, `/api/quote-versions/${quote.id}`);
  assert.equal(vpDraft.status, 200);
  assert.equal(vpDraft.body.attachments.mode, "CURRENT");
  const vpPreview = await api.request(f.vp, `/api/attachments/${attached.body.id}/preview`);
  assert.equal(vpPreview.status, 200);
  assert.ok(vpPreview.body.equals(original));
  assert.equal((await api.request(f.salesB, `/api/attachments/${attached.body.id}/preview`)).status, 404);
  const deniedWord = await upload(quote.id, wordSource, "可编辑源文件.docx", null, "QUOTE_WORD");
  assert.equal(deniedWord.status, 415);
  assert.equal(deniedWord.body.error.code, "QUOTE_WORD_SOURCE_DISABLED");
  // 在隔离测试库中模拟升级前已存在的 Word 源文件，不通过被关闭的入口新增。
  const legacyWord = await uploadAttachment(f.db, { storagePath }, f.salesA, { targetType: "CUSTOMER", targetId: customer.id }, {
    originalname: "历史源文件.docx", mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: wordSource
  });
  f.db.prepare(`UPDATE business_attachments SET target_type='QUOTE_VERSION', target_id=?, target_key='QUOTE_WORD' WHERE id=?`).run(quote.id, legacyWord.id);
  const deniedReplacement = await upload(quote.id, wordSource, "更新源文件.docx", legacyWord, "QUOTE_WORD");
  assert.equal(deniedReplacement.status, 415);
  assert.equal(deniedReplacement.body.error.code, "QUOTE_WORD_SOURCE_DISABLED");
  assert.ok((await api.request(f.salesA, `/api/attachments/${legacyWord.id}/download`)).body.equals(wordSource));
  assert.equal((await api.request(f.salesA, submit, "POST", {})).status, 200);
  const content = JSON.parse(f.db.prepare(`SELECT snapshot_json FROM quote_versions WHERE id = ?`).get(quote.id).snapshot_json);
  assert.equal(content.sourceKind, "UPLOADED");
  assert.equal(content.subtotalUntaxedCents, null);
  assert.deepEqual(content.items, []);
  assert.equal(content.uploadedSource.sha256, sha256(original));
  assert.equal(content.uploadedSource.confirmedAmountCents, input.amountCents);
  assert.equal(content.uploadedSource.amountVerification, "MATCH");
  assert.equal(content.uploadedSource.confirmedBy, null);
  assert.equal(content.documentReview.inspectionMode, "AUTO_FIXED_FIELDS");
  assert.equal(content.documentReview.manualConfirmed, false);
  assert.equal((await upload(quote.id, replacement, "不可覆盖.pdf", attached.body)).status, 409);
  const pending = await api.request(f.manager, `/api/quote-versions/${quote.id}`);
  assert.equal(pending.status, 200);
  assert.equal(pending.body.attachments.mode, "SNAPSHOT");
  const originalSnapshot = pending.body.attachments.items.find(item => !item.targetKey);
  const wordSnapshot = pending.body.attachments.items.find(item => item.targetKey === "QUOTE_WORD");
  assert.ok(wordSnapshot);
  assert.ok((await api.request(f.manager, `/api/attachment-snapshots/${wordSnapshot.id}/download`)).body.equals(wordSource));
  const downloaded = await api.request(f.manager, `/api/attachment-snapshots/${originalSnapshot.id}/download`);
  assert.ok(downloaded.body.equals(original));
  assert.equal((await api.request(f.salesB, `/api/attachment-snapshots/${originalSnapshot.id}/download`)).status, 404);

  const missingReason = await api.request(f.manager, `/api/quote-versions/${quote.id}/decision`, "POST", { decision: "REJECTED", comment: "  " });
  assert.equal(missingReason.status, 400);
  assert.equal(missingReason.body.error.code, "APPROVAL_COMMENT_REQUIRED");
  assert.equal((await api.request(f.manager, `/api/quote-versions/${quote.id}`)).body.approvals.length, 0);
  const rejected = await api.request(f.manager, `/api/quote-versions/${quote.id}/decision`, "POST", { decision: "REJECTED", comment: "请重新报价" });
  assert.equal(rejected.status, 200);
  const nextId = rejected.body.successorVersionId;
  const next = (await api.request(f.salesA, `/api/quote-versions/${nextId}`)).body;
  assert.equal(next.sourceKind, "UPLOADED");
  assert.equal(next.versionHistory[0].id, quote.id);
  assert.equal(next.versionHistory[0].canView, true);
  assert.equal(next.versionHistory[0].approvals[0].comment, "请重新报价");
  const priorVersion = (await api.request(f.salesA, `/api/quote-versions/${quote.id}`)).body;
  assert.equal(priorVersion.attachments.mode, "SNAPSHOT");
  assert.ok((await api.request(f.salesA, `/api/attachment-snapshots/${priorVersion.attachments.items.find(item => !item.targetKey).id}/download`)).body.equals(original));
  const nextPrimary = next.attachments.items.find(item => !item.targetKey);
  assert.equal(nextPrimary.currentVersion.sha256, sha256(original));
  assert.equal((await upload(nextId, replacement, "虚构调整报价.pdf", nextPrimary, "", 12000000, next.draftEtag)).status, 201);
  assert.equal((await api.request(f.salesA, `/api/quote-versions/${nextId}/submit`, "POST", {})).status, 200);
  assert.equal((await api.request(f.manager, `/api/quote-versions/${nextId}/decision`, "POST", { decision: "APPROVED", comment: "" })).status, 200);
  assert.equal((await api.request(f.generalManager, `/api/quote-versions/${nextId}/decision`, "POST", { decision: "APPROVED", comment: "核对原文件通过" })).status, 200);
  const vpPending = await api.request(f.vp, `/api/quote-versions/${nextId}`);
  assert.equal(vpPending.status, 200);
  assert.equal(vpPending.body.versionHistory[0].canView, true);
  assert.equal((await api.request(f.vp, `/api/quote-versions/${quote.id}`)).status, 200);
  assert.ok((await api.request(f.vp, `/api/attachment-snapshots/${originalSnapshot.id}/download`)).body.equals(original));
  assert.equal((await api.request(f.vp, `/api/quote-versions/${nextId}/decision`, "POST", { decision: "APPROVED" })).status, 200);
  const approved = (await api.request(f.salesA, `/api/quote-versions/${nextId}`)).body;
  assert.equal(approved.status, "APPROVED");
  assert.equal(approved.approvals.length, 3);
  assert.deepEqual(approved.approvals.map(item => item.comment), ["通过", "核对原文件通过", "通过"]);
  assert.equal(approved.attachments.items.find(item => !item.targetKey).sha256, sha256(replacement));
  assert.ok((await api.request(f.salesA, `/api/attachment-snapshots/${originalSnapshot.id}/download`)).body.equals(original));
  assert.equal((await api.request(f.salesA, `/api/quote-versions/${nextId}/export-docx`, "POST")).body.error.code, "QUOTE_EXPORT_DISABLED");
  assert.throws(() => approvedQuoteSnapshot(f.db, nextId), error => error.code === "UPLOADED_QUOTE_CONTRACT_UNAVAILABLE");
  assert.equal((await api.request(f.salesA, `/api/quote-versions/${nextId}/revise`, "POST", { reason: "再次调整" })).status, 201);

  const excelQuote = (await api.request(f.salesA, "/api/uploaded-quotes", "POST", input)).body;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("原报价");
  sheet.addRow(["虚构报价", 123456.78]);
  for (const value of ["交期：按约定", "付款方式：按约定", "报价人：测试售前甲", "手机：13000000000", "邮箱：sales@example.invalid"]) sheet.addRow([value]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const rejectedExcel = await upload(excelQuote.id, xlsx, "虚构原报价.xlsx");
  assert.equal(rejectedExcel.status, 415);
  assert.equal(rejectedExcel.body.error.code, "QUOTE_ATTACHMENT_FORMAT_INVALID");
  // 合成升级前已有的 Excel 报价，验证其原文件和历史审批仍可读取。
  const legacyUpload = await uploadAttachment(f.db, { storagePath }, f.salesA, { targetType: "CUSTOMER", targetId: customer.id }, {
    originalname: "虚构原报价.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: xlsx
  });
  f.db.prepare(`UPDATE business_attachments SET target_type = 'QUOTE_VERSION', target_id = ? WHERE id = ?`).run(excelQuote.id, legacyUpload.id);
  assert.ok((await api.request(f.salesA, `/api/attachments/${legacyUpload.id}/download`)).body.equals(xlsx));
  assert.equal((await api.request(f.salesA, `/api/quote-versions/${excelQuote.id}/document-review/boundary`)).body.error.code, "UPLOADED_QUOTE_SOURCE_REQUIRED");
});

test("报价仅接受真实 PDF，新建和替换 Word 源文件均被拒绝", async t => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-pdf-only-"));
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA], { storagePath, launchProfile: "CORE", dataMode: "TEST" });
  t.after(async () => { await api.close(); f.db.close(); fs.rmSync(storagePath, { recursive: true, force: true }); });
  const { customer, project } = addCustomerAndProject(f.db, f.salesA, "PDF格式");
  const quote = (await api.request(f.salesA, "/api/uploaded-quotes", "POST", { customerId: customer.id, projectId: project.id, amountCents: 100000 })).body;
  const pdf = quoteBindingPdfFixture({ customer: customer.fullName, gross: "1,000.00" });
  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("虚构 Word 源文件")] }] }));
  const send = (name, bytes, targetKey = "", previous = null) => {
    const form = new FormData(); form.set("targetType", "QUOTE_VERSION"); form.set("targetId", quote.id); form.set("requestKey", randomUUID());
    form.set("bindingReviewConfirmed", "true");
    if (targetKey) form.set("targetKey", targetKey);
    if (previous) { form.set("attachmentId", previous.id); form.set("expectedCurrentVersionId", previous.currentVersionId); }
    form.set("file", new Blob([bytes]), name);
    return api.request(f.salesA, "/api/attachments/upload", "POST", form);
  };
  assert.equal((await send("报价.docx", docx)).status, 415);
  assert.equal((await send("伪装.pdf", docx)).status, 415);
  assert.notEqual((await send("损坏.pdf", Buffer.from("%PDF-1.4\n%%EOF\n"))).status, 201);
  assert.equal((await send("源文件.pdf", pdf, "QUOTE_WORD")).status, 415);
  const attached = await send("报价.pdf", pdf);
  assert.equal(attached.status, 201);
  assert.equal((await send("重复.pdf", pdf)).status, 409);
  const word = await send("源文件.docx", docx, "QUOTE_WORD");
  assert.equal(word.status, 415);
  assert.equal(word.body.error.code, "QUOTE_WORD_SOURCE_DISABLED");
  const preview = await api.request(f.salesA, `/api/attachments/${attached.body.id}/preview`);
  assert.match(preview.headers.get("content-type"), /application\/pdf/);
  assert.ok(preview.body.equals(pdf));
  const items = (await api.request(f.salesA, `/api/attachments?targetType=QUOTE_VERSION&targetId=${quote.id}`)).body.items;
  assert.equal(items.length, 1);
});

test("上传报价页面在文件上传失败后允许重试，不重复创建报价", async () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const match = source.match(/async function openUploadedQuoteEditor\([\s\S]*?\n\}/);
  assert.ok(match);
  const customer = { id: "customer", fullName: "虚构客户" };
  const version = { id: "quote", customer: { id: "customer" }, draftEtag: 0, attachments: { items: [] } };
  const fields = {
    "#uploaded-quote-customer": { value: "customer" },
    "#uploaded-quote-amount": { value: "123,456.78" },
    "#uploaded-quote-file": { files: [new File(["虚构文件"], "报价.pdf")] }
  };
  const calls = [];
  let dialog;
  let failed = false;
  const context = vm.createContext({
    api: async (route, options = {}) => {
      calls.push({ route, options });
      if (route === "/api/customers") return { items: [customer] };
      if (route === "/api/projects") return { items: [{ id: "project", customerId: "customer" }] };
      if (route === "/api/uploaded-quotes/preflight") return { hasMismatch: false, needsReview: false };
      if (route === "/api/uploaded-quotes") return version;
      if (route === "/api/uploaded-quotes/quote") return version;
      if (route === "/api/quote-versions/quote") return version;
      if (route === "/api/attachments/upload") { if (!failed) { failed = true; throw new Error("模拟网络失败"); } return {}; }
      throw new Error(`意外请求 ${route}`);
    },
    document: { querySelector: selector => fields[selector] },
    openDialog: (title, html, options) => { dialog = { title, html, options }; },
    parseScaledDecimal: value => Math.round(Number(value.replaceAll(",", "")) * 100),
    escapeHtml: value => String(value), quoteBindingPanel: () => "", crypto: { randomUUID }, FormData,
    closeDialog() {}, showToast() {}, refreshQuoteContext: async () => {}
  });
  vm.runInContext(match[0], context);
  await vm.runInContext("openUploadedQuoteEditor()", context);
  assert.match(dialog.html, /报价单含税总额/);
  assert.match(dialog.html, /accept="\.pdf,application\/pdf"/);
  assert.doesNotMatch(dialog.html, /accept="\.docx"|uploaded-quote-word|Word 源文件|Excel|XLSX/);
  for (const name of ["报价.xlsx", "报价.docx", "报价.doc"]) {
    fields["#uploaded-quote-file"].files = [new File(["虚构文件"], name)];
    await assert.rejects(() => dialog.options.onSubmit(), /请上传 PDF 报价单/);
  }
  assert.equal(calls.filter(call => call.route === "/api/uploaded-quotes").length, 0);
  fields["#uploaded-quote-file"].files = [new File(["虚构文件"], "报价.pdf")];
  await assert.rejects(() => dialog.options.onSubmit(), /模拟网络失败/);
  await dialog.options.onSubmit();
  assert.equal(calls.filter(call => call.route === "/api/uploaded-quotes").length, 1);
  assert.equal(calls.filter(call => call.route === "/api/attachments/upload").length, 2);
  const creates = calls.find(call => call.route === "/api/uploaded-quotes");
  assert.equal(JSON.parse(creates.options.body).amountCents, 12345678);
});

test("总额无法识别时允许上传并明确提示金额未核对", async () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const match = source.match(/async function openUploadedQuoteEditor\([\s\S]*?\n\}/);
  assert.ok(match);
  const fields = {
    "#uploaded-quote-customer": { value: "customer" }, "#uploaded-quote-amount": { value: "100.00" },
    "#uploaded-quote-file": { files: [new File(["虚构文件"], "报价.pdf")] },
    "#uploaded-binding-result": { innerHTML: "" }, "#uploaded-binding-confirm": { checked: false }
  };
  let dialog, created = 0, toast = "";
  const version = { id: "quote", customer: { id: "customer" }, draftEtag: 0, attachments: { items: [] } };
  const context = vm.createContext({
    api: async route => {
      if (route === "/api/customers") return { items: [{ id: "customer", fullName: "虚构客户" }] };
      if (route === "/api/projects") return { items: [{ id: "project", customerId: "customer" }] };
      if (route === "/api/uploaded-quotes/preflight") return { hasMismatch: false, needsReview: true, customer: { status: "MATCH" }, amount: { status: "UNRECOGNIZED" }, fixedFields: { errorCount: 0 } };
      if (route === "/api/uploaded-quotes") { created++; return version; }
      if (route === "/api/attachments/upload") return {};
      if (route === "/api/quote-versions/quote") return version;
      throw new Error(`意外请求 ${route}`);
    },
    document: { querySelector: selector => fields[selector] }, openDialog: (_title, _html, options) => { dialog = options; },
    quoteBindingPanel: () => "人工核对", parseScaledDecimal: value => Math.round(Number(value) * 100), escapeHtml: String,
    crypto: { randomUUID }, FormData, closeDialog() {}, showToast(value) { toast = value; }, refreshQuoteContext: async () => {}
  });
  vm.runInContext(match[0], context);
  await vm.runInContext("openUploadedQuoteEditor()", context);
  await dialog.onSubmit();
  assert.equal(created, 1);
  assert.match(toast, /金额未能自动核对/);
});
