import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";
import { changeUserManager, createUser, setUserActive } from "../server/auth-service.js";
import { createCustomer, getCustomer, transferCustomer } from "../server/customer-service.js";
import { createDatabase } from "../server/database.js";
import { createQuote, decideQuote, submitQuote } from "../server/quote-service.js";
import { actOnReminder, createReminder, getReminder, listReminderEvents } from "../server/reminder-service.js";
import { addCustomerAndProject, sampleQuoteInput, setupBase, startTestApi } from "./test-utils.js";

test("无法完成提醒 HTTP 状态机保留原因和原时间，确认/恢复/重新指派不扩大客户权限", async () => {
  const f = setupBase();
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA, f.salesB, f.manager, f.managerOther]);
  try {
    const { customer } = addCustomerAndProject(f.db, f.salesA, "无法完成HTTP");
    const reminder = createReminder(f.db, f.manager, { customerId: customer.id, assigneeId: f.salesA.id, title: "虚构待确认事项", remindAt: "2026-08-01T01:00:00.000Z" });
    const route = `/api/reminders/${reminder.id}`;
    const action = (actor, payload) => api.request(actor, route, "PATCH", payload);
    assert.equal((await action(f.salesA, { action: "REPORT_UNABLE" })).status, 400);
    assert.equal((await action(f.salesA, { action: "REPORT_UNABLE", reason: "虚构客户条件不具备" })).body.status, "UNABLE_PENDING");
    for (const key of ["COMPLETE", "CANCEL", "POSTPONE", "REPORT_UNABLE"]) assert.equal((await action(f.salesA, { action: key, reason: "不能自行关闭" })).status, 409);
    assert.equal((await action(f.salesA, { action: "CONFIRM_CLOSE", reason: "不能代替指派人" })).status, 403);
    assert.equal((await action(f.manager, { action: "RESTORE" })).status, 400);
    assert.equal((await api.request(f.manager, "/api/dashboard")).body.reminderSummary.pendingConfirmation, 1);
    assert.equal((await api.request(f.manager, "/api/reminders?view=confirmation")).body.items[0].id, reminder.id);
    assert.equal((await action(f.manager, { action: "RESTORE", reason: "虚构恢复执行" })).status, 200);
    await action(f.salesA, { action: "REPORT_UNABLE", reason: "虚构再次上报" });
    assert.equal((await action(f.manager, { action: "REASSIGN", assigneeId: f.salesB.id, reason: "不得借提醒给其他人客户权限" })).status, 400);
    assert.equal((await api.request(f.salesB, `/api/customers/${customer.id}/workspace`)).status, 404);
    transferCustomer(f.db, f.admin, customer.id, { newOwnerId: f.salesB.id, reason: "虚构正式客户转让" });
    assert.equal((await action(f.manager, { action: "RESTORE", reason: "旧执行人已无客户权限" })).status, 400);
    assert.equal((await action(f.manager, { action: "REASSIGN", assigneeId: f.salesB.id, reason: "转交客户当前负责人" })).status, 200);
    assert.equal((await api.request(f.salesA, `${route}/events`)).status, 404);
    assert.equal((await api.request(f.salesA, "/api/reminders?view=mine")).body.items.length, 0);
    await action(f.salesB, { action: "REPORT_UNABLE", reason: "虚构交接后待确认" });
    changeUserManager(f.db, f.admin, f.salesB.id, { managerId: f.managerOther.id, reason: "虚构管理范围调整" });
    assert.equal((await action(f.manager, { action: "CONFIRM_CLOSE", reason: "原指派人失去权限" })).status, 404);
    assert.equal((await api.request(f.manager, "/api/reminders?view=assigned")).body.items.length, 0);
    assert.equal((await action(f.managerOther, { action: "CONFIRM_CLOSE", reason: "并非原指派人" })).status, 404);
    assert.equal((await action(f.admin, { action: "CONFIRM_CLOSE", reason: "管理员确认关闭" })).body.status, "CANCELED");
    const history = (await api.request(f.admin, `${route}/events`)).body.items;
    assert.deepEqual(history.map(item => item.type), ["ASSIGNED", "UNABLE_REPORTED", "RESTORED", "UNABLE_REPORTED", "REASSIGNED", "UNABLE_REPORTED", "CLOSE_CONFIRMED"]);
    assert.ok(history.every(item => item.after.original_remind_at === reminder.originalRemindAt && item.after.title === reminder.title));
    assert.ok(history.slice(1).every(item => item.reason && item.actor.id && item.before && item.createdAt));
    assert.equal((await api.request(f.admin, "/api/reminders?view=confirmation")).body.items.length, 0);
  } finally { await api.close(); f.db.close(); }
});

