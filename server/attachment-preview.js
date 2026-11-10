import ExcelJS from "exceljs";
import JSZip from "jszip";
import path from "node:path";
import { SaxesParser } from "saxes";
import { AppError } from "./domain.js";

const HTML_MIME = "text/html; charset=utf-8";
const MAX_SHEET_ROWS = 500;
const MAX_SHEET_COLUMNS = 40;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function taggedText(xml, tag) {
  return [...String(xml || "").matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi"))]
    .map(match => decodeXml(match[1].replace(/<[^>]+>/g, "")))
    .join("");
}

function previewDocument(title, description, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/attachment-preview.css"><style>
    :root{color-scheme:light;font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;color:#172b43;background:#eef3f7}*{box-sizing:border-box}body{margin:0}.bar{position:sticky;top:0;z-index:2;padding:14px 22px;border-bottom:1px solid #dce4eb;background:rgba(255,255,255,.96)}.bar strong{display:block;font-size:16px;overflow-wrap:anywhere}.bar small{display:block;margin-top:4px;color:#66788c}.page{max-width:1160px;margin:18px auto;padding:28px;border:1px solid #dce4eb;border-radius:12px;background:#fff;box-shadow:0 8px 28px rgba(23,43,67,.08)}p{margin:0 0 10px;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere}.empty{padding:44px;color:#66788c;text-align:center}.sheet{margin:0 0 28px}.sheet h2,.slide h2{margin:0 0 12px;font-size:17px}.table-wrap{max-width:100%;overflow:auto;border:1px solid #dce4eb;border-radius:8px}table{border-collapse:collapse;min-width:100%;font-size:13px}th,td{min-width:100px;max-width:360px;padding:8px 10px;border:1px solid #e3e9ee;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}th{position:sticky;top:0;background:#f5f8fa}.slide{min-height:240px;margin:0 0 18px;padding:24px;border:1px solid #dce4eb;border-radius:10px;background:#fff}.slide p{font-size:15px}.notice{margin-bottom:18px;padding:10px 12px;border:1px solid #c9dff1;border-radius:8px;color:#315d7c;background:#eef7ff}.page img{max-width:100%;height:auto}
  </style></head><body><header class="bar"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small></header><main class="page"><div class="notice">这是系统生成的在线内容预览，便于快速查看；Office 原文件的分页、字体和复杂版式可能与预览不同，正式修改请下载原文件。</div>${body}</main></body></html>`;
}

async function previewDocx(file) {
  const zip = await JSZip.loadAsync(file.buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new AppError(422, "ATTACHMENT_PREVIEW_UNAVAILABLE", "Word 文件缺少正文，无法在线预览");
  const xml = await entry.async("string");
  const document = parsePreviewXml(xml);
  const media = await wordPreviewImages(zip);
  const content = document.children.map(node => renderWordPreviewNode(node, media)).join("");
  const body = content || `<div class="empty">正文中没有可预览的内容</div>`;
  return { buffer: Buffer.from(previewDocument(file.downloadName, "Word 内容预览", body)), mimeType: HTML_MIME };
}

function parsePreviewXml(xml) {
  const root = { name: "root", attrs: {}, children: [] };
  const stack = [root];
  let nodeCount = 0;
  const parser = new SaxesParser({ xmlns: false });
  parser.on("doctype", () => { throw new AppError(422, "ATTACHMENT_PREVIEW_UNAVAILABLE", "文件包含不支持的 XML 内容"); });
  parser.on("opentag", tag => {
    if (++nodeCount > 120_000 || stack.length > 128) throw new AppError(422, "ATTACHMENT_PREVIEW_UNAVAILABLE", "文档内容过于复杂，请下载原文件查看");
    const node = { name: tag.name, attrs: tag.attributes, children: [] };
    stack.at(-1).children.push(node);
    stack.push(node);
  });
  const appendText = text => { if (stack.at(-1).name === "w:t") stack.at(-1).children.push(text); };
  parser.on("text", appendText);
  parser.on("cdata", appendText);
  parser.on("closetag", () => { stack.pop(); });
  parser.write(xml).close();
  return root;
}

function findPreviewNode(node, name) {
  if (typeof node === "string") return null;
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = findPreviewNode(child, name);
    if (found) return found;
  }
  return null;
}

async function wordPreviewImages(zip) {
  const rels = zip.file("word/_rels/document.xml.rels");
  if (!rels) return new Map();
  const tree = parsePreviewXml(await rels.async("string"));
  const relationships = findPreviewNode(tree, "Relationships");
  const images = new Map();
  let totalBytes = 0;
  for (const relation of relationships?.children || []) {
    if (images.size >= 20 || relation.name !== "Relationship" || relation.attrs.TargetMode === "External" || !String(relation.attrs.Type || "").endsWith("/image")) continue;
    const target = path.posix.normalize(path.posix.join("word", String(relation.attrs.Target || "")));
    if (!target.startsWith("word/media/")) continue;
    const extension = path.posix.extname(target).toLowerCase();
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" }[extension];
    const entry = mime && zip.file(target);
    if (!entry) continue;
    const buffer = await entry.async("nodebuffer");
    if (!buffer.length || buffer.length > 5 * 1024 * 1024 || totalBytes + buffer.length > 12 * 1024 * 1024) continue;
    const valid = mime === "image/png" ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === "image/jpeg" ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
        : /^GIF8[79]a/.test(buffer.subarray(0, 6).toString("ascii"));
    if (!valid) continue;
    totalBytes += buffer.length;
    images.set(String(relation.attrs.Id), `data:${mime};base64,${buffer.toString("base64")}`);
  }
  return images;
}

function renderWordPreviewNode(node, media) {
  if (typeof node === "string") return escapeHtml(node);
  const children = () => node.children.map(child => renderWordPreviewNode(child, media)).join("");
  if (["w:document", "w:body", "root", "w:hyperlink", "w:sdt", "w:sdtContent"].includes(node.name)) return children();
  if (node.name === "w:tbl") return `<div class="table-wrap"><table><tbody>${children()}</tbody></table></div>`;
  if (node.name === "w:tr") return `<tr>${children()}</tr>`;
  if (node.name === "w:tc") {
    const span = Number(findPreviewNode(node.children.find(child => child.name === "w:tcPr") || { name: "", children: [] }, "w:gridSpan")?.attrs["w:val"] || 1);
    return `<td${Number.isInteger(span) && span > 1 && span <= 40 ? ` colspan="${span}"` : ""}>${children()}</td>`;
  }
  if (node.name === "w:p") return `<p>${children() || "&nbsp;"}</p>`;
  if (node.name === "w:r") {
    let content = children();
    const properties = node.children.find(child => child.name === "w:rPr");
    const enabled = name => properties?.children.some(child => child.name === name && !["0", "false", "none"].includes(String(child.attrs["w:val"] || "").toLowerCase()));
    if (enabled("w:b")) content = `<strong>${content}</strong>`;
    if (enabled("w:i")) content = `<em>${content}</em>`;
    if (enabled("w:u")) content = `<u>${content}</u>`;
    return content;
  }
  if (node.name === "w:t") return children();
  if (["w:br", "w:cr"].includes(node.name)) return "<br>";
  if (node.name === "w:tab") return "&#8195;";
  if (["w:drawing", "w:pict"].includes(node.name)) {
    const id = findPreviewNode(node, "a:blip")?.attrs["r:embed"];
    return media.has(id) ? `<img src="${media.get(id)}" alt="附件图片">` : `<span>（图片请查看原件）</span>`;
  }
  return "";
}

function displayedCellValue(cell) {
  if (cell.text) return cell.text;
  if (cell.value && typeof cell.value === "object" && "formula" in cell.value) return cell.value.result ?? cell.value.formula ?? "";
  return cell.value ?? "";
}

function excelPreviewMerges(worksheet, rowCount, columnCount) {
  const anchors = new Map();
  const covered = new Set();
  const address = value => {
    const match = value.match(/^\$?([A-Z]+)\$?(\d+)$/i);
    if (!match) return null;
    const column = [...match[1].toUpperCase()].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
    return { row: Number(match[2]), column };
  };
  for (const range of worksheet.model.merges || []) {
    const [start, end] = String(range).split(":").map(address);
    if (!start || !end || start.row > rowCount || start.column > columnCount) continue;
    const bottom = Math.min(end.row, rowCount);
    const right = Math.min(end.column, columnCount);
    if (bottom < start.row || right < start.column) continue;
    anchors.set(`${start.row}:${start.column}`, { rows: bottom - start.row + 1, columns: right - start.column + 1 });
    for (let row = start.row; row <= bottom; row += 1) for (let column = start.column; column <= right; column += 1) {
      if (row !== start.row || column !== start.column) covered.add(`${row}:${column}`);
    }
  }
  return { anchors, covered };
}

function excelPreviewStyle(cell) {
  const styles = [];
  if (cell.font?.bold) styles.push("font-weight:bold");
  if (cell.font?.italic) styles.push("font-style:italic");
  if (cell.font?.underline) styles.push("text-decoration:underline");
  if (["left", "center", "right", "justify"].includes(cell.alignment?.horizontal)) styles.push(`text-align:${cell.alignment.horizontal}`);
  const color = value => /^[0-9a-f]{8}$/i.test(value || "") ? `#${value.slice(2)}` : /^[0-9a-f]{6}$/i.test(value || "") ? `#${value}` : "";
  const fontColor = color(cell.font?.color?.argb);
  const fillColor = cell.fill?.type === "pattern" && cell.fill.pattern !== "none" ? color(cell.fill.fgColor?.argb) : "";
  if (fontColor) styles.push(`color:${fontColor}`);
  if (fillColor) styles.push(`background-color:${fillColor}`);
  return styles.length ? ` style="${styles.join(";")}"` : "";
}

async function previewXlsx(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  const sheets = workbook.worksheets.map(worksheet => {
    const rowCount = Math.min(worksheet.rowCount, MAX_SHEET_ROWS);
    const columnCount = Math.min(worksheet.columnCount, MAX_SHEET_COLUMNS);
    const merges = excelPreviewMerges(worksheet, rowCount, columnCount);
    const rows = [];
    for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
      const cells = [];
      for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) {
        const key = `${rowNumber}:${columnNumber}`;
        if (merges.covered.has(key)) continue;
        const span = merges.anchors.get(key);
        const cell = worksheet.getCell(rowNumber, columnNumber);
        cells.push(`<td${span?.rows > 1 ? ` rowspan="${span.rows}"` : ""}${span?.columns > 1 ? ` colspan="${span.columns}"` : ""}${excelPreviewStyle(cell)}>${escapeHtml(displayedCellValue(cell))}</td>`);
      }
      rows.push(`<tr>${cells.join("")}</tr>`);
    }
    const truncated = worksheet.rowCount > MAX_SHEET_ROWS || worksheet.columnCount > MAX_SHEET_COLUMNS
      ? `<p>为保证浏览流畅，本页仅显示前 ${MAX_SHEET_ROWS} 行、${MAX_SHEET_COLUMNS} 列；完整内容请下载原文件。</p>` : "";
    return `<section class="sheet"><h2>${escapeHtml(worksheet.name)}</h2>${truncated}<div class="table-wrap"><table><tbody>${rows.join("")}</tbody></table></div></section>`;
  }).join("");
  return { buffer: Buffer.from(previewDocument(file.downloadName, "Excel 内容预览", sheets || `<div class="empty">工作簿中没有可预览的工作表</div>`)), mimeType: HTML_MIME };
}

