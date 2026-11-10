import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { audit } from "./audit.js";
import { nowIso } from "./database.js";
import { AppError, assert, ROLES } from "./domain.js";
import { removeManagedFile, resolveManagedPath, safeDownloadName, storeManagedBuffer, validateUploadedFile } from "./file-service.js";
import { sha256 } from "./security.js";

export const CONTRACT_TEMPLATE_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const CONTRACT_TEMPLATE_MARKERS = Object.freeze({
  contractNumber: "{{CONTRACT_NUMBER}}",
  signLocation: "{{SIGN_LOCATION}}",
  signDate: "{{SIGN_DATE}}",
  partyAName: "{{PARTY_A_NAME}}",
  licenseScope: "{{LICENSE_SCOPE}}",
  partyALegalRepresentative: "{{PARTY_A_LEGAL_REP}}",
  partyARepresentative: "{{PARTY_A_REP}}",
  partyAZip: "{{PARTY_A_ZIP}}",
  partyAAddress: "{{PARTY_A_ADDRESS}}",
  partyAPhone: "{{PARTY_A_PHONE}}",
  productNames: "{{PRODUCT_NAMES}}",
  bodyUnit: "{{BODY_UNIT}}",
  bodyQuantity: "{{BODY_QUANTITY}}",
  bodyUntaxedUnitPrice: "{{BODY_UNTAXED_UNIT_PRICE}}",
  bodyUntaxedAmount: "{{BODY_UNTAXED_AMOUNT}}",
  bodyTaxRate: "{{BODY_TAX_RATE}}",
  bodyTaxedAmount: "{{BODY_TAXED_AMOUNT}}",
  bodySubtotal: "{{BODY_SUBTOTAL}}",
  contractAmount: "{{CONTRACT_AMOUNT}}",
  contractAmountUpper: "{{CONTRACT_AMOUNT_UPPER}}",
  maintenanceFee: "{{MAINTENANCE_FEE}}",
  maintenanceFeeUpper: "{{MAINTENANCE_FEE_UPPER}}"
});

export const CONTRACT_ATTACHMENT_MARKER = "{{ATTACHMENT_PRICE_TABLE}}";
const FIXED_STRUCTURE_ANCHORS = Object.freeze(["附件一：价格明细"]);

function slotPath(key, paragraphIndex, textNodeIndex, tableIndex = null, rowIndex = null, cellIndex = null, cellParagraphIndex = null) {
  return Object.freeze({ key, paragraphIndex, textNodeIndex, tableIndex, rowIndex, cellIndex, cellParagraphIndex });
}

export const PRODUCTION_CONTRACT_SLOT_PATHS = Object.freeze([
  slotPath("contractNumber", 1, 4),
  slotPath("partyAName", 3, 7),
  slotPath("signLocation", 7, 1),
  slotPath("signDate", 7, 6),
  slotPath("productNames", 23, 0, 0, 1, 1, 0),
  slotPath("bodyUnit", 25, 0, 0, 1, 2, 0),
  slotPath("bodyQuantity", 26, 0, 0, 1, 3, 0),
  slotPath("bodyUntaxedUnitPrice", 27, 0, 0, 1, 4, 0),
  slotPath("bodyUntaxedAmount", 28, 0, 0, 1, 5, 0),
  slotPath("bodyTaxRate", 29, 0, 0, 1, 6, 0),
  slotPath("bodyTaxedAmount", 30, 0, 0, 1, 7, 0),
  slotPath("bodySubtotal", 33, 0, 0, 2, 1, 0),
  slotPath("contractAmount", 36, 0, 0, 3, 1, 0),
  slotPath("contractAmountUpper", 38, 1, 0, 4, 0, 0),
  slotPath("licenseScope", 71, 7),
  slotPath("maintenanceFee", 88, 10),
  slotPath("maintenanceFeeUpper", 88, 16),
  slotPath("partyAName", 109, 2, 1, 0, 0, 0),
  slotPath("partyARepresentative", 110, 2, 1, 0, 0, 1),
  slotPath("partyALegalRepresentative", 111, 1, 1, 0, 0, 2),
  slotPath("partyAZip", 112, 1, 1, 0, 0, 3),
  slotPath("partyAAddress", 113, 1, 1, 0, 0, 4),
  slotPath("partyAPhone", 114, 1, 1, 0, 0, 5),
  slotPath("attachmentPriceTable", 147, 0)
]);

