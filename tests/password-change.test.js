import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createApp } from "../server/app.js";
import { createUser, getSession, login } from "../server/auth-service.js";
import { createDatabase } from "../server/database.js";
import { hashPassword, sha256 } from "../server/security.js";

const password = () => `${randomBytes(18).toString("base64url")}aA1!`;

test("重置后四角色临时会话不能访问业务/下载，改密轮换全部会话和 CSRF，日志无凭据", async t => {
  const db = createDatabase(":memory:");
  const accounts = [];
  for (const role of ["ADMIN", "MANAGER", "PRESALES", "VP"]) {
    const secret = password();
    const user = createUser(db, { username: `virtual-${randomUUID()}`, displayName: `虚构${role}`, role, password: secret, managerId: accounts.find(item => item.user.role === "MANAGER")?.user.id });
    accounts.push({ user, secret });
  }
  const server = createApp({ db, config: { sessionHours: 1, secureCookie: false } }).listen(0, "127.0.0.1");
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, session, method = "GET", body) {
    const response = await fetch(`${base}${route}`, { method, headers: { "content-type": "application/json", ...(session ? { cookie: session.cookie, "x-csrf-token": session.csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = response.status === 204 ? null : await response.json();
    return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0], csrfToken: data?.csrfToken };
  }
  const signIn = (account, secret) => call("/api/auth/login", null, "POST", { username: account.user.username, password: secret });
  const adminAccount = accounts[0];
  let admin = await signIn(adminAccount, adminAccount.secret);
  for (const account of [...accounts.slice(1), adminAccount]) {
    const old = await signIn(account, account.secret);
    const temporaryPassword = password();
    assert.equal((await call(`/api/users/${account.user.id}/reset-password`, admin, "POST", { newPassword: temporaryPassword })).status, 200);
    assert.equal((await call("/api/auth/session", old)).status, 401);
    const temporary = await signIn(account, temporaryPassword);
    const second = await signIn(account, temporaryPassword);
    const logoutSession = await signIn(account, temporaryPassword);
    assert.equal((await call("/api/auth/logout", logoutSession, "POST")).status, 204);
    assert.equal(temporary.data.user.mustChangePassword, true);
    assert.equal((await call("/api/auth/session", temporary)).status, 200);
    for (const [route, method] of [["/api/customers", "GET"], ["/api/dashboard", "GET"], ["/api/sop", "GET"], ["/api/users", "GET"], ["/api/files/virtual/download", "GET"], ["/api/contract-files/virtual/download", "GET"], ["/api/contract-templates/virtual/download", "GET"], ["/api/customers", "POST"], ["/api/auth/session/extra", "GET"]]) {
      const denied = await call(route, temporary, method, method === "POST" ? {} : undefined);
      assert.equal(denied.status, 403, route);
      assert.equal(denied.data.error.code, "PASSWORD_CHANGE_REQUIRED");
    }
    const freshPassword = password();
    for (const [input, code] of [
      [{ currentPassword: password(), newPassword: freshPassword }, "CURRENT_PASSWORD_INVALID"],
      [{ currentPassword: temporaryPassword, newPassword: temporaryPassword }, "PASSWORD_UNCHANGED"],
      [{ currentPassword: temporaryPassword, newPassword: randomBytes(2).toString("hex") }, "PASSWORD_INVALID"]
    ]) {
      const rejected = await call("/api/auth/change-password", temporary, "POST", input);
      assert.equal(rejected.status, 400);
      assert.equal(rejected.data.error.code, code);
    }
    const changed = await call("/api/auth/change-password", temporary, "POST", { currentPassword: temporaryPassword, newPassword: freshPassword, userId: accounts.find(item => item !== account).user.id });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.user.id, account.user.id);
    assert.equal(changed.data.user.mustChangePassword, false);
    assert.notEqual(changed.cookie, temporary.cookie);
    assert.notEqual(changed.csrfToken, temporary.csrfToken);
    for (const stale of [temporary, second]) assert.equal((await call("/api/auth/session", stale)).status, 401);
    assert.equal((await call("/api/auth/logout", { ...changed, csrfToken: temporary.csrfToken }, "POST")).status, 403);
    assert.equal((await call("/api/customers", changed)).status, 200);
    assert.equal((await signIn(account, temporaryPassword)).status, 401);
    const logs = JSON.stringify(db.prepare(`SELECT summary_json FROM audit_logs WHERE action IN ('USER_PASSWORD_RESET','USER_PASSWORD_CHANGED')`).all());
    for (const secret of [account.secret, temporaryPassword, freshPassword, temporary.csrfToken, changed.csrfToken]) assert.ok(!logs.includes(secret));
    if (account === adminAccount) admin = changed;
  }
});

test("旧数据库增加强制改密标记且默认保留已有账号正常登录，迁移可重复执行", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-password-migration-"));
  const filename = path.join(root, "virtual.db");
  try {
    const old = new Database(filename);
    const schema = fs.readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8").replace(/^.*must_change_password.*\r?\n/m, "");
    old.exec(schema);
    const legacyPassword = password();
    const legacyToken = randomBytes(24).toString("hex");
    const legacyUserId = randomUUID();
    const legacyHash = hashPassword(legacyPassword);
    const timestamp = new Date().toISOString();
    old.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (?, 'virtual-legacy', '虚构旧账号', ?, 'ADMIN', ?)`).run(legacyUserId, legacyHash, timestamp);
    old.prepare(`INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`).run(sha256(legacyToken), legacyUserId, randomBytes(24).toString("hex"), new Date(Date.now() + 3600000).toISOString(), timestamp);
    old.close();
    for (let i = 0; i < 2; i++) {
      const migrated = createDatabase(filename);
      const column = migrated.pragma("table_info(users)").find(item => item.name === "must_change_password");
      assert.equal(column.dflt_value, "0");
      assert.equal(getSession(migrated, legacyToken).user.mustChangePassword, false);
      assert.equal(login(migrated, { username: "virtual-legacy", password: legacyPassword, sessionHours: 1 }).user.mustChangePassword, false);
      assert.equal(migrated.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(legacyUserId).password_hash, legacyHash);
      assert.deepEqual(migrated.pragma("foreign_key_check"), []);
      migrated.close();
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
