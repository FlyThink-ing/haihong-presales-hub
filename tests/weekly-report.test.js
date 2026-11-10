import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { setUserActive } from "../server/auth-service.js";
import { createCustomer, getCustomer, updateCustomer } from "../server/customer-service.js";
import { createDatabase } from "../server/database.js";
import { getFileForDownload } from "../server/file-service.js";
import { getImportJob, remapCustomerImport, uploadCustomerWorkbook } from "../server/import-service.js";
import { getWeeklyReportPreview, previewWeeklyReport } from "../server/weekly-report-service.js";
import { setupBase, startTestApi } from "./test-utils.js";

const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function weeklyWorkbook(customerA, customerB) {
  const workbook = new ExcelJS.Workbook();
  const information = workbook.addWorksheet("信息收集");
  information.addRow(["虚构结构测试，不含真实资料"]);
  information.addRow(["序号", "客户来源", "客户名称", "客户类型", "登记时间", "状态", "客户需求", "客户情况总结", "备注"]);
  const weekly = workbook.addWorksheet("周汇报");
  weekly.addRow(["虚构周汇报标题"]); // 标题单元格
  weekly.addRow(["", "2026-08-01"]); // 日期单元格分散在表头前
  weekly.addRow(["虚构阶段说明", "", "2026-08-02 虚构说明"]); // 日期与正文同格
  weekly.addRow(["序号", "日期", "客户名称", "内容", "金额（未税）", "备注", "补充日期"]); // 第4行表头
  weekly.addRow([1, new Date("2026-08-03T00:00:00Z"), customerA, "虚构完整客户活动", 12345.67, "虚构备注"]); // 完整行
  weekly.addRow([2, "", customerB, "虚构另一负责人内容", "", "未沟通"]); // 无日期客户行
  weekly.addRow(["", "", "", "", "", "", "2026-08-04"]); // 跨列单日期
  weekly.addRow(["", "", "", "", 8888]); // 仅金额
  weekly.addRow(["", "", `客户：${customerA}`, "虚构复合名称不匹配"]); // 复合客户文本
  weekly.addRow(["", "", "", { formula: "CONCAT(\"虚构\",\"公式\")", result: "虚构公式" }]); // 公式
  weekly.addRow(["", "", "", "虚构长文本".repeat(1_500)]); // 长文本
  weekly.addRow(["", "2026-08-05", "", "虚构跨列日期", "", "", "2026年8月6日"]); // 多日期候选
  weekly.addRow([]); // 真空行必须跳过
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function fileInput(buffer) {
  return { originalname: "虚构周汇报迁移.xlsx", mimetype: mimeType, buffer };
}

async function uploadHttp(api, actor, buffer) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), "virtual-weekly-report.xlsx");
  return api.request(actor, "/api/imports/customer/upload", "POST", form);
}

function linkDecision(entry, customerId, overrides = {}) {
  return {
    id: entry.id,
    action: "LINK_CUSTOMER",
    customerId,
    businessType: "虚构客户活动历史来源",
    dateHandling: "SOURCE_CELL",
    dateCellReference: entry.sourceCells.find(cell => cell.cellReference.startsWith("B"))?.cellReference,
    contentHandling: "SOURCE_CELLS",
    contentCellReferences: [entry.sourceCells.find(cell => cell.cellReference.startsWith("D"))?.cellReference].filter(Boolean),
    noBusinessRecordConfirmed: true,
    ...overrides
  };
}

function classifyDecision(entry, overrides = {}) {
  return {
    id: entry.id,
    action: "CLASSIFY_ONLY",
    businessType: "虚构待匹配历史来源",
    dateHandling: "NOT_RECORDED",
    contentHandling: "SOURCE_CELLS",
    contentCellReferences: [entry.sourceCells[0].cellReference],
    noBusinessRecordConfirmed: true,
    ...overrides
  };
}

