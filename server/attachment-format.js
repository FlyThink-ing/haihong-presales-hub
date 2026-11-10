import path from "node:path";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import JSZip from "jszip";
import { AppError, assert } from "./domain.js";

export const ATTACHMENT_FORMAT_LIMITS = Object.freeze({
  fileBytes: 20 * 1024 * 1024,
  zipEntries: 2048,
  zipEntryBytes: 32 * 1024 * 1024,
  zipExpandedBytes: 64 * 1024 * 1024,
  structureBytes: 4 * 1024 * 1024,
  structureTotalBytes: 16 * 1024 * 1024
});

const OFFICE = {
  ".docx": { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", main: "word/document.xml", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", root: "document", namespace: "wordprocessingml/2006/main", strictNamespace: "wordprocessingml/main" },
  ".xlsx": { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", main: "xl/workbook.xml", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", root: "workbook", namespace: "spreadsheetml/2006/main", strictNamespace: "spreadsheetml/main" },
  ".pptx": { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", main: "ppt/presentation.xml", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", root: "presentation", namespace: "presentationml/2006/main", strictNamespace: "presentationml/main" }
};
const FORMATS = { ...OFFICE, ".pdf": { mimeType: "application/pdf" }, ".png": { mimeType: "image/png" }, ".jpg": { mimeType: "image/jpeg" }, ".jpeg": { mimeType: "image/jpeg" } };
const EXECUTABLE_NAME = /(?:^|\/)(?:vba[^/]*|activex|embeddings|customui)(?:\/|\.|$)|\.(?:exe|dll|com|scr|msi|msp|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|jar|class|lnk|chm|ocx|cpl|reg|app|sh|html?|mht|swf)$/i;
const ACTIVE_TYPE = /macroenabled|vbaproject|vba\.data|activex|oleobject|javascript|x-msdownload|x-shockwave-flash|text\/html/i;
const TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = /^(?:http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships|http:\/\/purl\.oclc\.org\/ooxml\/officeDocument\/relationships)\/officeDocument$/;

function reject(code = "ATTACHMENT_FORMAT_INVALID", message = "文件内容与所选格式不匹配") {
  throw new AppError(415, code, message);
}

function check(condition, code, message) {
  if (!condition) reject(code, message);
}

function safePartName(name) {
  check(name && !/[\\\u0000-\u001f:]/.test(name) && !name.startsWith("/") && !name.split("/").some(part => part === ".." || part === "."), "ATTACHMENT_ZIP_INVALID", "Office 文件包含无效归档路径");
  check(!EXECUTABLE_NAME.test(name), "ATTACHMENT_ACTIVE_CONTENT", "不接受包含宏、嵌入对象或执行部件的 Office 文件");
}

function readExtra(buffer, start, length, name) {
  const end = start + length;
  for (let offset = start; offset < end;) {
    check(offset + 4 <= end, "ATTACHMENT_ZIP_INVALID");
    const kind = buffer.readUInt16LE(offset);
    const size = buffer.readUInt16LE(offset + 2);
    offset += 4;
    check(offset + size <= end && kind !== 0x0001, "ATTACHMENT_ZIP_INVALID");
    // Unicode aliases must not make the extractor see a different part name.
    if (kind === 0x7075) check(size >= 5 && buffer.subarray(offset + 5, offset + size).toString("utf8") === name, "ATTACHMENT_ZIP_INVALID");
    offset += size;
  }
}

