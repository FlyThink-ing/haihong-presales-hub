import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { createApp } from "../server/app.js";
import { resetUserPassword } from "../server/auth-service.js";
import { createContact, createFollowup } from "../server/customer-activity-service.js";
import { getCustomerWorkspace } from "../server/customer-workspace-service.js";
import { createCustomerDictionaryOption } from "../server/customer-dictionary-service.js";
import { createCustomer, transferCustomer, updateCustomer } from "../server/customer-service.js";
import { createContractDraft, getContractFileDownload } from "../server/contract-service.js";
import { nowIso } from "../server/database.js";
import { getFileForDownload } from "../server/file-service.js";
import { getImportJobWithWorkbook, importCustomerBatch, uploadCustomerWorkbook } from "../server/import-service.js";
import { createQuote, decideQuote, getQuoteVersion, submitQuote } from "../server/quote-service.js";
import { createReminder } from "../server/reminder-service.js";
import { createSurvey } from "../server/survey-service.js";
import { addCustomerAndProject, sampleQuoteInput, setupBase } from "./test-utils.js";

function customerUpdateInput(customer, overrides = {}) {
  return {
    fullName: customer.fullName,
    shortName: customer.shortName,
    source: customer.source,
    customerType: customer.customerType,
    status: customer.status,
    needSummary: customer.needSummary,
    industry: customer.industry,
    province: customer.province,
    city: customer.city,
    district: customer.district,
    address: customer.address,
    longitude: customer.longitude,
    latitude: customer.latitude,
    summary: customer.summary,
    notes: customer.notes,
    ...overrides
  };
}

