import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { sha256 } from "../server/security.js";
import { CONTRACT_ATTACHMENT_MARKER, CONTRACT_TEMPLATE_MARKER_COUNTS, CONTRACT_TEMPLATE_MARKER_RULES, CONTRACT_TEMPLATE_MARKERS, PRODUCTION_CONTRACT_SLOT_PATHS } from "../server/contract-template-service.js";
import {
  PRODUCTION_CONTRACT_MARKERS,
  PRODUCTION_CONTRACT_PROFILE,
  adaptProductionContractTemplateBuffer,
  proveProductionTemplateDiff,
  runProductionContractAdapterCli
} from "../scripts/adapt-production-contract-template.js";

const NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const VALUE_MARKER = "{{CONTRACT_NUMBER}}";
const ATTACHMENT_MARKER = "{{ATTACHMENT_PRICE_TABLE}}";

test("生产适配标记与项目模板门禁白名单保持一致", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(PRODUCTION_CONTRACT_MARKERS).filter(([key]) => key !== "attachmentPriceTable")),
    CONTRACT_TEMPLATE_MARKERS
  );
  assert.equal(PRODUCTION_CONTRACT_MARKERS.attachmentPriceTable, CONTRACT_ATTACHMENT_MARKER);
  assert.equal(CONTRACT_TEMPLATE_MARKER_COUNTS.partyAName, 2);
  assert.deepEqual(CONTRACT_TEMPLATE_MARKER_RULES.partyAName.locations, ["P3/T7", "TBL1/R0/C0/P0/T2"]);
  assert.ok(Object.entries(CONTRACT_TEMPLATE_MARKER_COUNTS).every(([key, count]) => key === "partyAName" ? count === 2 : count === 1));
  assert.ok(Object.values(CONTRACT_TEMPLATE_MARKER_RULES).every(rule => rule.locations.length === rule.count && rule.count > 0));
  const markerKeys = new Map(Object.entries(PRODUCTION_CONTRACT_MARKERS).map(([key, marker]) => [marker, key]));
  const adaptedPaths = PRODUCTION_CONTRACT_PROFILE.paragraphs.flatMap(target => Object.entries(target.replacements)
    .filter(([, replacement]) => markerKeys.has(replacement))
    .map(([textNodeIndex, replacement]) => ({ key: markerKeys.get(replacement), paragraphIndex: target.index, textNodeIndex: Number(textNodeIndex) })));
  adaptedPaths.push({ key: "attachmentPriceTable", paragraphIndex: PRODUCTION_CONTRACT_PROFILE.attachment.titleParagraphIndex + 1, textNodeIndex: 0 });
  assert.deepEqual(
    adaptedPaths.sort((left, right) => left.paragraphIndex - right.paragraphIndex || left.textNodeIndex - right.textNodeIndex),
    PRODUCTION_CONTRACT_SLOT_PATHS.map(({ key, paragraphIndex, textNodeIndex }) => ({ key, paragraphIndex, textNodeIndex }))
      .sort((left, right) => left.paragraphIndex - right.paragraphIndex || left.textNodeIndex - right.textNodeIndex)
  );
});

function paragraph(textNodes) {
  return `<w:p>${textNodes.map(text => `<w:r><w:t>${text}</w:t></w:r>`).join("")}</w:p>`;
}

function table(rows) {
  return `<w:tbl>${rows.map(row => `<w:tr>${row.map(value => `<w:tc>${paragraph([value])}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
}

function documentXml({ value = "SAMPLE", duplicateTitle = false, title = "附件一：价格明细", revision = false } = {}) {
  const main = table([["固定主表"]]);
  const attachment = table([["虚构附件值"]]);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${NS}"><w:body>${revision ? '<w:ins w:id="1"><w:r><w:t>虚构修订</w:t></w:r></w:ins>' : ""}${paragraph(["合同编号：", value])}${main}${paragraph([title])}${attachment}${duplicateTitle ? paragraph(["附件一：价格明细"]) : ""}<w:sectPr/></w:body></w:document>`;
}

async function bufferFromXml(xml, extraParts = {}) {
  const zip = new JSZip();
  zip.file("word/document.xml", xml);
  for (const [name, value] of Object.entries(extraParts)) zip.file(name, value);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function blocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "g"))].map(match => match[0]);
}

