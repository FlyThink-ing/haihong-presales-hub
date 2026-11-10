import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import {
  CONTRACT_TEMPLATE_MARKERS,
  generateContractFromTemplate,
  publishContractTemplate,
  uploadContractTemplate,
  validateContractTemplateBuffer,
  verifyGeneratedContractBuffer
} from "../server/contract-template-service.js";
import { safeDownloadName, storeFile } from "../server/file-service.js";
import { syntheticProductionTemplateBuffer } from "./contract-template-fixture.js";
import { setupBase } from "./test-utils.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function mutateDocumentXml(buffer, mutate) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml").async("string");
  zip.file("word/document.xml", mutate(xml));
  return zip.generateAsync({ type: "nodebuffer" });
}

function generatedValues() {
  return {
    contractNumber: "HT-VIRTUAL-001",
    signLocation: "鹤壁",
    signDate: "2026-08-25",
    partyAName: "虚构甲方有限公司",
    licenseScope: "虚构甲方有限公司",
    partyALegalRepresentative: "虚构法定代表人",
    partyARepresentative: "虚构甲方代表",
    partyAZip: "000000",
    partyAAddress: "虚构地址",
    partyAPhone: "000-00000000",
    productNames: "虚构生产执行模块",
    bodyUnit: "套",
    bodyQuantity: "1",
    bodyUntaxedUnitPrice: "¥120,000.00",
    bodyUntaxedAmount: "¥120,000.00",
    bodyTaxRate: "6%",
    bodyTaxedAmount: "¥127,200.00",
    bodySubtotal: "¥127,200.00",
    contractAmount: "¥126,000.00",
    contractAmountUpper: "人民币壹拾贰万陆仟元整",
    maintenanceFee: "¥12,600.00",
    maintenanceFeeUpper: "人民币壹万贰仟陆佰元整"
  };
}

function approvedSnapshot() {
  return {
    subtotalTaxedCents: 12_720_000,
    finalDiscountCents: 12_600_000,
    items: [{
      lineNo: 1,
      itemName: "虚构生产执行模块",
      subitemName: "虚构基础功能",
      unit: "套",
      quantityMilli: 1000,
      untaxedUnitPriceCents: 12_000_000,
      untaxedAmountCents: 12_000_000,
      taxRateBps: 600,
      taxedAmountCents: 12_720_000
    }]
  };
}

