import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { Document, Packer, Paragraph } from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { __test as docxTest } from "../server/docx-service.js";
import { createQuote, decideQuote, getQuoteVersion, submitQuote } from "../server/quote-service.js";
import { sha256 } from "../server/security.js";
import { quoteDetailRoundingAdjustment, quoteDetailRoundingAllocations, quoteDetailTotalsMismatch, quoteDetailTotalsMismatchMessage } from "../web/quote-math.js";
import { addCustomerAndProject, sampleQuoteInput, setupBase, startTestApi } from "./test-utils.js";

const row = (name, taxedAmountCents, quantityMilli = 1000) => ({
  category: "项目", itemName: name, unit: "项", quantityMilli,
  pricingMode: "TAXED_TOTAL", taxRateBps: 1300, taxedAmountCents
});
function removeTempDirectory(directory) {
  const resolved = path.resolve(directory);
  const allowedPrefix = path.join(path.resolve(os.tmpdir()), "hh-");
  assert.ok(resolved.startsWith(allowedPrefix));
  fs.rmSync(resolved, { recursive: true, force: true });
}

test("截图填写方式通过报价页面收集并提交，金额含千分位也可保存", async () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const names = ["escapeHtml", "parseScaledDecimal", "quoteCustomerContact", "quoteEditorRow", "quoteRowHasContent", "collectQuoteItems", "collectQuoteMetadata", "collectQuotePayload", "plainQuoteMoney", "quoteAmountUppercase", "updateQuoteEditorSummary", "resizeQuoteTextarea", "openQuoteEditor"];
  const functions = names.map(name => {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(match, `${name} 页面函数必须存在`);
    return match[0];
  }).join("\n");
  const element = (value = "") => ({ value, dataset: {}, textContent: "", listeners: {}, classList: { add() {}, remove() {} }, addEventListener(type, listener) { this.listeners[type] = listener; } });
  const makeRow = (section, values) => {
    const fields = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, element(value)]));
    fields[".qe-unit-preview"] = element(); fields[".qe-untaxed-preview"] = element();
    return { dataset: { quoteSection: section }, querySelector: key => fields[key] || null, querySelectorAll: () => [] };
  };
  const rows = [
    makeRow("SUMMARY", { ".qe-name": "虚构 MES 信息系统", ".qe-unit": "套", ".qe-quantity": "1", ".qe-taxed": "200,000.00", ".qe-tax": "13", ".qe-notes": "" }),
    makeRow("DETAIL", { ".qe-name": "设备对接", ".qe-subitem": "根据现场设备对接", ".qe-unit": "人天", ".qe-quantity": "10", ".qe-taxed": "20,000.00", ".qe-tax": "13", ".qe-notes": "" })
  ];
  const fields = Object.fromEntries(Object.entries({
    "#quote-editor": "", "#quote-customer-display": "虚构云帆制造有限公司", "#quote-contact-name": "", "#quote-contact-phone": "",
    "#quote-seller-name": "虚构售前", "#quote-seller-phone": "13000000000", "#quote-seller-email": "sales@example.invalid",
    "#quote-date": "2026-10-31", "#quote-validity": "30 天", "#quote-delivery": "按合同", "#quote-payment": "按合同",
    "#quote-bank": "虚构银行", "#quote-account": "虚构账号", "#quote-final-price": "", "#quote-notes": "不含第三方接口费用",
    "#quote-subtotal-untaxed": "", "#quote-subtotal-preview": "", "#quote-tax-rate-label": "", "#quote-final-untaxed": "",
    "#quote-discount-note": "", "#quote-detail-untaxed": "", "#quote-detail-preview": "", "#quote-amount-upper": ""
  }).map(([key, value]) => [key, element(value)]));
  let dialog;
  let submitted;
  let customerDialog;
  let scheduled;
  let resumed;
  let previewsRequested = 0;
  let attachmentUploads = 0;
  fields["#quote-customer-options"] = { insertAdjacentHTML() {} };
  fields["#dialog-submit"] = { click() { resumed = dialog.options.onSubmit(); } };
  fields["#pending-quote-files"] = element();
  fields["#pending-quote-file-list"] = element();
  fields["#pending-quote-file-count"] = element();
  fields["#quote-pending-inline"] = { hidden: true, innerHTML: "", querySelectorAll: () => [] };
  fields["#quote-editor"].querySelector = selector => fields[selector] || null;
  const context = vm.createContext({
    state: { user: { displayName: "虚构售前", phone: "13000000000", email: "sales@example.invalid" } },
    document: {
      querySelector: selector => fields[selector] || null,
      querySelectorAll: selector => selector === ".quote-editor-row" ? rows
        : selector.includes('data-quote-section="SUMMARY"') ? [rows[0]]
          : selector.includes('data-quote-section="DETAIL"') ? [rows[1]] : []
    },
    api: async (route, options) => {
      if (route === "/api/customers") return { items: [{ id: "customer", fullName: "虚构云帆制造有限公司" }] };
      if (route === "/api/projects") return { items: [{ id: "project", customerId: "customer" }] };
      if (route === "/api/customers/new-customer/projects") return { id: "new-project", customerId: "new-customer" };
      if (route === "/api/quote-attachments/preview") { previewsRequested += 1; return { html: "<p>虚构附件内容</p>" }; }
      if (route === "/api/attachments/upload") { attachmentUploads += 1; return {}; }
      if (route === "/api/quotes") { submitted = JSON.parse(options.body); return { id: "quote" }; }
      throw new Error(`意外请求 ${route}`);
    },
    openDialog: (title, html, options) => { dialog = { title, html, options }; },
    openCustomerDialog: async options => { customerDialog = options; },
    quoteDetailRoundingAdjustment, quoteDetailRoundingAllocations, quoteDetailTotalsMismatch, quoteDetailTotalsMismatchMessage, closeDialog() {}, showToast() {}, refreshQuoteContext() {}, setTimeout(callback) { scheduled = callback; }, FormData, crypto: { randomUUID }
  });
  vm.runInContext(functions, context);
  await vm.runInContext("openQuoteEditor()", context);
  assert.match(dialog.html, /id="quote-number"[^>]*readonly/);
  assert.equal(fields["#quote-final-price"].value, "200,000.00");
  assert.equal(fields["#quote-subtotal-untaxed"].textContent, "176,991.15");
  assert.equal(fields["#quote-detail-untaxed"].textContent, "17,699.12");
  const pendingFile = new File(["virtual"], "虚构清单.docx");
  fields["#pending-quote-files"].listeners.change({ target: { files: [pendingFile], value: "选择文件" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(previewsRequested, 1);
  assert.equal(fields["#quote-pending-inline"].hidden, false);
  assert.match(fields["#quote-pending-inline"].innerHTML, /虚构清单\.docx/);
  assert.match(fields["#quote-pending-inline"].innerHTML, /quote-inline-attachment-frame/);
  await assert.rejects(() => dialog.options.onSubmit(), /项目总价含税合计为 200,000\.00 元，费用明细含税合计为 20,000\.00 元/);
  assert.equal(submitted, undefined);
  rows[1].querySelector(".qe-taxed").value = "200,000.00";
  vm.runInContext("updateQuoteEditorSummary()", context);
  await dialog.options.onSubmit();
  assert.equal(submitted.customerId, "customer");
  assert.equal(submitted.projectId, "project");
  assert.equal(submitted.items[0].taxedAmountCents, 20_000_000);
  assert.equal(submitted.detailItems[0].taxedAmountCents, 20_000_000);
  assert.equal(submitted.finalDiscountCents, 20_000_000);
  assert.equal("quoteNumber" in submitted, false);
  assert.equal(attachmentUploads, 1);

  submitted = null;
  fields["#quote-customer-display"].value = "虚构新增客户";
  await dialog.options.onSubmit();
  assert.equal(submitted, null);
  assert.equal(customerDialog.initialName, "虚构新增客户");
  await customerDialog.onCreated({ id: "new-customer", fullName: "虚构新增客户" });
  scheduled();
  await resumed;
  assert.equal(submitted.customerId, "new-customer");
  assert.equal(submitted.projectId, "new-project");
  assert.equal(submitted.items[0].taxedAmountCents, 20_000_000);
});

test("按截图金额创建客户和报价，自动编号、必填规则与附件查看形成 HTTP 闭环", async t => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-quote-flow-"));
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA, f.manager], { storagePath, launchProfile: "CORE", dataMode: "TEST" });
  t.after(async () => { await api.close(); f.db.close(); removeTempDirectory(storagePath); });
  await api.request(f.admin, "/api/customer-dictionaries", "POST", { kind: "SOURCE", value: "虚构来源" });
  await api.request(f.admin, "/api/customer-dictionaries", "POST", { kind: "TYPE", value: "虚构类型" });
  const customer = {
    fullName: "虚构云帆制造有限公司", shortName: "", ownerId: f.salesA.id, registeredOn: "2026-10-31", status: "初期接洽",
    source: "虚构来源", customerType: "虚构类型", industry: "装备制造", province: "河南省", city: "鹤壁市", needSummary: "虚构 MES 需求"
  };
  for (const key of ["fullName", "registeredOn", "status", "source", "customerType", "industry", "province", "city", "needSummary"]) {
    const missing = await api.request(f.salesA, "/api/customers", "POST", { ...customer, [key]: "" });
    assert.equal(missing.status, 400, `${key} 应为必填`);
  }
  const noOwner = { ...customer, ownerId: "" };
  assert.equal((await api.request(f.admin, "/api/customers", "POST", noOwner)).status, 400);
  assert.equal((await api.request(f.manager, "/api/customers", "POST", noOwner)).status, 400);
  const otherOwner = await api.request(f.salesA, "/api/customers", "POST", { ...customer, ownerId: f.salesB.id });
  assert.equal(otherOwner.status, 403);
  assert.equal(otherOwner.body.error.code, "OWNER_FORBIDDEN");
  const outsideTeam = await api.request(f.manager, "/api/customers", "POST", { ...customer, ownerId: f.salesOther.id });
  assert.equal(outsideTeam.status, 403);
  assert.equal(outsideTeam.body.error.code, "OWNER_FORBIDDEN");
  const managerCreated = await api.request(f.manager, "/api/customers", "POST", { ...customer, fullName: "虚构经理登记客户", ownerId: f.salesB.id });
  assert.equal(managerCreated.status, 201);
  assert.equal(managerCreated.body.owner.id, f.salesB.id);
  const adminCreated = await api.request(f.admin, "/api/customers", "POST", { ...customer, fullName: "虚构管理员登记客户", ownerId: f.salesA.id });
  assert.equal(adminCreated.status, 201);
  assert.equal(adminCreated.body.owner.id, f.salesA.id);
  const { ownerId: ignoredOwner, ...salesInput } = customer;
  const savedCustomer = await api.request(f.salesA, "/api/customers", "POST", salesInput);
  assert.equal(savedCustomer.status, 201);
  assert.equal(savedCustomer.body.owner.id, f.salesA.id);
  assert.equal(savedCustomer.body.shortName, null);
  const project = await api.request(f.salesA, `/api/customers/${savedCustomer.body.id}/projects`, "POST", { name: "虚构报价", summary: "虚构测试" });
  assert.equal(project.status, 201);
  const input = {
    customerId: savedCustomer.body.id, projectId: project.body.id, quoteNumber: "不得手输",
    items: [{ ...row("虚构 MES 信息系统", 20_000_000), unit: "套" }],
    detailItems: [{ ...row("设备对接", 2_000_000, 10_000), unit: "人天", subitemName: "根据现场设备对接" }],
    finalDiscountCents: 20_000_000, notes: "不含第三方接口费用",
    metadata: { customerName: customer.fullName, customerContactName: "", customerPhone: "" }
  };
  const rejected = await api.request(f.salesA, "/api/quotes", "POST", input);
  assert.equal(rejected.status, 422);
  assert.equal(rejected.body.error.code, "QUOTE_DETAIL_TOTAL_MISMATCH");
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM quotes`).get().n, 0);
  input.detailItems[0].taxedAmountCents = 20_000_000;
  const results = await Promise.all(Array.from({ length: 4 }, () => api.request(f.salesA, "/api/quotes", "POST", input)));
  assert.ok(results.every(item => item.status === 201));
  assert.equal(new Set(results.map(item => item.body.quoteNumber)).size, 4);
  assert.ok(results.every(item => /^BJ-\d{8}-\d{4,}$/.test(item.body.quoteNumber)));
  const quote = results[0].body;
  assert.equal(quote.items[0].untaxedAmountCents, 17_699_115);
  assert.equal(quote.detailItems[0].untaxedAmountCents, 17_699_115);
  assert.equal(quote.detailRoundingAdjustmentCents, 0);
  assert.equal(quote.finalDiscountCents, 20_000_000);
  const failedUpdate = await api.request(f.salesA, `/api/quote-versions/${quote.id}`, "PATCH", { ...input, detailItems: [{ ...input.detailItems[0], taxedAmountCents: 2_000_000 }] });
  assert.equal(failedUpdate.status, 422);
  assert.equal(failedUpdate.body.error.code, "QUOTE_DETAIL_TOTAL_MISMATCH");
  const stillSaved = await api.request(f.salesA, `/api/quote-versions/${quote.id}`);
  assert.equal(stillSaved.body.detailSubtotalTaxedCents, 20_000_000);

  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("虚构 Word 附件内容")] }] }));
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("清单").addRow(["虚构 Excel 附件内容"]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const fileCount = f.db.prepare(`SELECT COUNT(*) AS n FROM stored_files`).get().n;
  for (const [name, buffer, expected] of [["虚构附件.docx", docx, "虚构 Word 附件内容"], ["虚构附件.xlsx", xlsx, "虚构 Excel 附件内容"]]) {
    const form = new FormData();
    form.set("file", new Blob([buffer]), name);
    const preview = await api.request(f.salesA, "/api/quote-attachments/preview", "POST", form);
    if (name.endsWith(".xlsx")) {
      assert.equal(preview.status, 415);
      assert.equal(preview.body.error.code, "QUOTE_ATTACHMENT_FORMAT_INVALID");
    } else {
      assert.equal(preview.status, 200);
      assert.match(preview.body.html, new RegExp(expected));
    }
  }
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM stored_files`).get().n, fileCount);
  const denied = new FormData();
  denied.set("file", new Blob([docx]), "虚构附件.docx");
  assert.equal((await api.request(f.manager, "/api/quote-attachments/preview", "POST", denied)).status, 403);
  const uploaded = new FormData();
  uploaded.set("targetType", "QUOTE_VERSION");
  uploaded.set("targetId", quote.id);
  uploaded.set("requestKey", randomUUID());
  uploaded.set("file", new Blob([docx]), "虚构附件.docx");
  const attachment = await api.request(f.salesA, "/api/attachments/upload", "POST", uploaded);
  assert.equal(attachment.status, 201);
  const savedPreview = await api.request(f.salesA, `/api/attachments/${attachment.body.id}/preview`);
  assert.equal(savedPreview.status, 200);
  assert.equal(savedPreview.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(savedPreview.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.match(savedPreview.body.toString("utf8"), /虚构 Word 附件内容/);
});

