import fs from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, PageNumber,
  Packer, Paragraph, ShadingType, Table, TableCell, TableLayoutType, TableRow,
  TextRun, VerticalAlign, WidthType
} from "docx";
import { audit } from "./audit.js";
import { AppError, assert, QUOTE_STATUSES } from "./domain.js";
import { resolveManagedPath, storeFile } from "./file-service.js";
import { calculateQuoteItems, getQuoteVersion, makeContentSnapshot } from "./quote-service.js";
import { getAttachmentDownload } from "./attachment-service.js";
import { quoteDetailTotalsMismatch, quoteDetailTotalsMismatchMessage } from "../web/quote-math.js";
import { sha256 } from "./security.js";
import { getSurvey } from "./survey-service.js";
import { listFollowups } from "./customer-activity-service.js";
import { getCustomer } from "./customer-service.js";
import { requireCustomerAccess } from "./permissions.js";
import { readQuoteExcelWorkbook } from "./quote-excel.js";

const COLORS = Object.freeze({ blue: "2E74B5", darkBlue: "1F4D78", light: "F2F4F7", line: "C8D0D8", muted: "687782" });
const TABLE_WIDTH = 9360;
const quoteTemplatePath = fileURLToPath(new URL("./templates/quote-template-v1.docx", import.meta.url));
const borders = { top: { style: BorderStyle.SINGLE, size: 1, color: COLORS.line }, bottom: { style: BorderStyle.SINGLE, size: 1, color: COLORS.line }, left: { style: BorderStyle.SINGLE, size: 1, color: COLORS.line }, right: { style: BorderStyle.SINGLE, size: 1, color: COLORS.line }, insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: COLORS.line }, insideVertical: { style: BorderStyle.SINGLE, size: 1, color: COLORS.line } };