function slotPathLabel(path) {
  return path.tableIndex === null
    ? `P${path.paragraphIndex}/T${path.textNodeIndex}`
    : `TBL${path.tableIndex}/R${path.rowIndex}/C${path.cellIndex}/P${path.cellParagraphIndex}/T${path.textNodeIndex}`;
}

export const CONTRACT_TEMPLATE_MARKER_RULES = Object.freeze(Object.fromEntries(
  Object.keys(CONTRACT_TEMPLATE_MARKERS).map(key => {
    const locations = PRODUCTION_CONTRACT_SLOT_PATHS.filter(path => path.key === key).map(slotPathLabel);
    return [key, Object.freeze({ count: locations.length, locations: Object.freeze(locations) })];
  })
));
export const CONTRACT_TEMPLATE_MARKER_COUNTS = Object.freeze(Object.fromEntries(
  Object.entries(CONTRACT_TEMPLATE_MARKER_RULES).map(([key, rule]) => [key, rule.count])
));

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function countOccurrences(text, fragment) {
  if (!fragment) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(fragment, cursor)) !== -1) {
    count += 1;
    cursor += fragment.length;
  }
  return count;
}

function xmlEscape(value) {
  return String(value ?? "").replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);
}

function money(cents) {
  return `¥${(Number(cents) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function quantity(milli) {
  return (Number(milli) / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
}

function xmlParagraph(text, { bold = false, align = "left" } = {}) {
  return `<w:p><w:pPr><w:jc w:val="${align}"/></w:pPr><w:r><w:rPr>${bold ? "<w:b/>" : ""}<w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function xmlCell(text, width, { bold = false, align = "left" } = {}) {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:vAlign w:val="center"/><w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tcMar></w:tcPr>${xmlParagraph(text, { bold, align })}</w:tc>`;
}

function attachmentTableXml(snapshot) {
  const widths = [520, 1250, 1600, 650, 760, 1150, 1150, 700, 1580];
  const rows = [
    ["序号", "项目", "子项", "单位", "数量", "未税单价", "未税金额", "税率", "价税合计"],
    ...snapshot.items.map(item => [
      item.lineNo,
      item.itemName,
      item.subitemName || "—",
      item.unit,
      quantity(item.quantityMilli),
      money(item.untaxedUnitPriceCents),
      money(item.untaxedAmountCents),
      `${item.taxRateBps / 100}%`,
      money(item.taxedAmountCents)
    ])
  ];
  const rowXml = rows.map((row, rowIndex) => `<w:tr>${row.map((value, index) => xmlCell(value, widths[index], { bold: rowIndex === 0, align: index === 1 || index === 2 ? "left" : "center" })).join("")}</w:tr>`).join("");
  const summary = [
    xmlParagraph(`附件明细原含税合计：${money(snapshot.subtotalTaxedCents)}`, { bold: true, align: "right" }),
    xmlParagraph(`最终优惠价：${money(snapshot.finalDiscountCents)}`, { bold: true, align: "right" })
  ].join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid>${widths.map(width => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${rowXml}</w:tbl>${summary}`;
}

function attachmentParagraph(documentXml) {
  const paragraphs = documentXml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
  return paragraphs.find(paragraph => {
    const text = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(match => match[1]).join("");
    return text === CONTRACT_ATTACHMENT_MARKER;
  }) || null;
}

function xmlBlocks(xml, tag, offset = 0) {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "g"))]
    .map((match, index) => ({ raw: match[0], index, start: offset + match.index, end: offset + match.index + match[0].length }));
}

