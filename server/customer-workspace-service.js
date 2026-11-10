import { listContacts, listFollowups, listProjects } from "./customer-activity-service.js";
import { listContracts } from "./contract-service.js";
import { getCustomer } from "./customer-service.js";
import { MANAGER_POSITIONS, ROLES } from "./domain.js";
import { canReadAllCustomersAndQuotes, canReadCustomer } from "./permissions.js";
import { getQuoteVersion } from "./quote-service.js";
import { listCustomerReminders } from "./reminder-service.js";
import { listSurveys } from "./survey-service.js";
import { listAttachments } from "./attachment-service.js";

function parseJson(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function storedFileView(row) {
  return {
    id: row.id,
    source: "STORED_FILE",
    entityType: row.entity_type,
    entityId: row.entity_id,
    category: row.category,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    uploadedBy: { id: row.uploaded_by, displayName: row.uploaded_by_name },
    createdAt: row.created_at
  };
}

function customerStoredFiles(db, customerId, surveys, quotes) {
  const groups = [
    ["CUSTOMER", [customerId]],
    ["SURVEY", surveys.map(item => item.id)],
    ["QUOTE_VERSION", quotes.map(item => item.id)]
  ].filter(([, ids]) => ids.length);
  if (!groups.length) return [];
  const clauses = [];
  const params = [];
  for (const [entityType, ids] of groups) {
    clauses.push(`(sf.entity_type = ? AND sf.entity_id IN (${ids.map(() => "?").join(",")}))`);
    params.push(entityType, ...ids);
  }
  return db.prepare(`
    SELECT sf.*, u.display_name AS uploaded_by_name
    FROM stored_files sf JOIN users u ON u.id = sf.uploaded_by
    WHERE sf.category <> 'BUSINESS_ATTACHMENT' AND (${clauses.join(" OR ")})
    ORDER BY sf.created_at DESC
  `).all(...params).map(storedFileView);
}

function contractFiles(contracts) {
  return contracts.flatMap(contract => contract.files.map(file => ({
    ...file,
    source: "CONTRACT_FILE",
    entityType: "CONTRACT",
    entityId: contract.id,
    contractNumber: contract.contractNumber
  })));
}

function addEntity(grouped, entityType, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length) grouped.set(entityType, unique);
}

function customerAuditLogs(db, customer, { contacts, followups, projects, reminders, surveys, quotes, contracts, files }) {
  const grouped = new Map();
  addEntity(grouped, "CUSTOMER", [customer.id]);
  addEntity(grouped, "PROJECT", projects.map(item => item.id));
  addEntity(grouped, "CONTACT", contacts.map(item => item.id));
  addEntity(grouped, "FOLLOWUP", followups.map(item => item.id));
  addEntity(grouped, "REMINDER", reminders.map(item => item.id));
  addEntity(grouped, "SURVEY", surveys.map(item => item.id));
  addEntity(grouped, "QUOTE_VERSION", quotes.map(item => item.id));
  addEntity(grouped, "CONTRACT", contracts.map(item => item.id));
  addEntity(grouped, "STORED_FILE", files.filter(item => item.source === "STORED_FILE").map(item => item.id));
  addEntity(grouped, "CONTRACT_FILE", files.filter(item => item.source === "CONTRACT_FILE").map(item => item.id));
  addEntity(grouped, "BUSINESS_ATTACHMENT", db.prepare(`SELECT id FROM business_attachments WHERE customer_id = ?`).all(customer.id).map(item => item.id));
  addEntity(grouped, "BUSINESS_ATTACHMENT_SNAPSHOT", db.prepare(`SELECT id FROM business_attachment_snapshots WHERE customer_id = ?`).all(customer.id).map(item => item.id));
  // 导入批次可能包含其他负责人客户，只在 customer.importOrigins 展示本客户行级来源。
  const clauses = [];
  const params = [];
  for (const [entityType, ids] of grouped) {
    clauses.push(`(a.entity_type = ? AND a.entity_id IN (${ids.map(() => "?").join(",")}))`);
    params.push(entityType, ...ids);
  }
  return db.prepare(`
    SELECT a.*, u.display_name AS actor_name
    FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
    WHERE ${clauses.join(" OR ")}
    ORDER BY a.created_at DESC, a.rowid DESC LIMIT 200
  `).all(...params).map(row => ({
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actor: row.actor_id ? { id: row.actor_id, displayName: row.actor_name } : null,
    summary: parseJson(row.summary_json),
    createdAt: row.created_at
  }));
}

