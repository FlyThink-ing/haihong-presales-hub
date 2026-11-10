import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { createCustomer, getCustomer, updateCustomer } from "../server/customer-service.js";
import { createCustomerDictionaryOption, deleteCustomerDictionaryOption, listCustomerDictionaryCandidates } from "../server/customer-dictionary-service.js";
import { createDatabase } from "../server/database.js";
import { importCustomerBatch, uploadCustomerWorkbook } from "../server/import-service.js";
import { setupBase, startTestApi } from "./test-utils.js";

test("字典 HTTP 仅管理员维护；正常客户仅选启用值，停用旧值不阻止其他编辑，曾使用项不能删除", async () => {
  const f = setupBase();
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA, f.manager, f.vp]);
  const input = { fullName: "虚构字典接口客户", ownerId: f.salesA.id, registeredOn: "2026-08-28", needSummary: "虚构需求", status: "初期接洽", source: "虚构来源甲", customerType: "虚构客户类型", industry: "虚构制造业", province: "河南省", city: "鹤壁市" };
  try {
    for (const actor of [f.salesA, f.manager, f.vp]) {
      assert.equal((await api.request(actor, "/api/customer-dictionaries", "POST", { kind: "SOURCE", value: "虚构来源甲" })).status, 403);
      assert.equal((await api.request(actor, "/api/customer-dictionaries?includeDisabled=true")).status, 403);
      assert.equal((await api.request(actor, "/api/customer-dictionaries/candidates")).status, 403);
    }
    assert.equal((await api.request(f.salesA, "/api/customers", "POST", { ...input, allowHistoricalDictionaryValues: true })).status, 400);
    const source = await api.request(f.admin, "/api/customer-dictionaries", "POST", { kind: "SOURCE", value: input.source });
    assert.equal(source.status, 201);
    const type = await api.request(f.admin, "/api/customer-dictionaries", "POST", { kind: "TYPE", value: input.customerType });
    assert.equal(type.status, 201);
    assert.equal((await api.request(f.admin, "/api/customer-dictionaries", "POST", { kind: "SOURCE", value: input.source })).status, 409);
    const created = await api.request(f.salesA, "/api/customers", "POST", input);
    assert.equal(created.status, 201);
    const sourceRoute = `/api/customer-dictionaries/${source.body.id}`;
    assert.equal((await api.request(f.manager, sourceRoute, "PATCH", { active: false })).status, 403);
    assert.equal((await api.request(f.admin, sourceRoute, "PATCH", { active: false })).status, 200);
    assert.ok(!(await api.request(f.salesA, "/api/customer-dictionaries")).body.items.some(item => item.id === source.body.id));
    assert.equal((await api.request(f.salesA, `/api/customers/${created.body.id}`, "PATCH", { source: input.source, status: "现场调研", notes: "停用值仍可保留" })).status, 200);
    assert.equal((await api.request(f.salesA, "/api/customers", "POST", { ...input, fullName: "虚构不得选择停用值客户" })).status, 400);
    assert.equal((await api.request(f.salesA, `/api/customers/${created.body.id}`, "PATCH", { source: "未知虚构值" })).status, 400);
    assert.equal((await api.request(f.admin, sourceRoute, "PATCH", { value: "不得改写已用值" })).status, 409);
    await api.request(f.salesA, `/api/customers/${created.body.id}`, "PATCH", { source: null });
    assert.equal((await api.request(f.admin, sourceRoute, "DELETE")).status, 409);
    assert.equal((await api.request(f.admin, sourceRoute, "PATCH", { active: true })).status, 200);
    const unused = await api.request(f.admin, "/api/customer-dictionaries", "POST", { kind: "SOURCE", value: "虚构未使用" });
    assert.equal((await api.request(f.admin, `/api/customer-dictionaries/${unused.body.id}`, "PATCH", { value: "虚构未使用已维护" })).status, 200);
    assert.equal((await api.request(f.admin, `/api/customer-dictionaries/${unused.body.id}`, "DELETE")).status, 204);
    assert.ok(f.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'CUSTOMER_DICTIONARY_UPDATED'`).get());
    assert.ok(f.db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'CUSTOMER_DICTIONARY_DELETED'`).get());
  } finally { await api.close(); f.db.close(); }
});

