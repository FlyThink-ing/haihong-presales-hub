import assert from "node:assert/strict";
import test from "node:test";
import { buildPdfLayout } from "../server/quote-pdf-layout.js";
import { checkPdfTables } from "../server/quote-pdf-tables.js";
import { parseQuoteDocument } from "../server/quote-document-parser.js";
import { checkMainQuote } from "../server/quote-document-checks.js";
import { quotePdfFixture, quoteBindingPdfFixture } from "./pdf-fixtures.js";
import { inspectQuoteBinding } from "../server/quote-binding.js";

const item = (text, x, y, width = 20) => ({ text, x, y, width, height: 10, rotated: false });
const header = (y, detail = false) => {
  const positions = detail ? [40, 90, 190, 280, 315, 360, 415, 470, 520] : [40, 110, 195, 230, 280, 345, 410, 490];
  const values = detail ? ["序号", "项目", "子项", "单位", "数量", "未税", "未税", "含税", "备注"] : ["序号", "项目/型号", "单位", "数量", "未税", "未税", "含税", "备注"];
  return values.map((value, index) => item(value, positions[index], y, value === "项目/型号" ? 45 : 20));
};
function syntheticPages({ detailSum = "100,000.00", badDetail = false } = {}) {
  const row = (seq, y, net, gross) => [item(String(seq), 45, y, 5), item("项", 285, y, 10), item("1", 320, y, 5), item(net, 355, y, 45), item(net, 410, y, 45), item(gross, 475, y, 42)];
  return [
    { page: 1, rotation: 0, items: [
      ...header(700), item("1", 45, 670, 5), item("套", 200, 670, 10), item("1", 235, 670, 5), item("88,495.58", 275, 670, 45), item("88,495.58", 340, 670, 45), item("100,000.00", 415, 670, 48),
      item("合计：", 290, 640, 30), item("88,495.58", 340, 640, 45), item("100,000.00", 415, 640, 48),
      ...header(590, true), ...row(1, 560, "53,097.35", "60,000.00")
    ] },
    { page: 2, rotation: 0, items: [
      ...header(700, true), item("较长说明续行", 190, 675, 70), ...row(2, 650, "35,398.23", badDetail ? "39,999.00" : "40,000.00"),
      item("合计：", 365, 620, 30), item("88,495.58", 410, 620, 45), item(detailSum, 475, 620, 48),
      item("含13%增值税，合计金额（大写）：壹拾万元整", 40, 580, 300), item("交期：按约定", 40, 550, 75), item("付款方式：按约定", 40, 530, 100),
      item("报价人：测试售前", 40, 510, 100), item("手机：13000000000", 40, 490, 130), item("邮箱：sales@example.invalid", 40, 470, 150),
      item("附件：不应检查", 40, 400, 110)
    ] }
  ];
}

test("合成 PDF 文本层正确读取邮箱边界并排除附件", async () => {
  const pdf = quotePdfFixture(["软件报价单", "交期：按约定", "付款方式：按约定", "报价人：测试售前", "手机：13000000000", "邮箱：sales@example.invalid", "附件：不应检查"]);
  const parsed = await parseQuoteDocument({ buffer: pdf, mimeType: "application/pdf" });
  assert.equal(parsed.format, "PDF");
  assert.match(parsed.units[parsed.boundary.endIndex].text, /^邮箱/);
  assert.ok(!parsed.units.some(unit => unit.text.includes("不应检查")));
  const result = checkMainQuote(parsed, parsed.boundary.endIndex, { declaredAmountCents: 100, sellers: [] });
  assert.ok(result.issues.some(issue => issue.code === "VISUAL" && issue.severity === "REVIEW"));
});