function productionMarker(key) {
  return key === "attachmentPriceTable" ? CONTRACT_ATTACHMENT_MARKER : CONTRACT_TEMPLATE_MARKERS[key];
}

function validateProductionSlotPaths(documentXml, issues) {
  const paragraphs = xmlBlocks(documentXml, "w:p");
  const tables = xmlBlocks(documentXml, "w:tbl");
  for (const expected of PRODUCTION_CONTRACT_SLOT_PATHS) {
    const paragraph = paragraphs[expected.paragraphIndex];
    const textNodes = paragraph
      ? [...paragraph.raw.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match, index) => ({ text: match[1], index }))
      : [];
    const marker = productionMarker(expected.key);
    let actualTableIndex = null;
    let actualRowIndex = null;
    let actualCellIndex = null;
    let actualCellParagraphIndex = null;
    const table = paragraph ? tables.find(item => item.start <= paragraph.start && paragraph.end <= item.end) : null;
    if (table) {
      actualTableIndex = table.index;
      const rows = xmlBlocks(table.raw, "w:tr", table.start);
      const row = rows.find(item => item.start <= paragraph.start && paragraph.end <= item.end);
      if (row) {
        actualRowIndex = row.index;
        const cells = xmlBlocks(row.raw, "w:tc", row.start);
        const cell = cells.find(item => item.start <= paragraph.start && paragraph.end <= item.end);
        if (cell) {
          actualCellIndex = cell.index;
          actualCellParagraphIndex = xmlBlocks(cell.raw, "w:p", cell.start).find(item => item.start === paragraph.start)?.index ?? null;
        }
      }
    }
    const locationMatches = textNodes[expected.textNodeIndex]?.text === marker
      && actualTableIndex === expected.tableIndex
      && actualRowIndex === expected.rowIndex
      && actualCellIndex === expected.cellIndex
      && actualCellParagraphIndex === expected.cellParagraphIndex;
    if (!locationMatches) {
      issues.push({ code: "CONTRACT_TEMPLATE_MARKER_LOCATION_INVALID", message: `模板变量 ${marker} 未位于已核验结构路径 ${slotPathLabel(expected)}` });
    }
  }
}

function slotLocations(documentXml) {
  const locations = [];
  for (const [key, marker] of Object.entries(CONTRACT_TEMPLATE_MARKERS)) {
    let cursor = 0;
    for (let occurrence = 0; occurrence < CONTRACT_TEMPLATE_MARKER_COUNTS[key]; occurrence += 1) {
      const index = documentXml.indexOf(marker, cursor);
      locations.push({ key, marker, fragment: marker, index, occurrence });
      cursor = index < 0 ? documentXml.length : index + marker.length;
    }
  }
  const paragraph = attachmentParagraph(documentXml);
  locations.push({ key: "attachmentPriceTable", marker: CONTRACT_ATTACHMENT_MARKER, fragment: paragraph, index: paragraph ? documentXml.indexOf(paragraph) : -1 });
  return locations.sort((left, right) => left.index - right.index);
}

function fixedSegments(documentXml, locations) {
  const segments = [];
  let cursor = 0;
  for (const location of locations) {
    assert(location.index >= cursor && location.fragment, 422, "CONTRACT_TEMPLATE_ANCHOR_INVALID", `合同模板变量 ${location.marker} 结构无效`);
    segments.push(documentXml.slice(cursor, location.index));
    cursor = location.index + location.fragment.length;
  }
  segments.push(documentXml.slice(cursor));
  return segments;
}

async function packageFingerprintFromSegments(zip, slotOrder, segments) {
  const parts = [];
  const entries = Object.values(zip.files).filter(entry => !entry.dir).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === "word/document.xml") {
      parts.push({ name: entry.name, slotOrder, fixedSegments: segments });
    } else {
      parts.push({ name: entry.name, sha256: sha256(await entry.async("nodebuffer")) });
    }
  }
  return sha256(JSON.stringify(parts));
}