test("同税率及同含税总额的尾差分摊到明细，审批快照和 Word 保留分摊结果", async t => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-rounding-"));
  t.after(() => { f.db.close(); removeTempDirectory(storagePath); });
  const { customer, project } = addCustomerAndProject(f.db, f.salesA, "尾差");
  const input = sampleQuoteInput(customer.id, project.id, "ROUNDING");
  input.items = [row("项目总价", 5)];
  input.detailItems = [row("明细一", 1), row("明细二", 4)];
  input.finalDiscountCents = 5;
  const quote = createQuote(f.db, f.salesA, input);
  assert.equal(quote.subtotalUntaxedCents, 4);
  assert.equal(quote.detailItems.reduce((sum, item) => sum + item.untaxedAmountCents, 0), 5);
  assert.equal(quote.detailRoundingAdjustmentCents, -1);
  assert.equal(quote.detailSubtotalUntaxedCents, 4);
  submitQuote(f.db, f.salesA, quote.id);
  for (const actor of [f.manager, f.generalManager, f.vp]) decideQuote(f.db, actor, quote.id, { decision: "APPROVED", comment: "虚构通过" });
  const snapshot = JSON.parse(f.db.prepare(`SELECT snapshot_json FROM quote_versions WHERE id = ?`).get(quote.id).snapshot_json);
  assert.equal(snapshot.roundingPolicy, "ALLOCATE_V2");
  assert.equal(snapshot.detailRoundingAdjustmentCents, -1);
  assert.equal(snapshot.detailRoundingAllocationsCents.reduce((a, b) => a + b, 0), -1);
  assert.equal(snapshot.detailItems.reduce((sum, item, index) => sum + item.untaxedAmountCents + snapshot.detailRoundingAllocationsCents[index], 0), snapshot.subtotalUntaxedCents);
  assert.equal(snapshot.detailSubtotalUntaxedCents, snapshot.subtotalUntaxedCents);
  const { buffer } = await docxTest.approvedQuoteBuffer(f.db, { storagePath }, f.salesA, quote.id);
  const xml = await (await JSZip.loadAsync(buffer)).file("word/document.xml").async("string");
  assert.doesNotMatch(xml, /尾差调整/);

  const unequal = [{ ...snapshot.detailItems[0], taxedAmountCents: 2 }];
  assert.equal(quoteDetailRoundingAdjustment(snapshot.items, unequal), 0);
  const mixedTax = snapshot.detailItems.map((item, index) => index ? { ...item, taxRateBps: 600 } : item);
  assert.equal(quoteDetailRoundingAdjustment(snapshot.items, mixedTax), 0);
});

