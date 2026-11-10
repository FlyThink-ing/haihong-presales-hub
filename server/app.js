import express from "express";
import multer from "multer";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changeOwnPassword, changeUserManager, createUser, getSession, login, logout, resetUserPassword, setUserActive, updateOwnProfile } from "./auth-service.js";
import { createCustomer, getCustomer, listCustomers, supplementCustomerRegisteredOn, transferCustomer, updateCustomer, updateCustomerMapPoint } from "./customer-service.js";
import { createContact, createFollowup, createProject, listContacts, listFollowups, listProjects, updateContact, updateFollowup } from "./customer-activity-service.js";
import { getCoreCustomerWorkspace, getCustomerWorkspace } from "./customer-workspace-service.js";
import { createCustomerDictionaryOption, deleteCustomerDictionaryOption, listCustomerDictionaryCandidates, listCustomerDictionaryOptions, updateCustomerDictionaryOption } from "./customer-dictionary-service.js";
import { archiveContractFile, confirmSignedContractCustomerStatus, createContractDraft, generateContractDocument, getContract, getContractFileDownload, listContracts, preflightContract, updateContractDraft, updateSigningNotes, voidContract } from "./contract-service.js";
import { getContractTemplateDownload, listContractTemplates, publishContractTemplate, uploadContractTemplate } from "./contract-template-service.js";
import { AppError, CUSTOMER_STATUSES, ROLES } from "./domain.js";
import { listPendingQuotes, listQuotes, createApprovedQuoteRevision, createQuote, createUploadedQuote, updateUploadedQuote, decideQuote, getQuoteVersion, submitQuote, updateQuoteDraft } from "./quote-service.js";
import { actOnReminder, createReminder, listReminderEvents, listReminderRelatedTargets, listReminders } from "./reminder-service.js";
import { validateMapResource } from "./map-resource.js";
import { getMapOverview } from "./map-service.js";
import { exportApprovedQuoteDocx, exportSurveyDocx, exportCustomerFollowupsDocx, previewUnapprovedQuoteDocx } from "./docx-service.js";
import { confirmHistoricalFollowups, getHistoricalFollowupPreview, previewHistoricalFollowups } from "./historical-followup-service.js";
import { confirmMunichVisits, getMunichVisitPreview, previewMunichVisits } from "./visit-import-service.js";
import { confirmWeeklyReportSources, getWeeklyReportPreview, previewWeeklyReport } from "./weekly-report-service.js";
import { FILE_LIMITS, getFileForDownload, safeDownloadName } from "./file-service.js";
import { CUSTOMER_IMPORT_FIELDS, getImportJobWithWorkbook, importCustomerBatch, listImportFailures, listImportJobs, remapCustomerImport, uploadCustomerWorkbook } from "./import-service.js";
import { completeSurvey, createSurvey, getSurvey, listSurveyRevisions, listSurveys, listSurveyTemplates, updateSurvey } from "./survey-service.js";
import { createSurveyTemplateDraft, getAdminSurveyTemplate, listAdminSurveyTemplates, publishSurveyTemplate, updateSurveyTemplateDraft } from "./survey-template-service.js";
import { createSopDocument, getSopDocument, listSopDocuments, listSopFilters, listSopVersions, publishSopVersion } from "./sop-service.js";
import { getBackupStatusStore, safeBackupErrorCode } from "./backup-status-service.js";
import { deleteAttachment, getAttachmentDownload, getAttachmentPreview, getAttachmentSnapshotDownload, getAttachmentSnapshotPreview, listAttachments, listAttachmentSnapshot, listSurveyAttachments, uploadAttachment, validateQuoteAttachmentFormat } from "./attachment-service.js";
import { ATTACHMENT_FORMAT_LIMITS } from "./attachment-format.js";
import { buildAttachmentPreview } from "./attachment-preview.js";
import { getQuoteReview, previewQuoteReviewBoundary, runQuoteReview, runAutomaticQuoteReview } from "./quote-review-service.js";
import { preflightQuoteFile, currentQuoteBinding } from "./quote-binding-service.js";
import { requireMatchingQuoteBinding, requireQuoteBindingReview } from "./quote-binding.js";
import { requireFixedQuoteFields } from "./quote-fixed-check.js";

const webRoot = fileURLToPath(new URL("../web", import.meta.url));
const standardQuoteTemplatePath = fileURLToPath(new URL("./templates/quote-standard-template.docx", import.meta.url));
const pdfJsRoot = fileURLToPath(new URL("../node_modules/pdfjs-dist", import.meta.url));
const COOKIE_NAME = "hh_session";
const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: FILE_LIMITS.SOURCE_XLSX, files: 1, fields: 4 } });
const contractUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: FILE_LIMITS.CONTRACT_TEMPLATE_DOCX, files: 1, fields: 20 } });
const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ATTACHMENT_FORMAT_LIMITS.fileBytes, files: 1, fields: 10 } });