function cleanName(value, fallback) {
  const cleaned = String(value || "").replace(/[\r\n\\/:*?"<>|]/g, "_").trim().slice(0, 100);
  return cleaned || fallback;
}
function money(cents) {
  return `¥${(Number(cents || 0) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function quantity(value) {
  return (Number(value || 0) / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
}

function plainMoney(cents) {
  return (Number(cents || 0) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function amountUppercase(cents) {
  const value = Number(cents || 0);
  assert(Number.isSafeInteger(value) && value >= 0, 500, "QUOTE_AMOUNT_UPPER_INVALID", "报价大写金额无效");
  if (value === 0) return "零元整";
  const digits = "零壹贰叁肆伍陆柒捌玖";
  const units = ["分", "角", "元", "拾", "佰", "仟", "万", "拾", "佰", "仟", "亿", "拾", "佰", "仟", "兆"];
  const text = String(value).split("").reverse().map((digit, index) => ({ digit: Number(digit), unit: units[index] || "" }));
  let result = "";
  let pendingZero = false;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const { digit, unit } = text[index];
    if (digit === 0) {
      if (["兆", "亿", "万", "元"].includes(unit) && result && !result.endsWith(unit)) result += unit;
      pendingZero = Boolean(result) && !["兆", "亿", "万", "元"].includes(unit);
      continue;
    }
    if (pendingZero && !result.endsWith("零")) result += "零";
    result += `${digits[digit]}${unit}`;
    pendingZero = false;
  }
  result = result.replace(/亿万/g, "亿").replace(/零+/g, "零").replace(/零(兆|亿|万|元)/g, "$1");
  if (value % 100 === 0) return `${result.replace(/元.*$/, "元")}整`;
  if (value % 10 === 0 && !result.endsWith("角")) result += "整";
  return result;
}

function xmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}

function replaceCellText(cellXml, text) {
  const properties = cellXml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/)?.[0] || "";
  const paragraphProperties = cellXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || "";
  const runProperties = cellXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] || '<w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="微软雅黑"/><w:sz w:val="20"/></w:rPr>';
  return `<w:tc>${properties}<w:p>${paragraphProperties}<w:r>${runProperties}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p></w:tc>`;
}

function replaceRowCells(rowXml, values) {
  let cellIndex = 0;
  return rowXml.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, cell => replaceCellText(cell, values[cellIndex++] ?? ""));
}

function rebuildQuoteTable(tableXml, dataRows, footerRows) {
  let rowIndex = 0;
  return tableXml.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, row => {
    const current = rowIndex++;
    if (current === 0) return row;
    if (current === 1) return (dataRows.length ? dataRows : [["1", "未填写"]]).map(values => replaceRowCells(row, values)).join("");
    if (footerRows[current - 2] === null) return "";
    return footerRows[current - 2] ? replaceRowCells(row, footerRows[current - 2]) : row;
  });
}

function chineseOrdinal(index) {
  return ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][index] || String(index + 1);
}

function attachmentTitleXml(title) {
  return `<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:pPr><w:spacing w:after="60"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体"/><w:b/><w:sz w:val="26"/></w:rPr><w:t xml:space="preserve">${xmlEscape(title)}</w:t></w:r></w:p>`;
}

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

async function excelAttachmentHtml(buffer) {
  const workbook = await readQuoteExcelWorkbook(buffer);
  const sheets = workbook.worksheets.map(sheet => {
    const rows = [];
    // actualRowCount/actualColumnCount 是非空行列的数量，不是最末行列的位置。
    // 使用它们作为边界会漏掉空行或空列之后的数据。
    const rowCount = sheet.rowCount;
    const columnCount = sheet.columnCount;
    for (let row = 1; row <= rowCount; row += 1) {
      const cells = [];
      for (let column = 1; column <= columnCount; column += 1) cells.push(`<td>${htmlEscape(sheet.getCell(row, column).text)}</td>`);
      rows.push(`<tr>${cells.join("")}</tr>`);
    }
    return `<h2>${htmlEscape(sheet.name)}</h2><table>${rows.join("")}</table>`;
  }).join("");
  return Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Microsoft YaHei}table{border-collapse:collapse;width:100%}td{border:1px solid #000;padding:4px;vertical-align:top;white-space:pre-wrap}</style></head><body>${sheets}</body></html>`);
}

function quoteAttachmentFiles(db, config, versionId) {
  return db.prepare(`
    SELECT s.original_name, s.mime_type, s.size_bytes, s.sha256, f.storage_key
    FROM business_attachment_snapshots s
    JOIN business_attachment_versions v ON v.id = s.attachment_version_id
    JOIN stored_files f ON f.id = v.file_id
    WHERE s.snapshot_kind = 'QUOTE_SUBMISSION' AND s.snapshot_owner_id = ?
    ORDER BY s.created_at, s.id
  `).all(versionId).map(row => {
    const absolutePath = resolveManagedPath(config, row.storage_key);
    assert(fs.existsSync(absolutePath), 409, "QUOTE_ATTACHMENT_MISSING", "报价快照附件归档缺失，禁止导出");
    const buffer = fs.readFileSync(absolutePath);
    assert(buffer.length === row.size_bytes && sha256(buffer) === row.sha256, 409, "QUOTE_ATTACHMENT_TAMPERED", "报价快照附件校验失败，禁止导出");
    return { ...row, buffer };
  });
}

async function renderApprovedQuoteTemplate(db, config, versionId, snapshot, previewAttachments = null) {
  const zip = await JSZip.loadAsync(fs.readFileSync(quoteTemplatePath));
  let documentXml = await zip.file("word/document.xml").async("string");
  // 参考文件的附件标题前遗留了单独分页符；由本系统追加附件时自行分页，避免空白页。
  documentXml = documentXml.replace(/<w:p><w:r><w:br w:type="page"\/><\/w:r><\/w:p>(?=<w:p\/><w:sectPr)/, "");
  // 表头的换行必须使用 Word 换行元素，不能把换行符直接放在文本节点中。
  documentXml = documentXml.replace(/(<w:t\b[^>]*>)(未税|含税)\r?\n(单价\(元\)|金额\(元\))(<\/w:t>)/g,
    '$1$2</w:t><w:br/><w:t xml:space="preserve">$3$4');
  const metadata = snapshot.metadata || {};
  const taxRates = [...new Set(snapshot.items.map(item => item.taxRateBps))];
  const taxRateLabel = taxRates.length === 1 ? `${taxRates[0] / 100}%` : "按明细税率";
  const finalUntaxedCents = ["RECONCILE_V1", "ALLOCATE_V2"].includes(snapshot.roundingPolicy) && snapshot.subtotalTaxedCents === snapshot.finalDiscountCents ? snapshot.subtotalUntaxedCents
    : taxRates.length === 1 ? Math.round((snapshot.finalDiscountCents * 10_000) / (10_000 + taxRates[0]))
    : snapshot.subtotalTaxedCents === snapshot.finalDiscountCents ? snapshot.subtotalUntaxedCents : 0;
  const tokens = {
    CUSTOMER_NAME: metadata.customerName || snapshot.customer.name,
    QUOTE_NUMBER: snapshot.quoteNumber,
    CONTACT_NAME: metadata.customerContactName || "",
    QUOTE_DATE: metadata.quoteDate || "",
    VALIDITY: metadata.validity || "30 天",
    CUSTOMER_PHONE: metadata.customerPhone || "",
    AMOUNT_UPPER: amountUppercase(snapshot.finalDiscountCents),
    DELIVERY_TERMS: metadata.deliveryTerms || "按双方合同约定",
    PAYMENT_TERMS: metadata.paymentTerms || "按双方合同约定",
    BANK_NAME: metadata.bankName || "",
    BANK_ACCOUNT: metadata.bankAccount || "",
    SELLER_NAME: metadata.sellerName || "",
    SELLER_PHONE: metadata.sellerPhone || "",
    SELLER_EMAIL: metadata.sellerEmail || "",
    TAX_RATE: taxRateLabel
  };
  for (const [key, value] of Object.entries(tokens)) documentXml = documentXml.split(`{{${key}}}`).join(xmlEscape(value));

  const tables = documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
  assert(tables.length === 3, 500, "QUOTE_TEMPLATE_STRUCTURE_INVALID", "报价模板主文档结构无效");
  const summaryRows = snapshot.items.map((item, index) => [
    index + 1, item.itemName, item.unit, quantity(item.quantityMilli), plainMoney(item.untaxedUnitPriceCents),
    plainMoney(item.untaxedAmountCents), plainMoney(item.taxedAmountCents), item.notes || ""
  ]);
  const discountNote = snapshot.discountAmountCents > 0 ? `优惠 ${plainMoney(snapshot.discountAmountCents)} 元` : "";
  documentXml = documentXml.replace(tables[1], rebuildQuoteTable(tables[1], summaryRows, [
    ["合计：", plainMoney(snapshot.subtotalUntaxedCents), plainMoney(snapshot.subtotalTaxedCents), ""],
    snapshot.discountAmountCents > 0 ? ["优惠后合计（含税）：", finalUntaxedCents ? plainMoney(finalUntaxedCents) : "按明细税率", plainMoney(snapshot.finalDiscountCents), discountNote] : null
  ]));
  const currentTables = documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
  const detailItems = snapshot.detailItems || [];
  const detailRows = detailItems.map((item, index) => [
    index + 1, item.itemName, item.subitemName || "", item.unit, quantity(item.quantityMilli), plainMoney(item.untaxedUnitPriceCents),
    plainMoney(item.untaxedAmountCents + (snapshot.roundingPolicy === "ALLOCATE_V2" ? (snapshot.detailRoundingAllocationsCents?.[index] || 0) : 0)), plainMoney(item.taxedAmountCents), item.notes || ""
  ]);
  if (snapshot.roundingPolicy !== "ALLOCATE_V2" && snapshot.detailRoundingAdjustmentCents) {
    const adjustment = snapshot.detailRoundingAdjustmentCents;
    detailRows.push(["", "尾差调整", "", "", "", "", `${adjustment > 0 ? "+" : ""}${plainMoney(adjustment)}`, "", "相同含税总额及税率的四舍五入尾差"]);
  }
  documentXml = documentXml.replace(currentTables[2], rebuildQuoteTable(currentTables[2], detailRows, [
    ["合计：", plainMoney(snapshot.detailSubtotalUntaxedCents || 0), plainMoney(snapshot.detailSubtotalTaxedCents || 0), ""],
    [snapshot.notes || ""]
  ]));

  const attachments = previewAttachments ?? quoteAttachmentFiles(db, config, versionId);
  if (attachments.length) {
    let relationships = await zip.file("word/_rels/document.xml.rels").async("string");
    let contentTypes = await zip.file("[Content_Types].xml").async("string");
    let attachmentXml = "";
    for (const [index, attachment] of attachments.entries()) {
      const title = `附件${chineseOrdinal(index)}  ${attachment.original_name.replace(/\.[^.]+$/, "")}`;
      attachmentXml += attachmentTitleXml(title);
      const relationId = `rIdQuoteAttachment${index + 1}`;
      if (attachment.mime_type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        const fileName = `quote-attachment-${index + 1}.docx`;
        zip.file(`word/${fileName}`, attachment.buffer);
        relationships = relationships.replace("</Relationships>", `<Relationship Id="${relationId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="${fileName}" TargetMode="Internal"/></Relationships>`);
        contentTypes = contentTypes.replace("</Types>", `<Override PartName="/word/${fileName}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
        attachmentXml += `<w:altChunk r:id="${relationId}"/><w:p/>`;
      } else if (attachment.mime_type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
        const fileName = `quote-attachment-${index + 1}.html`;
        zip.file(`word/${fileName}`, await excelAttachmentHtml(attachment.buffer));
        relationships = relationships.replace("</Relationships>", `<Relationship Id="${relationId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="${fileName}" TargetMode="Internal"/></Relationships>`);
        if (!/<Default\b[^>]*\bExtension="html"/i.test(contentTypes)) contentTypes = contentTypes.replace("</Types>", '<Default Extension="html" ContentType="text/html"/></Types>');
        attachmentXml += `<w:altChunk r:id="${relationId}"/><w:p/>`;
      } else {
        attachmentXml += `<w:p><w:r><w:t xml:space="preserve">该附件请在系统中在线查看或下载：${xmlEscape(attachment.original_name)}</w:t></w:r></w:p>`;
      }
    }
    documentXml = documentXml.replace("<w:sectPr", `${attachmentXml}<w:sectPr`);
    zip.file("word/_rels/document.xml.rels", relationships);
    zip.file("[Content_Types].xml", contentTypes);
  }
  zip.file("word/document.xml", documentXml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// 该功能只用于测试环境查看版式，不归档为正式报价，也不改变审批状态。
export async function previewUnapprovedQuoteDocx(db, config, actor, versionId) {
  assert(config.dataMode === "TEST" && config.allowUnapprovedQuoteExport === true, 404, "QUOTE_PREVIEW_DISABLED", "未审批预览功能未开放");
  const getAuthorizedDraft = () => {
    const view = getQuoteVersion(db, actor, versionId);
    const owner = db.prepare(`SELECT c.owner_id, q.current_version_id FROM quote_versions v JOIN quotes q ON q.id = v.quote_id JOIN customers c ON c.id = q.customer_id WHERE v.id = ?`).get(versionId);
    assert(actor.role === "ADMIN" || (actor.role === "PRESALES" && owner?.owner_id === actor.id), 403, "QUOTE_PREVIEW_FORBIDDEN", "仅管理员或客户当前负责人可以导出预览");
    assert(view.status === QUOTE_STATUSES.DRAFT && owner?.current_version_id === versionId, 409, "QUOTE_PREVIEW_NOT_DRAFT", "仅未发送的当前报价可以导出预览");
    return view;
  };
  const quote = getAuthorizedDraft();
  assert(quote.sourceKind !== "UPLOADED", 409, "UPLOADED_QUOTE_ORIGINAL_ONLY", "上传报价请查看或下载原文件");
  const mismatch = quoteDetailTotalsMismatch(quote.items, quote.detailItems);
  assert(!mismatch, 422, "QUOTE_DETAIL_TOTAL_MISMATCH", mismatch ? quoteDetailTotalsMismatchMessage(mismatch) : "");
  const snapshot = makeContentSnapshot(db, versionId, []);
  const contentHash = sha256(JSON.stringify(snapshot));
  const attachmentIdentity = view => JSON.stringify((view.attachments?.items || []).map(item => [item.id, item.currentVersionId, item.currentVersion?.sha256]));
  const attachmentsHash = attachmentIdentity(quote);
  const attachments = (quote.attachments?.items || []).map(item => {
    const file = getAttachmentDownload(db, config, actor, item.id, item.currentVersionId);
    return { original_name: file.downloadName, mime_type: file.mimeType, buffer: file.buffer };
  });
  const buffer = await renderApprovedQuoteTemplate(db, config, versionId, snapshot, attachments);
  const latest = getAuthorizedDraft();
  assert(contentHash === sha256(JSON.stringify(makeContentSnapshot(db, versionId, []))) && attachmentsHash === attachmentIdentity(latest), 409, "QUOTE_PREVIEW_CHANGED", "报价或附件已更新，请重新导出预览");
  const zip = await JSZip.loadAsync(buffer);
  const part = zip.file("word/document.xml");
  const xml = await part.async("string");
  assert(xml.includes("<w:body>"), 500, "QUOTE_TEMPLATE_STRUCTURE_INVALID", "报价模板主文档结构无效");
  zip.file("word/document.xml", xml.replace("<w:body>", '<w:body><w:p><w:r><w:rPr><w:color w:val="C00000"/><w:b/></w:rPr><w:t>未审批预览，仅用于查看效果</w:t></w:r></w:p>'));
  const previewBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  // 压缩为异步操作，发送之前再次核查权限和版本。
  const finalView = getAuthorizedDraft();
  assert(contentHash === sha256(JSON.stringify(makeContentSnapshot(db, versionId, []))) && attachmentsHash === attachmentIdentity(finalView), 409, "QUOTE_PREVIEW_CHANGED", "报价或附件已更新，请重新导出预览");
  audit(db, { actorId: actor.id, action: "QUOTE_PREVIEW_DOCX_EXPORTED", entityType: "QUOTE_VERSION", entityId: versionId, summary: { revision: quote.revision } });
  return { buffer: previewBuffer, name: `${cleanName(quote.quoteNumber, "报价")}-V${quote.revision}.0-未审批预览.docx` };
}

function baseRun(text, options = {}) {
  return new TextRun({ text: String(text ?? ""), font: "Microsoft YaHei", ...(options.size ? { size: options.size } : {}), bold: options.bold, color: options.color, italics: options.italics });
}

function paragraph(text, options = {}) {
  return new Paragraph({
    children: [baseRun(text, options)],
    heading: options.heading,
    alignment: options.alignment,
    spacing: { before: options.before ?? 0, after: options.after ?? 120, line: options.line ?? 264 },
    keepNext: options.keepNext
  });
}

function cell(text, width, { header = false, align = AlignmentType.LEFT } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    verticalAlign: VerticalAlign.CENTER,
    shading: header ? { type: ShadingType.CLEAR, fill: COLORS.light } : undefined,
    children: [new Paragraph({ alignment: align, spacing: { before: 0, after: 0, line: 240 }, children: [baseRun(text, { size: header ? 20 : 19, bold: header })] })]
  });
}

function table(rows, widths) {
  return new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders,
    rows: rows.map((values, rowIndex) => new TableRow({ tableHeader: rowIndex === 0, children: values.map((value, index) => cell(value, widths[index], { header: rowIndex === 0, align: index === 0 ? AlignmentType.LEFT : AlignmentType.LEFT })) }))
  });
}

function documentShell(title, subtitle, body) {
  return new Document({
    creator: "Haihong Presales Hub",
    lastModifiedBy: "Haihong Presales Hub",
    title,
    description: subtitle,
    styles: {
      default: { document: { run: { font: "Microsoft YaHei", size: 22, color: "24313D" }, paragraph: { spacing: { after: 120, line: 264 } } } },
      paragraphStyles: [
        { id: "DocTitle", name: "Document Title", basedOn: "Normal", next: "Normal", run: { font: "Microsoft YaHei", size: 46, bold: true, color: "17324D" }, paragraph: { spacing: { before: 0, after: 80 }, keepNext: true } },
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Microsoft YaHei", size: 32, bold: true, color: COLORS.blue }, paragraph: { spacing: { before: 320, after: 160 }, keepNext: true, outlineLevel: 0 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Microsoft YaHei", size: 26, bold: true, color: COLORS.blue }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true, outlineLevel: 1 } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Microsoft YaHei", size: 24, bold: true, color: COLORS.darkBlue }, paragraph: { spacing: { before: 160, after: 80 }, keepNext: true, outlineLevel: 2 } }
      ]
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 708, footer: 708 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 0 }, children: [baseRun("Haihong Presales Hub", { size: 18, color: COLORS.muted })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [baseRun("第 ", { size: 18, color: COLORS.muted }), new TextRun({ children: [PageNumber.CURRENT], size: 18, color: COLORS.muted }), baseRun(" 页", { size: 18, color: COLORS.muted })] })] }) },
      children: [
        new Paragraph({ style: "DocTitle", children: [baseRun(title, { size: 46, bold: true, color: "17324D" })] }),
        paragraph(subtitle, { size: 24, color: COLORS.muted, after: 280 }),
        ...body
      ]
    }]
  });
}

