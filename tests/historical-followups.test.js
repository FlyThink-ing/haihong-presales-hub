import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import Database from "better-sqlite3";
import JSZip from "jszip";
import { createFollowup, listFollowups, updateFollowup } from "../server/customer-activity-service.js";
import { createCustomer, transferCustomer } from "../server/customer-service.js";
import { createDatabase } from "../server/database.js";
import { getFileForDownload } from "../server/file-service.js";
import { confirmHistoricalFollowups, getHistoricalFollowupPreview, previewHistoricalFollowups } from "../server/historical-followup-service.js";
import { getImportJob, importCustomerBatch, remapCustomerImport, uploadCustomerWorkbook } from "../server/import-service.js";
import { addCustomerAndProject, setupBase, startTestApi } from "./test-utils.js";

const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
async function syntheticHistoryWorkbook(historyText) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("信息收集");
  sheet.addRow(["虚构验收表，不含真实资料"]);
  sheet.addRow(["序号", "客户来源", "客户名称", "客户类型", "登记时间", "状态", "客户需求", "客户情况总结", "备注"]);
  sheet.addRow([1, "虚构来源", "虚构历史客户甲", "虚构类型", "2026-08-01", "初期接洽", "虚构需求", "2024年2月29日（电话）：虚构第一段\n2026-08-02 远程：" + "虚构长内容".repeat(1000) + "\n8月3日 微信：缺年原文\n2026-02-30 现场：非法日期\n2026-08-04 电话：多行\n待核对续文", ""]);
  sheet.addRow([2, "虚构来源", "虚构未匹配客户", "虚构类型", "", "初期接洽", "虚构需求", "2026-08-05 微信：虚构未匹配", ""]);
  if (historyText !== undefined) {
    sheet.getCell("H3").value = historyText;
    sheet.getCell("H4").value = "";
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("HTTP 含时分原文拒绝日精度追加，升级前错误 READY 预览读取/刷新/直接确认均重新校验", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-history-time-review-"));
  const api = await startTestApi(f.db, f.admin, [f.salesA], { storagePath: root });
  try {
    const raw = [
      "2026-08-04：09:30 电话：虚构记录",
      "2026-08-04: 上午9点30分 现场：虚构记录",
      "2026-08-04（09:30）微信：虚构记录",
      "2026-08-05：电话：虚构纯日期记录"
    ].join("\n");
    const form = new FormData();
    form.append("file", new Blob([await syntheticHistoryWorkbook(raw)], { type: mimeType }), "virtual-time-review.xlsx");
    const uploaded = await api.request(f.salesA, "/api/imports/customer/upload", "POST", form);
    assert.equal(uploaded.status, 201);
    const route = `/api/imports/customer/${uploaded.body.id}`;
    const imported = await api.request(f.salesA, `${route}/import`, "POST", { rowNumbers: [3] });
    assert.equal(imported.status, 200);
    const customerId = imported.body.results[0].customerId;
    assert.ok(customerId);
    const assertReview = response => {
      assert.equal(response.status, 200);
      assert.equal(response.body.entries.length, 4);
      assert.equal(response.body.entries.map(row => row.rawText).join(""), raw);
      for (const row of response.body.entries.slice(0, 3)) {
        assert.equal(row.status, "REVIEW_REQUIRED");
        assert.equal(row.canConfirm, false);
        assert.equal(row.occurredOn, null);
        assert.deepEqual(row.issues.map(issue => issue.code), ["TIME_REVIEW_REQUIRED"]);
      }
    };
    const preview = await api.request(f.salesA, `${route}/followups/preview`, "POST", {});
    assertReview(preview);
    assert.equal(preview.body.entries[3].status, "READY");
    const request = { confirmed: true, entries: preview.body.entries.slice(0, 3).map(row => ({ id: row.id, customerId })) };
    const assertRejected = response => {
      assertReview(response);
      assert.deepEqual(response.body.results.map(row => [row.status, row.code]), Array.from({ length: 3 }, () => ["FAILED", "HISTORY_REVIEW_REQUIRED"]));
    };
    assertRejected(await api.request(f.salesA, `${route}/followups/confirm`, "POST", request));
    for (const table of ["followups", "followup_import_origins", "reminders"]) assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);

    // 正常日精度记录先提交；升级门禁不能改写已有跟进或来源。
    const normal = await api.request(f.salesA, `${route}/followups/confirm`, "POST", { confirmed: true, entries: [{ id: preview.body.entries[3].id, customerId }] });
    assert.equal(normal.body.results[0].status, "IMPORTED");
    const followupsBefore = f.db.prepare(`SELECT * FROM followups ORDER BY id`).all();
    const originsBefore = f.db.prepare(`SELECT * FROM followup_import_origins ORDER BY source_key`).all();
    const customerOriginsBefore = f.db.prepare(`SELECT * FROM customer_import_origins ORDER BY id`).all();
    for (const mode of ["direct", "read", "refresh"]) {
      // 精确模拟 8b28a92 已持久化的错误 READY，而非要求用户删除任务。
      for (const entry of request.entries) f.db.prepare(`UPDATE followup_import_entries SET errors_json = '[]', occurred_on = '2026-08-04' WHERE id = ?`).run(entry.id);
      const savedEntries = f.db.prepare(`SELECT * FROM followup_import_entries ORDER BY id`).all();
      if (mode === "read") assertReview(await api.request(f.salesA, `${route}/followups`));
      if (mode === "refresh") assertReview(await api.request(f.salesA, `${route}/followups/preview`, "POST", {}));
      const rejected = await api.request(f.salesA, `${route}/followups/confirm`, "POST", request);
      assertRejected(rejected);
      assert.equal(rejected.body.entries[3].status, "ALREADY_IMPORTED");
      assert.deepEqual(f.db.prepare(`SELECT * FROM followup_import_entries ORDER BY id`).all(), savedEntries, mode);
      assert.deepEqual(f.db.prepare(`SELECT * FROM followups ORDER BY id`).all(), followupsBefore, mode);
      assert.deepEqual(f.db.prepare(`SELECT * FROM followup_import_origins ORDER BY source_key`).all(), originsBefore, mode);
      assert.deepEqual(f.db.prepare(`SELECT * FROM customer_import_origins ORDER BY id`).all(), customerOriginsBefore, mode);
      assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM reminders`).get().n, 0);
      assert.equal(f.db.prepare(`SELECT summary FROM customers WHERE id = ?`).get(customerId).summary, raw);
    }
    assert.deepEqual(f.db.pragma("foreign_key_check"), []);
  } finally { await api.close(); f.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("历史跟进按来源匹配、人工确认并跨批幂等；日精度纠错保留原文且不创建提醒", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-history-"));
  const config = { storagePath: root };
  try {
    const buffer = await syntheticHistoryWorkbook();
    const upload = () => uploadCustomerWorkbook(f.db, config, f.salesA, { originalname: "虚构历史.xlsx", mimetype: mimeType, buffer });
    const job = await upload();
    const pre = await previewHistoricalFollowups(f.db, config, f.salesA, job.id);
    assert.equal(pre.counts.total, 6);
    assert.ok(pre.entries.every(row => row.issues.some(issue => issue.code === "NO_MATCH")));
    const imported = importCustomerBatch(f.db, f.salesA, job.id, { rowNumbers: [3] });
    const customerId = imported.results[0].customerId;
    const summary = f.db.prepare(`SELECT summary FROM customers WHERE id = ?`).get(customerId).summary;
    const preview = await previewHistoricalFollowups(f.db, config, f.salesA, job.id);
    assert.equal(preview.counts.ready, 2);
    assert.deepEqual(preview.entries.map(row => row.id), pre.entries.map(row => row.id));
    const request = { confirmed: true, entries: preview.entries.map(row => ({ id: row.id, customerId })) };
    assert.throws(() => confirmHistoricalFollowups(f.db, f.salesA, job.id, { ...request, confirmed: false }), error => error.code === "HISTORY_CONFIRM_REQUIRED");
    const result = confirmHistoricalFollowups(f.db, f.salesA, job.id, request);
    assert.deepEqual(result.results.map(row => row.status), ["IMPORTED", "IMPORTED", "FAILED", "FAILED", "FAILED", "FAILED"]);
    assert.deepEqual(confirmHistoricalFollowups(f.db, f.salesA, job.id, request).results.slice(0, 2).map(row => row.status), ["ALREADY_IMPORTED", "ALREADY_IMPORTED"]);
    const second = await upload();
    const originsBeforeRemap = JSON.stringify(f.db.prepare(`SELECT * FROM customer_import_origins ORDER BY id`).all());
    await remapCustomerImport(f.db, config, f.salesA, second.id, { sheetName: second.sheetName, headerRow: second.headerRow, fieldMapping: second.fieldMapping });
    assert.equal(JSON.stringify(f.db.prepare(`SELECT * FROM customer_import_origins ORDER BY id`).all()), originsBeforeRemap);
    const secondPreview = await previewHistoricalFollowups(f.db, config, f.salesA, second.id);
    assert.equal(secondPreview.counts.imported, 2);
    const repeated = confirmHistoricalFollowups(f.db, f.salesA, second.id, { confirmed: true, entries: secondPreview.entries.slice(0, 2).map(row => ({ id: row.id, customerId })) });
    assert.ok(repeated.results.every(row => row.status === "ALREADY_IMPORTED"));
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM followups`).get().n, 2);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM customers`).get().n, 1);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM reminders`).get().n, 0);
    assert.equal(f.db.prepare(`SELECT summary FROM customers WHERE id = ?`).get(customerId).summary, summary);
    await assert.rejects(remapCustomerImport(f.db, config, f.salesA, job.id, { sheetName: job.sheetName, headerRow: 2, fieldMapping: job.fieldMapping }), error => error.code === "IMPORT_PREVIEW_LOCKED");
    assert.equal(getImportJob(f.db, f.salesA, job.id).mappingLocked, true);
    assert.equal(JSON.stringify(f.db.prepare(`SELECT * FROM customer_import_origins ORDER BY id`).all()), originsBeforeRemap);
    const followups = listFollowups(f.db, f.salesA, customerId);
    const day = followups.find(row => row.method === "PHONE");
    assert.equal(day.occurredAt, "2024-02-29");
    assert.equal(day.occurredPrecision, "DAY");
    assert.equal(day.nextAction, "");
    assert.deepEqual(day.participants, []);
    assert.equal(day.source.cellReference, "H3");
    assert.equal(day.source.rawDate, "2024年2月29日");
    assert.equal(day.source.rawMethod, "电话");
    assert.equal(day.source.operatedBy, f.salesA.id);
    assert.ok(followups.find(row => row.method === "OTHER").content.length > 5000);
    const original = JSON.stringify(day.source);
    assert.throws(() => updateFollowup(f.db, f.salesA, day.id, { occurredAt: "2026-02-29", changeReason: "虚构无效日期" }), error => error.code === "FOLLOWUP_TIME_INVALID");
    assert.throws(() => updateFollowup(f.db, f.salesA, day.id, { occurredAt: "2024-02-29T09:00:00Z", changeReason: "不得补时刻" }), error => error.code === "FOLLOWUP_TIME_INVALID");
    const changed = updateFollowup(f.db, f.salesA, day.id, { content: "虚构纠正", changeReason: "虚构核对原因" });
    assert.equal(changed.occurredAt, day.occurredAt);
    assert.equal(JSON.stringify(changed.source), original);
    assert.equal(JSON.parse(f.db.prepare(`SELECT before_json FROM followup_revisions WHERE followup_id = ?`).get(day.id).before_json).occurred_precision, "DAY");
    assert.throws(() => createFollowup(f.db, f.salesA, customerId, { method: "OTHER", occurredAt: "2026-08-01", content: "普通新增不能绕过", historical: true }), error => error.code === "FOLLOWUP_NEXT_ACTION_REQUIRED");
    transferCustomer(f.db, f.admin, customerId, { newOwnerId: f.salesB.id, reason: "虚构转让" });
    for (const action of [() => getHistoricalFollowupPreview(f.db, f.salesA, job.id), () => confirmHistoricalFollowups(f.db, f.salesA, job.id, request), () => getImportJob(f.db, f.salesA, job.id)]) assert.throws(action, error => error.code === "IMPORT_JOB_NOT_FOUND");
    assert.throws(() => getFileForDownload(f.db, config, f.salesA, job.fileId), error => error.code === "FILE_NOT_FOUND");
    assert.equal(listFollowups(f.db, f.salesB, customerId).length, 2);
    assert.deepEqual(f.db.pragma("foreign_key_check"), []);
  } finally { f.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("旧库迁移保留普通跟进时间、必填与修订，新增历史精度列可重复升级", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-history-migration-"));
  try {
    const { customer } = addCustomerAndProject(f.db, f.salesA, "历史迁移");
    const before = createFollowup(f.db, f.salesA, customer.id, { method: "PHONE", occurredAt: "2026-08-01T09:30:00+08:00", content: "虚构旧跟进", nextAction: "虚构下一步" }).followup;
    const job = await uploadCustomerWorkbook(f.db, { storagePath: root }, f.salesA, { originalname: "虚构旧库文件.xlsx", mimetype: mimeType, buffer: await syntheticHistoryWorkbook() });
    const filename = path.join(root, "virtual.db");
    await f.db.backup(filename);
    const old = new Database(filename);
    old.exec(`DROP TABLE followup_import_origins; DROP TABLE followup_import_entries; ALTER TABLE followups DROP COLUMN occurred_precision; ALTER TABLE followups DROP COLUMN is_historical;`);
    const oldFilesSchema = old.prepare(`SELECT sql FROM sqlite_master WHERE name = 'stored_files'`).get().sql.replace(",'CUSTOMER'", "").replace(",'FOLLOWUPS_DOCX'", "");
    old.pragma("foreign_keys = OFF"); old.pragma("legacy_alter_table = ON");
    old.exec(`ALTER TABLE stored_files RENAME TO old_files; ${oldFilesSchema}; INSERT INTO stored_files SELECT * FROM old_files; DROP TABLE old_files;`);
    old.close();
    for (let i = 0; i < 2; i++) {
      const db = createDatabase(filename);
      const after = listFollowups(db, f.salesA, customer.id)[0];
      assert.equal(after.occurredAt, before.occurredAt);
      assert.equal(after.occurredPrecision, "DATETIME");
      assert.equal(after.historical, false);
      assert.equal(getFileForDownload(db, { storagePath: root }, f.salesA, job.fileId).id, job.fileId);
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      db.close();
    }
  } finally { f.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("历史跟进 HTTP 闭环支持同文件重传、部分失败重试、并发确认、日精度 Word 和转让失权", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-history-http-"));
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA, f.salesB, f.manager, f.vp], { storagePath: root });
  try {
    const buffer = await syntheticHistoryWorkbook();
    const upload = async actor => {
      const form = new FormData(); form.append("file", new Blob([buffer], { type: mimeType }), "virtual.xlsx");
      return api.request(actor, "/api/imports/customer/upload", "POST", form);
    };
    assert.equal((await upload(f.vp)).status, 403);
    const customer = createCustomer(f.db, f.salesA, { fullName: "虚构历史客户甲", registeredOn: "2026-08-01", status: "初期接洽", needSummary: "虚构已有需求", summary: "不可被拆分覆盖的虚构总结" });
    const uploaded = await upload(f.salesA);
    assert.equal(uploaded.status, 201);
    const job = uploaded.body;
    const route = `/api/imports/customer/${job.id}`;
    const early = await api.request(f.salesA, `${route}/followups/preview`, "POST", {});
    assert.equal(early.status, 200);
    assert.ok(early.body.entries.every(row => row.issues.some(issue => issue.code === "NO_MATCH")));
    assert.equal((await api.request(f.salesB, `${route}/followups`)).status, 404);
    assert.equal((await api.request(f.manager, `${route}/followups`)).status, 404);
    assert.equal((await api.request(f.vp, `${route}/followups`)).status, 404);
    const merge = await api.request(f.salesA, `${route}/import`, "POST", { rowNumbers: [3], duplicateActions: { 3: { action: "MERGE", existingCustomerId: customer.id } } });
    assert.equal(merge.body.results[0].disposition, "MERGED");
    const ready = (await api.request(f.salesA, `${route}/followups/preview`, "POST", {})).body.entries.filter(row => row.status === "READY");
    assert.equal(ready.length, 2);
    const payload = { confirmed: true, entries: ready.map(row => ({ id: row.id, customerId: row.customer.id })) };
    const managerJob = (await upload(f.manager)).body;
    const managerPreview = await api.request(f.manager, `/api/imports/customer/${managerJob.id}/followups/preview`, "POST", {});
    assert.equal(managerPreview.status, 200);
    assert.ok(managerPreview.body.entries.every(row => !row.canConfirm));
    assert.equal((await api.request(f.manager, `/api/imports/customer/${managerJob.id}/followups/confirm`, "POST", { confirmed: true, entries: managerPreview.body.entries.slice(0, 1).map(row => ({ id: row.id, customerId: customer.id })) })).status, 403);
    assert.equal((await api.request(f.salesA, `${route}/followups/confirm`, "POST", { ...payload, confirmed: false })).status, 400);
    const spoofed = await api.request(f.salesA, `${route}/followups/confirm`, "POST", { ...payload, entries: [{ id: ready[0].id, customerId: "not-the-matched-subject" }] });
    assert.equal(spoofed.body.results[0].code, "HISTORY_CUSTOMER_CHANGED");
    const malformed = await api.request(f.salesA, `${route}/followups/confirm`, "POST", { confirmed: true, entries: [null, { id: "unknown", customerId: customer.id }] });
    assert.deepEqual(malformed.body.results.map(row => row.code), ["HISTORY_ENTRY_INVALID", "HISTORY_ENTRY_NOT_FOUND"]);
    f.db.exec(`CREATE TRIGGER fail_second_history BEFORE INSERT ON followup_import_origins WHEN NEW.paragraph_number = 2 BEGIN SELECT RAISE(ABORT, 'synthetic transient failure'); END;`);
    const partial = await api.request(f.salesA, `${route}/followups/confirm`, "POST", payload);
    assert.deepEqual(partial.body.results.map(row => row.status), ["IMPORTED", "FAILED"]);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM followups`).get().n, 1);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM followup_import_origins`).get().n, 1);
    f.db.exec(`DROP TRIGGER fail_second_history`);
    const retry = { confirmed: true, entries: [payload.entries[1]] };
    const concurrent = await Promise.all([api.request(f.salesA, `${route}/followups/confirm`, "POST", retry), api.request(f.salesA, `${route}/followups/confirm`, "POST", retry)]);
    assert.deepEqual(concurrent.map(row => row.body.results[0].status).sort(), ["ALREADY_IMPORTED", "IMPORTED"]);
    const secondJob = (await upload(f.salesA)).body;
    assert.equal((await api.request(f.salesA, `/api/imports/customer/${secondJob.id}/followups/preview`, "POST", {})).body.counts.imported, 2);
    assert.equal((await api.request(f.salesA, `${route}/preview`, "POST", { sheetName: job.sheetName, headerRow: job.headerRow, fieldMapping: job.fieldMapping })).body.error.code, "IMPORT_PREVIEW_LOCKED");
    const workspace = (await api.request(f.salesA, `/api/customers/${customer.id}/workspace`)).body;
    assert.equal(workspace.customer.summary, "不可被拆分覆盖的虚构总结");
    assert.equal(workspace.followups.length, 2);
    assert.ok(workspace.followups.every(row => row.occurredPrecision === "DAY" && /^\d{4}-\d{2}-\d{2}$/.test(row.occurredAt)));
    assert.equal(workspace.reminders.length, 0);
    const exported = await api.request(f.salesA, `/api/customers/${customer.id}/followups/export-docx`, "POST", {});
    assert.equal(exported.status, 201);
    const download = await api.request(f.salesA, `/api/files/${exported.body.id}/download`);
    assert.equal(download.status, 200);
    const zip = await JSZip.loadAsync(download.body);
    const xml = await zip.file("word/document.xml").async("string");
    assert.ok(zip.file("[Content_Types].xml"));
    assert.match(xml, /2024-02-29（日精度，原文未记录时分）/);
    assert.match(xml, /原文未记录/);
    assert.match(xml, /信息收集!H3/);
    assert.ok(xml.includes("虚构长内容".repeat(1000)));
    assert.doesNotMatch(xml, /2024-02-29T|2026-08-02T/);
    assert.equal((await api.request(f.admin, `/api/customers/${customer.id}/transfer`, "POST", { newOwnerId: f.salesB.id, reason: "虚构来源权限转让" })).status, 200);
    for (const endpoint of [route, `${route}/failures`, `${route}/followups`, `/api/files/${job.fileId}/download`, `/api/files/${exported.body.id}/download`, `/api/customers/${customer.id}/workspace`]) assert.equal((await api.request(f.salesA, endpoint)).status, 404);
    assert.equal((await api.request(f.salesA, `${route}/followups/confirm`, "POST", payload)).status, 404);
    assert.equal((await api.request(f.salesA, `${route}/followups/preview`, "POST", {})).status, 404);
    assert.equal((await api.request(f.salesA, "/api/imports/customer")).body.items.length, 0);
    const filesBeforeDeniedUpload = f.db.prepare(`SELECT COUNT(*) AS n FROM stored_files`).get().n;
    assert.equal((await upload(f.salesA)).status, 404);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM stored_files`).get().n, filesBeforeDeniedUpload);
    assert.equal((await api.request(f.salesB, `/api/files/${exported.body.id}/download`)).status, 200);
    assert.equal((await api.request(f.salesB, `/api/customers/${customer.id}/workspace`)).body.followups.length, 2);
    assert.deepEqual(f.db.pragma("foreign_key_check"), []);
  } finally { await api.close(); f.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("同一源行合法关联两个不同主体时 HTTP 保留歧义，管理员也不能自动选择或重复追加", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-history-ambiguous-"));
  const config = { storagePath: root };
  const api = await startTestApi(f.db, f.admin, [f.admin], config);
  try {
    const buffer = await syntheticHistoryWorkbook();
    const upload = () => uploadCustomerWorkbook(f.db, config, f.admin, { originalname: "虚构歧义.xlsx", mimetype: mimeType, buffer });
    const first = await upload();
    const firstImport = importCustomerBatch(f.db, f.admin, first.id, { ownerId: f.salesA.id, rowNumbers: [3] });
    const second = await upload();
    importCustomerBatch(f.db, f.admin, second.id, { ownerId: f.salesB.id, rowNumbers: [3], duplicateActions: { 3: { action: "FORCE_CREATE", reason: "虚构主体核对", basisType: "BRANCH", basis: "虚构不同分支机构" } } });
    const response = await api.request(f.admin, `/api/imports/customer/${second.id}/followups/preview`, "POST", {});
    assert.equal(response.status, 200);
    const preview = response.body;
    assert.ok(preview.entries.filter(row => row.rowNumber === 3).every(row => row.issues.some(issue => issue.code === "AMBIGUOUS")));
    const result = (await api.request(f.admin, `/api/imports/customer/${second.id}/followups/confirm`, "POST", { confirmed: true, entries: [{ id: preview.entries[0].id, customerId: firstImport.results[0].customerId }] })).body;
    assert.equal(result.results[0].code, "HISTORY_REVIEW_REQUIRED");
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM followups`).get().n, 0);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM customers`).get().n, 2);
  } finally { await api.close(); f.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
