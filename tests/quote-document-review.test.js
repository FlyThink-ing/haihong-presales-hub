import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import ExcelJS from "exceljs";
import { parseQuoteDocument } from "../server/quote-document-parser.js";
import { uploadAttachment } from "../server/attachment-service.js";
import { checkMainQuote, __test as checks } from "../server/quote-document-checks.js";
import { QUOTE_COMPANY } from "../server/quote-service.js";
import { quoteBoundaryOptions, quoteReviewPanel } from "../web/quote-document-review.js";
import { addCustomerAndProject, setupBase, startTestApi } from "./test-utils.js";
import { quotePdfFixture, quoteBindingPdfFixture } from "./pdf-fixtures.js";
import { sha256 } from "../server/security.js";

const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const EXCEL = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const cells = values => new TableRow({ children: values.map(value => new TableCell({ children: [new Paragraph(value)] })) });
const table = rows => new Table({ rows: rows.map(cells) });
const head = ["序号", "项目/型号", "单位", "数量", "未税单价(元)", "未税金额(元)", "含税金额(元)", "备注"];
const detailHead = ["序号", "项目", "子项", "单位", "数量", "未税单价(元)", "未税金额(元)", "含税金额(元)", "备注"];
const context = { company: { name: QUOTE_COMPANY.name, bankName: "虚构银行", bankAccount: "1234567890" }, customerName: "虚构客户有限公司",
  declaredAmountCents: 10000000, sellers: [{ displayName: "虚构售前", phone: "13000000000", email: "sales@example.invalid" }] };

async function wordQuote({ detailGross = "100,000.00", detailUnit = "项", uppercase = "壹拾万元整", email = "sales@example.invalid", withFooter = true, splitEmail = false } = {}) {
  const paragraphs = [
    "软件报价单", `报价单位：${QUOTE_COMPANY.name}`, "客户：虚构客户有限公司", "编号：BJ-TEST", "日期：2026-11-02", "有效期：30天", "客户邮箱：buyer@example.invalid", "项目总价"
  ].map(text => new Paragraph(text));
  paragraphs.push(table([head, ["1", "虚构软件", "套", "1", "88,495.58", "88,495.58", "100,000.00", ""], ["合计：", "88,495.58", "100,000.00"]]));
  paragraphs.push(new Paragraph("项目费用明细"));
  paragraphs.push(table([detailHead, ["1", "软件", "虚构子项", detailUnit, "1", "88,495.58", "88,495.58", detailGross, ""], ["合计：", "88,495.58", detailGross]]));
  for (const text of [`含13%增值税，合计金额（大写）：${uppercase}`, "交期：按约定", "付款方式：按约定", "开户行：虚构银行", "账号：1234567890", "如有疑义请联系，我们将竭诚为您服务！", "报价人：虚构售前", "手机：13000000000"]) paragraphs.push(new Paragraph(text));
  if (withFooter) paragraphs.push(splitEmail ? new Paragraph({ children: [new TextRun("邮箱：sales@"), new TextRun({ text: "example.invalid", break: 1 })] }) : new Paragraph(`邮箱：${email}`));
  paragraphs.push(new Paragraph("附件一虚构清单"));
  paragraphs.push(new Paragraph("客户：不应参与校核的附件客户"));
  paragraphs.push(new Paragraph("报价人：附件人员 邮箱：wrong@example.invalid 金额 999999999.00"));
  return Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] }));
}