function surveyBody(survey) {
  const schema = survey.template.schema;
  const response = survey.response;
  const body = [
    table([
      ["客户", survey.customer.name],
      ["项目", survey.project.name],
      ["模板版本", `${survey.template.code} ${survey.template.version}`],
      ["调研状态", survey.status === "COMPLETED" ? "已完成确认" : "草稿"],
      ["记录修订", `第 ${survey.revision} 版`],
      ["完成时间", survey.completedAt || "—"]
    ], [1800, 7560]),
    paragraph("调研问答", { heading: HeadingLevel.HEADING_1, before: 320, after: 120 })
  ];
  for (const module of schema.modules || []) {
    body.push(paragraph(module.name, { heading: HeadingLevel.HEADING_2, before: 240, after: 100 }));
    for (const question of module.questions || []) {
      const answer = response.answers?.[question.id] || {};
      body.push(paragraph(`${question.prompt}${question.required ? "（必填）" : ""}`, { heading: HeadingLevel.HEADING_3, before: 140, after: 60 }));
      body.push(paragraph(answer.record || "未填写", { after: 60 }));
      if (answer.solution) body.push(paragraph(`解决方案及补充：${answer.solution}`, { color: COLORS.darkBlue, after: 100 }));
    }
  }
  body.push(paragraph("专项清单", { heading: HeadingLevel.HEADING_1, before: 320, after: 120 }));
  for (const definition of schema.tables || []) {
    body.push(paragraph(definition.name, { heading: HeadingLevel.HEADING_2, before: 240, after: 100 }));
    const rows = response.tables?.[definition.key] || [];
    if (!rows.length) {
      body.push(paragraph("未填写", { color: COLORS.muted }));
      continue;
    }
    const widths = definition.fields.map((_field, index) => {
      const base = Math.floor(TABLE_WIDTH / definition.fields.length);
      return index === definition.fields.length - 1 ? TABLE_WIDTH - base * (definition.fields.length - 1) : base;
    });
    body.push(table([definition.fields.map(field => field.label), ...rows.map(row => definition.fields.map(field => row[field.key] ?? ""))], widths));
  }
  return body;
}

