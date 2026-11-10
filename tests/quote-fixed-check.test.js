import assert from "node:assert/strict";
import test from "node:test";
import { parseQuoteDocument } from "../server/quote-document-parser.js";
import { checkFixedQuoteFields } from "../server/quote-fixed-check.js";
import { quoteBindingPdfFixture, quotePdfFixture } from "./pdf-fixtures.js";

test("报价单自动检查七类固定字段，缺失或留空时给出具体提示", async () => {
  const parse = buffer => parseQuoteDocument({ buffer, mimeType: "application/pdf" });
  const valid = await parse(quoteBindingPdfFixture());
  assert.deepEqual(checkFixedQuoteFields(valid).issues, []);
  for (const name of ["客户", "日期", "开户行", "账号", "报价人", "报价人电话", "报价人邮箱"]) {
    const missing = checkFixedQuoteFields(await parse(quoteBindingPdfFixture({ omit: [name] })));
    assert.ok(missing.issues.some(issue => issue.field === name), `未发现缺失字段：${name}`);
    const empty = checkFixedQuoteFields(await parse(quoteBindingPdfFixture({ blankField: name })));
    assert.ok(empty.issues.some(issue => issue.field === name), `未发现空字段：${name}`);
  }
});

test("附件不能补齐主报价缺失字段，模板占位符不能视为已填写", async () => {
  const parsed = await parseQuoteDocument({ buffer: quoteBindingPdfFixture({ blankField: "账号" }), mimeType: "application/pdf" });
  const sourceEnd = parsed.boundary.endIndex;
  parsed.units.push({ index: parsed.units.length, text: "附件：", location: "附件", pdfFieldEligible: false });
  parsed.units.push({ index: parsed.units.length, text: "账号：123456789", location: "附件", pdfFieldEligible: true });
  assert.ok(checkFixedQuoteFields(parsed).issues.some(issue => issue.field === "账号"));
  parsed.units[sourceEnd].text = "邮箱：{{报价人邮箱}}";
  assert.ok(checkFixedQuoteFields(parsed).issues.some(issue => issue.field === "报价人邮箱"));
});

test("不能确定主报价结束位置时，上传和送审均需先补齐邮箱位置", async () => {
  const parsed = await parseQuoteDocument({ buffer: quoteBindingPdfFixture(), mimeType: "application/pdf" });
  parsed.boundary.endIndex = null;
  const issues = checkFixedQuoteFields(parsed).issues;
  assert.ok(issues.some(issue => issue.code === "BOUNDARY_UNRECOGNIZED"));
});

test("附件里的邮箱不能充当主报价的结束位置或补齐主报价字段", async () => {
  const buffer = quotePdfFixture([
    "软件报价单", "客户：虚构客户有限公司", "日期：2026-11-03", "开户行：虚构银行",
    "账号：", "报价人：测试售前", "手机：13000000000", "附件一：设备清单",
    "账号：100000000000", "邮箱：sales@example.invalid"
  ]);
  const parsed = await parseQuoteDocument({ buffer, mimeType: "application/pdf" });
  const issues = checkFixedQuoteFields(parsed).issues;
  assert.ok(issues.some(issue => issue.field === "账号"));
  assert.ok(issues.some(issue => issue.field === "报价人邮箱"));
});