test("周汇报至少八种非空行形态全部保留，精确客户候选按当前权限过滤且不猜邻接主体", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-weekly-preview-"));
  const config = { storagePath: root };
  try {
    const customerA = createCustomer(f.db, f.salesA, { fullName: "虚构周报客户甲有限公司", registeredOn: "2026-07-01", status: "初期接洽", needSummary: "虚构需求甲" });
    const customerB = createCustomer(f.db, f.salesB, { fullName: "虚构周报客户乙有限公司", registeredOn: "2026-07-02", status: "初期接洽", needSummary: "虚构需求乙" });
    const sameNameOther = createCustomer(f.db, f.admin, { fullName: customerA.fullName, ownerId: f.salesB.id, registeredOn: "2026-07-03", status: "初期接洽", needSummary: "虚构同名不同主体需求" }, { allowDuplicate: true, auditSource: "SYNTHETIC_TEST_SETUP" });
    const buffer = await weeklyWorkbook(customerA.fullName, customerB.fullName);
    const job = await uploadCustomerWorkbook(f.db, config, f.salesA, fileInput(buffer));
    assert.deepEqual(getWeeklyReportPreview(f.db, f.salesA, job.id).entries, []);
    const salesView = await previewWeeklyReport(f.db, config, f.salesA, job.id);
    assert.equal(salesView.entries.length, 1);
    assert.equal(salesView.entries[0].candidateCustomers[0].id, customerA.id);
    assert.deepEqual(salesView.entries[0].candidateCustomers[0].matchedCells, ["C5"]);
    assert.equal(salesView.entries[0].canConfirm, false);
    assert.ok(salesView.entries[0].issues.some(issue => issue.code === "WEEKLY_CUSTOMER_SCOPE_AMBIGUOUS"));
    const adminView = getWeeklyReportPreview(f.db, f.admin, job.id);
    assert.equal(adminView.entries.length, 12);
    assert.ok(adminView.entries.length >= 8);
    assert.deepEqual(adminView.entries.find(entry => entry.rowNumber === 5).candidateCustomers.map(item => item.id).sort(), [customerA.id, sameNameOther.id].sort());
    assert.equal(adminView.entries.find(entry => entry.rowNumber === 8).candidates.amountCells[0].rawText, "8888");
    assert.equal(adminView.entries.find(entry => entry.rowNumber === 9).candidateCustomers.length, 0);
    assert.equal(adminView.entries.find(entry => entry.rowNumber === 10).sourceCells[0].rawText, '=CONCAT("虚构","公式")');
    assert.ok(adminView.entries.find(entry => entry.rowNumber === 10).warnings.some(item => item.code === "FORMULA_REVIEW_REQUIRED:D10"));
    assert.equal(adminView.entries.find(entry => entry.rowNumber === 11).sourceCells[0].rawText, "虚构长文本".repeat(1_500));
    assert.deepEqual(adminView.entries.find(entry => entry.rowNumber === 12).candidates.dateCells.map(item => item.cellReference), ["B12", "G12"]);
    assert.equal(getWeeklyReportPreview(f.db, f.admin, job.id, { search: "8888" }).entries[0].rowNumber, 8);
    assert.throws(() => getWeeklyReportPreview(f.db, f.manager, job.id), error => error.code === "IMPORT_JOB_NOT_FOUND");
    assert.throws(() => getWeeklyReportPreview(f.db, f.vp, job.id), error => error.code === "IMPORT_JOB_NOT_FOUND");
    assert.throws(() => getFileForDownload(f.db, config, f.salesA, job.fileId), error => error.code === "FILE_NOT_FOUND");
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM weekly_report_entries WHERE job_id = ?`).get(job.id).n, 12);
    assert.equal(f.db.prepare(`SELECT previewed_by FROM weekly_report_entries WHERE job_id = ? LIMIT 1`).get(job.id).previewed_by, f.salesA.id);
  } finally { f.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("正式 HTTP 逐项确认只关联来源，金额永久隔离，部分失败可重试且转让后旧售前失权", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-weekly-http-"));
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA, f.salesB, f.manager, f.vp], { storagePath: root });
  try {
    const customerA = createCustomer(f.db, f.salesA, { fullName: "虚构周报关联客户甲有限公司", registeredOn: "2026-07-01", status: "初期接洽", needSummary: "虚构需求甲" });
    const customerB = createCustomer(f.db, f.salesB, { fullName: "虚构周报关联客户乙有限公司", registeredOn: "2026-07-02", status: "初期接洽", needSummary: "虚构需求乙" });
    const buffer = await weeklyWorkbook(customerA.fullName, customerB.fullName);
    const uploaded = await uploadHttp(api, f.salesA, buffer);
    assert.equal(uploaded.status, 201);
    const route = `/api/imports/customer/${uploaded.body.id}/weekly-report`;
    const preview = await api.request(f.salesA, `${route}/preview`, "POST", {});
    assert.equal(preview.status, 200);
    assert.equal(preview.body.entries.length, 1);
    const managerUpload = await uploadHttp(api, f.manager, buffer);
    const managerRoute = `/api/imports/customer/${managerUpload.body.id}/weekly-report`;
    const managerPreview = await api.request(f.manager, `${managerRoute}/preview`, "POST", {});
    assert.equal(managerPreview.status, 200);
    assert.equal(managerPreview.body.entries.length, 2);
    assert.ok(managerPreview.body.entries.every(item => item.canConfirm === false));
    assert.equal((await api.request(f.manager, `${managerRoute}/confirm`, "POST", { confirmed: true, entries: [] })).status, 403);
    assert.equal((await api.request(f.manager, route)).status, 404);
    assert.equal((await api.request(f.vp, route)).status, 404);
    const entry = preview.body.entries[0];
    const missingBoundary = await api.request(f.salesA, `${route}/confirm`, "POST", { confirmed: true, entries: [linkDecision(entry, customerA.id, { noBusinessRecordConfirmed: false })] });
    assert.equal(missingBoundary.body.results[0].code, "WEEKLY_NO_RECORD_CONFIRM_REQUIRED");
    const before = Object.fromEntries(["followups", "reminders", "quotes", "quote_versions", "contracts"].map(table => [table, f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
    const confirmed = await api.request(f.salesA, `${route}/confirm`, "POST", { confirmed: true, entries: [linkDecision(entry, customerA.id)] });
    assert.equal(confirmed.body.results[0].status, "CONFIRMED");
    assert.deepEqual(confirmed.body.results[0].createdBusinessRecords, []);
    assert.equal(confirmed.body.results[0].amountTransferred, false);
    const after = Object.fromEntries(Object.keys(before).map(table => [table, f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
    assert.deepEqual(after, before);
    const customer = getCustomer(f.db, f.salesA, customerA.id);
    assert.equal(customer.weeklyReportOrigins[0].sourceRowNumber, 5);
    assert.equal(customer.weeklyReportOrigins[0].decisions[0].amountTransferred, false);
    assert.equal(customer.weeklyReportOrigins[0].sourceCells.find(cell => cell.cellReference === "E5").rawText, "12345.67");
    updateCustomer(f.db, f.salesA, customerA.id, { fullName: "虚构周报关联客户甲更名有限公司" });
    const renamedEntry = (await api.request(f.salesA, route)).body.entries[0];
    assert.equal(renamedEntry.linkedCustomer.fullName, "虚构周报关联客户甲更名有限公司");
    const appendedDecision = await api.request(f.salesA, `${route}/confirm`, "POST", { confirmed: true, entries: [linkDecision(renamedEntry, customerA.id, { businessType: "虚构客户活动补充分类", dateHandling: "NOT_REQUIRED", dateCellReference: null, contentHandling: "NOT_REQUIRED", contentCellReferences: [] })] });
    assert.equal(appendedDecision.body.results[0].status, "CONFIRMED");
    assert.equal(getCustomer(f.db, f.salesA, customerA.id).weeklyReportOrigins[0].decisions.length, 2);
    await assert.rejects(remapCustomerImport(f.db, { storagePath: root }, f.salesA, uploaded.body.id, { sheetName: "信息收集", headerRow: 2, fieldMapping: uploaded.body.fieldMapping }), error => error.code === "IMPORT_PREVIEW_LOCKED");
    assert.equal(getImportJob(f.db, f.salesA, uploaded.body.id).mappingLocked, true);

    const adminView = (await api.request(f.admin, route)).body;
    const row7 = adminView.entries.find(item => item.rowNumber === 7);
    const row8 = adminView.entries.find(item => item.rowNumber === 8);
    const partial = await api.request(f.admin, `${route}/confirm`, "POST", { confirmed: true, entries: [
      classifyDecision(row7),
      classifyDecision(row8, { businessType: "", contentCellReferences: ["E8"] })
    ] });
    assert.deepEqual(partial.body.results.map(item => [item.status, item.code || null]), [["CONFIRMED", null], ["FAILED", "WEEKLY_BUSINESS_TYPE_REQUIRED"]]);
    const retry = await api.request(f.admin, `${route}/confirm`, "POST", { confirmed: true, entries: [classifyDecision(row8, { contentCellReferences: ["E8"] })] });
    assert.equal(retry.body.results[0].status, "CONFIRMED");
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM weekly_report_origins WHERE source_key IN (?, ?)`).get(row7.sourceKey, row8.sourceKey).n, 2);

    assert.equal((await api.request(f.admin, `/api/customers/${customerA.id}/transfer`, "POST", { newOwnerId: f.salesB.id, reason: "虚构周报来源转让" })).status, 200);
    assert.equal((await api.request(f.salesA, route)).status, 404);
    assert.equal((await api.request(f.salesA, `${route}/confirm`, "POST", { confirmed: true, entries: [linkDecision(entry, customerA.id)] })).status, 404);
    assert.throws(() => getFileForDownload(f.db, { storagePath: root }, f.salesA, uploaded.body.fileId), error => error.code === "FILE_NOT_FOUND");
    assert.equal(getCustomer(f.db, f.salesB, customerA.id).weeklyReportOrigins[0].sourceKey, entry.sourceKey);
  } finally { await api.close(); f.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("管理员未匹配分类、跨批重传和并发重复点击保持单一不可变来源，停用账号会失去正式 HTTP 会话", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-weekly-idempotent-"));
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA], { storagePath: root });
  try {
    const customerA = createCustomer(f.db, f.salesA, { fullName: "虚构周报幂等客户甲有限公司", registeredOn: "2026-07-01", status: "初期接洽", needSummary: "虚构需求甲" });
    const buffer = await weeklyWorkbook(customerA.fullName, "虚构周报幂等客户乙有限公司");
    const first = await uploadHttp(api, f.admin, buffer);
    const firstRoute = `/api/imports/customer/${first.body.id}/weekly-report`;
    const firstView = (await api.request(f.admin, `${firstRoute}/preview`, "POST", {})).body;
    const amountRow = firstView.entries.find(item => item.rowNumber === 8);
    const amountDecision = classifyDecision(amountRow, { businessType: "虚构金额原文，仅归档", contentCellReferences: ["E8"] });
    assert.equal((await api.request(f.admin, `${firstRoute}/confirm`, "POST", { confirmed: true, entries: [amountDecision] })).body.results[0].status, "CONFIRMED");

    const second = await uploadHttp(api, f.admin, buffer);
    const secondRoute = `/api/imports/customer/${second.body.id}/weekly-report`;
    const secondView = (await api.request(f.admin, `${secondRoute}/preview`, "POST", {})).body;
    const repeatedRow = secondView.entries.find(item => item.rowNumber === 8);
    assert.equal(repeatedRow.sourceKey, amountRow.sourceKey);
    assert.equal((await api.request(f.admin, `${secondRoute}/confirm`, "POST", { confirmed: true, entries: [{ ...amountDecision, id: repeatedRow.id }] })).body.results[0].status, "ALREADY_CONFIRMED");
    const formulaRow = secondView.entries.find(item => item.rowNumber === 10);
    const concurrentPayload = { confirmed: true, entries: [classifyDecision(formulaRow, { businessType: "虚构公式原文，仅归档", contentCellReferences: ["D10"] })] };
    const concurrent = await Promise.all([api.request(f.admin, `${secondRoute}/confirm`, "POST", concurrentPayload), api.request(f.admin, `${secondRoute}/confirm`, "POST", concurrentPayload)]);
    assert.deepEqual(concurrent.map(response => response.body.results[0].status).sort(), ["ALREADY_CONFIRMED", "CONFIRMED"]);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM weekly_report_origins WHERE source_key = ?`).get(formulaRow.sourceKey).n, 1);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM weekly_report_decisions WHERE source_key = ?`).get(formulaRow.sourceKey).n, 1);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM quotes`).get().n, 0);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM contracts`).get().n, 0);

    const salesUpload = await uploadHttp(api, f.salesA, buffer);
    const salesRoute = `/api/imports/customer/${salesUpload.body.id}/weekly-report`;
    assert.equal((await api.request(f.salesA, `${salesRoute}/preview`, "POST", {})).status, 200);
    setUserActive(f.db, f.admin, f.salesA.id, false);
    assert.equal((await api.request(f.salesA, salesRoute)).status, 401);
  } finally { await api.close(); f.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("旧数据库重复升级新增周汇报来源表且保留原业务数据", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-weekly-migration-"));
  const filename = path.join(root, "legacy.db");
  try {
    const customer = createCustomer(f.db, f.salesA, { fullName: "虚构周报旧库客户有限公司", registeredOn: "2026-07-01", status: "初期接洽", needSummary: "虚构旧库需求" });
    await f.db.backup(filename);
    f.db.close();
    const old = new Database(filename);
    old.exec(`DROP TABLE weekly_report_decisions; DROP TABLE weekly_report_origins; DROP TABLE weekly_report_entries;`);
    old.close();
    for (let index = 0; index < 2; index += 1) {
      const upgraded = createDatabase(filename);
      assert.ok(upgraded.prepare(`SELECT 1 FROM customers WHERE id = ?`).get(customer.id));
      for (const table of ["weekly_report_entries", "weekly_report_origins", "weekly_report_decisions"]) assert.equal(upgraded.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
      assert.deepEqual(upgraded.pragma("foreign_key_check"), []);
      upgraded.close();
    }
  } finally {
    try { f.db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
