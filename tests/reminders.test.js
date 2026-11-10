import assert from "node:assert/strict";
import test from "node:test";
import { createReminder, actOnReminder } from "../server/reminder-service.js";
import { createQuote, decideQuote, submitQuote } from "../server/quote-service.js";
import { addCustomerAndProject, sampleQuoteInput, setupBase } from "./test-utils.js";

test("本人可建提醒，领导可指派；被指派事项延期必须说明原因", () => {
  const { db, manager, salesA, salesB } = setupBase();
  try {
    const { customer } = addCustomerAndProject(db, salesA, "提醒");
    const time = new Date(Date.now() + 86_400_000).toISOString();
    const self = createReminder(db, salesA, { customerId: customer.id, assigneeId: salesA.id, title: "虚构本人提醒", remindAt: time, priority: "MEDIUM" });
    assert.equal(self.source, "SELF");
    assert.throws(() => createReminder(db, salesA, { customerId: customer.id, assigneeId: salesB.id, title: "越权提醒", remindAt: time }), error => error.code === "ASSIGNEE_NOT_OWNER");

    const assigned = createReminder(db, manager, { customerId: customer.id, assigneeId: salesA.id, title: "虚构领导指派", remindAt: time, priority: "HIGH" });
    assert.equal(assigned.source, "LEADER");
    assert.equal(assigned.assignedBy.id, manager.id);
    assert.throws(() => actOnReminder(db, salesA, assigned.id, { action: "POSTPONE", remindAt: new Date(Date.now() + 172_800_000).toISOString() }), error => error.code === "REMINDER_REASON_REQUIRED");
    const postponed = actOnReminder(db, salesA, assigned.id, { action: "POSTPONE", remindAt: new Date(Date.now() + 172_800_000).toISOString(), reason: "虚构客户改期" });
    assert.equal(postponed.originalRemindAt, assigned.originalRemindAt);
    assert.equal(postponed.handlingReason, "虚构客户改期");
    assert.equal(actOnReminder(db, salesA, assigned.id, { action: "COMPLETE" }).status, "COMPLETED");
    const events = db.prepare(`SELECT event_type, reason FROM reminder_events WHERE reminder_id = ? ORDER BY created_at`).all(assigned.id);
    assert.deepEqual(events.map(event => event.event_type), ["ASSIGNED", "POSTPONED", "COMPLETED"]);
    assert.equal(events[1].reason, "虚构客户改期");
  } finally {
    db.close();
  }
});

test("副总经理仅可向终审相关客户的当前负责人指派提醒", () => {
  const { db, manager, generalManager, vp, salesA, salesB } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "终审提醒");
    const other = addCustomerAndProject(db, salesB, "非终审").customer;
    const time = new Date(Date.now() + 86_400_000).toISOString();
    assert.throws(() => createReminder(db, vp, { customerId: other.id, assigneeId: salesB.id, title: "越权副总提醒", remindAt: time }), error => error.code === "REMINDER_ASSIGN_FORBIDDEN");
    const quote = createQuote(db, salesA, sampleQuoteInput(customer.id, project.id, "VP-REMINDER"));
    submitQuote(db, salesA, quote.id);
    decideQuote(db, manager, quote.id, { decision: "APPROVED", comment: "虚构一级审批同意" });
    decideQuote(db, generalManager, quote.id, { decision: "APPROVED", comment: "虚构综合部二审同意" });
    const reminder = createReminder(db, vp, { customerId: customer.id, assigneeId: salesA.id, title: "虚构终审补充材料提醒", remindAt: time });
    assert.equal(reminder.source, "LEADER");
    assert.equal(reminder.assignedBy.id, vp.id);
  } finally {
    db.close();
  }
});
