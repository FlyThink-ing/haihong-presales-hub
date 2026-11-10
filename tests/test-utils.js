import { randomBytes, randomUUID } from "node:crypto";
import { changeOwnPassword, createUser, getSession, login, resetUserPassword } from "../server/auth-service.js";
import { createApp } from "../server/app.js";
import { createCustomer } from "../server/customer-service.js";
import { createDatabase, nowIso } from "../server/database.js";

function generatedPassword() {
  return `${randomBytes(18).toString("base64url")}aA1!`;
}

export function completeResetLogin(db, username, temporaryPassword) {
  const temporary = login(db, { username, password: temporaryPassword, sessionHours: 1 });
  return changeOwnPassword(db, getSession(db, temporary.token), { currentPassword: temporaryPassword, newPassword: generatedPassword() }, 1);
}

export async function startTestApi(db, admin, actors, config = {}) {
  const sessions = new Map();
  for (const actor of actors) {
    const temporaryPassword = generatedPassword();
    resetUserPassword(db, admin, actor.id, temporaryPassword);
    sessions.set(actor.id, completeResetLogin(db, actor.username, temporaryPassword));
  }
  const server = createApp({ db, config: { sessionHours: 1, secureCookie: false, ...config } }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  return {
    async request(actor, route, method = "GET", body) {
      const session = sessions.get(actor.id);
      const multipart = body instanceof FormData;
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { cookie: `hh_session=${session.token}`, "x-csrf-token": session.csrfToken, ...(!multipart ? { "content-type": "application/json" } : {}) }, ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, body: response.status === 204 ? null : response.headers.get("content-type")?.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer()) };
    },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

export function setupBase() {
  const db = createDatabase(":memory:");
  const admin = createUser(db, { username: `admin-${randomUUID()}`, displayName: "测试管理员", password: generatedPassword(), role: "ADMIN" });
  const manager = createUser(db, { username: `manager-${randomUUID()}`, displayName: "测试部门负责人", password: generatedPassword(), role: "MANAGER" }, admin.id);
  const managerOther = createUser(db, { username: `manager-other-${randomUUID()}`, displayName: "其他部门负责人", password: generatedPassword(), role: "MANAGER" }, admin.id);
  const generalManager = createUser(db, { username: `general-manager-${randomUUID()}`, displayName: "测试综合部经理", password: generatedPassword(), role: "MANAGER", positionCode: "GENERAL_MANAGER" }, admin.id);
  const salesA = createUser(db, { username: `sales-a-${randomUUID()}`, displayName: "测试售前甲", password: generatedPassword(), role: "PRESALES", managerId: manager.id, regions: ["测试省甲"] }, admin.id);
  const salesB = createUser(db, { username: `sales-b-${randomUUID()}`, displayName: "测试售前乙", password: generatedPassword(), role: "PRESALES", managerId: manager.id, regions: ["测试省乙"] }, admin.id);
  const salesOther = createUser(db, { username: `sales-other-${randomUUID()}`, displayName: "其他部门售前", password: generatedPassword(), role: "PRESALES", managerId: managerOther.id }, admin.id);
  const vp = createUser(db, { username: `vp-${randomUUID()}`, displayName: "测试副总", password: generatedPassword(), role: "VP" }, admin.id);
  return { db, admin, manager, managerOther, generalManager, salesA, salesB, salesOther, vp };
}

export function addCustomerAndProject(db, actor, suffix = "甲") {
  const customer = createCustomer(db, actor, {
    fullName: `虚构客户${suffix}有限公司`,
    shortName: `虚构客户${suffix}`,
    registeredOn: "2026-08-01",
    status: "初期接洽",
    needSummary: "虚构 MES 需求",
    province: `测试省${suffix}`,
    city: "测试市"
  });
  const project = { id: randomUUID(), customerId: customer.id, name: `虚构项目${suffix}` };
  db.prepare(`INSERT INTO projects (id, customer_id, name, summary, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(project.id, customer.id, project.name, "仅用于自动化测试", nowIso());
  return { customer, project };
}

export function sampleQuoteInput(customerId, projectId, suffix = "001") {
  return {
    quoteNumber: `Q-TEST-${suffix}-${randomUUID().slice(0, 8)}`,
    customerId,
    projectId,
    notes: "虚构报价，仅用于自动化测试",
    metadata: {
      customerContactName: "虚构客户联系人",
      customerPhone: "13000000000",
      customerContactSource: "CUSTOMER_MANUAL"
    },
    finalDiscountCents: 12_600_000,
    items: [
      { category: "标准模块", itemName: "虚构生产执行模块", unit: "套", quantityMilli: 1000, untaxedUnitPriceCents: 4_000_000, taxRateBps: 600 },
      { category: "定制化需求", itemName: "虚构追溯扩展", unit: "套", quantityMilli: 1000, untaxedUnitPriceCents: 4_000_000, taxRateBps: 600 },
      { category: "实施部署", itemName: "虚构部署服务", unit: "套", quantityMilli: 1000, untaxedUnitPriceCents: 4_000_000, taxRateBps: 600 }
    ]
  };
}

export function completeSurveyResponse(schema) {
  const answers = {};
  for (const module of schema.modules) {
    for (const question of module.questions) answers[question.id] = { record: question.required ? `虚构回答-${question.id}` : "", solution: "" };
  }
  const tables = {};
  for (const definition of schema.tables) {
    tables[definition.key] = [Object.fromEntries(definition.fields.map(field => {
      if (field.type === "number") return [field.key, field.required ? 1 : 0];
      if (field.type === "select") return [field.key, field.options[0]];
      return [field.key, field.required ? `虚构-${field.key}` : ""];
    }))];
  }
  return { answers, tables };
}