async function surveyReportBuffer(survey) {
  const document = documentShell("软件调研报告", `${survey.customer.name} / ${survey.project.name} · 模板 ${survey.template.version}`, surveyBody(survey));
  return Packer.toBuffer(document);
}

function quoteBody(snapshot, approvals, snapshotHash) {
  const widths = [700, 1200, 2500, 600, 1200, 800, 2360];
  const rows = [["序号", "分类", "项目 / 子项", "单位", "数量", "税率", "含税金额"], ...snapshot.items.map(item => [
    item.lineNo,
    item.category,
    [item.itemName, item.subitemName].filter(Boolean).join(" / "),
    item.unit,
    quantity(item.quantityMilli),
    `${item.taxRateBps / 100}%`,
    money(item.taxedAmountCents)
  ])];
  const body = [
    table([
      ["报价编号", snapshot.quoteNumber],
      ["报价版本", `V${snapshot.revision}.0`],
      ["客户", snapshot.customer.name],
      ["项目", snapshot.project.name],
      ["审批快照摘要", snapshotHash]
    ], [1800, 7560]),
    paragraph("报价明细", { heading: HeadingLevel.HEADING_1, before: 320, after: 120 }),
    table(rows, widths),
    paragraph("金额汇总", { heading: HeadingLevel.HEADING_1, before: 320, after: 120 }),
    table([
      ["明细未税合计", money(snapshot.subtotalUntaxedCents)],
      ["明细含税合计（原值）", money(snapshot.subtotalTaxedCents)],
      ["优惠金额（仅汇总展示）", money(snapshot.discountAmountCents)],
      ["最终优惠价", money(snapshot.finalDiscountCents)]
    ], [5200, 4160]),
    paragraph("审批记录", { heading: HeadingLevel.HEADING_1, before: 320, after: 120 }),
    table([["审批阶段", "审批人", "结果", "意见", "时间"], ...approvals.map(item => [{ MANAGER: "研发经理", GENERAL_MANAGER: "综合部经理", VP: "副总经理" }[item.stage] || "审批人", item.approverName, item.decision === "APPROVED" ? "通过" : "退回", item.comment, item.createdAt])], [1400, 1500, 900, 3500, 2060])
  ];
  if (snapshot.notes) body.push(paragraph("报价备注", { heading: HeadingLevel.HEADING_1, before: 320, after: 120 }), paragraph(snapshot.notes));
  return body;
}