test("待部门负责人报价 HTTP 交接只更新待办归属和日志，旧页面不能审批，终审快照不变", async () => {
  const f = setupBase();
  const api = await startTestApi(f.db, f.admin, [f.admin, f.manager, f.managerOther]);
  try {
    const { customer, project } = addCustomerAndProject(f.db, f.salesA, "报价交接");
    const versions = [];
    for (let index = 0; index < 3; index++) {
      const quote = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id, `交接${index}`));
      submitQuote(f.db, f.salesA, quote.id);
      if (index > 0) decideQuote(f.db, f.manager, quote.id, { decision: "APPROVED", comment: "虚构一级通过" });
      if (index > 1) decideQuote(f.db, f.generalManager, quote.id, { decision: "APPROVED", comment: "虚构综合部二审通过" });
      if (index > 1) decideQuote(f.db, f.vp, quote.id, { decision: "APPROVED", comment: "虚构终审通过" });
      versions.push(quote.id);
    }
    const snapshots = () => JSON.stringify({ versions: f.db.prepare(`SELECT * FROM quote_versions ORDER BY id`).all(), approvals: f.db.prepare(`SELECT * FROM quote_approvals ORDER BY id`).all(), snapshots: f.db.prepare(`SELECT * FROM quote_approval_snapshots ORDER BY id`).all() });
    const before = snapshots();
    assert.equal((await api.request(f.admin, `/api/users/${f.salesA.id}/manager`, "POST", { managerId: f.managerOther.id, reason: "虚构组织调整" })).status, 200);
    assert.deepEqual((await api.request(f.manager, "/api/quotes/pending/mine")).body.items, []);
    const next = (await api.request(f.managerOther, "/api/quotes/pending/mine")).body.items;
    assert.deepEqual(next.map(item => item.id), [versions[0]]);
    assert.equal(next[0].pendingManager.id, f.managerOther.id);
    assert.equal(next[0].handoffs[0].previousManager.id, f.manager.id);
    assert.equal(next[0].handoffs[0].operatedBy.id, f.admin.id);
    assert.equal((await api.request(f.manager, `/api/quote-versions/${versions[0]}/decision`, "POST", { decision: "APPROVED", comment: "旧页面不得继续审批" })).status, 403);
    assert.equal((await api.request(f.admin, `/api/customers/${customer.id}/transfer`, "POST", { newOwnerId: f.salesB.id, reason: "虚构客户转让" })).status, 200);
    assert.deepEqual((await api.request(f.managerOther, "/api/quotes/pending/mine")).body.items, []);
    assert.equal((await api.request(f.manager, "/api/quotes/pending/mine")).body.items[0].handoffs.length, 2);
    assert.equal(snapshots(), before);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM quote_manager_handoffs`).get().count, 2);
    f.db.prepare(`UPDATE users SET manager_id = NULL WHERE id = ?`).run(f.salesOther.id);
    const invalid = await api.request(f.admin, `/api/customers/${customer.id}/transfer`, "POST", { newOwnerId: f.salesOther.id, reason: "虚构无有效管理人应回滚" });
    assert.equal(invalid.status, 409);
    assert.equal(invalid.body.error.code, "QUOTE_MANAGER_REQUIRED");
    assert.equal(getCustomer(f.db, f.admin, customer.id).owner.id, f.salesB.id);
    assert.equal(snapshots(), before);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM quote_manager_handoffs`).get().count, 2);
    assert.equal((await api.request(f.manager, `/api/quote-versions/${versions[0]}/decision`, "POST", { decision: "APPROVED", comment: "新任负责人实际审批" })).status, 200);
  } finally { await api.close(); f.db.close(); }
});

