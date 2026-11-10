import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

// 只验证页面模板和交互门禁，不模拟浏览器验收，也不访问任何浏览器 URL。
test("拜访迁移页面完整转义十一字段长文本且不预选客户、负责人或正式状态", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const functions = ["escapeHtml", "munichVisitEntryHtml"].map(name => {
    const found = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(found, `${name} 页面函数必须存在`);
    return found[0];
  }).join("\n");
  const longText = "虚构长文本".repeat(1_500);
  const entry = {
    id: "virtual-entry", rowNumber: 3, status: "AWAITING_CONFIRMATION", canConfirm: true,
    sourceKey: "source-key", sourceSha256: "a".repeat(64), sheetName: "慕尼黑客户拜访记录",
    source: { 序号: 0, 客户名称: "<script>虚构主体</script>", 意向: "A", 行业: "虚构行业", 客户需求: longText, 接洽人: "虚构联系人", 登记时间: "2026-08-01", 售前: "虚构售前", 备注: "", 计划拜访日期: "2026-08-08", 拜访状态: "已拜访" },
    normalized: { customerName: "<script>虚构主体</script>", intention: "A", visitStatus: "已拜访", plannedVisitOn: "2026-08-08", salesText: "虚构售前", contactRaw: "虚构联系人", contactName: "虚构联系人" },
    issues: [], warnings: [], boundCustomer: null,
    candidateCustomers: [{ id: "customer-1", fullName: "虚构候选客户", owner: { displayName: "虚构售前" }, sourceMatched: false }],
    ownerCandidates: [{ id: "sales-1", username: "virtual-sales", displayName: "虚构售前" }],
    candidateFields: [{ key: "needSummary", label: "客户需求", value: longText }],
    contactCandidates: { "customer-1": [{ id: "contact-1", name: "虚构联系人" }] }
  };
  const context = vm.createContext({
    state: { user: { role: "ADMIN" } },
    customerStatuses: ["初期接洽", "现场调研", "方案&报价", "报价完成&商务洽谈", "合同签订完成", "丢标", "中止"], entry,
    owners: [{ id: "sales-1", username: "virtual-sales", displayName: "虚构售前" }]
  });
  vm.runInContext(functions, context);
  const html = vm.runInContext("munichVisitEntryHtml(entry, owners)", context);
  assert.ok(html.includes("&lt;script&gt;虚构主体&lt;/script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes(longText));
  assert.match(html, /序号：0/);
  assert.match(html, /备注：（空）/);
  assert.match(html, /计划拜访：2026-08-08（仅候选，不是实际跟进）/);
  assert.match(html, /请选择，不按名称自动确定/);
  assert.match(html, /请选择已启用售前/);
  assert.match(html, /虚构售前（virtual-sales）/);
  assert.match(html, /仅新建时必选/);
  assert.doesNotMatch(html, /<option[^>]+selected/);
});

test("拜访迁移页面具有重复点击、失败重试和非管理员原文件隐藏门禁", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(source, /panel\.dataset\.busy === "true"/);
  assert.match(source, /button\.disabled = true/);
  assert.match(source, /button\.disabled = false/);
  assert.match(source, /munich-visits\/confirm/);
  assert.match(source, /state\.user\.role !== "ADMIN"[\s\S]*import-source-download/);
  assert.match(source, /本模块不创建跟进或提醒，合并不覆盖已有非空字段/);
});
