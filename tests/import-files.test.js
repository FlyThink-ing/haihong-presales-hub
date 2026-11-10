import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { createCustomer, supplementCustomerRegisteredOn } from "../server/customer-service.js";
import { getFileForDownload, validateUploadedFile } from "../server/file-service.js";
import { getImportJobWithWorkbook, importCustomerBatch, listImportFailures, remapCustomerImport, uploadCustomerWorkbook } from "../server/import-service.js";
import { setupBase } from "./test-utils.js";

async function anonymousWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("信息收集");
  sheet.addRow(["序号", "客户来源", "客户名称", "客户类型", "登记时间", "状态", "客户需求", "客户情况总结", "备注"]);
  sheet.addRow([1, "虚构渠道", "虚构待导入客户甲有限公司", "新客户", new Date("2026-08-01T00:00:00Z"), "初期接洽", "虚构需求甲", "虚构总结", ""]);
  sheet.addRow([2, "虚构渠道", "虚构既有客户有限公司", "老客户", "2026/08/02", "现场调研", "虚构需求乙", "", ""]);
  sheet.addRow([3, "虚构渠道", "虚构状态错误客户有限公司", "新客户", "2026-08-03", "签订合同中", "虚构需求丙", "", ""]);
  sheet.addRow([4, "虚构渠道", "虚构缺失需求客户有限公司", "新客户", "2026-08-04", "初期接洽", "", "", ""]);
  sheet.addRow([5, "虚构渠道", "虚构日期未知客户有限公司", "新客户", "", "初期接洽", "虚构未知日期需求", "", ""]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function unmappedWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("自定义字段");
  sheet.addRow(["企业", "日期", "阶段", "诉求"]);
  sheet.addRow(["虚构自定义映射客户有限公司", "2026-08-05", "初期接洽", "虚构自定义映射需求"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("历史 Excel 导入保留状态映射和缺失日期溯源，并支持同主体合并", async () => {
  const { db, salesA, salesB } = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "presales-import-"));
  const config = { storagePath };
  try {
    const existing = createCustomer(db, salesA, { fullName: "虚构既有客户有限公司", registeredOn: "2026-07-01", status: "初期接洽", needSummary: "虚构既有需求" });
    const buffer = await anonymousWorkbook();
    const preview = await uploadCustomerWorkbook(db, config, salesA, { originalname: "虚构历史客户.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
    const reopened = await getImportJobWithWorkbook(db, config, salesA, preview.id);
    assert.equal(reopened.workbook.headers.find(header => header.label === "客户名称").column, 3);
    assert.equal(preview.sheetName, "信息收集");
    assert.equal(preview.counts.valid, 3);
    assert.equal(preview.counts.duplicate, 1);
    assert.equal(preview.counts.failed, 1);
    const legacyRow = preview.rows.find(row => row.rowNumber === 4);
    assert.equal(legacyRow.normalized.originalStatus, "签订合同中");
    assert.equal(legacyRow.normalized.status, "报价完成&商务洽谈");
    assert.deepEqual(legacyRow.normalized.statusMapping, { from: "签订合同中", to: "报价完成&商务洽谈" });
    const imported = importCustomerBatch(db, salesA, preview.id, { ownerId: salesA.id, rowNumbers: [2, 4, 6] });
    assert.deepEqual(imported.results.map(item => item.status), ["IMPORTED", "IMPORTED", "IMPORTED"]);
    assert.equal(imported.job.counts.imported, 3);
    const legacyCustomer = db.prepare(`SELECT status FROM customers WHERE full_name = '虚构状态错误客户有限公司'`).get();
    assert.equal(legacyCustomer.status, "报价完成&商务洽谈");
    const legacyOrigin = db.prepare(`SELECT original_status, mapped_status FROM customer_import_origins WHERE source_row_number = 4`).get();
    assert.deepEqual(legacyOrigin, { original_status: "签订合同中", mapped_status: "报价完成&商务洽谈" });
    const unknownDateCustomer = db.prepare(`SELECT id, registered_on FROM customers WHERE full_name = '虚构日期未知客户有限公司'`).get();
    assert.equal(unknownDateCustomer.registered_on, null);
    const unknownOrigin = db.prepare(`SELECT original_registered_on, sheet_name, source_row_number, operated_by FROM customer_import_origins WHERE customer_id = ?`).get(unknownDateCustomer.id);
    assert.deepEqual(unknownOrigin, { original_registered_on: "", sheet_name: "信息收集", source_row_number: 6, operated_by: salesA.id });
    supplementCustomerRegisteredOn(db, salesA, unknownDateCustomer.id, { registeredOn: "2026-07-15" });
    assert.equal(db.prepare(`SELECT registered_on FROM customers WHERE id = ?`).get(unknownDateCustomer.id).registered_on, "2026-07-15");
    assert.equal(db.prepare(`SELECT action FROM audit_logs WHERE entity_id = ? AND action = 'CUSTOMER_REGISTERED_ON_SUPPLEMENTED'`).get(unknownDateCustomer.id).action, "CUSTOMER_REGISTERED_ON_SUPPLEMENTED");

    const merged = importCustomerBatch(db, salesA, preview.id, { ownerId: salesA.id, rowNumbers: [3], duplicateActions: { 3: { action: "MERGE", existingCustomerId: existing.id } } });
    assert.equal(merged.results[0].disposition, "MERGED");
    assert.equal(merged.results[0].customerId, existing.id);
    assert.equal(db.prepare(`SELECT disposition FROM customer_import_origins WHERE import_job_id = ? AND source_row_number = 3`).get(preview.id).disposition, "MERGED");
    const failures = listImportFailures(db, salesA, preview.id);
    assert.equal(failures.length, 1);
    assert.throws(() => getFileForDownload(db, config, salesB, preview.fileId), error => error.code === "FILE_NOT_FOUND");
    assert.equal(getFileForDownload(db, config, salesA, preview.fileId).sha256.length, 64);

    const awaitingMapping = await uploadCustomerWorkbook(db, config, salesA, { originalname: "虚构待映射.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await unmappedWorkbook() });
    assert.equal(awaitingMapping.status, "UPLOADED");
    assert.equal(awaitingMapping.counts.total, 0);
    const mapped = await remapCustomerImport(db, config, salesA, awaitingMapping.id, { sheetName: "自定义字段", headerRow: 1, fieldMapping: { fullName: 1, registeredOn: 2, status: 3, needSummary: 4 } });
    assert.equal(mapped.counts.valid, 1);
  } finally {
    db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test("同名客户默认阻止，只有管理员凭原因和主体区分依据可强制新建", async () => {
  const { db, admin, salesA } = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "presales-import-force-"));
  try {
    assert.throws(() => createCustomer(db, salesA, { fullName: "虚构缺少登记时间客户有限公司", status: "初期接洽", needSummary: "虚构需求" }), error => error.code === "CUSTOMER_REGISTERED_ON_REQUIRED");
    createCustomer(db, salesA, { fullName: "虚构既有客户有限公司", registeredOn: "2026-07-01", status: "初期接洽", needSummary: "虚构既有需求" });
    assert.throws(() => createCustomer(db, salesA, { fullName: "虚构既有客户有限公司", registeredOn: "2026-07-02", status: "初期接洽", needSummary: "虚构重复需求" }), error => error.code === "CUSTOMER_NAME_DUPLICATE");
    const preview = await uploadCustomerWorkbook(db, { storagePath }, salesA, { originalname: "虚构同名迁移.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await anonymousWorkbook() });
    const denied = importCustomerBatch(db, salesA, preview.id, { ownerId: salesA.id, rowNumbers: [3], duplicateActions: { 3: { action: "FORCE_CREATE", reason: "虚构同名不同主体", basisType: "ADDRESS", basis: "虚构测试地址二号" } } });
    assert.equal(denied.results[0].status, "DUPLICATE");
    assert.match(denied.results[0].message, /仅系统管理员/);
    const missingBasis = importCustomerBatch(db, admin, preview.id, { ownerId: salesA.id, rowNumbers: [3], duplicateActions: { 3: { action: "FORCE_CREATE", reason: "虚构同名不同主体", basisType: "", basis: "" } } });
    assert.equal(missingBasis.results[0].status, "DUPLICATE");
    assert.match(missingBasis.results[0].message, /区分依据/);
    const forced = importCustomerBatch(db, admin, preview.id, { ownerId: salesA.id, rowNumbers: [3], duplicateActions: { 3: { action: "FORCE_CREATE", reason: "虚构同名不同主体", basisType: "ADDRESS", basis: "虚构测试地址二号" } } });
    assert.equal(forced.results[0].disposition, "FORCED_CREATED");
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM customers WHERE full_name = '虚构既有客户有限公司'`).get().count, 2);
    const relation = db.prepare(`SELECT relation_type, reason, distinguishing_basis_type, distinguishing_basis FROM customer_duplicate_relations WHERE customer_id = ?`).get(forced.results[0].customerId);
    assert.deepEqual(relation, { relation_type: "SAME_NAME_DISTINCT", reason: "虚构同名不同主体", distinguishing_basis_type: "ADDRESS", distinguishing_basis: "虚构测试地址二号" });
  } finally {
    db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test("上传文件拒绝错误扩展名、错误签名和超出大小限制", () => {
  assert.throws(() => validateUploadedFile({ originalname: "伪装.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("not-a-zip") }, "SOURCE_XLSX"), error => error.code === "FILE_SIGNATURE_INVALID");
  assert.throws(() => validateUploadedFile({ originalname: "伪装.exe", mimetype: "application/octet-stream", buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]) }, "SOURCE_XLSX"), error => error.code === "FILE_EXTENSION_INVALID");
  assert.throws(() => validateUploadedFile({ originalname: "过大.xlsx", mimetype: "application/octet-stream", buffer: Buffer.alloc(8 * 1024 * 1024 + 1, 0) }, "SOURCE_XLSX"), error => error.code === "FILE_SIZE_INVALID");
});