async function excelQuote() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("报价");
  for (const text of ["软件报价单", `报价单位：${QUOTE_COMPANY.name}`, "客户：虚构客户有限公司", "编号：BJ-TEST", "日期：2026-11-02", "有效期：30天", "项目总价"]) sheet.addRow([text]);
  sheet.addRow(head);
  sheet.addRow(["1", "虚构软件", "套", "1", "88,495.58", "88,495.58", "100,000.00", ""]);
  sheet.addRow(["合计：", "88,495.58", "100,000.00"]);
  sheet.addRow(["项目费用明细"]);
  sheet.addRow(detailHead);
  sheet.addRow(["1", "软件", "子项", "项", "1", "88,495.58", "88,495.58", "100,000.00", ""]);
  sheet.addRow(["合计：", "88,495.58", "100,000.00"]);
  for (const text of ["含13%增值税，合计金额（大写）：壹拾万元整", "交期：按约定", "付款方式：按约定", "开户行：虚构银行", "账号：1234567890", "我们将竭诚为您服务", "报价人：虚构售前", "手机：13000000000"]) sheet.addRow([text]);
  sheet.addRow(["邮箱：", "sales@example.invalid", "附件一：虚构明细"]);
  for (let row = 0; row < 520; row++) sheet.addRow([`附件内容${row}`]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("Word 只检查报价人邮箱之前的主报价，并识别准确金额及大写", async () => {
  const parsed = await parseQuoteDocument({ buffer: await wordQuote(), mimeType: WORD });
  assert.notEqual(parsed.boundary.endIndex, null);
  assert.match(parsed.units[parsed.boundary.endIndex].text, /邮箱/);
  const result = checkMainQuote(parsed, parsed.boundary.endIndex, context);
  assert.equal(result.errorCount, 0, JSON.stringify(result.issues));
  assert.equal(result.recognizedTotals.summaryCents, 10000000);
  assert.equal(result.recognizedTotals.detailCents, 10000000);
  assert.equal(result.recognizedTotals.finalCents, 10000000);
  assert.ok(result.issues.some(issue => issue.code === "VISUAL"));
  assert.ok(!JSON.stringify(result).includes("不应参与校核"));
});

test("报价人邮箱手动换行时包含完整地址，不把后续附件纳入检查", async () => {
  const parsed = await parseQuoteDocument({ buffer: await wordQuote({ splitEmail: true }), mimeType: WORD });
  assert.match(parsed.units[parsed.boundary.endIndex].text, /^example\.invalid$/);
  const result = checkMainQuote(parsed, parsed.boundary.endIndex, context);
  assert.ok(!result.issues.some(issue => issue.code === "EMAIL_FORMAT" || issue.code === "SELLER_EMAIL"));
  assert.equal(result.errorCount, 0, JSON.stringify(result.issues));
});

test("金额、大写错误可定位，缺少邮箱时需选择主报价边界", async () => {
  const parsed = await parseQuoteDocument({ buffer: await wordQuote({ detailGross: "99,999.00", uppercase: "玖万元整" }), mimeType: WORD });
  const result = checkMainQuote(parsed, parsed.boundary.endIndex, context);
  assert.ok(result.issues.some(item => item.code === "SUMMARY_DETAIL" && item.severity === "ERROR"));
  assert.ok(result.issues.some(item => item.code === "UPPERCASE_MISMATCH" && item.severity === "ERROR"));
  assert.equal(checks.upperCents("壹亿贰仟叁佰万元零伍分"), 12300000005);
  assert.equal(checks.upperCents("壹佰佰元整"), null);
  const missingUnit = await parseQuoteDocument({ buffer: await wordQuote({ detailUnit: "" }), mimeType: WORD });
  assert.ok(checkMainQuote(missingUnit, missingUnit.boundary.endIndex, context).issues.some(item => item.code === "UNIT_REQUIRED" && item.severity === "ERROR"));
  const missing = await parseQuoteDocument({ buffer: await wordQuote({ withFooter: false }), mimeType: WORD });
  assert.equal(missing.boundary.endIndex, null);
  const manuallyChecked = checkMainQuote(missing, missing.units.length - 2, context);
  assert.ok(manuallyChecked.issues.some(item => item.code === "FIELD_报价人邮箱"));
});

test("优惠金额与分表合计按可识别程度核对，避免误报", () => {
  const rows = [head, ["1", "软件", "套", "1", "88,495.58", "88,495.58", "100,000.00", ""],
    ["合计：", "88,495.58", "100,000.00"], ["优惠后合计：", "79,646.02", "90,000.00", "优惠金额：10,000.00"]];
  const units = rows.flatMap((row, index) => row.map((text, column) => ({ tableId: 1, row: index + 1, column: column + 1, text, location: `表1第${index + 1}行` })));
  const issues = [];
  const totals = checks.tableChecks(units, (...issue) => issues.push(issue), "DOCX");
  assert.equal(totals.summary, 10000000);
  assert.equal(totals.final, 9000000);
  assert.ok(!issues.some(issue => issue[1] === "DISCOUNT_AMOUNT"));
  const second = units.slice(0, head.length + 8 + 3).map(unit => ({ ...unit, tableId: 2 }));
  const manyIssues = [];
  const many = checks.tableChecks([...units, ...second], (...issue) => manyIssues.push(issue), "DOCX");
  assert.equal(many.summary, null);
  assert.ok(manyIssues.some(issue => issue[1] === "MULTIPLE_TOTALS" && issue[0] === "REVIEW"));
});

test("Excel 同行切分邮箱与附件，附件超过 500 行仍不参与主报价校核", async () => {
  const parsed = await parseQuoteDocument({ buffer: await excelQuote(), mimeType: EXCEL });
  assert.notEqual(parsed.boundary.endIndex, null);
  assert.match(parsed.units[parsed.boundary.endIndex].location, /!B\d+$/);
  assert.ok(parsed.units.length < 80);
  const result = checkMainQuote(parsed, parsed.boundary.endIndex, context);
  assert.equal(result.errorCount, 0, JSON.stringify(result.issues));
  assert.equal(result.recognizedTotals.finalCents, 10000000);
});

test("Excel 公式缓存只作为待核对依据，不把缓存差异直接定为错误", async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await excelQuote());
  workbook.getWorksheet("报价").getCell("G9").value = { formula: "SUM(1,2)", result: 99999 };
  const parsed = await parseQuoteDocument({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), mimeType: EXCEL });
  const result = checkMainQuote(parsed, parsed.boundary.endIndex, context);
  assert.ok(result.issues.some(item => item.code === "FORMULA" && item.severity === "REVIEW"));
  assert.ok(result.issues.some(item => item.code === "TOTAL_ROW" && item.severity === "REVIEW"));
  const unrelated = new ExcelJS.Workbook();
  await unrelated.xlsx.load(await excelQuote());
  unrelated.getWorksheet("报价").getCell("Z5").value = { formula: "1+1", result: 2 };
  unrelated.getWorksheet("报价").getCell("H13").value = "99,999.00";
  const parsedOther = await parseQuoteDocument({ buffer: Buffer.from(await unrelated.xlsx.writeBuffer()), mimeType: EXCEL });
  const resultOther = checkMainQuote(parsedOther, parsedOther.boundary.endIndex, context);
  assert.ok(resultOther.issues.some(item => item.code === "TOTAL_ROW" && item.severity === "ERROR"));
});

