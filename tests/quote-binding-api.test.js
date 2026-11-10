import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { addCustomerAndProject, setupBase, startTestApi } from "./test-utils.js";
import { quoteBindingPdfFixture, quotePdfFixture } from "./pdf-fixtures.js";
import { uploadAttachment } from "../server/attachment-service.js";

test("PDF 上传前及服务端保存时核对客户与金额；调价与文件原子更新", async t => {
  const f = setupBase(), storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-binding-"));
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA, f.salesB, f.manager, f.vp], { storagePath, dataMode: "TEST", launchProfile: "CORE" });
  t.after(async () => { await api.close(); f.db.close(); fs.rmSync(storagePath, { recursive: true, force: true }); });
  const { customer, project } = addCustomerAndProject(f.db, f.salesA, "绑定");
  for (const asset of ["/vendor/pdfjs/pdf.mjs", "/vendor/pdfjs/pdf.worker.mjs", "/vendor/pdfjs/cmaps/Add-H.bcmap", "/vendor/pdfjs/standard_fonts/FoxitSerif.pfb"]) {
    const response = await api.request(f.salesA, asset);
    assert.equal(response.status, 200, asset);
    assert.ok(response.body.length > 100, asset);
    if (asset.endsWith(".mjs")) assert.match(response.headers.get("content-type"), /javascript/);
  }
  const pdf = quoteBindingPdfFixture({ customer: customer.fullName });
  const mismatch = quoteBindingPdfFixture({ customer: "另一个虚构客户有限公司", gross: "90,000.00" });
  const preflight = (actor, bytes, amount = 10000000) => {
    const form = new FormData(); form.set("customerId", customer.id); form.set("amountCents", String(amount)); form.set("file", new Blob([bytes]), "报价.pdf");
    return api.request(actor, "/api/uploaded-quotes/preflight", "POST", form);
  };
  const before = f.db.prepare(`SELECT COUNT(*) AS n FROM quotes`).get().n;
  const bad = await preflight(f.salesA, mismatch);
  assert.equal(bad.status, 200);
  assert.equal(bad.body.customer.status, "MISMATCH");
  assert.equal(bad.body.amount.status, "MISMATCH");
  assert.equal(bad.body.hasMismatch, true);
  assert.equal((await preflight(f.salesB, pdf)).status, 404);
  assert.equal((await preflight(f.vp, pdf)).status, 403);
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM quotes`).get().n, before);
  const good = await preflight(f.salesA, pdf);
  assert.equal(good.body.customer.status, "MATCH");
  assert.equal(good.body.amount.status, "MATCH");
  const incompletePdf = quotePdfFixture(["软件报价单", "交期：按约定", "付款方式：按约定", "报价人：测试售前", "手机：13000000000", "邮箱：sales@example.invalid"]);
  const unknown = await preflight(f.salesA, incompletePdf);
  assert.equal(unknown.body.customer.status, "UNRECOGNIZED");
  assert.equal(unknown.body.amount.status, "UNRECOGNIZED");
  assert.equal(unknown.body.needsReview, true);

  const quote = (await api.request(f.salesA, "/api/uploaded-quotes", "POST", { customerId: customer.id, projectId: project.id, amountCents: 10000000 })).body;
  const upload = (bytes, { previous = null, amount = undefined, etag = undefined, confirmed = false } = {}) => {
    const form = new FormData(); form.set("targetType", "QUOTE_VERSION"); form.set("targetId", quote.id); form.set("requestKey", randomUUID());
    if (previous) { form.set("attachmentId", previous.id); form.set("expectedCurrentVersionId", previous.currentVersionId); }
    if (amount !== undefined) { form.set("amountCents", String(amount)); form.set("expectedDraftEtag", String(etag)); }
    if (confirmed) form.set("bindingReviewConfirmed", "true");
    form.set("file", new Blob([bytes]), "报价.pdf");
    return api.request(f.salesA, "/api/attachments/upload", "POST", form);
  };
  const rejected = await upload(mismatch);
  assert.equal(rejected.body.error.code, "QUOTE_BINDING_MISMATCH");
  assert.equal(rejected.body.error.details.length, 2);
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM business_attachments WHERE target_id = ?`).get(quote.id).n, 0);
  const withoutBank = quoteBindingPdfFixture({ customer: customer.fullName, omit: ["开户行"] });
  const preflightMissing = await preflight(f.salesA, withoutBank);
  assert.ok(preflightMissing.body.fixedFields.issues.some(issue => issue.field === "开户行"));
  const rejectedMissing = await upload(withoutBank, { confirmed: true });
  assert.equal(rejectedMissing.body.error.code, "QUOTE_FIXED_FIELDS_REQUIRED");
  assert.ok(rejectedMissing.body.error.details.some(issue => /开户行/.test(issue.message)));
  const unconfirmed = await upload(incompletePdf, { confirmed: true });
  assert.equal(unconfirmed.body.error.code, "QUOTE_FIXED_FIELDS_REQUIRED");
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM business_attachments WHERE target_id = ?`).get(quote.id).n, 0);
  const attached = await upload(pdf);
  assert.equal(attached.status, 201);
  assert.equal(attached.body.bindingCheck.hasMismatch, false);
  const badAmount = await api.request(f.salesA, `/api/uploaded-quotes/${quote.id}`, "PATCH", { amountCents: 12000000, expectedDraftEtag: quote.draftEtag });
  assert.equal(badAmount.body.error.code, "QUOTE_BINDING_MISMATCH");
  assert.equal(f.db.prepare(`SELECT final_discount_cents FROM quote_versions WHERE id = ?`).get(quote.id).final_discount_cents, 10000000);

  const optionA = quoteBindingPdfFixture({ customer: customer.fullName, gross: "110,000.00" });
  const optionB = quoteBindingPdfFixture({ customer: customer.fullName, gross: "120,000.00" });
  const outcomes = await Promise.all([
    upload(optionA, { previous: attached.body, amount: 11000000, etag: quote.draftEtag }),
    upload(optionB, { previous: attached.body, amount: 12000000, etag: quote.draftEtag })
  ]);
  assert.deepEqual(outcomes.map(result => result.status).sort(), [201, 409]);
  const selectedAmount = f.db.prepare(`SELECT final_discount_cents FROM quote_versions WHERE id = ?`).get(quote.id).final_discount_cents;
  const current = (await api.request(f.salesA, `/api/attachments?targetType=QUOTE_VERSION&targetId=${quote.id}`)).body.items[0];
  const currentBytes = (await api.request(f.salesA, `/api/attachments/${current.id}/download`)).body;
  assert.ok(currentBytes.equals(selectedAmount === 11000000 ? optionA : optionB));
  assert.ok((await api.request(f.salesA, `/api/attachments/${current.id}/download?versionId=${attached.body.currentVersionId}`)).body.equals(pdf));
});

test("总额无法识别时允许上传和送审，并在快照中保留金额未核对状态", async t => {
  const f = setupBase(), storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-unknown-total-"));
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA, f.manager, f.generalManager, f.vp], { storagePath, dataMode: "TEST", launchProfile: "CORE" });
  t.after(async () => { await api.close(); f.db.close(); fs.rmSync(storagePath, { recursive: true, force: true }); });
  const { customer, project } = addCustomerAndProject(f.db, f.salesA, "金额未识别");
  const quote = (await api.request(f.salesA, "/api/uploaded-quotes", "POST", { customerId: customer.id, projectId: project.id, amountCents: 10000000 })).body;
  const bytes = quotePdfFixture([`客户：${customer.fullName}`, "日期：2026-11-03", "开户行：虚构银行", "账号：100000000000", "报价人：测试售前", "手机：13000000000", "邮箱：sales@example.invalid"]);
  const form = new FormData(); form.set("targetType", "QUOTE_VERSION"); form.set("targetId", quote.id); form.set("requestKey", randomUUID()); form.set("file", new Blob([bytes]), "报价.pdf");
  const uploaded = await api.request(f.salesA, "/api/attachments/upload", "POST", form);
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.bindingCheck.customer.status, "MATCH");
  assert.equal(uploaded.body.bindingCheck.amount.status, "UNRECOGNIZED");
  const submitted = await api.request(f.salesA, `/api/quote-versions/${quote.id}/submit`, "POST", {});
  assert.equal(submitted.status, 200);
  const snapshot = JSON.parse(f.db.prepare(`SELECT snapshot_json FROM quote_versions WHERE id = ?`).get(quote.id).snapshot_json);
  assert.equal(snapshot.uploadedSource.amountVerification, "UNRECOGNIZED");
  assert.equal(snapshot.uploadedSource.recordedAmountCents, 10000000);
  assert.equal(snapshot.uploadedSource.confirmedAmountCents, null);
  assert.equal(snapshot.documentReview.manualConfirmed, false);
});

test("已有未发送报价若客户和金额不符，查看时提示且服务端拒绝送审", async t => {
  const f = setupBase(), storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-old-binding-"));
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA, f.salesB], { storagePath, dataMode: "TEST", launchProfile: "CORE" });
  t.after(async () => { await api.close(); f.db.close(); fs.rmSync(storagePath, { recursive: true, force: true }); });
  const { customer, project } = addCustomerAndProject(f.db, f.salesA, "旧报价");
  const quote = (await api.request(f.salesA, "/api/uploaded-quotes", "POST", { customerId: customer.id, projectId: project.id, amountCents: 20000000 })).body;
  // Construct an old record through the generic attachment path, as it existed before the new gate.
  const oldPdf = quoteBindingPdfFixture({ customer: "另一个虚构客户有限公司" });
  const attachment = await uploadAttachment(f.db, { storagePath }, f.salesA, { targetType: "CUSTOMER", targetId: customer.id }, { originalname: "历史报价.pdf", mimetype: "application/pdf", buffer: oldPdf });
  f.db.prepare(`UPDATE business_attachments SET target_type = 'QUOTE_VERSION', target_id = ? WHERE id = ?`).run(quote.id, attachment.id);
  const check = await api.request(f.salesA, `/api/quote-versions/${quote.id}/binding-check`);
  assert.equal(check.body.binding.customer.status, "MISMATCH");
  assert.equal(check.body.binding.amount.status, "MISMATCH");
  assert.equal((await api.request(f.salesB, `/api/quote-versions/${quote.id}/binding-check`)).status, 404);
  const submit = await api.request(f.salesA, `/api/quote-versions/${quote.id}/submit`, "POST", { amountConfirmed: true, reviewConfirmed: true });
  assert.equal(submit.body.error.code, "QUOTE_BINDING_MISMATCH");
  assert.equal(f.db.prepare(`SELECT status FROM quote_versions WHERE id = ?`).get(quote.id).status, "DRAFT");
  assert.ok((await api.request(f.salesA, `/api/attachments/${attachment.id}/download`)).body.equals(oldPdf));
});