async function packageFingerprint(zip, documentXml, locations) {
  return packageFingerprintFromSegments(zip, locations.map(item => item.key), fixedSegments(documentXml, locations));
}

function generatedFixedSegments(generatedXml, templateSegments, generatedFragments) {
  const actualSegments = [];
  let cursor = 0;
  for (let index = 0; index < generatedFragments.length; index += 1) {
    const expectedFixed = templateSegments[index];
    const actualFixed = generatedXml.slice(cursor, cursor + expectedFixed.length);
    actualSegments.push(actualFixed);
    cursor += expectedFixed.length;
    const fragment = generatedFragments[index];
    assert(generatedXml.slice(cursor, cursor + fragment.length) === fragment, 500, "CONTRACT_GENERATED_SLOT_INVALID", "生成文件白名单变量边界异常");
    cursor += fragment.length;
  }
  actualSegments.push(generatedXml.slice(cursor));
  return actualSegments;
}

async function loadZip(buffer) {
  try {
    return await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch {
    throw new AppError(422, "CONTRACT_TEMPLATE_PACKAGE_INVALID", "DOCX 压缩包结构损坏或无法读取");
  }
}

export async function validateContractTemplateBuffer(buffer) {
  const issues = [];
  let zip;
  try {
    zip = await loadZip(buffer);
  } catch (error) {
    return { ok: false, issues: [{ code: error.code, message: error.message }], fixedFingerprint: null, revisionCount: 0, commentCount: 0 };
  }
  const requiredParts = ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/numbering.xml"];
  for (const part of requiredParts) if (!zip.file(part)) issues.push({ code: "CONTRACT_TEMPLATE_PART_MISSING", message: `模板缺少必要 DOCX 结构：${part}` });
  const documentXml = zip.file("word/document.xml") ? await zip.file("word/document.xml").async("string") : "";
  const wordXml = await Promise.all(Object.values(zip.files).filter(entry => !entry.dir && entry.name.startsWith("word/") && entry.name.endsWith(".xml")).map(entry => entry.async("string")));
  const revisionCount = wordXml.reduce((sum, xml) => sum + (xml.match(/<w:(?:ins|del|moveFrom|moveTo|[A-Za-z]+PrChange)(?:\s|>)/g) || []).length, 0);
  const commentParts = Object.values(zip.files).filter(entry => !entry.dir && /^word\/comments[^/]*\.xml$/i.test(entry.name));
  const commentPartXml = await Promise.all(commentParts.map(entry => entry.async("string")));
  const commentDefinitions = commentPartXml.reduce((sum, xml) => sum + (xml.match(/<w:comment(?:\s|>)/g) || []).length, 0);
  const commentAnchors = wordXml.reduce((sum, xml) => sum + (xml.match(/<w:(?:commentRangeStart|commentRangeEnd|commentReference)(?:\s|>)/g) || []).length, 0);
  const commentCount = commentDefinitions + commentAnchors;
  if (revisionCount) issues.push({ code: "CONTRACT_TEMPLATE_REVISIONS_PENDING", message: `模板存在 ${revisionCount} 处未接受的修订，必须全部接受并经业务确认后再发布` });
  if (commentCount) issues.push({ code: "CONTRACT_TEMPLATE_COMMENTS_PRESENT", message: "模板存在批注或批注锚点，必须清理后再发布" });
  for (const [key, marker] of Object.entries(CONTRACT_TEMPLATE_MARKERS)) {
    const count = countOccurrences(documentXml, marker);
    const expected = CONTRACT_TEMPLATE_MARKER_COUNTS[key];
    if (count !== expected) issues.push({ code: "CONTRACT_TEMPLATE_ANCHOR_INVALID", message: `模板变量 ${marker} 必须以连续文本出现在显式配置的 ${expected} 个位置，当前为 ${count} 次` });
  }
  validateProductionSlotPaths(documentXml, issues);
  const allowedMarkers = new Set([...Object.values(CONTRACT_TEMPLATE_MARKERS), CONTRACT_ATTACHMENT_MARKER]);
  const unknownMarkers = [...new Set(documentXml.match(/\{\{[A-Z0-9_]+\}\}/g) || [])].filter(marker => !allowedMarkers.has(marker));
  if (unknownMarkers.length) issues.push({ code: "CONTRACT_TEMPLATE_UNKNOWN_MARKER", message: `模板包含未列入白名单的系统变量：${unknownMarkers.join("、")}` });
  const attachmentCount = countOccurrences(documentXml, CONTRACT_ATTACHMENT_MARKER);
  const attachment = attachmentParagraph(documentXml);
  if (attachmentCount !== 1 || !attachment) issues.push({ code: "CONTRACT_TEMPLATE_ATTACHMENT_ANCHOR_INVALID", message: `模板必须包含一个独立段落 ${CONTRACT_ATTACHMENT_MARKER}` });
  for (const anchor of FIXED_STRUCTURE_ANCHORS) if (!documentXml.includes(anchor)) issues.push({ code: "CONTRACT_TEMPLATE_STRUCTURE_ANCHOR_MISSING", message: `模板缺少固定结构锚点：${anchor}` });
  let fixedFingerprint = null;
  if (issues.length === 0) {
    fixedFingerprint = await packageFingerprint(zip, documentXml, slotLocations(documentXml));
  }
  const markerCount = Object.values(CONTRACT_TEMPLATE_MARKER_COUNTS).reduce((sum, count) => sum + count, 0) + 1;
  return { ok: issues.length === 0, issues, fixedFingerprint, revisionCount, commentCount, markerCount };
}

export async function verifyGeneratedContractBuffer(templateBuffer, generatedBuffer, values, snapshot) {
  const validation = await validateContractTemplateBuffer(templateBuffer);
  assert(validation.ok, 422, "CONTRACT_TEMPLATE_INVALID", "已发布模板重新校验失败，禁止生成合同", validation.issues);
  const originalZip = await loadZip(templateBuffer);
  const originalXml = await originalZip.file("word/document.xml").async("string");
  const locations = slotLocations(originalXml);
  const segments = fixedSegments(originalXml, locations);
  const tableXml = attachmentTableXml(snapshot);
  const fragments = locations.map(location => location.key === "attachmentPriceTable" ? tableXml : xmlEscape(values[location.key]));
  const generatedZip = await loadZip(generatedBuffer);
  const reloadedXml = await generatedZip.file("word/document.xml").async("string");
  const expectedXml = segments.reduce((result, segment, index) => result + segment + (fragments[index] || ""), "");
  assert(reloadedXml === expectedXml, 500, "CONTRACT_GENERATED_STRUCTURE_INVALID", "生成文件正文存在非白名单改动");
  const originalEntries = Object.values(originalZip.files).filter(entry => !entry.dir && entry.name !== "word/document.xml");
  for (const entry of originalEntries) {
    const before = await entry.async("nodebuffer");
    const afterEntry = generatedZip.file(entry.name);
    assert(afterEntry, 500, "CONTRACT_GENERATED_PART_MISSING", `生成文件丢失模板结构：${entry.name}`);
    const after = await afterEntry.async("nodebuffer");
    assert(sha256(before) === sha256(after), 500, "CONTRACT_GENERATED_FIXED_PART_CHANGED", `生成文件改动了非白名单结构：${entry.name}`);
  }
  const actualFixedSegments = generatedFixedSegments(reloadedXml, segments, fragments);
  const postFingerprint = await packageFingerprintFromSegments(generatedZip, locations.map(item => item.key), actualFixedSegments);
  assert(postFingerprint === validation.fixedFingerprint, 500, "CONTRACT_GENERATED_FINGERPRINT_MISMATCH", "生成文件固定正文指纹异常");
  return { fixedFingerprint: validation.fixedFingerprint, validation };
}

export async function generateContractFromTemplate(buffer, values, snapshot) {
  const validation = await validateContractTemplateBuffer(buffer);
  assert(validation.ok, 422, "CONTRACT_TEMPLATE_INVALID", "已发布模板重新校验失败，禁止生成合同", validation.issues);
  const zip = await loadZip(buffer);
  const originalXml = await zip.file("word/document.xml").async("string");
  const locations = slotLocations(originalXml);
  const segments = fixedSegments(originalXml, locations);
  const tableXml = attachmentTableXml(snapshot);
  const fragments = locations.map(location => location.key === "attachmentPriceTable" ? tableXml : xmlEscape(values[location.key]));
  let generatedXml = segments[0];
  for (let index = 0; index < locations.length; index += 1) generatedXml += fragments[index] + segments[index + 1];
  zip.file("word/document.xml", generatedXml);
  const generatedBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await verifyGeneratedContractBuffer(buffer, generatedBuffer, values, snapshot);
  return { buffer: generatedBuffer, fixedFingerprint: validation.fixedFingerprint, validation };
}

function templateView(row) {
  const validation = parseJson(row.validation_json, {});
  return {
    id: row.id,
    version: row.version,
    originalName: row.original_name,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    status: row.status,
    published: Boolean(row.is_published),
    validation,
    fixedFingerprint: row.fixed_fingerprint,
    uploadedBy: row.uploaded_by ? { id: row.uploaded_by, displayName: row.uploaded_by_name } : null,
    uploadedAt: row.uploaded_at,
    publishedBy: row.published_by ? { id: row.published_by, displayName: row.published_by_name } : null,
    publishedAt: row.published_at
  };
}

const TEMPLATE_SELECT = `
  SELECT t.*, uploader.display_name AS uploaded_by_name, publisher.display_name AS published_by_name
  FROM contract_templates t
  LEFT JOIN users uploader ON uploader.id = t.uploaded_by
  LEFT JOIN users publisher ON publisher.id = t.published_by
`;

function requireAdmin(actor) {
  assert(actor.role === ROLES.ADMIN, 403, "CONTRACT_TEMPLATE_ADMIN_FORBIDDEN", "仅系统管理员可以维护合同模板");
}

export function listContractTemplates(db, actor) {
  const rows = actor.role === ROLES.ADMIN
    ? db.prepare(`${TEMPLATE_SELECT} ORDER BY COALESCE(t.published_at, t.uploaded_at) DESC`).all()
    : db.prepare(`${TEMPLATE_SELECT} WHERE t.is_published = 1 ORDER BY t.published_at DESC`).all();
  return rows.map(templateView);
}

export async function uploadContractTemplate(db, config, actor, file, versionInput) {
  requireAdmin(actor);
  const version = cleanText(versionInput, 50);
  assert(version, 400, "CONTRACT_TEMPLATE_VERSION_REQUIRED", "模板版本号不能为空");
  const format = validateUploadedFile(file, "CONTRACT_TEMPLATE_DOCX");
  const existing = db.prepare(`SELECT 1 FROM contract_templates WHERE version = ?`).get(version);
  assert(!existing, 409, "CONTRACT_TEMPLATE_VERSION_EXISTS", "该合同模板版本已存在，历史版本不可覆盖");
  const validation = await validateContractTemplateBuffer(file.buffer);
  const stored = storeManagedBuffer(config, { directory: "contract-templates", extension: format.extension, buffer: file.buffer });
  const id = randomUUID();
  const timestamp = nowIso();
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO contract_templates (
          id, version, original_name, storage_key, mime_type, size_bytes, sha256, status,
          validation_json, fixed_fingerprint, is_published, uploaded_by, uploaded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(id, version, safeDownloadName(file.originalname, `合同模板-${version}.docx`), stored.storageKey, format.mimeType, stored.sizeBytes, stored.sha256, validation.ok ? "VALIDATED" : "REJECTED", JSON.stringify(validation), validation.fixedFingerprint, actor.id, timestamp);
      audit(db, { actorId: actor.id, action: "CONTRACT_TEMPLATE_UPLOADED", entityType: "CONTRACT_TEMPLATE", entityId: id, summary: { version, sha256: stored.sha256, status: validation.ok ? "VALIDATED" : "REJECTED", issues: validation.issues.map(item => item.code) } });
    })();
  } catch (error) {
    removeManagedFile(config, stored.storageKey);
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw new AppError(409, "CONTRACT_TEMPLATE_VERSION_EXISTS", "该合同模板版本已存在，历史版本不可覆盖");
    throw error;
  }
  return templateView(db.prepare(`${TEMPLATE_SELECT} WHERE t.id = ?`).get(id));
}

