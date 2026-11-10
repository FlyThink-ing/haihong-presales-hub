import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

// 只验证页面函数/模板，不模拟浏览器验收，也不访问任何浏览器 URL。
test("历史跟进页面函数保留日精度输入/提交及原文缺省，来源长文本按 HTML 转义", async () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const functions = ["escapeHtml", "formatFollowupTime", "followupSourceDetails", "openFollowupDialog"].map(name => {
    const found = source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(found, `${name} 页面函数必须存在`);
    return found[0];
  }).join("\n");
  const followup = { id: "virtual-followup", occurredAt: "2024-02-29", occurredPrecision: "DAY", historical: true, method: "OTHER", participants: [], nextAction: "", content: "虚构内容" };
  const values = { "#followup-method": "OTHER", "#followup-time": "2024-02-29", "#followup-project": "", "#followup-contact": "", "#followup-participants": "", "#followup-content": "虚构更正", "#followup-feedback": "", "#followup-next": "", "#followup-change-reason": "虚构核对" };
  let dialog;
  let submitted;
  const context = vm.createContext({
    state: { customerWorkspace: { customer: { id: "virtual-customer" }, followups: [followup] } },
    followupMethodLabels: { OTHER: "其他" }, formatTime: () => "不应用于日精度", localDateTimeValue: () => "不应用于日精度",
    api: async (route, options) => { if (options?.method === "PATCH") submitted = JSON.parse(options.body); return { items: [] }; },
    openDialog: (title, html, options) => { dialog = { title, html, options }; },
    document: { querySelector: selector => ({ value: values[selector] }) },
    closeDialog() {}, showToast() {}, refreshCustomerDetail() {}, followup,
    rawSource: { rawText: "<script>虚构</script>" + "虚构长文本".repeat(1000), rawDate: "2024年2月29日", rawMethod: "", sourceSha256: "a".repeat(64), sheetName: "信息收集", cellReference: "H3", paragraphNumber: 1, batchId: "virtual-batch", operatedBy: "virtual-user", importedAt: "2026-08-01T00:00:00Z" }
  });
  vm.runInContext(functions, context);
  assert.match(vm.runInContext("formatFollowupTime(followup)", context), /^2024-02-29（日精度/);
  const sourceHtml = vm.runInContext("followupSourceDetails(rawSource)", context);
  assert.ok(sourceHtml.includes("&lt;script&gt;虚构&lt;/script&gt;"));
  assert.ok(sourceHtml.includes("虚构长文本".repeat(1000)));
  await vm.runInContext('openFollowupDialog("virtual-customer", "virtual-followup")', context);
  assert.match(dialog.html, /id="followup-time" type="date" value="2024-02-29"/);
  assert.match(dialog.html, /原文未记录时可留空/);
  await dialog.options.onSubmit();
  assert.equal(submitted.occurredAt, "2024-02-29");
  assert.equal(submitted.nextAction, "");
  assert.equal(submitted.changeReason, "虚构核对");
});
