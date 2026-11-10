import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Document, Packer, Paragraph } from "docx";
import { createApp } from "../server/app.js";
import { checkMainQuote } from "../server/quote-document-checks.js";
import { parseQuoteDocument } from "../server/quote-document-parser.js";
import { CUSTOMER_DETAIL_TABS } from "../web/ui-policy.js";
import { setupBase, startTestApi } from "./test-utils.js";

const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const fixturePath = fileURLToPath(new URL("../server/templates/quote-template-v1.docx", import.meta.url));
const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

test("标准模板下载继承登录权限，并按原字节提供运维配置的 Word", async t => {
  const f = setupBase();
  const actors = [f.admin, f.salesA, f.manager, f.vp];
  const config = { launchProfile: "CORE", dataMode: "TEST", sessionHours: 1, secureCookie: false, quoteStandardTemplatePath: fixturePath };
  const api = await startTestApi(f.db, f.admin, actors, config);
  const anonymous = createApp({ db: f.db, config }).listen(0, "127.0.0.1");
  await once(anonymous, "listening");
  t.after(async () => {
    await api.close();
    await new Promise(resolve => anonymous.close(resolve));
    f.db.close();
  });
  const route = "/api/quote-template/download";
  const withoutLogin = await fetch(`http://127.0.0.1:${anonymous.address().port}${route}`);
  assert.equal(withoutLogin.status, 401);
  const original = fs.readFileSync(fixturePath);
  for (const actor of actors) {
    const result = await api.request(actor, route);
    assert.equal(result.status, 200);
    assert.match(result.headers.get("content-type"), /wordprocessingml\.document/);
    assert.match(result.headers.get("content-disposition"), /^attachment/);
    assert.match(decodeURIComponent(result.headers.get("content-disposition")), /软件报价单标准模板\.docx/);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.ok(result.body.equals(original));
  }
});

test("识别标准模板中未替换的必填标记，客户联系人和电话仍可留空", async () => {
  const lines = [
    "软件报价单", "客户：{{客户}}", "编号：{{编号}}", "日期：{{日期}}",
    "联系人：{{联系人}}", "客户电话：{{客户电话}}", "项目总价", "项目费用明细",
    "含 13% 增值税，合计金额（大写）：{{大写金额}}", "交期：按合同约定", "付款方式：按合同约定",
    "报价人：{{报价人}}", "电话：{{报价人电话}}", "邮箱：{{报价人邮箱}}"
  ];
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children: lines.map(text => new Paragraph(text)) }] }));
  const parsed = await parseQuoteDocument({ mimeType: mime, buffer });
  assert.ok(parsed.boundary.endIndex !== null);
  const context = { company: {}, customerName: "虚构客户", sellers: [] };
  const initial = checkMainQuote(parsed, parsed.boundary.endIndex, context);
  const markers = initial.issues.filter(issue => issue.code === "STANDARD_TEMPLATE_UNFILLED");
  assert.equal(markers.length, 7);
  for (const label of ["客户名称", "报价编号", "报价日期", "大写金额", "报价人", "报价人电话", "报价人邮箱"]) {
    assert.ok(markers.some(issue => issue.title === `${label}未填写` && issue.severity === "ERROR"), label);
  }
  assert.ok(!markers.some(issue => /联系人|客户电话/.test(issue.title)));

  const replacements = {
    "{{客户}}": "虚构客户", "{{编号}}": "BJ-TEST", "{{日期}}": "2026-11-03", "{{大写金额}}": "零元整",
    "{{报价人}}": "虚构售前", "{{报价人电话}}": "13000000000", "{{报价人邮箱}}": "sales@example.invalid"
  };
  const units = parsed.units.map(unit => ({ ...unit, text: Object.entries(replacements).reduce((text, [from, to]) => text.replaceAll(from, to), unit.text) }));
  units.splice(1, 0, { text: "设备说明：{{客户}}", location: "虚构技术说明" });
  units.push({ text: "客户：{{客户}}", location: "虚构附件" });
  const corrected = checkMainQuote({ ...parsed, units }, parsed.boundary.endIndex + 1, context);
  assert.ok(!corrected.issues.some(issue => issue.code === "STANDARD_TEMPLATE_UNFILLED"));
  assert.ok(units.some(unit => unit.text.includes("{{联系人}}")));
  assert.ok(units.some(unit => unit.text.includes("{{客户电话}}")));
});

