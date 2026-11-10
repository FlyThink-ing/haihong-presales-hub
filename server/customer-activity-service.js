import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { nowIso } from "./database.js";
import { AppError, assert, ROLES } from "./domain.js";
import { canReadCustomer, requireCustomerAccess } from "./permissions.js";
import { createReminder } from "./reminder-service.js";
import { validCalendarDay } from "./historical-followup-parser.js";

export function requireCustomerWrite(db, actor, customerId) {
  const customer = db.prepare(`SELECT id, owner_id FROM customers WHERE id = ?`).get(customerId);
  assert(customer && canReadCustomer(db, actor, customerId), 404, "CUSTOMER_NOT_FOUND", "客户不存在或当前账号无权访问");
  assert(actor.role === ROLES.ADMIN || (actor.role === ROLES.PRESALES && customer.owner_id === actor.id), 403, "CUSTOMER_WRITE_FORBIDDEN", "仅客户当前负责人可以维护该客户档案");
  return customer;
}

function contactView(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    name: row.name,
    department: row.department,
    title: row.title,
    mobile: row.mobile,
    wechat: row.wechat,
    email: row.email,
    decisionRole: row.decision_role,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listContacts(db, actor, customerId, { companyDirectory = false } = {}) {
  requireCustomerAccess(db, actor, customerId, { companyDirectory });
  return db.prepare(`SELECT * FROM contacts WHERE customer_id = ? ORDER BY updated_at DESC`).all(customerId).map(contactView);
}

export function createContact(db, actor, customerId, input) {
  requireCustomerWrite(db, actor, customerId);
  assert(input?.name?.trim(), 400, "CONTACT_NAME_REQUIRED", "联系人姓名不能为空");
  const id = randomUUID();
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO contacts (id, customer_id, name, department, title, mobile, wechat, email, decision_role, notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, customerId, input.name.trim(), input.department || null, input.title || null, input.mobile || null, input.wechat || null, input.email || null, input.decisionRole || null, input.notes || null, actor.id, timestamp, timestamp);
  audit(db, { actorId: actor.id, action: "CONTACT_CREATED", entityType: "CONTACT", entityId: id, summary: { customerId } });
  return contactView(db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(id));
}

export function updateContact(db, actor, contactId, input) {
  const current = db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(contactId);
  if (!current) throw new AppError(404, "CONTACT_NOT_FOUND", "联系人不存在或当前账号无权访问");
  requireCustomerWrite(db, actor, current.customer_id);
  assert(input?.name?.trim(), 400, "CONTACT_NAME_REQUIRED", "联系人姓名不能为空");
  const timestamp = nowIso();
  db.prepare(`
    UPDATE contacts SET name = ?, department = ?, title = ?, mobile = ?, wechat = ?, email = ?, decision_role = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `).run(input.name.trim(), input.department || null, input.title || null, input.mobile || null, input.wechat || null, input.email || null, input.decisionRole || null, input.notes || null, timestamp, contactId);
  audit(db, { actorId: actor.id, action: "CONTACT_UPDATED", entityType: "CONTACT", entityId: contactId, summary: { customerId: current.customer_id } });
  return contactView(db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(contactId));
}

function projectView(row) {
  return { id: row.id, customerId: row.customer_id, name: row.name, summary: row.summary, active: Boolean(row.is_active), createdAt: row.created_at };
}

export function listProjects(db, actor, customerId = null) {
  if (customerId) {
    requireCustomerAccess(db, actor, customerId);
    return db.prepare(`SELECT * FROM projects WHERE customer_id = ? ORDER BY created_at DESC`).all(customerId).map(projectView);
  }
  if (actor.role === ROLES.VP) return [];
  const customers = db.prepare(`SELECT id FROM customers`).all().filter(row => canReadCustomer(db, actor, row.id)).map(row => row.id);
  if (!customers.length) return [];
  return db.prepare(`SELECT * FROM projects WHERE customer_id IN (${customers.map(() => "?").join(",")}) ORDER BY created_at DESC`).all(...customers).map(projectView);
}

export function createProject(db, actor, customerId, input) {
  requireCustomerWrite(db, actor, customerId);
  assert(input?.name?.trim(), 400, "PROJECT_NAME_REQUIRED", "项目名称不能为空");
  const id = randomUUID();
  const timestamp = nowIso();
  db.prepare(`INSERT INTO projects (id, customer_id, name, summary, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, customerId, input.name.trim(), input.summary || null, timestamp);
  audit(db, { actorId: actor.id, action: "PROJECT_CREATED", entityType: "PROJECT", entityId: id, summary: { customerId } });
  return projectView(db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id));
}

function followupView(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    project: row.project_id ? { id: row.project_id, name: row.project_name } : null,
    contact: row.contact_id ? { id: row.contact_id, name: row.contact_name } : null,
    method: row.method,
    occurredAt: row.occurred_at,
    occurredPrecision: row.occurred_precision,
    historical: Boolean(row.is_historical),
    source: row.source_sha256 ? { sourceSha256: row.source_sha256, sheetName: row.sheet_name, cellReference: row.cell_reference, paragraphNumber: row.paragraph_number, rawDate: row.raw_date, rawMethod: row.raw_method, rawText: row.raw_text, batchId: row.import_job_id, operatedBy: row.operated_by, importedAt: row.imported_at } : null,
    participants: JSON.parse(row.participants_json || "[]"),
    content: row.content,
    customerFeedback: row.customer_feedback,
    nextAction: row.next_action,
    recordedBy: { id: row.recorded_by, displayName: row.recorder_name },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const FOLLOWUP_SELECT = `
  SELECT f.*, p.name AS project_name, ct.name AS contact_name, u.display_name AS recorder_name,
    s.source_sha256, s.sheet_name, s.cell_reference, s.paragraph_number, s.raw_date, s.raw_method, s.raw_text, s.import_job_id, s.operated_by, s.imported_at
  FROM followups f
  LEFT JOIN projects p ON p.id = f.project_id
  LEFT JOIN contacts ct ON ct.id = f.contact_id
  JOIN users u ON u.id = f.recorded_by
  LEFT JOIN followup_import_origins s ON s.followup_id = f.id
`;

export function listFollowups(db, actor, customerId) {
  requireCustomerAccess(db, actor, customerId);
  return db.prepare(`${FOLLOWUP_SELECT} WHERE f.customer_id = ? ORDER BY f.occurred_at DESC, f.created_at DESC`).all(customerId).map(followupView);
}

function validateLinks(db, customerId, input) {
  if (input.projectId) assert(db.prepare(`SELECT 1 FROM projects WHERE id = ? AND customer_id = ?`).get(input.projectId, customerId), 400, "FOLLOWUP_PROJECT_INVALID", "跟进项目与客户不匹配");
  if (input.contactId) assert(db.prepare(`SELECT 1 FROM contacts WHERE id = ? AND customer_id = ?`).get(input.contactId, customerId), 400, "FOLLOWUP_CONTACT_INVALID", "跟进联系人与客户不匹配");
}

export function createFollowup(db, actor, customerId, input) {
  const customer = requireCustomerWrite(db, actor, customerId);
  assert(["PHONE", "WECHAT", "ONSITE", "MEETING", "EMAIL", "OTHER"].includes(input?.method), 400, "FOLLOWUP_METHOD_INVALID", "跟进方式无效");
  assert(input?.occurredAt && !Number.isNaN(Date.parse(input.occurredAt)), 400, "FOLLOWUP_TIME_INVALID", "跟进时间无效");
  assert(input?.content?.trim(), 400, "FOLLOWUP_CONTENT_REQUIRED", "沟通内容不能为空");
  assert(input?.nextAction?.trim(), 400, "FOLLOWUP_NEXT_ACTION_REQUIRED", "下一步行动不能为空");
  validateLinks(db, customerId, input);
  const id = randomUUID();
  const timestamp = nowIso();
  let reminder = null;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO followups (id, customer_id, project_id, contact_id, method, occurred_at, participants_json, content, customer_feedback, next_action, recorded_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, customerId, input.projectId || null, input.contactId || null, input.method, new Date(input.occurredAt).toISOString(), JSON.stringify(input.participants || []), input.content.trim(), input.customerFeedback || null, input.nextAction.trim(), actor.id, timestamp, timestamp);
    audit(db, { actorId: actor.id, action: "FOLLOWUP_CREATED", entityType: "FOLLOWUP", entityId: id, summary: { customerId, method: input.method } });
    if (input.nextReminder) {
      reminder = createReminder(db, actor, {
        customerId,
        relatedType: "FOLLOWUP",
        relatedId: id,
        title: input.nextReminder.title || input.nextAction.trim(),
        remindAt: input.nextReminder.remindAt,
        priority: input.nextReminder.priority || "MEDIUM",
        assigneeId: customer.owner_id,
        notes: input.nextReminder.notes || null
      });
    }
  })();
  return { followup: followupView(db.prepare(`${FOLLOWUP_SELECT} WHERE f.id = ?`).get(id)), reminder };
}

// 仅由历史导入服务在来源唯一约束事务内调用；普通新增 API 不开放此入口。
export function createHistoricalFollowup(db, actor, customerId, entry) {
  requireCustomerWrite(db, actor, customerId);
  assert(validCalendarDay(entry.occurredOn), 400, "FOLLOWUP_DAY_INVALID", "历史跟进必须有合法年月日，不补充拜访时刻");
  assert(entry.rawText?.trim(), 400, "FOLLOWUP_CONTENT_REQUIRED", "历史全文不能为空");
  const id = randomUUID();
  const timestamp = nowIso();
  db.prepare(`INSERT INTO followups (id, customer_id, method, occurred_at, occurred_precision, is_historical, content, next_action, recorded_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'DAY', 1, ?, '', ?, ?, ?)`)
    .run(id, customerId, entry.method, entry.occurredOn, entry.rawText, actor.id, timestamp, timestamp);
  return id;
}

export function updateFollowup(db, actor, followupId, input) {
  const current = db.prepare(`SELECT * FROM followups WHERE id = ?`).get(followupId);
  if (!current) throw new AppError(404, "FOLLOWUP_NOT_FOUND", "跟进记录不存在或当前账号无权访问");
  requireCustomerWrite(db, actor, current.customer_id);
  assert(input?.changeReason?.trim(), 400, "FOLLOWUP_CHANGE_REASON_REQUIRED", "修改历史跟进必须填写纠正原因");
  const merged = {
    projectId: input.projectId === undefined ? current.project_id : input.projectId,
    contactId: input.contactId === undefined ? current.contact_id : input.contactId,
    method: input.method ?? current.method,
    occurredAt: input.occurredAt ?? current.occurred_at,
    participants: input.participants ?? JSON.parse(current.participants_json || "[]"),
    content: input.content ?? current.content,
    customerFeedback: input.customerFeedback ?? current.customer_feedback,
    nextAction: input.nextAction ?? current.next_action
  };
  assert(["PHONE", "WECHAT", "ONSITE", "MEETING", "EMAIL", "OTHER"].includes(merged.method), 400, "FOLLOWUP_METHOD_INVALID", "跟进方式无效");
  assert(input.occurredPrecision === undefined || input.occurredPrecision === current.occurred_precision, 400, "FOLLOWUP_PRECISION_LOCKED", "纠正记录不能把日精度变成推测的拜访时刻");
  assert(current.occurred_precision === "DAY" ? validCalendarDay(merged.occurredAt) : merged.occurredAt && !Number.isNaN(Date.parse(merged.occurredAt)), 400, "FOLLOWUP_TIME_INVALID", "跟进日期/时间无效，历史日精度只能填写年月日");
  assert(merged.content?.trim() && (current.is_historical || merged.nextAction?.trim()), 400, "FOLLOWUP_FIELD_REQUIRED", "沟通内容和下一步行动不能为空");
  validateLinks(db, current.customer_id, merged);
  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare(`INSERT INTO followup_revisions (id, followup_id, before_json, changed_by, reason, changed_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), followupId, JSON.stringify(current), actor.id, input.changeReason.trim(), timestamp);
    db.prepare(`
      UPDATE followups SET project_id = ?, contact_id = ?, method = ?, occurred_at = ?, participants_json = ?, content = ?, customer_feedback = ?, next_action = ?, updated_at = ?
      WHERE id = ?
    `).run(merged.projectId || null, merged.contactId || null, merged.method, current.occurred_precision === "DAY" ? merged.occurredAt : new Date(merged.occurredAt).toISOString(), JSON.stringify(merged.participants), merged.content.trim(), merged.customerFeedback || null, (merged.nextAction || "").trim(), timestamp, followupId);
    audit(db, { actorId: actor.id, action: "FOLLOWUP_UPDATED", entityType: "FOLLOWUP", entityId: followupId, summary: { customerId: current.customer_id, reason: input.changeReason.trim() } });
  })();
  return followupView(db.prepare(`${FOLLOWUP_SELECT} WHERE f.id = ?`).get(followupId));
}
