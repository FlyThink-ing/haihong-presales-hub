import assert from "node:assert/strict";
import test from "node:test";
import { createContact, createFollowup, listContacts, listFollowups, updateFollowup } from "../server/customer-activity-service.js";
import { transferCustomer } from "../server/customer-service.js";
import { addCustomerAndProject, setupBase } from "./test-utils.js";

test("联系人和跟进记录继承客户权限，跟进修改保留旧值且可同时创建提醒", () => {
  const { db, manager, salesA, salesB } = setupBase();
  try {
    const { customer, project } = addCustomerAndProject(db, salesA, "客户活动");
    const contact = createContact(db, salesA, customer.id, { name: "虚构联系人甲", department: "测试部门", decisionRole: "业务参与人" });
    assert.throws(() => listContacts(db, salesB, customer.id), error => error.code === "CUSTOMER_NOT_FOUND");
    const result = createFollowup(db, salesA, customer.id, {
      method: "MEETING",
      occurredAt: new Date().toISOString(),
      projectId: project.id,
      contactId: contact.id,
      participants: ["虚构参与人"],
      content: "虚构需求沟通内容",
      customerFeedback: "虚构反馈",
      nextAction: "发送虚构调研清单",
      nextReminder: { remindAt: new Date(Date.now() + 86_400_000).toISOString(), priority: "HIGH" }
    });
    assert.equal(result.followup.contact.id, contact.id);
    assert.equal(result.reminder.relatedType, "FOLLOWUP");
    assert.equal(listFollowups(db, manager, customer.id).length, 1);
    assert.throws(() => updateFollowup(db, salesA, result.followup.id, { content: "纠正内容" }), error => error.code === "FOLLOWUP_CHANGE_REASON_REQUIRED");
    const updated = updateFollowup(db, salesA, result.followup.id, { content: "纠正后的虚构沟通内容", changeReason: "修正记录表述" });
    assert.equal(updated.content, "纠正后的虚构沟通内容");
    const revision = db.prepare(`SELECT before_json, reason FROM followup_revisions WHERE followup_id = ?`).get(result.followup.id);
    assert.equal(JSON.parse(revision.before_json).content, "虚构需求沟通内容");
    assert.equal(revision.reason, "修正记录表述");
    assert.throws(() => updateFollowup(db, salesA, result.followup.id, { occurredAt: "invalid-date", changeReason: "虚构非法日期" }), error => error.code === "FOLLOWUP_TIME_INVALID");
    const unlinked = updateFollowup(db, salesA, result.followup.id, { projectId: null, contactId: null, changeReason: "虚构纠正关联" });
    assert.equal(unlinked.project, null);
    assert.equal(unlinked.contact, null);

    transferCustomer(db, manager, customer.id, { newOwnerId: salesB.id, reason: "虚构客户交接" });
    assert.throws(() => listFollowups(db, salesA, customer.id), error => error.code === "CUSTOMER_NOT_FOUND");
    assert.equal(listFollowups(db, salesB, customer.id).length, 1);
  } finally {
    db.close();
  }
});