test("合成历史导入未知原值逐字保留并汇总候选，确认不会改写客户或导入/审计快照", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-dictionary-import-"));
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("虚构信息收集");
    sheet.addRow(["客户名称", "客户来源", "客户类型", "登记时间", "状态", "客户需求"]);
    sheet.addRow(["虚构字典历史甲", "虚构展会", "虚构历史类型", "2026-08-01", "初期接洽", "虚构需求甲"]);
    sheet.addRow(["虚构字典历史乙", "虚构展览会", "虚构历史类型", "2026-08-02", "初期接洽", "虚构需求乙"]);
    const job = await uploadCustomerWorkbook(f.db, { storagePath: root }, f.admin, { originalname: "虚构候选.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await workbook.xlsx.writeBuffer()) });
    const imported = importCustomerBatch(f.db, f.admin, job.id, { ownerId: f.salesA.id, rowNumbers: [2, 3] });
    assert.ok(imported.results.every(row => row.status === "IMPORTED"), JSON.stringify(imported.results));
    const candidates = listCustomerDictionaryCandidates(f.db, f.admin);
    assert.equal(candidates.find(item => item.kind === "TYPE").importRowCount, 2);
    assert.equal(candidates.filter(item => item.kind === "SOURCE").length, 2);
    assert.ok(candidates.every(item => item.state === "PENDING"));
    assert.ok(!JSON.stringify(candidates).includes("虚构字典历史甲"));
    assert.ok(!JSON.stringify(candidates).includes(f.salesA.id));
    assert.throws(() => listCustomerDictionaryCandidates(f.db, f.salesA), error => error.code === "DICTIONARY_ADMIN_REQUIRED");
    const customer = getCustomer(f.db, f.salesA, imported.results[0].customerId);
    assert.equal(updateCustomer(f.db, f.salesA, customer.id, { notes: "虚构保留未确认原值" }).source, customer.source);
    const preserved = () => JSON.stringify({ customers: f.db.prepare(`SELECT * FROM customers ORDER BY id`).all(), rows: f.db.prepare(`SELECT * FROM import_rows ORDER BY id`).all(), origins: f.db.prepare(`SELECT * FROM customer_import_origins ORDER BY id`).all(), audits: f.db.prepare(`SELECT * FROM audit_logs WHERE entity_type <> 'CUSTOMER_DICTIONARY' ORDER BY id`).all() });
    const before = preserved();
    const option = createCustomerDictionaryOption(f.db, f.admin, { kind: "SOURCE", value: customer.source });
    assert.equal(preserved(), before);
    assert.equal(listCustomerDictionaryCandidates(f.db, f.admin).find(item => item.kind === "SOURCE" && item.value === customer.source).state, "ENABLED");
    assert.throws(() => deleteCustomerDictionaryOption(f.db, f.admin, option.id), error => error.code === "DICTIONARY_VALUE_IN_USE");
  } finally { f.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("旧库字典迁移只新增空字典，旧来源/类型自动成为候选而不修改原值", async () => {
  const f = setupBase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-dictionary-migration-"));
  const filename = path.join(root, "virtual.db");
  try {
    const customer = createCustomer(f.db, f.salesA, { fullName: "虚构旧字典客户", source: "  虚构原始来源  ", customerType: "虚构原始类型", needSummary: "虚构需求", registeredOn: "2026-08-01", status: "初期接洽" }, { allowHistoricalDictionaryValues: true });
    await f.db.backup(filename);
    const old = new Database(filename);
    old.exec("DROP TABLE customer_dictionary_options");
    old.close();
    for (let i = 0; i < 2; i++) {
      const migrated = createDatabase(filename);
      assert.equal(migrated.prepare(`SELECT COUNT(*) AS count FROM customer_dictionary_options`).get().count, 0);
      assert.equal(getCustomer(migrated, f.salesA, customer.id).source, customer.source);
      assert.equal(listCustomerDictionaryCandidates(migrated, f.admin).find(item => item.kind === "SOURCE").value, "  虚构原始来源  ");
      assert.deepEqual(migrated.pragma("foreign_key_check"), []);
      migrated.close();
    }
  } finally { f.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
