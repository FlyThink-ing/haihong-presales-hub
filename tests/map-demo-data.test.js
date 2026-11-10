import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUser } from "../server/auth-service.js";
import { createCustomerDictionaryOption } from "../server/customer-dictionary-service.js";
import { createDatabase } from "../server/database.js";
import { getMapOverview } from "../server/map-service.js";
import { seedMapDemoData } from "../scripts/seed-map-demo-data.js";
import { summarizeCustomersByProvince } from "../web/china-geo-map.js";

test("地图演示数据形成省份聚合且继续遵守本人、直属团队和管理员权限", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-map-demo-"));
  const db = createDatabase(path.join(root, "demo.db"));
  try {
    const admin = createUser(db, { username: "admin", displayName: "测试管理员", role: "ADMIN", password: "Test-Admin-Only-2026!" });
    const manager = createUser(db, { username: "demo_manager", displayName: "演示负责人", role: "MANAGER", password: "Test-Manager-Only-2026!" }, admin.id);
    const accounts = [
      ["demo_presales_north", "演示售前-华北"], ["demo_presales_east", "演示售前-华东"],
      ["demo_presales_central", "演示售前-中原"], ["demo_presales_south", "演示售前-华南"],
      ["demo_presales_southwest", "演示售前-西南"]
    ].map(([username, displayName]) => createUser(db, { username, displayName, role: "PRESALES", managerId: manager.id, password: "Test-Sales-Only-2026!", regions: [] }, admin.id));
    createCustomerDictionaryOption(db, admin, { kind: "SOURCE", value: "演示-销售推荐" });
    createCustomerDictionaryOption(db, admin, { kind: "TYPE", value: "演示-新客户" });

    const first = seedMapDemoData({ db, admin });
    assert.equal(first.alreadySeeded, false);
    assert.equal(first.customers, 10);
    assert.equal(first.activeCustomers, 10);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM projects`).get().count, 10);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM followups`).get().count, 10);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM customers WHERE longitude IS NOT NULL AND latitude IS NOT NULL`).get().count, 6);

    const adminMap = getMapOverview(db, path.join(root, "storage"), admin);
    const adminCustomers = [...adminMap.customerPoints, ...adminMap.unlocatedCustomers];
    const summaries = summarizeCustomersByProvince(adminCustomers);
    const counts = Object.fromEntries(summaries.map(item => [item.name, item.customerCount]));
    assert.equal(counts["广东省"], 2);
    assert.equal(counts["江苏省"], 2);
    assert.equal(counts["河南省"], 2);
    assert.deepEqual(adminMap.visibilityScope, { code: "ALL", label: "全部客户", description: "管理员可查看全部售前客户分布" });

    const managerMap = getMapOverview(db, path.join(root, "storage"), manager);
    assert.equal([...managerMap.customerPoints, ...managerMap.unlocatedCustomers].length, 10);
    assert.equal(managerMap.visibilityScope.code, "DIRECT_REPORTS");
    const northMap = getMapOverview(db, path.join(root, "storage"), accounts[0]);
    assert.equal([...northMap.customerPoints, ...northMap.unlocatedCustomers].length, 2);
    assert.ok([...northMap.customerPoints, ...northMap.unlocatedCustomers].every(customer => customer.owner.id === accounts[0].id));
    assert.equal(northMap.visibilityScope.code, "OWN");

    const second = seedMapDemoData({ db, admin });
    assert.equal(second.alreadySeeded, true);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM customers`).get().count, 10);
    assert.equal(db.pragma("foreign_key_check").length, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
