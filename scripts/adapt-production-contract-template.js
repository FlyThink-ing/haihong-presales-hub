import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { validateContractTemplateBuffer } from "../server/contract-template-service.js";
import { sha256 } from "../server/security.js";

function loadJsZip() {
  const bundledModules = process.env.CODEX_NODE_MODULES;
  if (bundledModules) {
    return createRequire(path.join(path.resolve(bundledModules), "codex-document-runtime.cjs"))("jszip");
  }
  return createRequire(import.meta.url)("jszip");
}

const JSZip = loadJsZip();

export const PRODUCTION_CONTRACT_SOURCE_SHA256 = "B4C937519A15B67B02E17FBB543BF70923125D6D9ACC31A8BF6449032A30EE7C";

export const PRODUCTION_CONTRACT_MARKERS = Object.freeze({
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
  maintenanceFeeUpper: "{{MAINTENANCE_FEE_UPPER}}",
  attachmentPriceTable: "{{ATTACHMENT_PRICE_TABLE}}"
});

const SOURCE_PARTS = Object.freeze([
  ["[Content_Types].xml", 1561, "8ca3aaba3b4118534ef9ae31b601ff04de388608b38dc68b39a418a96a83a594"],
  ["_rels/.rels", 737, "514e1846381cb6bcfff105a4b0a17d666cf0ed1f0c120bff73b82226ab7ed977"],
  ["docProps/app.xml", 661, "606749efcab426eb4df47c8f8986faf9394b5dc80cf30223aea8ff30a4158243"],
  ["docProps/core.xml", 697, "b8ea7b7dad0d3944c1503e62b992e023b30ffc06f2168d3fdeda0afa497b07a8"],
  ["docProps/custom.xml", 1204, "3471d160d33d318dadbae3cdaa48bf53a2dca2476c61696b00297bcc19d09575"],
  ["word/_rels/document.xml.rels", 941, "fda4503d3a9ea666c346a8af3994a8c1937e4436b12f4ec24a3bee660d5f9e9e"],
  ["word/document.xml", 319122, "7b1374be39369fb8117ed1cdc4896156fd746b11b8d7fa4d7ef3d03266aaa432"],
  ["word/fontTable.xml", 3083, "1c9dd221f2753d68f44c7ffa64ab849f2c6d88d8e58dc47d246febf3cbc1dc38"],
  ["word/header1.xml", 1394, "b0fe11e147cca7ad9708578d105b6d404156c39902665f780525f623d9f42e24"],
  ["word/numbering.xml", 7404, "bc5cbf8308e97f03969762c513aef5af8fbb3ee8e1844fd18ed1f22e35498347"],
  ["word/settings.xml", 21772, "0a9386ee001c29286dcf34b06a8f868935a1268ed9bcee0f5836be6ffb03af66"],
  ["word/styles.xml", 30392, "5d70b5b7a439a91b3c5ff6465dd565626ba96918e063ebe0ec03f5155682a4e3"],
  ["word/theme/theme1.xml", 7048, "877930300f41fcf60d3edea108678078177c4c20b65ced288432470652e6b4a1"]
].map(([name, size, digest]) => Object.freeze({ name, size, sha256: digest })));

function paragraph(index, rawSha256, replacements) {
  return Object.freeze({ index, rawSha256, replacements: Object.freeze(replacements) });
}

