import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { loadConfig } from "../server/config.js";
import { createContact } from "../server/customer-activity-service.js";
import { createQuote, submitQuote } from "../server/quote-service.js";
import { addCustomerAndProject, sampleQuoteInput, setupBase, startTestApi } from "./test-utils.js";

test("CORE 首发模式仅开放客户、报价和管理员必要能力", async () => {
  const f = setupBase();
  const { customer, project } = addCustomerAndProject(f.db, f.salesA, "首发");
  const quote = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id, "CORE"));
  const outside = addCustomerAndProject(f.db, f.salesOther, "其他部门");
  createContact(f.db, f.salesOther, outside.customer.id, { name: "虚构跨团队联系人" });
  const outsideQuote = createQuote(f.db, f.salesOther, sampleQuoteInput(outside.customer.id, outside.project.id, "OUTSIDE"));
  submitQuote(f.db, f.salesOther, outsideQuote.id);
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA, f.manager, f.generalManager, f.vp], {
    launchProfile: "CORE",
    dataMode: "TEST"
  });
  try {
    const runtime = await api.request(f.salesA, "/api/runtime");
    assert.equal(runtime.status, 200);
    assert.deepEqual(runtime.body, { launchProfile: "CORE", dataMode: "TEST", enabledModules: ["customers", "quotes", "admin"] });

    assert.equal((await api.request(f.salesA, "/api/customers")).status, 200);
    assert.equal((await api.request(f.salesA, "/api/quotes")).status, 200);
    assert.equal((await api.request(f.salesA, "/api/projects")).status, 200);
    assert.equal((await api.request(f.admin, "/api/users")).status, 200);

    const workspace = await api.request(f.salesA, `/api/customers/${customer.id}/core-workspace`);
    assert.equal(workspace.status, 200);
    assert.deepEqual(Object.keys(workspace.body).sort(), ["contacts", "customer", "permissions", "quotes"]);
    assert.equal(workspace.body.quotes[0].id, quote.id);
    assert.equal("followups" in workspace.body, false);
    assert.equal("contracts" in workspace.body, false);
    assert.equal("surveys" in workspace.body, false);

    const ownCustomers = (await api.request(f.salesA, "/api/customers")).body;
    assert.deepEqual(ownCustomers.items.map(item => item.id), [customer.id]);
    assert.deepEqual((await api.request(f.salesA, "/api/quotes")).body.items.map(item => item.id), [quote.id]);
    assert.equal((await api.request(f.salesA, `/api/customers/${outside.customer.id}/core-workspace`)).status, 404);
    assert.equal((await api.request(f.salesA, `/api/quote-versions/${outsideQuote.id}`)).status, 404);
    for (const actor of [f.manager, f.generalManager, f.vp]) {
      const directory = await api.request(actor, "/api/customers");
      assert.equal(directory.status, 200);
      assert.deepEqual(new Set(directory.body.items.map(item => item.id)), new Set([customer.id, outside.customer.id]));
      assert.equal(directory.body.statusCounts["初期接洽"], 2);
      assert.ok(directory.body.filterOptions.owners.some(owner => owner.id === f.salesOther.id));
      const entry = await api.request(actor, `/api/customers/${outside.customer.id}/core-workspace`);
      assert.equal(entry.status, 200);
      assert.deepEqual(entry.body.permissions, { canEditCustomer: false, canMaintainActivity: false, canSupplementRegisteredOn: false });
      assert.equal(entry.body.contacts[0].name, "虚构跨团队联系人");
      assert.equal(entry.body.quotes[0].currentApprovalStage, "MANAGER");
      const quotes = await api.request(actor, "/api/quotes");
      assert.deepEqual(new Set(quotes.body.items.map(item => item.id)), new Set([quote.id, outsideQuote.id]));
      assert.equal((await api.request(actor, `/api/quote-versions/${quote.id}`)).body.status, "DRAFT");
      assert.deepEqual((await api.request(actor, "/api/quotes/pending/mine")).body.items, []);
      assert.equal((await api.request(actor, `/api/quote-versions/${outsideQuote.id}/decision`, "POST", { decision: "APPROVED" })).status, 403);
      assert.equal((await api.request(actor, `/api/quote-versions/${quote.id}`, "PATCH", {})).status, 403);
      assert.equal((await api.request(actor, `/api/customers/${outside.customer.id}`, "PATCH", { notes: "禁止越权写入" })).status, 404);
      assert.ok([403, 404].includes((await api.request(actor, `/api/customers/${outside.customer.id}/registered-on`, "PATCH", { registeredOn: "2026-11-10" })).status));
    }

    const quoteAttachments = await api.request(f.salesA, `/api/attachments?targetType=QUOTE_VERSION&targetId=${quote.id}`);
    assert.equal(quoteAttachments.status, 200);
    const customerAttachments = await api.request(f.salesA, `/api/attachments?targetType=CUSTOMER&targetId=${customer.id}`);
    assert.equal(customerAttachments.status, 404);
    assert.equal(customerAttachments.body.error.code, "MODULE_DISABLED");

    const blocked = [
      "/api/dashboard",
      "/api/reminders",
      "/api/map",
      "/api/surveys",
      "/api/contracts",
      "/api/sop",
      "/api/imports/customer",
      "/api/admin/survey-templates",
      `/api/customers/${customer.id}/workspace`,
      `/api/customers/${customer.id}/followups`
    ];
    for (const route of blocked) {
      const response = await api.request(f.salesA, route);
      assert.equal(response.status, 404, route);
      assert.equal(response.body.error.code, "MODULE_DISABLED", route);
    }
  } finally {
    await api.close();
    f.db.close();
  }
});

