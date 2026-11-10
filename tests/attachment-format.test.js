import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { ATTACHMENT_FORMAT_LIMITS, validateAttachmentFormat } from "../server/attachment-format.js";

const TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const definitions = {
  docx: ["word/document.xml", "wordprocessingml.document", "document", "wordprocessingml"],
  xlsx: ["xl/workbook.xml", "spreadsheetml.sheet", "workbook", "spreadsheetml"],
  pptx: ["ppt/presentation.xml", "presentationml.presentation", "presentation", "presentationml"]
};

async function office(kind = "docx", mutate = () => {}, options = {}) {
  const [main, type, root, namespace] = definitions[kind];
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="${TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}" Target="${main}"/></Relationships>`);
  zip.file(main, `<x:${root} xmlns:x="http://schemas.openxmlformats.org/${namespace}/2006/main"/>`);
  await mutate(zip, { main, type, root, namespace });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", ...options });
}

function upload(buffer, extension, mimetype = "") {
  return { originalname: `虚构附件${extension}`, mimetype, buffer };
}

async function rejects(buffer, extension, code, mimetype = "") {
  await assert.rejects(() => validateAttachmentFormat(upload(buffer, extension, mimetype)), error => {
    assert.equal(error.status >= 400 && error.status < 500, true);
    if (code) assert.equal(error.code, code);
    assert.equal(error.message.includes("虚构附件"), false);
    return true;
  });
}

function centralRecords(buffer) {
  const end = buffer.length - 22;
  let offset = buffer.readUInt32LE(end + 16);
  const records = [];
  while (offset < end) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    records.push({ offset, name: buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"), local: buffer.readUInt32LE(offset + 42) });
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return records;
}

function setExpanded(buffer, name, size) {
  const record = centralRecords(buffer).find(item => item.name === name);
  buffer.writeUInt32LE(size, record.offset + 24);
  buffer.writeUInt32LE(size, record.local + 22);
}

test("通用附件接受三类非宏 Office，返回固定 MIME 且不宣称查毒", async () => {
  for (const kind of Object.keys(definitions)) {
    const buffer = await office(kind);
    const result = await validateAttachmentFormat(upload(buffer, `.${kind.toUpperCase()}`, "application/zip"));
    assert.equal(result.extension, `.${kind}`);
    assert.equal(result.mimeType.includes("openxmlformats"), true);
    assert.equal(result.sizeBytes, buffer.length);
    assert.equal(result.virusScanned, false);
    assert.deepEqual(Object.keys(result).sort(), ["extension", "mimeType", "sizeBytes", "virusScanned"]);
  }
});

test("PDF、PNG、JPEG 使用对应内容签名，不接受伪类型", async () => {
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  assert.equal(png.length, 68);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0, 0xff, 0xd9]);
  for (const [extension, buffer, mime] of [[".pdf", pdf, "application/pdf"], [".png", png, "image/png"], [".jpg", jpeg, "image/jpeg"], [".jpeg", jpeg, "image/jpeg"]]) {
    assert.equal((await validateAttachmentFormat(upload(buffer, extension, mime))).mimeType, mime);
    await rejects(Buffer.from("MZ virtual executable"), extension, "ATTACHMENT_SIGNATURE_INVALID");
    await rejects(buffer.subarray(0, buffer.length - 4), extension, "ATTACHMENT_SIGNATURE_INVALID");
  }
  await rejects(pdf, ".png", "ATTACHMENT_SIGNATURE_INVALID");
  await rejects(png, ".jpg", "ATTACHMENT_SIGNATURE_INVALID");
});

test("拒绝缺少文件、空文件、超过 20 MB、执行扩展名、MIME 冲突及非法名称", async () => {
  await assert.rejects(() => validateAttachmentFormat({}), { code: "ATTACHMENT_FILE_REQUIRED" });
  await rejects(Buffer.alloc(0), ".pdf", "ATTACHMENT_SIZE_INVALID");
  await rejects(Buffer.alloc(ATTACHMENT_FORMAT_LIMITS.fileBytes + 1), ".pdf", "ATTACHMENT_SIZE_INVALID");
  await rejects(Buffer.from("MZ virtual executable"), ".exe", "ATTACHMENT_EXTENSION_INVALID");
  await rejects(await office(), ".docx", "ATTACHMENT_MIME_INVALID", "application/pdf");
  await rejects(await office(), ".docm", "ATTACHMENT_EXTENSION_INVALID");
  await assert.rejects(() => validateAttachmentFormat({ originalname: "虚构\r\n附件.docx", buffer: Buffer.from("PK") }), { code: "ATTACHMENT_NAME_INVALID" });
  const exactLimit = Buffer.alloc(ATTACHMENT_FORMAT_LIMITS.fileBytes, 32);
  exactLimit.write("%PDF-1.7\n");
  exactLimit.write("%%EOF", exactLimit.length - 5);
  assert.equal((await validateAttachmentFormat(upload(exactLimit, ".pdf"))).sizeBytes, ATTACHMENT_FORMAT_LIMITS.fileBytes);
});

test("拒绝普通 ZIP、错 Office 类型、缺少必要部件、损坏压缩包和错误主文档根", async () => {
  const zip = new JSZip().file("virtual.txt", "virtual text");
  await rejects(await zip.generateAsync({ type: "nodebuffer" }), ".docx", "ATTACHMENT_OFFICE_STRUCTURE");
  await rejects(await office("xlsx"), ".docx", "ATTACHMENT_OFFICE_STRUCTURE");
  await rejects(await office("docx", value => value.remove("_rels/.rels")), ".docx", "ATTACHMENT_OFFICE_STRUCTURE");
  await rejects(await office("docx", (value, { main }) => value.file(main, "<document/>")), ".docx", "ATTACHMENT_OFFICE_TYPE");
  await rejects((await office()).subarray(0, 30), ".docx", "ATTACHMENT_ZIP_INVALID");
  await rejects(await office("docx", (value, { main }) => value.file(main, `<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:p></x:document>`)), ".docx", "ATTACHMENT_XML_INVALID");
});

test("拒绝宏、嵌入对象、执行部件以及被 XML 实体隐藏的宏内容类型", async () => {
  for (const name of ["word/vbaProject.bin", "word/activeX/activeX1.xml", "word/embeddings/oleObject1.bin", "word/media/virtual.exe", "customUI/customUI.xml"]) {
    await rejects(await office("docx", value => value.file(name, "virtual component")), ".docx", "ATTACHMENT_ACTIVE_CONTENT");
  }
  await rejects(await office("docx", value => value.file("[Content_Types].xml", `<Types xmlns="${TYPES_NS}"><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macro&#69;nabled.main+xml"/></Types>`)), ".docx", "ATTACHMENT_ACTIVE_CONTENT");
  await rejects(await office("docx", value => value.file("word/_rels/document.xml.rels", `<Relationships xmlns="${RELS_NS}"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="data.bin"/></Relationships>`)), ".docx", "ATTACHMENT_ACTIVE_CONTENT");
  await rejects(await office("docx", value => value.file("word/_rels/document.xml.rels", `<Relationships xmlns="${RELS_NS}"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" TargetMode="External" Target="https://example.invalid/virtual.dotm"/></Relationships>`)), ".docx", "ATTACHMENT_ACTIVE_CONTENT");
});

