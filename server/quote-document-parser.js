import JSZip from "jszip";
import ExcelJS from "exceljs";
import { SaxesParser } from "saxes";
import { AppError, assert } from "./domain.js";
import { parseQuotePdf } from "./quote-pdf-parser.js";

const WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const EXCEL_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_UNITS = 20000;
const MAX_TEXT = 2000000;
const clean = value => String(value ?? "").replace(/[\s\u3000]+/g, "");
function footerHint(value) {
  if (/^(?:交期|交货期)[:：]?/.test(value)) return "delivery";
  if (/^(?:付款方式|付款条款)[:：]?/.test(value)) return "payment";
  if (/^(?:开户行|开户银行)[:：]?/.test(value)) return "bank";
  if (/^(?:账号|帐号|账户|银行账号)[:：]?/.test(value)) return "account";
  return null;
}

function addUnit(units, unit, budget) {
  const text = String(unit.text || "");
  if (!text.trim() && !unit.image && !unit.unresolvedFormula && !unit.isMerged) return;
  budget.text += text.length;
  assert(units.length < MAX_UNITS && budget.text <= MAX_TEXT, 422, "QUOTE_REVIEW_TOO_COMPLEX", "文档内容较多，无法完整识别，请人工核对主报价");
  units.push({ ...unit, index: units.length });
}

async function readWord(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  assert(entry, 422, "QUOTE_REVIEW_DOCUMENT_INVALID", "Word 文件缺少正文，无法检查");
  const xml = await entry.async("string");
  const parser = new SaxesParser({ xmlns: false });
  const units = [];
  const budget = { text: 0 };
  const tables = [];
  const paragraphs = [];
  let tagText = false;
  let nodes = 0;
  let tableCounter = 0;
  let paragraphCounter = 0;
  let revisionDepth = 0;
  let textBoxDepth = 0;
  let seenSeller = false;
  const footerHints = new Set();
  const endOfMain = Symbol("end-of-main");
  parser.on("doctype", () => { throw new AppError(422, "QUOTE_REVIEW_DOCUMENT_INVALID", "文档包含不支持的内容"); });
  parser.on("opentag", tag => {
    if (++nodes > 200000) throw new AppError(422, "QUOTE_REVIEW_TOO_COMPLEX", "文档结构过于复杂，请人工核对主报价");
    const name = tag.name.split(":").at(-1);
    if (name === "ins" || name === "del") { revisionDepth++; if (paragraphs.length) paragraphs.at(-1).revision = true; }
    if (name === "txbxContent") { textBoxDepth++; if (paragraphs.length) paragraphs.at(-1).textBox = true; }
    if (name === "tbl") tables.push({ id: ++tableCounter, row: 0, cell: 0, cellMerged: false });
    if (name === "tr" && tables.length) { tables.at(-1).row++; tables.at(-1).cell = 0; }
    if (name === "tc" && tables.length) { tables.at(-1).cell++; tables.at(-1).cellMerged = false; tables.at(-1).cellFill = ""; }
    if (["gridSpan", "vMerge"].includes(name) && tables.length) tables.at(-1).cellMerged = true;
    if (name === "shd" && tables.length && !paragraphs.length) tables.at(-1).cellFill = String(tag.attributes["w:fill"] || "").toUpperCase();
    if (name === "p") {
      const table = tables.at(-1);
      const n = ++paragraphCounter;
      paragraphs.push({ text: "", image: false, fonts: [], fontSizes: [], fill: table?.cellFill || "", revision: revisionDepth > 0, textBox: textBoxDepth > 0, isMerged: table?.cellMerged || false, tableId: table?.id ?? null, row: table?.row ?? null, column: table?.cell ?? null,
        location: table ? `表${table.id} 第${table.row}行第${table.cell}格` : `正文第${n}段` });
    }
    if (paragraphs.length && name === "rFonts") {
      const font = tag.attributes["w:eastAsia"] || tag.attributes["w:ascii"];
      if (font) paragraphs.at(-1).fonts.push(String(font));
    }
    if (paragraphs.length && name === "sz" && tag.attributes["w:val"]) paragraphs.at(-1).fontSizes.push(Number(tag.attributes["w:val"]));
    if (paragraphs.length && ["drawing", "pict"].includes(name)) paragraphs.at(-1).image = true;
    if (paragraphs.length && ["br", "tab"].includes(name)) paragraphs.at(-1).text += name === "tab" ? "\t" : "\n";
    if (name === "t") tagText = true;
  });
  const append = text => { if (tagText && paragraphs.length) paragraphs.at(-1).text += text; };
  parser.on("text", append);
  parser.on("cdata", append);
  parser.on("closetag", tag => {
    const name = tag.name.split(":").at(-1);
    if (name === "t") tagText = false;
    if (name === "p") {
      const unit = paragraphs.pop();
      const lines = String(unit.text).split(/\r?\n/);
      for (const [lineIndex, line] of lines.entries()) {
        const part = { ...unit, text: line, image: lineIndex === 0 && unit.image,
          location: lines.length > 1 ? `${unit.location}第${lineIndex + 1}行` : unit.location };
        addUnit(units, part, budget);
        const normalized = clean(line);
        if (footerHint(normalized)) footerHints.add(footerHint(normalized));
        if (footerHints.size >= 2 && /^(?:报价人|报价员)[:：]?/.test(normalized)) seenSeller = true;
        if (seenSeller && attachmentHeading(line)) throw endOfMain;
      }
    }
    if (name === "tbl") tables.pop();
    if (name === "ins" || name === "del") revisionDepth--;
    if (name === "txbxContent") textBoxDepth--;
  });
  try { parser.write(xml).close(); } catch (error) {
    if (error === endOfMain) return { format: "DOCX", units, limitations: [] };
    if (error instanceof AppError) throw error;
    throw new AppError(422, "QUOTE_REVIEW_DOCUMENT_INVALID", "Word 正文无法解析，请人工核对主报价");
  }
  return { format: "DOCX", units, limitations: [] };
}