async function previewPptx(file) {
  const zip = await JSZip.loadAsync(file.buffer);
  const slides = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => Number(left.match(/(\d+)/)?.[1] || 0) - Number(right.match(/(\d+)/)?.[1] || 0));
  const rendered = [];
  for (const [index, name] of slides.entries()) {
    const xml = await zip.file(name).async("string");
    const paragraphs = [...xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gi)]
      .map(match => taggedText(match[1], "a:t"))
      .filter(text => text.trim());
    rendered.push(`<section class="slide"><h2>第 ${index + 1} 页</h2>${paragraphs.length ? paragraphs.map(text => `<p>${escapeHtml(text)}</p>`).join("") : `<p>本页没有可预览的文字</p>`}</section>`);
  }
  return { buffer: Buffer.from(previewDocument(file.downloadName, "PowerPoint 文字内容预览", rendered.join("") || `<div class="empty">演示文稿中没有可预览的页面</div>`)), mimeType: HTML_MIME };
}

export async function buildAttachmentPreview(file) {
  if (["application/pdf", "image/png", "image/jpeg"].includes(file.mimeType)) return { buffer: file.buffer, mimeType: file.mimeType };
  try {
    if (file.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return await previewDocx(file);
    if (file.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return await previewXlsx(file);
    if (file.mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return await previewPptx(file);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, "ATTACHMENT_PREVIEW_UNAVAILABLE", "附件内容无法生成在线预览，请下载原文件查看");
  }
  throw new AppError(415, "ATTACHMENT_PREVIEW_UNSUPPORTED", "该附件格式暂不支持在线预览");
}

export const __test = { escapeHtml, decodeXml, taggedText };
