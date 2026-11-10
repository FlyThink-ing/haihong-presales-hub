import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { nowIso } from "./database.js";
import { assert } from "./domain.js";

export function findCurrentQuoteManager(db, customerId) {
  const directManager = db.prepare(`
    SELECT m.id, m.display_name AS displayName, m.position_code AS positionCode, m.is_active AS active
    FROM customers c
    JOIN users owner ON owner.id = c.owner_id
    JOIN users m ON m.id = owner.manager_id
    WHERE c.id = ? AND m.role = 'MANAGER'
  `).get(customerId);
  if (!directManager) return null;
  if (directManager.positionCode === "RND_MANAGER") {
    return directManager.active ? { id: directManager.id, displayName: directManager.displayName } : null;
  }
  const researchManagers = db.prepare(`SELECT id, display_name AS displayName FROM users WHERE role = 'MANAGER' AND position_code = 'RND_MANAGER' AND is_active = 1 ORDER BY created_at, id`).all();
  return researchManagers.length === 1 ? researchManagers[0] : null;
}

export function requireCurrentQuoteManager(db, customerId) {
  const manager = findCurrentQuoteManager(db, customerId);
  assert(manager, 409, "QUOTE_MANAGER_REQUIRED", "待审报价必须配置唯一且已启用的研发经理");
  return manager;
}

// 由负责人调整事务调用；只增交接事实，不修改 quote_versions 或审批快照。
export function recordPendingQuoteHandoffs(db, actor, customerIds, previousManagerId, { reason, changeType }) {
  for (const customerId of customerIds) {
    const versions = db.prepare(`SELECT qv.id FROM quote_versions qv JOIN quotes q ON q.id = qv.quote_id WHERE q.customer_id = ? AND qv.status = 'PENDING_MANAGER'`).all(customerId);
    if (!versions.length) continue;
    const manager = requireCurrentQuoteManager(db, customerId);
    if (previousManagerId === manager.id) continue;
    for (const version of versions) {
      const summary = { previousManagerId, newManagerId: manager.id, reason, changeType };
      db.prepare(`INSERT INTO quote_manager_handoffs (id, quote_version_id, previous_manager_id, new_manager_id, operated_by, reason, change_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), version.id, previousManagerId, manager.id, actor.id, reason, changeType, nowIso());
      audit(db, { actorId: actor.id, action: "QUOTE_MANAGER_HANDOFF", entityType: "QUOTE_VERSION", entityId: version.id, summary });
    }
  }
}

export function listQuoteHandoffs(db, versionId) {
  return db.prepare(`SELECT h.*, old.display_name AS previous_name, next.display_name AS new_name, actor.display_name AS actor_name FROM quote_manager_handoffs h LEFT JOIN users old ON old.id = h.previous_manager_id JOIN users next ON next.id = h.new_manager_id JOIN users actor ON actor.id = h.operated_by WHERE h.quote_version_id = ? ORDER BY h.created_at, h.rowid`).all(versionId).map(row => ({
    id: row.id, previousManager: row.previous_manager_id ? { id: row.previous_manager_id, displayName: row.previous_name } : null,
    newManager: { id: row.new_manager_id, displayName: row.new_name }, operatedBy: { id: row.operated_by, displayName: row.actor_name },
    reason: row.reason, changeType: row.change_type, createdAt: row.created_at
  }));
}
