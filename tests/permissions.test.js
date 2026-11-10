import assert from "node:assert/strict";
import test from "node:test";
import { getCustomer, listCustomers, transferCustomer } from "../server/customer-service.js";
import { addCustomerAndProject, setupBase } from "./test-utils.js";

test("售前仅访问本人客户，部门负责人仅访问管理范围，副总无普通客户列表权限", () => {
  const context = setupBase();
  const { db, salesA, salesB, salesOther, manager, vp } = context;
  try {
    const a = addCustomerAndProject(db, salesA, "甲").customer;
    const b = addCustomerAndProject(db, salesB, "乙").customer;
    addCustomerAndProject(db, salesOther, "其他");
    assert.deepEqual(listCustomers(db, salesA).map(item => item.id), [a.id]);
    assert.equal(listCustomers(db, manager).length, 2);
    assert.equal(listCustomers(db, vp).length, 0);
    assert.throws(() => getCustomer(db, salesA, b.id), error => error.code === "CUSTOMER_NOT_FOUND");
  } finally {
    db.close();
  }
});

test("客户转让后原负责人立即失去权限并保留转让记录", () => {
  const { db, salesA, salesB, manager } = setupBase();
  try {
    const customer = addCustomerAndProject(db, salesA, "转让").customer;
    transferCustomer(db, manager, customer.id, { newOwnerId: salesB.id, reason: "虚构区域调整" });
    assert.throws(() => getCustomer(db, salesA, customer.id), error => error.code === "CUSTOMER_NOT_FOUND");
    assert.equal(getCustomer(db, salesB, customer.id).owner.id, salesB.id);
    const log = db.prepare(`SELECT * FROM customer_transfers WHERE customer_id = ?`).get(customer.id);
    assert.equal(log.previous_owner_id, salesA.id);
    assert.equal(log.new_owner_id, salesB.id);
    assert.equal(log.reason, "虚构区域调整");
  } finally {
    db.close();
  }
});