function inspectZip(buffer) {
  check(buffer.length >= 22 && buffer.readUInt32LE(0) === 0x04034b50, "ATTACHMENT_SIGNATURE_INVALID");
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) { end = offset; break; }
  }
  check(end >= 0, "ATTACHMENT_ZIP_INVALID");
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralStart = buffer.readUInt32LE(end + 16);
  check(buffer.readUInt16LE(end + 4) === 0 && buffer.readUInt16LE(end + 6) === 0 && buffer.readUInt16LE(end + 8) === count && centralStart + centralSize === end, "ATTACHMENT_ZIP_INVALID");
  check(count > 0 && count <= ATTACHMENT_FORMAT_LIMITS.zipEntries, "ATTACHMENT_ZIP_BUDGET", "Office 文件归档条目超出限制");
  const entries = new Map();
  const seenNames = new Set();
  const ranges = [];
  let expandedBytes = 0;
  let offset = centralStart;
  for (let index = 0; index < count; index++) {
    check(offset + 46 <= end && buffer.readUInt32LE(offset) === 0x02014b50, "ATTACHMENT_ZIP_INVALID");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const expanded = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    check(offset + 46 + nameLength + extraLength + commentLength <= end && nameLength > 0, "ATTACHMENT_ZIP_INVALID");
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString("utf8");
    check(!name.includes("\ufffd") && !seenNames.has(name.toLowerCase()), "ATTACHMENT_ZIP_INVALID");
    safePartName(name);
    seenNames.add(name.toLowerCase());
    check((flags & (1 | 64 | 8192)) === 0 && [0, 8].includes(method) && buffer.readUInt16LE(offset + 34) === 0, "ATTACHMENT_ZIP_INVALID", "不接受加密或不支持的 Office 压缩格式");
    check(((buffer.readUInt32LE(offset + 38) >>> 16) & 0xf000) !== 0xa000, "ATTACHMENT_ZIP_INVALID");
    expandedBytes += expanded;
    check(expanded <= ATTACHMENT_FORMAT_LIMITS.zipEntryBytes && expandedBytes <= ATTACHMENT_FORMAT_LIMITS.zipExpandedBytes, "ATTACHMENT_ZIP_BUDGET", "Office 文件展开大小超出限制");
    check(method !== 0 || compressed === expanded, "ATTACHMENT_ZIP_INVALID");
    check(local + 30 <= centralStart && buffer.readUInt32LE(local) === 0x04034b50, "ATTACHMENT_ZIP_INVALID");
    const localNameLength = buffer.readUInt16LE(local + 26);
    const localExtraLength = buffer.readUInt16LE(local + 28);
    const payload = local + 30 + localNameLength + localExtraLength;
    check(payload + compressed <= centralStart && buffer.readUInt16LE(local + 6) === flags && buffer.readUInt16LE(local + 8) === method && nameBytes.equals(buffer.subarray(local + 30, local + 30 + localNameLength)), "ATTACHMENT_ZIP_INVALID");
    if (!(flags & 8)) {
      check(buffer.readUInt32LE(local + 14) === buffer.readUInt32LE(offset + 16) && buffer.readUInt32LE(local + 18) === compressed && buffer.readUInt32LE(local + 22) === expanded, "ATTACHMENT_ZIP_INVALID");
    }
    readExtra(buffer, local + 30 + localNameLength, localExtraLength, name);
    readExtra(buffer, offset + 46 + nameLength, extraLength, name);
    ranges.push([local, payload + compressed]);
    entries.set(name, { expanded, compressed, payload, method, crc: buffer.readUInt32LE(offset + 16), directory: name.endsWith("/") });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  check(offset === end, "ATTACHMENT_ZIP_INVALID");
  ranges.sort((a, b) => a[0] - b[0]);
  check(ranges[0][0] === 0 && ranges.every((range, index) => index === 0 || range[0] >= ranges[index - 1][1]), "ATTACHMENT_ZIP_INVALID");
  return entries;
}

function decodeXml(value) {
  return value.replace(/&([^;]*);|&/g, (match, entity) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    check(/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity || ""), "ATTACHMENT_XML_INVALID");
    const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    check(Number.isSafeInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff), "ATTACHMENT_XML_INVALID");
    return String.fromCodePoint(point);
  });
}

