import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { createApp } from "../server/app.js";
import { resetUserPassword } from "../server/auth-service.js";
import {
  __test,
  archiveContractFile,
  confirmSignedContractCustomerStatus,
  chineseMoneyUpper,
  createContractDraft,
  generateContractDocument,
  getContract,
  getContractFileDownload,
  preflightContract,
  updateContractDraft,
  updateSigningNotes
} from "../server/contract-service.js";
import { publishContractTemplate, uploadContractTemplate } from "../server/contract-template-service.js";
import { createQuote, decideQuote, submitQuote } from "../server/quote-service.js";
import { sha256 } from "../server/security.js";
import { syntheticProductionTemplateBuffer } from "./contract-template-fixture.js";
import { addCustomerAndProject, completeResetLogin, sampleQuoteInput, setupBase } from "./test-utils.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CONFIRMATION_FIELDS = [
  "partyAName", "licenseScope", "partyALegalRepresentative", "partyARepresentative",
  "partyAZip", "partyAAddress", "partyAPhone", "contractNumber", "signLocation", "signDate"
];

async function fixture() {
  const base = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-contract-life-"));
  const { customer, project } = addCustomerAndProject(base.db, base.salesA, "合同闭环");
  const quote = createQuote(base.db, base.salesA, sampleQuoteInput(customer.id, project.id, "CONTRACT-LIFE"));
  submitQuote(base.db, base.salesA, quote.id);
  decideQuote(base.db, base.manager, quote.id, { decision: "APPROVED", comment: "虚构一级审批通过" });
  decideQuote(base.db, base.generalManager, quote.id, { decision: "APPROVED", comment: "虚构综合部审批通过" });
  decideQuote(base.db, base.vp, quote.id, { decision: "APPROVED", comment: "虚构终审通过" });
  const uploaded = await uploadContractTemplate(base.db, { storagePath }, base.admin, {
    originalname: "虚构生产合同模板.docx",
    mimetype: DOCX_MIME,
    buffer: await syntheticProductionTemplateBuffer()
  }, "VIRTUAL-CONTRACT-1.0");
  const template = await publishContractTemplate(base.db, { storagePath }, base.admin, uploaded.id);
  return { ...base, storagePath, customer, project, quote, template };
}

function contractInput(f, suffix, confirmed = true) {
  return {
    contractNumber: `HT-VIRTUAL-${suffix}`,
    customerId: f.customer.id,
    projectId: f.project.id,
    quoteVersionId: f.quote.id,
    templateId: f.template.id,
    contractAmountCents: f.quote.finalDiscountCents,
    signedLocation: "鹤壁",
    signedOn: "2026-08-25",
    signingNotes: "虚构签约备注：不改变报价范围和金额",
    partyA: {
      name: f.customer.fullName,
      licenseScope: f.customer.fullName,
      legalRepresentative: "",
      representative: "虚构甲方代表",
      zip: "000000",
      address: "虚构地址",
      phone: "000-00000000"
    },
    confirmations: Object.fromEntries(CONFIRMATION_FIELDS.map(field => [field, confirmed]))
  };
}

test("合同只取终审快照并由服务端锁定金额、大写与年度维护费", async () => {
  const f = await fixture();
  try {
    const input = contractInput(f, "LOCKED");
    const preflight = preflightContract(f.db, f.salesA, input);
    assert.equal(preflight.ok, true);
    assert.equal(preflight.expectedSubtotalCents, 12_720_000);
    assert.equal(preflight.expectedAmountCents, 12_600_000);
    assert.equal(preflight.expectedAmountUpper, "人民币壹拾贰万陆仟元整");
    assert.equal(preflight.maintenanceFeeCents, 1_260_000);
    assert.equal(preflight.maintenanceFeeUpper, "人民币壹万贰仟陆佰元整");
    assert.equal(chineseMoneyUpper(101), "人民币壹元零壹分");
    assert.equal(chineseMoneyUpper(1), "人民币零元零壹分");
    assert.equal(chineseMoneyUpper(1_640_902), "人民币壹万陆仟肆佰零玖元零贰分");

    const forged = preflightContract(f.db, f.salesA, { ...input, contractAmountCents: 1 });
    assert.equal(forged.ok, false);
    assert.ok(forged.issues.some(issue => issue.field === "contractAmountCents"));
    const contract = createContractDraft(f.db, f.salesA, { ...input, contractAmountCents: 1_000_000 });
    assert.fail(`伪造金额不应创建合同：${contract.id}`);
  } catch (error) {
    if (error?.code !== "CONTRACT_PREFLIGHT_FAILED") throw error;
  } finally {
    f.db.close();
    fs.rmSync(f.storagePath, { recursive: true, force: true });
  }
});