function cookies(header = "") {
  return Object.fromEntries(header.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf("=");
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

function customerFilters(source = {}) {
  return {
    search: source.search,
    ownerId: source.ownerId,
    status: source.status,
    source: source.source,
    customerType: source.customerType,
    industry: source.industry,
    region: source.region,
    registeredFrom: source.registeredFrom,
    registeredTo: source.registeredTo
  };
}

async function sendAttachmentPreview(res, file) {
  const preview = await buildAttachmentPreview(file);
  res.set("Cache-Control", "private, no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'");
  res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.downloadName)}`);
  res.type(preview.mimeType).send(preview.buffer);
}

function filterOptions(customers) {
  const unique = values => [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "zh-CN"));
  const owners = new Map(customers.map(item => [item.owner.id, item.owner]));
  return {
    owners: [...owners.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-CN")),
    sources: unique(customers.map(item => item.source)),
    customerTypes: unique(customers.map(item => item.customerType)),
    industries: unique(customers.map(item => item.industry)),
    regions: unique(customers.flatMap(item => [item.province, item.city, item.district]))
  };
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function setSessionCookie(res, token, config) {
  const maxAge = config.sessionHours * 60 * 60;
  const secure = config.secureCookie ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res, config) {
  const secure = config.secureCookie ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function authMiddleware(db) {
  return (req, _res, next) => {
    const token = cookies(req.headers.cookie)[COOKIE_NAME];
    const session = getSession(db, token);
    if (!session) return next(new AppError(401, "AUTH_REQUIRED", "请先登录"));
    req.session = session;
    req.user = session.user;
    next();
  };
}

function csrfMiddleware(req, _res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!safeEqual(req.get("x-csrf-token"), req.session.csrfToken)) {
    return next(new AppError(403, "CSRF_INVALID", "请求校验失败，请刷新页面后重试"));
  }
  next();
}

function createLoginLimiter() {
  const attempts = new Map();
  return (req, _res, next) => {
    const username = String(req.body?.username || "").trim().toLocaleLowerCase("zh-CN") || "unknown";
    // 外网反向代理还会按来源 IP 限流；应用层按“来源 IP + 用户名”隔离，避免同一出口下某个账号输错密码导致所有人被锁。
    const key = `${req.ip || "unknown"}:${username}`;
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter(time => now - time < 10 * 60 * 1000);
    if (recent.length >= 10) return next(new AppError(429, "LOGIN_RATE_LIMITED", "登录失败次数过多，请稍后再试"));
    req.recordLoginFailure = () => attempts.set(key, [...recent, Date.now()]);
    req.clearLoginFailures = () => attempts.delete(key);
    next();
  };
}

function runtimeView(config) {
  const core = config.launchProfile === "CORE";
  return {
    launchProfile: core ? "CORE" : "FULL",
    dataMode: config.dataMode === "PRODUCTION" ? "PRODUCTION" : "TEST",
    enabledModules: core
      ? ["customers", "quotes", "admin"]
      : ["dashboard", "customers", "map", "surveys", "quotes", "contracts", "sop", "reminders", "imports", "admin"]
  };
}

function moduleDisabled(moduleName) {
  return (_req, _res, next) => next(new AppError(404, "MODULE_DISABLED", `${moduleName}将在后续阶段开放`));
}

function requireCoreQuoteTarget(config, targetType) {
  if (config.launchProfile === "CORE" && targetType !== "QUOTE_VERSION") {
    throw new AppError(404, "MODULE_DISABLED", "当前首发版本仅开放报价附件");
  }
}

function requireCoreQuoteAttachment(db, config, attachmentId) {
  if (config.launchProfile !== "CORE") return;
  const row = db.prepare(`SELECT target_type FROM business_attachments WHERE id = ?`).get(attachmentId);
  if (row?.target_type !== "QUOTE_VERSION") throw new AppError(404, "MODULE_DISABLED", "当前首发版本仅开放报价附件");
}

function requireCoreQuoteSnapshot(db, config, snapshotId) {
  if (config.launchProfile !== "CORE") return;
  const row = db.prepare(`SELECT snapshot_kind FROM business_attachment_snapshots WHERE id = ?`).get(snapshotId);
  if (row?.snapshot_kind !== "QUOTE_SUBMISSION") throw new AppError(404, "MODULE_DISABLED", "当前首发版本仅开放报价附件");
}

export function createApp({ db, config, logger = console }) {
  const app = express();
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    });
    next();
  });
  app.use(express.json({ limit: "256kb", type: "application/json" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true, service: "haihong-presales-hub" }));
  app.get("/api/runtime", (_req, res) => res.json(runtimeView(config)));
  app.post("/api/auth/login", createLoginLimiter(), (req, res, next) => {
    try {
      const result = login(db, { ...req.body, sessionHours: config.sessionHours });
      req.clearLoginFailures();
      setSessionCookie(res, result.token, config);
      res.json({ user: result.user, csrfToken: result.csrfToken, expiresAt: result.expiresAt });
    } catch (error) {
      req.recordLoginFailure();
      next(error);
    }
  });

  const requireAuth = authMiddleware(db);
  app.use("/api", requireAuth);
  app.use("/api", csrfMiddleware);
  app.use("/api", (req, _res, next) => {
    const allowed = (req.method === "GET" && req.path === "/auth/session") ||
      (req.method === "POST" && ["/auth/change-password", "/auth/logout"].includes(req.path));
    if (req.user.mustChangePassword && !allowed) return next(new AppError(403, "PASSWORD_CHANGE_REQUIRED", "密码已重置，请先修改本人密码再访问业务数据"));
    next();
  });

  if (config.launchProfile === "CORE") {
    app.use("/api/dashboard", moduleDisabled("工作台"));
    app.use("/api/reminders", moduleDisabled("提醒"));
    app.use("/api/map", moduleDisabled("分布地图"));
    app.use("/api/surveys", moduleDisabled("软件调研"));
    app.use("/api/survey-templates", moduleDisabled("软件调研"));
    app.use("/api/admin/survey-templates", moduleDisabled("调研模板管理"));
    app.use("/api/contracts", moduleDisabled("合同管理"));
    app.use("/api/contract-templates", moduleDisabled("合同管理"));
    app.use("/api/contract-files", moduleDisabled("合同管理"));
    app.use("/api/sop", moduleDisabled("岗位职责与 SOP"));
    app.use("/api/imports", moduleDisabled("历史数据导入"));
    app.use("/api/followups", moduleDisabled("客户跟进"));
    app.use("/api/customers/:id/workspace", moduleDisabled("完整客户档案"));
    app.use("/api/customers/:id/followups", moduleDisabled("客户跟进"));
    app.use("/api/customers/:id/map-point", moduleDisabled("客户地图"));
  }

  app.get("/api/auth/session", (req, res) => res.json({ user: req.user, csrfToken: req.session.csrfToken, expiresAt: req.session.expiresAt }));
  app.patch("/api/auth/profile", (req, res) => res.json({ user: updateOwnProfile(db, req.user, req.body) }));
  app.get("/api/admin/backup-status", (req, res, next) => {
    if (req.user.role !== ROLES.ADMIN) return next(new AppError(403, "BACKUP_STATUS_FORBIDDEN", "仅系统管理员可查看备份运行状态"));
    res.set("Cache-Control", "private, no-store");
    try {
      res.json(getBackupStatusStore(db).getStatus(req.user));
    } catch (error) {
      const code = safeBackupErrorCode(error, "BACKUP_STATUS_READ_FAILED");
      logger.error(`备份状态查询失败 [${code}]；状态不确定，请联系运维核验`);
      res.status(503).json({ error: { code, message: "备份运行状态无法确认，请联系运维核验；此状态不表示备份成功" } });
    }
  });
  app.post("/api/auth/change-password", (req, res) => {
    const result = changeOwnPassword(db, req.session, req.body, config.sessionHours);
    setSessionCookie(res, result.token, config);
    res.json({ user: result.user, csrfToken: result.csrfToken, expiresAt: result.expiresAt });
  });
  app.post("/api/auth/logout", (req, res) => {
    logout(db, req.session, req.user.id);
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  app.get("/api/users", (req, res, next) => {
    if (req.user.role !== ROLES.ADMIN) return next(new AppError(403, "USER_ADMIN_FORBIDDEN", "仅管理员可以维护用户"));
    const rows = db.prepare(`SELECT id, username, display_name, role, manager_id, position_code, regions_json, home_city, is_active, created_at FROM users ORDER BY created_at`).all();
    res.json({ items: rows.map(row => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role, managerId: row.manager_id, positionCode: row.position_code || (row.role === 'MANAGER' ? 'RND_MANAGER' : null), regions: JSON.parse(row.regions_json || "[]"), homeCity: row.home_city, active: Boolean(row.is_active), createdAt: row.created_at })) });
  });
  app.post("/api/users", (req, res, next) => {
    if (req.user.role !== ROLES.ADMIN) return next(new AppError(403, "USER_ADMIN_FORBIDDEN", "仅管理员可以维护用户"));
    res.status(201).json(createUser(db, req.body, req.user.id));
  });
  app.patch("/api/users/:id/status", (req, res) => res.json(setUserActive(db, req.user, req.params.id, req.body.active)));
  app.post("/api/users/:id/reset-password", (req, res) => res.json(resetUserPassword(db, req.user, req.params.id, req.body.newPassword)));
  app.post("/api/users/:id/manager", (req, res) => res.json(changeUserManager(db, req.user, req.params.id, req.body)));
  app.get("/api/users/:id/manager-history", (req, res, next) => {
    if (req.user.role !== ROLES.ADMIN) return next(new AppError(403, "USER_ADMIN_FORBIDDEN", "仅管理员可以查看负责人变更历史"));
    const items = db.prepare(`
      SELECT h.*, old.display_name AS previous_manager_name, current.display_name AS new_manager_name, actor.display_name AS changed_by_name
      FROM user_manager_history h
      LEFT JOIN users old ON old.id = h.previous_manager_id
      JOIN users current ON current.id = h.new_manager_id
      LEFT JOIN users actor ON actor.id = h.changed_by
      WHERE h.user_id = ? ORDER BY h.effective_at DESC
    `).all(req.params.id).map(row => ({ id: row.id, previousManager: row.previous_manager_id ? { id: row.previous_manager_id, displayName: row.previous_manager_name } : null, newManager: { id: row.new_manager_id, displayName: row.new_manager_name }, changedBy: row.changed_by ? { id: row.changed_by, displayName: row.changed_by_name } : null, reason: row.reason, effectiveAt: row.effective_at }));
    res.json({ items });
  });

  app.get("/api/dashboard", (req, res) => {
    const customers = listCustomers(db, req.user);
    const reminders = listReminders(db, req.user, { view: "mine", includeCompleted: false });
    const now = Date.now();
    const sevenDays = now + 7 * 24 * 60 * 60 * 1000;
    const pendingApprovals = listPendingQuotes(db, req.user);
    const confirmations = listReminders(db, req.user, { view: "confirmation", includeCompleted: false });
    const overdue = reminders.filter(item => item.status === "OVERDUE");
    const nextSevenDays = reminders.filter(item => {
      const time = Date.parse(item.remindAt);
      return item.status === "PENDING" && time >= now && time <= sevenDays;
    });
    res.json({
      customerCount: customers.length,
      customerStatusCounts: Object.fromEntries(customers.map(customer => customer.status).filter((value, index, all) => all.indexOf(value) === index).map(status => [status, customers.filter(customer => customer.status === status).length])),
      reminderSummary: {
        pendingConfirmation: confirmations.length,
        confirmationItems: confirmations.slice(0, 5),
        overdue: overdue.length,
        nextSevenDays: nextSevenDays.length,
        items: reminders.slice(0, 8)
      },
      pendingApprovalCount: pendingApprovals.length,
      pendingApprovalItems: pendingApprovals.slice(0, 5).map(item => ({
        id: item.id,
        quoteNumber: item.quoteNumber,
        versionLabel: item.versionLabel,
        status: item.status,
        customer: item.customer,
        project: item.project,
        finalDiscountCents: item.finalDiscountCents,
        submittedAt: item.submittedAt
      })),
      recentCustomers: customers.slice(0, 5)
    });
  });

  app.get("/api/customers", (req, res) => {
    const directory = { companyDirectory: true, limit: 5000 };
    const scope = listCustomers(db, req.user, {}, directory);
    const filters = customerFilters(req.query);
    const stageScope = listCustomers(db, req.user, { ...filters, status: undefined }, directory);
    const statusCounts = Object.fromEntries(CUSTOMER_STATUSES.map(status => [status, stageScope.filter(customer => customer.status === status).length]));
    res.json({ items: listCustomers(db, req.user, filters, directory), filterOptions: filterOptions(scope), statusCounts });
  });
  app.get("/api/customer-dictionaries", (req, res) => res.json({ items: listCustomerDictionaryOptions(db, req.user, { includeDisabled: req.query.includeDisabled === "true" }) }));
  app.get("/api/customer-dictionaries/candidates", (req, res) => res.json({ items: listCustomerDictionaryCandidates(db, req.user) }));
  app.post("/api/customer-dictionaries", (req, res) => res.status(201).json(createCustomerDictionaryOption(db, req.user, req.body)));
  app.patch("/api/customer-dictionaries/:id", (req, res) => res.json(updateCustomerDictionaryOption(db, req.user, req.params.id, req.body)));
  app.delete("/api/customer-dictionaries/:id", (req, res) => { deleteCustomerDictionaryOption(db, req.user, req.params.id); res.status(204).end(); });
  app.post("/api/customers", (req, res) => res.status(201).json(createCustomer(db, req.user, req.body, { requireCompleteManual: true })));
  app.get("/api/customers/:id", (req, res) => res.json(getCustomer(db, req.user, req.params.id, { companyDirectory: true })));
  app.get("/api/customers/:id/core-workspace", (req, res) => res.json(getCoreCustomerWorkspace(db, req.user, req.params.id)));
  app.get("/api/customers/:id/workspace", (req, res) => res.json(getCustomerWorkspace(db, req.user, req.params.id)));
  app.patch("/api/customers/:id", (req, res) => res.json(updateCustomer(db, req.user, req.params.id, req.body)));
  app.patch("/api/customers/:id/map-point", (req, res) => res.json(updateCustomerMapPoint(db, config.storagePath, req.user, req.params.id, req.body)));
  app.patch("/api/customers/:id/registered-on", (req, res) => res.json(supplementCustomerRegisteredOn(db, req.user, req.params.id, req.body)));
  app.post("/api/customers/:id/transfer", (req, res) => res.json(transferCustomer(db, req.user, req.params.id, req.body)));
  app.get("/api/customers/:id/contacts", (req, res) => res.json({ items: listContacts(db, req.user, req.params.id, { companyDirectory: true }) }));
  app.post("/api/customers/:id/contacts", (req, res) => res.status(201).json(createContact(db, req.user, req.params.id, req.body)));
  app.patch("/api/contacts/:id", (req, res) => res.json(updateContact(db, req.user, req.params.id, req.body)));
  app.get("/api/customers/:id/projects", (req, res) => res.json({ items: listProjects(db, req.user, req.params.id) }));
  app.post("/api/customers/:id/projects", (req, res) => res.status(201).json(createProject(db, req.user, req.params.id, req.body)));
  app.get("/api/projects", (req, res) => res.json({ items: listProjects(db, req.user, req.query.customerId || null) }));
  app.get("/api/customers/:id/followups", (req, res) => res.json({ items: listFollowups(db, req.user, req.params.id) }));
  app.post("/api/customers/:id/followups/export-docx", async (req, res) => res.status(201).json(await exportCustomerFollowupsDocx(db, config, req.user, req.params.id)));
  app.post("/api/customers/:id/followups", (req, res) => res.status(201).json(createFollowup(db, req.user, req.params.id, req.body)));
  app.patch("/api/followups/:id", (req, res) => res.json(updateFollowup(db, req.user, req.params.id, req.body)));

  app.get("/api/attachments", (req, res) => {
    requireCoreQuoteTarget(config, String(req.query.targetType || ""));
    res.json(listAttachments(db, req.user, { targetType: String(req.query.targetType || ""), targetId: String(req.query.targetId || ""), targetKey: String(req.query.targetKey || "") }));
  });
  app.get("/api/surveys/:id/attachments", (req, res) => res.json(listSurveyAttachments(db, req.user, req.params.id)));
  app.get("/api/attachment-snapshots", (req, res) => {
    if (config.launchProfile === "CORE" && String(req.query.snapshotKind || "") !== "QUOTE_SUBMISSION") throw new AppError(404, "MODULE_DISABLED", "当前首发版本仅开放报价附件");
    res.json({ items: listAttachmentSnapshot(db, req.user, String(req.query.snapshotKind || ""), String(req.query.snapshotOwnerId || "")) });
  });
  app.post("/api/attachments/upload", attachmentUpload.single("file"), async (req, res) => {
    requireCoreQuoteTarget(config, String(req.body.targetType || ""));
    res.status(201).json(await uploadAttachment(db, config, req.user, req.body, req.file));
  });
  app.post("/api/quote-attachments/preview", attachmentUpload.single("file"), async (req, res) => {
    if (![ROLES.PRESALES, ROLES.ADMIN].includes(req.user.role)) throw new AppError(403, "QUOTE_ATTACHMENT_PREVIEW_FORBIDDEN", "当前账号不能新建报价附件");
    const format = await validateQuoteAttachmentFormat(req.file);
    const preview = await buildAttachmentPreview({ buffer: req.file.buffer, mimeType: format.mimeType, downloadName: safeDownloadName(req.file.originalname, `附件${format.extension}`) });
    res.set("Cache-Control", "private, no-store").json({ html: preview.buffer.toString("utf8") });
  });
  app.delete("/api/attachments/:id", (req, res) => {
    requireCoreQuoteAttachment(db, config, req.params.id);
    deleteAttachment(db, req.user, req.params.id, req.body);
    res.status(204).end();
  });
  app.get("/api/attachments/:id/download", (req, res) => {
    requireCoreQuoteAttachment(db, config, req.params.id);
    const file = getAttachmentDownload(db, config, req.user, req.params.id, req.query.versionId ? String(req.query.versionId) : null);
    res.set("Cache-Control", "private, no-store").attachment(file.downloadName).type(file.mimeType).send(file.buffer);
  });
  app.get("/api/attachments/:id/preview", async (req, res) => {
    requireCoreQuoteAttachment(db, config, req.params.id);
    const file = getAttachmentPreview(db, config, req.user, req.params.id, req.query.versionId ? String(req.query.versionId) : null);
    await sendAttachmentPreview(res, file);
  });
  app.get("/api/attachment-snapshots/:id/download", (req, res) => {
    requireCoreQuoteSnapshot(db, config, req.params.id);
    const file = getAttachmentSnapshotDownload(db, config, req.user, req.params.id);
    res.set("Cache-Control", "private, no-store").attachment(file.downloadName).type(file.mimeType).send(file.buffer);
  });
  app.get("/api/attachment-snapshots/:id/preview", async (req, res) => {
    requireCoreQuoteSnapshot(db, config, req.params.id);
    const file = getAttachmentSnapshotPreview(db, config, req.user, req.params.id);
    await sendAttachmentPreview(res, file);
  });

  app.get("/api/survey-templates", (_req, res) => res.json({ items: listSurveyTemplates(db) }));
  app.get("/api/admin/survey-templates", (req, res) => res.json({ items: listAdminSurveyTemplates(db, req.user) }));
  app.post("/api/admin/survey-templates", (req, res) => res.status(201).json(createSurveyTemplateDraft(db, req.user, req.body)));
  app.get("/api/admin/survey-templates/:id", (req, res) => res.json(getAdminSurveyTemplate(db, req.user, req.params.id)));
  app.patch("/api/admin/survey-templates/:id", (req, res) => res.json(updateSurveyTemplateDraft(db, req.user, req.params.id, req.body)));
  app.post("/api/admin/survey-templates/:id/publish", (req, res) => res.json(publishSurveyTemplate(db, req.user, req.params.id)));
  app.get("/api/surveys", (req, res) => res.json({ items: listSurveys(db, req.user) }));
  app.post("/api/surveys", (req, res) => res.status(201).json(createSurvey(db, req.user, req.body)));
  app.get("/api/surveys/:id", (req, res) => res.json(getSurvey(db, req.user, req.params.id)));
  app.patch("/api/surveys/:id", (req, res) => res.json(updateSurvey(db, req.user, req.params.id, req.body)));
  app.post("/api/surveys/:id/complete", (req, res) => res.json(completeSurvey(db, req.user, req.params.id)));
  app.get("/api/surveys/:id/revisions", (req, res) => res.json({ items: listSurveyRevisions(db, req.user, req.params.id) }));
  app.post("/api/surveys/:id/export-docx", async (req, res) => res.status(201).json(await exportSurveyDocx(db, config, req.user, req.params.id)));

  app.get("/api/sop", (req, res) => res.json({ items: listSopDocuments(db, req.user, { role: req.query.role, stage: req.query.stage, query: req.query.q }) }));
  app.get("/api/sop/filters", (req, res) => res.json(listSopFilters(db, req.user)));
  app.post("/api/sop", (req, res) => res.status(201).json(createSopDocument(db, req.user, req.body)));
  app.get("/api/sop/:id", (req, res) => res.json(getSopDocument(db, req.user, req.params.id)));
  app.get("/api/sop/:id/versions", (req, res) => res.json({ items: listSopVersions(db, req.user, req.params.id) }));
  app.post("/api/sop/:id/versions", (req, res) => res.status(201).json(publishSopVersion(db, req.user, req.params.id, req.body)));

  app.get("/api/imports/customer/fields", (_req, res) => res.json({ items: CUSTOMER_IMPORT_FIELDS.map(({ aliases: _aliases, ...field }) => field) }));
  app.get("/api/imports/customer", (req, res) => res.json({ items: listImportJobs(db, req.user) }));
  app.post("/api/imports/customer/upload", excelUpload.single("file"), async (req, res) => res.status(201).json(await uploadCustomerWorkbook(db, config, req.user, req.file)));
  app.get("/api/imports/customer/:id", async (req, res) => res.json(await getImportJobWithWorkbook(db, config, req.user, req.params.id)));
  app.post("/api/imports/customer/:id/preview", async (req, res) => res.json(await remapCustomerImport(db, config, req.user, req.params.id, req.body)));
  app.post("/api/imports/customer/:id/import", (req, res) => res.json(importCustomerBatch(db, req.user, req.params.id, req.body)));
  app.get("/api/imports/customer/:id/failures", (req, res) => res.json({ items: listImportFailures(db, req.user, req.params.id) }));
  app.get("/api/imports/customer/:id/followups", (req, res) => res.json(getHistoricalFollowupPreview(db, req.user, req.params.id)));
  app.post("/api/imports/customer/:id/followups/preview", async (req, res) => res.json(await previewHistoricalFollowups(db, config, req.user, req.params.id)));
  app.post("/api/imports/customer/:id/followups/confirm", (req, res) => res.json(confirmHistoricalFollowups(db, req.user, req.params.id, req.body)));
  app.get("/api/imports/customer/:id/munich-visits", (req, res) => res.json(getMunichVisitPreview(db, req.user, req.params.id)));
  app.post("/api/imports/customer/:id/munich-visits/preview", async (req, res) => res.json(await previewMunichVisits(db, config, req.user, req.params.id)));
  app.post("/api/imports/customer/:id/munich-visits/confirm", (req, res) => res.json(confirmMunichVisits(db, req.user, req.params.id, req.body)));
  app.get("/api/imports/customer/:id/weekly-report", (req, res) => res.json(getWeeklyReportPreview(db, req.user, req.params.id, { search: req.query.search })));
  app.post("/api/imports/customer/:id/weekly-report/preview", async (req, res) => res.json(await previewWeeklyReport(db, config, req.user, req.params.id)));
  app.post("/api/imports/customer/:id/weekly-report/confirm", (req, res) => res.json(confirmWeeklyReportSources(db, req.user, req.params.id, req.body)));

  app.get("/api/assignable-users", (req, res) => {
    let rows = [];
    if (req.user.role === ROLES.PRESALES) rows = db.prepare(`SELECT id, username, display_name, role FROM users WHERE id = ? AND is_active = 1`).all(req.user.id);
    if (req.user.role === ROLES.MANAGER) rows = db.prepare(`SELECT id, username, display_name, role FROM users WHERE manager_id = ? AND role = 'PRESALES' AND is_active = 1 ORDER BY display_name`).all(req.user.id);
    if (req.user.role === ROLES.ADMIN) rows = db.prepare(`SELECT id, username, display_name, role FROM users WHERE role = 'PRESALES' AND is_active = 1 ORDER BY display_name`).all();
    res.json({ items: rows.map(row => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role })) });
  });

  app.get("/api/reminders", (req, res) => res.json({ items: listReminders(db, req.user, { view: String(req.query.view || "mine"), includeCompleted: req.query.includeCompleted !== "false" }) }));
  app.get("/api/reminders/related-targets", (req, res) => res.json({ items: listReminderRelatedTargets(db, req.user, String(req.query.customerId || "")) }));
  app.get("/api/reminders/:id/events", (req, res) => res.json({ items: listReminderEvents(db, req.user, req.params.id) }));
  app.get("/api/reminders/targets", (req, res) => {
    let rows;
    if (req.user.role === ROLES.VP) {
      rows = db.prepare(`
        SELECT DISTINCT c.id AS customer_id, c.full_name, c.owner_id, u.display_name AS owner_name
        FROM customers c
        JOIN users u ON u.id = c.owner_id
        JOIN quotes q ON q.customer_id = c.id
        JOIN quote_versions qv ON qv.quote_id = q.id
        WHERE (qv.status = 'APPROVED' OR (qv.status = 'PENDING_VP' AND COALESCE(qv.approval_stage, 'VP') = 'VP')) AND u.is_active = 1
        ORDER BY c.full_name
      `).all();
    } else {
      rows = listCustomers(db, req.user).map(customer => ({ customer_id: customer.id, full_name: customer.fullName, owner_id: customer.owner.id, owner_name: customer.owner.displayName }));
    }
    res.json({ items: rows.map(row => ({ customerId: row.customer_id, customerName: row.full_name, assigneeId: row.owner_id, assigneeName: row.owner_name })) });
  });
  app.post("/api/reminders", (req, res) => res.status(201).json(createReminder(db, req.user, req.body)));
  app.patch("/api/reminders/:id", (req, res) => res.json(actOnReminder(db, req.user, req.params.id, req.body)));

  app.get("/api/map", (req, res) => res.json(getMapOverview(db, config.storagePath, req.user, customerFilters(req.query))));
  app.get("/api/map/basemap", (req, res, next) => {
    const resource = validateMapResource(config.storagePath);
    if (resource.status !== "READY") return next(new AppError(404, "MAP_RESOURCE_UNAVAILABLE", resource.message));
    if (typeof req.query.expectedAssetSha256 !== "string" || req.query.expectedAssetSha256 !== resource.sha256) return next(new AppError(409, "MAP_RESOURCE_CHANGED", "地图原图已变化或缺少预期摘要，请刷新地图后重试"));
    res.set("Cache-Control", "private, no-store");
    res.type(path.extname(resource.assetFile)).send(resource.assetBuffer);
  });

  app.get("/api/quote-template/download", (_req, res, next) => {
    const templatePath = config.quoteStandardTemplatePath || standardQuoteTemplatePath;
    res.download(templatePath, "软件报价单标准模板.docx", {
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Cache-Control": "private, no-store" }
    }, error => {
      if (!error || res.headersSent) return;
      if (["ENOENT", "EACCES", "EPERM"].includes(error.code) || error.status === 404) {
        return next(new AppError(503, "QUOTE_TEMPLATE_UNAVAILABLE", "标准报价模板不可用，请联系管理员安装公司模板"));
      }
      next(error);
    });
  });
  app.post("/api/quotes", (req, res) => res.status(201).json(createQuote(db, req.user, { ...req.body, quoteNumber: undefined })));
  app.post("/api/uploaded-quotes/preflight", attachmentUpload.single("file"), async (req, res) => res.set("Cache-Control", "private, no-store").json(await preflightQuoteFile(db, req.user, req.body, req.file)));
  app.post("/api/uploaded-quotes", (req, res) => res.status(201).json(createUploadedQuote(db, req.user, req.body)));
  app.patch("/api/uploaded-quotes/:id", async (req, res) => {
    const binding = await currentQuoteBinding(db, config, req.user, req.params.id, req.body.amountCents);
    if (binding) { requireMatchingQuoteBinding(binding); requireFixedQuoteFields(binding.fixedFields); requireQuoteBindingReview(binding, req.body.bindingReviewConfirmed === true); }
    res.json(updateUploadedQuote(db, req.user, req.params.id, req.body));
  });
  app.get("/api/quotes", (req, res) => res.json({ items: listQuotes(db, req.user) }));
  app.get("/api/quote-versions/:id", (req, res) => res.json(getQuoteVersion(db, req.user, req.params.id)));
  app.get("/api/quote-versions/:id/binding-check", async (req, res) => res.set("Cache-Control", "private, no-store").json({ binding: await currentQuoteBinding(db, config, req.user, req.params.id) }));
  app.post("/api/quote-versions/:id/binding-check", async (req, res) => res.set("Cache-Control", "private, no-store").json({ binding: await currentQuoteBinding(db, config, req.user, req.params.id, req.body.amountCents) }));
  app.get("/api/quote-versions/:id/document-review", (req, res) => res.set("Cache-Control", "private, no-store").json(getQuoteReview(db, req.user, req.params.id)));
  app.get("/api/quote-versions/:id/document-review/boundary", async (req, res) => res.set("Cache-Control", "private, no-store").json(await previewQuoteReviewBoundary(db, config, req.user, req.params.id)));
  app.post("/api/quote-versions/:id/document-review", async (req, res) => res.set("Cache-Control", "private, no-store").status(201).json(await runQuoteReview(db, config, req.user, req.params.id, req.body)));
  app.patch("/api/quote-versions/:id", (req, res) => res.json(updateQuoteDraft(db, req.user, req.params.id, req.body)));
  app.post("/api/quote-versions/:id/submit", async (req, res) => {
    const binding = await currentQuoteBinding(db, config, req.user, req.params.id);
    if (binding) {
      requireMatchingQuoteBinding(binding);
      requireFixedQuoteFields(binding.fixedFields);
      requireQuoteBindingReview(binding);
      const review = await runAutomaticQuoteReview(db, config, req.user, req.params.id);
      return res.json(submitQuote(db, req.user, req.params.id, { ...req.body, amountConfirmed: true, reviewId: review.id, reviewConfirmed: false }));
    }
    const quote = getQuoteVersion(db, req.user, req.params.id);
    if (quote.sourceKind === "UPLOADED" && quote.status === "DRAFT") throw new AppError(422, "UPLOADED_QUOTE_SOURCE_REQUIRED", "请先上传 PDF 报价单");
    res.json(submitQuote(db, req.user, req.params.id, req.body));
  });
  app.post("/api/quote-versions/:id/decision", (req, res) => res.json(decideQuote(db, req.user, req.params.id, req.body)));
  app.post("/api/quote-versions/:id/revise", (req, res) => res.status(201).json(createApprovedQuoteRevision(db, req.user, req.params.id, req.body)));
  app.post("/api/quote-versions/:id/export-docx", () => { throw new AppError(404, "QUOTE_EXPORT_DISABLED", "报价单导出 Word 已关闭"); });
  app.post("/api/quote-versions/:id/preview-docx", () => { throw new AppError(404, "QUOTE_PREVIEW_DISABLED", "未审批预览导出已关闭"); });
  app.get("/api/quotes/pending/mine", (req, res) => res.json({ items: listPendingQuotes(db, req.user) }));

  app.get("/api/contract-templates", (req, res) => res.json({ items: listContractTemplates(db, req.user) }));
  app.post("/api/contract-templates/upload", contractUpload.single("file"), async (req, res) => res.status(201).json(await uploadContractTemplate(db, config, req.user, req.file, req.body.version)));
  app.post("/api/contract-templates/:id/publish", async (req, res) => res.json(await publishContractTemplate(db, config, req.user, req.params.id)));
  app.get("/api/contract-templates/:id/download", (req, res, next) => {
    try {
      const file = getContractTemplateDownload(db, config, req.user, req.params.id);
      res.download(file.absolutePath, file.downloadName, { headers: { "Content-Type": file.mimeType, "Cache-Control": "private, no-store" } }, error => {
        if (error && !res.headersSent) next(error);
      });
    } catch (error) { next(error); }
  });

  app.get("/api/contracts", (req, res) => res.json({ items: listContracts(db, req.user) }));
  app.post("/api/contracts/preflight", (req, res) => res.status(200).json(preflightContract(db, req.user, req.body)));
  app.post("/api/contracts", (req, res) => res.status(201).json(createContractDraft(db, req.user, req.body)));
  app.get("/api/contracts/:id", (req, res) => res.json(getContract(db, req.user, req.params.id)));
  app.patch("/api/contracts/:id", (req, res) => res.json(updateContractDraft(db, req.user, req.params.id, req.body)));
  app.post("/api/contracts/:id/generate", async (req, res) => res.status(201).json(await generateContractDocument(db, config, req.user, req.params.id)));
  app.post("/api/contracts/:id/files", contractUpload.single("file"), (req, res) => res.status(201).json(archiveContractFile(db, config, req.user, req.params.id, req.body.category, req.file, req.body)));
  app.post("/api/contracts/:id/confirm-customer-status", (req, res) => res.json(confirmSignedContractCustomerStatus(db, req.user, req.params.id, req.body)));
  app.patch("/api/contracts/:id/signing-notes", (req, res) => res.json(updateSigningNotes(db, req.user, req.params.id, req.body.notes)));
  app.post("/api/contracts/:id/void", (req, res) => res.json(voidContract(db, req.user, req.params.id, req.body.reason)));

  app.get("/api/contract-files/:id/download", (req, res, next) => {
    try {
      const file = getContractFileDownload(db, config, req.user, req.params.id);
      res.download(file.absolutePath, file.downloadName, { headers: { "Content-Type": file.mimeType, "Cache-Control": "private, no-store" } }, error => {
        if (error && !res.headersSent) next(error);
      });
    } catch (error) { next(error); }
  });

  app.get("/api/files/:id/download", (req, res, next) => {
    try {
      if (config.launchProfile === "CORE") {
        const stored = db.prepare(`SELECT category FROM stored_files WHERE id = ?`).get(req.params.id);
        if (stored?.category !== "APPROVED_QUOTE_DOCX") throw new AppError(404, "MODULE_DISABLED", "当前首发版本仅开放报价 Word");
      }
      const file = getFileForDownload(db, config, req.user, req.params.id);
      res.download(file.absolutePath, file.downloadName, { headers: { "Content-Type": file.mimeType, "Cache-Control": "private, no-store" } }, error => {
        if (error && !res.headersSent) next(error);
      });
    } catch (error) { next(error); }
  });

  app.use("/api", (_req, _res, next) => next(new AppError(404, "API_NOT_FOUND", "接口不存在")));
  app.get("/vendor/pdfjs/pdf.mjs", (_req, res) => res.sendFile(path.join(pdfJsRoot, "build/pdf.mjs")));
  app.get("/vendor/pdfjs/pdf.worker.mjs", (_req, res) => res.sendFile(path.join(pdfJsRoot, "build/pdf.worker.mjs")));
  app.use("/vendor/pdfjs/cmaps", express.static(path.join(pdfJsRoot, "cmaps"), { dotfiles: "deny", fallthrough: false }));
  app.use("/vendor/pdfjs/standard_fonts", express.static(path.join(pdfJsRoot, "standard_fonts"), { dotfiles: "deny", fallthrough: false }));
  app.use(express.static(webRoot, { dotfiles: "deny", etag: true, fallthrough: true }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(webRoot, "index.html")));

  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ error: { code: error.code, message: error.code === "LIMIT_FILE_SIZE" ? "上传文件超过当前业务允许的大小限制" : "上传文件无效" } });
    }
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
      return res.status(400).json({ error: { code: "JSON_INVALID", message: "请求内容不是有效 JSON" } });
    }
    const status = error.status || 500;
    if (status >= 500) console.error("服务器处理请求失败", error);
    res.status(status).json({ error: { code: error.code || "INTERNAL_ERROR", message: status >= 500 ? "服务器处理请求失败" : error.message, details: error.details } });
  });
  return app;
}