export const PRODUCTION_CONTRACT_PROFILE = Object.freeze({
  sourceSha256: PRODUCTION_CONTRACT_SOURCE_SHA256.toLowerCase(),
  sourceSize: 40206,
  sourceParts: SOURCE_PARTS,
  documentXmlSha256: "7b1374be39369fb8117ed1cdc4896156fd746b11b8d7fa4d7ef3d03266aaa432",
  markerCounts: Object.freeze({
    ...Object.fromEntries(Object.values(PRODUCTION_CONTRACT_MARKERS).map(marker => [marker, 1])),
    [PRODUCTION_CONTRACT_MARKERS.partyAName]: 2
  }),
  paragraphs: Object.freeze([
    paragraph(1, "e5709b0d90aa7c133fee300f5410db038b7611e7575c4970fb6a820b027ac7e3", { 4: PRODUCTION_CONTRACT_MARKERS.contractNumber }),
    paragraph(3, "92ca7c5cf767823fd90e09a24ed5464cad269c66a73cc457eea244e203b00d76", { 7: PRODUCTION_CONTRACT_MARKERS.partyAName, 8: "" }),
    paragraph(7, "6ebee1c49987a2a34905d79dd08771b6e793b1ee6375488950216b3ccc4f12c9", { 1: PRODUCTION_CONTRACT_MARKERS.signLocation, 6: PRODUCTION_CONTRACT_MARKERS.signDate, 7: "", 8: "", 9: "" }),
    paragraph(23, "117cce853f8ad1b280e899d29d52bd7682ca191b649b3c20c826f93aaa9bb02a", { 0: PRODUCTION_CONTRACT_MARKERS.productNames }),
    paragraph(24, "13a019e1e1544a7c06e6dca51be0a7cb0b54253eedaeb8daa67b4f5020429194", { 0: "" }),
    paragraph(25, "b1994a90f1b3d1e24bd12a2043fb206b4b82c10a6f4c62389636bb38ce280c58", { 0: PRODUCTION_CONTRACT_MARKERS.bodyUnit }),
    paragraph(26, "0e75145d9385221c3b271e33dceec6ee859197c694cf20ac3b2e39ce36e705b3", { 0: PRODUCTION_CONTRACT_MARKERS.bodyQuantity }),
    paragraph(27, "5c53ebde31d11831a0ea15f16d8c95dc7c7513e2228617d176b6b596ad39adb9", { 0: PRODUCTION_CONTRACT_MARKERS.bodyUntaxedUnitPrice }),
    paragraph(28, "d92b7339c061d5a5e491056b42ea54527a20e2936b54256194ccff7734becb7b", { 0: PRODUCTION_CONTRACT_MARKERS.bodyUntaxedAmount }),
    paragraph(29, "a84fb62799a4f4830ca78c95b76fe9364e53bafc1ac59cabb6d80b031928506c", { 0: PRODUCTION_CONTRACT_MARKERS.bodyTaxRate, 1: "" }),
    paragraph(30, "067c499414c6a3df761ff7865ca7ac02f756d36893c056463649315bad7ee6bf", { 0: PRODUCTION_CONTRACT_MARKERS.bodyTaxedAmount }),
    paragraph(33, "c0b091f0672d3fd319fd1751a0f10ca41b1314bf1fc1f7782dcccf87c2a84c60", { 0: PRODUCTION_CONTRACT_MARKERS.bodySubtotal }),
    paragraph(36, "ade7d9df27fb84cd0348297eca8de81cd66862ea54fbd6f6ca784dc1b7ea0a2d", { 0: PRODUCTION_CONTRACT_MARKERS.contractAmount }),
    paragraph(38, "9c215809060f7f95aeb12d97bfc876c0f11c62ef3d4ed7ee69cd23c917cd4c99", { 1: PRODUCTION_CONTRACT_MARKERS.contractAmountUpper, 2: "" }),
    paragraph(71, "1f76eb214a82946271d3932958ef872a7d6c2ca3683867f6f54a56f42046e32b", { 7: PRODUCTION_CONTRACT_MARKERS.licenseScope, 8: "" }),
    paragraph(88, "5fcbfcb13359dd646059f6576ff8cd2276bc7f581b4626c53231d1bada18e770", { 10: PRODUCTION_CONTRACT_MARKERS.maintenanceFee, 11: "", 16: PRODUCTION_CONTRACT_MARKERS.maintenanceFeeUpper }),
    paragraph(109, "e2add31701f6b44e6409b777311acbf89540f17ad72c074d970b2f804a71d222", { 2: PRODUCTION_CONTRACT_MARKERS.partyAName }),
    paragraph(110, "9ce9097f1c4e35ac4401e25126016bc46e2a91786190ae05d5f9e201d4abb2f7", { 2: PRODUCTION_CONTRACT_MARKERS.partyARepresentative }),
    paragraph(111, "776170eb8c6659dc87d6d9e448564e7b1664e41ff41f3561f6c57636bfbe4282", { 1: PRODUCTION_CONTRACT_MARKERS.partyALegalRepresentative, 2: "", 3: "", 4: "" }),
    paragraph(112, "ad8b43d53bda79723f6535569b0f6526e738bdec42f8f680724f6339e677f0c5", { 1: PRODUCTION_CONTRACT_MARKERS.partyAZip, 2: "", 3: "" }),
    paragraph(113, "45db0aa2f6c04f93339ac1c2051867664d6e1eee8e7bd798c7f471ad3c6fb1ce", { 1: PRODUCTION_CONTRACT_MARKERS.partyAAddress, 2: "" }),
    paragraph(114, "3360ae843a5cd8183fcf58367c173e58dc9746da0d16912bb50d74c2a0037481", { 1: PRODUCTION_CONTRACT_MARKERS.partyAPhone, 2: "", 3: "" })
  ]),
  mainTable: Object.freeze({ index: 0, rawSha256: "f86d78e0e0ad1565198aa5870c47e7b6afa35646497adc6a298a198342d3ce5c", rowCellCounts: Object.freeze([9, 9, 3, 3, 1]) }),
  attachment: Object.freeze({
    title: "附件一：价格明细",
    titleParagraphIndex: 146,
    titleParagraphRawSha256: "e4d6f40caf1a0b7db43727e988272f1bbaa89f080fbc68fb5ad976af4ec1c0d1",
    tableIndex: 2,
    tableRawSha256: "9b74a9f265571aafd39a78db63d6c5ea1df382af2a4ccbbf6d9da6bc44b33503",
    rowCellCounts: Object.freeze([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 3, 3, 1]),
    marker: PRODUCTION_CONTRACT_MARKERS.attachmentPriceTable
  })
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function occurrences(text, fragment) {
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(fragment, cursor)) !== -1) {
    count += 1;
    cursor += fragment.length;
  }
  return count;
}

function blocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "g"))].map(match => ({ raw: match[0], index: match.index }));
}

function textNodes(xml) {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(match => match[1]);
}

function visibleText(xml) {
  return textNodes(xml).join("").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function replaceTextNodes(xml, replacements, errorContext) {
  let index = -1;
  const expected = new Set(Object.keys(replacements).map(Number));
  const replaced = xml.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (whole, open, _content, close) => {
    index += 1;
    if (!expected.has(index)) return whole;
    expected.delete(index);
    return `${open}${replacements[index]}${close}`;
  });
  if (expected.size) fail("PRODUCTION_TEMPLATE_TARGET_STRUCTURE_CHANGED", `${errorContext} 的文本节点结构不一致`);
  return replaced;
}

function countTableCells(tableXml) {
  return blocks(tableXml, "w:tr").map(row => (row.raw.match(/<w:tc(?:\s|>)/g) || []).length);
}

function revisionAndCommentCounts(zip, documentXml) {
  const wordXmlNames = Object.values(zip.files).filter(entry => !entry.dir && entry.name.startsWith("word/") && entry.name.endsWith(".xml")).map(entry => entry.name);
  return Promise.all(wordXmlNames.map(async name => [name, await zip.file(name).async("string")])).then(entries => {
    const revisionCount = entries.reduce((sum, [, xml]) => sum + (xml.match(/<w:(?:ins|del|moveFrom|moveTo|[A-Za-z]+PrChange)(?:\s|>)/g) || []).length, 0);
    const definitions = entries.filter(([name]) => /^word\/comments[^/]*\.xml$/i.test(name)).reduce((sum, [, xml]) => sum + (xml.match(/<w:comment(?:\s|>)/g) || []).length, 0);
    const anchors = entries.reduce((sum, [, xml]) => sum + (xml.match(/<w:(?:commentRangeStart|commentRangeEnd|commentReference)(?:\s|>)/g) || []).length, 0);
    return { revisionCount, commentCount: definitions + anchors, documentXml };
  });
}