test("待审经理停用后 HTTP 历史读取不受阻，写入门禁保留且正规调整后恢复待办", async () => {
  const f = setupBase();
  const api = await startTestApi(f.db, f.admin, [f.admin, f.manager, f.managerOther, f.salesOther, f.vp]);
  try {
    const { customer, project } = addCustomerAndProject(f.db, f.salesA, "停用经理历史");
    const pending = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id, "待审"));
    submitQuote(f.db, f.salesA, pending.id);
    const draft = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id, "草稿"));
    const approved = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id, "已终审"));
    submitQuote(f.db, f.salesA, approved.id);
    decideQuote(f.db, f.manager, approved.id, { decision: "APPROVED", comment: "虚构一级通过" });
    decideQuote(f.db, f.generalManager, approved.id, { decision: "APPROVED", comment: "虚构综合部二审通过" });
    decideQuote(f.db, f.vp, approved.id, { decision: "APPROVED", comment: "虚构终审通过" });
    const snapshots = () => JSON.stringify({ versions: f.db.prepare(`SELECT * FROM quote_versions ORDER BY id`).all(), items: f.db.prepare(`SELECT * FROM quote_items ORDER BY id`).all(), approvals: f.db.prepare(`SELECT * FROM quote_approvals ORDER BY id`).all(), snapshots: f.db.prepare(`SELECT * FROM quote_approval_snapshots ORDER BY id`).all() });
    const before = snapshots();
    for (const user of [f.salesA, f.salesB, f.manager]) assert.equal(setUserActive(f.db, f.admin, user.id, false).active, false);
    const route = `/api/quote-versions/${pending.id}`;
    const detail = await api.request(f.admin, route);
    const list = await api.request(f.admin, "/api/quotes");
    const workspace = await api.request(f.admin, `/api/customers/${customer.id}/workspace`);
    assert.deepEqual({ detail: detail.status, list: list.status, workspace: workspace.status }, { detail: 200, list: 200, workspace: 200 });
    for (const quote of [detail.body, list.body.items.find(item => item.id === pending.id), workspace.body.quotes.find(item => item.id === pending.id)]) {
      assert.equal(quote.status, "PENDING_MANAGER");
      assert.equal(quote.pendingManager, null);
      assert.equal(quote.pendingManagerIssue.code, "QUOTE_MANAGER_REQUIRED");
      assert.match(quote.pendingManagerIssue.message, /无效.*待调整/);
      assert.equal(quote.finalDiscountCents, pending.finalDiscountCents);
    }
    assert.deepEqual(detail.body.items, pending.items);
    assert.deepEqual(detail.body.approvals, []);
    assert.equal(list.body.items.length, 3);
    assert.equal(workspace.body.quotes.length, 3);
    assert.equal(list.body.items.find(item => item.id === approved.id).approvals.length, 3);
    assert.ok(list.body.items.filter(item => item.id !== pending.id).every(item => item.pendingManagerIssue === null));
    assert.equal((await api.request(f.salesOther, route)).status, 404);
    for (const actor of [f.managerOther, f.vp]) {
      const visible = await api.request(actor, route);
      assert.equal(visible.status, 200);
      assert.equal(visible.body.pendingManagerIssue.code, "QUOTE_MANAGER_REQUIRED");
    }
    assert.equal((await api.request(f.manager, route)).status, 401);
    const blockedSubmit = await api.request(f.admin, `/api/quote-versions/${draft.id}/submit`, "POST", {});
    assert.equal(blockedSubmit.status, 409);
    assert.equal(blockedSubmit.body.error.code, "QUOTE_MANAGER_REQUIRED");
    for (const decision of ["APPROVED", "REJECTED"]) {
      const blocked = await api.request(f.admin, `${route}/decision`, "POST", { decision, comment: "无有效负责人时不得代审或退回" });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error.code, "QUOTE_MANAGER_REQUIRED");
    }
    for (const actor of [f.managerOther, f.vp]) assert.equal((await api.request(actor, `${route}/decision`, "POST", { decision: "APPROVED", comment: "不得改交他人代审" })).status, 403);
    assert.deepEqual((await api.request(f.admin, "/api/quotes/pending/mine")).body.items, []);
    assert.deepEqual((await api.request(f.vp, "/api/quotes/pending/mine")).body.items, []);
    assert.deepEqual((await api.request(f.managerOther, "/api/quotes/pending/mine")).body.items, []);
    const managerRoute = `/api/users/${f.salesA.id}/manager`;
    assert.equal((await api.request(f.admin, managerRoute, "POST", { managerId: f.manager.id, reason: "无效经理不能作为交接目标" })).status, 400);
    assert.equal(snapshots(), before);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM quote_manager_handoffs`).get().count, 0);
    assert.equal((await api.request(f.admin, managerRoute, "POST", { managerId: f.managerOther.id, reason: "虚构停用后正规调整" })).status, 200);
    const restored = (await api.request(f.managerOther, "/api/quotes/pending/mine")).body.items;
    assert.deepEqual(restored.map(item => item.id), [pending.id]);
    assert.equal(restored[0].pendingManager.id, f.managerOther.id);
    assert.equal(restored[0].pendingManagerIssue, null);
    assert.equal(restored[0].handoffs.length, 1);
    assert.equal(restored[0].handoffs[0].previousManager.id, f.manager.id);
    assert.equal(restored[0].handoffs[0].newManager.id, f.managerOther.id);
    assert.equal(restored[0].handoffs[0].operatedBy.id, f.admin.id);
    assert.equal(restored[0].handoffs[0].reason, "虚构停用后正规调整");
    assert.equal(snapshots(), before);
    const decided = await api.request(f.managerOther, `${route}/decision`, "POST", { decision: "APPROVED", comment: "新任负责人实际处理" });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.decidedVersion.status, "PENDING_VP");
  } finally { await api.close(); f.db.close(); }
});

test("旧提醒和事件表无损迁移新状态及历史，重复启动无重复迁移记录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-reminder-migration-"));
  const filename = path.join(root, "virtual.db");
  try {
    const old = new Database(filename);
    old.exec(fs.readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8").replace(",'UNABLE_PENDING'", "").replace(",'UNABLE_REPORTED','CLOSE_CONFIRMED','RESTORED','REASSIGNED'", ""));
    const secret = () => randomBytes(18).toString("base64url");
    const manager = createUser(old, { username: "virtual-manager", displayName: "虚构负责人", role: "MANAGER", password: secret() });
    const sales = createUser(old, { username: "virtual-sales", displayName: "虚构售前", role: "PRESALES", managerId: manager.id, password: secret() });
    const customer = createCustomer(old, sales, { fullName: "虚构迁移客户", needSummary: "虚构需求", registeredOn: "2026-08-01", status: "初期接洽" });
    const reminder = createReminder(old, manager, { customerId: customer.id, assigneeId: sales.id, title: "虚构旧提醒", remindAt: "2026-08-01" });
    const originalEvents = JSON.stringify(listReminderEvents(old, manager, reminder.id));
    old.close();
    for (let i = 0; i < 2; i++) {
      const migrated = createDatabase(filename);
      assert.equal(getReminder(migrated, sales, reminder.id).originalRemindAt, reminder.originalRemindAt);
      assert.equal(JSON.stringify(listReminderEvents(migrated, manager, reminder.id)), originalEvents);
      assert.deepEqual(migrated.pragma("foreign_key_check"), []);
      if (i === 1) assert.equal(actOnReminder(migrated, sales, reminder.id, { action: "REPORT_UNABLE", reason: "虚构迁移后上报" }).status, "UNABLE_PENDING");
      migrated.close();
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
