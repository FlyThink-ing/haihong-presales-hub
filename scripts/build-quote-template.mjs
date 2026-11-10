import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--source");
const outputIndex = args.indexOf("--output");
if (sourceIndex < 0 || outputIndex < 0 || !args[sourceIndex + 1] || !args[outputIndex + 1]) {
  throw new Error("用法: node scripts/build-quote-template.mjs --source <参考报价.docx> --output <模板.docx>");
}

const sourcePath = path.resolve(args[sourceIndex + 1]);
const outputPath = path.resolve(args[outputIndex + 1]);

function xmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  })[character]);
}

function visibleText(xml) {
  return [...String(xml).matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map(match => match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"))
    .join("");
}

function textRun(text) {
  const lines = String(text).split(/\r?\n/).map(xmlEscape).join('</w:t><w:br/><w:t xml:space="preserve">');
  return `<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="微软雅黑"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr><w:t xml:space="preserve">${lines}</w:t></w:r></w:p>`;
}

function replaceCellText(cellXml, text) {
  const properties = cellXml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/)?.[0] || "";
  return `<w:tc>${properties}${textRun(text)}</w:tc>`;
}

function replaceRowCells(rowXml, values) {
  let index = 0;
  return rowXml.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, cell => replaceCellText(cell, values[index++] ?? ""));
}

function replaceTableRows(tableXml, rows) {
  let index = 0;
  return tableXml.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, row => rows[index] ? replaceRowCells(row, rows[index++]) : row);
}

function replaceParagraphText(documentXml, predicate, text) {
  return documentXml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, paragraph => {
    if (!predicate(visibleText(paragraph))) return paragraph;
    const properties = paragraph.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || "";
    return `<w:p>${properties}<w:r><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="微软雅黑"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  });
}

const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
let documentXml = await zip.file("word/document.xml").async("string");

const firstAttachment = documentXml.indexOf("附件一");
if (firstAttachment >= 0) {
  const paragraphStarts = [...documentXml.slice(0, firstAttachment).matchAll(/<w:p(?:\s|>)/g)];
  const removeFrom = paragraphStarts.at(-1)?.index ?? -1;
  const sectionStart = documentXml.indexOf("<w:sectPr", firstAttachment);
  if (removeFrom < 0 || sectionStart < 0) throw new Error("无法定位参考报价中的附件区域");
  const mainContent = documentXml.slice(0, removeFrom)
    .replace(/<w:p><w:r><w:br w:type="page"\/><\/w:r><\/w:p>$/, "");
  documentXml = `${mainContent}<w:p/>${documentXml.slice(sectionStart)}`;
}

const tables = documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
if (tables.length !== 3) throw new Error(`参考报价主文档应包含 3 张表，实际为 ${tables.length} 张`);

const metaRows = [
  ["客　　户：{{CUSTOMER_NAME}}", "报价单位：河南海弘软件技术有限公司"],
  ["编　　号：{{QUOTE_NUMBER}}", "地　　址：河南省鹤壁经济技术开发区渤海路 396 号"],
  ["联 系 人：{{CONTACT_NAME}}", "邮　　编：458030"],
  ["日　　期：{{QUOTE_DATE}}", "有 效 期：{{VALIDITY}}"],
  ["电　　话：{{CUSTOMER_PHONE}}", "电　　话：0392-3357155"]
];
const summaryRows = [
  ["序号", "项目/型号", "单位", "数量", "未税\n单价(元)", "未税\n金额(元)", "含税\n金额(元)", "备注"],
  ["1", "{{SUMMARY_ITEM}}", "套", "1", "", "", "", ""],
  ["合计：", "{{SUMMARY_UNTAXED_TOTAL}}", "{{SUMMARY_TAXED_TOTAL}}", ""],
  ["优惠后合计（含税）：", "{{FINAL_UNTAXED_TOTAL}}", "{{FINAL_TAXED_TOTAL}}", "{{DISCOUNT_NOTE}}"]
];
const detailRows = [
  ["序号", "项目", "子项", "单位", "数量", "未税\n单价(元)", "未税\n金额(元)", "含税\n金额(元)", "备注"],
  ["1", "{{DETAIL_PROJECT}}", "{{DETAIL_SUBITEM}}", "项", "1", "", "", "", ""],
  ["合计：", "{{DETAIL_UNTAXED_TOTAL}}", "{{DETAIL_TAXED_TOTAL}}", ""],
  ["{{QUOTE_NOTES}}"]
];

documentXml = documentXml.replace(tables[0], replaceTableRows(tables[0], metaRows));
const currentTables = documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
documentXml = documentXml.replace(currentTables[1], replaceTableRows(currentTables[1], summaryRows));
const nextTables = documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
documentXml = documentXml.replace(nextTables[2], replaceTableRows(nextTables[2], detailRows));

documentXml = replaceParagraphText(documentXml, text => text.startsWith("含 13% 增值税"), "含 {{TAX_RATE}} 增值税，合计金额（大写）：{{AMOUNT_UPPER}}");
documentXml = replaceParagraphText(documentXml, text => text.startsWith("交") && text.includes("期："), "交　　期：{{DELIVERY_TERMS}}");
documentXml = replaceParagraphText(documentXml, text => text.startsWith("付款方式："), "付款方式：{{PAYMENT_TERMS}}");
documentXml = replaceParagraphText(documentXml, text => text.startsWith("开 户 行："), "开 户 行：{{BANK_NAME}}");
documentXml = replaceParagraphText(documentXml, text => text.startsWith("账") && text.includes("号："), "账　　号：{{BANK_ACCOUNT}}");
documentXml = replaceParagraphText(documentXml, text => text.startsWith("报 价 人："), "报 价 人：{{SELLER_NAME}}");
documentXml = replaceParagraphText(documentXml, text => /^电\s*话：\s*1[3-9]\d{9}$/.test(text), "电　　话：{{SELLER_PHONE}}");
documentXml = replaceParagraphText(documentXml, text => text.startsWith("邮") && text.includes("箱："), "邮　　箱：{{SELLER_EMAIL}}");

for (const forbidden of ["333", "部门22", "调研记录11", "工单之间同批次"]) {
  if (documentXml.includes(forbidden)) throw new Error(`模板脱敏失败，仍包含示例内容：${forbidden}`);
}

const paragraphs = documentXml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
if (paragraphs.some(paragraph => /(?<!\d)1[3-9]\d{9}(?!\d)|[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(visibleText(paragraph)))) {
  throw new Error("模板脱敏失败，仍包含样例手机号码或邮箱");
}

zip.file("word/document.xml", documentXml);
const core = zip.file("docProps/core.xml");
if (core) {
  let coreXml = await core.async("string");
  coreXml = coreXml.replace(/<dc:creator>[\s\S]*?<\/dc:creator>/, "<dc:creator>Haihong Presales Hub</dc:creator>")
    .replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/, "<cp:lastModifiedBy>Haihong Presales Hub</cp:lastModifiedBy>");
  zip.file("docProps/core.xml", coreXml);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(outputPath);
