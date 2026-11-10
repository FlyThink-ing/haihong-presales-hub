import { AppError, MANAGER_POSITIONS, QUOTE_APPROVAL_STAGES, ROLES } from "./domain.js";
import { findCurrentQuoteManager } from "./quote-handoff-service.js";

export function canReadAllCustomersAndQuotes(actor) {
  return [ROLES.ADMIN, ROLES.MANAGER, ROLES.VP].includes(actor.role);
}

export function managedUserIds(db, actor) {
  if (actor.role === ROLES.ADMIN || actor.role === ROLES.VP) {
    return db.prepare(`SELECT id FROM users WHERE role = 'PRESALES' AND is_active = 1`).all().map(row => row.id);
  }
  if (actor.role === ROLES.MANAGER) {
    return db.prepare(`SELECT id FROM users WHERE manager_id = ? AND role = 'PRESALES' AND is_active = 1`).all(actor.id).map(row => row.id);
  }
  return actor.role === ROLES.PRESALES ? [actor.id] : [];
}

export function canReadCustomer(db, actor, customerId) {
  const customer = db.prepare(`SELECT owner_id FROM customers WHERE id = ?`).get(customerId);
  if (!customer) return false;
  if (actor.role === ROLES.ADMIN) return true;
  if (actor.role === ROLES.PRESALES) return customer.owner_id === actor.id;
  if (actor.role === ROLES.MANAGER) {
    return Boolean(db.prepare(`SELECT 1 FROM users WHERE id = ? AND manager_id = ?`).get(customer.owner_id, actor.id));
  }
  return false;
}

export function requireCustomerAccess(db, actor, customerId, { companyDirectory = false } = {}) {
  const allowed = companyDirectory && canReadAllCustomersAndQuotes(actor)
    ? Boolean(db.prepare("SELECT 1 FROM customers WHERE id = ?").get(customerId))
    : canReadCustomer(db, actor, customerId);
  if (!allowed) {
    throw new AppError(404, "CUSTOMER_NOT_FOUND", "客户不存在或当前账号无权访问");
  }
}

// 整个工作簿可能包含多客户：单客户权限不能变成整批来源权限。
export function canReadImportSource(db, actor, sourceSha256) {
  if (actor.role === ROLES.ADMIN) return true;
  const origins = db.prepare(`
    SELECT DISTINCT customer_id FROM (
      SELECT o.customer_id FROM customer_import_origins o JOIN stored_files f ON f.id = o.source_file_id WHERE f.sha256 = ?
      UNION ALL
      SELECT o.customer_id FROM visit_import_origins o WHERE o.source_sha256 = ?
      UNION ALL
      SELECT d.customer_id FROM weekly_report_decisions d JOIN weekly_report_origins o ON o.source_key = d.source_key WHERE o.source_sha256 = ? AND d.customer_id IS NOT NULL
    )
  `).all(sourceSha256, sourceSha256, sourceSha256);
  return origins.every(row => canReadCustomer(db, actor, row.customer_id));
}

export function canReadImportJob(db, actor, jobId) {
  const job = db.prepare(`SELECT j.created_by, f.sha256 FROM import_jobs j LEFT JOIN stored_files f ON f.id = j.file_id WHERE j.id = ?`).get(jobId);
  if (!job) return false;
  if (actor.role === ROLES.ADMIN) return true;
  if (job.created_by !== actor.id || actor.role === ROLES.VP) return false;
  return canReadImportSource(db, actor, job.sha256);
}

export function canApproveCustomerQuote(db, actor, customerId, stage) {
  const customer = db.prepare(`SELECT owner_id FROM customers WHERE id = ?`).get(customerId);
  if (!customer) return false;
  if (actor.role === ROLES.ADMIN) return true;
  if (stage === QUOTE_APPROVAL_STAGES.MANAGER && actor.role === ROLES.MANAGER && actor.positionCode !== MANAGER_POSITIONS.GENERAL_MANAGER) {
    return findCurrentQuoteManager(db, customerId)?.id === actor.id;
  }
  if (stage === QUOTE_APPROVAL_STAGES.GENERAL_MANAGER) {
    return actor.role === ROLES.MANAGER && actor.positionCode === MANAGER_POSITIONS.GENERAL_MANAGER;
  }
  return stage === QUOTE_APPROVAL_STAGES.VP && actor.role === ROLES.VP;
}

export function canVpAccessCustomerForApproval(db, actor, customerId) {
  if (actor.role !== ROLES.VP) return false;
  return Boolean(db.prepare(`
    SELECT 1
    FROM quotes q JOIN quote_versions qv ON qv.quote_id = q.id
    WHERE q.customer_id = ?
      AND (qv.status = 'APPROVED' OR (qv.status = 'PENDING_VP' AND COALESCE(qv.approval_stage, 'VP') = 'VP'))
    LIMIT 1
  `).get(customerId));
}