async function loadPackage(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
    const documentEntry = zip.file("word/document.xml");
    if (!documentEntry) fail("PRODUCTION_TEMPLATE_PART_MISSING", "原件缺少 word/document.xml");
    const documentXml = await documentEntry.async("string");
    return { zip, documentXml };
  } catch (error) {
    if (error.code) throw error;
    fail("PRODUCTION_TEMPLATE_PACKAGE_INVALID", "原件 DOCX 压缩包结构损坏或无法读取");
  }
}

async function packageInventory(zip) {
  const entries = Object.values(zip.files).filter(entry => !entry.dir).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return Promise.all(entries.map(async entry => {
    const buffer = await entry.async("nodebuffer");
    return { name: entry.name, size: buffer.length, sha256: sha256(buffer) };
  }));
}

function checkMarkersAbsent(documentXml) {
  if (/\{\{[A-Z0-9_]+\}\}/.test(documentXml)) fail("PRODUCTION_TEMPLATE_ALREADY_ADAPTED", "输入文件已包含系统模板标记，禁止重复适配");
}

function checkParagraphs(documentXml, profile) {
  const paragraphs = blocks(documentXml, "w:p");
  for (const target of profile.paragraphs) {
    const actual = paragraphs[target.index];
    if (!actual || sha256(actual.raw) !== target.rawSha256) {
      fail("PRODUCTION_TEMPLATE_TARGET_CONTEXT_CHANGED", `目标段落 ${target.index} 的上下文或结构与已核验原件不一致`);
    }
    const maxIndex = Math.max(...Object.keys(target.replacements).map(Number));
    if (textNodes(actual.raw).length <= maxIndex) fail("PRODUCTION_TEMPLATE_TARGET_STRUCTURE_CHANGED", `目标段落 ${target.index} 的文本节点缺失`);
  }
  return paragraphs;
}

function checkTables(documentXml, profile) {
  const tables = blocks(documentXml, "w:tbl");
  const main = tables[profile.mainTable.index];
  if (!main || sha256(main.raw) !== profile.mainTable.rawSha256 || JSON.stringify(countTableCells(main.raw)) !== JSON.stringify(profile.mainTable.rowCellCounts)) {
    fail("PRODUCTION_TEMPLATE_MAIN_TABLE_CHANGED", "正文主价格表位置、内容或 5×9 结构与已核验原件不一致");
  }
  const attachment = tables[profile.attachment.tableIndex];
  if (!attachment || sha256(attachment.raw) !== profile.attachment.tableRawSha256 || JSON.stringify(countTableCells(attachment.raw)) !== JSON.stringify(profile.attachment.rowCellCounts)) {
    fail("PRODUCTION_TEMPLATE_ATTACHMENT_TABLE_CHANGED", "附件一示例价格表位置、内容或 17×9 结构与已核验原件不一致");
  }
  return tables;
}

function checkAttachmentTitle(documentXml, profile, paragraphs, tables) {
  const matches = paragraphs.filter(paragraphBlock => visibleText(paragraphBlock.raw).trim() === profile.attachment.title);
  if (matches.length !== 1) fail("PRODUCTION_TEMPLATE_ATTACHMENT_TITLE_AMBIGUOUS", `附件一标题必须唯一，当前为 ${matches.length} 处`);
  const title = paragraphs[profile.attachment.titleParagraphIndex];
  if (!title || title.raw !== matches[0].raw || sha256(title.raw) !== profile.attachment.titleParagraphRawSha256) {
    fail("PRODUCTION_TEMPLATE_ATTACHMENT_TITLE_CHANGED", "附件一标题位置或结构与已核验原件不一致");
  }
  const table = tables[profile.attachment.tableIndex];
  if (table.index <= title.index || documentXml.slice(title.index + title.raw.length, table.index).trim()) {
    fail("PRODUCTION_TEMPLATE_ATTACHMENT_POSITION_CHANGED", "附件一标题后不再紧邻已核验的示例价格表");
  }
}

