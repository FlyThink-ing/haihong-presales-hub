import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createApp } from "../server/app.js";
import { createUser } from "../server/auth-service.js";
import { createCustomerDictionaryOption } from "../server/customer-dictionary-service.js";
import { createDatabase } from "../server/database.js";

test("登录使用安全密码摘要、HttpOnly 会话和 CSRF 校验", async t => {
  const db = createDatabase(":memory:");
  const password = `${randomBytes(18).toString("base64url")}aA1!`;
  const username = `api-user-${randomUUID()}`;
  const admin = createUser(db, { username: `api-admin-${randomUUID()}`, displayName: "接口测试管理员", password: `${randomBytes(18).toString("base64url")}aA1!`, role: "ADMIN" });
  const manager = createUser(db, { username: `api-manager-${randomUUID()}`, displayName: "接口测试负责人", password: `${randomBytes(18).toString("base64url")}aA1!`, role: "MANAGER" });
  const user = createUser(db, { username, displayName: "接口测试售前", password, role: "PRESALES", managerId: manager.id });
  createCustomerDictionaryOption(db, admin, { kind: "SOURCE", value: "虚构来源" });
  createCustomerDictionaryOption(db, admin, { kind: "TYPE", value: "虚构类型" });
  const stored = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(user.id).password_hash;
  assert.notEqual(stored, password);
  assert.match(stored, /^scrypt\$/);

  const app = createApp({ db, config: { sessionHours: 12, secureCookie: false } });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.close(); db.close(); });
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  assert.equal(login.status, 200);
  const cookieHeader = login.headers.get("set-cookie");
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Strict/i);
  const cookie = cookieHeader.split(";")[0];
  const session = await login.json();

  const profileUpdate = await fetch(`${base}/api/auth/profile`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken },
    body: JSON.stringify({ phone: "13800000000", email: "api-presales@example.invalid" })
  });
  assert.equal(profileUpdate.status, 200);
  const profile = await profileUpdate.json();
  assert.equal(profile.user.phone, "13800000000");
  assert.equal(profile.user.email, "api-presales@example.invalid");

  const refreshedSession = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.equal(refreshedSession.status, 200);
  assert.equal((await refreshedSession.json()).user.email, "api-presales@example.invalid");

  const noCsrf = await fetch(`${base}/api/customers`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(noCsrf.status, 403);

  const withCsrf = await fetch(`${base}/api/customers`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken },
    body: JSON.stringify({ fullName: "接口虚构客户", ownerId: user.id, registeredOn: "2026-08-01", needSummary: "虚构需求", status: "初期接洽", source: "虚构来源", customerType: "虚构类型", industry: "虚构行业", province: "河南省", city: "鹤壁市" })
  });
  assert.equal(withCsrf.status, 201);
});