async function approvedQuoteBuffer(db, config, actor, versionId) {
  getQuoteVersion(db, actor, versionId);
  const row = db.prepare(`SELECT status, snapshot_json, snapshot_hash FROM quote_versions WHERE id = ?`).get(versionId);
  assert(row?.status === QUOTE_STATUSES.APPROVED, 422, "QUOTE_NOT_APPROVED", "只有审批完成的报价可以导出 Word");
  assert(row.snapshot_json && sha256(row.snapshot_json) === row.snapshot_hash, 409, "QUOTE_SNAPSHOT_INVALID", "报价内容快照校验失败，禁止导出");
  const approvalRow = db.prepare(`
    SELECT qas.snapshot_json, qas.snapshot_hash
    FROM quote_approval_snapshots qas
    JOIN quote_approvals qa ON qa.id = qas.approval_id
    WHERE qas.quote_version_id = ? AND qa.stage = 'VP' AND qa.decision = 'APPROVED'
    ORDER BY qas.created_at DESC, qas.rowid DESC LIMIT 1
  `).get(versionId);
  assert(approvalRow?.snapshot_json && sha256(approvalRow.snapshot_json) === approvalRow.snapshot_hash, 409, "QUOTE_APPROVAL_SNAPSHOT_INVALID", "报价终审快照校验失败，禁止导出");
  const finalApprovalSnapshot = JSON.parse(approvalRow.snapshot_json);
  const snapshot = finalApprovalSnapshot.content;
  assert(snapshot?.quoteVersionId === versionId && sha256(JSON.stringify(snapshot)) === row.snapshot_hash, 409, "QUOTE_APPROVAL_CONTENT_INVALID", "报价终审快照与锁定内容不一致，禁止导出");
  assert(snapshot.sourceKind !== "UPLOADED", 409, "UPLOADED_QUOTE_ORIGINAL_ONLY", "上传报价请下载已审批的原文件");
  const calculated = calculateQuoteItems(snapshot.items);
  assert(calculated.subtotalUntaxedCents === snapshot.subtotalUntaxedCents && calculated.subtotalTaxedCents === snapshot.subtotalTaxedCents, 409, "QUOTE_SNAPSHOT_AMOUNT_INVALID", "报价审批快照金额复核失败，禁止导出");
  assert(Number.isSafeInteger(snapshot.finalDiscountCents) && snapshot.finalDiscountCents > 0 && snapshot.finalDiscountCents <= snapshot.subtotalTaxedCents && snapshot.discountAmountCents === snapshot.subtotalTaxedCents - snapshot.finalDiscountCents, 409, "QUOTE_SNAPSHOT_DISCOUNT_INVALID", "报价审批快照优惠金额复核失败，禁止导出");
  const approvals = finalApprovalSnapshot.approvals || [];
  const requiredStages = Array.isArray(snapshot.approvalWorkflow) ? snapshot.approvalWorkflow : ["MANAGER", "VP"];
  assert(approvals.length === requiredStages.length && approvals.every((item, index) => item.stage === requiredStages[index] && item.decision === "APPROVED"), 409, "QUOTE_APPROVAL_CHAIN_INVALID", "报价终审快照缺少完整的顺序通过记录");
  const users = new Map(db.prepare(`SELECT id, display_name FROM users`).all().map(item => [item.id, item.display_name]));
  const approvalViews = approvals.map(item => ({ ...item, approverName: users.get(item.approverId) || "未知审批人" }));
  return { buffer: await renderApprovedQuoteTemplate(db, config, versionId, snapshot), snapshot, approvalSnapshotHash: approvalRow.snapshot_hash };
}