async function verifySource(buffer, profile) {
  const { zip, documentXml } = await loadPackage(buffer);
  checkMarkersAbsent(documentXml);
  const counts = await revisionAndCommentCounts(zip, documentXml);
  if (counts.revisionCount) fail("PRODUCTION_TEMPLATE_REVISIONS_PENDING", `原件存在 ${counts.revisionCount} 处未接受修订`);
  if (counts.commentCount) fail("PRODUCTION_TEMPLATE_COMMENTS_PRESENT", "原件存在批注或批注锚点");
  if (buffer.length !== profile.sourceSize || sha256(buffer) !== profile.sourceSha256) fail("PRODUCTION_TEMPLATE_SOURCE_SHA256_MISMATCH", "原件大小或 SHA-256 与受控映射不一致");
  const inventory = await packageInventory(zip);
  if (JSON.stringify(inventory) !== JSON.stringify(profile.sourceParts)) fail("PRODUCTION_TEMPLATE_PACKAGE_MANIFEST_CHANGED", "原件 OOXML 部件清单、大小或摘要与受控映射不一致");
  if (sha256(documentXml) !== profile.documentXmlSha256) fail("PRODUCTION_TEMPLATE_DOCUMENT_XML_CHANGED", "原件 word/document.xml 摘要与受控映射不一致");
  const paragraphs = checkParagraphs(documentXml, profile);
  const tables = checkTables(documentXml, profile);
  checkAttachmentTitle(documentXml, profile, paragraphs, tables);
  return { zip, documentXml, inventory, paragraphs, tables, revisionCount: counts.revisionCount, commentCount: counts.commentCount };
}

function applyParagraphMappings(documentXml, profile) {
  const paragraphs = blocks(documentXml, "w:p");
  const changes = [];
  for (const target of profile.paragraphs) {
    const current = paragraphs[target.index];
    const replacement = replaceTextNodes(current.raw, target.replacements, `目标段落 ${target.index}`);
    changes.push({ start: current.index, end: current.index + current.raw.length, replacement });
  }
  let result = documentXml;
  for (const change of changes.sort((left, right) => right.start - left.start)) result = result.slice(0, change.start) + change.replacement + result.slice(change.end);
  return result;
}

function replaceAttachmentTable(documentXml, profile) {
  const tables = blocks(documentXml, "w:tbl");
  const target = tables[profile.attachment.tableIndex];
  const markerParagraph = `<w:p><w:r><w:t>${profile.attachment.marker}</w:t></w:r></w:p>`;
  return documentXml.slice(0, target.index) + markerParagraph + documentXml.slice(target.index + target.raw.length);
}

function checkAdaptedMarkers(documentXml, profile) {
  for (const [marker, expected] of Object.entries(profile.markerCounts)) {
    const actual = occurrences(documentXml, marker);
    if (actual !== expected) fail("PRODUCTION_TEMPLATE_ADAPTED_MARKER_INVALID", `${marker} 预期 ${expected} 处，实际 ${actual} 处`);
  }
}

function canonicalSourceDocument(documentXml, profile) {
  let canonical = applyParagraphMappings(documentXml, {
    ...profile,
    paragraphs: profile.paragraphs.map(target => ({ ...target, replacements: Object.fromEntries(Object.keys(target.replacements).map(index => [index, `[[ALLOWED:${target.index}:${index}]]`])) }))
  });
  const tables = blocks(canonical, "w:tbl");
  const target = tables[profile.attachment.tableIndex];
  return canonical.slice(0, target.index) + "[[ALLOWED:ATTACHMENT_PRICE_TABLE]]" + canonical.slice(target.index + target.raw.length);
}