test("报价页面隐藏新建入口，售前仍可上传、下载模板并操作历史报价", async () => {
  const head = source.match(/function pageHead\([\s\S]*?\n\}/)?.[0];
  const renderer = source.match(/async function renderQuotes\([\s\S]*?\n\}/)?.[0];
  const statuses = source.match(/const quoteStatusLabels = \{[^;]+\};/)?.[0];
  assert.ok(head && renderer && statuses);
  const quote = { id: "old-quote", quoteNumber: "BJ-OLD", versionLabel: "V1.0", status: "DRAFT", sourceKind: "SYSTEM", customer: { name: "虚构客户" }, subtotalTaxedCents: 20000, finalDiscountCents: 18000, discountAmountCents: 2000 };
  const state = { user: { role: "PRESALES" }, quoteFilters: { query: "", status: "" }, quotes: [quote], runtime: {} };
  const context = vm.createContext({
    state, escapeHtml: value => String(value ?? ""), quoteMatchesFilters: () => true,
    quoteVersionHistoryNote: () => "", formatMoney: cents => `金额${cents}`, quoteStatusLabel: () => "未发送", canDecideQuote: () => false
  });
  vm.runInContext(`${statuses}\n${head}\n${renderer}`, context);
  const content = { innerHTML: "" };
  context.content = content;
  for (const role of ["PRESALES", "ADMIN", "MANAGER", "VP"]) {
    state.user.role = role;
    await vm.runInContext("renderQuotes(content, { reload: false })", context);
    assert.match(content.innerHTML, /data-action="download-quote-template"/);
    const filter = content.innerHTML.match(/<select id="quote-status-filter">([\s\S]*?)<\/select>/)?.[1];
    assert.ok(filter);
    assert.deepEqual([...filter.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map(match => match[1]), ["全部状态", "未发送", "待我审批", "审核通过"]);
    assert.doesNotMatch(content.innerHTML, /data-action="new-quote"|page-head-sticky/);
    assert.match(content.innerHTML, /data-quote-view="old-quote"/);
    assert.match(content.innerHTML, /<th>报价编号<\/th><th>客户<\/th><th>最终报价（含税）<\/th>/);
    assert.match(content.innerHTML, /data-label="报价编号"[^>]*><div>BJ-OLD · V1\.0/);
    assert.match(content.innerHTML, /data-label="最终报价（含税）"[^>]*><div><strong>金额18000<\/strong>/);
    assert.match(content.innerHTML, /优惠 金额2000/);
    assert.doesNotMatch(content.innerHTML, /<th>含税合计<\/th>|<th>报价金额<\/th>|金额20000/);
    if (["PRESALES", "ADMIN"].includes(role)) {
      assert.match(content.innerHTML, /data-action="new-uploaded-quote"/);
      assert.match(content.innerHTML, /data-quote-edit="old-quote"/);
    } else {
      assert.doesNotMatch(content.innerHTML, /data-action="new-uploaded-quote"/);
    }
    assert.doesNotMatch(content.innerHTML, /id="quote-mine-filter"|只看待我审批/);
  }
  state.user.role = "PRESALES";
  state.quotes = [{ ...quote, sourceKind: "UPLOADED" }];
  await vm.runInContext("renderQuotes(content, { reload: false })", context);
  assert.match(content.innerHTML, />重新上传<\/button>/);
  assert.doesNotMatch(content.innerHTML, />编辑<\/button>|检查主报价|下载原报价单|<small>上传报价<\/small>/);
  state.quotes = [{ ...quote, status: "APPROVED", sourceKind: "UPLOADED" }];
  await vm.runInContext("renderQuotes(content, { reload: false })", context);
  assert.match(content.innerHTML, /调整价格/);
  assert.doesNotMatch(content.innerHTML, /下载原报价单|检查主报价/);
  state.quotes = [{ ...quote, status: "APPROVED", sourceKind: "SYSTEM" }];
  await vm.runInContext("renderQuotes(content, { reload: false })", context);
  assert.match(content.innerHTML, /调整价格/);
  assert.doesNotMatch(content.innerHTML, /data-quote-export|导出 Word/);
  // 两种客户档案入口不再渲染网页创建报价按钮；旧编辑器和后端能力保留。
  assert.doesNotMatch(source, /<button[^>]*data-customer-quote-new=/);
  assert.match(source, /async function openQuoteEditor\(/);
  assert.match(source, /data-quote-edit=/);
});

test("精简版和完整版客户档案均隐藏创建入口并保留历史报价操作", async () => {
  const core = source.match(/async function openCoreCustomerDetail\([\s\S]*?\n\}/)?.[0];
  const full = source.match(/async function openCustomerDetail\([\s\S]*?\n\}/)?.[0];
  assert.ok(core && full);
  const quote = { id: "old-quote", quoteNumber: "BJ-OLD", versionLabel: "V1.0", status: "DRAFT", project: { name: "虚构项目" }, finalDiscountCents: 0 };
  const customer = { id: "customer", fullName: "虚构客户", status: "初期接洽", owner: { displayName: "虚构售前" }, needSummary: "虚构需求" };
  const workspace = { customer, permissions: { canMaintainActivity: true }, projects: [], contacts: [], followups: [], reminders: [], surveys: [], quotes: [quote], contracts: [], files: [], businessAttachments: {}, auditLogs: [] };
  const dialogs = [];
  const context = vm.createContext({
    state: {}, api: async () => workspace, isCoreLaunch: () => false, CUSTOMER_DETAIL_TABS,
    document: { querySelector: () => ({ isConnected: true }) }, openDialog: (_title, html) => dialogs.push(html),
    escapeHtml: value => String(value ?? ""), formatTime: () => "—", formatMoney: () => "0.00",
    customerTabButton: () => "", activateCustomerTab: () => {}, quoteStatusLabel: () => "未发送",
    canDecideQuote: () => false, attachmentBlock: () => ""
  });
  vm.runInContext(`${core}\n${full}`, context);
  for (const name of ["openCoreCustomerDetail", "openCustomerDetail"]) {
    await vm.runInContext(`${name}("customer", "quotes")`, context);
    const html = dialogs.at(-1);
    assert.doesNotMatch(html, /data-customer-quote-new|\+ 创建报价/);
    assert.match(html, /data-quote-view="old-quote"/);
    assert.match(html, /data-quote-edit="old-quote"/);
    assert.match(html, /data-quote-submit="old-quote"/);
  }
});

test("模板下载成功触发 Word 保存，错误时不保存错误内容", async () => {
  const download = source.match(/async function downloadQuoteTemplate\([\s\S]*?\n\}/)?.[0];
  assert.ok(download);
  const steps = [];
  const link = { click: () => steps.push("click"), remove: () => steps.push("remove") };
  const good = vm.createContext({
    fetch: async path => { assert.equal(path, "/api/quote-template/download"); return { ok: true, blob: async () => "虚构模板内容" }; },
    URL: { createObjectURL: () => "blob:template", revokeObjectURL: value => { assert.equal(value, "blob:template"); steps.push("revoke"); } },
    document: { createElement: () => link, body: { append: value => { assert.equal(value, link); steps.push("append"); } } },
    setTimeout: callback => callback()
  });
  vm.runInContext(download, good);
  await vm.runInContext("downloadQuoteTemplate()", good);
  assert.equal(link.href, "blob:template");
  assert.equal(link.download, "软件报价单标准模板.docx");
  assert.deepEqual(steps, ["append", "click", "remove", "revoke"]);
  let clicked = false;
  const context = vm.createContext({
    fetch: async () => ({ ok: false, json: async () => ({ error: { message: "请先登录" } }) }),
    document: { createElement() { clicked = true; } }
  });
  vm.runInContext(download, context);
  await assert.rejects(() => vm.runInContext("downloadQuoteTemplate()", context), /请先登录/);
  assert.equal(clicked, false);
});