test("合同模板门禁拒绝修订、批注和缺失锚点，并只允许管理员发布不可覆盖版本", async () => {
  const { db, admin, salesA } = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-contract-template-"));
  try {
    const validBuffer = await syntheticProductionTemplateBuffer();
    const valid = await validateContractTemplateBuffer(validBuffer);
    assert.equal(valid.ok, true, JSON.stringify(valid.issues));
    assert.ok(valid.fixedFingerprint);

    const revisionBuffer = await mutateDocumentXml(validBuffer, xml => xml.replace("<w:body>", '<w:body><w:ins w:id="1"><w:r><w:t>虚构修订</w:t></w:r></w:ins>'));
    const revision = await validateContractTemplateBuffer(revisionBuffer);
    assert.equal(revision.ok, false);
    assert.ok(revision.issues.some(item => item.code === "CONTRACT_TEMPLATE_REVISIONS_PENDING"));

    const commentZip = await JSZip.loadAsync(validBuffer);
    commentZip.file("word/comments.xml", '<?xml version="1.0" encoding="UTF-8"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="1" w:author="虚构审阅人"><w:p><w:r><w:t>虚构批注</w:t></w:r></w:p></w:comment></w:comments>');
    const comments = await validateContractTemplateBuffer(await commentZip.generateAsync({ type: "nodebuffer" }));
    assert.equal(comments.ok, false);
    assert.ok(comments.issues.some(item => item.code === "CONTRACT_TEMPLATE_COMMENTS_PRESENT"));

    const missingAnchorBuffer = await mutateDocumentXml(validBuffer, xml => xml.replace(CONTRACT_TEMPLATE_MARKERS.contractNumber, "缺失合同编号变量"));
    const missingAnchor = await validateContractTemplateBuffer(missingAnchorBuffer);
    assert.equal(missingAnchor.ok, false);
    assert.ok(missingAnchor.issues.some(item => item.code === "CONTRACT_TEMPLATE_ANCHOR_INVALID"));

    const missingRepeatedPartyA = await mutateDocumentXml(validBuffer, xml => xml.replace(CONTRACT_TEMPLATE_MARKERS.partyAName, "缺失第一处甲方名称"));
    const repeatedPartyA = await validateContractTemplateBuffer(missingRepeatedPartyA);
    assert.equal(repeatedPartyA.ok, false);
    assert.ok(repeatedPartyA.issues.some(item => item.code === "CONTRACT_TEMPLATE_ANCHOR_INVALID" && item.message.includes("2 个位置")));

    const misplacedRepeatedPartyA = await mutateDocumentXml(validBuffer, xml => xml
      .replace(CONTRACT_TEMPLATE_MARKERS.partyAName, "甲方名称被移出抬头")
      .replace("虚构固定-4-0", CONTRACT_TEMPLATE_MARKERS.partyAName));
    const misplacedPartyA = await validateContractTemplateBuffer(misplacedRepeatedPartyA);
    assert.equal(misplacedPartyA.ok, false);
    assert.ok(misplacedPartyA.issues.some(item => item.code === "CONTRACT_TEMPLATE_MARKER_LOCATION_INVALID"));

    const swappedBodySlots = await mutateDocumentXml(validBuffer, xml => xml
      .replace(CONTRACT_TEMPLATE_MARKERS.bodyUnit, "{{SWAP_TEMP}}")
      .replace(CONTRACT_TEMPLATE_MARKERS.bodyUntaxedUnitPrice, CONTRACT_TEMPLATE_MARKERS.bodyUnit)
      .replace("{{SWAP_TEMP}}", CONTRACT_TEMPLATE_MARKERS.bodyUntaxedUnitPrice));
    const swappedBodyValidation = await validateContractTemplateBuffer(swappedBodySlots);
    assert.equal(swappedBodyValidation.ok, false);
    assert.equal(swappedBodyValidation.fixedFingerprint, null);
    assert.ok(swappedBodyValidation.issues.some(item => item.code === "CONTRACT_TEMPLATE_MARKER_LOCATION_INVALID" && item.message.includes(CONTRACT_TEMPLATE_MARKERS.bodyUnit)));
    assert.ok(swappedBodyValidation.issues.some(item => item.code === "CONTRACT_TEMPLATE_MARKER_LOCATION_INVALID" && item.message.includes(CONTRACT_TEMPLATE_MARKERS.bodyUntaxedUnitPrice)));

    const unknownMarkerBuffer = await mutateDocumentXml(validBuffer, xml => xml.replace("虚构固定-116-0", "{{UNAPPROVED_FIELD}}虚构固定-116-0"));
    const unknownMarker = await validateContractTemplateBuffer(unknownMarkerBuffer);
    assert.equal(unknownMarker.ok, false);
    assert.ok(unknownMarker.issues.some(item => item.code === "CONTRACT_TEMPLATE_UNKNOWN_MARKER"));

    const file = { originalname: "虚构合同模板.docx", mimetype: DOCX_MIME, buffer: validBuffer };
    await assert.rejects(() => uploadContractTemplate(db, { storagePath }, salesA, file, "VIRTUAL-1.0"), error => error.code === "CONTRACT_TEMPLATE_ADMIN_FORBIDDEN");
    const template = await uploadContractTemplate(db, { storagePath }, admin, file, "VIRTUAL-1.0");
    assert.equal(template.status, "VALIDATED");
    const published = await publishContractTemplate(db, { storagePath }, admin, template.id);
    assert.equal(published.status, "PUBLISHED");
    await assert.rejects(() => publishContractTemplate(db, { storagePath }, admin, template.id), error => error.code === "CONTRACT_TEMPLATE_ALREADY_PUBLISHED");
    await assert.rejects(() => uploadContractTemplate(db, { storagePath }, admin, file, "VIRTUAL-1.0"), error => error.code === "CONTRACT_TEMPLATE_VERSION_EXISTS");
  } finally {
    db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test("合同生成只替换白名单槽位，生成后固定正文被篡改时结构校验必失败", async () => {
  const templateBuffer = await syntheticProductionTemplateBuffer();
  const values = generatedValues();
  const snapshot = approvedSnapshot();
  const generated = await generateContractFromTemplate(templateBuffer, values, snapshot);
  await verifyGeneratedContractBuffer(templateBuffer, generated.buffer, values, snapshot);
  const generatedZip = await JSZip.loadAsync(generated.buffer);
  const generatedXml = await generatedZip.file("word/document.xml").async("string");
  assert.equal((generatedXml.match(/虚构甲方有限公司/g) || []).length, 3);
  assert.doesNotMatch(generatedXml, /\{\{[A-Z0-9_]+\}\}/);
  assert.match(generatedXml, /¥120,000\.00/);
  assert.match(generatedXml, /¥127,200\.00/);
  const tampered = await mutateDocumentXml(generated.buffer, xml => xml.replace("虚构固定-0-0", "虚构固定正文被篡改"));
  await assert.rejects(
    () => verifyGeneratedContractBuffer(templateBuffer, tampered, values, snapshot),
    error => error.code === "CONTRACT_GENERATED_STRUCTURE_INVALID" || error.code === "CONTRACT_GENERATED_FINGERPRINT_MISMATCH"
  );
});

test("通用文件服务分别校验上传路径并约束服务端生成文件路径", () => {
  const { db, admin } = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-file-branches-"));
  try {
    const uploaded = storeFile(db, { storagePath }, admin, {
      entityType: "IMPORT_JOB",
      entityId: "virtual-import",
      category: "SOURCE_XLSX",
      originalName: "虚构导入.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
      validateUpload: true
    });
    assert.equal(uploaded.category, "SOURCE_XLSX");
    const generated = storeFile(db, { storagePath }, admin, {
      entityType: "QUOTE_VERSION",
      entityId: "virtual-quote",
      category: "APPROVED_QUOTE_DOCX",
      originalName: "虚构报价.docx",
      mimeType: DOCX_MIME,
      buffer: Buffer.from("server-generated-placeholder")
    });
    assert.equal(generated.category, "APPROVED_QUOTE_DOCX");
    assert.throws(() => storeFile(db, { storagePath }, admin, {
      entityType: "QUOTE_VERSION",
      entityId: "virtual-empty",
      category: "APPROVED_QUOTE_DOCX",
      originalName: "空文件.docx",
      mimeType: DOCX_MIME,
      buffer: Buffer.alloc(0)
    }), error => error.code === "GENERATED_FILE_INVALID");
  } finally {
    db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test("上传文件名兼容浏览器 multipart 的 UTF-8 乱码编码", () => {
  const expected = "虚构合同模板.docx";
  const multipartName = Buffer.from(expected, "utf8").toString("latin1");
  assert.equal(safeDownloadName(multipartName, "fallback.docx"), expected);
  assert.equal(safeDownloadName(expected, "fallback.docx"), expected);
});