test("范围选择与检查结果转义文件内容，便于在弹窗中展示", () => {
  const html = quoteBoundaryOptions({ units: [{ index: 0, location: "第1段", text: '<img src=x onerror="x">' }], suggestedEndIndex: 0, reason: "已识别" });
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img/);
  const report = quoteReviewPanel({ id: "id", boundaryLocation: "第1段", errorCount: 1, reviewCount: 0, issues: [{ severity: "ERROR", title: "<script>", location: "第1段", message: "<unsafe>" }] });
  assert.match(report, /&lt;script&gt;/); assert.doesNotMatch(report, /<script>/);
});

test("上传报价送审直接展示原件和审批记录，不要求手动检查或重复确认", async () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const match = source.match(/async function openUploadedQuoteSubmitDialog\([\s\S]*?\n\}/);
  assert.ok(match);
  let dialog, sent;
  const sandbox = vm.createContext({
    api: async (route, options = {}) => {
      if (route.endsWith("/binding-check")) return { binding: null };
      if (route.endsWith("/submit")) { sent = JSON.parse(options.body); return {}; }
      throw new Error(`意外请求 ${route}`);
    },
    openDialog: (title, html, options) => { dialog = { title, html, options }; },
    quoteReviewPanel, quoteBindingPanel: () => "",
    escapeHtml: value => String(value), quotePaperContent: () => "报价原文件", quoteHandoffSection: () => "", quoteVersionArchive: () => "", quoteApprovalTimeline: () => "", attachmentBlock: () => "", quoteUploadedWordSource: () => "",
    closeDialog() {}, showToast() {}, refreshQuoteContext: async () => {}
  });
  vm.runInContext(match[0], sandbox);
  sandbox.quote = { id: "quote-1", attachments: { items: [] } };
  await vm.runInContext("openUploadedQuoteSubmitDialog(quote)", sandbox);
  assert.match(dialog.html, /报价原文件/);
  assert.doesNotMatch(dialog.html, /主报价检查|uploaded-review-confirm|uploaded-quote-confirm/);
  await dialog.options.onSubmit();
  assert.deepEqual(sent, {});
});