function rowCellCounts(tableXml) {
  return blocks(tableXml, "w:tr").map(row => (row.match(/<w:tc(?:\s|>)/g) || []).length);
}

async function inventory(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter(entry => !entry.dir).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return Promise.all(entries.map(async entry => {
    const part = await entry.async("nodebuffer");
    return { name: entry.name, size: part.length, sha256: sha256(part) };
  }));
}

async function profileFor(buffer, { keepTargetHash, keepMainHash, title = "附件一：价格明细" } = {}) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml").async("string");
  const paragraphs = blocks(xml, "w:p");
  const tables = blocks(xml, "w:tbl");
  return {
    sourceSha256: sha256(buffer),
    sourceSize: buffer.length,
    sourceParts: await inventory(buffer),
    documentXmlSha256: sha256(xml),
    markerCounts: { [VALUE_MARKER]: 1, [ATTACHMENT_MARKER]: 1 },
    paragraphs: [{ index: 0, rawSha256: keepTargetHash || sha256(paragraphs[0]), replacements: { 1: VALUE_MARKER } }],
    mainTable: { index: 0, rawSha256: keepMainHash || sha256(tables[0]), rowCellCounts: rowCellCounts(tables[0]) },
    attachment: {
      title,
      titleParagraphIndex: 2,
      titleParagraphRawSha256: sha256(paragraphs[2]),
      tableIndex: 1,
      tableRawSha256: sha256(tables[1]),
      rowCellCounts: rowCellCounts(tables[1]),
      marker: ATTACHMENT_MARKER
    }
  };
}