test("旧版已发送报价沿用原快照的明细合计", t => {
  const f = setupBase();
  t.after(() => f.db.close());
  const { customer, project } = addCustomerAndProject(f.db, f.salesA, "旧版尾差");
  const input = { ...sampleQuoteInput(customer.id, project.id, "LEGACY-ROUNDING"), items: [row("总价", 5)], detailItems: [row("一", 1), row("二", 4)], finalDiscountCents: 5 };
  const quote = createQuote(f.db, f.salesA, input);
  submitQuote(f.db, f.salesA, quote.id);
  const snapshot = JSON.parse(f.db.prepare(`SELECT snapshot_json FROM quote_versions WHERE id = ?`).get(quote.id).snapshot_json);
  snapshot.schemaVersion = 2;
  delete snapshot.roundingPolicy;
  delete snapshot.detailRoundingAdjustmentCents;
  snapshot.detailSubtotalUntaxedCents = 5;
  const serialized = JSON.stringify(snapshot);
  f.db.prepare(`UPDATE quote_versions SET snapshot_json = ?, snapshot_hash = ? WHERE id = ?`).run(serialized, sha256(serialized), quote.id);
  const legacy = getQuoteVersion(f.db, f.salesA, quote.id);
  assert.equal(legacy.roundingPolicy, "LEGACY");
  assert.equal(legacy.detailRoundingAdjustmentCents, 0);
  assert.equal(legacy.detailSubtotalUntaxedCents, 5);
});