function quoteSummary(quote) {
  return {
    id: quote.id,
    quoteId: quote.quoteId,
    quoteNumber: quote.quoteNumber,
    versionLabel: quote.versionLabel,
    status: quote.status,
    currentApprovalStage: quote.currentApprovalStage,
    sourceKind: quote.sourceKind,
    pendingManager: quote.pendingManager,
    pendingManagerIssue: quote.pendingManagerIssue,
    project: quote.project,
    subtotalTaxedCents: quote.subtotalTaxedCents,
    finalDiscountCents: quote.finalDiscountCents,
    submittedAt: quote.submittedAt,
    createdAt: quote.createdAt,
    approvals: quote.approvals
  };
}

function contractSummary(contract) {
  return {
    id: contract.id,
    contractNumber: contract.contractNumber,
    status: contract.status,
    project: contract.project,
    quoteReference: contract.quoteReference,
    template: { id: contract.template.id, version: contract.template.version },
    amountCents: contract.locked.amountCents,
    createdAt: contract.createdAt,
    generatedAt: contract.generatedAt,
    updatedAt: contract.updatedAt,
    files: contract.files
  };
}

export function getCustomerWorkspace(db, actor, customerId) {
  if (canReadAllCustomersAndQuotes(actor) && !canReadCustomer(db, actor, customerId)) {
    return { ...getCoreCustomerWorkspace(db, actor, customerId), directoryOnly: true };
  }
  const customer = getCustomer(db, actor, customerId);
  const contacts = listContacts(db, actor, customerId);
  const followups = listFollowups(db, actor, customerId);
  const projects = listProjects(db, actor, customerId);
  const reminders = listCustomerReminders(db, actor, customerId);
  const surveys = listSurveys(db, actor).filter(item => item.customer.id === customerId);
  const quotes = db.prepare(`
    SELECT qv.id FROM quote_versions qv JOIN quotes q ON q.id = qv.quote_id
    WHERE q.customer_id = ? ORDER BY q.created_at DESC, qv.revision DESC
  `).all(customerId).map(row => getQuoteVersion(db, actor, row.id));
  const contracts = listContracts(db, actor).filter(item => item.customer.id === customerId);
  const storedFiles = customerStoredFiles(db, customerId, surveys, quotes);
  const archivedContractFiles = contractFiles(contracts);
  const files = [...storedFiles, ...archivedContractFiles].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const businessAttachments = {
    customer: listAttachments(db, actor, { targetType: "CUSTOMER", targetId: customerId }),
    followups: Object.fromEntries(followups.map(item => [item.id, listAttachments(db, actor, { targetType: "FOLLOWUP", targetId: item.id })]))
  };
  const auditLogs = customerAuditLogs(db, customer, { contacts, followups, projects, reminders, surveys, quotes, contracts, files });
  const canWrite = actor.role === ROLES.ADMIN || (actor.role === ROLES.PRESALES && customer.owner.id === actor.id);
  return {
    customer,
    permissions: {
      canEditCustomer: canWrite,
      canMaintainActivity: canWrite,
      canSupplementRegisteredOn: !customer.registeredOn && [ROLES.PRESALES, ROLES.MANAGER, ROLES.ADMIN].includes(actor.role),
      canCreateReminder: [ROLES.PRESALES, ROLES.MANAGER, ROLES.ADMIN].includes(actor.role)
    },
    projects,
    contacts,
    followups,
    reminders,
    surveys,
    quotes: quotes.map(quoteSummary),
    contracts: contracts.map(contractSummary),
    files,
    businessAttachments,
    auditLogs
  };
}

export function getCoreCustomerWorkspace(db, actor, customerId) {
  const customer = getCustomer(db, actor, customerId, { companyDirectory: true });
  const contacts = listContacts(db, actor, customerId, { companyDirectory: true });
  const quotes = db.prepare(`
    SELECT qv.id FROM quote_versions qv JOIN quotes q ON q.id = qv.quote_id
    WHERE q.customer_id = ? ORDER BY q.created_at DESC, qv.revision DESC
  `).all(customerId).map(row => getQuoteVersion(db, actor, row.id));
  const canWrite = actor.role === ROLES.ADMIN || (actor.role === ROLES.PRESALES && customer.owner.id === actor.id);
  return {
    customer,
    permissions: {
      canEditCustomer: canWrite,
      canMaintainActivity: canWrite,
      canSupplementRegisteredOn: !customer.registeredOn && (
        canWrite || (actor.role === ROLES.MANAGER && actor.positionCode === MANAGER_POSITIONS.GENERAL_MANAGER && canReadCustomer(db, actor, customerId))
      )
    },
    contacts,
    quotes: quotes.map(quoteSummary)
  };
}
