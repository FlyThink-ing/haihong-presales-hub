import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createQuote, submitQuote } from "../server/quote-service.js";
import { actOnReminder, createReminder } from "../server/reminder-service.js";
import { addCustomerAndProject, sampleQuoteInput, setupBase, startTestApi } from "./test-utils.js";

test("行动工作台只把真正未完成事项计入，并返回权限内待审批摘要", async () => {
  const f = setupBase();
  const api = await startTestApi(f.db, f.admin, [f.salesA, f.manager]);
  try {
    const { customer, project } = addCustomerAndProject(f.db, f.salesA, "行动工作台");
    const quote = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id, "DASHBOARD"));
    submitQuote(f.db, f.salesA, quote.id);
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    createReminder(f.db, f.salesA, { customerId: customer.id, assigneeId: f.salesA.id, title: "虚构未来行动", remindAt: future });
    const unable = createReminder(f.db, f.manager, { customerId: customer.id, assigneeId: f.salesA.id, title: "虚构待确认行动", remindAt: future });
    actOnReminder(f.db, f.salesA, unable.id, { action: "REPORT_UNABLE", reason: "虚构无法完成原因" });

    const sales = await api.request(f.salesA, "/api/dashboard");
    assert.equal(sales.status, 200);
    assert.equal(sales.body.reminderSummary.nextSevenDays, 1, "无法完成待确认不能与未来七天提醒重复计数");

    const manager = await api.request(f.manager, "/api/dashboard");
    assert.equal(manager.status, 200);
    assert.equal(manager.body.pendingApprovalCount, 1);
    assert.deepEqual(manager.body.pendingApprovalItems.map(item => ({ id: item.id, customer: item.customer.name, status: item.status })), [
      { id: quote.id, customer: customer.fullName, status: "PENDING_MANAGER" }
    ]);
    assert.equal(manager.body.reminderSummary.pendingConfirmation, 1);
    assert.equal(manager.body.reminderSummary.confirmationItems[0].id, unable.id);
  } finally {
    await api.close();
    f.db.close();
  }
});

test("工作台视觉结构突出行动优先级并保留移动端适配", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  assert.match(source, /今日行动台/);
  assert.match(source, /优先处理/);
  assert.match(source, /待我审批/);
  assert.match(source, /下属上报无法完成/);
  assert.match(source, /dashboard-columns/);
  assert.match(source, /dashboard-column dashboard-column-main/);
  assert.doesNotMatch(source, /dashboard-side/);
  assert.doesNotMatch(source, /工作台仅展示提醒摘要/);
  assert.match(css, /\.dashboard-hero/);
  assert.match(css, /\.dashboard-hero \{ min-height: 132px;/);
  assert.match(css, /\.dashboard-columns \{[^}]*align-items: start;/);
  assert.match(css, /\.dashboard-column \{[^}]*align-content: start;/);
  assert.match(css, /\.action-metric\.danger\.has-work/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.action-metrics \{ grid-template-columns: 1fr; \}/);
});
