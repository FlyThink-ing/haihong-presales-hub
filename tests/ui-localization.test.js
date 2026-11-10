import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadLabels() {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const names = [
    "quoteStatusLabels",
    "approvalStageLabels",
    "contractStatusLabels",
    "contractTemplateStatusLabels",
    "reminderStatusLabels",
    "reminderPriorityLabels",
    "reminderEventTypeLabels"
  ];
  const declarations = names.map(name => {
    const found = source.match(new RegExp(`const ${name} = \\{[^;]+\\};`));
    assert.ok(found, `${name} 中文映射必须存在`);
    return found[0];
  }).join("\n");
  const helper = source.match(/function displayEnum\([\s\S]*?\n\}/)?.[0];
  assert.ok(helper, "统一枚举显示函数必须存在");
  const context = vm.createContext({});
  vm.runInContext(`${declarations}\n${helper}`, context);
  return { source, context };
}

test("业务状态、优先级和处理历史统一显示中文", () => {
  const { source, context } = loadLabels();
  assert.equal(vm.runInContext(`displayEnum("DRAFT", quoteStatusLabels, "状态待确认")`, context), "未发送");
  assert.equal(vm.runInContext(`displayEnum("PENDING_MANAGER", quoteStatusLabels, "状态待确认")`, context), "待研发部经理审核");
  assert.equal(vm.runInContext(`displayEnum("PENDING_VP", quoteStatusLabels, "状态待确认")`, context), "待副总经理审核");
  assert.equal(vm.runInContext(`displayEnum("GENERAL_MANAGER", approvalStageLabels, "审批人")`, context), "综合部经理");
  assert.equal(vm.runInContext(`displayEnum("GENERATED", contractStatusLabels, "状态待确认")`, context), "已生成");
  assert.equal(vm.runInContext(`displayEnum("VALIDATED", contractTemplateStatusLabels, "状态待确认")`, context), "校验通过");
  assert.equal(vm.runInContext(`displayEnum("HIGH", reminderPriorityLabels, "未设置")`, context), "高");
  assert.equal(vm.runInContext(`displayEnum("REASSIGNED", reminderEventTypeLabels, "其他处理")`, context), "重新指派");
  assert.equal(vm.runInContext(`displayEnum("UNKNOWN_INTERNAL_CODE", quoteStatusLabels, "状态待确认")`, context), "状态待确认");

  assert.doesNotMatch(source, /escapeHtml\(quote\.status\)/);
  assert.doesNotMatch(source, /escapeHtml\(template\.status\)/);
  assert.doesNotMatch(source, /escapeHtml\(item\.priority\)/);
  assert.match(source, /displayEnum\(quoteDisplayStatus\(quote\), quoteStatusLabels, "状态待确认"\)/);
  assert.match(source, /function quoteStatusLabel\(quote\)/);
  assert.match(source, /APPROVED: "审核通过"/);
  assert.doesNotMatch(source, /历史两级|系统升级前的两级流程|未补造综合部经理审核/);
  assert.match(source, /displayEnum\(item\.type, reminderEventTypeLabels, "其他处理"\)/);
});