test("部署配置严格区分首发范围、数据模式和可信代理", () => {
  const config = loadConfig({ HH_LAUNCH_PROFILE: "core", HH_DATA_MODE: "production", HH_TRUST_PROXY: "loopback" }, process.cwd());
  assert.equal(config.launchProfile, "CORE");
  assert.equal(config.dataMode, "PRODUCTION");
  assert.equal(config.trustProxy, "loopback");
  assert.throws(() => loadConfig({ HH_LAUNCH_PROFILE: "UNKNOWN" }, process.cwd()), /HH_LAUNCH_PROFILE/);
  assert.throws(() => loadConfig({ HH_DATA_MODE: "DEMO" }, process.cwd()), /HH_DATA_MODE/);
  assert.throws(() => loadConfig({ HH_TRUST_PROXY: "true" }, process.cwd()), /HH_TRUST_PROXY/);
  assert.throws(() => loadConfig({ HH_QUOTE_STANDARD_TEMPLATE_PATH: "deployment.env" }), /必须指向 DOCX/);
});

test("首发页面使用运行时能力控制入口且没有自助注册文案", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(source, /await api\("\/api\/runtime"\)/);
  assert.match(source, /if \(isCoreLaunch\(\)\)/);
  assert.match(source, /\/core-workspace/);
  assert.doesNotMatch(source, />\s*注册\s*</);
  assert.doesNotMatch(source, /测试数据环境|class="runtime-badge test"/);
  const allowed = source.match(/function pageAllowed\([\s\S]*?\n\}/)?.[0];
  const nav = source.match(/function navItems\([\s\S]*?\n\}/)?.[0];
  assert.ok(allowed && nav);
  const context = vm.createContext({ state: {}, isCoreLaunch: () => true });
  vm.runInContext(`${allowed}\n${nav}`, context);
  for (const user of [{ role: "MANAGER", positionCode: "RND_MANAGER" }, { role: "MANAGER", positionCode: "GENERAL_MANAGER" }, { role: "VP" }]) {
    context.state.user = user;
    assert.equal(context.pageAllowed("customers"), true);
    assert.equal(context.pageAllowed("quotes"), true);
    assert.equal(context.pageAllowed("settings"), false);
    assert.deepEqual(Array.from(context.navItems(), item => item[0]), ["customers", "quotes"]);
  }
});