test("范围选择使用已上传的版本，并在原弹窗展示新检查结果", async () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const match = source.match(/async function openQuoteDocumentReview\([\s\S]*?\n\}/);
  assert.ok(match);
  const preview = { attachmentVersionId: "file-v1", draftEtag: 2, suggestedEndIndex: 1, reason: "已识别", units: [{ index: 0, location: "第1段", text: "报价人" }, { index: 1, location: "第2段", text: "邮箱" }] };
  const result = { id: "check-1", boundaryLocation: "第2段", issues: [], errorCount: 0, reviewCount: 1 };
  const slot = { dataset: { quoteReviewSlot: "quote-1" }, innerHTML: "" };
  const confirm = { checked: true };
  let selection = "", dialog, sent;
  const sandbox = vm.createContext({
    api: async (route, options = {}) => {
      if (route.endsWith("/boundary")) return preview;
      if (route.endsWith("/document-review")) { sent = JSON.parse(options.body); return result; }
      throw new Error(`意外请求 ${route}`);
    }, quoteBoundaryOptions, quoteReviewPanel,
    openDialog: (title, html, options) => { dialog = { title, html, options }; },
    document: { querySelector: key => key === "#quote-review-boundary" ? { value: selection } : key === "#uploaded-review-confirm" ? confirm : null,
      querySelectorAll: () => [slot] },
    closeDialog() {}, showToast() {}
  });
  vm.runInContext(match[0], sandbox);
  await vm.runInContext('openQuoteDocumentReview("quote-1")', sandbox);
  await assert.rejects(() => dialog.options.onSubmit(), /结束位置/);
  selection = "1";
  await dialog.options.onSubmit();
  assert.equal(sent.attachmentVersionId, "file-v1");
  assert.equal(sent.draftEtag, 2);
  assert.equal(sent.endIndex, 1);
  assert.match(slot.innerHTML, /check-1/);
  assert.equal(confirm.checked, false);
});

