import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { nowIso } from "./database.js";
import { AppError, assert, MANAGER_POSITIONS } from "./domain.js";
import { hashPassword, newOpaqueToken, sha256, verifyPassword } from "./security.js";
import { recordPendingQuoteHandoffs } from "./quote-handoff-service.js";

const SAFE_USER_COLUMNS = "id, username, display_name, role, manager_id, position_code, phone, email, regions_json, home_city, is_active, must_change_password";

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    managerId: row.manager_id,
    positionCode: row.position_code || (row.role === "MANAGER" ? MANAGER_POSITIONS.RND_MANAGER : null),
    phone: row.phone,
    email: row.email,
    regions: JSON.parse(row.regions_json || "[]"),
    homeCity: row.home_city,
    active: Boolean(row.is_active),
    mustChangePassword: Boolean(row.must_change_password)
  };
}

export function createUser(db, input, actorId = null) {
  assert(input?.username?.trim(), 400, "USERNAME_REQUIRED", "用户名不能为空");
  assert(input?.displayName?.trim(), 400, "DISPLAY_NAME_REQUIRED", "姓名不能为空");
  assert(["PRESALES", "MANAGER", "VP", "ADMIN"].includes(input.role), 400, "ROLE_INVALID", "用户角色无效");
  const positionCode = input.role === "MANAGER"
    ? (input.positionCode === MANAGER_POSITIONS.GENERAL_MANAGER ? MANAGER_POSITIONS.GENERAL_MANAGER : MANAGER_POSITIONS.RND_MANAGER)
    : null;
  if (input.role === "PRESALES") {
    const manager = db.prepare(`SELECT role, position_code, is_active FROM users WHERE id = ?`).get(input.managerId);
    assert(manager?.is_active && manager.role === "MANAGER", 400, "MANAGER_REQUIRED", "售前人员必须关联一名已启用的部门经理");
  }
  const id = randomUUID();
  const createdAt = nowIso();
  const passwordHash = hashPassword(input.password);
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, username, display_name, password_hash, role, manager_id, position_code, phone, email, regions_json, home_city, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.username.trim(),
        input.displayName.trim(),
        passwordHash,
        input.role,
        input.managerId || null,
        positionCode,
        input.phone || null,
        input.email || null,
        JSON.stringify(input.regions || []),
        input.homeCity || null,
        createdAt
      );
      if (input.role === "PRESALES") {
        db.prepare(`
          INSERT INTO user_manager_history (id, user_id, previous_manager_id, new_manager_id, changed_by, reason, effective_at)
          VALUES (?, ?, NULL, ?, ?, ?, ?)
        `).run(randomUUID(), id, input.managerId, actorId, "账号创建时建立直属关系", createdAt);
      }
      audit(db, { actorId, action: "USER_CREATED", entityType: "USER", entityId: id, summary: { role: input.role, positionCode, managerId: input.managerId || null } });
    })();
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw new AppError(409, "USERNAME_EXISTS", "用户名已存在");
    throw error;
  }
  return publicUser(db.prepare(`SELECT ${SAFE_USER_COLUMNS} FROM users WHERE id = ?`).get(id));
}

export function updateOwnProfile(db, actor, input) {
  const phone = String(input?.phone || "").trim();
  const email = String(input?.email || "").trim().toLowerCase();
  assert(phone.length >= 5 && phone.length <= 30, 400, "USER_PHONE_INVALID", "请填写有效的本人手机号码");
  assert(email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 400, "USER_EMAIL_INVALID", "请填写有效的本人邮箱");
  const before = db.prepare(`SELECT phone, email FROM users WHERE id = ? AND is_active = 1`).get(actor.id);
  assert(before, 404, "USER_NOT_FOUND", "当前账号不存在或已停用");
  db.transaction(() => {
    db.prepare(`UPDATE users SET phone = ?, email = ? WHERE id = ?`).run(phone, email, actor.id);
    audit(db, {
      actorId: actor.id,
      action: "USER_PROFILE_UPDATED",
      entityType: "USER",
      entityId: actor.id,
      summary: { changedFields: [before.phone !== phone ? "phone" : null, before.email !== email ? "email" : null].filter(Boolean) }
    });
  })();
  return publicUser(db.prepare(`SELECT ${SAFE_USER_COLUMNS} FROM users WHERE id = ?`).get(actor.id));
}

export function setUserActive(db, actor, userId, active) {
  assert(actor.role === "ADMIN", 403, "USER_ADMIN_FORBIDDEN", "仅管理员可以调整账号状态");
  assert(typeof active === "boolean", 400, "USER_STATUS_INVALID", "账号状态无效");
  const user = db.prepare(`SELECT ${SAFE_USER_COLUMNS} FROM users WHERE id = ?`).get(userId);
  assert(user, 404, "USER_NOT_FOUND", "用户不存在");
  assert(user.id !== actor.id || active, 400, "ADMIN_SELF_DISABLE", "管理员不能停用当前登录账号");
  if (!active && user.role === "MANAGER") {
    const directReports = db.prepare(`SELECT COUNT(*) AS count FROM users WHERE manager_id = ? AND role = 'PRESALES' AND is_active = 1`).get(userId).count;
    assert(directReports === 0, 409, "MANAGER_HAS_ACTIVE_REPORTS", "请先变更其名下售前人员的当前部门负责人");
  }
  db.transaction(() => {
    db.prepare(`UPDATE users SET is_active = ? WHERE id = ?`).run(active ? 1 : 0, userId);
    if (!active) db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
    audit(db, { actorId: actor.id, action: active ? "USER_ENABLED" : "USER_DISABLED", entityType: "USER", entityId: userId });
  })();
  return publicUser(db.prepare(`SELECT ${SAFE_USER_COLUMNS} FROM users WHERE id = ?`).get(userId));
}

