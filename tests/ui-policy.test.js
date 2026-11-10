import assert from "node:assert/strict";
import test from "node:test";
import { canCreateCustomer, CUSTOMER_DETAIL_TABS } from "../web/ui-policy.js";

test("客户新增入口只向售前、部门负责人和管理员显示", () => {
  assert.equal(canCreateCustomer("PRESALES"), true);
  assert.equal(canCreateCustomer("MANAGER"), true);
  assert.equal(canCreateCustomer("ADMIN"), true);
  assert.equal(canCreateCustomer("VP"), false);
});

test("客户详情固定为需求规定的八个清晰区域", () => {
  assert.deepEqual(CUSTOMER_DETAIL_TABS, [
    ["overview", "概览"],
    ["contacts", "联系人"],
    ["followups", "跟进"],
    ["reminders", "提醒"],
    ["surveys", "软件调研"],
    ["quotes", "报价"],
    ["contracts", "合同"],
    ["files", "附件与操作日志"]
  ]);
});