// A bounded XML reader for package manifests and root identity, never an entity resolver.
function inspectXml(buffer, onElement = () => {}) {
  let xml;
  try { xml = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { reject("ATTACHMENT_XML_INVALID"); }
  check(!/<!DOCTYPE|<!ENTITY/i.test(xml) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml), "ATTACHMENT_XML_INVALID");
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^<>"']|"[^"]*"|'[^']*')+>/g;
  const stack = [];
  let root = null;
  let last = 0;
  let elements = 0;
  for (const token of xml.matchAll(tokens)) {
    const text = xml.slice(last, token.index);
    check(!text.includes("<") && (stack.length > 0 || !text.trim()), "ATTACHMENT_XML_INVALID");
    decodeXml(text);
    last = token.index + token[0].length;
    const tag = token[0];
    if (tag.startsWith("<!--")) { check(!tag.slice(4, -3).includes("--"), "ATTACHMENT_XML_INVALID"); continue; }
    if (tag.startsWith("<?")) { check(/^<\?xml\s[^?]*\?>$/i.test(tag) && !root, "ATTACHMENT_XML_INVALID"); continue; }
    if (tag.startsWith("<![CDATA[")) { check(stack.length > 0, "ATTACHMENT_XML_INVALID"); continue; }
    if (tag.startsWith("</")) {
      const name = tag.slice(2, -1).trim();
      check(stack.length > 0 && stack.pop().name === name, "ATTACHMENT_XML_INVALID");
      continue;
    }
    const match = /^<([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>$/.exec(tag);
    check(match && ++elements <= 100000 && stack.length < 256, "ATTACHMENT_XML_INVALID");
    const attrs = Object.create(null);
    let rest = match[2];
    while (rest.trim()) {
      const attr = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
      check(attr && !Object.hasOwn(attrs, attr[1]), "ATTACHMENT_XML_INVALID");
      attrs[attr[1]] = decodeXml(attr[2] ?? attr[3]);
      rest = rest.slice(attr[0].length);
    }
    const namespaces = { ...(stack.at(-1)?.namespaces || {}) };
    for (const [name, value] of Object.entries(attrs)) {
      if (name === "xmlns") namespaces[""] = value;
      else if (name.startsWith("xmlns:")) namespaces[name.slice(6)] = value;
    }
    const names = match[1].split(":");
    check(names.length <= 2, "ATTACHMENT_XML_INVALID");
    const element = { name: match[1], localName: names.at(-1), namespace: namespaces[names.length === 2 ? names[0] : ""] || "", attrs, namespaces, depth: stack.length };
    if (!stack.length) { check(!root, "ATTACHMENT_XML_INVALID"); root = element; }
    onElement(element);
    if (!match[3]) stack.push(element);
  }
  check(root && !stack.length && !xml.slice(last).trim(), "ATTACHMENT_XML_INVALID");
  return root;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function readEntry(buffer, declared, budget, structure) {
  // Native streams propagate backpressure and destruction to the inflater. The
  // legacy JSZip nodeStream adapter cannot cancel its decompression worker.
  const source = Readable.from((function* () {
    const end = declared.payload + declared.compressed;
    for (let offset = declared.payload; offset < end; offset += 16384) yield buffer.subarray(offset, Math.min(offset + 16384, end));
  })(), { objectMode: false, highWaterMark: 16384 });
  const stream = declared.method === 8 ? createInflateRaw({ chunkSize: 16384 }) : source;
  return new Promise((resolve, rejectPromise) => {
    const chunks = structure ? [] : null;
    let size = 0;
    let crc = 0xffffffff;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      source.unpipe();
      source.destroy();
      stream.destroy();
      if (chunks) chunks.length = 0;
      rejectPromise(error);
    };
    source.on("error", fail);
    if (stream !== source) stream.on("error", fail);
    stream.on("data", chunk => {
      if (settled) return;
      try {
        size += chunk.length;
        budget.expanded += chunk.length;
        check(size <= ATTACHMENT_FORMAT_LIMITS.zipEntryBytes && budget.expanded <= ATTACHMENT_FORMAT_LIMITS.zipExpandedBytes && size <= declared.expanded, "ATTACHMENT_ZIP_BUDGET", "Office 文件实际展开大小超出限制");
        if (structure) {
          budget.structure += chunk.length;
          check(size <= ATTACHMENT_FORMAT_LIMITS.structureBytes && budget.structure <= ATTACHMENT_FORMAT_LIMITS.structureTotalBytes, "ATTACHMENT_ZIP_BUDGET", "Office 结构文件实际展开大小超出限制");
          chunks.push(chunk);
        }
        for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
      } catch (error) { fail(error); }
    });
    stream.on("end", () => {
      if (settled) return;
      try {
        check(size === declared.expanded && ((crc ^ 0xffffffff) >>> 0) === declared.crc, "ATTACHMENT_ZIP_INVALID", "Office 文件归档校验失败");
        settled = true;
        resolve(structure ? Buffer.concat(chunks, size) : null);
      } catch (error) { fail(error); }
    });
    if (stream !== source) source.pipe(stream);
  });
}

async function validateOffice(buffer, format) {
  const entries = inspectZip(buffer);
  const structures = ["[Content_Types].xml", ...[...entries.keys()].filter(name => name.endsWith(".rels")), format.main];
  check(entries.has("_rels/.rels") && new Set(structures).size === structures.length, "ATTACHMENT_OFFICE_STRUCTURE");
  let structureBytes = 0;
  for (const name of structures) {
    const entry = entries.get(name);
    check(entry && !entry.directory, "ATTACHMENT_OFFICE_STRUCTURE");
    structureBytes += entry.expanded;
    check(entry.expanded <= ATTACHMENT_FORMAT_LIMITS.structureBytes && structureBytes <= ATTACHMENT_FORMAT_LIMITS.structureTotalBytes, "ATTACHMENT_ZIP_BUDGET");
  }
  const zip = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: false });
  check(Object.keys(zip.files).length === entries.size && Object.keys(zip.files).every(name => entries.has(name)), "ATTACHMENT_ZIP_INVALID");
  const budget = { expanded: 0, structure: 0 };
  const structureContents = new Map();
  const structureNames = new Set(structures);
  for (const [name, entry] of entries) {
    if (entry.directory) { check(entry.expanded === 0 && entry.compressed === 0, "ATTACHMENT_ZIP_INVALID"); continue; }
    const file = zip.file(name);
    check(file && (!file.unsafeOriginalName || file.unsafeOriginalName === name), "ATTACHMENT_ZIP_INVALID");
    const content = await readEntry(buffer, entry, budget, structureNames.has(name));
    if (content) structureContents.set(name, content);
  }
  let mainTypeCount = 0;
  const typesRoot = inspectXml(structureContents.get("[Content_Types].xml"), element => {
    check(element.namespace === TYPES_NS, "ATTACHMENT_OFFICE_STRUCTURE");
    if (!element.depth) return;
    check(element.depth === 1 && ["Default", "Override"].includes(element.localName), "ATTACHMENT_OFFICE_STRUCTURE");
    check(element.attrs.ContentType && !ACTIVE_TYPE.test(element.attrs.ContentType), "ATTACHMENT_ACTIVE_CONTENT");
    if (element.localName === "Override") {
      check(element.attrs.PartName?.startsWith("/"), "ATTACHMENT_OFFICE_STRUCTURE");
      safePartName(element.attrs.PartName.slice(1));
      if (element.attrs.PartName === `/${format.main}`) {
        check(element.attrs.ContentType === format.contentType, "ATTACHMENT_OFFICE_TYPE");
        mainTypeCount++;
      }
    }
  });
  check(typesRoot.localName === "Types" && typesRoot.namespace === TYPES_NS && mainTypeCount === 1, "ATTACHMENT_OFFICE_TYPE");
  let officeRelationships = 0;
  for (const name of structures.filter(item => item.endsWith(".rels"))) {
    const root = inspectXml(structureContents.get(name), element => {
      check(element.namespace === RELS_NS, "ATTACHMENT_OFFICE_STRUCTURE");
      if (!element.depth) return;
      check(element.depth === 1 && element.localName === "Relationship" && element.attrs.Type && element.attrs.Target, "ATTACHMENT_OFFICE_STRUCTURE");
      check(!/(?:\/)(?:vbaProject|vbaData|control|oleObject|package|attachedTemplate|aFChunk)$/i.test(element.attrs.Type), "ATTACHMENT_ACTIVE_CONTENT");
      if (element.attrs.TargetMode === "External") check(/\/hyperlink$/.test(element.attrs.Type) && /^(?:https?:|mailto:)/i.test(element.attrs.Target), "ATTACHMENT_ACTIVE_CONTENT");
      else check(!EXECUTABLE_NAME.test(element.attrs.Target), "ATTACHMENT_ACTIVE_CONTENT");
      if (name === "_rels/.rels" && OFFICE_REL.test(element.attrs.Type)) {
        check(!element.attrs.TargetMode && element.attrs.Target.replace(/^\//, "") === format.main, "ATTACHMENT_OFFICE_TYPE");
        officeRelationships++;
      }
    });
    check(root.localName === "Relationships" && root.namespace === RELS_NS, "ATTACHMENT_OFFICE_STRUCTURE");
  }
  check(officeRelationships === 1, "ATTACHMENT_OFFICE_STRUCTURE");
  const mainRoot = inspectXml(structureContents.get(format.main));
  check(mainRoot.localName === format.root && [`http://schemas.openxmlformats.org/${format.namespace}`, `http://purl.oclc.org/ooxml/${format.strictNamespace}`].includes(mainRoot.namespace), "ATTACHMENT_OFFICE_TYPE");
}

function validateRaster(buffer, extension) {
  if (extension === ".png") {
    check(buffer.length >= 45 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "ATTACHMENT_SIGNATURE_INVALID");
    let offset = 8;
    let sawData = false;
    while (offset + 12 <= buffer.length) {
      const size = buffer.readUInt32BE(offset);
      const kind = buffer.subarray(offset + 4, offset + 8).toString("ascii");
      check(offset + 12 + size <= buffer.length && /^[A-Za-z]{4}$/.test(kind), "ATTACHMENT_SIGNATURE_INVALID");
      if (offset === 8) check(kind === "IHDR" && size === 13 && buffer.readUInt32BE(offset + 8) > 0 && buffer.readUInt32BE(offset + 12) > 0, "ATTACHMENT_SIGNATURE_INVALID");
      else check(kind !== "IHDR", "ATTACHMENT_SIGNATURE_INVALID");
      if (kind === "IDAT") sawData = true;
      offset += 12 + size;
      if (kind === "IEND") { check(size === 0 && sawData && offset === buffer.length, "ATTACHMENT_SIGNATURE_INVALID"); return; }
    }
    reject("ATTACHMENT_SIGNATURE_INVALID");
  }
  check(buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9, "ATTACHMENT_SIGNATURE_INVALID");
  let offset = 2;
  let sawFrame = false;
  while (offset + 4 <= buffer.length) {
    check(buffer[offset++] === 0xff, "ATTACHMENT_SIGNATURE_INVALID");
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    check(marker !== 0 && marker !== 0xd8 && marker !== 0xd9 && !(marker >= 0xd0 && marker <= 0xd7), "ATTACHMENT_SIGNATURE_INVALID");
    const size = buffer.readUInt16BE(offset);
    check(size >= 2 && offset + size <= buffer.length - 2, "ATTACHMENT_SIGNATURE_INVALID");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      check(size >= 8 && buffer.readUInt16BE(offset + 3) > 0 && buffer.readUInt16BE(offset + 5) > 0, "ATTACHMENT_SIGNATURE_INVALID");
      sawFrame = true;
    }
    if (marker === 0xda) { check(sawFrame && size >= 6 && offset + size < buffer.length - 2, "ATTACHMENT_SIGNATURE_INVALID"); return; }
    offset += size;
  }
  reject("ATTACHMENT_SIGNATURE_INVALID");
}

// This checks format and bounded package structure, not malware or document business validity.
export async function validateAttachmentFormat(file) {
  assert(file && Buffer.isBuffer(file.buffer), 400, "ATTACHMENT_FILE_REQUIRED", "请选择一个附件");
  assert(file.buffer.length > 0 && file.buffer.length <= ATTACHMENT_FORMAT_LIMITS.fileBytes, 413, "ATTACHMENT_SIZE_INVALID", "附件大小必须在 1 字节至 20 MB 之间");
  const filename = String(file.originalname || "");
  check(filename && !/[\u0000-\u001f]/.test(filename), "ATTACHMENT_NAME_INVALID");
  const extension = path.extname(filename).toLowerCase();
  const format = FORMATS[extension];
  check(format, "ATTACHMENT_EXTENSION_INVALID", "只允许 PDF、DOCX、XLSX、PPTX、PNG 和 JPEG 附件");
  const acceptedMimes = [format.mimeType, "application/octet-stream", ""];
  if (OFFICE[extension]) acceptedMimes.push("application/zip");
  check(acceptedMimes.includes(String(file.mimetype || "").toLowerCase()), "ATTACHMENT_MIME_INVALID", "附件 MIME 类型与扩展名不匹配");
  try {
    if (OFFICE[extension]) await validateOffice(file.buffer, format);
    else if (extension === ".pdf") {
      check(/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)/.test(file.buffer.subarray(0, 16).toString("ascii")) && /%%EOF[\t\r\n ]*$/.test(file.buffer.subarray(-1024).toString("ascii")), "ATTACHMENT_SIGNATURE_INVALID");
    } else validateRaster(file.buffer, extension);
  } catch (error) {
    if (error instanceof AppError) throw error;
    reject("ATTACHMENT_FORMAT_INVALID", "附件结构无效或已损坏");
  }
  return { extension, mimeType: format.mimeType, sizeBytes: file.buffer.length, virusScanned: false };
}