test("合同编号唯一，甲方与使用权范围一致，空签章字段也必须逐项确认后才能生成", async () => {
  const f = await fixture();
  try {
    const input = contractInput(f, "CONFIRM", false);
    const draft = createContractDraft(f.db, f.salesA, input);
    assert.equal(draft.status, "DRAFT");
    await assert.rejects(() => generateContractDocument(f.db, { storagePath: f.storagePath }, f.salesA, draft.id), error => error.code === "CONTRACT_CONFIRMATION_REQUIRED");
    assert.throws(() => createContractDraft(f.db, f.salesA, input), error => error.code === "CONTRACT_NUMBER_EXISTS");
    assert.throws(() => createContractDraft(f.db, f.salesA, { ...contractInput(f, "WRONG-PARTY"), partyA: { ...input.partyA, name: "虚构其他主体有限公司", licenseScope: "虚构其他主体有限公司" } }), error => error.code === "CONTRACT_PARTY_A_CUSTOMER_MISMATCH");
    assert.throws(() => createContractDraft(f.db, f.salesA, { ...contractInput(f, "WRONG-SCOPE"), partyA: { ...input.partyA, licenseScope: "虚构集团范围" } }), error => error.code === "CONTRACT_LICENSE_SCOPE_MISMATCH");
    assert.equal(__test.isValidCalendarDate("2024-02-29"), true);
    assert.equal(__test.isValidCalendarDate("2026-02-29"), false);
    assert.equal(__test.isValidCalendarDate("2026-99-99"), false);
    const localNow = new Date();
    assert.equal(__test.localCalendarDate(localNow), `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, "0")}-${String(localNow.getDate()).padStart(2, "0")}`);

    const invalidDate = createContractDraft(f.db, f.salesA, { ...contractInput(f, "BAD-DATE", true), signedOn: "2026-99-99" });
    await assert.rejects(() => generateContractDocument(f.db, { storagePath: f.storagePath }, f.salesA, invalidDate.id), error => error.code === "CONTRACT_SIGN_DATE_INVALID");
    const repaired = updateContractDraft(f.db, f.salesA, invalidDate.id, { signedOn: "2024-02-29", confirmations: Object.fromEntries(CONFIRMATION_FIELDS.map(field => [field, true])) });
    assert.equal(repaired.manual.signDate, "2024-02-29");
    assert.equal((await generateContractDocument(f.db, { storagePath: f.storagePath }, f.salesA, invalidDate.id)).status, "GENERATED");

    const ready = createContractDraft(f.db, f.salesA, contractInput(f, "READY", true));
    f.db.prepare(`UPDATE quote_items SET item_name = '被篡改的实时明细', taxed_amount_cents = 1 WHERE quote_version_id = ? AND line_no = 1`).run(f.quote.id);
    const generated = await generateContractDocument(f.db, { storagePath: f.storagePath }, f.salesA, ready.id);
    assert.equal(generated.status, "GENERATED");
    assert.equal(generated.files.length, 1);
    assert.equal(generated.files[0].category, "SYSTEM_GENERATED");
    assert.equal(generated.quoteReference.quoteNumber, f.quote.quoteNumber);
    assert.equal(generated.quoteReference.versionLabel, "V1.0");
    assert.equal(generated.quoteReference.approvals.map(item => item.stage).join(","), "MANAGER,GENERAL_MANAGER,VP");
    assert.ok(generated.quoteReference.approvedAt);
    assert.match(f.db.prepare(`SELECT storage_key FROM contract_files WHERE id = ?`).get(generated.files[0].id).storage_key, /^contracts\/[0-9a-f-]+\.docx$/);
    const file = getContractFileDownload(f.db, { storagePath: f.storagePath }, f.salesA, generated.files[0].id);
    const zip = await JSZip.loadAsync(fs.readFileSync(file.absolutePath));
    const xml = await zip.file("word/document.xml").async("string");
    assert.match(xml, /虚构生产执行模块/);
    assert.doesNotMatch(xml, /被篡改的实时明细/);
    assert.match(xml, /¥126,000\.00/);
    assert.match(xml, /人民币壹拾贰万陆仟元整/);
    assert.match(xml, /¥12,600\.00/);
    assert.match(xml, /附件明细原含税合计：¥127,200\.00/);
    await assert.rejects(() => generateContractDocument(f.db, { storagePath: f.storagePath }, f.salesA, ready.id), error => error.code === "CONTRACT_NOT_DRAFT");
    assert.throws(() => getContract(f.db, f.salesOther, ready.id), error => error.code === "CONTRACT_NOT_FOUND");
    assert.throws(() => getContractFileDownload(f.db, { storagePath: f.storagePath }, f.salesOther, generated.files[0].id), error => error.code === "CONTRACT_NOT_FOUND");
    assert.equal(getContract(f.db, f.manager, ready.id).id, ready.id);
    const snapshotRow = f.db.prepare(`SELECT generation_snapshot_json, generation_snapshot_hash FROM contracts WHERE id = ?`).get(ready.id);
    assert.equal(sha256(snapshotRow.generation_snapshot_json), snapshotRow.generation_snapshot_hash);
    const generationSnapshot = JSON.parse(snapshotRow.generation_snapshot_json);
    assert.equal(generationSnapshot.locked.finalDiscountCents, 12_600_000);
    assert.equal(generationSnapshot.locked.maintenanceFeeCents, 1_260_000);
    assert.equal(generationSnapshot.confirmations.partyALegalRepresentative, true);
    assert.equal(generationSnapshot.signingNotes.value, "虚构签约备注：不改变报价范围和金额");
    assert.equal(generationSnapshot.signingNotes.updatedBy.id, f.salesA.id);
    assert.equal(generationSnapshot.quoteReference.quoteNumber, f.quote.quoteNumber);
    const processUpdated = updateSigningNotes(f.db, f.salesA, ready.id, "虚构生成后过程备注");
    assert.equal(processUpdated.signingNotes.value, "虚构生成后过程备注");
    assert.equal(processUpdated.generationSigningNotes.value, "虚构签约备注：不改变报价范围和金额");
    const concurrentDraft = createContractDraft(f.db, f.salesA, contractInput(f, "CONCURRENT", true));
    const beforeFiles = fs.readdirSync(path.join(f.storagePath, "contracts")).length;
    const repeated = await Promise.allSettled([
      generateContractDocument(f.db, { storagePath: f.storagePath }, f.salesA, concurrentDraft.id),
      generateContractDocument(f.db, { storagePath: f.storagePath }, f.salesA, concurrentDraft.id)
    ]);
    assert.equal(repeated.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(repeated.filter(item => item.status === "rejected").length, 1);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM contract_files WHERE contract_id = ? AND category = 'SYSTEM_GENERATED'`).get(concurrentDraft.id).count, 1);
    assert.equal(fs.readdirSync(path.join(f.storagePath, "contracts")).length, beforeFiles + 1);
  } finally {
    f.db.close();
    fs.rmSync(f.storagePath, { recursive: true, force: true });
  }
});

test("生成时重新读取终审快照并拒绝异构正文报价", async () => {
  const f = await fixture();
  try {
    const draft = createContractDraft(f.db, f.salesA, contractInput(f, "RECHECK-HETERO", true));
    const quoteRow = f.db.prepare(`SELECT snapshot_json FROM quote_versions WHERE id = ?`).get(f.quote.id);
    const content = JSON.parse(quoteRow.snapshot_json);
    content.items[1].unit = "项";
    const contentJson = JSON.stringify(content);
    f.db.prepare(`UPDATE quote_versions SET snapshot_json = ?, snapshot_hash = ? WHERE id = ?`).run(contentJson, sha256(contentJson), f.quote.id);
    const approvalRow = f.db.prepare(`
      SELECT qas.id, qas.snapshot_json
      FROM quote_approval_snapshots qas
      JOIN quote_approvals qa ON qa.id = qas.approval_id
      WHERE qas.quote_version_id = ? AND qa.stage = 'VP'
    `).get(f.quote.id);
    const approval = JSON.parse(approvalRow.snapshot_json);
    approval.content = content;
    const approvalJson = JSON.stringify(approval);
    f.db.prepare(`UPDATE quote_approval_snapshots SET snapshot_json = ?, snapshot_hash = ? WHERE id = ?`).run(approvalJson, sha256(approvalJson), approvalRow.id);

    await assert.rejects(
      () => generateContractDocument(f.db, { storagePath: f.storagePath }, f.salesA, draft.id),
      error => error.code === "CONTRACT_BODY_PRICE_TABLE_HETEROGENEOUS" && error.message.includes("支持正文多行价格表")
    );
    assert.equal(getContract(f.db, f.salesA, draft.id).status, "DRAFT");
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM contract_files WHERE contract_id = ?`).get(draft.id).count, 0);
  } finally {
    f.db.close();
    fs.rmSync(f.storagePath, { recursive: true, force: true });
  }
});