function canonicalAdaptedDocument(documentXml, profile) {
  let canonical = documentXml;
  const paragraphs = blocks(canonical, "w:p");
  const changes = profile.paragraphs.map(target => {
    const current = paragraphs[target.index];
    const replacements = Object.fromEntries(Object.keys(target.replacements).map(index => [index, `[[ALLOWED:${target.index}:${index}]]`]));
    return { start: current.index, end: current.index + current.raw.length, replacement: replaceTextNodes(current.raw, replacements, `适配段落 ${target.index}`) };
  });
  for (const change of changes.sort((left, right) => right.start - left.start)) canonical = canonical.slice(0, change.start) + change.replacement + canonical.slice(change.end);
  const markerParagraphs = blocks(canonical, "w:p").filter(item => visibleText(item.raw) === profile.attachment.marker);
  if (markerParagraphs.length !== 1) fail("PRODUCTION_TEMPLATE_ATTACHMENT_ANCHOR_INVALID", "适配结果附件锚点不是唯一独立段落");
  const marker = markerParagraphs[0];
  return canonical.slice(0, marker.index) + "[[ALLOWED:ATTACHMENT_PRICE_TABLE]]" + canonical.slice(marker.index + marker.raw.length);
}

export async function proveProductionTemplateDiff(sourceBuffer, adaptedBuffer, { profile = PRODUCTION_CONTRACT_PROFILE } = {}) {
  const source = await verifySource(sourceBuffer, profile);
  const adapted = await loadPackage(adaptedBuffer);
  checkAdaptedMarkers(adapted.documentXml, profile);
  const adaptedCounts = await revisionAndCommentCounts(adapted.zip, adapted.documentXml);
  if (adaptedCounts.revisionCount || adaptedCounts.commentCount) fail("PRODUCTION_TEMPLATE_ADAPTED_REVIEW_MARKUP_PRESENT", "适配结果出现修订或批注");
  const sourceInventory = await packageInventory(source.zip);
  const adaptedInventory = await packageInventory(adapted.zip);
  const sourceOther = sourceInventory.filter(part => part.name !== "word/document.xml");
  const adaptedOther = adaptedInventory.filter(part => part.name !== "word/document.xml");
  if (JSON.stringify(sourceOther) !== JSON.stringify(adaptedOther)) fail("PRODUCTION_TEMPLATE_FIXED_PART_CHANGED", "适配结果改动了 document.xml 之外的 OOXML 部件");
  const sourceFixed = canonicalSourceDocument(source.documentXml, profile);
  const adaptedFixed = canonicalAdaptedDocument(adapted.documentXml, profile);
  if (sourceFixed !== adaptedFixed) fail("PRODUCTION_TEMPLATE_FIXED_DOCUMENT_CHANGED", "适配结果改动了白名单之外的 document.xml 内容");
  return {
    ok: true,
    sourceSha256: sha256(sourceBuffer),
    adaptedSha256: sha256(adaptedBuffer),
    sourceDocumentXmlSha256: sha256(source.documentXml),
    adaptedDocumentXmlSha256: sha256(adapted.documentXml),
    fixedDocumentFingerprint: sha256(sourceFixed),
    unchangedPartCount: sourceOther.length,
    changedParts: ["word/document.xml"],
    allowedParagraphCount: profile.paragraphs.length,
    allowedAttachmentTableCount: 1,
    markerCounts: profile.markerCounts,
    revisionCount: adaptedCounts.revisionCount,
    commentCount: adaptedCounts.commentCount
  };
}