export async function exportSurveyDocx(db, config, actor, surveyId) {
  const survey = getSurvey(db, actor, surveyId);
  assert(survey.status === "COMPLETED", 422, "SURVEY_NOT_COMPLETED", "只有完成确认的软件调研可以导出正式报告");
  const buffer = await surveyReportBuffer(survey);
  const file = storeFile(db, config, actor, { entityType: "SURVEY", entityId: survey.id, category: "SURVEY_REPORT_DOCX", originalName: `${cleanName(survey.customer.name, "客户")}-${cleanName(survey.project.name, "项目")}-软件调研-R${survey.revision}.docx`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer });
  audit(db, { actorId: actor.id, action: "SURVEY_DOCX_EXPORTED", entityType: "SURVEY", entityId: survey.id, summary: { fileId: file.id, revision: survey.revision, templateVersion: survey.template.version } });
  return file;
}

export async function exportApprovedQuoteDocx(db, config, actor, versionId) {
  const { buffer, snapshot, approvalSnapshotHash } = await approvedQuoteBuffer(db, config, actor, versionId);
  const file = storeFile(db, config, actor, { entityType: "QUOTE_VERSION", entityId: versionId, category: "APPROVED_QUOTE_DOCX", originalName: `${cleanName(snapshot.quoteNumber, "报价")}-V${snapshot.revision}.0-已审批.docx`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer });
  audit(db, { actorId: actor.id, action: "APPROVED_QUOTE_DOCX_EXPORTED", entityType: "QUOTE_VERSION", entityId: versionId, summary: { fileId: file.id, approvalSnapshotHash, subtotalTaxedCents: snapshot.subtotalTaxedCents, finalDiscountCents: snapshot.finalDiscountCents } });
  return file;
}