test("系统原始版、外部修改版和最终签订版分别归档，关键范围变化禁止标记最终版", async () => {
  const f = await fixture();
  try {
    const draft = createContractDraft(f.db, f.salesA, contractInput(f, "ARCHIVE", true));
    const generated = await generateContractDocument(f.db, { storagePath: f.storagePath }, f.salesA, draft.id);
    const originalDownload = getContractFileDownload(f.db, { storagePath: f.storagePath }, f.salesA, generated.files[0].id);
    const editedBuffer = fs.readFileSync(originalDownload.absolutePath);
    const edited = archiveContractFile(f.db, { storagePath: f.storagePath }, f.salesA, draft.id, "WORD_EDITED", {
      originalname: "虚构外部修改版.docx", mimetype: DOCX_MIME, buffer: editedBuffer
    }, { amount: false, scope: true, quantity: false, unitPrice: false, taxRate: false, confirmed: true, note: "虚构范围修改声明" });
    assert.equal(edited.status, "SIGNING");
    assert.equal(edited.files.at(-1).declaredScopeChanged, true);

    assert.throws(() => archiveContractFile(f.db, { storagePath: f.storagePath }, f.salesA, draft.id, "FINAL_SIGNED", {
      originalname: "虚构禁止最终版.pdf", mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.7\nvirtual")
    }, { amount: true, scope: false, quantity: false, unitPrice: false, taxRate: false, confirmed: true }), error => error.code === "CONTRACT_FINAL_SCOPE_CHANGED");

    assert.throws(() => archiveContractFile(f.db, { storagePath: f.storagePath }, f.salesA, draft.id, "FINAL_SIGNED", {
      originalname: "虚构最终签订版.pdf", mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.7\nvirtual-signed")
    }, { amount: false, scope: false, quantity: false, unitPrice: false, taxRate: false, confirmed: true, note: "试图以本次无变化声明绕过历史变化" }), error => error.code === "CONTRACT_HISTORY_SCOPE_CHANGED");
    assert.equal(getContract(f.db, f.salesA, draft.id).status, "SIGNING");

    const cleanDraft = createContractDraft(f.db, f.salesA, contractInput(f, "CLEAN-ARCHIVE", true));
    const cleanGenerated = await generateContractDocument(f.db, { storagePath: f.storagePath }, f.salesA, cleanDraft.id);
    const cleanOriginal = getContractFileDownload(f.db, { storagePath: f.storagePath }, f.salesA, cleanGenerated.files[0].id);
    archiveContractFile(f.db, { storagePath: f.storagePath }, f.salesA, cleanDraft.id, "WORD_EDITED", {
      originalname: "虚构无关键变化修改版.docx", mimetype: DOCX_MIME, buffer: fs.readFileSync(cleanOriginal.absolutePath)
    }, { amount: false, scope: false, quantity: false, unitPrice: false, taxRate: false, confirmed: true });
    const signed = archiveContractFile(f.db, { storagePath: f.storagePath }, f.salesA, cleanDraft.id, "FINAL_SIGNED", {
      originalname: "虚构最终签订版.pdf", mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.7\nvirtual-signed")
    }, { amount: false, scope: false, quantity: false, unitPrice: false, taxRate: false, confirmed: true, note: "逐项确认当前及历史均未改变关键字段" });
    assert.equal(signed.status, "SIGNED");
    assert.deepEqual(signed.files.map(file => file.category), ["SYSTEM_GENERATED", "WORD_EDITED", "FINAL_SIGNED"]);
    assert.equal(signed.customerStatusSuggestion?.requiresConfirmation, true);
    assert.equal(f.db.prepare(`SELECT status FROM customers WHERE id = ?`).get(f.customer.id).status, "初期接洽");
    assert.throws(() => confirmSignedContractCustomerStatus(f.db, f.salesA, cleanDraft.id), error => error.code === "CONTRACT_CUSTOMER_STATUS_CONFIRMATION_REQUIRED");
    const confirmedStatus = confirmSignedContractCustomerStatus(f.db, f.salesA, cleanDraft.id, { confirmed: true });
    assert.equal(confirmedStatus.customerStatusSuggestion, null);
    assert.equal(f.db.prepare(`SELECT status FROM customers WHERE id = ?`).get(f.customer.id).status, "合同签订完成");
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'CONTRACT_CUSTOMER_STATUS_CONFIRMED' AND entity_id = ?`).get(cleanDraft.id).count, 1);
    confirmSignedContractCustomerStatus(f.db, f.salesA, cleanDraft.id, { confirmed: true });
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'CONTRACT_CUSTOMER_STATUS_CONFIRMED' AND entity_id = ?`).get(cleanDraft.id).count, 1);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type = 'CONTRACT' AND entity_id = ?`).get(draft.id).count >= 3, true);
  } finally {
    f.db.close();
    fs.rmSync(f.storagePath, { recursive: true, force: true });
  }
});

test("合同接口支持草稿补录、生成和权限受控下载", async () => {
  const f = await fixture();
  let server;
  try {
    const password = `${randomBytes(18).toString("base64url")}aA1!`;
    resetUserPassword(f.db, f.admin, f.salesA.id, password);
    const session = completeResetLogin(f.db, f.salesA.username, password);
    server = createApp({ db: f.db, config: { storagePath: f.storagePath, sessionHours: 1, secureCookie: false } }).listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { cookie: `hh_session=${session.token}`, "x-csrf-token": session.csrfToken, "content-type": "application/json" };
    const input = contractInput(f, "API", false);
    const createdResponse = await fetch(`${base}/api/contracts`, { method: "POST", headers, body: JSON.stringify(input) });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.status, "DRAFT");

    const patchResponse = await fetch(`${base}/api/contracts/${created.id}`, { method: "PATCH", headers, body: JSON.stringify({ confirmations: Object.fromEntries(CONFIRMATION_FIELDS.map(field => [field, true])) }) });
    assert.equal(patchResponse.status, 200);
    assert.equal((await patchResponse.json()).confirmations.partyAName, true);
    const generatedResponse = await fetch(`${base}/api/contracts/${created.id}/generate`, { method: "POST", headers, body: "{}" });
    assert.equal(generatedResponse.status, 201);
    const generated = await generatedResponse.json();
    assert.equal(generated.status, "GENERATED");
    const download = await fetch(`${base}/api/contract-files/${generated.files[0].id}/download`, { headers: { cookie: `hh_session=${session.token}` } });
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition"), /attachment/i);
    assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 2).toString("ascii"), "PK");

    const otherPassword = `${randomBytes(18).toString("base64url")}aA1!`;
    resetUserPassword(f.db, f.admin, f.salesOther.id, otherPassword);
    const otherSession = completeResetLogin(f.db, f.salesOther.username, otherPassword);
    const forbidden = await fetch(`${base}/api/contract-files/${generated.files[0].id}/download`, { headers: { cookie: `hh_session=${otherSession.token}` } });
    assert.equal(forbidden.status, 404);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    f.db.close();
    fs.rmSync(f.storagePath, { recursive: true, force: true });
  }
});
