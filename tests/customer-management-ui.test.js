import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { listChinaCities, listChinaProvinces } from "../web/china-regions.js";

test("新增和编辑客户使用完整省市联动选项且保留历史值口径", () => {
  const provinces = listChinaProvinces();
  assert.equal(provinces.length, 34);
  assert.ok(provinces.includes("河南省"));
  assert.ok(provinces.includes("香港特别行政区"));
  assert.ok(listChinaCities("河南省").includes("鹤壁市"));
  assert.deepEqual(listChinaCities("北京市"), ["北京市"]);
  assert.deepEqual(listChinaCities("不存在的省份"), []);

  const first = listChinaCities("江苏省");
  first.pop();
  assert.ok(listChinaCities("江苏省").includes("宿迁市"), "调用方不能改写固定城市字典");

  const appSource = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(appSource, /chinaRegionFields\(\{ provinceId: "customer-new-province", cityId: "customer-new-city", required: true \}\)/);
  assert.match(appSource, /bindChinaRegionSelects\("customer-new-province", "customer-new-city"\)/);
  assert.match(appSource, /province: customer\.province \|\| "", city: customer\.city \|\| ""/);
  assert.match(appSource, /class="region-select-pair full"/);
  assert.doesNotMatch(appSource, /<input id="customer-new-province"/);
  assert.doesNotMatch(appSource, /<input id="customer-new-city"/);
  assert.match(appSource, /（历史值）/);
});

test("客户管理突出登记日期区间并固定档案弹窗视口", () => {
  const appSource = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const cssSource = fs.readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  const tableViewStart = appSource.indexOf("const tableView =");
  const tableViewEnd = appSource.indexOf("content.innerHTML =", tableViewStart);
  const customerTableSource = appSource.slice(tableViewStart, tableViewEnd);

  assert.match(appSource, /<legend>登记时间范围<\/legend>/);
  assert.match(appSource, /<span>开始日期<\/span><input id="customer-registered-from"/);
  assert.match(appSource, /<span>结束日期<\/span><input id="customer-registered-to"/);
  assert.match(appSource, /customer-filter-primary/);
  assert.match(appSource, /customer-filter-secondary/);
  assert.match(appSource, /customer-stage-panel/);
  assert.match(appSource, /<span>全部阶段<\/span>/);
  assert.doesNotMatch(appSource, /<label>客户状态<\/label><select id="customer-status"/);
  assert.match(appSource, /<th>客户阶段<\/th>/);
  assert.match(appSource, /<label class="required">客户阶段<\/label><select id="customer-new-status"/);
  assert.match(appSource, /点击客户名称进入完整档案/);
  assert.match(appSource, /编辑客户主档 \/ 阶段/);
  assert.doesNotMatch(appSource, /编辑客户主档 \/ 状态/);
  assert.match(customerTableSource, /class="text-button customer-name-link" data-customer-open=/);
  assert.doesNotMatch(customerTableSource, /<th>操作<\/th>/);
  assert.doesNotMatch(customerTableSource, />查看档案<\/button>/);
  assert.doesNotMatch(appSource, /data-customer-export/);
  assert.doesNotMatch(appSource, /查看客户拜访 SOP/);
  assert.doesNotMatch(appSource, /data-customer-view=/);
  assert.doesNotMatch(appSource, /customer-kanban/);
  assert.match(appSource, /dialogClass: "customer-archive-dialog"/);
  assert.match(cssSource, /\.dialog\.customer-archive-dialog \{[^}]*height: min\(820px, calc\(100vh - 60px\)\)/s);
  assert.match(cssSource, /\.customer-archive-dialog \.dialog-body \{[^}]*overflow-y: auto/s);
  assert.match(cssSource, /\.region-select-pair \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(cssSource, /@media \(max-width: 520px\)[\s\S]*\.customer-filter-primary, \.customer-filter-secondary \{ grid-template-columns: 1fr; \}/);
});

test("售前新增客户自动归属本人，管理员与经理选择售前负责人", async () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const escape = source.match(/function escapeHtml\([\s\S]*?\n\}/)?.[0];
  const customerDialog = source.match(/async function openCustomerDialog\([\s\S]*?\n\}/)?.[0];
  assert.ok(escape && customerDialog);
  const values = {
    "customer-new-name": "虚构客户", "customer-new-short": "", "customer-new-owner": "",
    "customer-new-registered-on": "2026-11-10", "customer-new-status": "初期接洽",
    "customer-new-source": "虚构来源", "customer-new-type": "虚构类型", "customer-new-industry": "制造业",
    "customer-new-province": "河南省", "customer-new-city": "鹤壁市", "customer-new-need": "虚构需求"
  };
  let dialog, submitted;
  const requests = [];
  const context = vm.createContext({
    state: { user: { id: "sale-a", role: "PRESALES", displayName: "虚构售前" }, page: "customers" },
    document: { querySelector: selector => ({ value: values[selector.slice(1)] }) },
    api: async (route, options) => {
      requests.push(route);
      if (route === "/api/assignable-users") return { items: [{ id: "sale-b", displayName: "另一售前" }] };
      if (route === "/api/customer-dictionaries") return { items: [] };
      if (route === "/api/customers") { submitted = JSON.parse(options.body); return { id: "customer" }; }
      throw new Error(`意外请求 ${route}`);
    },
    localDateTimeValue: () => "2026-11-10T10:00", customerDictionaryField: () => "", chinaRegionFields: () => "",
    bindChinaRegionSelects: () => {}, openDialog: (title, html, options) => { dialog = { title, html, options }; },
    closeDialog: () => {}, showToast: () => {}, go: async () => {}
  });
  vm.runInContext(`${escape}\n${customerDialog}`, context);
  await context.openCustomerDialog();
  assert.match(dialog.html, /value="虚构售前" readonly/);
  assert.doesNotMatch(dialog.html, /<select id="customer-new-owner">/);
  assert.ok(!requests.includes("/api/assignable-users"));
  await dialog.options.onSubmit();
  assert.equal(submitted.ownerId, "sale-a");

  for (const role of ["ADMIN", "MANAGER"]) {
    context.state.user = { id: `user-${role}`, role, displayName: "虚构管理人员" };
    values["customer-new-owner"] = "";
    await context.openCustomerDialog();
    assert.match(dialog.html, /<select id="customer-new-owner">/);
    assert.match(dialog.html, /请选择售前负责人/);
    await assert.rejects(() => dialog.options.onSubmit(), /当前负责人/);
    values["customer-new-owner"] = "sale-b";
    await dialog.options.onSubmit();
    assert.equal(submitted.ownerId, "sale-b");
  }
});