async function readAndValidateStoredTemplate(config, row) {
  const absolutePath = resolveManagedPath(config, row.storage_key);
  assert(fs.existsSync(absolutePath), 409, "CONTRACT_TEMPLATE_FILE_MISSING", "合同模板原始文件缺失，禁止发布或生成");
  const buffer = fs.readFileSync(absolutePath);
  assert(sha256(buffer) === row.sha256, 409, "CONTRACT_TEMPLATE_SHA_MISMATCH", "合同模板原始文件摘要不一致，禁止发布或生成");
  const validation = await validateContractTemplateBuffer(buffer);
  assert(validation.ok, 422, "CONTRACT_TEMPLATE_INVALID", "合同模板校验未通过", validation.issues);
  assert(validation.fixedFingerprint === row.fixed_fingerprint, 409, "CONTRACT_TEMPLATE_FINGERPRINT_MISMATCH", "合同模板固定正文指纹不一致");
  return { buffer, validation, absolutePath };
}

export async function publishContractTemplate(db, config, actor, templateId) {
  requireAdmin(actor);
  const row = db.prepare(`SELECT * FROM contract_templates WHERE id = ?`).get(templateId);
  assert(row, 404, "CONTRACT_TEMPLATE_NOT_FOUND", "合同模板不存在");
  assert(!row.is_published, 409, "CONTRACT_TEMPLATE_ALREADY_PUBLISHED", "已发布模板不可覆盖或重复发布");
  await readAndValidateStoredTemplate(config, row);
  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE contract_templates SET status = 'PUBLISHED', is_published = 1, published_by = ?, published_at = ? WHERE id = ?`).run(actor.id, timestamp, templateId);
    audit(db, { actorId: actor.id, action: "CONTRACT_TEMPLATE_PUBLISHED", entityType: "CONTRACT_TEMPLATE", entityId: templateId, summary: { version: row.version, sha256: row.sha256, fixedFingerprint: row.fixed_fingerprint } });
  })();
  return templateView(db.prepare(`${TEMPLATE_SELECT} WHERE t.id = ?`).get(templateId));
}

export async function loadPublishedTemplate(db, config, templateId) {
  const row = db.prepare(`SELECT * FROM contract_templates WHERE id = ? AND is_published = 1`).get(templateId);
  assert(row, 422, "CONTRACT_TEMPLATE_NOT_PUBLISHED", "必须选择已发布的合同模板版本");
  const loaded = await readAndValidateStoredTemplate(config, row);
  return { row, ...loaded };
}

export function getContractTemplateDownload(db, config, actor, templateId) {
  requireAdmin(actor);
  const row = db.prepare(`SELECT * FROM contract_templates WHERE id = ?`).get(templateId);
  assert(row, 404, "CONTRACT_TEMPLATE_NOT_FOUND", "合同模板不存在");
  const absolutePath = resolveManagedPath(config, row.storage_key);
  assert(fs.existsSync(absolutePath), 404, "CONTRACT_TEMPLATE_FILE_MISSING", "合同模板原始文件缺失");
  audit(db, { actorId: actor.id, action: "CONTRACT_TEMPLATE_DOWNLOADED", entityType: "CONTRACT_TEMPLATE", entityId: templateId, summary: { version: row.version } });
  return { absolutePath, downloadName: safeDownloadName(row.original_name, `合同模板-${row.version}.docx`), mimeType: row.mime_type };
}

export const __test = { attachmentTableXml, packageFingerprint, generatedFixedSegments };