async function mutatePart(buffer, name, mutate) {
  const zip = await JSZip.loadAsync(buffer);
  const before = await zip.file(name).async("string");
  zip.file(name, mutate(before));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("生产合同离线适配只改变受控文本和附件整表，重复适配默认拒绝", async () => {
  const source = await bufferFromXml(documentXml());
  const profile = await profileFor(source);
  const adapted = await adaptProductionContractTemplateBuffer(source, { profile });
  const repeatedFreshRun = await adaptProductionContractTemplateBuffer(source, { profile });
  assert.equal(adapted.proof.ok, true);
  assert.equal(sha256(repeatedFreshRun.buffer), sha256(adapted.buffer));
  assert.equal(adapted.proof.unchangedPartCount, 0);
  assert.equal(adapted.proof.revisionCount, 0);
  assert.equal(adapted.proof.commentCount, 0);
  const zip = await JSZip.loadAsync(adapted.buffer);
  const xml = await zip.file("word/document.xml").async("string");
  assert.equal((xml.match(/\{\{CONTRACT_NUMBER\}\}/g) || []).length, 1);
  assert.equal((xml.match(/\{\{ATTACHMENT_PRICE_TABLE\}\}/g) || []).length, 1);
  assert.doesNotMatch(xml, /虚构附件值/);
  await assert.rejects(() => adaptProductionContractTemplateBuffer(adapted.buffer, { profile }), error => error.code === "PRODUCTION_TEMPLATE_ALREADY_ADAPTED");
});

test("适配器拒绝错误摘要、位置变化、主表变化和附件标题歧义或缺失", async () => {
  const source = await bufferFromXml(documentXml());
  const profile = await profileFor(source);
  const wrongValue = await bufferFromXml(documentXml({ value: "CHANGED" }));
  await assert.rejects(() => adaptProductionContractTemplateBuffer(wrongValue, { profile }), error => error.code === "PRODUCTION_TEMPLATE_SOURCE_SHA256_MISMATCH");

  const originalParagraphHash = profile.paragraphs[0].rawSha256;
  const changedProfile = await profileFor(wrongValue, { keepTargetHash: originalParagraphHash });
  await assert.rejects(() => adaptProductionContractTemplateBuffer(wrongValue, { profile: changedProfile }), error => error.code === "PRODUCTION_TEMPLATE_TARGET_CONTEXT_CHANGED");

  const changedMainXml = documentXml().replace("固定主表", "变化主表");
  const changedMain = await bufferFromXml(changedMainXml);
  const changedMainProfile = await profileFor(changedMain, { keepMainHash: profile.mainTable.rawSha256 });
  await assert.rejects(() => adaptProductionContractTemplateBuffer(changedMain, { profile: changedMainProfile }), error => error.code === "PRODUCTION_TEMPLATE_MAIN_TABLE_CHANGED");

  const ambiguous = await bufferFromXml(documentXml({ duplicateTitle: true }));
  const ambiguousProfile = await profileFor(ambiguous);
  await assert.rejects(() => adaptProductionContractTemplateBuffer(ambiguous, { profile: ambiguousProfile }), error => error.code === "PRODUCTION_TEMPLATE_ATTACHMENT_TITLE_AMBIGUOUS");

  const missing = await bufferFromXml(documentXml({ title: "附件区域缺失" }));
  const missingProfile = await profileFor(missing, { title: "附件一：价格明细" });
  await assert.rejects(() => adaptProductionContractTemplateBuffer(missing, { profile: missingProfile }), error => error.code === "PRODUCTION_TEMPLATE_ATTACHMENT_TITLE_AMBIGUOUS");
});

test("适配器在摘要检查前明确拒绝修订、批注和已含标记", async () => {
  const source = await bufferFromXml(documentXml());
  const profile = await profileFor(source);
  const revision = await bufferFromXml(documentXml({ revision: true }));
  await assert.rejects(() => adaptProductionContractTemplateBuffer(revision, { profile }), error => error.code === "PRODUCTION_TEMPLATE_REVISIONS_PENDING");

  const comments = await bufferFromXml(documentXml(), {
    "word/comments.xml": `<?xml version="1.0"?><w:comments xmlns:w="${NS}"><w:comment w:id="1"><w:p><w:r><w:t>虚构批注</w:t></w:r></w:p></w:comment></w:comments>`
  });
  await assert.rejects(() => adaptProductionContractTemplateBuffer(comments, { profile }), error => error.code === "PRODUCTION_TEMPLATE_COMMENTS_PRESENT");

  const marked = await bufferFromXml(documentXml({ value: VALUE_MARKER }));
  await assert.rejects(() => adaptProductionContractTemplateBuffer(marked, { profile }), error => error.code === "PRODUCTION_TEMPLATE_ALREADY_ADAPTED");
});

test("OOXML 差异证明拒绝生成后固定正文或其他部件变化", async () => {
  const source = await bufferFromXml(documentXml(), { "word/styles.xml": "<styles>fixed</styles>" });
  const profile = await profileFor(source);
  const adapted = await adaptProductionContractTemplateBuffer(source, { profile });
  const fixedTamper = await mutatePart(adapted.buffer, "word/document.xml", xml => xml.replace("合同编号：", "被改正文："));
  await assert.rejects(() => proveProductionTemplateDiff(source, fixedTamper, { profile }), error => error.code === "PRODUCTION_TEMPLATE_FIXED_DOCUMENT_CHANGED");
  const partTamper = await mutatePart(adapted.buffer, "word/styles.xml", xml => `${xml}<!--changed-->`);
  await assert.rejects(() => proveProductionTemplateDiff(source, partTamper, { profile }), error => error.code === "PRODUCTION_TEMPLATE_FIXED_PART_CHANGED");
});

test("CLI 必须显式指定不同输出路径且拒绝覆盖原件", async () => {
  await assert.rejects(() => runProductionContractAdapterCli([]), error => error.code === "PRODUCTION_TEMPLATE_ARGUMENT_REQUIRED");
  await assert.rejects(() => runProductionContractAdapterCli(["--input", "in.docx", "--output", "out.docx"]), error => error.code === "PRODUCTION_TEMPLATE_ARGUMENT_REQUIRED");
  await assert.rejects(() => runProductionContractAdapterCli(["--input", "same.docx", "--output", "same.docx", "--proof", "proof.json"]), error => error.code === "PRODUCTION_TEMPLATE_OUTPUT_OVERWRITE_FORBIDDEN");
  await assert.rejects(() => runProductionContractAdapterCli(["--input", "source.docx", "--output", "adapted.docx", "--proof", "adapted.docx"]), error => error.code === "PRODUCTION_TEMPLATE_PROOF_PATH_INVALID");
});