test("上传报价自动检查绑定当前文件和负责人，三级审批保留原件及自动检查结果", async t => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-quote-review-"));
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA, f.salesB, f.manager, f.generalManager, f.vp], { storagePath, dataMode: "TEST", launchProfile: "CORE" });
  t.after(async () => { await api.close(); f.db.close(); fs.rmSync(storagePath, { recursive: true, force: true }); });
  const { customer, project } = addCustomerAndProject(f.db, f.salesA, "校核");
  const created = await api.request(f.salesA, "/api/uploaded-quotes", "POST", { customerId: customer.id, projectId: project.id, amountCents: 10000000 });
  const id = created.body.id, url = `/api/quote-versions/${id}`;
  const upload = (bytes, previous = null) => {
    const form = new FormData(); form.set("targetType", "QUOTE_VERSION"); form.set("targetId", id); form.set("requestKey", randomUUID());
    if (previous) { form.set("attachmentId", previous.id); form.set("expectedCurrentVersionId", previous.currentVersionId); }
    form.set("file", new Blob([bytes]), "虚构报价.pdf");
    return api.request(f.salesA, "/api/attachments/upload", "POST", form);
  };
  const firstDoc = quoteBindingPdfFixture({ customer: customer.fullName });
  const first = await upload(firstDoc);
  assert.equal(first.status, 201);
  assert.equal((await api.request(f.salesB, `${url}/document-review/boundary`)).status, 404);
  assert.equal((await api.request(f.manager, `${url}/document-review/boundary`)).status, 403);
  const firstBoundary = (await api.request(f.salesA, `${url}/document-review/boundary`)).body;
  const run = body => api.request(f.salesA, `${url}/document-review`, "POST", body);
  const oldReview = await run({ endIndex: firstBoundary.suggestedEndIndex, attachmentVersionId: firstBoundary.attachmentVersionId, draftEtag: firstBoundary.draftEtag });
  assert.equal(oldReview.status, 201);
  const transferUrl = `/api/customers/${customer.id}/transfer`;
  assert.equal((await api.request(f.admin, transferUrl, "POST", { newOwnerId: f.salesB.id, reason: "虚构客户交接" })).status, 200);
  assert.equal((await api.request(f.salesA, `${url}/document-review`)).status, 404);
  assert.equal((await api.request(f.salesB, `${url}/document-review`)).body.review, null);
  assert.equal((await api.request(f.admin, transferUrl, "POST", { newOwnerId: f.salesA.id, reason: "虚构客户转回" })).status, 200);
  assert.equal((await api.request(f.salesA, `${url}/document-review`)).body.review, null);
  const wrongAmount = await api.request(f.salesA, `/api/uploaded-quotes/${id}`, "PATCH", { amountCents: 9000000, expectedDraftEtag: firstBoundary.draftEtag });
  assert.equal(wrongAmount.body.error.code, "QUOTE_BINDING_MISMATCH");
  const invalid = await upload(quoteBindingPdfFixture({ customer: customer.fullName, omit: ["开户行"] }), first.body);
  assert.equal(invalid.body.error.code, "QUOTE_FIXED_FIELDS_REQUIRED");
  const correctedDoc = quoteBindingPdfFixture({ customer: customer.fullName, gross: "100000.00" });
  const corrected = await upload(correctedDoc, first.body);
  assert.equal(corrected.status, 201);
  assert.equal((await api.request(f.salesA, `${url}/document-review`)).body.review, null);
  assert.equal((await run({ endIndex: firstBoundary.suggestedEndIndex, attachmentVersionId: firstBoundary.attachmentVersionId, draftEtag: firstBoundary.draftEtag })).status, 409);
  const accepted = await api.request(f.salesA, `${url}/submit`, "POST", {});
  assert.equal(accepted.status, 200);
  const approvedReview = await api.request(f.manager, `${url}/document-review`);
  assert.equal(approvedReview.body.review.inspectionMode, "AUTO_FIXED_FIELDS");
  assert.equal(approvedReview.body.review.manualConfirmed, false);
  assert.notEqual(approvedReview.body.review.id, oldReview.body.id);
  assert.equal((await api.request(f.salesB, `${url}/document-review`)).status, 404);
  for (const actor of [f.manager, f.generalManager, f.vp]) assert.equal((await api.request(actor, `${url}/decision`, "POST", { decision: "APPROVED", comment: "已审核" })).status, 200);
  assert.equal((await api.request(f.salesA, `${url}/document-review`)).body.review.id, approvedReview.body.review.id);
  const approved = (await api.request(f.salesA, url)).body;
  assert.ok((await api.request(f.salesA, `/api/attachment-snapshots/${approved.attachments.items[0].id}/download`)).body.equals(correctedDoc));
  assert.ok((await api.request(f.salesA, `/api/attachments/${first.body.id}/download?versionId=${first.body.currentVersionId}`)).body.equals(firstDoc));
  const newQuote = (await api.request(f.salesA, "/api/uploaded-quotes", "POST", { customerId: customer.id, projectId: project.id, amountCents: 10000000 })).body;
  const excelForm = new FormData(); excelForm.set("targetType", "QUOTE_VERSION"); excelForm.set("targetId", newQuote.id); excelForm.set("requestKey", randomUUID());
  excelForm.set("file", new Blob([await excelQuote()]), "虚构报价.xlsx");
  assert.equal((await api.request(f.salesA, "/api/attachments/upload", "POST", excelForm)).body.error.code, "QUOTE_ATTACHMENT_FORMAT_INVALID");
  const legacyExcel = await uploadAttachment(f.db, { storagePath }, f.salesA, { targetType: "CUSTOMER", targetId: customer.id }, {
    originalname: "虚构报价.xlsx", mimetype: EXCEL, buffer: await excelQuote()
  });
  f.db.prepare(`UPDATE business_attachments SET target_type = 'QUOTE_VERSION', target_id = ? WHERE id = ?`).run(newQuote.id, legacyExcel.id);
  assert.equal((await api.request(f.salesA, `/api/quote-versions/${newQuote.id}/document-review/boundary`)).body.error.code, "UPLOADED_QUOTE_SOURCE_REQUIRED");
  assert.equal(sha256((await api.request(f.salesA, `/api/attachments/${legacyExcel.id}/download`)).body), legacyExcel.currentVersion.sha256);
});