test("客户当前负责人和管理员可修改完整主档，状态及字段变更保留审计且重复保存不重复记账", () => {
  const { db, admin, manager, salesA, salesB } = setupBase();
  try {
    const customer = addCustomerAndProject(db, salesA, "主档编辑").customer;
    createCustomerDictionaryOption(db, admin, { kind: "SOURCE", value: "虚构内部推荐" });
    createCustomerDictionaryOption(db, admin, { kind: "TYPE", value: "虚构新客户" });
    assert.throws(() => updateCustomer(db, manager, customer.id, customerUpdateInput(customer, { status: "现场调研" })), error => error.code === "CUSTOMER_UPDATE_FORBIDDEN");
    const updated = updateCustomer(db, salesA, customer.id, customerUpdateInput(customer, {
      shortName: "虚构编辑客户",
      source: "虚构内部推荐",
      customerType: "虚构新客户",
      status: "现场调研",
      needSummary: "虚构的超长需求说明，用于验证客户详情长文本不会突破页面边界。".repeat(20),
      industry: "虚构制造业",
      district: "测试区",
      address: "测试省测试市测试区虚构道路 100 号",
      longitude: "114.31",
      latitude: "35.75",
      summary: "虚构客户情况总结",
      notes: "虚构备注"
    }));
    assert.equal(updated.status, "现场调研");
    assert.equal(updated.source, "虚构内部推荐");
    assert.equal(updated.longitude, 114.31);
    const logs = db.prepare(`SELECT action, summary_json FROM audit_logs WHERE entity_type = 'CUSTOMER' AND entity_id = ? AND action IN ('CUSTOMER_UPDATED','CUSTOMER_STATUS_CHANGED') ORDER BY created_at`).all(customer.id);
    assert.equal(logs.length, 2);
    assert.ok(JSON.parse(logs[0].summary_json).changedFields.includes("source"));
    assert.deepEqual(JSON.parse(logs[1].summary_json), { before: "初期接洽", after: "现场调研" });

    updateCustomer(db, salesA, customer.id, customerUpdateInput(updated));
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type = 'CUSTOMER' AND entity_id = ? AND action IN ('CUSTOMER_UPDATED','CUSTOMER_STATUS_CHANGED')`).get(customer.id).count, 2);
    assert.throws(() => updateCustomer(db, salesA, customer.id, customerUpdateInput(updated, { longitude: 181 })), error => error.code === "CUSTOMER_COORDINATE_INVALID");

    const sameName = addCustomerAndProject(db, salesB, "同名保护").customer;
    assert.throws(() => updateCustomer(db, admin, customer.id, customerUpdateInput(updated, { fullName: sameName.fullName })), error => error.code === "CUSTOMER_NAME_DUPLICATE");
  } finally {
    db.close();
  }
});

test("主档编辑保留历史未知日期，日期补录和修改留痕且不得清空已有日期", () => {
  const { db, salesA } = setupBase();
  try {
    const customer = createCustomer(db, salesA, {
      fullName: "虚构日期未知编辑客户", needSummary: "虚构历史需求", status: "初期接洽"
    }, { allowUnknownRegisteredOn: true, auditSource: "IMPORT" });
    assert.equal(updateCustomer(db, salesA, customer.id, { notes: "虚构补充备注", registeredOn: "" }).registeredOn, null);
    assert.throws(() => updateCustomer(db, salesA, customer.id, { registeredOn: "2026-02-29" }), error => error.code === "CUSTOMER_REGISTERED_ON_INVALID");
    assert.equal(updateCustomer(db, salesA, customer.id, { registeredOn: "2024-02-29" }).registeredOn, "2024-02-29");
    assert.throws(() => updateCustomer(db, salesA, customer.id, { registeredOn: null }), error => error.code === "CUSTOMER_REGISTERED_ON_REQUIRED");
    assert.equal(updateCustomer(db, salesA, customer.id, { registeredOn: "2024-03-01" }).registeredOn, "2024-03-01");
    const logs = db.prepare(`SELECT action, summary_json FROM audit_logs WHERE entity_id = ? AND action LIKE 'CUSTOMER_REGISTERED_ON_%' ORDER BY created_at, rowid`).all(customer.id);
    assert.deepEqual(logs.map(log => log.action), ["CUSTOMER_REGISTERED_ON_SUPPLEMENTED", "CUSTOMER_REGISTERED_ON_CHANGED"]);
    assert.deepEqual(JSON.parse(logs[0].summary_json), { before: null, after: "2024-02-29" });
    assert.deepEqual(JSON.parse(logs[1].summary_json), { before: "2024-02-29", after: "2024-03-01" });
  } finally {
    db.close();
  }
});

test("客户工作区正式 HTTP 接口覆盖四角色、空态、跟进纠错失败恢复及领导指派", async t => {
    const { db, admin, manager, generalManager, vp, salesA, salesB } = setupBase();
  const { customer } = addCustomerAndProject(db, salesA, "HTTP聚合验收");
  const server = createApp({ db, config: { sessionHours: 12, secureCookie: false } }).listen(0, "127.0.0.1");
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function signIn(actor) {
    const password = `${randomBytes(18).toString("base64url")}aA1!`;
    resetUserPassword(db, admin, actor.id, password);
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: actor.username, password })
    });
    assert.equal(response.status, 200);
    const session = await response.json();
    const changed = await fetch(`${base}/api/auth/change-password`, {
      method: "POST", headers: { cookie: response.headers.get("set-cookie").split(";")[0], "x-csrf-token": session.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: password, newPassword: `${randomBytes(18).toString("base64url")}aA1!` })
    });
    assert.equal(changed.status, 200);
    const changedSession = await changed.json();
    return { cookie: changed.headers.get("set-cookie").split(";")[0], "x-csrf-token": changedSession.csrfToken, "content-type": "application/json" };
  }
  const headers = {};
  for (const actor of [admin, manager, vp, salesA, salesB]) headers[actor.id] = await signIn(actor);
  async function request(actor, route, method = "GET", body) {
    const response = await fetch(`${base}${route}`, { method, headers: headers[actor.id], ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  const workspaceUrl = `/api/customers/${customer.id}/workspace`;
  assert.equal((await fetch(`${base}${workspaceUrl}`)).status, 401);
  for (const actor of [admin, salesA, manager]) {
    const result = await request(actor, workspaceUrl);
    assert.equal(result.status, 200);
    assert.equal(result.body.permissions.canMaintainActivity, actor.role !== "MANAGER");
    for (const key of ["contacts", "followups", "reminders", "surveys", "quotes", "contracts", "files"]) assert.deepEqual(result.body[key], []);
  }
  assert.equal((await request(salesB, workspaceUrl)).status, 404);
  const vpDirectory = await request(vp, workspaceUrl);
  assert.equal(vpDirectory.status, 200);
  assert.equal(vpDirectory.body.directoryOnly, true);
  assert.equal(vpDirectory.body.customer.id, customer.id);
  assert.equal("followups" in vpDirectory.body, false);
  assert.deepEqual((await request(vp, "/api/customers")).body.items.map(item => item.id), [customer.id]);
  assert.equal((await request(manager, `/api/customers/${customer.id}`, "PATCH", { notes: "不可写入" })).status, 403);
  const followup = await request(salesA, `/api/customers/${customer.id}/followups`, "POST", {
    method: "MEETING", occurredAt: "2026-08-27T01:00:00.000Z", content: "虚构原始跟进", nextAction: "虚构下一步"
  });
  assert.equal(followup.status, 201);
  const followupUrl = `/api/followups/${followup.body.followup.id}`;
  const missingReason = await request(salesA, followupUrl, "PATCH", { content: "虚构纠正内容" });
  assert.equal(missingReason.status, 400);
  assert.equal(missingReason.body.error.code, "FOLLOWUP_CHANGE_REASON_REQUIRED");
  const corrected = await request(salesA, followupUrl, "PATCH", { content: "虚构纠正后的长文本。".repeat(100), changeReason: "虚构记录校正" });
  assert.equal(corrected.status, 200);
  assert.equal((await request(manager, followupUrl, "PATCH", { content: "不应保存", changeReason: "无权修改" })).status, 403);
  const reminder = await request(manager, "/api/reminders", "POST", {
    customerId: customer.id, assigneeId: salesA.id, title: "虚构领导指派", remindAt: "2026-09-01T01:00:00.000Z"
  });
  assert.equal(reminder.status, 201);
  assert.equal(reminder.body.source, "LEADER");
  const updated = await request(salesA, workspaceUrl);
  assert.equal(updated.body.followups[0].content, corrected.body.content);
  assert.equal(updated.body.reminders[0].id, reminder.body.id);
  assert.ok(updated.body.auditLogs.some(log => log.action === "FOLLOWUP_UPDATED"));
  assert.ok(updated.body.auditLogs.some(log => log.action === "REMINDER_ASSIGNED"));
});

test("客户工作区按原权限汇聚八区域，跨范围领导仅查看基础档案与报价", () => {
  const { db, admin, manager, generalManager, vp, salesA, salesB, salesOther } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "八区汇聚");
    const unrelated = addCustomerAndProject(db, salesOther, "不可混入");
    createContact(db, salesA, customer.id, { name: "虚构汇聚联系人", department: "虚构部门", notes: "仅用于测试" });
    createContact(db, salesOther, unrelated.customer.id, { name: "虚构无关联系人" });
    createFollowup(db, salesA, customer.id, {
      method: "MEETING",
      occurredAt: "2026-08-27T01:00:00.000Z",
      projectId: project.id,
      content: "虚构客户汇聚跟进长文本。".repeat(30),
      nextAction: "虚构下一步"
    });
    createReminder(db, manager, {
      customerId: customer.id,
      assigneeId: salesA.id,
      title: "虚构领导指派提醒",
      remindAt: "2026-09-01T01:00:00.000Z",
      priority: "HIGH"
    });
    const template = db.prepare(`SELECT id FROM survey_templates WHERE is_active = 1 ORDER BY code LIMIT 1`).get();
    const survey = createSurvey(db, salesA, {
      customerId: customer.id,
      projectId: project.id,
      templateId: template.id,
      title: "虚构客户软件调研"
    });
    const quote = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "WORKSPACE"));
    submitQuote(db, salesA, quote.id);
    decideQuote(db, manager, quote.id, { decision: "APPROVED", comment: "虚构一级审批通过" });
    decideQuote(db, generalManager, quote.id, { decision: "APPROVED", comment: "虚构综合部审批通过" });
    decideQuote(db, vp, quote.id, { decision: "APPROVED", comment: "虚构终审通过" });
    const approved = getQuoteVersion(db, salesA, quote.id);
    const contractTemplateId = randomUUID();
    db.prepare(`
      INSERT INTO contract_templates (id, version, original_name, storage_key, sha256, status, is_published, published_by, published_at)
      VALUES (?, ?, ?, ?, ?, 'PUBLISHED', 1, ?, ?)
    `).run(contractTemplateId, "VIRTUAL-WORKSPACE-1.0", "虚构工作区模板.docx", "templates/virtual-workspace.docx", "virtual-workspace-sha256", admin.id, nowIso());
    const contract = createContractDraft(db, salesA, {
      contractNumber: `HT-WORKSPACE-${randomUUID().slice(0, 8)}`,
      customerId: customer.id,
      projectId: project.id,
      quoteVersionId: approved.id,
      templateId: contractTemplateId,
      contractAmountCents: approved.finalDiscountCents,
      attachment: { subtotalCents: approved.subtotalTaxedCents, finalDiscountCents: approved.finalDiscountCents, items: approved.items },
      partyA: { name: customer.fullName, licenseScope: customer.fullName }
    });
    const surveyFileId = randomUUID();
    const quoteFileId = randomUUID();
    const contractFileId = randomUUID();
    const timestamp = nowIso();
    const insertStoredFile = db.prepare(`
      INSERT INTO stored_files (id, entity_type, entity_id, category, original_name, storage_key, mime_type, size_bytes, sha256, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 128, ?, ?, ?)
    `);
    insertStoredFile.run(surveyFileId, "SURVEY", survey.id, "SURVEY_REPORT_DOCX", "虚构调研报告.docx", `files/${surveyFileId}.docx`, "survey-file-sha256", salesA.id, timestamp);
    insertStoredFile.run(quoteFileId, "QUOTE_VERSION", approved.id, "APPROVED_QUOTE_DOCX", "虚构审批报价.docx", `files/${quoteFileId}.docx`, "quote-file-sha256", salesA.id, timestamp);
    db.prepare(`
      INSERT INTO contract_files (id, contract_id, category, original_name, storage_key, size_bytes, sha256, uploaded_by, created_at)
      VALUES (?, ?, 'SYSTEM_GENERATED', ?, ?, 256, ?, ?, ?)
    `).run(contractFileId, contract.id, "虚构系统生成合同.docx", `contracts/${contractFileId}.docx`, "contract-file-sha256", salesA.id, timestamp);
    db.prepare(`UPDATE contracts SET status = 'GENERATED', generated_at = ?, updated_at = ? WHERE id = ?`).run(timestamp, timestamp, contract.id);

    const own = getCustomerWorkspace(db, salesA, customer.id);
    assert.equal(own.projects.length, 1);
    assert.equal(own.contacts.length, 1);
    assert.equal(own.followups.length, 1);
    assert.equal(own.reminders.length, 1);
    assert.equal(own.surveys.length, 1);
    assert.equal(own.quotes.length, 1);
    assert.equal(own.contracts.length, 1);
    assert.equal(own.files.length, 3);
    assert.ok(own.auditLogs.some(item => item.action === "QUOTE_VP_APPROVED"));
    assert.ok(own.auditLogs.every(item => ![unrelated.customer.id, unrelated.project.id].includes(item.entityId)));
    assert.deepEqual(own.permissions, { canEditCustomer: true, canMaintainActivity: true, canSupplementRegisteredOn: false, canCreateReminder: true });

    const managed = getCustomerWorkspace(db, manager, customer.id);
    assert.equal(managed.contacts.length, 1);
    assert.equal(managed.permissions.canEditCustomer, false);
    assert.equal(managed.permissions.canMaintainActivity, false);
    assert.equal(managed.permissions.canCreateReminder, true);
    assert.equal(getCustomerWorkspace(db, admin, customer.id).files.length, 3);
    assert.throws(() => getCustomerWorkspace(db, salesOther, customer.id), error => error.code === "CUSTOMER_NOT_FOUND");
    const leadershipView = getCustomerWorkspace(db, vp, customer.id);
    assert.equal(leadershipView.directoryOnly, true);
    assert.equal(leadershipView.quotes.length, 1);
    for (const key of ["followups", "surveys", "reminders", "contracts", "files", "auditLogs"]) assert.ok(!(key in leadershipView));

    transferCustomer(db, manager, customer.id, { newOwnerId: salesB.id, reason: "虚构汇聚权限交接" });
    assert.throws(() => getCustomerWorkspace(db, salesA, customer.id), error => error.code === "CUSTOMER_NOT_FOUND");
    assert.throws(() => getFileForDownload(db, { storagePath: os.tmpdir() }, salesA, surveyFileId), error => error.code === "FILE_NOT_FOUND");
    assert.throws(() => getFileForDownload(db, { storagePath: os.tmpdir() }, salesA, quoteFileId), error => error.code === "FILE_NOT_FOUND");
    assert.throws(() => getContractFileDownload(db, { storagePath: os.tmpdir() }, salesA, contractFileId), error => error.code === "CONTRACT_NOT_FOUND");
    const transferred = getCustomerWorkspace(db, salesB, customer.id);
    assert.equal(transferred.files.length, 3);
    assert.ok(transferred.auditLogs.some(item => item.action === "CUSTOMER_TRANSFERRED"));
  } finally {
    db.close();
  }
});

test("合法强制导入的同名不同主体允许不改名维护，客户日志不泄露跨负责人整批导入信息", async () => {
  const { db, admin, salesA, salesOther } = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-workspace-import-"));
  try {
    const existing = createCustomer(db, salesA, { fullName: "虚构同名主体有限公司", registeredOn: "2026-08-01", status: "初期接洽", needSummary: "虚构既有主体需求" });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("虚构跨负责人批次");
    sheet.addRow(["客户名称", "登记时间", "状态", "客户需求"]);
    sheet.addRow([existing.fullName, "2026-08-02", "初期接洽", "虚构第二主体需求"]);
    sheet.addRow(["虚构其他负责人保密客户有限公司", "2026-08-03", "签订合同中", "虚构不可外泄需求"]);
    const preview = await uploadCustomerWorkbook(db, { storagePath }, admin, {
      originalname: "虚构跨负责人迁移.xlsx",
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(await workbook.xlsx.writeBuffer())
    });
    const forced = importCustomerBatch(db, admin, preview.id, {
      ownerId: salesA.id,
      rowNumbers: [2],
      duplicateActions: { 2: { action: "FORCE_CREATE", reason: "虚构同名不同主体", basisType: "ADDRESS", basis: "虚构独立地址二号" } }
    }).results[0];
    assert.equal(forced.disposition, "FORCED_CREATED");
    const other = importCustomerBatch(db, admin, preview.id, { ownerId: salesOther.id, rowNumbers: [3] }).results[0];
    assert.equal(other.status, "IMPORTED");
    const updated = updateCustomer(db, salesA, forced.customerId, { status: "现场调研", notes: "虚构同名主体维护备注" });
    assert.equal(updated.fullName, existing.fullName);
    assert.equal(updated.status, "现场调研");
    assert.equal(updated.notes, "虚构同名主体维护备注");
    assert.throws(() => updateCustomer(db, salesA, forced.customerId, { fullName: "虚构其他负责人保密客户有限公司" }), error => error.code === "CUSTOMER_NAME_DUPLICATE");
    assert.throws(() => createCustomer(db, salesA, { fullName: existing.fullName, registeredOn: "2026-08-04", status: "初期接洽", needSummary: "虚构重复创建" }), error => error.code === "CUSTOMER_NAME_DUPLICATE");
    await assert.rejects(() => getImportJobWithWorkbook(db, { storagePath }, salesA, preview.id), error => error.code === "IMPORT_JOB_NOT_FOUND");

    const workspace = getCustomerWorkspace(db, salesA, forced.customerId);
    assert.deepEqual(workspace.customer.importOrigins.map(origin => origin.sourceRowNumber), [2]);
    assert.ok(workspace.auditLogs.every(log => log.entityType !== "IMPORT_JOB"));
    assert.ok(workspace.files.every(file => file.entityType !== "IMPORT_JOB"));
    const serialized = JSON.stringify(workspace);
    assert.ok(!serialized.includes("虚构其他负责人保密客户有限公司"));
    assert.ok(!serialized.includes("虚构不可外泄需求"));
    assert.ok(!serialized.includes(salesOther.id));
    assert.ok(!serialized.includes("签订合同中"));
  } finally {
    db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test("客户工作区保留报价历史版本和对应审批日志", () => {
  const { db, manager, salesA } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "报价历史汇聚");
    const original = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "WORKSPACE-HISTORY"));
    submitQuote(db, salesA, original.id);
    const returned = decideQuote(db, manager, original.id, { decision: "REJECTED", comment: "虚构历史退回意见" });
    const workspace = getCustomerWorkspace(db, salesA, customer.id);
    assert.deepEqual(workspace.quotes.map(item => item.id), [returned.successorVersionId, original.id]);
    assert.ok(workspace.auditLogs.some(log => log.entityId === original.id && log.action === "QUOTE_MANAGER_REJECTED"));
    assert.ok(workspace.auditLogs.some(log => log.entityId === returned.successorVersionId && log.action === "QUOTE_SUCCESSOR_CREATED"));
  } finally {
    db.close();
  }
});

test("空客户工作区返回稳定空集合而不是缺失区域", () => {
  const { db, salesA } = setupBase();
  try {
    const customer = addCustomerAndProject(db, salesA, "空态").customer;
    db.prepare(`DELETE FROM projects WHERE customer_id = ?`).run(customer.id);
    const workspace = getCustomerWorkspace(db, salesA, customer.id);
    for (const key of ["projects", "contacts", "followups", "reminders", "surveys", "quotes", "contracts", "files", "auditLogs"]) assert.ok(Array.isArray(workspace[key]), key);
    assert.equal(workspace.contacts.length, 0);
    assert.equal(workspace.contracts.length, 0);
  } finally {
    db.close();
  }
});
