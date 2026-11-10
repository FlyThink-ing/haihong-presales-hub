import test from "node:test";
import assert from "node:assert/strict";
import { createUser, publicUser } from "../server/auth-service.js";
import { createCustomerDictionaryOption } from "../server/customer-dictionary-service.js";
import { createCustomer } from "../server/customer-service.js";
import { createDatabase } from "../server/database.js";
import { canApproveCustomerQuote, canReadCustomer } from "../server/permissions.js";
import { applyTestRoster } from "../scripts/apply-test-roster.js";

function roster() {
  return [
    ["sales1", "售前一", "售前顾问", "13000000001", "sales1@example.test"],
    ["sales2", "售前二", "售前顾问", "13000000002", "sales2@example.test"],
    ["sales3", "售前三", "售前顾问", "13000000003", "sales3@example.test"],
    ["sales4", "售前四", "售前顾问", "13000000004", "sales4@example.test"],
    ["sales5", "售前五", "售前顾问", "13000000005", "sales5@example.test"],
    ["general", "综合经理", "综合部经理", "13000000006", "general@example.test"],
    ["rnd", "研发经理", "研发部经理", "13000000007", "rnd@example.test"],
    ["vpuser", "副总经理", "副总经理", "13000000008", "vp@example.test"],
    ["admin", "系统管理员", "系统管理员", "13000000009", "admin@example.test"]
  ].map(([username, displayName, roleLabel, phone, email]) => ({ username, displayName, roleLabel, phone, email }));
}

test("测试名单按正式角色接管既有演示流程且不记录联系方式或密码", () => {
  const db = createDatabase(":memory:");
  try {
    const admin = createUser(db, { username: "admin", displayName: "旧管理员", role: "ADMIN", password: "Test-Admin-Only-2026!" });
    const demoManager = createUser(db, { username: "demo_manager", displayName: "演示研发经理", role: "MANAGER", password: "Test-Manager-Only-2026!" }, admin.id);
    createUser(db, { username: "demo_general_manager", displayName: "演示综合经理", role: "MANAGER", positionCode: "GENERAL_MANAGER", password: "Test-General-Only-2026!" }, admin.id);
    createUser(db, { username: "demo_vp", displayName: "演示副总", role: "VP", password: "Test-Vp-Only-2026!" }, admin.id);
    const demoSales = ["north", "east", "central", "south", "southwest"].map(name => createUser(db, { username: `demo_presales_${name}`, displayName: `演示${name}`, role: "PRESALES", managerId: demoManager.id, password: "Test-Sales-Only-2026!" }, admin.id));
    createCustomerDictionaryOption(db, admin, { kind: "SOURCE", value: "演示来源" });
    createCustomerDictionaryOption(db, admin, { kind: "TYPE", value: "演示类型" });
    createCustomer(db, demoSales[0], {
      fullName: "【演示】名单接管客户",
      source: "演示来源",
      customerType: "演示类型",
      registeredOn: "2026-10-30",
      status: "初期接洽",
      needSummary: "仅用于测试",
      notes: "DEMO_DATASET:presales-business-flow-v1"
    });

    const result = applyTestRoster({ db, input: roster(), adminUsername: "admin" });
    const users = db.prepare(`SELECT id, username, role, manager_id, position_code, is_active, must_change_password FROM users WHERE username NOT LIKE 'demo_%' ORDER BY username`).all();
    const manager = users.find(item => item.username === "general");
    assert.equal(users.length, 9);
    assert.equal(users.filter(item => item.role === "PRESALES" && item.manager_id === manager.id).length, 5);
    assert.equal(users.find(item => item.username === "general").position_code, "GENERAL_MANAGER");
    assert.equal(users.find(item => item.username === "vpuser").role, "VP");
    assert.equal(users.find(item => item.username === "admin").must_change_password, 0);
    assert.equal(users.filter(item => item.username !== "admin" && item.must_change_password === 1).length, 8);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM users WHERE username LIKE 'demo_%' AND is_active = 0`).get().count, 8);
    assert.equal(db.prepare(`SELECT owner_id FROM customers WHERE full_name = '【演示】名单接管客户'`).get().owner_id, users.find(item => item.username === "sales1").id);
    const customerId = db.prepare(`SELECT id FROM customers WHERE full_name = '【演示】名单接管客户'`).get().id;
    const generalActor = publicUser(db.prepare(`SELECT * FROM users WHERE username = 'general'`).get());
    const researchActor = publicUser(db.prepare(`SELECT * FROM users WHERE username = 'rnd'`).get());
    assert.equal(canReadCustomer(db, generalActor, customerId), true);
    assert.equal(canReadCustomer(db, researchActor, customerId), false);
    assert.equal(canApproveCustomerQuote(db, researchActor, customerId, "MANAGER"), true);
    assert.equal(canApproveCustomerQuote(db, generalActor, customerId, "MANAGER"), false);
    assert.equal(canApproveCustomerQuote(db, generalActor, customerId, "GENERAL_MANAGER"), true);
    const auditRow = db.prepare(`SELECT summary_json FROM audit_logs WHERE action = 'TEST_ROSTER_APPLIED'`).get();
    assert.ok(auditRow);
    assert.doesNotMatch(auditRow.summary_json, /130000|example\.test|password/i);
    assert.equal(result.activeRosterAccounts, 9);

    const rerun = applyTestRoster({ db, input: roster(), adminUsername: "admin" });
    assert.equal(rerun.activeRosterAccounts, 9);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'TEST_ROSTER_APPLIED'`).get().count, 1);
  } finally {
    db.close();
  }
});