export async function adaptProductionContractTemplateBuffer(sourceBuffer, { profile = PRODUCTION_CONTRACT_PROFILE } = {}) {
  const source = await verifySource(sourceBuffer, profile);
  let documentXml = applyParagraphMappings(source.documentXml, profile);
  documentXml = replaceAttachmentTable(documentXml, profile);
  checkAdaptedMarkers(documentXml, profile);
  const originalDocumentEntry = source.zip.file("word/document.xml");
  source.zip.file("word/document.xml", documentXml, {
    date: originalDocumentEntry.date,
    comment: originalDocumentEntry.comment,
    unixPermissions: originalDocumentEntry.unixPermissions,
    dosPermissions: originalDocumentEntry.dosPermissions,
    createFolders: false
  });
  const buffer = await source.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  let proof = await proveProductionTemplateDiff(sourceBuffer, buffer, { profile });
  if (profile === PRODUCTION_CONTRACT_PROFILE) {
    const validation = await validateContractTemplateBuffer(buffer);
    if (!validation.ok) fail("PRODUCTION_TEMPLATE_PROJECT_GATE_REJECTED", `适配结果未通过项目模板门禁：${validation.issues.map(item => item.code).join("、")}`);
    proof = {
      ...proof,
      projectTemplateValidation: {
        ok: validation.ok,
        fixedFingerprint: validation.fixedFingerprint,
        markerCount: validation.markerCount,
        revisionCount: validation.revisionCount,
        commentCount: validation.commentCount
      }
    };
  }
  return { buffer, proof };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input" || arg === "--output" || arg === "--proof") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("PRODUCTION_TEMPLATE_ARGUMENT_INVALID", `${arg} 必须提供路径`);
      options[arg.slice(2)] = value;
      index += 1;
    } else {
      fail("PRODUCTION_TEMPLATE_ARGUMENT_INVALID", `不支持的参数：${arg}`);
    }
  }
  if (!options.input || !options.output || !options.proof) fail("PRODUCTION_TEMPLATE_ARGUMENT_REQUIRED", "必须显式提供 --input、--output 和 --proof");
  return options;
}

export async function runProductionContractAdapterCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);
  const proofPath = path.resolve(options.proof);
  if (inputPath === outputPath) fail("PRODUCTION_TEMPLATE_OUTPUT_OVERWRITE_FORBIDDEN", "输出路径不得覆盖原件");
  if (proofPath === inputPath || proofPath === outputPath) fail("PRODUCTION_TEMPLATE_PROOF_PATH_INVALID", "差异证明路径不得与原件或适配输出相同");
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) fail("PRODUCTION_TEMPLATE_INPUT_NOT_FOUND", "输入原件不存在或不是文件");
  if (fs.existsSync(outputPath)) fail("PRODUCTION_TEMPLATE_OUTPUT_EXISTS", "输出路径已存在，拒绝覆盖");
  if (fs.existsSync(proofPath)) fail("PRODUCTION_TEMPLATE_PROOF_EXISTS", "差异证明路径已存在，拒绝覆盖");
  const sourceBuffer = fs.readFileSync(inputPath);
  const adapted = await adaptProductionContractTemplateBuffer(sourceBuffer);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  let outputCreated = false;
  let proofCreated = false;
  try {
    fs.writeFileSync(outputPath, adapted.buffer, { flag: "wx" });
    outputCreated = true;
    fs.writeFileSync(proofPath, `${JSON.stringify(adapted.proof, null, 2)}\n`, { flag: "wx" });
    proofCreated = true;
  } catch (error) {
    if (proofCreated) fs.rmSync(proofPath, { force: true });
    if (outputCreated) fs.rmSync(outputPath, { force: true });
    throw error;
  }
  return { outputPath, proofPath, proof: adapted.proof };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runProductionContractAdapterCli().then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch(error => {
    process.stderr.write(`${error.code || "PRODUCTION_TEMPLATE_ADAPTER_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export const __test = { blocks, visibleText, replaceTextNodes, canonicalSourceDocument, canonicalAdaptedDocument, parseArgs };