export function resetUserPassword(db, actor, userId, newPassword) {
  assert(actor.role === "ADMIN", 403, "USER_ADMIN_FORBIDDEN", "仅管理员可以重置密码");
  const user = db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId);
  assert(user, 404, "USER_NOT_FOUND", "用户不存在");
  const passwordHash = hashPassword(newPassword);
  db.transaction(() => {
    db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?`).run(passwordHash, userId);
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
    audit(db, { actorId: actor.id, action: "USER_PASSWORD_RESET", entityType: "USER", entityId: userId, summary: { sessionsRevoked: true, mustChangePassword: true } });
  })();
  return { id: userId, reset: true, mustChangePassword: true };
}

export function changeOwnPassword(db, session, { currentPassword, newPassword }, sessionHours) {
  const row = db.prepare(`SELECT * FROM users WHERE id = ? AND is_active = 1`).get(session.user.id);
  assert(row && verifyPassword(String(currentPassword || ""), row.password_hash), 400, "CURRENT_PASSWORD_INVALID", "当前密码不正确");
  assert(!verifyPassword(String(newPassword || ""), row.password_hash), 400, "PASSWORD_UNCHANGED", "新密码不能与当前密码相同");
  assert(typeof newPassword === "string" && newPassword.length >= 12, 400, "PASSWORD_INVALID", "密码长度至少为 12 位");
  const passwordHash = hashPassword(newPassword);
  return db.transaction(() => {
    // 只使用已认证会话的本人 ID；撤销该账号全部临时会话，并轮换会话及 CSRF。
    assert(db.prepare(`SELECT 1 FROM sessions WHERE token_hash = ?`).get(session.tokenHash), 401, "AUTH_REQUIRED", "请重新登录");
    db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`).run(passwordHash, row.id);
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(row.id);
    audit(db, { actorId: row.id, action: "USER_PASSWORD_CHANGED", entityType: "USER", entityId: row.id, summary: { forced: Boolean(row.must_change_password), sessionsRevoked: true } });
    return login(db, { username: row.username, password: newPassword, sessionHours });
  })();
}

export function changeUserManager(db, actor, userId, { managerId, reason }) {
  assert(actor.role === "ADMIN", 403, "USER_ADMIN_FORBIDDEN", "仅管理员可以变更直属负责人");
  assert(reason?.trim(), 400, "MANAGER_CHANGE_REASON_REQUIRED", "变更直属负责人必须填写原因");
  const user = db.prepare(`SELECT id, role, manager_id FROM users WHERE id = ?`).get(userId);
  assert(user?.role === "PRESALES", 400, "PRESALES_USER_REQUIRED", "只能为售前人员变更直属负责人");
  const manager = db.prepare(`SELECT id, role, position_code, is_active FROM users WHERE id = ?`).get(managerId);
  assert(manager?.role === "MANAGER" && manager.is_active, 400, "MANAGER_INVALID", "新的直属经理无效或已停用");
  assert(user.manager_id !== managerId, 400, "MANAGER_UNCHANGED", "新的部门负责人不能与当前负责人相同");
  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE users SET manager_id = ? WHERE id = ?`).run(managerId, userId);
    const customerIds = db.prepare(`SELECT id FROM customers WHERE owner_id = ?`).all(userId).map(row => row.id);
    recordPendingQuoteHandoffs(db, actor, customerIds, user.manager_id, { reason: reason.trim(), changeType: "USER_MANAGER_CHANGE" });
    db.prepare(`
      INSERT INTO user_manager_history (id, user_id, previous_manager_id, new_manager_id, changed_by, reason, effective_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), userId, user.manager_id, managerId, actor.id, reason.trim(), timestamp);
    audit(db, { actorId: actor.id, action: "USER_MANAGER_CHANGED", entityType: "USER", entityId: userId, summary: { previousManagerId: user.manager_id, newManagerId: managerId, reason: reason.trim() } });
  })();
  return publicUser(db.prepare(`SELECT ${SAFE_USER_COLUMNS} FROM users WHERE id = ?`).get(userId));
}

export function login(db, { username, password, sessionHours }) {
  const row = db.prepare(`SELECT * FROM users WHERE username = ?`).get(String(username || "").trim());
  if (!row || !row.is_active || !verifyPassword(String(password || ""), row.password_hash)) {
    throw new AppError(401, "LOGIN_FAILED", "用户名或密码错误，或账号已停用");
  }
  const token = newOpaqueToken();
  const csrfToken = newOpaqueToken(24);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + sessionHours * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(createdAt);
  db.prepare(`INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(sha256(token), row.id, csrfToken, expiresAt, createdAt);
  audit(db, { actorId: row.id, action: "LOGIN", entityType: "USER", entityId: row.id });
  return { token, csrfToken, expiresAt, user: publicUser(row) };
}

export function getSession(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.token_hash, s.csrf_token, s.expires_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1
  `).get(sha256(token), nowIso());
  if (!row) return null;
  return { tokenHash: row.token_hash, csrfToken: row.csrf_token, expiresAt: row.expires_at, user: publicUser(row) };
}

export function logout(db, session, actorId) {
  if (session) db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(session.tokenHash);
  if (actorId) audit(db, { actorId, action: "LOGOUT", entityType: "USER", entityId: actorId });
}
