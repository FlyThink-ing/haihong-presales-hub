import { randomUUID } from "node:crypto";
import { nowIso } from "./database.js";

export function audit(db, { actorId = null, action, entityType, entityId, summary = {} }) {
  db.prepare(`
    INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, summary_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), actorId, action, entityType, entityId, JSON.stringify(summary), nowIso());
}

