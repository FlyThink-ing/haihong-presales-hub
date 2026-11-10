import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { changeUserManager, login, resetUserPassword, setUserActive, updateOwnProfile } from "../server/auth-service.js";
import { listCustomers } from "../server/customer-service.js";
import { addCustomerAndProject, setupBase } from "./test-utils.js";

test("每名售前只有一名当前负责人，变更时保留完整历史并立即改变管理范围", () => {
  const { db, admin, manager, managerOther, generalManager, salesA } = setupBase();
  try {
    addCustomerAndProject(db, salesA, "负责人变更");
    assert.equal(listCustomers(db, manager).length, 1);
    changeUserManager(db, admin, salesA.id, { managerId: managerOther.id, reason: "虚构组织调整" });
    assert.equal(listCustomers(db, manager).length, 0);
    assert.equal(listCustomers(db, managerOther).length, 1);
    const history = db.prepare(`SELECT previous_manager_id, new_manager_id, reason FROM user_manager_history WHERE user_id = ? ORDER BY effective_at`).all(salesA.id);
    assert.equal(history.length, 2);
    assert.equal(history[0].previous_manager_id, null);
    assert.equal(history[1].previous_manager_id, manager.id);
    assert.equal(history[1].new_manager_id, managerOther.id);
    assert.equal(history[1].reason, "虚构组织调整");
    assert.equal(generalManager.positionCode, "GENERAL_MANAGER");
    changeUserManager(db, admin, salesA.id, { managerId: generalManager.id, reason: "售前改为直属综合部经理" });
    assert.equal(listCustomers(db, managerOther).length, 0);
    assert.equal(listCustomers(db, generalManager).length, 1);
    const latest = db.prepare(`SELECT previous_manager_id, new_manager_id, reason FROM user_manager_history WHERE user_id = ? ORDER BY effective_at DESC LIMIT 1`).get(salesA.id);
    assert.equal(latest.previous_manager_id, managerOther.id);
    assert.equal(latest.new_manager_id, generalManager.id);
    assert.equal(latest.reason, "售前改为直属综合部经理");
  } finally {
    db.close();
  }
});

test("停用账号和重置密码会撤销会话，负责人存在有效下属时不能停用", () => {
  const { db, admin, manager, salesA } = setupBase();
  try {
    assert.throws(() => setUserActive(db, admin, manager.id, false), error => error.code === "MANAGER_HAS_ACTIVE_REPORTS");
    db.prepare(`INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES ('test-session', ?, 'test-csrf', '2999-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(salesA.id);
    setUserActive(db, admin, salesA.id, false);
    assert.equal(db.prepare(`SELECT is_active FROM users WHERE id = ?`).get(salesA.id).is_active, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?`).get(salesA.id).count, 0);
    setUserActive(db, admin, salesA.id, true);
    const newPassword = `${randomBytes(18).toString("base64url")}aA1!`;
    resetUserPassword(db, admin, salesA.id, newPassword);
    const session = login(db, { username: salesA.username, password: newPassword, sessionHours: 1 });
    assert.equal(session.user.id, salesA.id);
  } finally {
    db.close();
  }
});

test("用户维护本人手机和邮箱后可由会话安全回读并留下审计", () => {
  const { db, salesA } = setupBase();
  try {
    const updated = updateOwnProfile(db, salesA, { phone: "13800000000", email: "presales@example.invalid" });
    assert.equal(updated.phone, "13800000000");
    assert.equal(updated.email, "presales@example.invalid");
    assert.throws(() => updateOwnProfile(db, salesA, { phone: "1", email: "not-an-email" }), error => error.code === "USER_PHONE_INVALID");
    const audit = db.prepare(`SELECT summary_json FROM audit_logs WHERE action = 'USER_PROFILE_UPDATED' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`).get(salesA.id);
    assert.ok(audit);
    assert.deepEqual(JSON.parse(audit.summary_json).changedFields.sort(), ["email", "phone"]);
    assert.doesNotMatch(audit.summary_json, /13800000000|presales@example\.invalid/);
  } finally {
    db.close();
  }
});