async function readExcel(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const units = [];
  const budget = { text: 0 };
  let seenSeller = false;
  let afterAttachmentHeading = false;
  const footerHints = new Set();
  for (const [sheetIndex, sheet] of workbook.worksheets.entries()) {
    if (afterAttachmentHeading) break;
    assert(sheetIndex < 50, 422, "QUOTE_REVIEW_TOO_COMPLEX", "未定位主报价范围，请人工核对工作表");
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => row.eachCell({ includeEmpty: false }, (cell, column) => {
      if (afterAttachmentHeading) return;
      if (cell.isMerged && cell.master?.address !== cell.address) {
        addUnit(units, { text: "", location: `${sheet.name}!${cell.address}`, sheetIndex, sheetName: sheet.name, tableId: `sheet:${sheetIndex}`,
          row: rowNumber, column, isMerged: true }, budget);
        return;
      }
      const value = cell.value;
      const isFormula = Boolean(value && typeof value === "object" && ("formula" in value || "sharedFormula" in value));
      const unresolvedFormula = isFormula && value.result === undefined;
      const text = unresolvedFormula ? "" : String(cell.text ?? "");
      const lines = text.split(/\r?\n/);
      for (const [lineIndex, line] of lines.entries()) {
        addUnit(units, { text: line, location: `${sheet.name}!${cell.address}${lines.length > 1 ? ` 第${lineIndex + 1}行` : ""}`, sheetIndex, sheetName: sheet.name, tableId: `sheet:${sheetIndex}`,
          row: rowNumber, column, fill: String(cell.fill?.fgColor?.argb || "").slice(-6).toUpperCase(), numFmt: cell.numFmt || "", isMerged: Boolean(cell.isMerged), isFormula, unresolvedFormula }, budget);
        const normalized = clean(line);
        if (footerHint(normalized)) footerHints.add(footerHint(normalized));
        if (footerHints.size >= 2 && /^(?:报价人|报价员)[:：]?/.test(normalized)) seenSeller = true;
        if (seenSeller && attachmentHeading(line)) { afterAttachmentHeading = true; break; }
      }
    }));
  }
  return { format: "XLSX", units, limitations: [] };
}

function attachmentHeading(text) {
  const value = clean(text);
  return value.length <= 80 && (/^附件[一二三四五六七八九十\d]+/.test(value) || /^附件(?:[：:\-—.、]|$)/.test(value));
}

function suggestBoundary(units) {
  const sellers = [];
  for (let index = 0; index < units.length; index++) {
    if (!/^(?:报价人|报价员)[:：]?/.test(clean(units[index].text))) continue;
    const before = units.slice(0, index).map(unit => clean(unit.text));
    const hints = [/^(?:交期|交货期)[:：]?/, /^(?:付款方式|付款条款)[:：]?/, /^(?:开户行|开户银行)[:：]?/, /^(?:账号|帐号|账户|银行账号)[:：]?/];
    if (hints.filter(pattern => before.some(text => pattern.test(text))).length >= 2) sellers.push(index);
  }
  const firstSeller = sellers[0] ?? units.length;
  const firstAttachment = units.findIndex((unit, index) => index > firstSeller && attachmentHeading(unit.text));
  const limit = firstAttachment < 0 ? units.length : firstAttachment;
  const candidates = [];
  for (const seller of sellers.filter(index => index < limit)) {
    for (let index = seller; index < Math.min(limit, seller + 16); index++) {
      if (!/^(?:邮箱|电子邮箱|E-?mail)[:：]?/i.test(clean(units[index].text))) continue;
      let end = index;
      let value = clean(units[index].text).replace(/^(?:邮箱|电子邮箱|E-?mail)[:：]?/i, "");
      if (!value && index + 1 < limit && !/^(?:附件|报价人|手机|电话|邮箱|电子邮箱)[:：]?/.test(clean(units[index + 1].text))) {
        end = index + 1;
        value = clean(units[end].text);
      }
      if (value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && end + 1 < limit) {
        const continuation = clean(units[end + 1].text);
        if (!attachmentHeading(continuation) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value + continuation)) end++;
      }
      candidates.push({ seller, email: index, end });
      break;
    }
  }
  if (candidates.length !== 1) return { endIndex: null, reason: candidates.length ? "识别到多处报价人邮箱，请选择主报价结束位置" : "未能确定报价人邮箱位置，请选择主报价结束位置" };
  return { endIndex: candidates[0].end, reason: "已按报价人信息区的邮箱行建议结束位置，请核对" };
}

export async function parseQuoteDocument(file) {
  const parsed = file.mimeType === WORD_MIME ? await readWord(file.buffer)
    : file.mimeType === EXCEL_MIME ? await readExcel(file.buffer)
      : file.mimeType === "application/pdf" ? await parseQuotePdf(file.buffer)
      : null;
  assert(parsed, 415, "QUOTE_REVIEW_FORMAT_INVALID", "报价文件格式不支持检查");
  assert(parsed.units.length, 422, "QUOTE_REVIEW_EMPTY", "未识别到报价正文，请人工核对");
  return { ...parsed, boundary: suggestBoundary(parsed.units) };
}

export const __test = { suggestBoundary, attachmentHeading, clean };
