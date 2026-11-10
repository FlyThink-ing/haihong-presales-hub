import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { setUserActive } from "../server/auth-service.js";
import { createContact } from "../server/customer-activity-service.js";
import { createCustomer, getCustomer, transferCustomer, updateCustomer } from "../server/customer-service.js";
import { createDatabase } from "../server/database.js";
import { getFileForDownload } from "../server/file-service.js";
import { getImportJob, remapCustomerImport, uploadCustomerWorkbook } from "../server/import-service.js";
import { getMunichVisitPreview, previewMunichVisits } from "../server/visit-import-service.js";
import { MUNICH_VISIT_FIELDS } from "../server/visit-import-parser.js";
import { setupBase, startTestApi } from "./test-utils.js";

const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const headers = MUNICH_VISIT_FIELDS.map(field => field.label);

function visitRow(name, options = {}) {
  return [
    options.sequence ?? 1, name, options.intention ?? "A", options.industry ?? "虚构装备行业",
    options.needSummary ?? "虚构 MES 需求", options.contactName ?? "虚构联系人甲",
    options.registeredOn ?? new Date("2026-08-01T00:00:00Z"), options.salesText ?? "",
    options.notes ?? "虚构拜访来源备注", options.plannedVisitOn ?? "", options.visitStatus ?? "未沟通"
  ];
}

async function visitWorkbook(rows, { header = headers } = {}) {
  const workbook = new ExcelJS.Workbook();
  const information = workbook.addWorksheet("信息收集");
  information.addRow(["虚构结构测试，不含真实资料"]);
  information.addRow(["序号", "客户来源", "客户名称", "客户类型", "登记时间", "状态", "客户需求", "客户情况总结", "备注"]);
  const visits = workbook.addWorksheet("慕尼黑客户拜访记录");
  visits.addRow(["虚构拜访迁移测试"]);
  visits.addRow(header);
  for (const row of rows) visits.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function fileInput(buffer, name = "虚构拜访迁移.xlsx") {
  return { originalname: name, mimetype: mimeType, buffer };
}

async function uploadHttp(api, actor, buffer) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), "virtual-visits.xlsx");
  return api.request(actor, "/api/imports/customer/upload", "POST", form);
}