test("拒绝 DTD、外部实体、未知实体、伪内容类型和错误根关系", async () => {
  await rejects(await office("docx", value => value.file("[Content_Types].xml", `<!DOCTYPE Types [<!ENTITY secret SYSTEM "file:///virtual">]><Types xmlns="${TYPES_NS}"/>`)), ".docx", "ATTACHMENT_XML_INVALID");
  await rejects(await office("docx", value => value.file("[Content_Types].xml", `<Types xmlns="${TYPES_NS}"><Override PartName="/word/document.xml" ContentType="&unknown;"/></Types>`)), ".docx", "ATTACHMENT_XML_INVALID");
  await rejects(await office("docx", value => value.file("[Content_Types].xml", `<Types xmlns="${TYPES_NS}"><Override PartName="/word/document.xml" ContentType="application/zip"/></Types>`)), ".docx", "ATTACHMENT_OFFICE_TYPE");
  await rejects(await office("docx", value => value.file("_rels/.rels", `<Relationships xmlns="${RELS_NS}"><Relationship Id="r" Type="${OFFICE_REL}" Target="xl/workbook.xml"/></Relationships>`)), ".docx", "ATTACHMENT_OFFICE_TYPE");
});

test("条目数、单项/总展开大小及结构 XML 预算在读取条目前拒绝", async () => {
  const excessive = await office("docx", value => {
    for (let index = 0; index < ATTACHMENT_FORMAT_LIMITS.zipEntries; index++) value.file(`parts/item${index}.xml`, "");
  });
  await rejects(excessive, ".docx", "ATTACHMENT_ZIP_BUDGET");
  const single = await office();
  setExpanded(single, "word/document.xml", ATTACHMENT_FORMAT_LIMITS.zipEntryBytes + 1);
  await rejects(single, ".docx", "ATTACHMENT_ZIP_BUDGET");
  const total = await office("docx", value => { for (let index = 0; index < 3; index++) value.file(`word/media/item${index}.png`, "virtual"); });
  for (let index = 0; index < 3; index++) setExpanded(total, `word/media/item${index}.png`, ATTACHMENT_FORMAT_LIMITS.zipEntryBytes);
  await rejects(total, ".docx", "ATTACHMENT_ZIP_BUDGET");
  const structure = await office();
  setExpanded(structure, "word/document.xml", ATTACHMENT_FORMAT_LIMITS.structureBytes + 1);
  await rejects(structure, ".docx", "ATTACHMENT_ZIP_BUDGET");
});