test("报价显示保留具体审核状态，待我审批筛选按当前角色生效", () => {
  const { source, context } = loadLabels();
  const names = ["quoteDisplayStatus", "quoteStatusLabel", "canDecideQuote", "quoteMatchesFilters"];
  const helpers = names.map(name => {
    const found = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(found, name);
    return found[0];
  }).join("\n");
  context.state = { user: { role: "MANAGER", positionCode: "GENERAL_MANAGER" } };
  vm.runInContext(helpers, context);
  const cases = [
    [{ status: "DRAFT", versionHistory: [{ status: "MANAGER_RETURNED" }] }, "DRAFT", "未发送"],
    [{ status: "PENDING_MANAGER", currentApprovalStage: "MANAGER" }, "PENDING_MANAGER", "待研发部经理审核"],
    [{ status: "PENDING_VP", currentApprovalStage: "GENERAL_MANAGER" }, "PENDING_GENERAL_MANAGER", "待综合部经理审核"],
    [{ status: "PENDING_VP", currentApprovalStage: "VP" }, "PENDING_VP", "待副总经理审核"],
    [{ status: "MANAGER_RETURNED", approvals: [{ stage: "MANAGER" }] }, "MANAGER_RETURNED", "研发部经理退回"],
    [{ status: "MANAGER_RETURNED", approvals: [{ stage: "GENERAL_MANAGER" }] }, "GENERAL_MANAGER_RETURNED", "综合部经理退回"],
    [{ status: "VP_RETURNED" }, "VP_RETURNED", "副总经理退回"],
    [{ status: "APPROVED" }, "APPROVED", "审核通过"],
    [{ status: "VOID" }, "VOID", "已作废"]
  ];
  for (const [quote, status, label] of cases) {
    context.quote = quote; context.filters = { query: "", status };
    assert.equal(vm.runInContext("quoteStatusLabel(quote)", context), label);
    assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), true, status);
    context.filters.status = status === "DRAFT" ? "MANAGER_RETURNED" : "DRAFT";
    assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), false, status);
  }
  context.quote = { status: "PENDING_VP", currentApprovalStage: "GENERAL_MANAGER" };
  context.filters = { query: "", status: "MINE" };
  assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), true);
  context.state.user.positionCode = "RND_MANAGER";
  context.state.user.id = "research-manager";
  assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), false);
  context.quote = { status: "PENDING_MANAGER", currentApprovalStage: "MANAGER", pendingManager: { id: "research-manager" } };
  assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), true);
  context.quote.pendingManager = { id: "other-manager" };
  assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), false);
  context.quote.pendingManager = null;
  assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), false);
  context.state.user = { role: "VP" };
  assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), false);
  context.quote = { status: "PENDING_VP", currentApprovalStage: "VP" };
  assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), true);
  context.state.user = { role: "PRESALES" };
  assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), false);
  context.state.user = { role: "ADMIN" };
  context.quote = { status: "PENDING_MANAGER", currentApprovalStage: "MANAGER", pendingManager: null };
  assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), false);
  context.quote = { status: "PENDING_VP", currentApprovalStage: "GENERAL_MANAGER", quoteNumber: "BJ-TEST" };
  context.filters = { query: "bj-test", status: "MINE" };
  assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), true);
  context.filters.query = "其他编号";
  assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), false);
  context.filters.query = "";
  context.quote = { status: "DRAFT" };
  assert.equal(vm.runInContext("quoteMatchesFilters(quote, filters)", context), false);
});

