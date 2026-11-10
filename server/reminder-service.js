import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { nowIso } from "./database.js";
import { AppError, assert, ROLES } from "./domain.js";
import { canReadCustomer, canVpAccessCustomerForApproval, requireCustomerAccess } from "./permissions.js";

function reminderView(row, now = new Date()) {
  const overdue = row.status === "PENDING" && new Date(row.remind_at) < now;
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    relatedType: row.related_type,
    relatedId: row.related_id,
    title: row.title,
    remindAt: row.remind_at,
    originalRemindAt: row.original_remind_at,
    priority: row.priority,
    assignee: { id: row.assignee_id, displayName: row.assignee_name },
    source: row.source,
    assignedBy: { id: row.assigned_by, displayName: row.assigner_name },
    notes: row.notes,
    status: overdue ? "OVERDUE" : row.status,
    completedAt: row.completed_at,
    handledBy: row.handled_by ? { id: row.handled_by, displayName: row.handler_name } : null,
    handlingReason: row.handling_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const RELATED_TYPES = Object.freeze(["CONTACT", "FOLLOWUP", "SURVEY", "QUOTE_VERSION", "CONTRACT"]);

function relatedObject(db, actor, customerId, relatedType, relatedId) {
  if (!relatedType && !relatedId) return { type: "CUSTOMER", id: customerId, label: "客户档案", target: { page: "customer", customerId, tab: "overview" } };
  if (!RELATED_TYPES.includes(relatedType) || !relatedId) return null;
  if (actor.role === ROLES.VP && relatedType !== "QUOTE_VERSION") return null;
  if (relatedType === "CONTACT") {
    const row = db.prepare(`SELECT id, name FROM contacts WHERE id = ? AND customer_id = ?`).get(relatedId, customerId);
    return row ? { type: relatedType, id: row.id, label: `联系人：${row.name}`, target: { page: "customer", customerId, tab: "contacts" } } : null;
  }
  if (relatedType === "FOLLOWUP") {
    const row = db.prepare(`SELECT id, occurred_at FROM followups WHERE id = ? AND customer_id = ?`).get(relatedId, customerId);
    return row ? { type: relatedType, id: row.id, label: `跟进记录：${String(row.occurred_at).slice(0, 10)}`, target: { page: "customer", customerId, tab: "followups" } } : null;
  }
  if (relatedType === "SURVEY") {
    const row = db.prepare(`SELECT id, title FROM surveys WHERE id = ? AND customer_id = ?`).get(relatedId, customerId);
    return row ? { type: relatedType, id: row.id, label: `软件调研：${row.title}`, target: { page: "survey", id: row.id } } : null;
  }
  if (relatedType === "QUOTE_VERSION") {
    const row = db.prepare(`
      SELECT qv.id, qv.revision, qv.status, qv.approval_stage, q.quote_number
      FROM quote_versions qv JOIN quotes q ON q.id = qv.quote_id
      WHERE qv.id = ? AND q.customer_id = ?
    `).get(relatedId, customerId);
    if (!row || (actor.role === ROLES.VP && !(row.status === "APPROVED" || (row.status === "PENDING_VP" && (row.approval_stage || "VP") === "VP")))) return null;
    return { type: relatedType, id: row.id, label: `报价：${row.quote_number} V${row.revision}.0`, target: { page: "quote", id: row.id } };
  }
  const row = db.prepare(`SELECT id, contract_number FROM contracts WHERE id = ? AND customer_id = ?`).get(relatedId, customerId);
  if (!row || actor.role === ROLES.VP) return null;
  return { type: relatedType, id: row.id, label: `合同：${row.contract_number}`, target: { page: "contract", id: row.id } };
}

function canReadReminderCustomer(db, actor, customerId) {
  return canReadCustomer(db, actor, customerId) || canVpAccessCustomerForApproval(db, actor, customerId);
}

function canResolveReminder(db, actor, row) {
  if (row.source !== "LEADER" || (row.assigned_by !== actor.id && actor.role !== ROLES.ADMIN)) return false;
  const owner = db.prepare(`SELECT owner_id FROM customers WHERE id = ?`).get(row.customer_id);
  try { assertAssignment(db, actor, row.customer_id, owner?.owner_id); return true; } catch { return false; }
}

function actorReminderView(db, actor, row) {
  const businessObject = relatedObject(db, actor, row.customer_id, row.related_type, row.related_id);
  return { ...reminderView(row), relatedType: businessObject ? row.related_type : null, relatedId: businessObject ? row.related_id : null, businessObject, canResolve: row.status === "UNABLE_PENDING" && canResolveReminder(db, actor, row) };
}

function actorReminderSnapshot(db, actor, json) {
  if (!json) return null;
  const row = JSON.parse(json);
  if (!relatedObject(db, actor, row.customer_id, row.related_type, row.related_id)) {
    row.related_type = null;
    row.related_id = null;
  }
  return row;
}

const REMINDER_SELECT = `
  SELECT r.*, c.full_name AS customer_name,
    assignee.display_name AS assignee_name, assigner.display_name AS assigner_name,
    handler.display_name AS handler_name
  FROM reminders r
  JOIN customers c ON c.id = r.customer_id
  JOIN users assignee ON assignee.id = r.assignee_id
  JOIN users assigner ON assigner.id = r.assigned_by
  LEFT JOIN users handler ON handler.id = r.handled_by
`;

function assertAssignment(db, actor, customerId, assigneeId) {
  const customer = db.prepare(`SELECT owner_id FROM customers WHERE id = ?`).get(customerId);
  assert(customer, 404, "CUSTOMER_NOT_FOUND", "客户不存在或当前账号无权访问");
  const assignee = db.prepare(`SELECT id, role, manager_id, is_active FROM users WHERE id = ?`).get(assigneeId);
  assert(assignee?.is_active && assignee.role === ROLES.PRESALES, 400, "ASSIGNEE_INVALID", "提醒负责人必须是已启用的售前人员");
  assert(customer.owner_id === assignee.id, 400, "ASSIGNEE_NOT_OWNER", "提醒负责人必须是该客户当前负责人");
  if (actor.role === ROLES.PRESALES) {
    assert(actor.id === assignee.id && canReadCustomer(db, actor, customerId), 403, "REMINDER_ASSIGN_FORBIDDEN", "售前人员只能为本人负责的客户创建本人提醒");
  } else if (actor.role === ROLES.MANAGER) {
    assert(assignee.manager_id === actor.id, 403, "REMINDER_ASSIGN_FORBIDDEN", "只能向本人管理范围内的售前人员指派提醒");
  } else if (actor.role === ROLES.VP) {
    assert(canVpAccessCustomerForApproval(db, actor, customerId), 403, "REMINDER_ASSIGN_FORBIDDEN", "副总经理仅可向报价审批相关客户的负责人指派提醒");
  } else {
    assert(actor.role === ROLES.ADMIN, 403, "REMINDER_ASSIGN_FORBIDDEN", "当前账号无权指派提醒");
  }
}

export function createReminder(db, actor, input) {
  assert(input?.title?.trim(), 400, "REMINDER_TITLE_REQUIRED", "提醒事项不能为空");
  assert(input?.remindAt && !Number.isNaN(Date.parse(input.remindAt)), 400, "REMINDER_TIME_INVALID", "提醒时间无效");
  assert(["LOW", "MEDIUM", "HIGH"].includes(input.priority || "MEDIUM"), 400, "REMINDER_PRIORITY_INVALID", "提醒优先级无效");
  assertAssignment(db, actor, input.customerId, input.assigneeId || actor.id);
  const relatedType = String(input.relatedType || "").trim() || null;
  const relatedId = String(input.relatedId || "").trim() || null;
  assert(Boolean(relatedType) === Boolean(relatedId), 400, "REMINDER_RELATED_TARGET_INCOMPLETE", "关联业务对象类型和记录必须同时选择");
  const relation = relatedType ? relatedObject(db, actor, input.customerId, relatedType, relatedId) : null;
  assert(!relatedType || relation, 400, "REMINDER_RELATED_TARGET_INVALID", "关联业务对象不存在、不属于该客户或当前账号无权关联");
  const id = randomUUID();
  const timestamp = nowIso();
  const assigneeId = input.assigneeId || actor.id;
  const source = assigneeId === actor.id ? "SELF" : "LEADER";
  db.transaction(() => {
    db.prepare(`
      INSERT INTO reminders (
        id, customer_id, related_type, related_id, title, remind_at, original_remind_at,
        priority, assignee_id, source, assigned_by, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.customerId, relatedType, relatedId, input.title.trim(),
      new Date(input.remindAt).toISOString(), new Date(input.remindAt).toISOString(), input.priority || "MEDIUM",
      assigneeId, source, actor.id, input.notes || null, timestamp, timestamp
    );
    const created = db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id);
    db.prepare(`INSERT INTO reminder_events (id, reminder_id, event_type, actor_id, before_json, after_json, reason, created_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)`)
      .run(randomUUID(), id, source === "SELF" ? "CREATED" : "ASSIGNED", actor.id, JSON.stringify(created), timestamp);
    audit(db, { actorId: actor.id, action: source === "SELF" ? "REMINDER_CREATED" : "REMINDER_ASSIGNED", entityType: "REMINDER", entityId: id, summary: { assigneeId, customerId: input.customerId } });
  })();
  return getReminder(db, actor, id);
}

export function getReminder(db, actor, reminderId) {
  const row = db.prepare(`${REMINDER_SELECT} WHERE r.id = ?`).get(reminderId);
  if (!row || !canReadReminderCustomer(db, actor, row.customer_id) || (row.assignee_id !== actor.id && row.assigned_by !== actor.id && actor.role !== ROLES.ADMIN)) {
    throw new AppError(404, "REMINDER_NOT_FOUND", "提醒不存在或当前账号无权访问");
  }
  return actorReminderView(db, actor, row);
}

export function listReminderEvents(db, actor, reminderId) {
  getReminder(db, actor, reminderId);
  return db.prepare(`SELECT e.*, u.display_name AS actor_name FROM reminder_events e JOIN users u ON u.id = e.actor_id WHERE e.reminder_id = ? ORDER BY e.created_at, e.rowid`).all(reminderId).map(row => ({
    id: row.id, type: row.event_type, actor: { id: row.actor_id, displayName: row.actor_name }, reason: row.reason, createdAt: row.created_at,
    before: actorReminderSnapshot(db, actor, row.before_json), after: actorReminderSnapshot(db, actor, row.after_json)
  }));
}

export function listReminders(db, actor, { view = "mine", includeCompleted = true } = {}) {
  assert(["mine", "assigned", "confirmation"].includes(view), 400, "REMINDER_VIEW_INVALID", "提醒视图无效");
  const ownerColumn = view === "assigned" ? "r.assigned_by" : "r.assignee_id";
  const allAssigned = actor.role === ROLES.ADMIN && view !== "mine";
  const predicate = view === "confirmation" ? "r.status = 'UNABLE_PENDING'" : allAssigned ? "r.source = 'LEADER'" : `${ownerColumn} = ?`;
  const rows = db.prepare(`${REMINDER_SELECT} WHERE ${predicate} ${includeCompleted ? "" : "AND r.status IN ('PENDING','UNABLE_PENDING')"} ORDER BY r.remind_at ASC`).all(...(view === "confirmation" || allAssigned ? [] : [actor.id]));
  return rows.filter(row => canReadReminderCustomer(db, actor, row.customer_id) && (view !== "confirmation" || canResolveReminder(db, actor, row))).slice(0, 200).map(row => actorReminderView(db, actor, row));
}

export function listCustomerReminders(db, actor, customerId) {
  requireCustomerAccess(db, actor, customerId);
  return db.prepare(`${REMINDER_SELECT} WHERE r.customer_id = ? ORDER BY r.remind_at DESC, r.created_at DESC LIMIT 200`).all(customerId).map(row => actorReminderView(db, actor, row));
}

export function listReminderRelatedTargets(db, actor, customerId) {
  if (actor.role === ROLES.VP) assert(canVpAccessCustomerForApproval(db, actor, customerId), 404, "CUSTOMER_NOT_FOUND", "客户不存在或当前账号无权访问");
  else requireCustomerAccess(db, actor, customerId);
  const targets = [];
  if (actor.role !== ROLES.VP) {
    for (const row of db.prepare(`SELECT id FROM contacts WHERE customer_id = ? ORDER BY name`).all(customerId)) targets.push(relatedObject(db, actor, customerId, "CONTACT", row.id));
    for (const row of db.prepare(`SELECT id FROM followups WHERE customer_id = ? ORDER BY occurred_at DESC`).all(customerId)) targets.push(relatedObject(db, actor, customerId, "FOLLOWUP", row.id));
    for (const row of db.prepare(`SELECT id FROM surveys WHERE customer_id = ? ORDER BY updated_at DESC`).all(customerId)) targets.push(relatedObject(db, actor, customerId, "SURVEY", row.id));
    for (const row of db.prepare(`SELECT id FROM contracts WHERE customer_id = ? ORDER BY updated_at DESC`).all(customerId)) targets.push(relatedObject(db, actor, customerId, "CONTRACT", row.id));
  }
  const quoteRows = db.prepare(`
    SELECT qv.id FROM quote_versions qv JOIN quotes q ON q.id = qv.quote_id
    WHERE q.customer_id = ? ${actor.role === ROLES.VP ? "AND (qv.status = 'APPROVED' OR (qv.status = 'PENDING_VP' AND COALESCE(qv.approval_stage, 'VP') = 'VP'))" : ""}
    ORDER BY qv.created_at DESC
  `).all(customerId);
  for (const row of quoteRows) targets.push(relatedObject(db, actor, customerId, "QUOTE_VERSION", row.id));
  return targets.filter(Boolean);
}

export function actOnReminder(db, actor, reminderId, input) {
  const row = db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(reminderId);
  if (!row) throw new AppError(404, "REMINDER_NOT_FOUND", "提醒不存在或当前账号无权访问");
  getReminder(db, actor, reminderId);
  const action = input?.action;
  assert(["COMPLETE", "POSTPONE", "CANCEL", "REPORT_UNABLE", "CONFIRM_CLOSE", "RESTORE", "REASSIGN"].includes(action), 400, "REMINDER_ACTION_INVALID", "提醒操作无效");
  const resolving = ["CONFIRM_CLOSE", "RESTORE", "REASSIGN"].includes(action);
  assert(row.status === (resolving ? "UNABLE_PENDING" : "PENDING"), 409, "REMINDER_NOT_PENDING", "当前提醒状态不允许该操作");
  if (resolving) {
    assert(canResolveReminder(db, actor, row), 403, "REMINDER_RESOLVE_FORBIDDEN", "仅当前有权指派人或管理员可以确认处理");
    assert(input.reason?.trim(), 400, "REMINDER_REASON_REQUIRED", "确认处理必须填写原因");
    if (action !== "CONFIRM_CLOSE") assertAssignment(db, actor, row.customer_id, action === "REASSIGN" ? input.assigneeId : row.assignee_id);
  }
  const timestamp = nowIso();
  db.transaction(() => {
    if (action === "REPORT_UNABLE") {
      assert(row.source === "LEADER" && row.assignee_id === actor.id, 403, "REMINDER_REPORT_FORBIDDEN", "只有被指派人可以上报无法完成");
      assert(input.reason?.trim(), 400, "REMINDER_REASON_REQUIRED", "无法完成时必须填写原因");
      db.prepare(`UPDATE reminders SET status = 'UNABLE_PENDING', handled_by = ?, handling_reason = ?, updated_at = ? WHERE id = ?`).run(actor.id, input.reason.trim(), timestamp, reminderId);
    }
    if (resolving) {
      db.prepare(`UPDATE reminders SET status = ?, assignee_id = ?, handled_by = ?, handling_reason = ?, updated_at = ? WHERE id = ?`).run(action === "CONFIRM_CLOSE" ? "CANCELED" : "PENDING", action === "REASSIGN" ? input.assigneeId : row.assignee_id, actor.id, input.reason.trim(), timestamp, reminderId);
    }
    if (action === "COMPLETE") {
      assert(row.assignee_id === actor.id, 403, "REMINDER_COMPLETE_FORBIDDEN", "仅提醒负责人可以完成该提醒");
      db.prepare(`UPDATE reminders SET status = 'COMPLETED', completed_at = ?, handled_by = ?, handling_reason = ?, updated_at = ? WHERE id = ?`)
        .run(timestamp, actor.id, input.reason?.trim() || null, timestamp, reminderId);
    }
    if (action === "POSTPONE") {
      assert(row.assignee_id === actor.id, 403, "REMINDER_POSTPONE_FORBIDDEN", "仅提醒负责人可以延期该提醒");
      assert(input.remindAt && !Number.isNaN(Date.parse(input.remindAt)), 400, "REMINDER_TIME_INVALID", "新的提醒时间无效");
      if (row.source === "LEADER") assert(input.reason?.trim(), 400, "REMINDER_REASON_REQUIRED", "领导指派的提醒延期时必须填写原因");
      db.prepare(`UPDATE reminders SET remind_at = ?, handled_by = ?, handling_reason = ?, updated_at = ? WHERE id = ?`)
        .run(new Date(input.remindAt).toISOString(), actor.id, input.reason?.trim() || null, timestamp, reminderId);
    }
    if (action === "CANCEL") {
      const canCancelSelf = row.source === "SELF" && row.assignee_id === actor.id;
      const canCancelAssignment = row.source === "LEADER" && row.assigned_by === actor.id;
      assert(canCancelSelf || canCancelAssignment || actor.role === ROLES.ADMIN, 403, "REMINDER_CANCEL_FORBIDDEN", "被指派人不能取消领导指派的提醒");
      if (row.source === "LEADER") assert(canResolveReminder(db, actor, row), 403, "REMINDER_RESOLVE_FORBIDDEN", "当前指派权限已失效");
      if (row.source === "LEADER") assert(input.reason?.trim(), 400, "REMINDER_REASON_REQUIRED", "取消领导指派的提醒必须填写原因");
      db.prepare(`UPDATE reminders SET status = 'CANCELED', handled_by = ?, handling_reason = ?, updated_at = ? WHERE id = ?`)
        .run(actor.id, input.reason?.trim() || null, timestamp, reminderId);
    }
    const updated = db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(reminderId);
    const eventTypes = { COMPLETE: "COMPLETED", POSTPONE: "POSTPONED", CANCEL: "CANCELED", REPORT_UNABLE: "UNABLE_REPORTED", CONFIRM_CLOSE: "CLOSE_CONFIRMED", RESTORE: "RESTORED", REASSIGN: "REASSIGNED" };
    db.prepare(`INSERT INTO reminder_events (id, reminder_id, event_type, actor_id, before_json, after_json, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), reminderId, eventTypes[action], actor.id, JSON.stringify(row), JSON.stringify(updated), input.reason?.trim() || null, timestamp);
    audit(db, { actorId: actor.id, action: `REMINDER_${action}`, entityType: "REMINDER", entityId: reminderId, summary: { reasonProvided: Boolean(input.reason?.trim()) } });
  })();
  return getReminder(db, actor, reminderId);
}