test("伪造较小 ZIP 展开长度也不能让必要 XML 无限制展开", async () => {
  const buffer = await office("docx", value => value.file("word/document.xml", "x".repeat(ATTACHMENT_FORMAT_LIMITS.structureBytes + 1)));
  setExpanded(buffer, "word/document.xml", 32);
  await rejects(buffer, ".docx");
});

test("非结构部件的 65 MiB 压缩炸弹即使伪造中央与本地长度也会中止", async () => {
  const buffer = await office("docx", value => {
    const chunk = Buffer.alloc(64 * 1024, 65);
    value.file("word/media/virtual.bin", Readable.from((function* () {
      for (let index = 0; index < 65 * 16; index++) yield chunk;
    })()));
  });
  assert.ok(buffer.length < 100 * 1024);
  setExpanded(buffer, "word/media/virtual.bin", 1024);
  await rejects(buffer, ".docx", "ATTACHMENT_ZIP_BUDGET");
});

test("所有非结构条目都校验实际内容 CRC，正常媒体内容不聚合为结构 XML", async () => {
  const normal = await office("docx", value => value.file("word/media/virtual.bin", Buffer.alloc(2 * 1024 * 1024, 65)));
  assert.equal((await validateAttachmentFormat(upload(normal, ".docx"))).extension, ".docx");
  const record = centralRecords(normal).find(item => item.name === "word/media/virtual.bin");
  const forgedCrc = (normal.readUInt32LE(record.offset + 16) ^ 1) >>> 0;
  normal.writeUInt32LE(forgedCrc, record.offset + 16);
  normal.writeUInt32LE(forgedCrc, record.local + 14);
  await rejects(normal, ".docx", "ATTACHMENT_ZIP_INVALID");
});

test("拒绝目录穿越、大小写重名、加密标志及本地/中央目录不一致", async () => {
  await rejects(await office("docx", value => value.file("../virtual.txt", "virtual")), ".docx", "ATTACHMENT_ZIP_INVALID");
  await rejects(await office("docx", value => value.file("WORD/document.xml", "virtual")), ".docx", "ATTACHMENT_ZIP_INVALID");
  const encrypted = await office();
  const entry = centralRecords(encrypted)[0];
  encrypted.writeUInt16LE(encrypted.readUInt16LE(entry.offset + 8) | 1, entry.offset + 8);
  await rejects(encrypted, ".docx", "ATTACHMENT_ZIP_INVALID");
  const mismatch = await office();
  mismatch[centralRecords(mismatch)[0].local + 30] = 120;
  await rejects(mismatch, ".docx", "ATTACHMENT_ZIP_INVALID");
});

test("兼容带数据描述符的正常 ZIP、XML 注释和安全外部超链接", async () => {
  const buffer = await office("docx", value => {
    value.file("word/_rels/document.xml.rels", `<Relationships xmlns="${RELS_NS}"><!-- virtual --><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="https://example.invalid/?a=1&amp;b=2"/></Relationships>`);
  }, { streamFiles: true });
  assert.equal((await validateAttachmentFormat(upload(buffer, ".docx"))).extension, ".docx");
});
