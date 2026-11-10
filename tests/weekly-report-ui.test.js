import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

// 只验证页面模板与交互门禁，不访问浏览器 URL，也不作为浏览器验收证据。
test("周汇报页面完整转义源行长文本，金额只显示为隔离候选且不预选客户或分类", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const functions = ["escapeHtml", "weeklyReportEntryHtml"].map(name => {
    const found = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(found, `${name} 页面函数必须存在`);
    return found[0];
  }).join("\n");
  const longText = "虚构周报长文本".repeat(1_000);
  const entry = {
    id: "virtual-weekly-entry", rowNumber: 8, status: "AWAITING_CLASSIFICATION", canConfirm: true,
    sourceKey: "weekly-source-key", sourceSha256: "a".repeat(64), sheetName: "周汇报",
    sourceCells: [
      { cellReference: "C8", headerText: "客户名称", rawText: "<script>虚构客户</script>", valueType: "TEXT", formulaResult: null },
      { cellReference: "D8", headerText: "内容", rawText: longText, valueType: "TEXT", formulaResult: null },
      { cellReference: "E8", headerText: "金额（未税）", rawText: "8888", valueType: "NUMBER", formulaResult: null }
    ],
    candidates: { dateCells: [], amountCells: [{ cellReference: "E8", rawText: "8888" }] },
    candidateCustomers: [{ id: "customer-1", fullName: "虚构候选客户", owner: { displayName: "虚构售前" }, matchedCells: ["C8"] }],
    linkedCustomer: null, decisions: [], issues: [], warnings: []
  };
  const context = vm.createContext({ state: { user: { role: "ADMIN" } }, entry });
  vm.runInContext(functions, context);
  const html = vm.runInContext("weeklyReportEntryHtml(entry)", context);
  assert.ok(html.includes("&lt;script&gt;虚构客户&lt;/script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes(longText));
  assert.match(html, /E8=8888（只保留原文，永不写入报价\/合同\/回款）/);
  assert.match(html, /请选择，不按姓名或邻接关系自动确定/);
  assert.match(html, /业务类型（人工填写，不触发自动转换）/);
  assert.match(html, /仅分类归档，继续待匹配客户/);
  assert.doesNotMatch(html, /<option[^>]+selected/);
});

test("周汇报页面具有检索、双确认、重复点击、失败重试和非管理员原文件隐藏门禁", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(source, /weekly-report\/confirm/);
  assert.match(source, /weekly-search-button/);
  assert.match(source, /panel\.dataset\.busy === "true"/);
  assert.match(source, /button\.disabled = true/);
  assert.match(source, /button\.disabled = false/);
  assert.match(source, /weekly-confirmed/);
  assert.match(source, /weekly-no-record/);
  assert.match(source, /state\.user\.role !== "ADMIN"[\s\S]*import-source-download/);
  assert.match(source, /不生成跟进\/提醒，未税金额永不写入报价、合同、回款/);
});