test("历史未发送报价的总价与明细不一致时不能直接送审", t => {
  const f = setupBase();
  t.after(() => f.db.close());
  const { customer, project } = addCustomerAndProject(f.db, f.salesA, "历史不一致");
  const input = { ...sampleQuoteInput(customer.id, project.id, "OLD-MISMATCH"), items: [row("总价", 10_000)], detailItems: [row("明细", 10_000)], finalDiscountCents: 10_000 };
  const quote = createQuote(f.db, f.salesA, input);
  f.db.prepare(`UPDATE quote_items SET taxed_amount_cents = 100, untaxed_amount_cents = 88, untaxed_unit_price_cents = 88 WHERE quote_version_id = ? AND section = 'DETAIL'`).run(quote.id);
  assert.throws(() => submitQuote(f.db, f.salesA, quote.id), error => error.code === "QUOTE_DETAIL_TOTAL_MISMATCH");
  assert.equal(getQuoteVersion(f.db, f.salesA, quote.id).status, "DRAFT");
});

test("无优惠时不展示优惠合计，需要时可展开并取消", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const names = ["escapeHtml", "quoteCustomerContact", "quoteReadonlyRows", "quoteReadonlyPaper", "plainQuoteMoney", "quoteAmountUppercase"];
  const functions = names.map(name => source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`))?.[0]).join("\n");
  const context = vm.createContext({});
  vm.runInContext(functions, context);
  context.quote = {
    quoteNumber: "BJ-TEST", customer: { name: "虚构客户" }, metadata: {}, items: [], detailItems: [],
    subtotalUntaxedCents: 8850, subtotalTaxedCents: 10_000, detailSubtotalUntaxedCents: 0, detailSubtotalTaxedCents: 0,
    finalDiscountCents: 10_000, discountAmountCents: 0, roundingPolicy: "RECONCILE_V1"
  };
  assert.doesNotMatch(vm.runInContext("quoteReadonlyPaper(quote)", context), /优惠后合计/);
  context.quote.finalDiscountCents = 9000;
  context.quote.discountAmountCents = 1000;
  assert.match(vm.runInContext("quoteReadonlyPaper(quote)", context), /优惠后合计/);

  const toggleFunction = source.match(/function setQuoteDiscountVisible\([\s\S]*?\n\}/)?.[0];
  assert.ok(toggleFunction);
  const rowElement = { hidden: true };
  const toggle = { textContent: "", setAttribute(name, value) { this[name] = value; } };
  const input = { dataset: { touched: "true" }, focus() { this.focused = true; }, dispatchEvent(event) { this.dispatched = event.type; } };
  let updates = 0;
  const toggleContext = vm.createContext({
    document: { querySelector: selector => ({ "#quote-discount-row": rowElement, "[data-quote-discount-toggle]": toggle, "#quote-final-price": input })[selector] },
    updateQuoteEditorSummary: () => { updates += 1; }, Event
  });
  vm.runInContext(toggleFunction, toggleContext);
  vm.runInContext("setQuoteDiscountVisible(true)", toggleContext);
  assert.equal(rowElement.hidden, false);
  assert.equal(toggle.textContent, "取消优惠");
  assert.equal(input.focused, true);
  vm.runInContext("setQuoteDiscountVisible(false)", toggleContext);
  assert.equal(rowElement.hidden, true);
  assert.equal(toggle.textContent, "+ 设置优惠");
  assert.equal(input.dataset.touched, undefined);
  assert.equal(input.dispatched, "change");
  assert.equal(updates, 1);
});