test("报价编辑沿用参考页格式并使用系统内确认弹窗", () => {
  const { source } = loadLabels();
  assert.match(source, /function confirmInApp/);
  assert.doesNotMatch(source, /window\.confirm/);
  assert.match(source, /\/assets\/quote-logo\.png/);
  assert.match(source, /quote-reference-layout/);
  assert.match(source, /客　　户：/);
  assert.match(source, /报价单位：/);
  assert.match(source, /项目\/型号/);
  assert.match(source, /项目费用明细/);
  assert.match(source, /审批记录/);
  assert.match(source, /审核人/);
  assert.match(source, /审核时间/);
  assert.match(source, /备注/);
  assert.doesNotMatch(source, /quote-approval-timeline|quote-approval-step/);
  const editorStart = source.indexOf("async function openQuoteEditor(");
  const editorEnd = source.indexOf("function quoteHandoffSection", editorStart);
  const editor = editorStart >= 0 && editorEnd > editorStart ? source.slice(editorStart, editorEnd) : "";
  assert.ok(editor, "报价编辑函数必须存在");
  assert.doesNotMatch(editor, /quote-toolstrip|联系人快捷带入|请选择关联客户和项目机会/);
  assert.match(editor, /id="quote-customer-display" list="quote-customer-options"/);
  assert.match(editor, /accept="\.docx" multiple/);
  assert.match(editor, /当前状态为未发送/);
  assert.match(editor, /const detailRows = quote\?\.detailItems\?\.length \? quote\.detailItems : \[\{\}\]/);
  assert.match(editor, /customerContactInput\.readOnly = false/);
  assert.match(editor, /customerPhoneInput\.readOnly = false/);
  assert.match(editor, /customerContactInput\.placeholder = ""/);
  assert.match(editor, /customerPhoneInput\.placeholder = ""/);
  assert.match(source, /function quoteCustomerContact\(meta = \{\}\)/);
  assert.match(source, /customerContactSource: "CUSTOMER_MANUAL"/);
  assert.doesNotMatch(source, /请在当前未发送版本中补录客户联系人和联系电话/);
  assert.match(source, /function quoteReadonlyPaper\(quote\)/);
  assert.match(source, /quoteReadonlyPaper\(quote\).*quoteApprovalTimeline\(quote\)/s);
  const paperContent = source.slice(source.indexOf("function quotePaperContent("), source.indexOf("async function openUploadedQuoteEditor("));
  assert.match(paperContent, /quoteReadonlyPaper\(quote\)/);
  assert.match(paperContent, /quoteInlineAttachments\(quote\.attachments, quote\.id/);
  const quoteView = source.match(/async function openQuoteView\([\s\S]*?\n\}/)?.[0];
  assert.ok(quoteView);
  assert.doesNotMatch(quoteView, /quoteExportedFiles\(quote\)/);
  assert.doesNotMatch(source, /\$\{quoteVersionArchive\(quote\)\}/);
  assert.match(source, /data-quote-revise/);
  assert.match(source, /function quoteMatchesFilters\(quote, filters = state\.quoteFilters\)/);
  assert.match(source, /待我审批/);
  assert.doesNotMatch(source, /id="global-search"/);
  assert.doesNotMatch(source, /查看报价与合同 SOP/);

  const decisionStart = source.indexOf("async function openQuoteDecisionDialog(");
  const decisionEnd = source.indexOf("function reminderCenterRow", decisionStart);
  const decision = decisionStart >= 0 && decisionEnd > decisionStart ? source.slice(decisionStart, decisionEnd) : "";
  assert.ok(decision, "报价审批函数必须存在");
  assert.match(decision, /quotePaperContent\(quote\)/);
  assert.match(decision, /quoteApprovalTimeline\(quote\)/);
  assert.match(decision, /attachmentBlock/);
  assert.match(decision, /dialogClass: "quote-editor-dialog quote-approval-dialog"/);
  assert.doesNotMatch(decision, /quoteItemsTable\(quote\)/);
  const submitStart = source.indexOf("async function openQuoteSubmitDialog(");
  const submitEnd = source.indexOf("document.addEventListener", submitStart);
  const submit = source.slice(submitStart, submitEnd);
  assert.match(submit, /openDialog\("发送审批"/);
  assert.match(submit, /quotePaperContent\(quote\)/);
  assert.match(submit, /dialogClass: "quote-editor-dialog"/);
  assert.doesNotMatch(submit, /quoteItemsTable\(quote\)/);
  const metadata = source.slice(source.indexOf("function collectQuoteMetadata("), source.indexOf("function plainQuoteMoney("));
  assert.doesNotMatch(metadata, /if \(!customerContactName\)|if \(!customerPhone\)/);
});

test("报价单位下拉保留足够宽度且不会被原生箭头遮挡", () => {
  const css = fs.readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  assert.match(css, /\.quote-summary-table th:nth-child\(3\).*width: 96px/);
  assert.match(css, /\.quote-detail-table th:nth-child\(4\).*width: 96px/);
  assert.match(css, /\.quote-editor-table \.qe-unit \{ min-width: 80px;/);
  assert.match(css, /\.quote-editor-table \{ width: 100%; min-width: 900px/);
  assert.match(css, /\.quote-paper-section \.table-wrap \{ max-width: 100%; overflow-x: auto;/);
});

test("页面主操作和弹窗操作保持可见", () => {
  const { source } = loadLabels();
  const css = fs.readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  assert.match(source, /actions \? " page-head-sticky" : ""/);
  assert.match(css, /\.page-head-sticky \{ position: sticky; top: 72px;/);
  assert.match(css, /\.page-head-sticky \{ top: 56px; \}/);
  assert.match(css, /\.dialog \{[^}]*display: grid; grid-template-rows: auto minmax\(0, 1fr\) auto; overflow: hidden;/);
  assert.match(css, /\.dialog-body \{[^}]*overflow-y: auto;/);
});

test("报价附件在报价单下方内嵌展示并区分审批快照", () => {
  const { source } = loadLabels();
  const functions = ["escapeHtml", "attachmentItemsFor", "quoteInlineAttachments"].map(name => {
    const found = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(found);
    return found[0];
  }).join("\n");
  const context = vm.createContext({});
  vm.runInContext(functions, context);
  context.data = { mode: "CURRENT", items: [{ id: "attachment-id", targetType: "QUOTE_VERSION", targetId: "quote-id", currentVersion: { originalName: "虚构<附件>.docx" } }] };
  let html = vm.runInContext('quoteInlineAttachments(data, "quote-id")', context);
  assert.match(html, /\/api\/attachments\/attachment-id\/preview/);
  assert.match(html, /虚构&lt;附件&gt;\.docx/);
  context.data = { mode: "SNAPSHOT", items: [{ id: "snapshot-id", targetType: "QUOTE_VERSION", targetId: "quote-id", originalName: "审批附件.xlsx" }] };
  html = vm.runInContext('quoteInlineAttachments(data, "quote-id")', context);
  assert.match(html, /\/api\/attachment-snapshots\/snapshot-id\/preview/);
  assert.match(html, /sandbox="allow-same-origin"/);
  context.data = { mode: "CURRENT", items: [{ id: "pdf-id", targetType: "QUOTE_VERSION", targetId: "quote-id", currentVersion: { originalName: "报价.pdf", mimeType: "application/pdf" } }] };
  html = vm.runInContext('quoteInlineAttachments(data, "quote-id")', context);
  assert.match(html, /data-quote-pdf-preview/);
  assert.match(html, /\/api\/attachments\/pdf-id\/preview/);
  assert.doesNotMatch(html, /<iframe|在新窗口查看/);
});

test("只显示报价单问题，转义文件内容并提示未核对金额", () => {
  const { source } = loadLabels();
  const functions = ["escapeHtml", "quoteBindingPanel"].map(name => {
    const found = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(found);
    return found[0];
  }).join("\n");
  const context = vm.createContext({ formatMoney: cents => `¥${(cents / 100).toFixed(2)}` });
  vm.runInContext(functions, context);
  context.binding = { hasMismatch: true, needsReview: false, customer: { status: "MISMATCH", actual: "<script>虚构</script>", expected: "虚构客户" }, amount: { status: "MISMATCH", actualCents: 100, expectedCents: 200 } };
  let html = vm.runInContext("quoteBindingPanel(binding, { requireConfirmation: true })", context);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /uploaded-binding-confirm/);
  context.binding = { hasMismatch: false, needsReview: true, customer: { status: "MATCH" }, amount: { status: "UNRECOGNIZED" } };
  html = vm.runInContext("quoteBindingPanel(binding, { requireConfirmation: true })", context);
  assert.match(html, /金额未核对/);
  assert.match(html, /可继续上传和送审/);
  assert.doesNotMatch(html, /报价单有待处理的问题/);
  assert.doesNotMatch(html, /uploaded-binding-confirm|人工核对/);
  context.binding = { hasMismatch: false, needsReview: false, customer: { status: "MATCH" }, amount: { status: "MATCH" }, fixedFields: { issues: [] } };
  assert.equal(vm.runInContext("quoteBindingPanel(binding)", context), "");
  context.binding.fixedFields = { issues: [{ field: "开户行", message: "报价单中的开户行未填写，请补充后重新上传。" }], errorCount: 1 };
  html = vm.runInContext("quoteBindingPanel(binding)", context);
  assert.match(html, /开户行未填写/);
  assert.doesNotMatch(html, /人工核对|uploaded-binding-confirm/);
});

test("审批通过默认备注可修改，退回必须填写原因且切换时保留各自备注", async () => {
  const { source } = loadLabels();
  const fn = source.match(/async function openQuoteDecisionDialog\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn);
  let dialog;
  const requests = [];
  const comment = { value: "通过", required: false, focus() { this.focused = true; } };
  const label = { textContent: "审批备注", classList: { toggle(_name, value) { label.isRequired = value; } } };
  const options = ["APPROVED", "REJECTED"].map(value => ({ value, checked: value === "APPROVED", addEventListener(_type, handler) { this.change = handler; } }));
  const panel = { querySelector: selector => selector === "#quote-comment" ? comment : label, querySelectorAll: () => options };
  const context = vm.createContext({
    api: async (route, init) => {
      if (init?.method === "POST") { requests.push(JSON.parse(init.body)); return {}; }
      return route.endsWith("/document-review") ? { review: { amountVerification: "UNRECOGNIZED" } } : { id: "quote", sourceKind: "UPLOADED" };
    },
    openDialog: (_title, html, config) => { dialog = { html, config }; }, quotePaperContent: () => "PDF预览", quoteHandoffSection: () => "",
    quoteApprovalTimeline: () => "审批记录", attachmentBlock: () => "不应显示的附件区域", encodeURIComponent,
    document: { querySelector: () => panel }, closeDialog() {}, showToast() {}, refreshQuoteContext: async () => {}
  });
  vm.runInContext(fn, context);
  await vm.runInContext('openQuoteDecisionDialog("quote")', context);
  assert.match(dialog.html, /金额未核对/);
  assert.match(dialog.html, /PDF预览/);
  assert.match(dialog.html, /审批记录/);
  assert.match(dialog.html, /type="radio" name="quote-decision" value="APPROVED" checked/);
  assert.match(dialog.html, /type="radio" name="quote-decision" value="REJECTED"/);
  assert.match(dialog.html, /<textarea id="quote-comment"[^>]*>通过<\/textarea>/);
  assert.doesNotMatch(dialog.html, /<select id="quote-decision"|主报价检查|人工核对|不应显示的附件区域/);
  const choose = value => { for (const option of options) option.checked = option.value === value; options.find(option => option.checked).change(); };
  choose("REJECTED");
  assert.equal(comment.value, "");
  assert.equal(comment.required, true);
  assert.equal(label.textContent, "退回原因");
  await assert.rejects(() => dialog.config.onSubmit(), /退回时请填写原因/);
  assert.equal(requests.length, 0);
  comment.value = "请核对价格";
  choose("APPROVED");
  assert.equal(comment.value, "通过");
  assert.equal(comment.required, false);
  await dialog.config.onSubmit();
  assert.deepEqual(requests.at(-1), { decision: "APPROVED", comment: "通过" });
  comment.value = "自定义审批意见";
  choose("REJECTED");
  assert.equal(comment.value, "请核对价格");
  await dialog.config.onSubmit();
  assert.deepEqual(requests.at(-1), { decision: "REJECTED", comment: "请核对价格" });
  choose("APPROVED");
  assert.equal(comment.value, "自定义审批意见");
  await dialog.config.onSubmit();
  assert.deepEqual(requests.at(-1), { decision: "APPROVED", comment: "自定义审批意见" });
  comment.value = " ";
  await dialog.config.onSubmit();
  assert.deepEqual(requests.at(-1), { decision: "APPROVED", comment: "通过" });
});

test("审批记录关联各版本报价，且不为无权限版本显示查看入口", () => {
  const { source } = loadLabels();
  const escape = source.match(/function escapeHtml\([\s\S]*?\n\}/)?.[0];
  const timeline = source.match(/function quoteApprovalTimeline\([\s\S]*?\n\}/)?.[0];
  assert.ok(escape && timeline);
  const context = vm.createContext({ approvalStageLabels: { MANAGER: "研发经理" }, approvalDecisionLabels: { REJECTED: "退回", APPROVED: "通过" },
    quoteStatusLabel: () => "未发送", formatTime: () => "虚构时间", displayEnum: (value, labels, fallback) => labels[value] || fallback });
  vm.runInContext(`${escape}\n${timeline}`, context);
  context.quote = { id: "current", versionLabel: "V4.0", status: "DRAFT", approvals: [], versionHistory: [
    { id: "old", versionLabel: "V1.0", status: "MANAGER_RETURNED", canView: true, approvals: [{ stage: "MANAGER", decision: "REJECTED", approver: { displayName: "虚构审核人" }, comment: "请核价" }] },
    { id: "without-approval", versionLabel: "V2.0", status: "DRAFT", canView: true, approvals: [] },
    { id: "restricted", versionLabel: "V3.0", status: "MANAGER_RETURNED", canView: false, approvals: [{ stage: "MANAGER", decision: "REJECTED", approver: { displayName: "另一审核人" }, comment: "退回" }] }
  ] };
  const html = vm.runInContext("quoteApprovalTimeline(quote)", context);
  assert.match(html, /审批记录/);
  assert.match(html, /data-quote-view="old"/);
  assert.match(html, /data-quote-view="without-approval"/);
  assert.match(html, /尚无审批/);
  assert.doesNotMatch(html, /data-quote-view="restricted"|历史报价与文件/);
});

test("审批备注悬停显示全文并限制在视口内，历史报价按钮仍位于备注之后", () => {
  const { source } = loadLabels();
  const css = fs.readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  const escape = source.match(/function escapeHtml\([\s\S]*?\n\}/)?.[0];
  const timeline = source.match(/function quoteApprovalTimeline\([\s\S]*?\n\}/)?.[0];
  const hide = source.match(/function hideQuoteCommentHint\([\s\S]*?\n\}/)?.[0];
  const show = source.match(/function showQuoteCommentHint\([\s\S]*?\n\}/)?.[0];
  const hover = source.match(/document\.addEventListener\("pointerover",[\s\S]*?\n\}\);/)?.[0];
  assert.ok(escape && timeline && hide && show && hover);
  const comment = `${"虚构审批备注".repeat(80)}\n<script>不应作为脚本运行</script>`;
  let hovered, appended, removed = false;
  const attributes = new Map();
  const tooltip = { style: {}, offsetWidth: 160, offsetHeight: 80, setAttribute: (key, value) => attributes.set(key, value), remove: () => { removed = true; } };
  const container = { append: element => { appended = element; } };
  const trigger = {
    textContent: comment,
    closest: selector => selector === ".dialog-backdrop" ? container : trigger,
    getBoundingClientRect: () => ({ left: 305, top: 180, bottom: 200 }),
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: key => attributes.delete(key)
  };
  const context = vm.createContext({
    approvalStageLabels: { MANAGER: "研发部经理" }, approvalDecisionLabels: { REJECTED: "退回" },
    quoteStatusLabel: () => "未发送", formatTime: () => "2026年11月10日 20:32",
    displayEnum: (value, labels, fallback) => labels[value] || fallback,
    document: { createElement: () => tooltip, addEventListener: (_name, listener) => { hovered = listener; } },
    window: { innerWidth: 330, innerHeight: 220 },
    clearTimeout
  });
  vm.runInContext(`${escape}\n${timeline}\nlet quoteCommentHint = null; let quoteCommentHideTimer;\n${hide}\n${show}\n${hover}`, context);
  context.quote = { id: "current", versionLabel: "V2.0", status: "DRAFT", approvals: [], versionHistory: [
    { id: "old", versionLabel: "V1.0", status: "MANAGER_RETURNED", canView: true, approvals: [{ stage: "MANAGER", decision: "REJECTED", approver: { displayName: "虚构审核人" }, comment }] }
  ] };
  const html = vm.runInContext("quoteApprovalTimeline(quote)", context);
  assert.match(html, /<th>备注<\/th><th>操作<\/th>/);
  assert.match(html, /<td data-label="版本">V1\.0<\/td>/);
  assert.match(html, /data-quote-comment[\s\S]*<\/td><td class="quote-record-action"[^>]*><button class="button small quote-record-file"[^>]*data-quote-view="old"/);
  assert.ok(html.includes("&lt;script&gt;不应作为脚本运行&lt;/script&gt;"));
  assert.doesNotMatch(html, /<script>/);
  assert.match(css, /\.quote-approval-records \{[^}]*table-layout: fixed/);
  assert.match(css, /\.quote-record-comment \{[^}]*text-overflow: ellipsis; white-space: nowrap/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.quote-approval-records td::before \{ content: attr\(data-label\)/);
  hovered({ pointerType: "mouse", target: trigger });
  assert.equal(appended, tooltip);
  assert.equal(tooltip.textContent, comment);
  assert.equal(attributes.get("role"), "tooltip");
  assert.equal(tooltip.style.left, "162px");
  assert.equal(tooltip.style.top, "92px");
  context.hideQuoteCommentHint();
  assert.equal(removed, true);
  assert.equal(attributes.has("aria-describedby"), false);
  assert.doesNotMatch(source, /openDialog\("查看备注"/);
});

test("查看报价时不提供当前版本的重复入口，其他历史版本仍可打开", () => {
  const { source } = loadLabels();
  const escape = source.match(/function escapeHtml\([\s\S]*?\n\}/)?.[0];
  const timeline = source.match(/function quoteApprovalTimeline\([\s\S]*?\n\}/)?.[0];
  assert.ok(escape && timeline);
  const context = vm.createContext({ approvalStageLabels: { MANAGER: "研发经理" }, approvalDecisionLabels: { REJECTED: "退回", APPROVED: "通过" },
    quoteStatusLabel: () => "未发送", formatTime: () => "虚构时间", displayEnum: (value, labels, fallback) => labels[value] || fallback });
  vm.runInContext(`${escape}\n${timeline}`, context);
  const approval = { stage: "MANAGER", decision: "REJECTED", approver: { displayName: "虚构审核人" }, comment: "请核价" };
  context.quote = { id: "v1", versionLabel: "V1.0", status: "MANAGER_RETURNED", approvals: [approval], versionHistory: [] };
  let html = vm.runInContext("quoteApprovalTimeline(quote)", context);
  assert.match(html, /V1\.0/);
  assert.match(html, /请核价/);
  assert.doesNotMatch(html, /data-quote-view="v1"/);
  context.quote = { id: "v2", versionLabel: "V2.0", status: "APPROVED", approvals: [approval], versionHistory: [
    { id: "v1", versionLabel: "V1.0", status: "MANAGER_RETURNED", canView: true, approvals: [approval] }
  ] };
  html = vm.runInContext("quoteApprovalTimeline(quote)", context);
  assert.match(html, /data-quote-view="v1"/);
  assert.doesNotMatch(html, /data-quote-view="v2"/);
  html = vm.runInContext("quoteApprovalTimeline(quote, { showCurrentQuoteLink: true })", context);
  assert.match(html, /data-quote-view="v2"/);
  const revision = source.match(/async function openApprovedQuoteRevisionDialog\([\s\S]*?\n\}/)?.[0];
  assert.match(revision, /quoteApprovalTimeline\(quote, \{ showCurrentQuoteLink: true \}\)/);
});

test("重复点击查看报价时只打开一个弹窗，失败后仍可重试", async () => {
  const { source } = loadLabels();
  const block = source.match(/if \(quoteView && !quoteView\.disabled\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(block);
  let resolveOpen, calls = 0, toast = "";
  const pending = new Promise(resolve => { resolveOpen = resolve; });
  const context = vm.createContext({ openQuoteView: async () => { calls++; await pending; }, showToast: value => { toast = value; } });
  vm.runInContext(`async function openFromButton(quoteView) { ${block} }`, context);
  const button = { disabled: false, dataset: { quoteView: "v1" } };
  const first = context.openFromButton(button);
  const second = context.openFromButton(button);
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  resolveOpen();
  await Promise.all([first, second]);
  assert.equal(button.disabled, false);
  context.openQuoteView = async () => { throw new Error("查看失败"); };
  await context.openFromButton(button);
  assert.equal(toast, "查看失败");
  assert.equal(button.disabled, false);
});

test("改密页面的并排按钮复用全局操作间距", () => {
  const { source } = loadLabels();
  const css = fs.readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  const changePassword = source.match(/function renderPasswordChange\([\s\S]*?\n\}/)?.[0];
  assert.ok(changePassword);
  assert.match(changePassword, /<div class="actions"><button[^>]*>修改密码并进入系统<\/button><button[^>]*>退出登录<\/button><\/div>/);
  assert.match(css, /\.actions \{[^}]*display: flex;[^}]*gap: 8px;[^}]*flex-wrap: wrap/);
});

test("报价页面允许客户联系人和手机同时留空", () => {
  const { source } = loadLabels();
  const fn = source.match(/function collectQuoteMetadata\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn);
  const values = {
    "#quote-customer-display": "虚构客户", "#quote-contact-name": "", "#quote-contact-phone": "",
    "#quote-seller-name": "虚构售前", "#quote-seller-phone": "13000000000", "#quote-seller-email": "sales@example.invalid",
    "#quote-date": "2026-10-31", "#quote-validity": "30 天", "#quote-delivery": "按合同", "#quote-payment": "按合同",
    "#quote-bank": "虚构银行", "#quote-account": "虚构账号"
  };
  const context = vm.createContext({ document: { querySelector: selector => ({ value: values[selector] }) } });
  vm.runInContext(fn, context);
  const metadata = vm.runInContext("collectQuoteMetadata()", context);
  assert.equal(metadata.customerContactName, "");
  assert.equal(metadata.customerPhone, "");
  assert.equal(metadata.customerName, "虚构客户");
});

test("报价列表和完整审批页适配手机端", () => {
  const css = fs.readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.sidebar \{ width: 100%; height: 68px;/);
  assert.match(css, /\.quote-list-table thead \{ display: none; \}/);
  assert.match(css, /\.quote-list-table td::before \{ content: attr\(data-label\)/);
  assert.match(css, /\.quote-decision-panel \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.quote-decision-panel \{[^}]*grid-template-columns: minmax\(168px, 190px\) minmax\(0, 1fr\)/);
  assert.match(css, /\.quote-decision-panel \.field textarea \{ min-height: 44px;/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.quote-filter-grid \{ grid-template-columns: 1fr; \}/);
});

test("个人资料入口合并到左下角且手机端仍可访问", () => {
  const { source } = loadLabels();
  const css = fs.readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  assert.match(source, /class="sidebar-profile"[^>]*data-action="edit-profile"/);
  assert.doesNotMatch(source, /class="\$\{userChipClass\}"/);
  assert.match(source, /请先在左下角账号资料中维护手机号码和邮箱/);
  assert.doesNotMatch(source, /请先在右上角个人资料中维护手机号码和邮箱/);
  assert.match(css, /\.sidebar-mobile-label \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.sidebar-foot \{[^}]*display: flex;/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.sidebar-profile \{ display: flex; \}/);
});