test("拜访来源候选按精确表头和当前客户权限展示，售前文本只作精确账号候选", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-visit-candidates-"));
  const config = { storagePath: root };
  try {
    const customer = createCustomer(f.db, f.salesA, { fullName: "虚构既有拜访客户有限公司", registeredOn: "2026-07-01", status: "初期接洽", needSummary: "不可覆盖的既有需求", notes: "不可覆盖的既有备注" });
    const contact = createContact(f.db, f.salesA, customer.id, { name: "虚构联系人甲" });
    const buffer = await visitWorkbook([
      visitRow(customer.fullName, { salesText: f.salesA.displayName, plannedVisitOn: "2026-08-08", visitStatus: "已拜访" }),
      visitRow("虚构无匹配拜访客户有限公司", { salesText: `${f.salesB.displayName}近似文本`, registeredOn: "2026-02-29", visitStatus: "线上沟通" }),
      [3, "", "C", "虚构行业", "", "", "", "", "保留无客户名整行", "", "未沟通"]
    ]);
    const job = await uploadCustomerWorkbook(f.db, config, f.salesA, fileInput(buffer));
    assert.deepEqual(getMunichVisitPreview(f.db, f.salesA, job.id).entries, []);
    const own = await previewMunichVisits(f.db, config, f.salesA, job.id);
    assert.equal(own.entries.length, 1);
    assert.equal(own.entries[0].candidateCustomers[0].id, customer.id);
    assert.deepEqual(own.entries[0].ownerCandidates, [{ id: f.salesA.id, username: f.salesA.username, displayName: f.salesA.displayName }]);
    assert.deepEqual(own.entries[0].contactCandidates[customer.id], [{ id: contact.id, name: contact.name }]);
    assert.equal(own.entries[0].source.意向, "A");
    assert.equal(own.entries[0].source.拜访状态, "已拜访");
    assert.equal(own.entries[0].normalized.plannedVisitOn, "2026-08-08");
    assert.deepEqual(own.entries[0].safeguards, { createsFollowup: false, createsReminder: false, mapsIntentionToStatus: false, mapsVisitStatusToStatus: false, plannedVisitIsActual: false });
    const adminView = getMunichVisitPreview(f.db, f.admin, job.id);
    assert.equal(adminView.entries.length, 3);
    assert.equal(adminView.entries[1].status, "REVIEW_REQUIRED");
    assert.ok(adminView.entries[1].issues.some(issue => issue.code === "REGISTERED_ON_INVALID"));
    assert.equal(adminView.entries[2].source.备注, "保留无客户名整行");
    assert.ok(adminView.entries[2].issues.some(issue => issue.code === "CUSTOMER_NAME_REQUIRED"));
    assert.equal(f.db.prepare(`SELECT previewed_by FROM visit_import_entries WHERE job_id = ? LIMIT 1`).get(job.id).previewed_by, f.salesA.id);
    assert.throws(() => getMunichVisitPreview(f.db, f.manager, job.id), error => error.code === "IMPORT_JOB_NOT_FOUND");
    assert.throws(() => getMunichVisitPreview(f.db, f.vp, job.id), error => error.code === "IMPORT_JOB_NOT_FOUND");
    const wrongHeader = await uploadCustomerWorkbook(f.db, config, f.admin, fileInput(await visitWorkbook([visitRow("虚构表头客户")], { header: headers.map(value => value === "计划拜访日期" ? "实际拜访日期" : value) }), "虚构错误表头.xlsx"));
    await assert.rejects(previewMunichVisits(f.db, config, f.admin, wrongHeader.id), error => error.code === "VISIT_HEADER_INVALID");
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM visit_import_entries WHERE job_id = ?`).get(wrongHeader.id).n, 0);
  } finally { f.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("正式 HTTP 合并逐字段保护既有值、联系人需人工匹配，转让后旧售前失去来源和下载权限", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-visit-merge-"));
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA, f.salesB, f.manager, f.vp], { storagePath: root });
  try {
    const customer = createCustomer(f.db, f.salesA, { fullName: "虚构合并拜访客户有限公司", registeredOn: "2026-07-01", status: "初期接洽", needSummary: "既有需求不得覆盖", notes: "既有备注不得覆盖" });
    const contact = createContact(f.db, f.salesA, customer.id, { name: "虚构联系人甲" });
    const buffer = await visitWorkbook([
      visitRow(customer.fullName, { industry: "虚构待补行业", needSummary: "来源候选需求", notes: "来源候选备注", salesText: f.salesA.displayName, plannedVisitOn: "2026-08-08", visitStatus: "线上沟通" }),
      visitRow("虚构无权行有限公司", { salesText: f.salesB.displayName })
    ]);
    const uploaded = await uploadHttp(api, f.salesA, buffer);
    assert.equal(uploaded.status, 201);
    const route = `/api/imports/customer/${uploaded.body.id}/munich-visits`;
    const preview = await api.request(f.salesA, `${route}/preview`, "POST", {});
    assert.equal(preview.status, 200);
    assert.equal(preview.body.entries.length, 1);
    assert.equal((await api.request(f.admin, route)).body.entries.length, 2);
    const managerUpload = await uploadHttp(api, f.manager, buffer);
    const managerRoute = `/api/imports/customer/${managerUpload.body.id}/munich-visits`;
    const managerPreview = await api.request(f.manager, `${managerRoute}/preview`, "POST", {});
    assert.equal(managerPreview.status, 200);
    assert.equal(managerPreview.body.entries.length, 1);
    assert.equal(managerPreview.body.entries[0].canConfirm, false);
    assert.equal((await api.request(f.manager, `${managerRoute}/confirm`, "POST", { confirmed: true, entries: [] })).status, 403);
    assert.equal((await api.request(f.manager, route)).status, 404);
    assert.equal((await api.request(f.vp, route)).status, 404);
    const entry = preview.body.entries[0];
    const common = { id: entry.id, action: "MERGE", customerId: customer.id, ownerId: f.salesA.id, fieldActions: { registeredOn: "APPLY", industry: "APPLY", needSummary: "APPLY", notes: "APPLY" } };
    const duplicate = await api.request(f.salesA, `${route}/confirm`, "POST", { confirmed: true, entries: [{ ...common, contact: { action: "CREATE" } }] });
    assert.equal(duplicate.body.results[0].code, "VISIT_CONTACT_DUPLICATE");
    assert.equal(f.db.prepare(`SELECT industry FROM customers WHERE id = ?`).get(customer.id).industry, null);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM visit_import_origins`).get().n, 0);
    const merged = await api.request(f.salesA, `${route}/confirm`, "POST", { confirmed: true, entries: [{ ...common, contact: { action: "MATCH_EXISTING", existingContactId: contact.id } }] });
    assert.equal(merged.body.results[0].status, "PROCESSED");
    assert.deepEqual(merged.body.results[0].appliedFields, ["industry"]);
    assert.deepEqual(merged.body.results[0].protectedFields.sort(), ["needSummary", "notes", "registeredOn"].sort());
    assert.equal(merged.body.results[0].contact.contactId, contact.id);
    const after = getCustomer(f.db, f.salesA, customer.id);
    assert.equal(after.industry, "虚构待补行业");
    assert.equal(after.needSummary, "既有需求不得覆盖");
    assert.equal(after.notes, "既有备注不得覆盖");
    assert.equal(after.registeredOn, "2026-07-01");
    assert.equal(after.visitImportOrigins[0].source.计划拜访日期, "2026-08-08");
    assert.equal(after.visitImportOrigins[0].source.拜访状态, "线上沟通");
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE customer_id = ?`).get(customer.id).n, 1);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM followups`).get().n, 0);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM reminders`).get().n, 0);
    updateCustomer(f.db, f.salesA, customer.id, { fullName: "虚构合并后更名客户有限公司" });
    const renamedSource = getMunichVisitPreview(f.db, f.salesA, uploaded.body.id).entries[0];
    assert.equal(renamedSource.boundCustomer.fullName, "虚构合并后更名客户有限公司");
    assert.deepEqual(renamedSource.contactCandidates[customer.id], [{ id: contact.id, name: contact.name }]);
    await assert.rejects(remapCustomerImport(f.db, { storagePath: root }, f.salesA, uploaded.body.id, { sheetName: "信息收集", headerRow: 2, fieldMapping: uploaded.body.fieldMapping }), error => error.code === "IMPORT_PREVIEW_LOCKED");
    assert.equal(getImportJob(f.db, f.salesA, uploaded.body.id).mappingLocked, true);
    assert.throws(() => getFileForDownload(f.db, { storagePath: root }, f.salesA, uploaded.body.fileId), error => error.code === "FILE_NOT_FOUND");
    assert.equal((await api.request(f.admin, `/api/customers/${customer.id}/transfer`, "POST", { newOwnerId: f.salesB.id, reason: "虚构拜访来源转让" })).status, 200);
    assert.equal((await api.request(f.salesA, route)).status, 404);
    assert.equal((await api.request(f.salesA, `${route}/confirm`, "POST", { confirmed: true, entries: [common] })).status, 404);
    assert.throws(() => getFileForDownload(f.db, { storagePath: root }, f.salesA, uploaded.body.fileId), error => error.code === "FILE_NOT_FOUND");
    assert.equal(getCustomer(f.db, f.salesB, customer.id).visitImportOrigins[0].sourceKey, entry.sourceKey);
  } finally { await api.close(); f.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("管理员人工新建状态/负责人、同名强制规则、七条计划日期及三种拜访状态均不生成跟进提醒", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-visit-admin-"));
  const api = await startTestApi(f.db, f.admin, [f.admin], { storagePath: root });
  try {
    const statuses = ["线上沟通", "未沟通", "已拜访", "线上沟通", "未沟通", "已拜访", "线上沟通"];
    const rows = statuses.map((visitStatus, index) => visitRow(`虚构计划客户${index + 1}有限公司`, { sequence: index + 1, intention: ["A", "B", "C", "D"][index % 4], salesText: f.salesA.displayName, plannedVisitOn: `2026-08-${String(index + 10).padStart(2, "0")}`, visitStatus }));
    rows.push(visitRow("虚构分批客户有限公司", { sequence: 8, salesText: f.salesA.username }));
    const duplicateCustomer = createCustomer(f.db, f.salesA, { fullName: "虚构同名拜访客户有限公司", registeredOn: "2026-07-01", status: "初期接洽", needSummary: "既有同名需求" });
    createCustomer(f.db, f.admin, { fullName: duplicateCustomer.fullName, ownerId: f.salesB.id, registeredOn: "2026-07-02", status: "初期接洽", needSummary: "虚构另一主体需求" }, { allowDuplicate: true, auditSource: "SYNTHETIC_TEST_SETUP" });
    rows.push(visitRow(duplicateCustomer.fullName, { sequence: 9, salesText: f.salesA.displayName }));
    rows.push(visitRow("虚构并发客户有限公司", { sequence: 10, salesText: "不存在的近似售前", notes: "" }));
    const buffer = await visitWorkbook(rows);
    const uploaded = await uploadHttp(api, f.admin, buffer);
    const route = `/api/imports/customer/${uploaded.body.id}/munich-visits`;
    const preview = await api.request(f.admin, `${route}/preview`, "POST", {});
    assert.equal(preview.status, 200);
    assert.equal(preview.body.entries.length, 10);
    assert.equal(preview.body.entries[8].candidateCustomers.length, 2);
    assert.deepEqual(preview.body.entries.slice(0, 7).map(row => row.normalized.plannedVisitOn), ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"]);
    assert.deepEqual(preview.body.entries.slice(0, 7).map(row => row.normalized.visitStatus), statuses);
    assert.equal(preview.body.entries[9].ownerCandidates.length, 0);
    const first = preview.body.entries[0];
    const missingStatus = await api.request(f.admin, `${route}/confirm`, "POST", { confirmed: true, entries: [{ id: first.id, action: "CREATE", ownerId: f.salesA.id, fieldActions: { needSummary: "APPLY" } }] });
    assert.equal(missingStatus.body.results[0].code, "VISIT_CUSTOMER_STATUS_REQUIRED");
    setUserActive(f.db, f.admin, f.salesB.id, false);
    const inactiveOwner = await api.request(f.admin, `${route}/confirm`, "POST", { confirmed: true, entries: [{ id: first.id, action: "CREATE", ownerId: f.salesB.id, customerStatus: "初期接洽", fieldActions: { needSummary: "APPLY" } }] });
    assert.equal(inactiveOwner.body.results[0].code, "OWNER_INVALID");
    const newRequests = preview.body.entries.slice(0, 7).map(row => ({
      id: row.id, action: "CREATE", ownerId: f.salesA.id, customerStatus: "现场调研",
      fieldActions: { registeredOn: "APPLY", industry: "APPLY", needSummary: "APPLY", notes: "SKIP" }, contact: { action: "SKIP" }
    }));
    const created = await api.request(f.admin, `${route}/confirm`, "POST", { confirmed: true, entries: newRequests });
    assert.ok(created.body.results.every(row => row.status === "PROCESSED"));
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE status = '现场调研' AND full_name LIKE '虚构计划客户%'`).get().n, 7);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM followups`).get().n, 0);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM reminders`).get().n, 0);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM visit_import_origins WHERE normalized_json LIKE '%plannedVisitOn%'`).get().n, 7);

    const partialEntry = preview.body.entries[7];
    const duplicateEntry = preview.body.entries[8];
    const partial = await api.request(f.admin, `${route}/confirm`, "POST", { confirmed: true, entries: [
      { id: partialEntry.id, action: "CREATE", ownerId: f.salesA.id, customerStatus: "初期接洽", fieldActions: { needSummary: "APPLY" }, contact: { action: "SKIP" } },
      { id: duplicateEntry.id, action: "FORCE_CREATE", ownerId: f.salesA.id, customerStatus: "初期接洽", fieldActions: { needSummary: "APPLY" }, forceReason: "虚构同名区分", basisType: "", basis: "" }
    ] });
    assert.deepEqual(partial.body.results.map(row => [row.status, row.code || null]), [["PROCESSED", null], ["FAILED", "IMPORT_DISTINGUISHING_BASIS_REQUIRED"]]);
    const forced = await api.request(f.admin, `${route}/confirm`, "POST", { confirmed: true, entries: [{ id: duplicateEntry.id, action: "FORCE_CREATE", ownerId: f.salesA.id, customerStatus: "初期接洽", fieldActions: { needSummary: "APPLY" }, forceReason: "虚构同名不同主体", basisType: "BRANCH", basis: "虚构独立分支" }] });
    assert.equal(forced.body.results[0].disposition, "FORCED_CREATED");
    assert.equal(f.db.prepare(`SELECT relation_type FROM customer_duplicate_relations WHERE customer_id = ?`).get(forced.body.results[0].customerId).relation_type, "SAME_NAME_DISTINCT");

    const second = await uploadHttp(api, f.admin, buffer);
    const secondRoute = `/api/imports/customer/${second.body.id}/munich-visits`;
    const secondPreview = await api.request(f.admin, `${secondRoute}/preview`, "POST", {});
    assert.equal(secondPreview.body.entries[7].sourceKey, partialEntry.sourceKey);
    const repeated = await api.request(f.admin, `${secondRoute}/confirm`, "POST", { confirmed: true, entries: [{ id: secondPreview.body.entries[7].id, action: "CREATE", ownerId: f.salesA.id, customerStatus: "初期接洽", fieldActions: { needSummary: "APPLY" }, contact: { action: "SKIP" } }] });
    assert.equal(repeated.body.results[0].status, "ALREADY_PROCESSED");
    const concurrentEntry = secondPreview.body.entries[9];
    const forgedEmptyField = await api.request(f.admin, `${secondRoute}/confirm`, "POST", { confirmed: true, entries: [{ id: concurrentEntry.id, action: "CREATE", ownerId: f.salesA.id, customerStatus: "初期接洽", fieldActions: { needSummary: "APPLY", notes: "APPLY" }, contact: { action: "SKIP" } }] });
    assert.equal(forgedEmptyField.body.results[0].code, "VISIT_FIELD_CANDIDATE_MISSING");
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM visit_import_origins WHERE source_key = ?`).get(concurrentEntry.sourceKey).n, 0);
    const concurrentPayload = { confirmed: true, entries: [{ id: concurrentEntry.id, action: "CREATE", ownerId: f.salesA.id, customerStatus: "初期接洽", fieldActions: { needSummary: "APPLY" }, contact: { action: "SKIP" } }] };
    const concurrent = await Promise.all([api.request(f.admin, `${secondRoute}/confirm`, "POST", concurrentPayload), api.request(f.admin, `${secondRoute}/confirm`, "POST", concurrentPayload)]);
    assert.deepEqual(concurrent.map(response => response.body.results[0].status).sort(), ["ALREADY_PROCESSED", "PROCESSED"]);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE full_name = '虚构并发客户有限公司'`).get().n, 1);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM visit_import_origins WHERE source_key = ?`).get(concurrentEntry.sourceKey).n, 1);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM reminders`).get().n, 0);
  } finally { await api.close(); f.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("旧数据库重复升级新增拜访来源表且保留原业务数据", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-visit-migration-"));
  const filename = path.join(root, "legacy.db");
  try {
    const customer = createCustomer(f.db, f.salesA, { fullName: "虚构旧库客户有限公司", registeredOn: "2026-07-01", status: "初期接洽", needSummary: "虚构旧库需求" });
    await f.db.backup(filename);
    f.db.close();
    const old = new Database(filename);
    old.exec(`DROP TABLE visit_import_decisions; DROP TABLE visit_import_origins; DROP TABLE visit_import_entries;`);
    old.close();
    for (let index = 0; index < 2; index += 1) {
      const upgraded = createDatabase(filename);
      assert.ok(upgraded.prepare(`SELECT 1 FROM customers WHERE id = ?`).get(customer.id));
      for (const table of ["visit_import_entries", "visit_import_origins", "visit_import_decisions"]) assert.equal(upgraded.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
      assert.deepEqual(upgraded.pragma("foreign_key_check"), []);
      upgraded.close();
    }
  } finally {
    try { f.db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