export const __test = { surveyReportBuffer, approvedQuoteBuffer, excelAttachmentHtml };

export async function exportCustomerFollowupsDocx(db, config, actor, customerId) {
  const customer = getCustomer(db, actor, customerId);
  const followups = listFollowups(db, actor, customerId);
  const body = [];
  for (const item of followups) {
    const occurred = item.occurredPrecision === "DAY" ? `${item.occurredAt}（日精度，原文未记录时分）` : item.occurredAt;
    body.push(paragraph(`${occurred} · ${item.method}`, { heading: HeadingLevel.HEADING_1 }), paragraph(item.content),
      paragraph(`参与人：${item.participants.join("、") || (item.historical ? "原文未记录" : "未填写")}`),
      paragraph(`客户反馈：${item.customerFeedback || (item.historical ? "原文未记录" : "未填写")}`),
      paragraph(`下一步：${item.nextAction || (item.historical ? "原文未记录" : "未填写")}`));
    if (item.source) body.push(paragraph(`来源：${item.source.sourceSha256} / ${item.source.sheetName}!${item.source.cellReference} / 第${item.source.paragraphNumber}段`),
      paragraph(`原日期：${item.source.rawDate}；原方式：${item.source.rawMethod || "未标注"}；批次：${item.source.batchId}；操作人：${item.recordedBy.displayName}；导入时间：${item.source.importedAt}`),
      paragraph("原始全文（纠错不覆盖）："), paragraph(item.source.rawText));
  }
  const buffer = await Packer.toBuffer(documentShell("客户跟进记录", customer.fullName, body.length ? body : [paragraph("暂无跟进记录")]));
  // Word 生成期间可能发生转让；归档前重新验证，不能用旧权限完成导出。
  requireCustomerAccess(db, actor, customerId);
  const file = storeFile(db, config, actor, { entityType: "CUSTOMER", entityId: customerId, category: "FOLLOWUPS_DOCX", originalName: `${cleanName(customer.fullName, "客户")}-跟进记录.docx`, buffer });
  audit(db, { actorId: actor.id, action: "FOLLOWUPS_DOCX_EXPORTED", entityType: "CUSTOMER", entityId: customerId, summary: { fileId: file.id, count: followups.length } });
  return file;
}