test("PDF 表格跨页续行只计一次，分项和总价精确核对", () => {
  const layout = buildPdfLayout(syntheticPages());
  const issues = [];
  const totals = checkPdfTables(layout.lines, layout.emailEnd, (...args) => issues.push(args), { rate: 13 });
  assert.deepEqual({ summary: totals.summary, detail: totals.detail, final: totals.final }, { summary: 10000000, detail: 10000000, final: 10000000 });
  assert.ok(!issues.some(issue => issue[0] === "ERROR"), JSON.stringify(issues));
  assert.ok(!issues.some(issue => issue[1] === "TABLE_UNRECOGNIZED"), JSON.stringify(issues));
  assert.ok(!layout.units.some(unit => unit.text.includes("不应检查")));
});

test("可靠识别的 PDF 合计差异阻止审批，提取不完整时交人工核对", () => {
  const layout = buildPdfLayout(syntheticPages({ badDetail: true }));
  const issues = [];
  checkPdfTables(layout.lines, layout.emailEnd, (...args) => issues.push(args), { rate: 13 });
  assert.ok(issues.some(issue => issue[1] === "TOTAL_ROW" && issue[0] === "ERROR"));
  const uncertain = [];
  checkPdfTables(layout.lines, layout.emailEnd, (...args) => uncertain.push(args), { rate: 13, uncertain: true });
  assert.ok(!uncertain.some(issue => issue[0] === "ERROR"));
  assert.ok(uncertain.some(issue => issue[1] === "PDF_TABLE_COMPLEX"));
  const missingRowPages = syntheticPages({ badDetail: true });
  const lastSequence = missingRowPages[1].items.find(part => part.text === "2" && part.x === 45);
  lastSequence.text = "3";
  const incomplete = buildPdfLayout(missingRowPages), incompleteIssues = [];
  checkPdfTables(incomplete.lines, incomplete.emailEnd, (...args) => incompleteIssues.push(args), { rate: 13 });
  assert.ok(!incompleteIssues.some(issue => issue[0] === "ERROR" && issue[1] === "TOTAL_ROW"));
  assert.ok(incompleteIssues.some(issue => issue[1] === "PDF_TABLE_COMPLEX"));
});

test("主报价未识别邮箱时保留手动选择和人工确认", async () => {
  const parsed = await parseQuoteDocument({ buffer: quotePdfFixture(["软件报价单", "交期：按约定", "付款方式：按约定"]), mimeType: "application/pdf" });
  assert.equal(parsed.boundary.endIndex, null);
  const result = checkMainQuote(parsed, parsed.units.length - 1, { declaredAmountCents: 1, sellers: [] });
  assert.ok(result.issues.some(issue => issue.code === "FIELD_报价人邮箱" && issue.severity === "REVIEW"));
});

test("标准总价后的硬件清单小计不会覆盖主报价，客户和含税总额单独比较", async () => {
  const parsed = await parseQuoteDocument({ buffer: quoteBindingPdfFixture(), mimeType: "application/pdf" });
  const matching = inspectQuoteBinding(parsed, { customerName: "虚构客户有限公司", amountCents: 10000000 });
  assert.equal(matching.customer.status, "MATCH");
  assert.equal(matching.amount.status, "MATCH");
  const wrong = inspectQuoteBinding(parsed, { customerName: "另一个虚构客户有限公司", amountCents: 20000000 });
  assert.equal(wrong.customer.status, "MISMATCH");
  assert.equal(wrong.amount.status, "MISMATCH");
  assert.equal(wrong.hasMismatch, true);
  assert.equal(wrong.amount.actualCents, 10000000);
  const short = inspectQuoteBinding(parsed, { customerName: "其他全称有限公司", customerShortName: "虚构客户有限公司", amountCents: 10000000 });
  assert.equal(short.customer.status, "MATCH");
  const items = syntheticPages();
  items[0].items.push(item("较长的虚构项目名称", 73, 670, 92));
  const layout = buildPdfLayout(items), issues = [];
  const totals = checkPdfTables(layout.lines, layout.emailEnd, (...args) => issues.push(args), { rate: 13 });
  assert.equal(totals.finalFormula, false);
  assert.ok(!issues.some(issue => issue[0] === "ERROR"));
});
