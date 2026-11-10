import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { Document, Packer, Paragraph } from "docx";
import { createApp } from "../server/app.js";
import { uploadAttachment } from "../server/attachment-service.js";
import { createUser, login } from "../server/auth-service.js";
import { __test as docxInternals, exportApprovedQuoteDocx, exportSurveyDocx } from "../server/docx-service.js";
import { getFileForDownload } from "../server/file-service.js";
import { createQuote, decideQuote, getQuoteVersion, submitQuote } from "../server/quote-service.js";
import { sha256 } from "../server/security.js";
import { completeSurvey, createSurvey, updateSurvey } from "../server/survey-service.js";
import { addCustomerAndProject, completeSurveyResponse, sampleQuoteInput, setupBase } from "./test-utils.js";

async function xmlParts(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file("word/document.xml").async("string");
  const coreXml = await zip.file("docProps/core.xml").async("string");
  return { documentXml, coreXml };
}

test("调研报告 Word 来自固定模板和已保存版本，文件下载继承客户权限", async () => {
  const { db, manager, salesA, salesOther } = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-survey-docx-"));
  let server;
  try {
    const config = { storagePath };
    const { customer, project } = addCustomerAndProject(db, salesA, "调研导出");
    const survey = createSurvey(db, salesA, { templateId: "MES-PRESALES-SURVEY:A/0", customerId: customer.id, projectId: project.id, title: "虚构软件调研导出" });
    await assert.rejects(() => exportSurveyDocx(db, config, salesA, survey.id), error => error.code === "SURVEY_NOT_COMPLETED");
    const response = completeSurveyResponse(survey.template.schema);
    response.answers.m1 = { record: "虚构经营目标回答", solution: "虚构系统建议" };
    updateSurvey(db, salesA, survey.id, { response });
    completeSurvey(db, salesA, survey.id);

    const file = await exportSurveyDocx(db, config, salesA, survey.id);
    assert.match(file.storageKey, /^files\/[0-9a-f-]+\.docx$/);
    assert.doesNotMatch(file.storageKey, /虚构客户/);
    const downloaded = getFileForDownload(db, config, manager, file.id);
    const { documentXml, coreXml } = await xmlParts(fs.readFileSync(downloaded.absolutePath));
    assert.match(documentXml, /软件调研报告/);
    assert.match(documentXml, /虚构客户调研导出有限公司/);
    assert.match(documentXml, /MES-PRESALES-SURVEY A\/0/);
    assert.match(documentXml, /虚构经营目标回答/);
    assert.match(documentXml, /虚构系统建议/);
    assert.match(coreXml, /Haihong Presales Hub/);
    assert.doesNotMatch(coreXml, /测试售前甲/);
    const successor = updateSurvey(db, salesA, survey.id, { response, reason: "虚构确认后需求调整" });
    assert.equal(successor.status, "DRAFT");
    assert.equal(successor.versionNumber, 2);
    await assert.rejects(() => exportSurveyDocx(db, config, salesA, successor.id), error => error.code === "SURVEY_NOT_COMPLETED");
    assert.equal((await exportSurveyDocx(db, config, salesA, survey.id)).entityId, survey.id);
    assert.throws(() => getFileForDownload(db, config, salesOther, file.id), error => error.code === "FILE_NOT_FOUND");

    const password = `${randomBytes(18).toString("base64url")}aA1!`;
    const username = `docx-download-${randomUUID()}`;
    createUser(db, { username, displayName: "虚构下载验收管理员", password, role: "ADMIN" });
    const session = login(db, { username, password, sessionHours: 1 });
    server = createApp({ db, config: { ...config, sessionHours: 1, secureCookie: false } }).listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const downloadResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/files/${file.id}/download`, { headers: { cookie: `hh_session=${session.token}` } });
    assert.equal(downloadResponse.status, 200);
    assert.match(downloadResponse.headers.get("content-disposition"), /attachment/i);
    assert.equal(sha256(Buffer.from(await downloadResponse.arrayBuffer())), file.sha256);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test("审批报价 Word 只使用终审快照并按对客模板展示项目总价和最终优惠价", async () => {
  const { db, manager, generalManager, vp, salesA, salesOther } = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-quote-docx-"));
  try {
    const config = { storagePath };
    const { customer, project } = addCustomerAndProject(db, salesA, "报价导出");
    const quote = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "DOCX"));
    submitQuote(db, salesA, quote.id);
    decideQuote(db, manager, quote.id, { decision: "APPROVED", comment: "虚构一级审批通过" });
    decideQuote(db, generalManager, quote.id, { decision: "APPROVED", comment: "虚构综合部二审通过" });
    decideQuote(db, vp, quote.id, { decision: "APPROVED", comment: "虚构终审通过" });

    db.prepare(`UPDATE quote_items SET item_name = '被篡改的实时明细', taxed_amount_cents = 1 WHERE quote_version_id = ? AND line_no = 1`).run(quote.id);
    const file = await exportApprovedQuoteDocx(db, config, salesA, quote.id);
    const { documentXml, coreXml } = await xmlParts(fs.readFileSync(getFileForDownload(db, config, salesA, file.id).absolutePath));
    assert.match(documentXml, /虚构生产执行模块/);
    assert.doesNotMatch(documentXml, /被篡改的实时明细/);
    assert.match(documentXml, /软　件　报　价　单/);
    assert.match(documentXml, /项目总价/);
    assert.match(documentXml, /项目费用明细/);
    assert.match(documentXml, /127,200\.00/);
    assert.match(documentXml, /优惠后合计（含税）：/);
    assert.match(documentXml, /126,000\.00/);
    assert.match(documentXml, /河南海弘软件技术有限公司/);
    assert.doesNotMatch(documentXml, /虚构一级审批通过|虚构终审通过/);
    assert.doesNotMatch(documentXml, /<w:br w:type="page"\/>/);
    assert.match(documentXml, /未税<\/w:t><w:br\/><w:t xml:space="preserve">单价\(元\)/);
    assert.doesNotMatch(documentXml, /(?:未税|含税)\n(?:单价|金额)/);
    assert.match(coreXml, /Haihong Presales Hub/);
    await assert.rejects(() => exportApprovedQuoteDocx(db, config, salesOther, quote.id), error => error.code === "QUOTE_VERSION_NOT_FOUND");
    assert.throws(() => getFileForDownload(db, config, salesOther, file.id), error => error.code === "FILE_NOT_FOUND");
    assert.deepEqual(getQuoteVersion(db, salesA, quote.id).exportedFiles.map(item => item.id), [file.id]);
    assert.deepEqual(getQuoteVersion(db, vp, quote.id).exportedFiles.map(item => item.id), [file.id]);

    db.prepare(`UPDATE quote_approval_snapshots SET snapshot_json = json_set(snapshot_json, '$.content.finalDiscountCents', 1) WHERE quote_version_id = ? AND approval_id = (SELECT id FROM quote_approvals WHERE quote_version_id = ? AND stage = 'VP')`).run(quote.id, quote.id);
    await assert.rejects(() => exportApprovedQuoteDocx(db, config, salesA, quote.id), error => error.code === "QUOTE_APPROVAL_SNAPSHOT_INVALID");
  } finally {
    db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test("对客报价 Word 使用 13% 含税录入、报价元数据和费用明细", async () => {
  const { db, manager, generalManager, vp, salesA } = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-quote-format-docx-"));
  try {
    const config = { storagePath };
    const { customer, project } = addCustomerAndProject(db, salesA, "对客格式");
    const quote = createQuote(db, salesA, {
      quoteNumber: `Q-FORMAT-${randomUUID().slice(0, 8)}`,
      customerId: customer.id,
      projectId: project.id,
      notes: "注：虚构报价格式验收",
      metadata: {
        quoteDate: "2026-10-26",
        validity: "30 天",
        customerContactName: "虚构联系人",
        customerPhone: "13000000000",
        deliveryTerms: "虚构合同约定交期",
        paymentTerms: "虚构合同约定付款",
        sellerName: "虚构报价人",
        sellerPhone: "13900000000",
        sellerEmail: "quote@example.test"
      },
      finalDiscountCents: 11_100,
      items: [{ category: "项目总价", itemName: "虚构 HMES V2.0", unit: "套", quantityMilli: 1000, pricingMode: "TAXED_TOTAL", taxedAmountCents: 11_100, taxRateBps: 1300, notes: "虚构总价备注" }],
      detailItems: [{ category: "费用明细", itemName: "虚构实施", subitemName: "虚构现场服务", unit: "人天", quantityMilli: 2000, pricingMode: "TAXED_TOTAL", taxedAmountCents: 11_100, taxRateBps: 1300, notes: "虚构费用备注" }]
    });
    assert.equal(quote.items[0].untaxedAmountCents, 9823);
    assert.equal(quote.items[0].untaxedUnitPriceCents, 9823);
    assert.equal(quote.items[0].taxedAmountCents, 11_100);
    assert.equal(quote.detailItems[0].taxedAmountCents, 11_100);
    submitQuote(db, salesA, quote.id);
    decideQuote(db, manager, quote.id, { decision: "APPROVED", comment: "虚构格式一级通过" });
    decideQuote(db, generalManager, quote.id, { decision: "APPROVED", comment: "虚构格式综合部二审通过" });
    decideQuote(db, vp, quote.id, { decision: "APPROVED", comment: "虚构格式终审通过" });

    const file = await exportApprovedQuoteDocx(db, config, salesA, quote.id);
    const { documentXml } = await xmlParts(fs.readFileSync(getFileForDownload(db, config, salesA, file.id).absolutePath));
    for (const expected of ["虚构联系人", "13000000000", "虚构报价人", "quote@example.test", "虚构 HMES V2.0", "虚构现场服务", "含 13% 增值税", "壹佰壹拾壹元整", "虚构合同约定交期", "虚构合同约定付款"]) assert.match(documentXml, new RegExp(expected));
    assert.doesNotMatch(documentXml, /\{\{[A-Z_]+\}\}/);
    assert.doesNotMatch(documentXml, /优惠后合计/);
  } finally {
    db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test("报价提交冻结的 Word 附件按原文件字节并入对客报价包", async () => {
  const { db, manager, generalManager, vp, salesA } = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-quote-attachment-docx-"));
  try {
    const config = { storagePath };
    const { customer, project } = addCustomerAndProject(db, salesA, "附件保真");
    const quote = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "ATTACHMENT-DOCX"));
    const attachmentBuffer = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("虚构附件正文，仅用于自动化测试")] }] }));
    await uploadAttachment(db, config, salesA, { targetType: "QUOTE_VERSION", targetId: quote.id }, {
      originalname: "虚构报价附件.docx",
      mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: attachmentBuffer
    });
    submitQuote(db, salesA, quote.id);
    decideQuote(db, manager, quote.id, { decision: "APPROVED", comment: "虚构附件一级通过" });
    decideQuote(db, generalManager, quote.id, { decision: "APPROVED", comment: "虚构附件综合部二审通过" });
    decideQuote(db, vp, quote.id, { decision: "APPROVED", comment: "虚构附件终审通过" });

    const file = await exportApprovedQuoteDocx(db, config, salesA, quote.id);
    const exported = fs.readFileSync(getFileForDownload(db, config, salesA, file.id).absolutePath);
    const zip = await JSZip.loadAsync(exported);
    assert.ok(zip.file("word/quote-attachment-1.docx"));
    assert.deepEqual(await zip.file("word/quote-attachment-1.docx").async("nodebuffer"), attachmentBuffer);
    assert.match(await zip.file("word/document.xml").async("string"), /附件一  虚构报价附件/);
    assert.equal((await zip.file("word/document.xml").async("string")).match(/<w:br w:type="page"\/>/g)?.length, 1);
    assert.match(await zip.file("word/_rels/document.xml.rels").async("string"), /relationships\/aFChunk/);
  } finally {
    db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test("历史 Excel 附件合并保留原有范围校验，新增报价附件拒绝 Excel", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("功能清单");
  sheet.getCell("A1").value = "首行内容";
  sheet.getCell("F10").value = "末行中文 & 特殊符号";
  const html = (await docxInternals.excelAttachmentHtml(Buffer.from(await workbook.xlsx.writeBuffer()))).toString("utf8");
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
  assert.equal(rows.length, 10);
  assert.equal((rows[9][1].match(/<td>/g) || []).length, 6);
  assert.match(rows[9][1], /末行中文 &amp; 特殊符号/);

  sheet.getCell("A501").value = "超出范围的数据";
  const oversized = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(
    () => docxInternals.excelAttachmentHtml(oversized),
    error => error.code === "QUOTE_EXCEL_ATTACHMENT_TOO_LARGE" && /500 行或 40 列/.test(error.message)
  );
  const { db, salesA } = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-quote-excel-limit-"));
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "附件范围");
    const quote = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "EXCEL-LIMIT"));
    await assert.rejects(() => uploadAttachment(db, { storagePath }, salesA, { targetType: "QUOTE_VERSION", targetId: quote.id }, {
      originalname: "范围过大的工作表.xlsx",
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: oversized
    }), error => error.code === "QUOTE_ATTACHMENT_FORMAT_INVALID");
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM business_attachments`).get().count, 0);
  } finally {
    db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});
