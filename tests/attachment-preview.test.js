import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { buildAttachmentPreview } from "../server/attachment-preview.js";

const file = (downloadName, mimeType, buffer) => ({ downloadName, mimeType, buffer });

test("PDF 和图片在线预览保持原始字节", async () => {
  const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
  const preview = await buildAttachmentPreview(file("虚构.pdf", "application/pdf", pdf));
  assert.equal(preview.mimeType, "application/pdf");
  assert.deepEqual(preview.buffer, pdf);
});

test("Word 在线预览提取正文并对用户内容进行 HTML 转义", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>客户&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p><w:p><w:r><w:t>第二段说明</w:t></w:r></w:p></w:body></w:document>`);
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const preview = await buildAttachmentPreview(file("虚构调研.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer));
  const html = preview.buffer.toString("utf8");
  assert.match(preview.mimeType, /^text\/html/);
  assert.match(html, /客户&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /第二段说明/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("Word 预览保留段落顺序、表格、合并列及安全图片", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body><w:p><w:r><w:t>表格之前</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>虚构表头</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p><w:p><w:r><w:t>表格之后</w:t></w:r></w:p></w:body></w:document>`);
  zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="rel"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`);
  zip.file("word/media/image1.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const preview = await buildAttachmentPreview(file("虚构.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", await zip.generateAsync({ type: "nodebuffer" })));
  const html = preview.buffer.toString("utf8");
  assert.match(html, /<table><tbody><tr><td colspan="2"><p><strong>虚构表头<\/strong><\/p><\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.ok(html.indexOf("表格之前") < html.indexOf("虚构表头"));
  assert.ok(html.indexOf("虚构表头") < html.indexOf("表格之后"));
});

test("Excel 在线预览按工作表显示长文本并进行转义", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("专项清单");
  sheet.addRow(["对接内容", "备注"]);
  sheet.addRow(["第一行\n第二行", "<img src=x onerror=alert(1)>"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const preview = await buildAttachmentPreview(file("虚构清单.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer));
  const html = preview.buffer.toString("utf8");
  assert.match(html, /专项清单/);
  assert.match(html, /第一行\n第二行/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
});

test("Excel 在线预览保留空行后内容、合并单元格和常用样式", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("报价清单");
  sheet.getCell("A1").value = "开头";
  sheet.mergeCells("B3:C4");
  sheet.getCell("B3").value = "合并项";
  sheet.getCell("B3").font = { bold: true, color: { argb: "FF225588" } };
  sheet.getCell("E8").value = "空行之后";
  sheet.getCell("A450").value = "后续行内容";
  const preview = await buildAttachmentPreview(file("虚构清单.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Buffer.from(await workbook.xlsx.writeBuffer())));
  const html = preview.buffer.toString("utf8");
  assert.match(html, /rowspan="2" colspan="2" style="font-weight:bold;color:#225588">合并项/);
  assert.match(html, /空行之后/);
  assert.match(html, /后续行内容/);
});

test("PowerPoint 在线预览按页提取文字", async () => {
  const zip = new JSZip();
  zip.file("ppt/slides/slide2.xml", `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>第二页内容</a:t></a:r></a:p></p:sld>`);
  zip.file("ppt/slides/slide1.xml", `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>第一页内容</a:t></a:r></a:p></p:sld>`);
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const preview = await buildAttachmentPreview(file("虚构汇报.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", buffer));
  const html = preview.buffer.toString("utf8");
  assert.ok(html.indexOf("第一页内容") < html.indexOf("第二页内容"));
  assert.match(html, /第 1 页/);
  assert.match(html, /第 2 页/);
});
