import { canCreateCustomer, CUSTOMER_DETAIL_TABS } from "./ui-policy.js";
import { buildCustomerFilterQuery, createLatestRequestGate, normalizedMapPosition, reminderTargetAction, shouldShowSignedStatusSuggestion } from "./core-use-ui.js";
import { createDraftAutosave } from "./draft-autosave.js";
import { quoteDetailRoundingAdjustment, quoteDetailRoundingAllocations, quoteDetailTotalsMismatch, quoteDetailTotalsMismatchMessage } from "./quote-math.js";
import { quoteBoundaryOptions, quoteReviewPanel } from "./quote-document-review.js";
import { listChinaCities, listChinaProvinces } from "./china-regions.js";
import { normalizeProvinceName, renderChinaGeoMap, summarizeCustomersByProvince } from "./china-geo-map.js";
import { initializeInlinePdfViewers, disposeInlinePdfViewers } from "./quote-pdf-preview.js";

const root = document.querySelector("#root");
const dialogRoot = document.querySelector("#dialog-root");
const toastRoot = document.querySelector("#toast-root");

const state = {
  user: null,
  csrfToken: null,
  runtime: { launchProfile: "CORE", dataMode: "TEST", enabledModules: ["customers", "quotes", "admin"] },
  page: "dashboard",
  dashboard: null,
  customers: [],
  quotes: [],
  surveys: [],
  surveyTemplates: [],
  customerWorkspace: null,
  quoteFilters: { query: "", status: "" },
  customerFilters: { search: "", ownerId: "", status: "", source: "", customerType: "", industry: "", region: "", registeredFrom: "", registeredTo: "" },
  mapFilters: { ownerId: "", status: "", region: "" },
  mapData: null,
  mapImageReady: false,
  mapPickerCustomerId: null,
  mapPickerAssetSha256: null,
  importJob: null,
  sopFilters: { role: "", stage: "", query: "" },
  users: []
};
const customerRenderGate = createLatestRequestGate();
const mapRenderGate = createLatestRequestGate();
let activeDraftAutosave = null;
const dialogStack = [];

function isCoreLaunch() {
  return state.runtime?.launchProfile === "CORE";
}

function moduleEnabled(name) {
  return state.runtime?.enabledModules?.includes(name) !== false;
}

function defaultPageForUser() {
  if (!isCoreLaunch()) return "dashboard";
  if (state.user?.role === "VP" || (state.user?.role === "MANAGER" && state.user.positionCode !== "GENERAL_MANAGER")) return "quotes";
  return "customers";
}

function pageAllowed(page) {
  if (!isCoreLaunch()) return true;
  if (page === "settings") return state.user?.role === "ADMIN";
  return page === "customers" || page === "quotes";
}

function autosaveStatusText(autosaveState) {
  if (autosaveState.status === "DIRTY") return "未保存";
  if (autosaveState.status === "SAVING") return "保存中…";
  if (autosaveState.status === "SAVED") return `已保存${autosaveState.lastSavedAt ? ` · ${formatTime(autosaveState.lastSavedAt)}` : ""}`;
  if (autosaveState.status === "INVALID") return `请继续填写，完整后自动保存：${autosaveState.error?.message || "存在未填写字段"}`;
  if (autosaveState.status === "ERROR") return `保存失败：${autosaveState.error?.message || "请重试"}`;
  return autosaveState.lastSavedAt ? `已保存 · ${formatTime(autosaveState.lastSavedAt)}` : "尚无自动保存记录";
}

function confirmInApp({ title = "请确认", message, confirmLabel = "确定", cancelLabel = "取消", danger = false }) {
  return new Promise(resolve => {
    document.querySelector(".system-confirm-backdrop")?.remove();
    const host = document.createElement("div");
    host.className = "system-confirm-backdrop";
    host.innerHTML = `<section class="system-confirm" role="alertdialog" aria-modal="true" aria-labelledby="system-confirm-title" aria-describedby="system-confirm-message"><div class="system-confirm-icon${danger ? " danger" : ""}">${danger ? "!" : "?"}</div><div class="system-confirm-copy"><h2 id="system-confirm-title">${escapeHtml(title)}</h2><p id="system-confirm-message">${escapeHtml(message)}</p></div><div class="system-confirm-actions"><button class="button" type="button" data-confirm-cancel>${escapeHtml(cancelLabel)}</button><button class="button ${danger ? "danger" : "primary"}" type="button" data-confirm-accept>${escapeHtml(confirmLabel)}</button></div></section>`;
    const settle = value => { host.remove(); resolve(value); };
    host.querySelector("[data-confirm-cancel]").addEventListener("click", () => settle(false));
    host.querySelector("[data-confirm-accept]").addEventListener("click", () => settle(true));
    document.body.append(host);
    host.querySelector("[data-confirm-cancel]").focus();
  });
}

function startDialogAutosave({ root, initialEtag, initialSavedAt, collect, save, shouldTrack = () => true, delay = 1200 }) {
  activeDraftAutosave?.dispose();
  const statusElement = root.closest(".dialog")?.querySelector("#draft-autosave-status");
  const render = autosaveState => {
    const element = statusElement;
    if (!element) return;
    element.textContent = autosaveStatusText(autosaveState);
    element.dataset.status = autosaveState.status;
  };
  const controller = createDraftAutosave({ initialEtag, initialSavedAt, collect, save, render, delay });
  activeDraftAutosave = controller;
  const mark = event => {
    if (event.target.closest?.("[data-attachment-file]") || !shouldTrack(event.target)) return;
    controller.markDirty();
  };
  root.addEventListener("input", mark);
  root.addEventListener("change", mark);
  root.addEventListener("click", event => {
    if (event.target.closest("[data-add-survey-row], [data-action='remove-survey-row'], [data-add-quote-row], .qe-remove")) mark(event);
  });
  render({ status: "READY", ...controller.getState() });
  return controller;
}

async function requestCloseDialog() {
  if (activeDraftAutosave?.getState().pending) {
    try {
      await activeDraftAutosave.flush();
    } catch (error) {
      const discard = await confirmInApp({
        title: "关闭窗口",
        message: `草稿中仍有未填写或不符合要求的内容：${error.message}。你可以返回继续填写，也可以放弃本次未保存内容。`,
        confirmLabel: "放弃并关闭",
        cancelLabel: "继续填写",
        danger: true
      });
      if (!discard) return;
    }
  }
  closeDialog();
}

window.addEventListener("beforeunload", event => {
  if (!activeDraftAutosave?.getState().pending && !dialogStack.some(item => item.autosave?.getState().pending)) return;
  event.preventDefault();
  event.returnValue = "";
});

function resetBusinessState() {
  customerRenderGate.invalidate();
  mapRenderGate.invalidate();
  Object.assign(state, {
    page: "dashboard", dashboard: null, customers: [], quotes: [], surveys: [], surveyTemplates: [], customerWorkspace: null,
    quoteFilters: { query: "", status: "" },
    customerFilters: { search: "", ownerId: "", status: "", source: "", customerType: "", industry: "", region: "", registeredFrom: "", registeredTo: "" },
    mapFilters: { ownerId: "", status: "", region: "" }, mapData: null, mapImageReady: false, mapPickerCustomerId: null, mapPickerAssetSha256: null,
    importJob: null, sopFilters: { role: "", stage: "", query: "" }, users: []
  });
}

const roleLabels = { PRESALES: "售前人员", MANAGER: "研发经理", VP: "副总经理", ADMIN: "系统管理员" };
const customerStatuses = ["初期接洽", "现场调研", "方案&报价", "报价完成&商务洽谈", "合同签订完成", "丢标", "中止"];
const quoteStatusLabels = { DRAFT: "未发送", PENDING_MANAGER: "待研发部经理审核", PENDING_GENERAL_MANAGER: "待综合部经理审核", PENDING_VP: "待副总经理审核", MANAGER_RETURNED: "研发部经理退回", GENERAL_MANAGER_RETURNED: "综合部经理退回", VP_RETURNED: "副总经理退回", APPROVED: "审核通过", VOID: "已作废" };
const surveyStatusLabels = { DRAFT: "草稿", COMPLETED: "已完成" };
const contractStatusLabels = { DRAFT: "草稿", GENERATED: "已生成", SIGNING: "签订中", SIGNED: "已签订", VOID: "已作废" };
const contractTemplateStatusLabels = { VALIDATED: "校验通过", REJECTED: "校验未通过", PUBLISHED: "已发布" };
const contractFileLabels = { SYSTEM_GENERATED: "系统生成原始版", WORD_EDITED: "外部修改版", FINAL_SIGNED: "最终签订版" };
const reminderStatusLabels = { PENDING: "待处理", OVERDUE: "已逾期", COMPLETED: "已完成", CANCELED: "已取消", UNABLE_PENDING: "无法完成、待指派人确认" };
const reminderPriorityLabels = { LOW: "低", MEDIUM: "中", HIGH: "高" };
const reminderEventTypeLabels = { CREATED: "新建提醒", ASSIGNED: "领导指派", COMPLETED: "完成提醒", POSTPONED: "延期提醒", CANCELED: "取消提醒", UNABLE_REPORTED: "上报无法完成", CLOSE_CONFIRMED: "确认关闭", RESTORED: "恢复执行", REASSIGNED: "重新指派" };
const approvalStageLabels = { MANAGER: "研发部经理", GENERAL_MANAGER: "综合部经理", VP: "副总经理" };
const approvalDecisionLabels = { APPROVED: "通过", REJECTED: "退回" };
const duplicateRelationTypeLabels = { SAME_NAME_DISTINCT: "同名不同主体" };
const customerFieldLabels = { full_name: "客户全称", short_name: "简称", source: "客户来源", customer_type: "客户类型", registered_on: "登记时间", status: "客户阶段", need_summary: "客户需求", industry: "行业", province: "省", city: "市", district: "区县", address: "详细地址", longitude: "经度", latitude: "纬度", summary: "客户情况总结", notes: "备注" };
const auditActionLabels = { CUSTOMER_CREATED: "创建客户", CUSTOMER_UPDATED: "修改客户主档", CUSTOMER_STATUS_CHANGED: "变更客户阶段", CUSTOMER_REGISTERED_ON_SUPPLEMENTED: "补录登记时间", CUSTOMER_REGISTERED_ON_CHANGED: "修改登记时间", CUSTOMER_TRANSFERRED: "转让客户", CONTACT_CREATED: "新增联系人", CONTACT_UPDATED: "修改联系人", PROJECT_CREATED: "新增项目机会", FOLLOWUP_CREATED: "新增跟进", FOLLOWUP_UPDATED: "修改跟进", REMINDER_CREATED: "创建本人提醒", REMINDER_ASSIGNED: "领导指派提醒", REMINDER_COMPLETE: "完成提醒", REMINDER_POSTPONE: "延期提醒", REMINDER_CANCEL: "取消提醒", SURVEY_CREATED: "创建软件调研", SURVEY_VERSION_CREATED: "创建调研新版本", SURVEY_UPDATED: "修改调研", SURVEY_COMPLETED: "确认完成调研", SURVEY_DOCX_EXPORTED: "导出调研报告", QUOTE_CREATED: "创建报价", QUOTE_DRAFT_UPDATED: "修改未发送报价", QUOTE_SUBMITTED: "发送报价审批", QUOTE_MANAGER_APPROVED: "研发经理通过报价", QUOTE_MANAGER_REJECTED: "研发经理退回报价", QUOTE_GENERAL_MANAGER_APPROVED: "综合部经理通过报价", QUOTE_GENERAL_MANAGER_REJECTED: "综合部经理退回报价", QUOTE_VP_APPROVED: "副总经理终审通过报价", QUOTE_VP_REJECTED: "副总经理退回报价", APPROVED_QUOTE_DOCX_EXPORTED: "导出已审批报价", CONTRACT_DRAFT_CREATED: "创建合同草稿", CONTRACT_DRAFT_UPDATED: "修改合同草稿", CONTRACT_DOCX_GENERATED: "生成合同 Word", CONTRACT_EDITED_WORD_ARCHIVED: "归档外部修改版", CONTRACT_FINAL_SIGNED_ARCHIVED: "归档最终签订版", CONTRACT_VOIDED: "作废合同", FILE_GENERATED: "生成归档文件", FILE_DOWNLOADED: "下载归档文件", CONTRACT_FILE_DOWNLOADED: "下载合同文件", CUSTOMER_IMPORT_BATCH: "导入客户批次", USER_PROFILE_UPDATED: "更新个人资料" };
const storedFileLabels = { SURVEY_REPORT_DOCX: "软件调研报告", APPROVED_QUOTE_DOCX: "已审批报价 Word", FOLLOWUPS_DOCX: "客户跟进 Word" };
Object.assign(auditActionLabels, { FOLLOWUP_IMPORTED: "导入历史跟进", FOLLOWUPS_DOCX_EXPORTED: "导出客户跟进" });
Object.assign(auditActionLabels, { REMINDER_REPORT_UNABLE: "上报无法完成", REMINDER_CONFIRM_CLOSE: "确认关闭提醒", REMINDER_RESTORE: "恢复提醒执行", REMINDER_REASSIGN: "重新指派提醒", QUOTE_MANAGER_HANDOFF: "待审报价交接" });
Object.assign(auditActionLabels, { CUSTOMER_MAP_POINT_UPDATED: "修改客户地图点位", CONTRACT_CUSTOMER_STATUS_CONFIRMED: "确认合同签订并更新客户状态" });
Object.assign(auditActionLabels, { ATTACHMENT_UPLOADED: "上传附件", ATTACHMENT_VERSION_UPLOADED: "替换附件", ATTACHMENT_DELETED: "删除附件", ATTACHMENT_DOWNLOADED: "下载附件", ATTACHMENT_PREVIEWED: "在线查看附件", ATTACHMENT_SNAPSHOT_DOWNLOADED: "下载锁定附件", ATTACHMENT_SNAPSHOT_PREVIEWED: "在线查看锁定附件" });
Object.assign(auditActionLabels, { SURVEY_TEMPLATE_DRAFT_CREATED: "新建调研模板草稿", SURVEY_TEMPLATE_DRAFT_UPDATED: "修改调研模板草稿", SURVEY_TEMPLATE_PUBLISHED: "发布调研模板" });
Object.assign(auditActionLabels, { QUOTE_APPROVED_REVISION_CREATED: "从已审批报价创建调价版本" });

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function displayEnum(value, labels, fallback) {
  const key = String(value ?? "");
  if (Object.prototype.hasOwnProperty.call(labels, key)) return labels[key];
  if (!key || /^[A-Z][A-Z0-9_]*$/.test(key)) return fallback;
  return key;
}

function roleLabel(user) {
  if (user?.role === "MANAGER" && user.positionCode === "GENERAL_MANAGER") return "综合部经理";
  return roleLabels[user?.role] || "其他角色";
}

function quoteDisplayStatus(quote) {
  if (quote.status === "PENDING_VP" && quote.currentApprovalStage === "GENERAL_MANAGER") return "PENDING_GENERAL_MANAGER";
  if (quote.status === "MANAGER_RETURNED" && quote.approvals?.at(-1)?.stage === "GENERAL_MANAGER") return "GENERAL_MANAGER_RETURNED";
  return quote.status;
}

function quoteStatusLabel(quote) {
  return displayEnum(quoteDisplayStatus(quote), quoteStatusLabels, "状态待确认");
}

function canDecideQuote(quote) {
  if (!["PENDING_MANAGER", "PENDING_VP"].includes(quote.status)) return false;
  if (quote.currentApprovalStage === "MANAGER") {
    if (!quote.pendingManager?.id) return false;
    return state.user.role === "ADMIN" || (state.user.role === "MANAGER" && state.user.positionCode !== "GENERAL_MANAGER" && quote.pendingManager.id === state.user.id);
  }
  if (state.user.role === "ADMIN") return ["MANAGER", "GENERAL_MANAGER", "VP"].includes(quote.currentApprovalStage);
  if (quote.currentApprovalStage === "GENERAL_MANAGER") return state.user.role === "MANAGER" && state.user.positionCode === "GENERAL_MANAGER";
  return quote.currentApprovalStage === "VP" && state.user.role === "VP";
}

function quoteVersionHistoryNote(quote) {
  const previous = Array.isArray(quote.versionHistory) ? quote.versionHistory.at(-1) : null;
  if (!previous) return "";
  if (["MANAGER_RETURNED", "VP_RETURNED"].includes(previous.status)) {
    const rejection = previous.approvals?.filter(item => item.decision === "REJECTED").at(-1);
    return `<br><small class="quote-history-note">上版 ${escapeHtml(previous.versionLabel)} 已由${escapeHtml(approvalStageLabels[rejection?.stage] || "审批人")}退回${rejection?.comment ? `：${escapeHtml(rejection.comment)}` : ""}</small>`;
  }
  if (previous.status === "APPROVED" && quote.status === "DRAFT") return `<br><small class="quote-history-note">基于已审批 ${escapeHtml(previous.versionLabel)} 创建的调价版本</small>`;
  return "";
}

function formatMoney(cents) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format((cents || 0) / 100);
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", hour12: false }).format(new Date(value));
}

function formatFollowupTime(item) {
  return item.occurredPrecision === "DAY" ? `${escapeHtml(item.occurredAt)}（日精度，原文未记录时分）` : formatTime(item.occurredAt);
}

function followupSourceDetails(source) {
  return `<details class="section-gap"><summary>历史来源（只读）</summary><p class="history-source-text">SHA-256：${escapeHtml(source.sourceSha256)}<br>${escapeHtml(source.sheetName)}!${escapeHtml(source.cellReference)} · 第${source.paragraphNumber}段<br>原日期：${escapeHtml(source.rawDate)} · 原方式：${escapeHtml(source.rawMethod || "未标注")}<br>批次：${escapeHtml(source.batchId)} · 操作人ID：${escapeHtml(source.operatedBy)} · 导入于 ${formatTime(source.importedAt)}</p><pre class="history-source-text">${escapeHtml(source.rawText)}</pre></details>`;
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  toastRoot.append(toast);
  setTimeout(() => toast.remove(), 3200);
}

function downloadFile(fileId) {
  const link = document.createElement("a");
  link.href = `/api/files/${encodeURIComponent(fileId)}/download`;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

function downloadContractFile(fileId) {
  const link = document.createElement("a");
  link.href = `/api/contract-files/${encodeURIComponent(fileId)}/download`;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

function downloadAttachment(attachmentId, versionId = "") {
  const link = document.createElement("a");
  link.href = `/api/attachments/${encodeURIComponent(attachmentId)}/download${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

function downloadAttachmentSnapshot(snapshotId) {
  const link = document.createElement("a");
  link.href = `/api/attachment-snapshots/${encodeURIComponent(snapshotId)}/download`;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

function previewAttachment(attachmentId, versionId = "") {
  const url = `/api/attachments/${encodeURIComponent(attachmentId)}/preview${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function previewAttachmentSnapshot(snapshotId) {
  window.open(`/api/attachment-snapshots/${encodeURIComponent(snapshotId)}/preview`, "_blank", "noopener,noreferrer");
}

function attachmentItemsFor(data, targetType, targetId, targetKey = "") {
  return (data?.items || []).filter(item => item.targetType === targetType && item.targetId === targetId && (item.targetKey || "") === targetKey);
}

function quoteInlineAttachments(data, quoteVersionId, label = "附件") {
  const items = attachmentItemsFor(data, "QUOTE_VERSION", quoteVersionId);
  const cards = items.map((item, index) => {
    const current = data?.mode === "SNAPSHOT" ? item : item.currentVersion;
    const id = item.id;
    const route = data?.mode === "SNAPSHOT" ? "attachment-snapshots" : "attachments";
    const name = current?.originalName || "附件";
    if (current?.mimeType === "application/pdf") return `<article class="quote-inline-attachment"><h3>${escapeHtml(label)} ${index + 1}：${escapeHtml(name)}</h3><div class="quote-pdf-preview" data-quote-pdf-preview data-pdf-url="/api/${route}/${encodeURIComponent(id)}/preview"><span class="quote-pdf-status" data-pdf-status>正在加载 PDF…</span><div class="quote-pdf-pages" data-pdf-pages></div></div></article>`;
    const previewButton = data?.mode === "SNAPSHOT" ? `data-attachment-snapshot-preview="${escapeHtml(id)}"` : `data-attachment-preview="${escapeHtml(id)}"`;
    return `<article class="quote-inline-attachment"><h3>${escapeHtml(label)} ${index + 1}：${escapeHtml(name)}</h3><button class="button small" type="button" ${previewButton}>在新窗口查看</button><iframe class="quote-inline-attachment-frame" sandbox="allow-same-origin" loading="lazy" title="${escapeHtml(name)} 内容预览" src="/api/${route}/${encodeURIComponent(id)}/preview"></iframe></article>`;
  }).join("");
  return `<section class="quote-inline-attachments" data-quote-inline-target="${escapeHtml(quoteVersionId)}"${items.length ? "" : " hidden"}>${cards}</section>`;
}

function attachmentBlock({ title = "附件", data, targetType, targetId, targetKey = "", writable = false, compact = false, uploadedSource = false }) {
  const items = attachmentItemsFor(data, targetType, targetId, targetKey);
  const blockId = `attachment-${crypto.randomUUID()}`;
  const quoteAttachment = targetType === "QUOTE_VERSION";
  const accept = quoteAttachment ? (uploadedSource && !targetKey ? ".pdf" : ".docx") : ".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg";
  const uploadLabel = quoteAttachment ? "+ 添加文件" : "+ 上传附件";
  const upload = writable ? `<button class="button small" type="button" data-attachment-pick="${blockId}">${uploadLabel}</button><input id="${blockId}" class="attachment-file-input" type="file" accept="${accept}" data-attachment-file data-target-type="${targetType}" data-target-id="${escapeHtml(targetId)}" data-target-key="${escapeHtml(targetKey)}" />` : `<span class="tag">${data?.mode === "SNAPSHOT" && quoteAttachment ? "审批附件" : "只读"}</span>`;
  const rows = items.map(item => {
    if (data?.mode === "SNAPSHOT") return `<li><div><strong>${escapeHtml(item.originalName)}</strong><small>R${item.revision} · ${formatTime(item.createdAt)} · ${(item.sizeBytes / 1024).toFixed(1)} KB · SHA-256 ${escapeHtml(item.sha256.slice(0, 16))}…</small></div><div class="actions"><button class="button small" data-attachment-snapshot-preview="${item.id}">在线查看</button><button class="button small" data-attachment-snapshot-download="${item.id}">下载</button></div></li>`;
    const current = item.currentVersion;
    const history = item.versions.length > 1 ? `<details><summary>历史版本（${item.versions.length}）</summary><ul class="attachment-version-list">${item.versions.slice().reverse().map(version => `<li><span>R${version.revision} · ${escapeHtml(version.originalName)} · ${formatTime(version.createdAt)}</span><span class="actions"><button class="text-button" data-attachment-preview="${item.id}" data-version-id="${version.id}">在线查看</button><button class="text-button" data-attachment-download="${item.id}" data-version-id="${version.id}">下载</button></span></li>`).join("")}</ul></details>` : "";
    return `<li><div><strong>${escapeHtml(current.originalName)}</strong><small>当前 R${current.revision} · ${escapeHtml(current.uploadedBy.displayName)} · ${formatTime(current.createdAt)} · ${(current.sizeBytes / 1024).toFixed(1)} KB · SHA-256 ${escapeHtml(current.sha256.slice(0, 16))}…</small>${history}</div><div class="actions"><button class="button small" data-attachment-preview="${item.id}">在线查看</button><button class="button small" data-attachment-download="${item.id}">下载</button>${writable ? `<button class="button small" type="button" data-attachment-replace="${item.id}" data-current-version="${current.id}" data-file-input="${blockId}">替换</button><button class="button small danger" data-attachment-delete="${item.id}">删除</button>` : ""}</div></li>`;
  }).join("");
  const help = quoteAttachment ? (targetKey === "QUOTE_WORD" ? "Word 源文件选填；审批以 PDF 报价单为准。" : uploadedSource ? "正式报价单为 PDF，单文件不超过 20 MB。" : "仅支持 Word（DOCX），单文件不超过 20 MB。") : "允许 PDF、DOCX、XLSX、PPTX、PNG、JPG/JPEG，单文件不超过 20 MB；系统校验文件真实结构，但未宣称已进行病毒查杀。";
  const contents = `<div class="card-head"><h${compact ? "4" : "3"}>${escapeHtml(title)} <span class="muted">(${items.length})</span></h${compact ? "4" : "3"}>${upload}</div>${rows ? `<ul class="list attachment-list">${rows}</ul>` : `<div class="empty attachment-empty">暂无附件</div>`}<small class="attachment-help">${help}</small>`;
  return compact ? `<details class="attachment-block compact" data-attachment-block data-target-type="${targetType}" data-target-id="${escapeHtml(targetId)}" data-target-key="${escapeHtml(targetKey)}"><summary>${escapeHtml(title)}（${items.length}）</summary>${contents}</details>` : `<section class="detail-section attachment-block" data-attachment-block data-target-type="${targetType}" data-target-id="${escapeHtml(targetId)}" data-target-key="${escapeHtml(targetKey)}">${contents}</section>`;
}

async function refreshAttachmentBlocks(targetType, targetId) {
  const blocks = [...document.querySelectorAll("[data-attachment-block]")].filter(block => block.dataset.targetId === targetId);
  if (!blocks.length) return;
  const data = targetType === "SURVEY" || targetType === "SURVEY_QUESTION" ? await api(`/api/surveys/${encodeURIComponent(targetId)}/attachments`) : await api(`/api/attachments?targetType=${encodeURIComponent(targetType)}&targetId=${encodeURIComponent(targetId)}`);
  for (const block of blocks) {
    const replacement = attachmentBlock({ title: block.querySelector("h3,h4")?.childNodes[0]?.textContent?.trim() || "附件", data, targetType: block.dataset.targetType, targetId: block.dataset.targetId, targetKey: block.dataset.targetKey || "", writable: block.querySelector("[data-attachment-file]") !== null, compact: block.matches("details") });
    const template = document.createElement("template");
    template.innerHTML = replacement;
    block.replaceWith(template.content.firstElementChild);
  }
  if (targetType === "QUOTE_VERSION") {
    for (const inline of document.querySelectorAll("[data-quote-inline-target]")) {
      if (inline.dataset.quoteInlineTarget !== targetId) continue;
      const template = document.createElement("template");
      template.innerHTML = quoteInlineAttachments(data, targetId);
      disposeInlinePdfViewers(inline);
      inline.replaceWith(template.content.firstElementChild);
    }
    initializeInlinePdfViewers(dialogRoot);
  }
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (state.csrfToken && !["GET", "HEAD"].includes(options.method || "GET")) headers["X-CSRF-Token"] = state.csrfToken;
  const response = await fetch(url, { credentials: "same-origin", ...options, headers });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/auth/login") {
      resetBusinessState();
      state.user = null;
      state.csrfToken = null;
      renderLogin();
    }
    if (data.error?.code === "PASSWORD_CHANGE_REQUIRED" && state.user) {
      state.user.mustChangePassword = true;
      renderPasswordChange();
    }
    const error = new Error(data.error?.message || "请求失败");
    error.details = data.error?.details;
    throw error;
  }
  return data;
}

async function downloadQuotePreview(versionId) {
  const response = await fetch(`/api/quote-versions/${encodeURIComponent(versionId)}/preview-docx`, {
    method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": state.csrfToken }
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message || "导出预览失败");
  }
  const blob = await response.blob();
  const match = response.headers.get("Content-Disposition")?.match(/filename\*=UTF-8''([^;]+)/i);
  let filename = "未审批预览.docx";
  if (match) {
    try { filename = decodeURIComponent(match[1]); } catch { /* 使用默认文件名 */ }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadQuoteTemplate() {
  const response = await fetch("/api/quote-template/download", { credentials: "same-origin" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message || "下载标准模板失败");
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = "软件报价单标准模板.docx";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderLogin() {
  closeAllDialogs();
  state.customerWorkspace = null;
  root.innerHTML = `
    <main class="login-page">
      <section class="login-card">
        <div class="login-brand"><span class="brand-mark">HH</span><div><strong>海弘售前协同</strong><small>Haihong Presales Hub</small></div></div>
        <h1>登录售前系统</h1>
        <p>请使用管理员分配的独立账号。审批操作将记录实际账号。</p>
        <form id="login-form">
          <div class="field"><label class="required" for="username">用户名</label><input id="username" name="username" autocomplete="username" required /></div>
          <div class="field"><label class="required" for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required /></div>
          <div class="form-error" id="login-error" role="alert"></div>
          <button class="button primary" type="submit">登录</button>
        </form>
      </section>
      <aside class="login-side"><h2>${isCoreLaunch() ? "集中维护客户资料与对客报价。" : "把客户跟进、提醒、报价审批与合同风险控制放在同一个可信流程中。"}</h2><p>${isCoreLaunch() ? "首期开放客户管理和报价审批；客户数据按当前负责人隔离，报价版本与审批记录全程留痕。" : "系统仅用于公司内部；客户数据按当前负责人隔离，审批与合同版本全程留痕。"}</p></aside>
    </main>`;
  document.querySelector("#login-form").addEventListener("submit", async event => {
    event.preventDefault();
    const errorEl = document.querySelector("#login-error");
    errorEl.textContent = "正在登录…";
    const form = new FormData(event.currentTarget);
    try {
      const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
      resetBusinessState();
      state.user = result.user;
      state.csrfToken = result.csrfToken;
      state.page = defaultPageForUser();
      if (state.user.mustChangePassword) return renderPasswordChange();
      renderShell();
      await go(defaultPageForUser());
    } catch (error) {
      errorEl.textContent = error.message;
    }
  });
}

function renderPasswordChange() {
  closeAllDialogs();
  state.customerWorkspace = null;
  root.innerHTML = `<main class="login-page"><section class="login-card"><h1>请先修改重置后的密码</h1><p>临时登录仅允许本人改密或退出，尚未开放业务数据。</p><form id="change-password-form"><div class="field"><label for="current-password">当前临时密码</label><input id="current-password" type="password" autocomplete="current-password" required /></div><div class="field"><label for="new-password">新密码（至少 12 位）</label><input id="new-password" type="password" autocomplete="new-password" required /></div><div class="field"><label for="confirm-password">确认新密码</label><input id="confirm-password" type="password" autocomplete="new-password" required /></div><div id="password-change-error" class="form-error" role="alert"></div><div class="actions"><button class="button primary" type="submit">修改密码并进入系统</button><button class="button" type="button" data-action="logout">退出登录</button></div></form></section></main>`;
  document.querySelector("#change-password-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("[type=submit]");
    if (button.disabled) return;
    button.disabled = true;
    const errorEl = document.querySelector("#password-change-error");
    try {
      const newPassword = document.querySelector("#new-password").value;
      if (newPassword !== document.querySelector("#confirm-password").value) throw new Error("两次新密码输入不一致");
      const result = await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: document.querySelector("#current-password").value, newPassword }) });
      state.user = result.user;
      state.csrfToken = result.csrfToken;
      renderShell();
      await go(defaultPageForUser());
    } catch (error) { errorEl.textContent = error.message; }
    finally { if (button.isConnected) button.disabled = false; }
  });
}

function navItems() {
  if (isCoreLaunch()) {
    const items = [["customers", "◎", "客户管理"], ["quotes", "¥", "报价管理"]];
    if (state.user.role === "ADMIN") items.push(["settings", "⚙", "系统管理"]);
    return items;
  }
  const items = [
    ["dashboard", "⌂", "工作台"],
    ["customers", "◎", "客户管理"],
    ["map", "⌖", "分布地图"],
    ["surveys", "▤", "软件调研"],
    ["quotes", "¥", "报价管理"],
    ["contracts", "▣", "合同管理"],
    ["sop", "☰", "岗位职责与 SOP"]
  ];
  if (state.user.role === "VP" || (state.user.role === "MANAGER" && state.user.positionCode !== "GENERAL_MANAGER")) return items.filter(([key]) => ["dashboard", "customers", "quotes", "sop"].includes(key));
  if (state.user.role === "ADMIN") items.push(["settings", "⚙", "系统设置"]);
  return items;
}

function openProfileDialog({ resumeQuote = false, quoteVersionId = null, preselectedCustomerId = null } = {}) {
  openDialog("维护个人资料", `<div class="notice">手机号码和邮箱会自动带入本人新建的报价单，请填写本人可对外使用的联系信息。</div><div class="form-grid"><div class="field full"><label>姓名</label><input value="${escapeHtml(state.user.displayName)}" disabled /></div><div class="field"><label class="required">手机号码</label><input id="profile-phone" value="${escapeHtml(state.user.phone || "")}" autocomplete="tel" maxlength="30" /></div><div class="field"><label class="required">邮箱</label><input id="profile-email" type="email" value="${escapeHtml(state.user.email || "")}" autocomplete="email" maxlength="200" /></div></div>`, {
    submitLabel: "保存个人资料",
    onSubmit: async () => {
      const result = await api("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ phone: document.querySelector("#profile-phone").value, email: document.querySelector("#profile-email").value }) });
      state.user = result.user;
      closeDialog();
      renderShell();
      await go(state.page || "dashboard");
      showToast("个人联系信息已保存");
      if (resumeQuote) await openQuoteEditor(quoteVersionId, preselectedCustomerId);
    }
  });
}

function renderShell() {
  const reminderBell = moduleEnabled("reminders") ? `<button class="bell" data-action="open-reminders" aria-label="打开统一提醒中心"><span aria-hidden="true">♢</span><span class="bell-count" id="bell-count">0</span></button>` : "";
  const profileState = state.user.phone && state.user.email ? roleLabel(state.user) : "联系信息待补充";
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">HH</span><div><strong>海弘售前协同</strong><small>Presales Hub</small></div></div>
        <nav class="nav" id="nav" aria-label="主导航">${navItems().map(([key, icon, label]) => `<button data-page="${key}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span></button>`).join("")}</nav>
        <div class="sidebar-foot"><button class="sidebar-profile" type="button" data-action="edit-profile" aria-label="维护个人资料" title="维护手机和邮箱"><span class="user-avatar">${escapeHtml(state.user.displayName.slice(0, 1))}</span><span class="sidebar-profile-copy"><strong>${escapeHtml(state.user.displayName)}</strong><small>${escapeHtml(profileState)}</small></span><span class="sidebar-mobile-label" aria-hidden="true">我的</span></button><button class="logout" data-action="logout"><span aria-hidden="true">⇥</span><span>退出登录</span></button></div>
      </aside>
      <div class="main">
        <header class="topbar"><div class="topbar-spacer"></div>${reminderBell}</header>
        <main class="content" id="content" tabindex="-1"></main>
      </div>
    </div>`;
}

function pageHead(title, subtitle, actions = "", { sticky = true } = {}) {
  const stickyClass = actions ? " page-head-sticky" : "";
  return `<div class="page-head${sticky ? stickyClass : ""}"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div><div class="actions">${actions}</div></div>`;
}

async function go(page) {
  if (state.user?.mustChangePassword) return renderPasswordChange();
  if (!pageAllowed(page)) page = defaultPageForUser();
  if (page !== "customers") customerRenderGate.invalidate();
  if (page !== "map") mapRenderGate.invalidate();
  state.page = page;
  document.querySelectorAll("#nav [data-page]").forEach(button => button.classList.toggle("active", button.dataset.page === page));
  const content = document.querySelector("#content");
  content.innerHTML = `<div class="empty">正在加载…</div>`;
  try {
    if (page === "dashboard") await renderDashboard(content);
    if (page === "customers") await renderCustomers(content);
    if (page === "map") await renderMap(content);
    if (page === "surveys") await renderSurveys(content);
    if (page === "quotes") await renderQuotes(content);
    if (page === "contracts") await renderContracts(content);
    if (page === "sop") await renderSop(content);
    if (page === "settings") await renderSettings(content);
    content.focus();
  } catch (error) {
    content.innerHTML = `<div class="notice danger">${escapeHtml(error.message)}</div>`;
  }
}

async function renderDashboard(content) {
  state.dashboard = await api("/api/dashboard");
  const reminderCount = state.dashboard.reminderSummary.overdue + state.dashboard.reminderSummary.nextSevenDays + state.dashboard.reminderSummary.pendingConfirmation;
  const actionCount = reminderCount + state.dashboard.pendingApprovalCount;
  const bell = document.querySelector(".bell");
  document.querySelector("#bell-count").textContent = reminderCount;
  bell.classList.toggle("has-alerts", reminderCount > 0);
  const items = state.dashboard.reminderSummary.items;
  const confirmationItems = state.dashboard.reminderSummary.confirmationItems || [];
  const pendingApprovalItems = state.dashboard.pendingApprovalItems || [];
  const priorityItems = [
    ...confirmationItems.map(item => ({ kind: "confirmation", item })),
    ...items.filter(item => item.status === "OVERDUE").map(item => ({ kind: "overdue", item })),
    ...pendingApprovalItems.map(item => ({ kind: "approval", item })),
    ...items.filter(item => item.status !== "OVERDUE" && item.status !== "UNABLE_PENDING").map(item => ({ kind: "reminder", item }))
  ].slice(0, 8);
  const canCreateCustomerRecord = canCreateCustomer(state.user.role);
  const focusByRole = {
    PRESALES: "先处理逾期跟进，再安排未来 7 天的客户行动。",
    MANAGER: "优先处理下属无法完成事项和待部门审核报价。",
    VP: "优先完成报价终审，并关注已指派事项的进展。",
    ADMIN: "优先处理异常待办，再检查团队业务是否持续推进。"
  };
  if (state.user.role === "MANAGER" && state.user.positionCode === "GENERAL_MANAGER") focusByRole.MANAGER = "优先处理研发经理已通过的报价，再检查审核意见是否完整。";
  const customerStatusCounts = state.dashboard.customerStatusCounts || {};
  const terminalStatuses = new Set(["合同签订完成", "丢标", "中止"]);
  const pipelineEntries = Object.entries(customerStatusCounts).filter(([status]) => !terminalStatuses.has(status));
  const activeCustomers = pipelineEntries.reduce((sum, [, count]) => sum + count, 0);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  content.innerHTML = `
    <section class="dashboard-hero">
      <div>
        <span class="dashboard-eyebrow">今日行动台 · ${escapeHtml(roleLabel(state.user))}</span>
        <h1>${greeting}，${escapeHtml(state.user.displayName)}</h1>
        <p>${actionCount > 0 ? `当前有 <strong>${actionCount}</strong> 项工作需要你关注。${escapeHtml(focusByRole[state.user.role])}` : `当前没有紧急待办。${escapeHtml(focusByRole[state.user.role])}`}</p>
      </div>
      <div class="hero-actions"><button class="button primary" data-action="open-reminders">查看我的待办</button><button class="button hero-secondary" data-action="new-reminder">新建或指派提醒</button></div>
    </section>
    <section class="action-metrics" aria-label="需要处理的工作">
      ${actionMetric("已逾期", state.dashboard.reminderSummary.overdue, "超过提醒时间仍未完成", "danger", "open-reminders", "逾")}
      ${actionMetric("待我审批", state.dashboard.pendingApprovalCount, "报价等待当前账号处理", "warning", "quotes", "审")}
      ${actionMetric("待我确认", state.dashboard.reminderSummary.pendingConfirmation, "下属上报无法完成", "attention", "open-reminders", "确")}
      ${actionMetric("未来 7 天", state.dashboard.reminderSummary.nextSevenDays, "即将到期的跟进行动", "info", "open-reminders", "近")}
    </section>
    <section class="dashboard-columns section-gap">
      <div class="dashboard-column dashboard-column-main">
        <div class="card priority-card">
          <div class="card-head"><div><span class="section-kicker">按紧急程度排序</span><h2>优先处理</h2></div><button class="text-button" data-action="open-reminders">进入待办中心 →</button></div>
          ${priorityItems.length ? `<ul class="priority-list">${priorityItems.map(priorityRow).join("")}</ul>` : `<div class="dashboard-empty"><span>✓</span><strong>当前待办已清空</strong><p>新的提醒或审批到达后会优先显示在这里。</p></div>`}
        </div>
        <div class="card recent-card"><div class="card-head"><div><span class="section-kicker">最近更新</span><h2>客户动态</h2></div><button class="text-button" data-page="customers">查看全部 →</button></div>${state.dashboard.recentCustomers.length ? `<ul class="recent-customers">${state.dashboard.recentCustomers.map(customer => `<li><button data-customer-open="${customer.id}"><span><strong>${escapeHtml(customer.shortName || customer.fullName)}</strong><small>${escapeHtml(customer.owner.displayName)} · ${escapeHtml(customer.province || customer.city || "地区未填写")}</small></span><span class="stage-pill">${escapeHtml(customer.status)}</span></button></li>`).join("")}</ul>` : `<div class="empty compact">暂无客户动态</div>`}</div>
      </div>
      <aside class="dashboard-column dashboard-column-side">
        <div class="card pipeline-card"><div class="card-head"><div><span class="section-kicker">客户推进概览</span><h2>业务阶段 · ${activeCustomers} 个推进中</h2></div><button class="text-button" data-page="customers">查看客户 →</button></div><div class="pipeline-list">${pipelineEntries.length ? pipelineEntries.map(([status, count]) => pipelineRow(status, count, Math.max(activeCustomers, 1))).join("") : `<div class="empty compact">暂无推进中的客户</div>`}</div></div>
        <div class="card quick-card"><div class="card-head"><div><span class="section-kicker">常用操作</span><h2>快速开始</h2></div></div><div class="card-body quick-actions">${canCreateCustomerRecord ? `<button data-action="new-customer"><span class="quick-icon">＋</span><strong>新增客户</strong><span>建立本人或下属客户档案</span></button>` : ""}<button data-action="new-reminder"><span class="quick-icon">◇</span><strong>新建提醒</strong><span>本人创建或领导指派</span></button><button data-page="quotes"><span class="quick-icon">¥</span><strong>报价审批</strong><span>查看待审与历史版本</span></button></div></div>
      </aside>
    </section>`;
}

function actionMetric(label, count, description, tone, target, icon) {
  const targetAttribute = target === "quotes" ? `data-page="quotes"` : `data-action="${target}"`;
  return `<button class="action-metric ${tone}${count ? " has-work" : " is-clear"}" ${targetAttribute}><span class="action-symbol">${icon}</span><span class="action-copy"><strong>${escapeHtml(label)}</strong><em>${count ? escapeHtml(description) : "当前已清空"}</em></span><span class="action-value">${count}</span></button>`;
}

function priorityRow(entry) {
  if (entry.kind === "approval") {
    const quote = entry.item;
    return `<li><span class="priority-mark warning">审</span><div><span class="priority-meta">待报价审批 · ${formatTime(quote.submittedAt)}</span><strong>${escapeHtml(quote.customer.name)}</strong><small>${escapeHtml(quote.quoteNumber)} ${escapeHtml(quote.versionLabel)} · ${formatMoney(quote.finalDiscountCents)}</small></div><button class="button small" data-page="quotes">去审批</button></li>`;
  }
  const item = entry.item;
  const tone = entry.kind === "overdue" ? "danger" : entry.kind === "confirmation" ? "attention" : "info";
  const label = entry.kind === "overdue" ? "逾" : entry.kind === "confirmation" ? "确" : "近";
  return `<li><span class="priority-mark ${tone}">${label}</span><div><span class="priority-meta">${entry.kind === "confirmation" ? "无法完成 · 待你确认" : entry.kind === "overdue" ? "已逾期" : "近期提醒"} · ${formatTime(item.remindAt)}</span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.customerName)} · ${escapeHtml(item.assignee?.displayName || "负责人未记录")}${item.source === "LEADER" ? ` · ${escapeHtml(item.assignedBy.displayName)} 指派` : ""}</small></div><button class="button small" data-action="open-reminders">处理</button></li>`;
}

function pipelineRow(status, count, total) {
  const ratio = total ? Math.max(4, Math.round((count / total) * 100)) : 0;
  return `<button data-page="customers"><span><strong>${escapeHtml(status)}</strong><small>${count} 个客户</small></span><span class="pipeline-track"><i style="width:${ratio}%"></i></span><b>${count}</b></button>`;
}

function reminderRow(item) {
  return `<li><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.customerName)} · ${escapeHtml(item.businessObject?.label || "客户档案")} · ${formatTime(item.remindAt)} · ${item.source === "LEADER" ? `由 ${escapeHtml(item.assignedBy.displayName)} 指派` : "本人创建"}</small></div><span class="tag ${item.status === "OVERDUE" ? "red" : "orange"}">${item.status === "UNABLE_PENDING" ? "无法完成、待指派人确认" : item.status === "OVERDUE" ? "已逾期" : "待处理"}</span></li>`;
}

function selectOptions(items, value, label = item => item) {
  return items.map(item => { const optionValue = typeof item === "string" ? item : item.id; return `<option value="${escapeHtml(optionValue)}"${optionValue === value ? " selected" : ""}>${escapeHtml(label(item))}</option>`; }).join("");
}

function regionSelectOptions(items, current, placeholder) {
  const legacy = current && !items.includes(current);
  return `<option value="">${escapeHtml(placeholder)}</option>${legacy ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}（历史值）</option>` : ""}${items.map(item => `<option value="${escapeHtml(item)}"${item === current ? " selected" : ""}>${escapeHtml(item)}</option>`).join("")}`;
}

function chinaRegionFields({ provinceId, cityId, province = "", city = "", required = false }) {
  const cities = listChinaCities(province);
  return `<div class="region-select-pair full"><div class="field"><label${required ? ' class="required"' : ""}>省 / 自治区 / 直辖市</label><select id="${provinceId}">${regionSelectOptions(listChinaProvinces(), province, "请选择省份")}</select></div><div class="field"><label${required ? ' class="required"' : ""}>市 / 地区 / 自治州</label><select id="${cityId}"${province ? "" : " disabled"}>${regionSelectOptions(cities, city, province ? "请选择城市" : "请先选择省份")}</select></div><small class="field-help">先选择省份，再从对应城市中选择；无需手工输入。</small></div>`;
}

function bindChinaRegionSelects(provinceId, cityId) {
  const province = document.querySelector(`#${provinceId}`);
  const city = document.querySelector(`#${cityId}`);
  if (!province || !city) return;
  province.addEventListener("change", () => {
    city.innerHTML = regionSelectOptions(listChinaCities(province.value), "", province.value ? "请选择城市" : "请先选择省份");
    city.disabled = !province.value;
  });
}

function readCustomerFilters() {
  return {
    search: document.querySelector("#customer-search")?.value.trim() || "",
    ownerId: document.querySelector("#customer-owner")?.value || "",
    status: state.customerFilters.status || "",
    source: document.querySelector("#customer-source")?.value || "",
    customerType: document.querySelector("#customer-type")?.value || "",
    industry: document.querySelector("#customer-industry")?.value || "",
    region: document.querySelector("#customer-region")?.value || "",
    registeredFrom: document.querySelector("#customer-registered-from")?.value || "",
    registeredTo: document.querySelector("#customer-registered-to")?.value || ""
  };
}

async function renderCustomers(content, search = null) {
  if (typeof search === "string") state.customerFilters.search = search;
  const requestId = customerRenderGate.begin();
  const filters = { ...state.customerFilters };
  let result;
  try {
    result = await api(`/api/customers?${buildCustomerFilterQuery(filters)}`);
  } catch (error) {
    if (!customerRenderGate.isCurrent(requestId)) return;
    throw error;
  }
  if (!customerRenderGate.isCurrent(requestId)) return;
  state.customers = result.items;
  const options = result.filterOptions || { owners: [], sources: [], customerTypes: [], industries: [], regions: [] };
  const canRegister = canCreateCustomer(state.user.role) && (state.user.role !== "MANAGER" || state.user.positionCode === "GENERAL_MANAGER");
  const createAction = canRegister ? `<button class="button primary" data-action="new-customer">+ 新增客户</button>` : "";
  const counts = result.statusCounts || Object.fromEntries(customerStatuses.map(status => [status, state.customers.filter(customer => customer.status === status).length]));
  const allStageCount = customerStatuses.reduce((total, status) => total + (counts[status] || 0), 0);
  const tableView = `<div class="card table-wrap customer-table-view"><table><thead><tr><th>客户名称</th><th>客户阶段</th><th>登记时间</th><th>需求</th><th>区域</th><th>负责人</th><th>更新时间</th></tr></thead><tbody>${state.customers.map(customer => `<tr><td><button class="text-button customer-name-link" data-customer-open="${customer.id}" title="查看客户档案"><strong>${escapeHtml(customer.fullName)}</strong></button></td><td><span class="tag">${escapeHtml(customer.status)}</span></td><td>${customer.registeredOn ? escapeHtml(customer.registeredOn) : `<span class="muted">日期未知</span>${customer.canSupplementRegisteredOn ? `<br><button class="text-button" data-customer-date="${customer.id}">补录</button>` : ""}`}</td><td>${escapeHtml(customer.needSummary)}</td><td>${escapeHtml([customer.province, customer.city].filter(Boolean).join(" · ") || "—")}</td><td>${escapeHtml(customer.owner.displayName)}</td><td>${formatTime(customer.updatedAt)}</td></tr>`).join("")}</tbody></table>${state.customers.length ? "" : `<div class="empty">当前权限和筛选条件下没有客户</div>`}</div>`;
  content.innerHTML = `${pageHead("客户管理", "按阶段和负责人查找客户，点击客户名称进入完整档案", createAction)}
    <section class="card customer-filter-panel" aria-label="客户筛选">
      <div class="customer-filter-heading"><div><strong>筛选客户</strong><span>登记时间支持开始、结束日期组合查询</span></div></div>
      <div class="customer-filter-primary"><div class="field customer-name-filter"><label>客户名称</label><input id="customer-search" value="${escapeHtml(filters.search)}" placeholder="输入客户全称或简称" /></div><div class="field"><label>负责人</label><select id="customer-owner"><option value="">全部负责人</option>${selectOptions(options.owners, filters.ownerId, item => item.displayName)}</select></div><div class="customer-filter-actions"><button class="button primary" data-action="search-customers">应用筛选</button><button class="button" data-action="reset-customer-filters">重置</button></div></div>
      <div class="customer-filter-secondary"><div class="field"><label>客户来源</label><select id="customer-source"><option value="">全部来源</option>${selectOptions(options.sources, filters.source)}</select></div><div class="field"><label>客户类型</label><select id="customer-type"><option value="">全部类型</option>${selectOptions(options.customerTypes, filters.customerType)}</select></div><div class="field"><label>行业</label><select id="customer-industry"><option value="">全部行业</option>${selectOptions(options.industries, filters.industry)}</select></div><div class="field"><label>区域</label><select id="customer-region"><option value="">全部区域</option>${selectOptions(options.regions, filters.region)}</select></div><fieldset class="customer-date-range"><legend>登记时间范围</legend><label><span>开始日期</span><input id="customer-registered-from" type="date" value="${escapeHtml(filters.registeredFrom)}" /></label><i>至</i><label><span>结束日期</span><input id="customer-registered-to" type="date" value="${escapeHtml(filters.registeredTo)}" /></label></fieldset></div>
    </section>
    <section class="card customer-stage-panel"><div class="customer-stage-heading"><div><strong>客户阶段</strong><span>${filters.status ? `全部阶段共 ${allStageCount} 家，当前显示 ${state.customers.length} 家` : `符合其他筛选条件 ${allStageCount} 家`}；点击阶段筛选客户</span></div></div><div class="status-board" aria-label="按状态快速筛选"><button class="status-card${filters.status ? "" : " active"}" data-customer-board-status=""><span>全部阶段</span><strong>${allStageCount}</strong></button>${customerStatuses.map(status => `<button class="status-card${filters.status === status ? " active" : ""}" data-customer-board-status="${escapeHtml(status)}"><span>${escapeHtml(status)}</span><strong>${counts[status]}</strong></button>`).join("")}</div></section>
    ${tableView}`;
}

async function renderMap(content) {
  const requestId = mapRenderGate.begin();
  const filters = { ...state.mapFilters };
  let data;
  try {
    data = await api(`/api/map?${buildCustomerFilterQuery(filters)}`);
  } catch (error) {
    if (!mapRenderGate.isCurrent(requestId)) return;
    throw error;
  }
  if (!mapRenderGate.isCurrent(requestId)) return;
  state.mapData = data;
  state.mapImageReady = false;
  state.mapPickerCustomerId = null;
  state.mapPickerAssetSha256 = null;
  const usesGeoMap = data.provinceMap?.status === "READY";
  const pointButtons = data.customerPoints.map(point => {
    const position = normalizedMapPosition(point.mapPosition);
    return position ? `<button class="map-customer-point" style="--map-left:${position.left}%;--map-top:${position.top}%" data-map-customer="${point.id}" aria-label="${escapeHtml(point.name)}"><span></span></button>` : "";
  }).join("");
  const regionButtons = data.representatives.flatMap(rep => rep.regionSummaries.map(region => {
    const position = normalizedMapPosition(region.anchor);
    return position ? `<button class="map-region-marker" style="--map-left:${position.left}%;--map-top:${position.top}%" data-map-region-owner="${rep.id}" data-map-region-name="${escapeHtml(region.name)}"><span>${escapeHtml(region.name.replace(/省|市|自治区|特别行政区/g, ""))}</span></button>` : "";
  })).join("");
  const visibleCustomers = [...data.customerPoints, ...data.unlocatedCustomers];
  const provinceSummaries = usesGeoMap ? summarizeCustomersByProvince(visibleCustomers) : [];
  const activeCustomerCount = visibleCustomers.filter(customer => !["丢标", "中止"].includes(customer.status)).length;
  const filtersActive = Boolean(filters.ownerId || filters.status || filters.region);
  const listFallback = `<div class="map-list-fallback" aria-label="区域与客户分布清单"><div class="map-list-head"><div><strong>区域与客户分布（清单模式）</strong><p>地图资源当前不可用，系统仍按售前、客户状态和区域展示权限内数据，不推测边界或坐标。</p></div><span class="tag">${visibleCustomers.length} 家可见客户</span></div>${data.representatives.length ? `<div class="map-owner-summary">${data.representatives.map(rep => `<section><div><strong>${escapeHtml(rep.displayName)}</strong><span>${rep.customerCount} 家客户</span></div>${rep.regionSummaries.length ? `<div class="map-region-chips">${rep.regionSummaries.map(region => `<button class="button small" data-map-region-owner="${rep.id}" data-map-region-name="${escapeHtml(region.name)}">${escapeHtml(region.name)} · ${region.customerCount}</button>`).join("")}</div>` : `<small>未配置负责区域</small>`}</section>`).join("")}</div>` : `<div class="empty">当前筛选条件下无区域分工</div>`}<div class="table-wrap"><table><thead><tr><th>客户</th><th>负责人</th><th>区域</th><th>状态</th><th>最近跟进</th><th>操作</th></tr></thead><tbody>${visibleCustomers.map(customer => `<tr><td><strong>${escapeHtml(customer.name)}</strong></td><td>${escapeHtml(customer.owner.displayName)}</td><td>${escapeHtml(customer.region)}</td><td><span class="tag">${escapeHtml(customer.status)}</span></td><td>${customer.lastFollowupAt ? formatTime(customer.lastFollowupAt) : "暂无跟进"}</td><td><button class="button small" data-map-customer="${customer.id}">查看</button></td></tr>`).join("")}</tbody></table>${visibleCustomers.length ? "" : `<div class="empty">当前权限和筛选条件下没有客户</div>`}</div></div>`;
  const geoMap = `<div class="china-geo-map-panel"><div class="china-geo-map-head"><div><strong>省份客户分布</strong><p>省名后的数字是当前权限和筛选范围内的客户数；点击省份色块、名称或数量查看客户清单，滚轮直接缩放。</p></div><div class="china-geo-map-actions"><span class="tag china-geo-map-summary">正在统计 ${visibleCustomers.length} 家客户</span><div class="map-zoom-controls" aria-label="地图缩放控制"><button class="button small" data-map-zoom="out" aria-label="缩小地图">−</button><span class="map-zoom-label" aria-live="polite">100%</span><button class="button small" data-map-zoom="in" aria-label="放大地图">＋</button><button class="button small" data-map-zoom="reset">复位</button></div></div></div><div class="china-geo-map-host" tabindex="0" aria-label="中国省级行政区客户业务分布示意图，支持滚轮缩放和拖动平移" aria-live="polite" aria-busy="true"><div class="map-placeholder">正在加载中国省级行政区地图…</div></div><div class="china-map-legend"><span><i class="legend-area level-0"></i>0 家</span><span><i class="legend-area level-1"></i>较少</span><span><i class="legend-area level-2"></i>较多</span><span><i class="legend-area level-3"></i>集中</span></div><div class="china-geo-unplaced" hidden></div><p class="china-map-note">颜色深浅及“省名 · 数量”均按当前可见客户实时汇总；具体客户和城市信息在省份清单中查看，不在地图上重复显示点位。省级汇总不改变客户归属，也不采集人员轨迹；正式对外用图可在安装自然资源部标准地图原图后切换。</p></div>`;
  const pendingPoints = !usesGeoMap && data.offlineBasemap.status === "READY" ? `<section class="detail-section"><h3>待人工选点 / 重新确认</h3>${data.unlocatedCustomers.length ? `<ul class="list compact-list">${data.unlocatedCustomers.map(customer => `<li><div><strong>${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.owner.displayName)} · ${escapeHtml(customer.region)}${customer.mapPointStatus === "RECONFIRM_REQUIRED" ? " · 底图已变化，需重新确认" : ""}</small></div>${customer.canEditPoint ? `<button class="button small" data-map-pick="${customer.id}">${customer.mapPointStatus === "RECONFIRM_REQUIRED" ? "重新确认点位" : "人工选点"}</button>` : `<span class="tag">只读</span>`}</li>`).join("")}</ul>` : `<div class="empty">没有待选点客户</div>`}</section>` : "";
  const mapNotice = usesGeoMap
    ? `<div class="notice map-scope-notice"><strong>当前查看范围：${escapeHtml(data.visibilityScope?.label || "权限内客户")}</strong><span>${escapeHtml(data.visibilityScope?.description || "只展示当前账号有权查看的客户")}。地图用于内网业务判断，不代表人员实时位置。</span></div>`
    : `<div class="notice ${data.offlineBasemap.status === "READY" ? "" : "warning"}"><strong>${data.offlineBasemap.status === "READY" ? "离线标准地图已校验：" : "当前启用清单模式："}</strong>${escapeHtml(data.offlineBasemap.message)}。${data.offlineBasemap.status === "READY" ? "底图原图与客户点位、人员颜色和区域说明保持为独立图层。" : "区域分工与客户分布仍可按清单查看。"}</div>`;
  const mapPrimary = usesGeoMap ? geoMap : data.offlineBasemap.status === "READY" ? `<div class="map-stage"><div class="map-canvas" aria-label="中国标准地图业务叠加层"><img src="${escapeHtml(data.offlineBasemap.assetUrl)}" alt="中国标准地图原图" draggable="false" /><div class="map-overlay">${regionButtons}${pointButtons}</div></div><div class="map-business-layer" aria-label="客户点位业务图层">业务图层：${data.customerPoints.length} 个客户点位</div><p>审图号：${escapeHtml(data.offlineBasemap.reviewNumber)} · 点位为绑定本原图摘要的独立图片坐标，不改变地图原图</p></div>` : listFallback;
  const provinceRanking = provinceSummaries.length ? `<div class="map-province-ranking">${provinceSummaries.map((province, index) => {
    const leadingStatuses = Object.entries(province.statusCounts).sort((left, right) => right[1] - left[1]).slice(0, 2).map(([status, count]) => `${status} ${count}`).join(" · ");
    return `<button class="map-province-rank" data-map-province="${escapeHtml(province.name)}"><span class="rank-number">${index + 1}</span><span><strong>${escapeHtml(province.name)}</strong><small>${escapeHtml(leadingStatuses || "暂无阶段信息")}</small></span><span class="rank-count"><strong>${province.customerCount}</strong><small>家客户</small></span></button>`;
  }).join("")}</div>` : `<div class="empty">当前权限和筛选条件下没有可汇总的省份客户</div>`;
  const geoSidebar = `<aside class="card map-insight-card"><div class="card-head"><div><h2>出差拜访概览</h2><small>${escapeHtml(data.visibilityScope?.label || "权限内客户")}</small></div></div><div class="map-kpis"><div><strong>${visibleCustomers.length}</strong><span>可见客户</span></div><div><strong>${provinceSummaries.length}</strong><span>涉及省份</span></div><div><strong>${activeCustomerCount}</strong><span>推进中</span></div></div><section class="map-ranking-section"><div class="map-section-title"><strong>省份客户排行</strong><span>点击查看清单</span></div>${provinceRanking}</section><details class="map-assignment-details"><summary>查看售前负责区域</summary>${data.representatives.length ? `<ul class="list compact-list">${data.representatives.map(rep => `<li><div><strong>${escapeHtml(rep.displayName)}</strong><small>${escapeHtml(rep.regions.join("、") || "未配置负责区域")}</small></div><span class="tag">${rep.customerCount} 家</span></li>`).join("")}</ul>` : `<div class="empty">当前范围没有区域分工</div>`}</details></aside>`;
  const legacySidebar = `<aside class="card map-assignment-card"><div class="card-head"><h2>当前可见区域分工</h2></div>${data.representatives.length ? `<ul class="list">${data.representatives.map(rep => `<li><div><strong>${escapeHtml(rep.displayName)}</strong><small>${escapeHtml(rep.regions.join("、") || "未配置负责区域")}</small></div><span class="tag">${rep.customerCount} 家客户</span></li>`).join("")}</ul>` : `<div class="empty">当前筛选条件下无区域数据</div>`}${pendingPoints}</aside>`;
  const ownerFilter = data.filterOptions.owners.length > 1 || filters.ownerId ? `<div class="field"><label>售前人员</label><select id="map-owner" data-map-filter><option value="">全部可见人员</option>${selectOptions(data.filterOptions.owners, filters.ownerId, item => item.displayName)}</select></div>` : "";
  content.innerHTML = `${pageHead("客户分布与拜访规划", "按省份汇总当前有权查看的客户，帮助安排出差和集中拜访")}
    ${mapNotice}
    <section class="card map-filter-panel"><div class="map-filter-copy"><strong>快速筛选</strong><span>选择后自动更新地图和排行</span></div><div class="map-filter-controls">${ownerFilter}<div class="field"><label>客户阶段</label><select id="map-status" data-map-filter><option value="">全部阶段</option>${selectOptions(data.filterOptions.statuses, filters.status)}</select></div>${filtersActive ? `<button class="button" data-action="reset-map-filters">清除筛选</button>` : ""}</div></section>
    <div class="grid map-layout">${mapPrimary}${usesGeoMap ? geoSidebar : legacySidebar}</div>`;
  if (usesGeoMap) {
    const host = content.querySelector(".china-geo-map-host");
    try {
      const response = await fetch(data.provinceMap.assetUrl, { cache: "force-cache" });
      if (!response.ok) throw new Error(`地图文件加载失败（${response.status}）`);
      const collection = await response.json();
      if (!mapRenderGate.isCurrent(requestId) || !host?.isConnected) return;
      const zoomLabel = content.querySelector(".map-zoom-label");
      const model = renderChinaGeoMap(host, collection, {
        customers: visibleCustomers,
        representatives: data.representatives,
        onZoomChange: scale => { if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`; }
      });
      host.setAttribute("aria-busy", "false");
      const summary = content.querySelector(".china-geo-map-summary");
      if (summary) summary.textContent = `已统计 ${visibleCustomers.length} 家 · ${model.regions.filter(region => region.customerCount).length} 个省份`;
      const unplaced = content.querySelector(".china-geo-unplaced");
      if (unplaced && model.unplaced.length) {
        unplaced.hidden = false;
        unplaced.innerHTML = `<strong>${model.unplaced.length} 家暂未定位：</strong>${model.unplaced.map(customer => `<button class="text-button" data-map-customer="${customer.id}">${escapeHtml(customer.name)}</button>`).join("、")}<span>（请先补充省份或经纬度）</span>`;
      }
    } catch (error) {
      if (!mapRenderGate.isCurrent(requestId) || !host?.isConnected) return;
      host.closest(".china-geo-map-panel").outerHTML = `<div class="notice warning">中国地图文件加载失败：${escapeHtml(error.message)}。已切换为清单，不影响客户数据。</div>${listFallback}`;
    }
  }
  const image = content.querySelector(".map-canvas img");
  if (image) {
    const updateImageState = status => {
      if (mapRenderGate.isCurrent(requestId)) setMapImageState(content, data, status);
    };
    updateImageState("LOADING");
    image.addEventListener("load", () => updateImageState(image.naturalWidth > 0 ? "READY" : "ERROR"));
    image.addEventListener("error", () => updateImageState("ERROR"));
    if (image.complete) updateImageState(image.naturalWidth > 0 ? "READY" : "ERROR");
  }
}

function setMapImageState(content, data, status) {
  if (!content.isConnected || state.mapData !== data) return;
  const ready = status === "READY";
  state.mapImageReady = ready;
  const canvas = content.querySelector(".map-canvas");
  canvas?.classList.toggle("map-image-ready", ready);
  for (const button of content.querySelectorAll("[data-map-pick]")) button.disabled = !ready;
  const label = content.querySelector(".map-business-layer");
  if (label) label.textContent = ready ? `业务图层：${data.customerPoints.length} 个客户点位` : status === "ERROR" ? "底图加载失败或已变化，请刷新地图后重试；叠加层和选点已关闭" : "底图加载中，暂不显示叠加层或允许选点";
  if (!ready) {
    state.mapPickerCustomerId = null;
    state.mapPickerAssetSha256 = null;
    canvas?.classList.remove("picking");
  }
}

function openMapCustomer(customerId) {
  const customer = [...(state.mapData?.customerPoints || []), ...(state.mapData?.unlocatedCustomers || [])].find(item => item.id === customerId);
  if (!customer) return;
  const target = customer.detailTarget ? `<button class="button primary" data-map-detail-type="${customer.detailTarget.type}" data-map-detail-id="${customer.detailTarget.id}">进入有权限详情</button>` : "";
  const pointAction = customer.canEditPoint && state.mapImageReady && state.mapData.offlineBasemap.status === "READY" ? `<button class="button" data-map-pick="${customer.id}">${customer.coordinates ? "修改点位" : "人工选点"}</button>` : "";
  openDialog("查看客户", `<p><strong>${escapeHtml(customer.name)}</strong></p><div class="customer-master-grid"><div><span>客户状态</span><strong>${escapeHtml(customer.status)}</strong></div><div><span>负责人</span><strong>${escapeHtml(customer.owner.displayName)}</strong></div><div><span>所在区域</span><strong>${escapeHtml(customer.region)}</strong></div><div><span>最近跟进</span><strong>${customer.lastFollowupAt ? formatTime(customer.lastFollowupAt) : "暂无跟进"}</strong></div><div class="full"><span>详细地址</span><strong>${escapeHtml(customer.address || "未填写")}</strong></div></div><div class="actions section-gap">${target}${pointAction}</div>`);
}

function openMapProvince(provinceName) {
  const normalized = normalizeProvinceName(provinceName);
  const customers = [...(state.mapData?.customerPoints || []), ...(state.mapData?.unlocatedCustomers || [])]
    .filter(customer => normalizeProvinceName(customer.province) === normalized)
    .sort((left, right) => {
      const leftInactive = ["丢标", "中止"].includes(left.status) ? 1 : 0;
      const rightInactive = ["丢标", "中止"].includes(right.status) ? 1 : 0;
      if (leftInactive !== rightInactive) return leftInactive - rightInactive;
      if (!left.lastFollowupAt && right.lastFollowupAt) return -1;
      if (left.lastFollowupAt && !right.lastFollowupAt) return 1;
      return String(left.lastFollowupAt || "").localeCompare(String(right.lastFollowupAt || "")) || left.name.localeCompare(right.name, "zh-CN");
    });
  if (!customers.length) return showToast("当前筛选和权限范围内，该省份没有客户");
  const activeCount = customers.filter(customer => !["丢标", "中止"].includes(customer.status)).length;
  const ownerCount = new Set(customers.map(customer => customer.owner.id)).size;
  const statusCounts = [...customers.reduce((counts, customer) => counts.set(customer.status, (counts.get(customer.status) || 0) + 1), new Map()).entries()]
    .sort((left, right) => right[1] - left[1]);
  openDialog("查看客户拜访清单", `<p><strong>${escapeHtml(provinceName)}</strong></p><div class="province-trip-summary"><div><strong>${customers.length}</strong><span>当前可见客户</span></div><div><strong>${activeCount}</strong><span>推进中客户</span></div><div><strong>${ownerCount}</strong><span>涉及售前</span></div></div><div class="map-status-summary">${statusCounts.map(([status, count]) => `<span class="tag">${escapeHtml(status)} ${count}</span>`).join("")}</div><div class="notice section-gap">清单按推进中优先、暂无跟进或较久未跟进优先排列，便于出差前逐项核对拜访价值。</div><div class="table-wrap province-customer-table"><table><thead><tr><th>客户</th><th>城市</th><th>阶段</th><th>负责人</th><th>最近跟进</th><th>操作</th></tr></thead><tbody>${customers.map(customer => `<tr><td><strong>${escapeHtml(customer.name)}</strong></td><td>${escapeHtml([customer.city, customer.district].filter(Boolean).join(" · ") || "未填写")}</td><td><span class="tag">${escapeHtml(customer.status)}</span></td><td>${escapeHtml(customer.owner.displayName)}</td><td>${customer.lastFollowupAt ? formatTime(customer.lastFollowupAt) : `<span class="attention-text">暂无跟进</span>`}</td><td><button class="button small" data-map-customer="${customer.id}">查看档案</button></td></tr>`).join("")}</tbody></table></div><div class="actions section-gap"><button class="button primary" data-map-customer-region="${escapeHtml(provinceName)}">在客户管理中查看该省</button></div>`, { wide: true });
}

function openMapRegion(ownerId, regionName) {
  const owner = state.mapData?.representatives.find(item => item.id === ownerId);
  const region = owner?.regionSummaries.find(item => item.name === regionName);
  if (!owner || !region) return;
  openDialog("查看负责区域", `<div class="customer-master-grid"><div><span>售前人员</span><strong>${escapeHtml(owner.displayName)}</strong></div><div><span>负责范围</span><strong>${escapeHtml(region.name)}</strong></div><div><span>当前筛选客户数</span><strong>${region.customerCount} 家</strong></div></div><div class="notice section-gap">客户数沿用当前地图权限与售前、状态、区域筛选条件。</div>`);
}

function startMapPointPicker(customerId) {
  const customer = [...(state.mapData?.customerPoints || []), ...(state.mapData?.unlocatedCustomers || [])].find(item => item.id === customerId);
  if (!customer?.canEditPoint || state.mapData?.offlineBasemap.status !== "READY") return showToast("当前账号不能修改该客户点位，或合规底图尚未安装");
  if (!state.mapImageReady) return showToast("底图尚未成功加载，请刷新地图后重试");
  closeDialog();
  state.mapPickerCustomerId = customerId;
  state.mapPickerAssetSha256 = state.mapData.offlineBasemap.sha256;
  document.querySelector(".map-canvas")?.classList.add("picking");
  showToast(`请在地图原图上选择 ${customer.name} 的业务点位`);
}

function confirmMapPoint(customerId, position, expectedAssetSha256) {
  openDialog("确认人工点位", `<div class="notice">本次只保存当前标准地图原图上的归一化图片坐标，并绑定当前原图摘要；不推算经纬度，不采集实时定位或人员轨迹。服务端会重新核验底图及当前负责人权限。</div><div class="form-grid"><div class="field"><label>图片横向位置</label><input value="${position.xPercent.toFixed(4)}%" readonly /></div><div class="field"><label>图片纵向位置</label><input value="${position.yPercent.toFixed(4)}%" readonly /></div><div class="field full"><label class="required">人工选点原因</label><textarea id="map-point-reason" placeholder="例如：已根据客户地址在当前标准地图原图上人工确认"></textarea></div></div>`, {
    submitLabel: "确认保存点位",
    onSubmit: async () => {
      await api(`/api/customers/${customerId}/map-point`, { method: "PATCH", body: JSON.stringify({ xPercent: position.xPercent, yPercent: position.yPercent, expectedAssetSha256, reason: document.querySelector("#map-point-reason").value }) });
      state.mapPickerCustomerId = null;
      state.mapPickerAssetSha256 = null;
      closeDialog(); showToast("客户点位已保存并记录审计"); await go("map");
    }
  });
}

function quoteMatchesFilters(quote, filters = state.quoteFilters) {
  const query = String(filters.query || "").trim().toLowerCase();
  if (query) {
    const searchable = [quote.quoteNumber, quote.versionLabel, quote.metadata?.customerName, quote.customer?.name, quote.project?.name]
      .filter(Boolean).join(" ").toLowerCase();
    if (!searchable.includes(query)) return false;
  }
  if (filters.status === "MINE") return canDecideQuote(quote);
  if (filters.status && quoteDisplayStatus(quote) !== filters.status) return false;
  return true;
}

async function renderQuotes(content, { reload = true } = {}) {
  if (reload) {
    const result = await api("/api/quotes");
    state.quotes = result.items;
  }
  const canCreate = ["PRESALES", "ADMIN"].includes(state.user.role);
  const visibleQuotes = state.quotes.filter(quote => quoteMatchesFilters(quote));
  const filters = state.quoteFilters;
  const statusOptions = [["DRAFT", quoteStatusLabels.DRAFT], ["MINE", "待我审批"], ["APPROVED", quoteStatusLabels.APPROVED]].map(([value, label]) => `<option value="${value}"${filters.status === value ? " selected" : ""}>${label}</option>`).join("");
  const actions = `<button class="button" data-action="download-quote-template">下载标准模板</button>${canCreate ? `<button class="button primary" data-action="new-uploaded-quote">上传报价单</button>` : ""}`;
  content.innerHTML = `${pageHead("报价管理", "按标准模板制作并上传 PDF，发送审批依次由研发部经理、综合部经理和副总经理审核", actions, { sticky: false })}
    <section class="card quote-filter-panel" aria-label="报价筛选">
      <div class="quote-filter-grid">
        <div class="field"><label>报价或客户</label><input id="quote-search" value="${escapeHtml(filters.query)}" placeholder="输入报价编号、客户或项目" /></div>
        <div class="field"><label>当前状态</label><select id="quote-status-filter"><option value="">全部状态</option>${statusOptions}</select></div>
        <div class="quote-filter-actions"><button class="button primary" data-action="apply-quote-filters">应用筛选</button><button class="button" data-action="reset-quote-filters">重置</button></div>
      </div>
      <small class="quote-filter-result">显示 ${visibleQuotes.length} / ${state.quotes.length} 条报价</small>
    </section>
    <div class="notice"><strong>模板填写：</strong>请替换模板中双花括号里的内容；无优惠时删除优惠后合计行。发送审批后将保留本次原件及审批记录。</div>
    <div class="card table-wrap quote-list-wrap"><table class="quote-list-table"><thead><tr><th>报价编号</th><th>客户</th><th>最终报价（含税）</th><th>状态</th><th>操作</th></tr></thead><tbody>${visibleQuotes.map(quote => `<tr><td data-label="报价编号"><div>${escapeHtml(quote.quoteNumber)} · ${escapeHtml(quote.versionLabel)}${quoteVersionHistoryNote(quote)}</div></td><td data-label="客户">${escapeHtml(quote.metadata?.customerName || quote.customer.name)}</td><td data-label="最终报价（含税）"><div><strong>${formatMoney(quote.finalDiscountCents)}</strong>${quote.discountAmountCents > 0 ? `<br><small>优惠 ${formatMoney(quote.discountAmountCents)}</small>` : ""}</div></td><td data-label="状态"><div><span class="tag ${quote.status === "APPROVED" ? "green" : quote.status.includes("RETURNED") ? "red" : "orange"}">${escapeHtml(quoteStatusLabel(quote))}</span>${quote.pendingManagerIssue ? `<br><small>${escapeHtml(quote.pendingManagerIssue.message)}</small>` : ""}</div></td><td data-label="操作"><div class="actions"><button class="button small" data-quote-view="${quote.id}">查看</button>${quote.status === "DRAFT" && canCreate ? `${quote.sourceKind === "UPLOADED" ? `<button class="button small" data-quote-edit="${quote.id}">重新上传</button>` : `<button class="button small" data-quote-edit="${quote.id}">编辑</button>`}<button class="button small primary" data-quote-submit="${quote.id}">发送审批</button>` : ""}${canDecideQuote(quote) ? `<button class="button small primary" data-quote-decision="${quote.id}">处理审批</button>` : ""}${quote.status === "APPROVED" ? `${canCreate ? `<button class="button small" data-quote-revise="${quote.id}">调整价格</button>` : ""}` : ""}</div></td></tr>`).join("")}</tbody></table>${visibleQuotes.length ? "" : `<div class="empty">当前筛选条件下没有报价</div>`}</div>`;
}

function statusTag(status) {
  const labels = { ...surveyStatusLabels, VALID: "可导入", DUPLICATE: "重复提示", FAILED: "校验失败", IMPORTED: "已导入", PREVIEWED: "已预览", PARTIAL: "部分导入" };
  const color = ["COMPLETED", "IMPORTED"].includes(status) ? "green" : ["FAILED", "DUPLICATE"].includes(status) ? "red" : "orange";
  return `<span class="tag ${color}">${escapeHtml(displayEnum(status, labels, "状态待确认"))}</span>`;
}

async function renderSurveys(content) {
  const result = await api("/api/surveys");
  state.surveys = result.items;
  const canCreate = ["PRESALES", "ADMIN"].includes(state.user.role);
  content.innerHTML = `${pageHead("软件调研", "固定模板版本、草稿续填、完成确认与修改留痕", `<button class="button" data-sop-context="前期调研">查看调研 SOP</button>${canCreate ? `<button class="button primary" data-action="new-survey">+ 新建调研</button>` : ""}`)}
    <div class="notice">当前模板按来源文件原有结构固化为 A/0 版：6 个问答模块、49 个问题和 4 张专项清单。正式报告只允许从已完成确认的版本生成。</div>
    <div class="card table-wrap"><table><thead><tr><th>调研</th><th>客户 / 项目</th><th>模板</th><th>版本</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${state.surveys.map(survey => `<tr><td><strong>${escapeHtml(survey.title)}</strong></td><td>${escapeHtml(survey.customer.name)}<br><small>${escapeHtml(survey.project.name)}</small></td><td>${escapeHtml(survey.template.code)} ${escapeHtml(survey.template.version)}</td><td>V${survey.versionNumber} · R${survey.revision}</td><td>${statusTag(survey.status)}</td><td>${formatTime(survey.updatedAt)}</td><td><div class="actions"><button class="button small" data-survey-open="${survey.id}">${canCreate ? (survey.status === "DRAFT" ? "继续填写" : "查看 / 创建修订版") : "查看"}</button><button class="button small" data-survey-history="${survey.id}">版本历史</button>${survey.status === "DRAFT" && canCreate ? `<button class="button small primary" data-survey-complete="${survey.id}">完成确认</button>` : ""}${survey.status === "COMPLETED" ? `<button class="button small" data-survey-export="${survey.id}">导出 Word</button>` : ""}</div></td></tr>`).join("")}</tbody></table>${state.surveys.length ? "" : `<div class="empty">当前权限下没有软件调研记录</div>`}</div>`;
}

async function openNewSurveyDialog(preselectedCustomerId = null) {
  const [customers, projects, templates, surveys] = await Promise.all([api("/api/customers"), api("/api/projects"), api("/api/survey-templates"), api("/api/surveys")]);
  if (!customers.items.length || !projects.items.length) {
    openDialog("新建软件调研", `<div class="notice warning">请先建立有权限的客户和项目机会，再创建调研。</div>`);
    return;
  }
  const selectedCustomerId = customers.items.some(item => item.id === preselectedCustomerId) ? preselectedCustomerId : customers.items[0]?.id;
  const reusable = surveys.items.filter(item => item.status === "COMPLETED");
  openDialog("新建软件调研", `<div class="form-grid"><div class="field full"><label class="required">标题</label><input id="survey-title" placeholder="客户 / 项目软件调研" /></div><div class="field"><label class="required">客户</label><select id="survey-customer">${customers.items.map(item => `<option value="${item.id}"${item.id === selectedCustomerId ? " selected" : ""}>${escapeHtml(item.fullName)}</option>`).join("")}</select></div><div class="field"><label class="required">项目</label><select id="survey-project">${projects.items.map(item => `<option value="${item.id}" data-customer="${item.customerId}">${escapeHtml(item.name)}</option>`).join("")}</select></div><div class="field full"><label class="required">调研模板</label><select id="survey-template">${templates.items.map(item => `<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.version)}</option>`).join("")}</select><small>创建后模板版本固定，不随以后发布的新模板变化。</small></div><div class="field full"><label>复用已有调研（可选）</label><select id="survey-reuse"><option value="">不复用，从空白模板开始</option>${reusable.map(item => `<option value="${item.id}" data-template="${item.template.id}">${escapeHtml(item.customer.name)} · ${escapeHtml(item.title)} · V${item.versionNumber}</option>`).join("")}</select><small>仅显示当前账号有权查看、已完成且模板版本一致的调研；只复制问答与专项清单，不复制附件，创建后仍是当前客户的独立草稿。</small></div></div>`, {
    submitLabel: "创建并填写",
    onSubmit: async () => {
      const created = await api("/api/surveys", { method: "POST", body: JSON.stringify({ title: document.querySelector("#survey-title").value, customerId: document.querySelector("#survey-customer").value, projectId: document.querySelector("#survey-project").value, templateId: document.querySelector("#survey-template").value, reuseFromSurveyId: document.querySelector("#survey-reuse").value || undefined }) });
      closeDialog();
      await openSurveyEditor(created.id);
    }
  });
  const filterProjects = () => {
    const customerId = document.querySelector("#survey-customer").value;
    const select = document.querySelector("#survey-project");
    [...select.options].forEach(option => { option.hidden = option.dataset.customer !== customerId; });
    const first = [...select.options].find(option => !option.hidden);
    if (first) select.value = first.value;
    else select.value = "";
  };
  document.querySelector("#survey-customer").addEventListener("change", filterProjects);
  const filterReusableSurveys = () => {
    const templateId = document.querySelector("#survey-template").value;
    const select = document.querySelector("#survey-reuse");
    [...select.options].forEach(option => { if (option.value) option.hidden = option.dataset.template !== templateId; });
    if (select.selectedOptions[0]?.hidden) select.value = "";
  };
  document.querySelector("#survey-template").addEventListener("change", filterReusableSurveys);
  filterProjects();
  filterReusableSurveys();
}

function isSurveyTableLongField(field) {
  return String(field?.label || "").trim() === "对接内容";
}

function surveyTableField(field, row, editable) {
  const value = row[field.key] ?? "";
  const attributes = `data-survey-field="${field.key}" data-survey-field-required="${field.required ? "true" : "false"}" data-survey-field-type="${field.type}" ${editable ? "" : "disabled"}`;
  const longField = isSurveyTableLongField(field);
  const control = field.type === "select"
    ? `<select ${attributes}><option value="">请选择</option>${field.options.map(option => `<option${value === option ? " selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select>`
    : longField
      ? `<textarea ${attributes} rows="1" data-survey-auto-grow placeholder="内容少时保持紧凑，输入较多时自动展开">${escapeHtml(value)}</textarea>`
      : `<input ${attributes} type="${field.type === "number" ? "number" : "text"}" ${field.type === "number" ? "min=\"0\"" : ""} value="${escapeHtml(value)}" />`;
  return `<label class="survey-special-field${longField ? " is-long" : ""}"><span>${escapeHtml(field.label)}${field.required ? " *" : ""}</span>${control}</label>`;
}

function surveyTableRow(definition, row = {}, editable = true, index = 0) {
  return `<article class="survey-special-row" data-survey-table-row><header class="survey-special-row-head"><strong data-survey-row-number>第 ${index + 1} 条</strong>${editable ? `<button class="button small danger" type="button" data-action="remove-survey-row">删除</button>` : `<span class="tag">只读</span>`}</header><div class="survey-special-fields">${definition.fields.map(field => surveyTableField(field, row, editable)).join("")}</div></article>`;
}

function surveyQuestionProgress(module, response) {
  const questions = module.questions || [];
  const answered = questions.filter(question => String(response.answers?.[question.id]?.record || "").trim()).length;
  const requiredMissing = questions.filter(question => question.required && !String(response.answers?.[question.id]?.record || "").trim()).length;
  return { total: questions.length, answered, requiredMissing };
}

function surveyTableIsComplete(definition, rows = []) {
  if (definition.requiredAtLeastOne && !rows.length) return false;
  return rows.every(row => (definition.fields || []).every(field => {
    if (!field.required) return true;
    const value = row?.[field.key];
    if (value === "" || value === null || value === undefined) return false;
    if (field.type === "number") return Number.isSafeInteger(Number(value)) && Number(value) > 0;
    return true;
  }));
}

function resizeSurveySpecialTextarea(textarea) {
  if (!textarea?.matches?.("[data-survey-auto-grow]")) return;
  const minimumHeight = 42;
  const maximumHeight = 220;
  textarea.style.height = "auto";
  const contentHeight = Math.max(minimumHeight, Math.ceil(textarea.scrollHeight || 0));
  textarea.style.height = `${Math.min(contentHeight, maximumHeight)}px`;
  textarea.style.overflowY = contentHeight > maximumHeight ? "auto" : "hidden";
}

function resizeSurveySpecialTextareas(root = document) {
  root.querySelectorAll?.("[data-survey-auto-grow]").forEach(resizeSurveySpecialTextarea);
}

function surveyQuestionSection({ module, moduleIndex, questionOffset, response, writable, open }) {
  const progress = surveyQuestionProgress(module, response);
  const key = `module-${moduleIndex}`;
  const questions = (module.questions || []).map((question, questionIndex) => {
    const answer = response.answers?.[question.id] || {};
    const recorded = Boolean(String(answer.record || "").trim());
    const inputId = `survey-record-${moduleIndex}-${questionIndex}`;
    return `<article class="survey-question-row ${recorded ? "is-complete" : "is-pending"}${question.required && !recorded ? " is-required-missing" : ""}" data-survey-question-row data-survey-required="${question.required ? "true" : "false"}">
      <div class="survey-question-prompt"><span class="survey-question-index">Q${questionOffset + questionIndex + 1}</span><label for="${inputId}" class="${question.required ? "required" : ""}">${escapeHtml(question.prompt)}</label>${question.help ? `<small>${escapeHtml(question.help)}</small>` : ""}</div>
      <div class="survey-answer-field"><label for="${inputId}">调研记录${question.required ? "（必填）" : "（选填）"}</label><textarea id="${inputId}" data-survey-question="${question.id}" data-answer-kind="record" ${writable ? "" : "disabled"} placeholder="记录客户当前情况、流程和现场原话">${escapeHtml(answer.record || "")}</textarea></div>
      <div class="survey-answer-field"><label for="survey-solution-${moduleIndex}-${questionIndex}">解决方案及补充（选填）</label><textarea id="survey-solution-${moduleIndex}-${questionIndex}" data-survey-question="${question.id}" data-answer-kind="solution" ${writable ? "" : "disabled"} placeholder="填写建议方案、边界或待确认内容">${escapeHtml(answer.solution || "")}</textarea></div>
      <div class="survey-question-state ${recorded ? "complete" : question.required ? "missing" : "optional"}" data-survey-question-state>${recorded ? "已填写" : question.required ? "待填写" : "可后补"}</div>
    </article>`;
  }).join("");
  const state = progress.requiredMissing ? `待补 ${progress.requiredMissing} 个必填` : progress.answered === progress.total ? "已完成" : "必填已完成";
  return `<details class="survey-section${progress.requiredMissing ? " has-required-missing" : ""}" data-survey-section data-section-kind="questions" data-section-key="${key}" id="survey-section-${key}" ${open ? "open" : ""}>
    <summary><div><span class="survey-section-number">${String(moduleIndex + 1).padStart(2, "0")}</span><span><strong>${escapeHtml(module.name)}</strong><small>${escapeHtml(module.description || "按实际业务情况填写")}</small></span></div><span class="survey-section-summary"><b data-module-state>${state}</b><i data-module-count>${progress.answered}/${progress.total}</i></span></summary>
    <div class="survey-question-columns" aria-hidden="true"><span>调研问题</span><span>调研记录</span><span>解决方案及补充</span><span>状态</span></div>
    <div class="survey-question-list">${questions}</div>
  </details>`;
}

function surveyTableSection({ definition, tableIndex, response, writable, open }) {
  const rows = response.tables?.[definition.key] || [];
  const complete = surveyTableIsComplete(definition, rows);
  const key = `table-${tableIndex}`;
  const hasLongContent = (definition.fields || []).some(isSurveyTableLongField);
  return `<details class="survey-section survey-table-section${complete ? "" : " has-required-missing"}" data-survey-section data-section-kind="table" data-section-key="${key}" data-survey-table-required="${definition.requiredAtLeastOne ? "true" : "false"}" id="survey-section-${key}" ${open ? "open" : ""}>
    <summary><div><span class="survey-section-number">清</span><span><strong>${escapeHtml(definition.name)}</strong><small>${definition.requiredAtLeastOne ? "至少填写一行，并补齐标记为必填的字段" : "按客户实际情况补充"}</small></span></div><span class="survey-section-summary"><b data-module-state>${complete ? "已完成" : rows.length ? "信息待补齐" : "至少添加 1 行"}</b><i data-module-count>${rows.length} 行</i></span></summary>
    <div class="survey-table-content"><div class="survey-table-toolbar"><span>${hasLongContent ? "对接内容可填写较长文字并自动展开；其余字段保持紧凑。" : "本清单以简短字段为主，按实际情况逐项填写。"}</span>${writable ? `<button class="button small" type="button" data-add-survey-row="${definition.key}">+ 添加一条</button>` : ""}</div><div class="survey-special-list" data-survey-table="${definition.key}"><div class="survey-special-empty" ${rows.length ? "hidden" : ""}>暂无记录，请先添加一条</div>${rows.map((row, index) => surveyTableRow(definition, row, writable, index)).join("")}</div></div>
  </details>`;
}

function updateSurveyEditorProgress() {
  const editor = document.querySelector("#survey-editor");
  if (!editor) return;
  let answered = 0;
  let total = 0;
  let requiredMissing = 0;
  let tablesComplete = 0;
  let tableTotal = 0;
  editor.querySelectorAll('[data-section-kind="questions"]').forEach(section => {
    const rows = [...section.querySelectorAll("[data-survey-question-row]")];
    const sectionAnswered = rows.filter(row => String(row.querySelector('[data-answer-kind="record"]')?.value || "").trim()).length;
    const sectionMissing = rows.filter(row => row.dataset.surveyRequired === "true" && !String(row.querySelector('[data-answer-kind="record"]')?.value || "").trim()).length;
    rows.forEach(row => {
      const recorded = Boolean(String(row.querySelector('[data-answer-kind="record"]')?.value || "").trim());
      const missing = row.dataset.surveyRequired === "true" && !recorded;
      row.classList.toggle("is-complete", recorded);
      row.classList.toggle("is-pending", !recorded);
      row.classList.toggle("is-required-missing", missing);
      const stateElement = row.querySelector("[data-survey-question-state]");
      stateElement.textContent = recorded ? "已填写" : missing ? "待填写" : "可后补";
      stateElement.className = `survey-question-state ${recorded ? "complete" : missing ? "missing" : "optional"}`;
    });
    section.classList.toggle("has-required-missing", sectionMissing > 0);
    section.querySelector("[data-module-count]").textContent = `${sectionAnswered}/${rows.length}`;
    section.querySelector("[data-module-state]").textContent = sectionMissing ? `待补 ${sectionMissing} 个必填` : sectionAnswered === rows.length ? "已完成" : "必填已完成";
    const outline = editor.querySelector(`[data-survey-outline="${section.dataset.sectionKey}"]`);
    if (outline) {
      outline.querySelector("b").textContent = `${sectionAnswered}/${rows.length}`;
      outline.classList.toggle("has-missing", sectionMissing > 0);
    }
    answered += sectionAnswered;
    total += rows.length;
    requiredMissing += sectionMissing;
  });
  editor.querySelectorAll('[data-section-kind="table"]').forEach(section => {
    const rows = [...section.querySelectorAll("[data-survey-table-row]")];
    rows.forEach((row, index) => { const number = row.querySelector("[data-survey-row-number]"); if (number) number.textContent = `第 ${index + 1} 条`; });
    const empty = section.querySelector(".survey-special-empty");
    if (empty) empty.hidden = rows.length > 0;
    const complete = (!section.dataset.surveyTableRequired || section.dataset.surveyTableRequired !== "true" || rows.length > 0) && rows.every(row => [...row.querySelectorAll("[data-survey-field-required='true']")].every(field => {
      if (!String(field.value ?? "").trim()) return false;
      return field.dataset.surveyFieldType !== "number" || (Number.isSafeInteger(Number(field.value)) && Number(field.value) > 0);
    }));
    section.classList.toggle("has-required-missing", !complete);
    section.querySelector("[data-module-count]").textContent = `${rows.length} 行`;
    section.querySelector("[data-module-state]").textContent = complete ? "已完成" : rows.length ? "信息待补齐" : "至少添加 1 行";
    const outline = editor.querySelector(`[data-survey-outline="${section.dataset.sectionKey}"]`);
    if (outline) {
      outline.querySelector("b").textContent = complete ? "完成" : "待补";
      outline.classList.toggle("has-missing", !complete);
    }
    tablesComplete += complete ? 1 : 0;
    tableTotal += 1;
  });
  editor.querySelector("[data-survey-answered]").textContent = answered;
  editor.querySelector("[data-survey-total]").textContent = total;
  editor.querySelector("[data-survey-required-missing]").textContent = requiredMissing;
  editor.querySelector("[data-survey-tables-complete]").textContent = tablesComplete;
  editor.querySelector("[data-survey-table-total]").textContent = tableTotal;
  editor.querySelector("[data-survey-progress-bar]").style.width = `${total ? Math.round(answered / total * 100) : 100}%`;
  const allComplete = requiredMissing === 0 && tablesComplete === tableTotal;
  editor.querySelector("[data-survey-all-complete]").hidden = !allComplete;
  const requiredAlert = editor.querySelector("[data-survey-required-alert]");
  if (requiredAlert) requiredAlert.hidden = allComplete;
  const completeButton = editor.querySelector("[data-survey-editor-complete]");
  if (completeButton) {
    completeButton.disabled = !allComplete;
    completeButton.title = allComplete ? "必填内容已完整，可以完成确认" : "还有必填字段未填写";
  }
}

function bindSurveyEditorInteractions() {
  const editor = document.querySelector("#survey-editor");
  if (!editor) return;
  editor.addEventListener("input", event => {
    resizeSurveySpecialTextarea(event.target);
    updateSurveyEditorProgress();
  });
  editor.addEventListener("change", updateSurveyEditorProgress);
  editor.addEventListener("toggle", event => {
    if (event.target.matches?.(".survey-table-section[open]")) resizeSurveySpecialTextareas(event.target);
  }, true);
  editor.addEventListener("click", async event => {
    const jump = event.target.closest("[data-survey-jump]");
    if (jump) {
      const section = editor.querySelector(`#survey-section-${jump.dataset.surveyJump}`);
      if (section) { section.open = true; section.scrollIntoView({ behavior: "smooth", block: "start" }); }
    }
    const filter = event.target.closest("[data-survey-missing-toggle]");
    if (filter) {
      const active = editor.classList.toggle("show-required-missing");
      filter.classList.toggle("active", active);
      filter.textContent = active ? "显示全部" : "只看必填待补";
      if (active) editor.querySelectorAll(".has-required-missing").forEach(section => { section.open = true; });
    }
    const expand = event.target.closest("[data-survey-expand-all]");
    if (expand) {
      const sections = [...editor.querySelectorAll("[data-survey-section]")];
      const shouldOpen = sections.some(section => !section.open);
      sections.forEach(section => { section.open = shouldOpen; });
      expand.textContent = shouldOpen ? "全部收起" : "全部展开";
    }
    const complete = event.target.closest("[data-survey-editor-complete]");
    if (complete && !complete.disabled) {
      complete.disabled = true;
      try {
        await activeDraftAutosave?.flush();
        openSurveyCompleteDialog(complete.dataset.surveyEditorComplete);
      } catch (error) {
        showToast(`草稿尚未保存：${error.message}`);
        if (complete.isConnected) complete.disabled = false;
      }
    }
    if (event.target.closest("[data-add-survey-row], [data-action='remove-survey-row']")) setTimeout(updateSurveyEditorProgress, 0);
  });
  resizeSurveySpecialTextareas(editor);
  updateSurveyEditorProgress();
}

function collectSurveyResponse() {
  const answers = {};
  document.querySelectorAll("[data-survey-question]").forEach(element => {
    const id = element.dataset.surveyQuestion;
    answers[id] ||= {};
    answers[id][element.dataset.answerKind] = element.value;
  });
  const tables = {};
  document.querySelectorAll("[data-survey-table]").forEach(table => {
    tables[table.dataset.surveyTable] = [...table.querySelectorAll("[data-survey-table-row]")].map(row => Object.fromEntries([...row.querySelectorAll("[data-survey-field]")].map(input => [input.dataset.surveyField, input.type === "number" && input.value !== "" ? Number(input.value) : input.value])));
  });
  return { answers, tables };
}

async function openSurveyEditor(surveyId) {
  const survey = await api(`/api/surveys/${surveyId}`);
  const writable = ["PRESALES", "ADMIN"].includes(state.user.role);
  const attachmentWritable = writable && survey.status === "DRAFT";
  const moduleProgress = survey.template.schema.modules.map(module => surveyQuestionProgress(module, survey.response));
  const tableProgress = survey.template.schema.tables.map(definition => surveyTableIsComplete(definition, survey.response.tables?.[definition.key] || []));
  const firstMissingModule = moduleProgress.findIndex(item => item.requiredMissing > 0);
  const firstMissingTable = tableProgress.findIndex(complete => !complete);
  const firstOpenKey = firstMissingModule >= 0 ? `module-${firstMissingModule}` : firstMissingTable >= 0 ? `table-${firstMissingTable}` : "module-0";
  let questionOffset = 0;
  const modules = survey.template.schema.modules.map((module, index) => {
    const section = surveyQuestionSection({ module, moduleIndex: index, questionOffset, response: survey.response, writable, open: firstOpenKey === `module-${index}` });
    questionOffset += module.questions?.length || 0;
    return section;
  }).join("");
  const tables = survey.template.schema.tables.map((definition, index) => surveyTableSection({ definition, tableIndex: index, response: survey.response, writable, open: firstOpenKey === `table-${index}` })).join("");
  const outlineModules = survey.template.schema.modules.map((module, index) => `<button type="button" data-survey-jump="module-${index}" data-survey-outline="module-${index}" class="${moduleProgress[index].requiredMissing ? "has-missing" : ""}"><span>${String(index + 1).padStart(2, "0")} · ${escapeHtml(module.name)}</span><b>${moduleProgress[index].answered}/${moduleProgress[index].total}</b></button>`).join("");
  const outlineTables = survey.template.schema.tables.map((definition, index) => `<button type="button" data-survey-jump="table-${index}" data-survey-outline="table-${index}" class="${tableProgress[index] ? "" : "has-missing"}"><span>${escapeHtml(definition.name)}</span><b>${tableProgress[index] ? "完成" : "待补"}</b></button>`).join("");
  const totalQuestions = moduleProgress.reduce((sum, item) => sum + item.total, 0);
  const answeredQuestions = moduleProgress.reduce((sum, item) => sum + item.answered, 0);
  const requiredMissing = moduleProgress.reduce((sum, item) => sum + item.requiredMissing, 0);
  const tablesComplete = tableProgress.filter(Boolean).length;
  const surveyReady = requiredMissing === 0 && tablesComplete === tableProgress.length;
  openDialog(writable && survey.status === "DRAFT" ? "编辑软件调研" : "查看软件调研", `<div id="survey-editor" class="survey-editor">
    <section class="survey-editor-overview">
      <div class="survey-editor-context"><span class="survey-kicker">软件调研 · ${survey.status === "COMPLETED" ? "确认版" : "草稿"}</span><strong>${escapeHtml(survey.customer.name)}</strong><small>${escapeHtml(survey.project.name)} · 模板 ${escapeHtml(survey.template.code)} ${escapeHtml(survey.template.version)}</small></div>
      <div class="survey-progress-card"><div><span>已填写问题</span><strong><em data-survey-answered>${answeredQuestions}</em> / <em data-survey-total>${totalQuestions}</em></strong></div><div><span>必填待补</span><strong data-survey-required-missing>${requiredMissing}</strong></div><div><span>专项清单</span><strong><em data-survey-tables-complete>${tablesComplete}</em> / <em data-survey-table-total>${tableProgress.length}</em></strong></div><div class="survey-progress-track"><i data-survey-progress-bar style="width:${totalQuestions ? Math.round(answeredQuestions / totalQuestions * 100) : 100}%"></i></div></div>
    </section>
    <div class="survey-editor-notice">${survey.status === "COMPLETED" ? "该确认版只读保留；继续修改会创建新的草稿版本，重新确认前不能导出正式报告。" : "草稿会自动保存；完成确认仍需人工执行。"}${survey.status === "DRAFT" && writable ? ` <span id="draft-autosave-status" class="draft-save-status" aria-live="polite"></span>` : ""}</div>
    <section class="survey-editor-settings"><div class="field"><label class="required">调研标题</label><input id="survey-edit-title" value="${escapeHtml(survey.title)}" ${writable ? "" : "disabled"} /></div>${survey.status === "COMPLETED" && writable ? `<div class="field"><label class="required">本次修改原因</label><input id="survey-edit-reason" maxlength="500" /></div>` : ""}${attachmentBlock({ title: "调研整体附件", data: survey.attachments, targetType: "SURVEY", targetId: survey.id, writable: attachmentWritable })}</section>
    <div class="survey-editor-toolbar"><div><strong>调研内容</strong><span>已完成模块默认折叠，点击目录可快速定位。</span></div><div class="actions"><button class="button small" type="button" data-survey-missing-toggle>只看必填待补</button><button class="button small" type="button" data-survey-expand-all>全部展开</button>${survey.status === "DRAFT" && writable ? `<button class="button small primary" type="button" data-survey-editor-complete="${survey.id}" ${surveyReady ? "" : "disabled"} title="${surveyReady ? "必填内容已完整，可以完成确认" : "还有必填字段未填写"}">完成确认</button>` : ""}</div></div>
    <div class="survey-editor-layout">
      <aside class="survey-outline" aria-label="调研目录"><strong>问题模块</strong>${outlineModules}<strong>专项清单</strong>${outlineTables}</aside>
      <main class="survey-editor-content"><div class="survey-required-alert" data-survey-required-alert ${surveyReady ? "hidden" : ""}>还有必填字段未填写，填写完整后才能完成确认。</div><div class="survey-filter-empty" data-survey-all-complete ${surveyReady ? "" : "hidden"}>必填问题和专项清单已经补齐，可以完成确认。</div>${modules}<div class="survey-special-heading"><span>专项清单</span><small>4 张清单均需至少一行，必填字段必须完整</small></div>${tables}</main>
    </div>
  </div>`, {
    extraWide: true,
    dialogClass: "survey-editor-dialog",
    submitLabel: "保存草稿",
    onSubmit: writable ? async () => {
      if (survey.status === "DRAFT") await activeDraftAutosave?.flush();
      const saved = await api(`/api/surveys/${survey.id}`, { method: "PATCH", body: JSON.stringify({ title: document.querySelector("#survey-edit-title").value, reason: document.querySelector("#survey-edit-reason")?.value, response: collectSurveyResponse(), ...(survey.status === "DRAFT" ? { expectedDraftEtag: activeDraftAutosave?.getState().etag } : {}) }) });
      closeDialog(); showToast(survey.status === "COMPLETED" ? `已创建 V${saved.versionNumber} 草稿，原确认版保持只读` : "调研草稿已保存并记录修改"); await go("surveys");
    } : undefined
  });
  survey.template.schema.tables.forEach(definition => {
    document.querySelector(`[data-add-survey-row="${definition.key}"]`)?.addEventListener("click", () => {
      const list = document.querySelector(`[data-survey-table="${definition.key}"]`);
      const count = list.querySelectorAll("[data-survey-table-row]").length;
      list.insertAdjacentHTML("beforeend", surveyTableRow(definition, {}, true, count));
      resizeSurveySpecialTextareas(list);
      updateSurveyEditorProgress();
    });
  });
  bindSurveyEditorInteractions();
  if (writable && survey.status === "DRAFT") {
    startDialogAutosave({
      root: document.querySelector(".dialog"),
      initialEtag: survey.draftEtag,
      initialSavedAt: survey.draftSavedAt || survey.updatedAt,
      collect: () => ({ title: document.querySelector("#survey-edit-title").value, response: collectSurveyResponse() }),
      save: payload => api(`/api/surveys/${survey.id}`, { method: "PATCH", body: JSON.stringify(payload) })
    });
  }
}

async function openSurveyHistory(surveyId) {
  const result = await api(`/api/surveys/${surveyId}/revisions`);
  openDialog("查看软件调研历史", result.items.length ? `<ul class="list">${result.items.map(item => `<li><div><strong>V${item.versionNumber} / R${item.revision} · ${escapeHtml(item.reason)}</strong><small>${formatTime(item.changedAt)} · ${escapeHtml(item.changedBy.displayName)}</small></div><span>${item.after.status === "COMPLETED" ? "完成确认" : "草稿"}</span></li>`).join("")}</ul>` : `<div class="empty">尚无修改记录</div>`, { wide: true });
}

function openSurveyCompleteDialog(surveyId) {
  openDialog("确认完成调研", `<div class="notice warning">必填内容已经完整。确认后才能导出正式 Word；后续修改必须填写原因、生成新草稿版本并重新完成确认。</div>`, {
    submitLabel: "确认完成",
    onSubmit: async () => {
      try {
        await api(`/api/surveys/${surveyId}/complete`, { method: "POST", body: "{}" });
      } catch (error) {
        if (error.message === "调研仍有必填项未完成" || error.details?.length) throw new Error("还有必填字段未填写，填写完整后才能完成确认。");
        throw error;
      }
      closeDialog(); showToast("调研已完成确认"); await go("surveys");
    }
  });
}

async function renderImports(content) {
  const result = await api("/api/imports/customer");
  content.innerHTML = `${pageHead("历史 Excel 导入", "上传后先映射和预览，再按不超过 50 行分批导入", `<button class="button primary" data-action="show-import-upload">上传 Excel</button>`)}
    <div class="notice warning">只接受不超过 8 MB 的 .xlsx 文件。“签订合同中”会映射为“报价完成&amp;商务洽谈”并保留原值；同名客户默认阻止，确认同一主体后可合并，只有管理员能凭原因和区分依据强制新建。</div>
    <div id="import-upload" class="card card-body import-upload" hidden><form id="import-upload-form"><div class="field"><label class="required">客户历史表（.xlsx）</label><input id="import-file" name="file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></div><button class="button primary" type="submit">上传并生成预览</button><span id="import-upload-status" class="muted"></span></form></div>
    <div id="import-detail"></div>
    <div class="card table-wrap section-gap"><table><thead><tr><th>任务</th><th>工作表 / 表头行</th><th>总行数</th><th>可导入</th><th>重复</th><th>失败</th><th>已导入</th><th>操作</th></tr></thead><tbody>${result.items.map(job => `<tr><td>${job.id.slice(0, 8)}</td><td>${escapeHtml(job.sheetName || "—")} / ${job.headerRow || "—"}</td><td>${job.counts.total}</td><td>${job.counts.valid}</td><td>${job.counts.duplicate}</td><td>${job.counts.failed}</td><td>${job.counts.imported}</td><td><button class="button small" data-import-open="${job.id}">查看任务</button></td></tr>`).join("")}</tbody></table>${result.items.length ? "" : `<div class="empty">尚无导入任务</div>`}</div>`;
  document.querySelector("#import-upload-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    const status = document.querySelector("#import-upload-status");
    status.textContent = "正在解析和校验…";
    try {
      const body = new FormData(); body.append("file", document.querySelector("#import-file").files[0]);
      const job = await api("/api/imports/customer/upload", { method: "POST", body });
      showToast("Excel 已上传并生成预览");
      await renderImportJob(job.id);
    } catch (error) { status.textContent = error.message; }
    finally { if (button.isConnected) button.disabled = false; }
  });
}

function importDuplicateControls(row) {
  if (row.status !== "DUPLICATE") return escapeHtml(row.errors.join("；") || "通过校验");
  const candidates = row.duplicateCandidates || [];
  const mergeOption = candidates.length ? `<option value="MERGE">确认同一主体，合并来源</option>` : "";
  const forceOption = state.user.role === "ADMIN" ? `<option value="FORCE_CREATE">同名不同主体，强制新建</option>` : "";
  return `<div class="field"><label>处理方式</label><select data-duplicate-action="${row.rowNumber}"><option value="">暂不处理</option>${mergeOption}${forceOption}</select></div>${candidates.length ? `<div class="field"><label>合并到</label><select data-duplicate-target="${row.rowNumber}">${candidates.map(item => `<option value="${item.id}">${escapeHtml(item.fullName)} · ${escapeHtml(item.owner.displayName)} · ${escapeHtml(item.registeredOn || "日期未知")}</option>`).join("")}</select></div>` : ""}${state.user.role === "ADMIN" ? `<div class="field"><label>强制原因</label><input data-duplicate-reason="${row.rowNumber}" maxlength="500" /></div><div class="field"><label>区分依据类型</label><select data-duplicate-basis-type="${row.rowNumber}"><option value="">请选择</option><option value="CREDIT_CODE">统一社会信用代码</option><option value="ADDRESS">地址</option><option value="BRANCH">分支机构</option><option value="OTHER">其他</option></select></div><div class="field"><label>区分依据</label><input data-duplicate-basis="${row.rowNumber}" maxlength="1000" /></div>` : ""}`;
}

async function renderImportJob(jobId) {
  const [job, fields, owners] = await Promise.all([api(`/api/imports/customer/${jobId}`), api("/api/imports/customer/fields"), api("/api/assignable-users")]);
  state.importJob = job;
  const headers = job.workbook.headers || [];
  const actionableRows = job.rows.filter(row => row.status === "VALID" || (row.status === "DUPLICATE" && ((row.duplicateCandidates || []).length || state.user.role === "ADMIN")));
  const issueRows = job.rows.filter(row => ["FAILED", "DUPLICATE"].includes(row.status));
  const detail = document.querySelector("#import-detail");
  detail.innerHTML = `<section class="card import-detail"><div class="card-head"><h2>导入任务 ${job.id.slice(0, 8)}</h2><a class="button small" id="import-source-download" href="/api/files/${job.fileId}/download">下载原文件</a></div><div class="card-body"><div class="import-counts"><span>总行 ${job.counts.total}</span><span>可导入 ${job.counts.valid}</span><span>重复 ${job.counts.duplicate}</span><span>失败 ${job.counts.failed}</span><span>已导入 ${job.counts.imported}</span></div><h3>字段映射</h3><div class="mapping-grid">${fields.items.map(field => `<div class="field"><label class="${field.required ? "required" : ""}">${escapeHtml(field.label)}</label><select data-import-field="${field.key}"><option value="">不导入</option>${headers.map(header => `<option value="${header.column}"${job.fieldMapping[field.key] === header.column ? " selected" : ""}>${header.column}. ${escapeHtml(header.label)}</option>`).join("")}</select></div>`).join("")}</div><button class="button" id="import-remap">重新校验预览</button><hr /><div class="form-grid"><div class="field"><label class="required">导入后的客户负责人</label><select id="import-owner">${owners.items.map(owner => `<option value="${owner.id}">${escapeHtml(owner.displayName)}</option>`).join("")}</select></div><div class="field checkbox-field"><label><input id="import-select-all" type="checkbox" checked /> 选择前 50 行可处理数据</label></div></div><button class="button primary" id="import-batch" ${actionableRows.length ? "" : "disabled"}>处理选中行（每批最多 50 行）</button><h3>数据预览</h3><div class="table-wrap"><table><thead><tr><th>选择</th><th>Excel 行</th><th>客户名称</th><th>登记时间</th><th>客户状态</th><th>校验 / 重复处理</th></tr></thead><tbody>${job.rows.map((row, index) => { const actionable = row.status === "VALID" || (row.status === "DUPLICATE" && ((row.duplicateCandidates || []).length || state.user.role === "ADMIN")); const originalStatus = row.normalized?.originalStatus || row.source.status || "—"; const mappedStatus = row.normalized?.status; return `<tr><td>${actionable ? `<input class="import-row-check" data-import-row-status="${row.status}" type="checkbox" value="${row.rowNumber}" ${index < 50 ? "checked" : ""} />` : "—"}</td><td>${row.rowNumber}</td><td>${escapeHtml(row.normalized?.fullName || row.source.fullName || "—")}</td><td>${row.normalized?.registeredOn ? escapeHtml(row.normalized.registeredOn) : `<span class="muted">日期未知</span>`}</td><td>${escapeHtml(originalStatus)}${mappedStatus && mappedStatus !== originalStatus ? `<br><small>映射为 ${escapeHtml(mappedStatus)}</small>` : ""}</td><td>${row.status === "DUPLICATE" ? importDuplicateControls(row) : row.status === "IMPORTED" ? `<span class="tag green">已导入</span>` : escapeHtml(row.errors.join("；") || "通过校验")}</td></tr>`; }).join("")}</tbody></table></div>${issueRows.length ? `<h3>失败及重复行清单</h3><ul class="list issue-list">${issueRows.map(row => `<li><strong>第 ${row.rowNumber} 行 · ${escapeHtml(row.normalized?.fullName || row.source.fullName || "未命名")}</strong><span>${escapeHtml(row.errors.join("；") || `发现 ${row.duplicateCount} 个同名记录`)}</span></li>`).join("")}</ul>` : ""}</div></section>`;
  detail.insertAdjacentHTML("beforeend", `<section class="card card-body section-gap"><div class="card-head"><h2>信息收集 H 列历史跟进</h2><button class="button" id="history-preview">拆分 / 刷新预览</button></div><div id="history-preview-panel" aria-live="polite"></div></section>`);
  detail.insertAdjacentHTML("beforeend", `<section class="card card-body section-gap"><div class="card-head"><h2>慕尼黑客户拜访记录 · 逐行迁移</h2><button class="button" id="visit-preview">解析 / 刷新预览</button></div><div id="visit-preview-panel" aria-live="polite"></div></section>`);
  detail.insertAdjacentHTML("beforeend", `<section class="card card-body section-gap"><div class="card-head"><h2>周汇报 · 待分类历史来源</h2><button class="button" id="weekly-preview">解析 / 刷新预览</button></div><div id="weekly-preview-panel" aria-live="polite"></div></section>`);
  document.querySelector("#history-preview").addEventListener("click", () => renderHistoricalFollowupPreview(jobId, true));
  document.querySelector("#visit-preview").addEventListener("click", () => renderMunichVisitPreview(jobId, true, owners.items));
  document.querySelector("#weekly-preview").addEventListener("click", () => renderWeeklyReportPreview(jobId, true));
  document.querySelector("#import-remap").disabled = job.mappingLocked;
  if (job.mappingLocked) document.querySelector("#import-remap").textContent = "已有提交来源，字段映射已锁定";
  await renderHistoricalFollowupPreview(jobId, false);
  await renderMunichVisitPreview(jobId, false, owners.items);
  await renderWeeklyReportPreview(jobId, false);
  if (!detail.isConnected) return;
  detail.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelector("#import-select-all").addEventListener("change", event => document.querySelectorAll(".import-row-check").forEach((box, index) => { box.checked = event.target.checked && index < 50; }));
  document.querySelector("#import-remap").addEventListener("click", async event => {
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    const fieldMapping = Object.fromEntries([...document.querySelectorAll("[data-import-field]")].filter(select => select.value).map(select => [select.dataset.importField, Number(select.value)]));
    try {
      await api(`/api/imports/customer/${job.id}/preview`, { method: "POST", body: JSON.stringify({ sheetName: job.sheetName, headerRow: job.headerRow, fieldMapping }) });
      showToast("字段映射已重新校验"); await go("imports"); await renderImportJob(job.id);
    } catch (error) { showToast(error.message); }
    finally { if (button.isConnected) button.disabled = job.mappingLocked; }
  });
  document.querySelector("#import-batch").addEventListener("click", async () => {
    const selected = [...document.querySelectorAll(".import-row-check:checked")].slice(0, 50);
    const rowNumbers = selected.map(box => Number(box.value));
    if (!rowNumbers.length) { showToast("请至少选择一行可处理数据"); return; }
    const duplicateActions = {};
    for (const box of selected.filter(item => item.dataset.importRowStatus === "DUPLICATE")) {
      const rowNumber = box.value;
      const action = document.querySelector(`[data-duplicate-action="${rowNumber}"]`)?.value;
      if (action === "MERGE") duplicateActions[rowNumber] = { action, existingCustomerId: document.querySelector(`[data-duplicate-target="${rowNumber}"]`)?.value };
      if (action === "FORCE_CREATE") duplicateActions[rowNumber] = { action, reason: document.querySelector(`[data-duplicate-reason="${rowNumber}"]`)?.value, basisType: document.querySelector(`[data-duplicate-basis-type="${rowNumber}"]`)?.value, basis: document.querySelector(`[data-duplicate-basis="${rowNumber}"]`)?.value };
    }
    const result = await api(`/api/imports/customer/${job.id}/import`, { method: "POST", body: JSON.stringify({ ownerId: document.querySelector("#import-owner").value, rowNumbers, duplicateActions }) });
    showToast(`本批已处理 ${result.results.filter(item => item.status === "IMPORTED").length} 行`); await go("imports"); await renderImportJob(job.id);
  });
}

function munichVisitEntryHtml(entry, owners) {
  const customerOptions = entry.boundCustomer
    ? `<option value="MERGE|${entry.boundCustomer.id}">继续处理已绑定客户：${escapeHtml(entry.boundCustomer.fullName)}</option>`
    : `${entry.candidateCustomers.map(item => `<option value="MERGE|${item.id}">合并：${escapeHtml(item.fullName)} · ${escapeHtml(item.owner.displayName)}${item.sourceMatched ? " · 已有同文件来源" : ""}</option>`).join("")}${state.user.role === "ADMIN" ? entry.candidateCustomers.length ? `<option value="FORCE_CREATE">同名不同主体，管理员强制新建</option>` : `<option value="CREATE">新建客户（状态和负责人人工选择）</option>` : ""}`;
  const contacts = Object.values(entry.contactCandidates || {}).flat();
  const rawFields = Object.entries(entry.source).map(([label, value]) => `${escapeHtml(label)}：${escapeHtml(value === "" || value === null || value === undefined ? "（空）" : value)}`).join("\n");
  return `<details class="section-gap visit-entry" data-visit-entry="${entry.id}"><summary><strong>第 ${entry.rowNumber} 行 · ${escapeHtml(entry.normalized.customerName || "客户名称待核对")}</strong>　${entry.status === "REVIEW_REQUIRED" ? "保留待核对" : entry.status === "PROCESSED" ? "已绑定，可继续确认未处理字段" : "待人工选择主体"}</summary><div class="notice">意向：${escapeHtml(entry.normalized.intention || "未记录")}　拜访状态：${escapeHtml(entry.normalized.visitStatus || "未记录")}　计划拜访：${escapeHtml(entry.normalized.plannedVisitOn || "未记录")}（仅候选，不是实际跟进）<br>原“售前”：${escapeHtml(entry.normalized.salesText || "未记录")}　精确账号候选：${escapeHtml(entry.ownerCandidates.map(item => `${item.displayName}（${item.username}）`).join("、") || "无")}</div>${entry.issues.map(issue => `<p class="error-text">${escapeHtml(issue.message)}</p>`).join("")}${entry.warnings.map(issue => `<p class="muted">${escapeHtml(issue.message)}</p>`).join("")}<details><summary>完整十一字段原文</summary><pre class="history-source-text">${rawFields}</pre><p class="history-source-text">SHA-256：${escapeHtml(entry.sourceSha256)} · ${escapeHtml(entry.sheetName)} 第${entry.rowNumber}行 · 来源键 ${escapeHtml(entry.sourceKey)}</p></details>${entry.canConfirm ? `<div class="form-grid"><div class="field full"><label class="required">客户主体处理</label><select data-visit-customer><option value="">请选择，不按名称自动确定</option>${customerOptions}</select></div><div class="field"><label class="required">当前负责人</label><select data-visit-owner><option value="">请选择已启用售前</option>${owners.map(owner => `<option value="${owner.id}">${escapeHtml(owner.displayName)}（${escapeHtml(owner.username)}）</option>`).join("")}</select></div><div class="field"><label>新建客户正式状态</label><select data-visit-status><option value="">仅新建时必选</option>${customerStatuses.map(status => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`).join("")}</select></div>${entry.candidateFields.map(field => `<div class="field"><label>${escapeHtml(field.label)}候选：${escapeHtml(field.value)}${field.confirmed ? "（已有确认记录）" : ""}</label><select data-visit-field="${field.key}"><option value="">暂不确认，继续保留</option><option value="APPLY">应用（已有非空值仍保留）</option><option value="SKIP">确认本次不应用</option></select></div>`).join("")}<div class="field"><label>接洽人候选：${escapeHtml(entry.normalized.contactRaw || "未记录")}</label><select data-visit-contact><option value="">暂不确认</option><option value="SKIP">确认不新建联系人</option>${entry.normalized.contactName ? `<option value="CREATE">新增最小联系人</option>` : ""}${contacts.map(contact => `<option value="MATCH|${contact.id}">关联已有同名联系人：${escapeHtml(contact.name)}</option>`).join("")}</select></div>${state.user.role === "ADMIN" ? `<div class="field"><label>强制新建原因</label><input data-visit-force-reason maxlength="500" /></div><div class="field"><label>主体区分依据</label><select data-visit-basis-type><option value="">请选择类型</option><option value="CREDIT_CODE">统一社会信用代码</option><option value="ADDRESS">地址</option><option value="BRANCH">分支机构</option><option value="OTHER">其他</option></select><input data-visit-basis maxlength="1000" placeholder="填写可审计依据" /></div>` : ""}</div><label><input type="checkbox" class="visit-entry-check" value="${entry.id}" /> 选择本行加入本次确认</label>` : ""}</details>`;
}

async function renderMunichVisitPreview(jobId, parse, owners, results = []) {
  const panel = document.querySelector("#visit-preview-panel");
  const refresh = document.querySelector("#visit-preview");
  if (!panel || panel.dataset.busy === "true") return;
  panel.dataset.busy = "true";
  refresh.disabled = true;
  panel.innerHTML = `<div class="empty">正在读取逐行来源并校验当前客户权限…</div>`;
  try {
    const view = await api(`/api/imports/customer/${jobId}/munich-visits${parse ? "/preview" : ""}`, parse ? { method: "POST", body: "{}" } : {});
    if (!panel.isConnected || state.importJob?.id !== jobId) return;
    if (view.entries.length && state.user.role !== "ADMIN") document.querySelector("#import-source-download")?.setAttribute("hidden", "");
    panel.innerHTML = `<div class="notice warning">只接受目标表第2行固定 A:K 表头。客户主体、负责人和新建状态必须人工选择；登记/计划日期、意向和拜访状态不互相映射。本模块不创建跟进或提醒，合并不覆盖已有非空字段。</div><p>当前权限下 ${view.counts.total} 行 · 待选择 ${view.counts.awaiting} · 待核对 ${view.counts.review} · 已处理 ${view.counts.processed}</p>${results.length ? `<div class="notice">本次成功 ${results.filter(item => item.status === "PROCESSED").length}，已处理 ${results.filter(item => item.status === "ALREADY_PROCESSED").length}，失败 ${results.filter(item => item.status === "FAILED").length}${results.filter(item => item.status === "FAILED").map(item => `<p>${escapeHtml(view.entries.find(entry => entry.id === item.id)?.rowNumber || "来源行")}：${escapeHtml(item.message)}</p>`).join("")}</div>` : ""}${view.entries.map(entry => munichVisitEntryHtml(entry, owners)).join("") || `<div class="empty">尚无逐行预览。点击“解析 / 刷新预览”；普通账号只显示本人当前有权客户的候选行。</div>`}${view.entries.some(entry => entry.canConfirm) ? `<label class="section-gap"><input type="checkbox" id="visit-confirmed" /> 我已逐行核对客户主体、负责人、正式状态及字段候选</label><div class="actions section-gap"><button class="button primary" id="visit-confirm">确认处理选中行（最多50行）</button></div><p id="visit-confirm-status" aria-live="polite"></p>` : ""}`;
    panel.querySelector("#visit-confirm")?.addEventListener("click", async event => {
      const button = event.currentTarget;
      if (button.disabled) return;
      const status = panel.querySelector("#visit-confirm-status");
      const selected = [...panel.querySelectorAll(".visit-entry-check:checked")].slice(0, 50);
      if (!panel.querySelector("#visit-confirmed")?.checked || !selected.length) { status.textContent = "请选择1至50行并勾选逐行核对确认。"; return; }
      const entries = selected.map(box => {
        const container = box.closest("[data-visit-entry]");
        const [action, customerId] = (container.querySelector("[data-visit-customer]").value || "|").split("|");
        const contactValue = container.querySelector("[data-visit-contact]")?.value || "";
        const [contactAction, existingContactId] = contactValue.split("|");
        return {
          id: box.value, action, customerId: customerId || null, ownerId: container.querySelector("[data-visit-owner]").value,
          customerStatus: container.querySelector("[data-visit-status]").value,
          fieldActions: Object.fromEntries([...container.querySelectorAll("[data-visit-field]")].filter(select => select.value).map(select => [select.dataset.visitField, select.value])),
          contact: contactAction ? { action: contactAction, existingContactId: existingContactId || null } : null,
          forceReason: container.querySelector("[data-visit-force-reason]")?.value || "",
          basisType: container.querySelector("[data-visit-basis-type]")?.value || "",
          basis: container.querySelector("[data-visit-basis]")?.value || ""
        };
      });
      button.disabled = true; refresh.disabled = true; status.textContent = "正在事务内重新鉴权并逐行处理…";
      try {
        const response = await api(`/api/imports/customer/${jobId}/munich-visits/confirm`, { method: "POST", body: JSON.stringify({ confirmed: true, entries }) });
        if (panel.isConnected && response.results.some(item => item.status === "PROCESSED")) {
          const remap = document.querySelector("#import-remap");
          remap.disabled = true; remap.textContent = "已有提交来源，字段映射已锁定";
        }
        if (panel.isConnected && state.importJob?.id === jobId) await renderMunichVisitPreview(jobId, false, owners, response.results);
      } catch (error) {
        if (panel.isConnected) { status.textContent = error.message; button.disabled = false; }
      } finally { if (refresh.isConnected) refresh.disabled = false; }
    });
  } catch (error) {
    if (panel.isConnected) panel.innerHTML = `<div class="notice warning">${escapeHtml(error.message)}。可重试；权限变更后请返回客户列表。</div>`;
  } finally {
    panel.dataset.busy = "false";
    if (refresh.isConnected) refresh.disabled = false;
  }
}

function weeklyReportEntryHtml(entry) {
  const cells = entry.sourceCells.map(cell => `${escapeHtml(cell.cellReference)}${cell.headerText ? `［${escapeHtml(cell.headerText)}］` : ""}：${escapeHtml(cell.rawText)}${cell.valueType === "FORMULA" ? `（公式结果：${escapeHtml(cell.formulaResult || "空") }）` : ""}`).join("\n");
  const customerOptions = entry.linkedCustomer
    ? `<option value="LINK_CUSTOMER|${entry.linkedCustomer.id}">继续关联已确认客户：${escapeHtml(entry.linkedCustomer.fullName)}</option>`
    : `${entry.candidateCustomers.map(customer => `<option value="LINK_CUSTOMER|${customer.id}">关联现有客户：${escapeHtml(customer.fullName)} · ${escapeHtml(customer.owner.displayName)} · 匹配单元格 ${escapeHtml(customer.matchedCells.join("、"))}</option>`).join("")}${state.user.role === "ADMIN" ? `<option value="CLASSIFY_ONLY">仅分类归档，继续待匹配客户</option>` : ""}`;
  const cellOptions = entry.sourceCells.map(cell => `<option value="${escapeHtml(cell.cellReference)}">${escapeHtml(cell.cellReference)} · ${escapeHtml(cell.rawText.slice(0, 80))}</option>`).join("");
  const candidateSummary = `<div class="notice">日期候选：${entry.candidates.dateCells?.map(item => `${escapeHtml(item.cellReference)}=${escapeHtml(item.rawText)}${item.normalizedDate ? `（仅候选日期 ${escapeHtml(item.normalizedDate)}）` : "（原文待确认）"}`).join("；") || "无"}<br>未税金额候选：${entry.candidates.amountCells?.map(item => `${escapeHtml(item.cellReference)}=${escapeHtml(item.rawText)}`).join("；") || "无"}（只保留原文，永不写入报价/合同/回款）</div>`;
  return `<details class="section-gap weekly-entry" data-weekly-entry="${entry.id}"><summary><strong>第 ${entry.rowNumber} 行</strong>　${entry.status === "LINKED_SOURCE" ? `已关联 ${escapeHtml(entry.linkedCustomer.fullName)}` : entry.status === "CLASSIFIED_ONLY" ? "已分类、客户待匹配" : "待分类、待匹配"}</summary>${candidateSummary}${entry.issues.map(issue => `<p class="error-text">${escapeHtml(issue.message)}</p>`).join("")}${entry.warnings.map(issue => `<p class="muted">${escapeHtml(issue.message)}</p>`).join("")}<details><summary>完整非空单元格原文（${entry.sourceCells.length}格）</summary><pre class="history-source-text">${cells}</pre><p class="history-source-text">SHA-256：${escapeHtml(entry.sourceSha256)} · ${escapeHtml(entry.sheetName)} 第${entry.rowNumber}行 · 来源键 ${escapeHtml(entry.sourceKey)}</p></details>${entry.decisions.length ? `<details><summary>人工决定历史（${entry.decisions.length}）</summary>${entry.decisions.map(decision => `<p>${escapeHtml(decision.businessType)} · ${decision.customerId ? "已关联客户" : "仅分类"} · 日期 ${escapeHtml(decision.dateHandling)} · 内容 ${escapeHtml(decision.contentHandling)} · 未生成业务记录</p>`).join("")}</details>` : ""}${entry.canConfirm ? `<div class="form-grid"><div class="field full"><label class="required">客户主体处理</label><select data-weekly-action><option value="">请选择，不按姓名或邻接关系自动确定</option>${customerOptions}</select></div><div class="field full"><label class="required">业务类型（人工填写，不触发自动转换）</label><input data-weekly-business-type maxlength="100" placeholder="例如：客户活动历史来源" /></div><div class="field"><label class="required">日期确认</label><select data-weekly-date-handling><option value="">请选择</option><option value="SOURCE_CELL">日期引用本行单元格</option><option value="NOT_RECORDED">原文未记录可确认日期</option><option value="NOT_REQUIRED">该分类无需日期</option></select></div><div class="field"><label>日期来源单元格</label><select data-weekly-date-cell><option value="">仅“引用本行单元格”时选择</option>${cellOptions}</select></div><div class="field"><label class="required">内容确认</label><select data-weekly-content-handling><option value="">请选择</option><option value="SOURCE_CELLS">内容引用本行单元格</option><option value="NOT_RECORDED">原文未记录可确认内容</option><option value="NOT_REQUIRED">该分类无需内容</option></select></div><div class="field"><label>内容来源单元格（可多选，最多20格）</label><select data-weekly-content-cells multiple size="4">${cellOptions}</select></div></div><label><input type="checkbox" class="weekly-entry-check" value="${entry.id}" /> 选择本行加入本次确认</label>` : ""}</details>`;
}

async function renderWeeklyReportPreview(jobId, parse, search = "", results = []) {
  const panel = document.querySelector("#weekly-preview-panel");
  const refresh = document.querySelector("#weekly-preview");
  if (!panel || panel.dataset.busy === "true") return;
  panel.dataset.busy = "true";
  refresh.disabled = true;
  panel.innerHTML = `<div class="empty">正在读取不规则源行并按当前客户权限过滤…</div>`;
  try {
    const query = !parse && search ? `?search=${encodeURIComponent(search)}` : "";
    const view = await api(`/api/imports/customer/${jobId}/weekly-report${parse ? "/preview" : query}`, parse ? { method: "POST", body: "{}" } : {});
    if (!panel.isConnected || state.importJob?.id !== jobId) return;
    if (view.entries.length && state.user.role !== "ADMIN") document.querySelector("#import-source-download")?.setAttribute("hidden", "");
    panel.innerHTML = `<div class="notice warning">周汇报不是稳定客户表。本期只保存完整源行并支持人工分类/关联；不按邻接猜客户或日期，不新建客户，不生成跟进/提醒，未税金额永不写入报价、合同、回款或其他正式金额字段。</div><div class="actions"><input id="weekly-search" value="${escapeHtml(search)}" placeholder="在当前权限的源行和分类中检索" /><button class="button small" id="weekly-search-button">检索</button></div><p>当前权限下 ${view.counts.total} 行 · 待分类 ${view.counts.awaiting} · 已分类待匹配 ${view.counts.classified} · 已关联客户 ${view.counts.linked}</p>${results.length ? `<div class="notice">本次确认 ${results.filter(item => item.status === "CONFIRMED").length}，已处理 ${results.filter(item => item.status === "ALREADY_CONFIRMED").length}，失败 ${results.filter(item => item.status === "FAILED").length}${results.filter(item => item.status === "FAILED").map(item => `<p>${escapeHtml(view.entries.find(entry => entry.id === item.id)?.rowNumber || "来源行")}：${escapeHtml(item.message)}</p>`).join("")}</div>` : ""}${view.entries.map(weeklyReportEntryHtml).join("") || `<div class="empty">尚无当前权限可见的周汇报来源。点击“解析 / 刷新预览”；无可靠客户匹配的行仅管理员可分类归档。</div>`}${view.entries.some(entry => entry.canConfirm) ? `<label class="section-gap"><input type="checkbox" id="weekly-confirmed" /> 我已逐行确认客户主体、业务类型以及日期/内容来源</label><label><input type="checkbox" id="weekly-no-record" /> 我确认本期只分类/关联来源，不生成跟进、提醒、报价、合同或金额记录</label><div class="actions section-gap"><button class="button primary" id="weekly-confirm">确认选中来源（最多50行）</button></div><p id="weekly-confirm-status" aria-live="polite"></p>` : ""}`;
    panel.querySelector("#weekly-search-button")?.addEventListener("click", () => renderWeeklyReportPreview(jobId, false, panel.querySelector("#weekly-search").value));
    panel.querySelector("#weekly-confirm")?.addEventListener("click", async event => {
      const button = event.currentTarget;
      if (button.disabled) return;
      const status = panel.querySelector("#weekly-confirm-status");
      const selected = [...panel.querySelectorAll(".weekly-entry-check:checked")].slice(0, 50);
      if (!panel.querySelector("#weekly-confirmed")?.checked || !panel.querySelector("#weekly-no-record")?.checked || !selected.length) { status.textContent = "请选择1至50行，并勾选逐行核对和不生成业务记录两项确认。"; return; }
      const entries = selected.map(box => {
        const container = box.closest("[data-weekly-entry]");
        const [action, customerId] = (container.querySelector("[data-weekly-action]").value || "|").split("|");
        return {
          id: box.value,
          action,
          customerId: customerId || null,
          businessType: container.querySelector("[data-weekly-business-type]").value,
          dateHandling: container.querySelector("[data-weekly-date-handling]").value,
          dateCellReference: container.querySelector("[data-weekly-date-cell]").value || null,
          contentHandling: container.querySelector("[data-weekly-content-handling]").value,
          contentCellReferences: [...container.querySelector("[data-weekly-content-cells]").selectedOptions].map(option => option.value),
          noBusinessRecordConfirmed: true
        };
      });
      button.disabled = true; refresh.disabled = true; status.textContent = "正在事务内重新鉴权并逐行保存分类/关联来源…";
      try {
        const response = await api(`/api/imports/customer/${jobId}/weekly-report/confirm`, { method: "POST", body: JSON.stringify({ confirmed: true, entries }) });
        if (panel.isConnected && response.results.some(item => item.status === "CONFIRMED")) {
          const remap = document.querySelector("#import-remap");
          remap.disabled = true; remap.textContent = "已有提交来源，字段映射已锁定";
        }
        if (panel.isConnected && state.importJob?.id === jobId) await renderWeeklyReportPreview(jobId, false, search, response.results);
      } catch (error) {
        if (panel.isConnected) { status.textContent = error.message; button.disabled = false; }
      } finally { if (refresh.isConnected) refresh.disabled = false; }
    });
  } catch (error) {
    if (panel.isConnected) panel.innerHTML = `<div class="notice warning">${escapeHtml(error.message)}。可重试；权限变更后请返回客户列表。</div>`;
  } finally {
    panel.dataset.busy = "false";
    if (refresh.isConnected) refresh.disabled = false;
  }
}

async function renderHistoricalFollowupPreview(jobId, parse, results = []) {
  const panel = document.querySelector("#history-preview-panel");
  const refresh = document.querySelector("#history-preview");
  if (!panel || panel.dataset.busy === "true") return;
  panel.dataset.busy = "true";
  refresh.disabled = true;
  panel.innerHTML = `<div class="empty">正在读取来源并校验当前权限…</div>`;
  try {
    const view = await api(`/api/imports/customer/${jobId}/followups${parse ? "/preview" : ""}`, parse ? { method: "POST", body: "{}" } : {});
    if (!panel.isConnected || state.importJob?.id !== jobId) return;
    panel.innerHTML = `<div class="notice">只按已确认的主档行级来源匹配，不按名字新建客户或合并主体。日精度不补时刻；不明确日期、多行续文和歧义来源保留待核对。历史字段缺省标为原文未记录，不创建提醒，不覆盖客户总结。</div><p>共 ${view.counts.total} 段 · 待确认 ${view.counts.ready} · 待核对 ${view.counts.review} · 已追加 ${view.counts.imported}</p>${results.length ? `<div class="notice">本次追加 ${results.filter(row => row.status === "IMPORTED").length}，已存在 ${results.filter(row => row.status === "ALREADY_IMPORTED").length}，失败 ${results.filter(row => row.status === "FAILED").length}${results.filter(row => row.status === "FAILED").map(row => `<p>${escapeHtml(view.entries.find(entry => entry.id === row.id)?.cellReference || "条目")}：${escapeHtml(row.message)}</p>`).join("")}</div>` : ""}${view.entries.length ? `<div class="table-wrap"><table><thead><tr><th>确认</th><th>来源 / 日期 / 方式</th><th>已有客户 / 状态</th><th>原文 / 核对原因</th></tr></thead><tbody>${view.entries.map(entry => `<tr><td>${entry.canConfirm ? `<input type="checkbox" class="history-entry-check" value="${entry.id}" aria-label="确认 ${entry.cellReference} 第${entry.paragraphNumber}段" />` : "—"}</td><td>${escapeHtml(entry.sheetName)}!${entry.cellReference} · 第${entry.paragraphNumber}段<br>${escapeHtml(entry.occurredOn || "日期待核对")}（日精度）<br>原日期：${escapeHtml(entry.rawDate || "未识别")}<br>原方式：${escapeHtml(entry.rawMethod || "未标注")} → ${escapeHtml(followupMethodLabels[entry.method])}<details><summary>文件摘要</summary><p class="history-source-text">${escapeHtml(entry.sourceSha256)}</p></details></td><td>${escapeHtml(entry.customer?.name || "尚未唯一匹配")}<br>${entry.status === "READY" ? "待人工确认" : entry.status === "ALREADY_IMPORTED" ? "已追加，不重复导入" : "保留待核对"}</td><td><details><summary>完整原文（${entry.rawText.length}字）</summary><pre class="history-source-text">${escapeHtml(entry.rawText)}</pre></details>${entry.issues.map(issue => `<p class="error-text">${escapeHtml(issue.message)}</p>`).join("")}</td></tr>`).join("")}</tbody></table></div><label><input type="checkbox" id="history-confirmed" /> 我已核对选中条目的来源、匹配客户与日期精度</label><div class="actions section-gap"><button class="button primary" id="history-confirm" ${view.entries.some(row => row.canConfirm) ? "" : "disabled"}>确认追加选中段落（最多50条）</button></div><p id="history-confirm-status" aria-live="polite"></p>` : `<div class="empty">尚无历史预览。点击拆分；仅支持信息收集页第2行表头和H列，不读取其他工作表历史。</div>`}`;
    panel.querySelector("#history-confirm")?.addEventListener("click", async event => {
      const button = event.currentTarget;
      if (button.disabled) return;
      const status = panel.querySelector("#history-confirm-status");
      const ids = [...panel.querySelectorAll(".history-entry-check:checked")].map(box => box.value);
      if (!panel.querySelector("#history-confirmed").checked || !ids.length || ids.length > 50) { status.textContent = "请选择1至50条，并勾选人工核对确认。"; return; }
      button.disabled = true; refresh.disabled = true;
      status.textContent = "正在重新校验权限并追加…";
      try {
        const response = await api(`/api/imports/customer/${jobId}/followups/confirm`, { method: "POST", body: JSON.stringify({ confirmed: true, entries: ids.map(id => ({ id, customerId: view.entries.find(row => row.id === id).customer.id })) }) });
        if (panel.isConnected && response.results.some(row => row.status === "IMPORTED")) {
          const remap = document.querySelector("#import-remap");
          remap.disabled = true; remap.textContent = "已有提交来源，字段映射已锁定";
        }
        if (panel.isConnected && state.importJob?.id === jobId) await renderHistoricalFollowupPreview(jobId, false, response.results);
      } catch (error) {
        if (panel.isConnected) { status.textContent = error.message; button.disabled = false; }
      } finally { if (refresh.isConnected) refresh.disabled = false; }
    });
  } catch (error) {
    if (panel.isConnected) panel.innerHTML = `<div class="notice warning">${escapeHtml(error.message)}。可用上方按钮重试；权限已变更时请返回客户列表。</div>`;
  } finally {
    panel.dataset.busy = "false";
    if (refresh.isConnected) refresh.disabled = false;
  }
}

async function renderContracts(content) {
  const [contracts, templates, quotes] = await Promise.all([api("/api/contracts"), api("/api/contract-templates"), api("/api/quotes")]);
  state.quotes = quotes.items;
  const approvedQuotes = quotes.items.filter(item => item.status === "APPROVED");
  const publishedTemplates = templates.items.filter(item => item.published);
  const canCreate = ["PRESALES", "ADMIN"].includes(state.user.role);
  const adminActions = state.user.role === "ADMIN" ? `<button class="button" data-contract-template-upload>上传合同模板</button>` : "";
  content.innerHTML = `${pageHead("合同管理", "终审报价快照是金额、明细和附件一的唯一来源", `<button class="button" data-sop-context="合同签订">查看合同签订 SOP</button>${adminActions}${canCreate ? `<button class="button primary" data-contract-new ${approvedQuotes.length && publishedTemplates.length ? "" : "disabled"}>+ 创建合同草稿</button>` : ""}`)}
    <div class="notice"><strong>三类字段严格分区：</strong>产品明细、金额、大写金额和年度维护费由服务端锁定；甲方信息须人工确认；乙方及法律条款来自已发布模板固定正文，不开放编辑。</div>
    ${canCreate && (!approvedQuotes.length || !publishedTemplates.length) ? `<div class="notice warning">创建合同前必须同时存在当前账号可访问的终审通过报价和已发布合同模板。</div>` : ""}
    <div class="card table-wrap"><table><thead><tr><th>合同编号</th><th>客户 / 项目</th><th>终审报价</th><th>合同总价</th><th>模板</th><th>状态</th><th>操作</th></tr></thead><tbody>${contracts.items.map(contract => `<tr><td><strong>${escapeHtml(contract.contractNumber)}</strong></td><td>${escapeHtml(contract.customer.name)}<br><small>${escapeHtml(contract.project.name)}</small></td><td><strong>${escapeHtml(contract.quoteReference.quoteNumber)} · ${escapeHtml(contract.quoteReference.versionLabel)}</strong><br><small>终审 ${formatTime(contract.quoteReference.approvedAt)}</small></td><td>${formatMoney(contract.locked.amountCents)}</td><td>${escapeHtml(contract.template.version)}</td><td><span class="tag ${contract.status === "SIGNED" ? "green" : contract.status === "VOID" ? "red" : "orange"}">${escapeHtml(displayEnum(contract.status, contractStatusLabels, "状态待确认"))}</span></td><td><button class="button small primary" data-contract-open="${contract.id}">查看 / 处理</button></td></tr>`).join("")}</tbody></table>${contracts.items.length ? "" : `<div class="empty">当前权限下没有合同记录</div>`}</div>
    ${state.user.role === "ADMIN" ? contractTemplateAdminSection(templates.items) : ""}`;
}

function contractTemplateAdminSection(templates) {
  return `<section class="card section-gap"><div class="card-head"><h2>合同模板版本</h2><span class="tag">仅管理员维护</span></div><div class="table-wrap"><table><thead><tr><th>版本</th><th>原始文件</th><th>校验状态</th><th>上传 / 发布时间</th><th>操作</th></tr></thead><tbody>${templates.map(template => { const issues = template.validation?.issues || []; return `<tr><td><strong>${escapeHtml(template.version)}</strong></td><td>${escapeHtml(template.originalName)}<br><small>SHA-256：${escapeHtml(template.sha256.slice(0, 16))}…</small></td><td><span class="tag ${template.status === "PUBLISHED" ? "green" : template.status === "REJECTED" ? "red" : "orange"}">${escapeHtml(displayEnum(template.status, contractTemplateStatusLabels, "状态待确认"))}</span>${issues.length ? `<br><small>${escapeHtml(issues.map(item => item.message).join("；"))}</small>` : ""}</td><td>${formatTime(template.publishedAt || template.uploadedAt)}</td><td><div class="actions"><a class="button small" href="/api/contract-templates/${template.id}/download">下载原始模板</a>${template.status === "VALIDATED" && !template.published ? `<button class="button small primary" data-contract-template-publish="${template.id}">发布</button>` : ""}</div></td></tr>`; }).join("")}</tbody></table>${templates.length ? "" : `<div class="empty">尚未上传合规合同模板</div>`}</div></section>`;
}

async function openContractCreateDialog(preselectedCustomerId = null) {
  const [quotes, templates] = await Promise.all([api("/api/quotes"), api("/api/contract-templates")]);
  const approved = quotes.items.filter(item => item.status === "APPROVED" && (!preselectedCustomerId || item.customer.id === preselectedCustomerId));
  const published = templates.items.filter(item => item.published);
  if (!approved.length || !published.length) {
    openDialog("创建合同草稿", `<div class="notice warning">当前客户缺少可用的终审通过报价，或系统尚未发布合同模板。请先在既有报价 / 模板流程中完成前置条件。</div>`);
    return;
  }
  const today = localDateTimeValue().slice(0, 10);
  const confirmationFields = [
    ["partyAName", "甲方完整法定名称"], ["licenseScope", "使用权范围"], ["partyALegalRepresentative", "法定代表人（可确认留空）"],
    ["partyARepresentative", "甲方代表（可确认留空）"], ["partyAZip", "邮编（可确认留空）"], ["partyAAddress", "地址（可确认留空）"],
    ["partyAPhone", "电话（可确认留空）"], ["contractNumber", "合同编号"], ["signLocation", "签订地点"], ["signDate", "签订日期"]
  ];
  openDialog("创建合同草稿", `<div class="notice warning">合同金额、维护费和附件一不接受页面输入；服务端将从所选报价的副总终审快照重新计算并锁定。</div><div class="form-grid"><div class="field full"><label class="required">终审通过报价</label><select id="contract-quote">${approved.map(quote => `<option value="${quote.id}">${escapeHtml(quote.quoteNumber)} ${escapeHtml(quote.versionLabel)} · ${escapeHtml(quote.customer.name)} · ${formatMoney(quote.finalDiscountCents)}</option>`).join("")}</select></div><div class="field full"><label class="required">已发布模板</label><select id="contract-template">${published.map(template => `<option value="${template.id}">${escapeHtml(template.version)} · ${escapeHtml(template.originalName)}</option>`).join("")}</select></div><div class="field"><label class="required">合同编号（系统唯一）</label><input id="contract-number" maxlength="100" /></div><div class="field"><label class="required">签订地点</label><input id="contract-location" value="鹤壁" /></div><div class="field"><label class="required">签订日期</label><input id="contract-date" type="date" value="${today}" /></div><div class="field"><label>法定代表人</label><input id="contract-legal-rep" /></div><div class="field"><label>甲方代表</label><input id="contract-rep" /></div><div class="field"><label>邮编</label><input id="contract-zip" /></div><div class="field full"><label>地址</label><input id="contract-address" /></div><div class="field full"><label>电话</label><input id="contract-phone" /></div><div class="field full"><label>签约备注（不改变报价范围和金额）</label><textarea id="contract-signing-notes" maxlength="2000" placeholder="例如：签订沟通事项、实际日期或过程说明"></textarea></div></div><section class="detail-section"><div class="card-head"><h2>服务端锁定值预览</h2></div><div class="card-body" id="contract-locked-preview"></div></section><section class="detail-section"><div class="card-head"><h2>逐项人工确认</h2></div><div class="card-body contract-confirmations">${confirmationFields.map(([key, label]) => `<label><input type="checkbox" data-contract-confirm="${key}" /> 已核对：${escapeHtml(label)}</label>`).join("")}</div></section><div class="notice section-gap">甲方完整法定名称和使用权范围均固定为报价客户全称；乙方信息及法律条款只读使用模板正文。</div>`, {
    extraWide: true,
    submitLabel: "保存合同草稿",
    onSubmit: async () => {
      const quote = approved.find(item => item.id === document.querySelector("#contract-quote").value);
      const confirmations = Object.fromEntries([...document.querySelectorAll("[data-contract-confirm]")].map(box => [box.dataset.contractConfirm, box.checked]));
      const contract = await api("/api/contracts", { method: "POST", body: JSON.stringify({
        contractNumber: document.querySelector("#contract-number").value,
        customerId: quote.customer.id,
        projectId: quote.project.id,
        quoteVersionId: quote.id,
        templateId: document.querySelector("#contract-template").value,
        contractAmountCents: quote.finalDiscountCents,
        signedLocation: document.querySelector("#contract-location").value,
        signedOn: document.querySelector("#contract-date").value,
        signingNotes: document.querySelector("#contract-signing-notes").value,
        partyA: { name: quote.customer.name, licenseScope: quote.customer.name, legalRepresentative: document.querySelector("#contract-legal-rep").value, representative: document.querySelector("#contract-rep").value, zip: document.querySelector("#contract-zip").value, address: document.querySelector("#contract-address").value, phone: document.querySelector("#contract-phone").value },
        confirmations
      }) });
      closeDialog();
      showToast("合同草稿已保存，金额和附件已从终审快照锁定");
      await go("contracts");
      await openContractDetail(contract.id);
    }
  });
  const renderPreview = () => {
    const quote = approved.find(item => item.id === document.querySelector("#contract-quote").value);
    document.querySelector("#contract-locked-preview").innerHTML = `<strong>${escapeHtml(quote.customer.name)} / ${escapeHtml(quote.project.name)}</strong><p>原含税合计：${formatMoney(quote.subtotalTaxedCents)}　最终优惠价 / 合同总价：<strong>${formatMoney(quote.finalDiscountCents)}</strong>　年度维护费：${formatMoney(Math.round(quote.finalDiscountCents / 10))}</p>`;
  };
  document.querySelector("#contract-quote").addEventListener("change", renderPreview);
  renderPreview();
}

function contractAttachmentTable(contract) {
  const attachment = contract.locked.attachment;
  if (!attachment) return `<div class="notice danger">附件一归档快照缺失</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>序号</th><th>项目 / 子项</th><th>单位</th><th>数量</th><th>未税单价</th><th>税率</th><th>价税合计</th></tr></thead><tbody>${attachment.items.map(item => `<tr><td>${item.lineNo}</td><td>${escapeHtml(item.itemName)}${item.subitemName ? `<br><small>${escapeHtml(item.subitemName)}</small>` : ""}</td><td>${escapeHtml(item.unit)}</td><td>${item.quantityMilli / 1000}</td><td>${formatMoney(item.untaxedUnitPriceCents)}</td><td>${item.taxRateBps / 100}%</td><td>${formatMoney(item.taxedAmountCents)}</td></tr>`).join("")}</tbody><tfoot><tr><td colspan="6">附件明细原含税合计</td><td><strong>${formatMoney(attachment.subtotalCents)}</strong></td></tr><tr><td colspan="6">附件汇总最终优惠价 / 合同总价</td><td><strong>${formatMoney(attachment.finalDiscountCents)}</strong></td></tr></tfoot></table></div>`;
}

async function openContractDetail(contractId) {
  const contract = await api(`/api/contracts/${contractId}`);
  const canWrite = ["PRESALES", "ADMIN"].includes(state.user.role) && contract.status !== "VOID";
  const blankLabel = field => contract.confirmations[field] ? "已确认留空" : "尚未确认留空";
  const approvals = contract.quoteReference.approvals.map(item => `${escapeHtml(approvalStageLabels[item.stage] || "审批人")}：${escapeHtml(item.approver.displayName)}（${formatTime(item.createdAt)}，${escapeHtml(item.comment)}）`).join("；");
  const generatedNote = contract.generationSigningNotes;
  const statusSuggestion = shouldShowSignedStatusSuggestion(contract) ? `<div class="notice warning section-gap"><strong>合同已签订，但客户状态尚未同步。</strong><p>${escapeHtml(contract.customerStatusSuggestion.message)}。系统不会自动修改，须由当前客户负责人或管理员明确确认。</p><button class="button primary" data-contract-confirm-status="${contract.id}" data-customer-name="${escapeHtml(contract.customer.name)}">确认更新客户状态</button></div>` : "";
  openDialog("查看合同", `<p><strong>${escapeHtml(contract.contractNumber)}</strong> · ${escapeHtml(displayEnum(contract.status, contractStatusLabels, "状态待确认"))}</p><section class="detail-section contract-quote-reference"><div class="card-head"><h2>引用报价与审批</h2><span class="tag green">已验证终审快照</span></div><div class="card-body"><p><strong>${escapeHtml(contract.quoteReference.quoteNumber)} · ${escapeHtml(contract.quoteReference.versionLabel)}</strong>　终审完成：${formatTime(contract.quoteReference.approvedAt)}</p><p>${approvals}</p></div></section><section class="detail-section"><div class="card-head"><h2>系统锁定值</h2><span class="tag green">终审快照</span></div><div class="card-body"><p><strong>合同总价：</strong>${formatMoney(contract.locked.amountCents)}（${escapeHtml(contract.locked.amountUpper)}）</p><p><strong>年度维护费 10%：</strong>${formatMoney(contract.locked.maintenanceFeeCents)}（${escapeHtml(contract.locked.maintenanceFeeUpper)}）</p>${contractAttachmentTable(contract)}</div></section><section class="detail-section"><div class="card-head"><h2>待人工确认值与签约备注</h2><div class="actions">${canWrite && contract.status === "DRAFT" ? `<button class="button small" data-contract-edit="${contract.id}">修改并逐项确认</button>` : ""}${canWrite && contract.status !== "DRAFT" ? `<button class="button small" data-contract-notes="${contract.id}">更新过程备注</button>` : ""}</div></div><div class="card-body"><p><strong>甲方：</strong>${escapeHtml(contract.partyA.name)}　<strong>使用权范围：</strong>${escapeHtml(contract.partyA.licenseScope)}</p><p><strong>法定代表人：</strong>${escapeHtml(contract.partyA.legalRepresentative || blankLabel("partyALegalRepresentative"))}　<strong>甲方代表：</strong>${escapeHtml(contract.partyA.representative || blankLabel("partyARepresentative"))}</p><p><strong>地址：</strong>${escapeHtml(contract.partyA.address || blankLabel("partyAAddress"))}　<strong>邮编：</strong>${escapeHtml(contract.partyA.zip || blankLabel("partyAZip"))}　<strong>电话：</strong>${escapeHtml(contract.partyA.phone || blankLabel("partyAPhone"))}</p><p><strong>签订地点 / 日期：</strong>${escapeHtml(contract.manual.signLocation)} / ${escapeHtml(contract.manual.signDate)}</p><p><strong>当前过程备注：</strong>${escapeHtml(contract.signingNotes.value || "无")}${contract.signingNotes.updatedBy ? ` <small>· ${escapeHtml(contract.signingNotes.updatedBy.displayName)} 更新于 ${formatTime(contract.signingNotes.updatedAt)}</small>` : ""}</p>${generatedNote ? `<p><strong>生成时锁定备注：</strong>${escapeHtml(generatedNote.value || "无")}<small> · 此快照不随生成后的过程备注修改</small></p>` : ""}</div></section><section class="detail-section"><div class="card-head"><h2>模板固定正文</h2><span class="tag">只读</span></div><div class="card-body"><p>${escapeHtml(contract.fixedTerms.message)}</p><small>模板版本 ${escapeHtml(contract.template.version)} · 固定正文指纹 ${escapeHtml((contract.template.fixedFingerprint || "").slice(0, 16))}…</small></div></section><section class="detail-section"><div class="card-head"><h2>归档文件</h2>${canWrite && ["GENERATED", "SIGNING"].includes(contract.status) ? `<button class="button small" data-contract-archive="${contract.id}">上传外部版 / 最终版</button>` : ""}</div>${contract.files.length ? `<ul class="list">${contract.files.map(file => `<li><div><strong>${escapeHtml(displayEnum(file.category, contractFileLabels, "其他合同文件"))} · ${escapeHtml(file.originalName)}</strong><small>${formatTime(file.createdAt)} · SHA-256 ${escapeHtml(file.sha256.slice(0, 16))}…${file.declaredScopeChanged ? " · 已声明关键字段发生变化" : ""}</small></div><button class="button small" data-contract-download="${file.id}">下载</button></li>`).join("")}</ul>` : `<div class="empty">尚未生成或归档文件</div>`}</section>${statusSuggestion}${canWrite && contract.status === "DRAFT" ? `<div class="notice warning section-gap">生成前将重新校验模板、终审快照、合同编号、逐项确认、金额、大写、维护费及附件一一致性。</div><button class="button primary" data-contract-generate="${contract.id}">生成并归档系统原始 Word</button>` : ""}`, { extraWide: true });
}

function openContractStatusConfirmation(contractId, customerName) {
  openDialog("确认同步客户状态", `<div class="notice warning">本操作会把 <strong>${escapeHtml(customerName)}</strong> 的客户状态更新为“合同签订完成”并记录操作人、合同和前后状态；合同归档本身不会自动触发该修改。</div><label><input id="contract-status-confirmed" type="checkbox" /> 我已核对最终签订版，确认更新客户状态</label>`, {
    submitLabel: "确认更新",
    onSubmit: async () => {
      if (!document.querySelector("#contract-status-confirmed").checked) throw new Error("请先勾选明确确认");
      await api(`/api/contracts/${contractId}/confirm-customer-status`, { method: "POST", body: JSON.stringify({ confirmed: true }) });
      closeDialog(); showToast("客户状态已更新并留痕"); await go("contracts"); await openContractDetail(contractId);
    }
  });
}

async function openContractEditDialog(contractId) {
  const contract = await api(`/api/contracts/${contractId}`);
  const confirmationFields = [
    ["partyAName", "甲方完整法定名称"], ["licenseScope", "使用权范围"], ["partyALegalRepresentative", "法定代表人（可确认留空）"],
    ["partyARepresentative", "甲方代表（可确认留空）"], ["partyAZip", "邮编（可确认留空）"], ["partyAAddress", "地址（可确认留空）"],
    ["partyAPhone", "电话（可确认留空）"], ["contractNumber", "合同编号"], ["signLocation", "签订地点"], ["signDate", "签订日期"]
  ];
  const collectContractDraft = ({ includeConfirmations = false } = {}) => ({
    contractNumber: document.querySelector("#contract-edit-number").value,
    signedLocation: document.querySelector("#contract-edit-location").value,
    signedOn: document.querySelector("#contract-edit-date").value,
    signingNotes: document.querySelector("#contract-edit-notes").value,
    partyA: {
      name: contract.customer.name,
      licenseScope: contract.customer.name,
      legalRepresentative: document.querySelector("#contract-edit-legal-rep").value,
      representative: document.querySelector("#contract-edit-rep").value,
      zip: document.querySelector("#contract-edit-zip").value,
      address: document.querySelector("#contract-edit-address").value,
      phone: document.querySelector("#contract-edit-phone").value
    },
    ...(includeConfirmations ? { confirmations: Object.fromEntries([...document.querySelectorAll("[data-contract-edit-confirm]")].map(box => [box.dataset.contractEditConfirm, box.checked])) } : {})
  });
  openDialog("修改合同人工字段", `<div class="notice">报价、模板、合同总价、维护费和附件一均已锁定，不在此页面修改。</div><div class="form-grid"><div class="field"><label class="required">合同编号</label><input id="contract-edit-number" value="${escapeHtml(contract.contractNumber)}" /></div><div class="field"><label class="required">签订地点</label><input id="contract-edit-location" value="${escapeHtml(contract.manual.signLocation)}" /></div><div class="field"><label class="required">签订日期</label><input id="contract-edit-date" type="date" value="${escapeHtml(contract.manual.signDate)}" /></div><div class="field"><label>法定代表人</label><input id="contract-edit-legal-rep" value="${escapeHtml(contract.partyA.legalRepresentative)}" /></div><div class="field"><label>甲方代表</label><input id="contract-edit-rep" value="${escapeHtml(contract.partyA.representative)}" /></div><div class="field"><label>邮编</label><input id="contract-edit-zip" value="${escapeHtml(contract.partyA.zip)}" /></div><div class="field full"><label>地址</label><input id="contract-edit-address" value="${escapeHtml(contract.partyA.address)}" /></div><div class="field full"><label>电话</label><input id="contract-edit-phone" value="${escapeHtml(contract.partyA.phone)}" /></div><div class="field full"><label>签约备注（不改变报价范围和金额）</label><textarea id="contract-edit-notes" maxlength="2000">${escapeHtml(contract.signingNotes.value)}</textarea></div></div><div class="notice">甲方完整法定名称及使用权范围：${escapeHtml(contract.customer.name)}</div><div class="contract-confirmations">${confirmationFields.map(([key, label]) => `<label><input type="checkbox" data-contract-edit-confirm="${key}" ${contract.confirmations[key] ? "checked" : ""} /> 已核对：${escapeHtml(label)}</label>`).join("")}</div>`, {
    wide: true,
    submitLabel: "保存人工确认",
    onSubmit: async () => {
      await activeDraftAutosave?.flush();
      await api(`/api/contracts/${contractId}`, { method: "PATCH", body: JSON.stringify({ ...collectContractDraft({ includeConfirmations: true }), expectedDraftEtag: activeDraftAutosave?.getState().etag }) });
      closeDialog(); showToast("人工字段和逐项确认已更新并留痕"); await openContractDetail(contractId);
    }
  });
  document.querySelector(".dialog-body").insertAdjacentHTML("afterbegin", `<div class="notice">人工文本字段会自动保存；逐项确认勾选只在点击“保存人工确认”后生效。　<span id="draft-autosave-status" class="draft-save-status" aria-live="polite"></span></div>`);
  startDialogAutosave({
    root: document.querySelector(".dialog"),
    initialEtag: contract.draftEtag,
    initialSavedAt: contract.draftSavedAt || contract.updatedAt,
    collect: () => collectContractDraft(),
    save: payload => api(`/api/contracts/${contractId}`, { method: "PATCH", body: JSON.stringify(payload) }),
    shouldTrack: target => !target.closest("[data-contract-edit-confirm]")
  });
}

async function openContractNotesDialog(contractId) {
  const contract = await api(`/api/contracts/${contractId}`);
  openDialog("更新签约过程备注", `<div class="notice">本次只更新生成后的过程备注和修改人、时间；系统原始 Word 中的生成时备注快照不会被反写。</div><div class="field"><label>当前过程备注</label><textarea id="contract-process-notes" maxlength="2000">${escapeHtml(contract.signingNotes.value)}</textarea></div>`, {
    submitLabel: "保存过程备注",
    onSubmit: async () => {
      await api(`/api/contracts/${contractId}/signing-notes`, { method: "PATCH", body: JSON.stringify({ notes: document.querySelector("#contract-process-notes").value }) });
      closeDialog(); showToast("过程备注已更新，生成时快照保持不变"); await openContractDetail(contractId);
    }
  });
}

function openContractArchiveDialog(contractId) {
  openDialog("归档外部修改版或最终签订版", `<div class="notice warning">如外部修改涉及金额、范围、数量、单价或税率，最终版会被服务端阻止，必须回报价创建新版本并重新完成三级审批。</div><div class="field"><label class="required">归档类型</label><select id="contract-file-category"><option value="WORD_EDITED">外部修改版 Word</option><option value="FINAL_SIGNED">最终签订版 Word / PDF</option></select></div><div class="field"><label class="required">选择文件（不超过 20 MB）</label><input id="contract-file" type="file" accept=".docx,.pdf" /></div><div class="contract-confirmations"><strong>逐项声明是否发生变化：</strong>${[["amount", "金额"], ["scope", "范围"], ["quantity", "数量"], ["unitPrice", "单价"], ["taxRate", "税率"]].map(([key, label]) => `<label><input type="checkbox" data-contract-change="${key}" /> 涉及${label}变化</label>`).join("")}</div><div class="field section-gap"><label>说明</label><textarea id="contract-file-note"></textarea></div><label><input id="contract-change-confirm" type="checkbox" /> 我已逐项核对并确认以上声明真实完整</label>`, {
    wide: true,
    submitLabel: "上传归档",
    onSubmit: async () => {
      const file = document.querySelector("#contract-file").files[0];
      if (!file) throw new Error("请选择归档文件");
      const form = new FormData();
      form.append("file", file);
      form.append("category", document.querySelector("#contract-file-category").value);
      form.append("confirmed", document.querySelector("#contract-change-confirm").checked);
      form.append("note", document.querySelector("#contract-file-note").value);
      document.querySelectorAll("[data-contract-change]").forEach(box => form.append(box.dataset.contractChange, box.checked));
      await api(`/api/contracts/${contractId}/files`, { method: "POST", body: form });
      closeDialog(); showToast("合同文件已独立归档并留痕"); await go("contracts"); await openContractDetail(contractId);
    }
  });
}

function openContractTemplateUploadDialog() {
  openDialog("上传合同模板", `<div class="notice warning">只接受无未接受修订、无批注且包含全部白名单变量和附件一锚点的 DOCX。校验通过后仍需单独发布，已发布版本不可覆盖。</div><div class="field"><label class="required">版本号</label><input id="contract-template-version" maxlength="50" placeholder="例如：MES-2026.1" /></div><div class="field"><label class="required">原始 DOCX（不超过 20 MB）</label><input id="contract-template-file" type="file" accept=".docx" /></div>`, {
    submitLabel: "上传并校验",
    onSubmit: async () => {
      const file = document.querySelector("#contract-template-file").files[0];
      if (!file) throw new Error("请选择 DOCX 模板");
      const form = new FormData();
      form.append("version", document.querySelector("#contract-template-version").value);
      form.append("file", file);
      const template = await api("/api/contract-templates/upload", { method: "POST", body: form });
      closeDialog(); showToast(template.status === "VALIDATED" ? "模板校验通过，待管理员发布" : "模板已留档但校验未通过，不能发布"); await go("contracts");
    }
  });
}

function sopBody(body) {
  return escapeHtml(body).replace(/\n/g, "<br>");
}

function splitSopTags(value) {
  return value.split(/[、,，\n]/).map(item => item.trim()).filter(Boolean);
}

async function renderSop(content) {
  const filters = state.sopFilters;
  const params = new URLSearchParams();
  if (filters.role) params.set("role", filters.role);
  if (filters.stage) params.set("stage", filters.stage);
  if (filters.query) params.set("q", filters.query);
  const [result, options] = await Promise.all([api(`/api/sop?${params}`), api("/api/sop/filters")]);
  content.innerHTML = `${pageHead("岗位职责与售前 SOP", "按岗位、阶段和关键词查询；已发布历史版本只增不改", `${state.user.role === "ADMIN" ? `<button class="button primary" data-action="new-sop">+ 新建知识条目</button>` : ""}`)}
    <div class="toolbar sop-toolbar"><select id="sop-role"><option value="">全部岗位</option>${options.roles.map(item => `<option${filters.role === item ? " selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select><select id="sop-stage"><option value="">全部阶段</option>${options.stages.map(item => `<option${filters.stage === item ? " selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select><input id="sop-query" value="${escapeHtml(filters.query)}" placeholder="搜索职责、交付物或规则" /><button class="button primary" data-action="search-sop">查询</button><button class="button" data-action="reset-sop">重置</button></div>
    <div class="sop-grid">${result.items.map(item => `<article class="card sop-card"><div class="card-head"><div><h2>${escapeHtml(item.title)}</h2><small>${escapeHtml(item.code)}</small></div><span class="tag green">v${escapeHtml(item.versionNumber)}</span></div><div class="card-body"><div class="sop-tags">${item.roles.map(role => `<span class="tag">岗位：${escapeHtml(role)}</span>`).join("")}${item.stages.map(stage => `<span class="tag orange">阶段：${escapeHtml(stage)}</span>`).join("")}</div><p>${escapeHtml(item.body.split("\n").find(line => line.trim()) || "")}</p><small>发布时间：${formatTime(item.publishedAt)} · ${escapeHtml(item.updateSummary)}</small><div class="actions section-gap"><button class="button small primary" data-sop-open="${item.documentId}">查看正文</button><button class="button small" data-sop-history="${item.documentId}">历史版本</button>${state.user.role === "ADMIN" ? `<button class="button small" data-sop-publish="${item.documentId}">发布新版本</button>` : ""}</div></div></article>`).join("")}</div>${result.items.length ? "" : `<div class="empty">当前筛选条件下没有 SOP 内容</div>`}`;
}

async function openSopDetail(documentId) {
  const item = await api(`/api/sop/${documentId}`);
  openDialog("查看 SOP", `<p><strong>${escapeHtml(item.title)}</strong> · v${escapeHtml(item.versionNumber)}</p><div class="sop-tags">${item.roles.map(role => `<span class="tag">岗位：${escapeHtml(role)}</span>`).join("")}${item.stages.map(stage => `<span class="tag orange">阶段：${escapeHtml(stage)}</span>`).join("")}</div><div class="notice"><strong>发布时间：</strong>${formatTime(item.publishedAt)}　<strong>发布人：</strong>${escapeHtml(item.publishedBy?.displayName || "系统预置")}<br><strong>更新说明：</strong>${escapeHtml(item.updateSummary)}</div><div class="sop-body">${sopBody(item.body)}</div>`, { extraWide: true });
}

async function openSopHistory(documentId) {
  const result = await api(`/api/sop/${documentId}/versions`);
  openDialog("查看 SOP 历史", `<div class="notice">历史发布内容不可覆盖；展开版本可查看当时的完整正文。</div><div class="sop-history">${result.items.map(item => `<details${item.current ? " open" : ""}><summary><strong>v${escapeHtml(item.versionNumber)} · ${escapeHtml(item.title)}</strong><span>${formatTime(item.publishedAt)} · ${escapeHtml(item.publishedBy?.displayName || "系统预置")}${item.current ? " · 当前版本" : ""}</span></summary><p><strong>更新说明：</strong>${escapeHtml(item.updateSummary)}</p><div class="sop-body">${sopBody(item.body)}</div></details>`).join("")}</div>`, { extraWide: true });
}

async function openSopEditor(documentId = null) {
  const current = documentId ? await api(`/api/sop/${documentId}`) : null;
  openDialog(current ? "发布 SOP 新版本" : "新建 SOP 知识条目", `<div class="notice warning">发布后形成不可覆盖的独立版本；后续修改必须再次发布新版本。</div><div class="form-grid"><div class="field"><label class="required">版本号</label><input id="sop-version" placeholder="例如：1.1" /></div><div class="field"><label class="required">标题</label><input id="sop-title" maxlength="200" value="${escapeHtml(current?.title || "")}" /></div><div class="field"><label class="required">岗位（顿号分隔）</label><input id="sop-roles" value="${escapeHtml(current?.roles.join("、") || "")}" /></div><div class="field"><label class="required">阶段（顿号分隔）</label><input id="sop-stages" value="${escapeHtml(current?.stages.join("、") || "")}" /></div><div class="field full"><label>关键词（顿号分隔）</label><input id="sop-keywords" value="${escapeHtml(current?.keywords.join("、") || "")}" /></div><div class="field full"><label class="required">更新说明</label><input id="sop-summary" maxlength="500" /></div><div class="field full"><label class="required">正文（纯文本）</label><textarea id="sop-body" class="sop-editor-body">${escapeHtml(current?.body || "")}</textarea></div></div>`, {
    extraWide: true,
    submitLabel: "发布版本",
    onSubmit: async () => {
      const body = JSON.stringify({ versionNumber: document.querySelector("#sop-version").value, title: document.querySelector("#sop-title").value, roles: splitSopTags(document.querySelector("#sop-roles").value), stages: splitSopTags(document.querySelector("#sop-stages").value), keywords: splitSopTags(document.querySelector("#sop-keywords").value), updateSummary: document.querySelector("#sop-summary").value, body: document.querySelector("#sop-body").value });
      await api(documentId ? `/api/sop/${documentId}/versions` : "/api/sop", { method: "POST", body });
      closeDialog(); showToast("SOP 新版本已发布，历史版本保持不变"); await go("sop");
    }
  });
}

async function renderSettings(content) {
  if (state.user?.role !== "ADMIN" || state.user.mustChangePassword) return;
  const requestedUserId = state.user.id;
  const [result, dictionaries, candidates, templates, backupStatus] = await Promise.all([api("/api/users"), api("/api/customer-dictionaries?includeDisabled=true"), api("/api/customer-dictionaries/candidates"), isCoreLaunch() ? Promise.resolve({ items: [] }) : api("/api/admin/survey-templates"), api("/api/admin/backup-status").catch(() => null)]);
  if (state.user?.id !== requestedUserId || state.user.role !== "ADMIN" || state.user.mustChangePassword || state.page !== "settings" || !content.isConnected) return;
  state.users = result.items;
  state.dictionaryOptions = dictionaries.items;
  state.dictionaryCandidates = candidates.items;
  state.surveyTemplates = templates.items;
  content.innerHTML = `${pageHead("系统设置", "管理员创建独立账号；仓库和页面不保存或回显密码", `<button class="button primary" data-action="new-user">+ 创建用户</button>`)}
    ${backupStatusSection(backupStatus)}
    ${isCoreLaunch() ? "" : surveyTemplateSettingsSection()}
    <div class="card table-wrap section-gap"><div class="card-head"><h2>账号与直属综合部经理</h2></div><table><thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>当前直属综合部经理</th><th>状态</th><th>操作</th></tr></thead><tbody>${result.items.map(user => `<tr><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.displayName)}</td><td>${escapeHtml(roleLabel(user))}</td><td>${escapeHtml(result.items.find(manager => manager.id === user.managerId)?.displayName || "—")}</td><td><span class="tag ${user.active ? "green" : "red"}">${user.active ? "启用" : "停用"}</span></td><td><div class="actions"><button class="button small" data-user-reset="${user.id}">重置密码</button>${user.role === "PRESALES" ? `<button class="button small" data-user-manager="${user.id}">变更综合部经理</button><button class="button small" data-user-history="${user.id}">负责人历史</button>` : ""}<button class="button small ${user.active ? "danger" : ""}" data-user-status="${user.id}" data-active="${user.active ? "false" : "true"}">${user.active ? "停用" : "启用"}</button></div></td></tr>`).join("")}</tbody></table></div>${dictionarySettingsSection()}`;
}

function surveyTemplateSettingsSection() {
  const rows = state.surveyTemplates.map(template => `<tr><td><strong>${escapeHtml(template.name)}</strong><small>${escapeHtml(template.code)} · ${escapeHtml(template.version)}</small></td><td>${template.moduleCount} 个模块<br><small>${template.questionCount} 个问题</small></td><td>${template.tableCount} 张</td><td><span class="tag ${template.status === "PUBLISHED" ? "green" : "orange"}">${template.status === "PUBLISHED" ? "已发布" : "草稿"}</span><br><small>${template.usageCount} 份调研使用</small></td><td><div class="actions"><button class="button small" data-survey-template-preview="${template.id}">预览</button>${template.status === "DRAFT" ? `<button class="button small" data-survey-template-edit="${template.id}">编辑草稿</button><button class="button small primary" data-survey-template-publish="${template.id}">发布</button>` : `<button class="button small" data-survey-template-copy="${template.id}">复制为新版本</button>`}</div></td></tr>`).join("");
  return `<section class="card section-gap survey-template-settings"><div class="card-head"><div><h2>调研模板管理</h2><small>管理员维护 · 发布后不可覆盖</small></div><button class="button small primary" data-action="new-survey-template">+ 新建模板</button></div><div class="notice">后续新增软件类型或调整问题时，请新建草稿或复制已有模板为新版本。发布后可用于创建调研；历史报告始终保留原模板版本。</div><div class="table-wrap"><table><thead><tr><th>模板</th><th>问题结构</th><th>专项清单</th><th>状态 / 使用</th><th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="5">暂无调研模板</td></tr>`}</tbody></table></div></section>`;
}

function openSurveyTemplateCreateDialog(baseTemplateId = "") {
  const base = state.surveyTemplates.find(item => item.id === baseTemplateId);
  openDialog(base ? "复制为调研模板新版本" : "新建调研模板", `<div class="notice">建议复制相近的已发布模板，再修改问题和专项清单。新建内容先保存为草稿，发布前可反复调整。</div><div class="form-grid"><div class="field"><label class="required">模板编码</label><input id="survey-template-code" maxlength="60" value="${escapeHtml(base?.code || "")}" placeholder="例如 WMS-PRESALES-SURVEY" /></div><div class="field"><label class="required">版本号</label><input id="survey-template-version" maxlength="30" placeholder="例如 A/0 或 1.0" /></div><div class="field full"><label class="required">模板名称</label><input id="survey-template-name" maxlength="160" value="${escapeHtml(base?.name || "")}" placeholder="例如 WMS 项目售前调研记录表" /></div><div class="field full"><label>复制已有模板</label><select id="survey-template-base"><option value="">不复制，从基础空白模板开始</option>${state.surveyTemplates.map(item => `<option value="${item.id}"${item.id === baseTemplateId ? " selected" : ""}>${escapeHtml(item.name)} · ${escapeHtml(item.version)} · ${item.status === "PUBLISHED" ? "已发布" : "草稿"}</option>`).join("")}</select><small>只复制模板结构，不复制任何客户调研内容或附件。</small></div></div>`, {
    wide: true,
    submitLabel: "创建草稿并编辑",
    onSubmit: async () => {
      const created = await api("/api/admin/survey-templates", { method: "POST", body: JSON.stringify({ code: document.querySelector("#survey-template-code").value, version: document.querySelector("#survey-template-version").value, name: document.querySelector("#survey-template-name").value, baseTemplateId: document.querySelector("#survey-template-base").value || null }) });
      closeDialog();
      state.surveyTemplates.unshift(created);
      await openSurveyTemplateEditor(created.id);
    }
  });
}

function surveyTemplateQuestionEditor(question = {}, index = 0) {
  const id = question.id || `question-${crypto.randomUUID()}`;
  return `<article class="survey-template-question" data-template-question data-key="${escapeHtml(id)}"><header><strong data-template-question-number>问题 ${index + 1}</strong><button class="button small danger" type="button" data-template-remove-question>删除问题</button></header><div class="field"><label class="required">问题内容</label><textarea data-template-question-prompt rows="3" placeholder="填写需要向客户了解的问题">${escapeHtml(question.prompt || "")}</textarea></div><div class="field"><label>填写提示</label><textarea data-template-question-help rows="2" placeholder="帮助售前理解填写口径">${escapeHtml(question.help || "")}</textarea></div><label class="template-inline-check"><input type="checkbox" data-template-question-required ${question.required ? "checked" : ""} /> 必填问题</label></article>`;
}

function surveyTemplateModuleEditor(module = {}, index = 0) {
  const key = module.key || `module-${crypto.randomUUID()}`;
  const questions = module.questions?.length ? module.questions : [{ id: `question-${crypto.randomUUID()}`, prompt: "", help: "", required: true }];
  return `<details class="survey-template-block" data-template-module data-key="${escapeHtml(key)}" open><summary><span><strong data-template-module-number>模块 ${index + 1}</strong><small>问题分组</small></span><span class="tag">${questions.length} 个问题</span></summary><div class="survey-template-block-body"><div class="form-grid"><div class="field"><label class="required">模块名称</label><input data-template-module-name maxlength="120" value="${escapeHtml(module.name || "")}" /></div><div class="field"><label>模块说明</label><input data-template-module-description maxlength="1000" value="${escapeHtml(module.description || "")}" /></div></div><div class="survey-template-question-list">${questions.map((question, questionIndex) => surveyTemplateQuestionEditor(question, questionIndex)).join("")}</div><div class="actions"><button class="button small" type="button" data-template-add-question>+ 添加问题</button><button class="button small danger" type="button" data-template-remove-module>删除整个模块</button></div></div></details>`;
}

function surveyTemplateFieldEditor(field = {}, index = 0) {
  const key = field.key || `field-${crypto.randomUUID()}`;
  const type = field.type || "text";
  return `<article class="survey-template-field" data-template-field data-key="${escapeHtml(key)}"><header><strong data-template-field-number>字段 ${index + 1}</strong><button class="text-button danger-text" type="button" data-template-remove-field>删除</button></header><div class="survey-template-field-grid"><label>字段名称 *<input data-template-field-label maxlength="120" value="${escapeHtml(field.label || "")}" /></label><label>填写类型<select data-template-field-type><option value="text"${type === "text" ? " selected" : ""}>多行/文本</option><option value="number"${type === "number" ? " selected" : ""}>数字</option><option value="select"${type === "select" ? " selected" : ""}>下拉选择</option></select></label><label class="template-field-options${type === "select" ? "" : " is-hidden"}">下拉选项（顿号或换行分隔）<textarea data-template-field-options rows="2">${escapeHtml((field.options || []).join("、"))}</textarea></label><label class="template-inline-check"><input type="checkbox" data-template-field-required ${field.required ? "checked" : ""} /> 必填字段</label></div></article>`;
}

function surveyTemplateTableEditor(table = {}, index = 0) {
  const key = table.key || `table-${crypto.randomUUID()}`;
  const fields = table.fields?.length ? table.fields : [{ key: `field-${crypto.randomUUID()}`, label: "", type: "text", required: true }];
  return `<details class="survey-template-block" data-template-table data-key="${escapeHtml(key)}" open><summary><span><strong data-template-table-number>专项清单 ${index + 1}</strong><small>重复填写的结构化记录</small></span><span class="tag">${fields.length} 个字段</span></summary><div class="survey-template-block-body"><div class="form-grid"><div class="field"><label class="required">清单名称</label><input data-template-table-name maxlength="120" value="${escapeHtml(table.name || "")}" /></div><label class="template-inline-check template-table-required"><input type="checkbox" data-template-table-required ${table.requiredAtLeastOne ? "checked" : ""} /> 完成调研时至少填写一条</label></div><div class="survey-template-field-list">${fields.map((field, fieldIndex) => surveyTemplateFieldEditor(field, fieldIndex)).join("")}</div><div class="actions"><button class="button small" type="button" data-template-add-field>+ 添加字段</button><button class="button small danger" type="button" data-template-remove-table>删除整张清单</button></div></div></details>`;
}

function refreshSurveyTemplateEditorLabels(editor) {
  editor.querySelectorAll("[data-template-module]").forEach((module, index) => {
    module.querySelector("[data-template-module-number]").textContent = `模块 ${index + 1}`;
    module.querySelectorAll("[data-template-question]").forEach((question, questionIndex) => { question.querySelector("[data-template-question-number]").textContent = `问题 ${questionIndex + 1}`; });
    const count = module.querySelectorAll("[data-template-question]").length;
    module.querySelector(":scope > summary .tag").textContent = `${count} 个问题`;
  });
  editor.querySelectorAll("[data-template-table]").forEach((table, index) => {
    table.querySelector("[data-template-table-number]").textContent = `专项清单 ${index + 1}`;
    table.querySelectorAll("[data-template-field]").forEach((field, fieldIndex) => { field.querySelector("[data-template-field-number]").textContent = `字段 ${fieldIndex + 1}`; });
    const count = table.querySelectorAll("[data-template-field]").length;
    table.querySelector(":scope > summary .tag").textContent = `${count} 个字段`;
  });
}

function collectSurveyTemplateSchema(editor) {
  const modules = [...editor.querySelectorAll("[data-template-module]")].map(module => ({
    key: module.dataset.key,
    name: module.querySelector("[data-template-module-name]").value,
    description: module.querySelector("[data-template-module-description]").value,
    questions: [...module.querySelectorAll("[data-template-question]")].map(question => ({ id: question.dataset.key, prompt: question.querySelector("[data-template-question-prompt]").value, help: question.querySelector("[data-template-question-help]").value, required: question.querySelector("[data-template-question-required]").checked }))
  }));
  const tables = [...editor.querySelectorAll("[data-template-table]")].map(table => ({
    key: table.dataset.key,
    name: table.querySelector("[data-template-table-name]").value,
    requiredAtLeastOne: table.querySelector("[data-template-table-required]").checked,
    fields: [...table.querySelectorAll("[data-template-field]")].map(field => ({
      key: field.dataset.key,
      label: field.querySelector("[data-template-field-label]").value,
      type: field.querySelector("[data-template-field-type]").value,
      required: field.querySelector("[data-template-field-required]").checked,
      options: field.querySelector("[data-template-field-options]").value.split(/[、,，\n]/).map(value => value.trim()).filter(Boolean)
    }))
  }));
  return { modules, tables };
}

function bindSurveyTemplateEditor(editor) {
  editor.addEventListener("change", event => {
    const type = event.target.closest("[data-template-field-type]");
    if (type) type.closest("[data-template-field]").querySelector(".template-field-options").classList.toggle("is-hidden", type.value !== "select");
  });
  editor.addEventListener("click", async event => {
    const module = event.target.closest("[data-template-module]");
    const table = event.target.closest("[data-template-table]");
    if (event.target.closest("[data-template-add-question]")) module.querySelector(".survey-template-question-list").insertAdjacentHTML("beforeend", surveyTemplateQuestionEditor());
    if (event.target.closest("[data-template-add-field]")) table.querySelector(".survey-template-field-list").insertAdjacentHTML("beforeend", surveyTemplateFieldEditor());
    if (event.target.closest("[data-template-add-module]")) editor.querySelector(".survey-template-module-list").insertAdjacentHTML("beforeend", surveyTemplateModuleEditor());
    if (event.target.closest("[data-template-add-table]")) editor.querySelector(".survey-template-table-list").insertAdjacentHTML("beforeend", surveyTemplateTableEditor());
    if (event.target.closest("[data-template-remove-question]") && await confirmInApp({ title: "删除问题", message: "确认删除这个尚未发布的问题吗？", confirmLabel: "删除", danger: true })) event.target.closest("[data-template-question]").remove();
    if (event.target.closest("[data-template-remove-field]") && await confirmInApp({ title: "删除字段", message: "确认删除这个尚未发布的字段吗？", confirmLabel: "删除", danger: true })) event.target.closest("[data-template-field]").remove();
    if (event.target.closest("[data-template-remove-module]") && await confirmInApp({ title: "删除模块", message: "确认删除整个模块及其中的问题吗？", confirmLabel: "删除", danger: true })) module.remove();
    if (event.target.closest("[data-template-remove-table]") && await confirmInApp({ title: "删除专项清单", message: "确认删除整张专项清单及其中的字段吗？", confirmLabel: "删除", danger: true })) table.remove();
    refreshSurveyTemplateEditorLabels(editor);
  });
}

async function openSurveyTemplateEditor(templateId) {
  const template = await api(`/api/admin/survey-templates/${encodeURIComponent(templateId)}`);
  if (template.status !== "DRAFT") return openSurveyTemplatePreview(templateId);
  const modules = template.schema.modules || [];
  const tables = template.schema.tables || [];
  openDialog("编辑调研模板", `<div id="survey-template-editor" class="survey-template-editor"><div class="survey-template-editor-intro"><div class="form-grid"><div class="field"><label class="required">模板编码</label><input id="template-edit-code" value="${escapeHtml(template.code)}" /></div><div class="field"><label class="required">版本号</label><input id="template-edit-version" value="${escapeHtml(template.version)}" /></div><div class="field full"><label class="required">模板名称</label><input id="template-edit-name" value="${escapeHtml(template.name)}" /></div></div><div class="notice warning">当前为草稿。发布后内容永久锁定；后续调整需复制为新版本，历史调研不会被改变。</div></div><section class="survey-template-editor-section"><div class="survey-special-heading"><span>问题模块</span><button class="button small" type="button" data-template-add-module>+ 添加模块</button></div><div class="survey-template-module-list">${modules.map((module, index) => surveyTemplateModuleEditor(module, index)).join("")}</div></section><section class="survey-template-editor-section"><div class="survey-special-heading"><span>专项清单</span><button class="button small" type="button" data-template-add-table>+ 添加专项清单</button></div><div class="survey-template-table-list">${tables.map((table, index) => surveyTemplateTableEditor(table, index)).join("")}</div></section></div>`, {
    extraWide: true,
    dialogClass: "survey-template-editor-dialog",
    submitLabel: "保存草稿",
    onSubmit: async () => {
      const editor = document.querySelector("#survey-template-editor");
      await api(`/api/admin/survey-templates/${encodeURIComponent(templateId)}`, { method: "PATCH", body: JSON.stringify({ code: document.querySelector("#template-edit-code").value, version: document.querySelector("#template-edit-version").value, name: document.querySelector("#template-edit-name").value, schema: collectSurveyTemplateSchema(editor) }) });
      closeDialog(); showToast("调研模板草稿已保存"); await go("settings");
    }
  });
  const editor = document.querySelector("#survey-template-editor");
  bindSurveyTemplateEditor(editor);
  refreshSurveyTemplateEditorLabels(editor);
}

async function openSurveyTemplatePreview(templateId) {
  const template = await api(`/api/admin/survey-templates/${encodeURIComponent(templateId)}`);
  const modules = (template.schema.modules || []).map((module, index) => `<details class="survey-template-preview-block" open><summary>${index + 1}. ${escapeHtml(module.name)} <span>${module.questions.length} 题</span></summary><ol>${module.questions.map(question => `<li><strong>${escapeHtml(question.prompt || "未填写问题内容")}</strong>${question.required ? `<span class="tag orange">必填</span>` : ""}${question.help ? `<small>${escapeHtml(question.help)}</small>` : ""}</li>`).join("")}</ol></details>`).join("");
  const tables = (template.schema.tables || []).map(table => `<div class="survey-template-preview-table"><strong>${escapeHtml(table.name || "未命名清单")}</strong><small>${table.requiredAtLeastOne ? "至少一条 · " : ""}${table.fields.map(field => `${escapeHtml(field.label || "未命名字段")}（${field.type === "select" ? "下拉" : field.type === "number" ? "数字" : "文本"}${field.required ? "，必填" : ""}）`).join("、")}</small></div>`).join("");
  openDialog("查看调研模板", `<p><strong>${escapeHtml(template.name)}</strong> · ${escapeHtml(template.version)}</p><div class="notice">${template.status === "PUBLISHED" ? "该版本已经发布并锁定，可用于新建调研。" : "该版本仍是草稿，发布前可以继续编辑。"}</div><div class="grid-4 template-preview-metrics"><div class="metric"><span>模块</span><strong>${template.moduleCount}</strong></div><div class="metric"><span>问题</span><strong>${template.questionCount}</strong></div><div class="metric"><span>专项清单</span><strong>${template.tableCount}</strong></div><div class="metric"><span>已使用</span><strong>${template.usageCount}</strong></div></div><h3>问题模块</h3>${modules || `<div class="empty">尚未添加问题模块</div>`}<h3>专项清单</h3>${tables || `<div class="empty">未设置专项清单</div>`}`, { extraWide: true });
}

function openSurveyTemplatePublishDialog(templateId) {
  const template = state.surveyTemplates.find(item => item.id === templateId);
  openDialog("发布调研模板", `<div class="notice warning">发布后模板将进入新建调研的可选列表，并且不能直接修改或覆盖。后续调整必须复制为新版本。</div><p><strong>${escapeHtml(template?.name || "调研模板")} · ${escapeHtml(template?.version || "")}</strong></p><p>${template?.moduleCount || 0} 个模块、${template?.questionCount || 0} 个问题、${template?.tableCount || 0} 张专项清单</p>`, {
    submitLabel: "确认发布并锁定",
    onSubmit: async () => {
      await api(`/api/admin/survey-templates/${encodeURIComponent(templateId)}/publish`, { method: "POST", body: "{}" });
      closeDialog(); showToast("调研模板已发布，历史版本保持不变"); await go("settings");
    }
  });
}

function backupStatusSection(status) {
  const title = `<div class="card-head"><h2>备份运行状态</h2><span class="tag">仅管理员 · 只读</span></div>`;
  if (!status) return `<section class="card section-gap">${title}<div class="notice warning" role="status">备份运行状态无法确认，请联系运维核验；此状态不表示备份成功。重新进入系统设置可重试。</div></section>`;
  const schedulerLabels = { NOT_STARTED: "尚未启动", SCHEDULED: "已安排每日备份", RUNNING: "正在执行", STOPPED: "已停止", FAILED: "调度失败", UNCONFIRMED: "上次调度未确认，需核验", OVERDUE: "计划时间已过，尚未确认执行" };
  const kindLabel = kind => kind === "MANUAL" ? "手工备份" : kind === "AUTOMATIC" ? "每日备份" : "备份调度";
  const success = status.lastSuccess;
  const failure = status.lastFailure;
  const newerFailure = failure && (!success || failure.failedAt >= success.completedAt);
  const attention = status.freshness !== "CURRENT" || status.storageFailure || status.incompleteCount || newerFailure || ["FAILED", "UNCONFIRMED", "OVERDUE", "STOPPED", "NOT_STARTED"].includes(status.scheduler.status);
  const freshness = status.freshness === "CURRENT" ? "最近成功在 24 小时内" : status.freshness === "OVERDUE" ? "最近成功已超过 24 小时，请核验是否漏跑" : "尚无已确认成功的备份";
  return `<section class="card section-gap">${title}<div class="notice ${attention ? "warning" : ""}">${newerFailure ? "最近一次失败晚于最近成功，请先核验失败原因。" : ""}${freshness}。记录仅表示当时已完成校验，不保证文件当前仍完整；恢复前须重新校验备份清单，不能代替隔离恢复演练或上线验收。</div>
    <ul class="list"><li><div><strong>最近成功</strong>${success ? `<small>${kindLabel(success.kind)} · 批次 ${escapeHtml(success.batchId)}<br>实际完成 ${formatTime(success.completedAt)}<br>数据库检查通过 · 外键异常 ${success.validation.foreignKeyErrors} · 文件已校验 ${success.validation.filesVerified} 个（业务引用 ${success.validation.referencedFiles} 个）</small>` : `<small>无已确认成功记录</small>`}</div></li>
    <li><div><strong>最近失败</strong>${failure ? `<small>${kindLabel(failure.kind)} · ${formatTime(failure.failedAt)} · 安全错误码 ${escapeHtml(failure.code)}</small>` : `<small>暂无已记录失败；不代表备份已经成功</small>`}</div></li>
    <li><div><strong>当前调度：${escapeHtml(schedulerLabels[status.scheduler.status] || "状态不确定")}</strong><small>下次计划 ${status.scheduler.nextRunAt ? formatTime(status.scheduler.nextRunAt) : "尚无计划时间"}</small></div></li>
    <li><div><strong>未确认完成：${status.incompleteCount} 项</strong><small>${status.incompleteRuns.map(run => `${kindLabel(run.kind)} · 开始 ${formatTime(run.startedAt)} · ${run.status === "RUNNING" ? "当前进程运行中" : "未确认完成（可能仍在其他进程执行或已中断）"}`).join("<br>") || "暂无未完成记录"}${status.incompleteCount > status.incompleteRuns.length ? "<br>仅显示最近 20 项，请联系运维核验历史未完成项" : ""}</small></div></li></ul>
    ${status.storageFailure ? `<div class="notice warning">状态记录曾失败：${formatTime(status.storageFailure.failedAt)} · ${escapeHtml(status.storageFailure.code)}。不能据此确认该次备份成功。</div>` : ""}
    <small>查询于 ${formatTime(status.checkedAt)}；时间按当前浏览器时区 ${escapeHtml(Intl.DateTimeFormat().resolvedOptions().timeZone)} 显示，每日计划按服务器本地时间安排。重新进入系统设置可刷新。本页不提供备份、恢复或删除操作。</small></section>`;
}

function dictionarySettingsSection() {
  const kindLabel = kind => kind === "SOURCE" ? "客户来源" : "客户类型";
  return `<section class="card section-gap"><div class="card-head"><h2>客户来源 / 类型字典</h2><button class="button small" data-action="new-dictionary">新增字典项</button></div><div class="notice">正常新增/更改只能选择启用项。已使用文本保持稳定，可停用后新增，不联动修改历史主档、导入原值或快照。</div><ul class="list">${state.dictionaryOptions.map(item => `<li><div><strong>${kindLabel(item.kind)} · ${escapeHtml(item.value)}</strong><small>${item.active ? "启用" : "停用"} · ${item.used ? "已使用，不可删除/改写值" : "尚未使用"}</small></div><div class="actions"><button class="button small" data-dictionary-edit="${item.id}">维护</button>${item.used ? "" : `<button class="button small danger" data-dictionary-delete="${item.id}">删除未使用项</button>`}</div></li>`).join("") || `<li>暂无字典项，请由管理员确认后新增。</li>`}</ul></section><section class="card section-gap"><div class="card-head"><h2>历史原值候选与使用情况（仅管理员）</h2></div><div class="notice">按原文精确汇总，不合并相似词。统计为主档数、源行数和字段审计出现次数，不提供其他客户的名称、行号或负责人。</div><div class="table-wrap"><table><thead><tr><th>类型 / 原始值</th><th>当前主档数</th><th>导入源行数</th><th>审计出现次数</th><th>状态</th></tr></thead><tbody>${state.dictionaryCandidates.map((item, index) => `<tr><td>${kindLabel(item.kind)} · <code>${escapeHtml(JSON.stringify(item.value))}</code></td><td>${item.customerCount}</td><td>${item.importRowCount}</td><td>${item.auditValueCount}</td><td>${item.state === "PENDING" ? `<button class="button small" data-dictionary-candidate="${index}">确认并新增启用项</button>` : item.state === "ENABLED" ? "已启用" : "已停用"}</td></tr>`).join("") || `<tr><td colspan="5">暂无历史原值</td></tr>`}</tbody></table></div></section>`;
}

function openDictionaryDialog(id = null, candidateIndex = null) {
  const item = id ? state.dictionaryOptions.find(item => item.id === id) : null;
  const candidate = candidateIndex === null ? null : state.dictionaryCandidates[candidateIndex];
  const value = item?.value ?? candidate?.value ?? "";
  const kind = item?.kind || candidate?.kind || "SOURCE";
  openDialog(item ? "维护客户字典" : "新增并启用客户字典", `<div class="field"><label>字典类型</label><select id="dictionary-kind" ${item ? "disabled" : ""}><option value="SOURCE"${kind === "SOURCE" ? " selected" : ""}>客户来源</option><option value="TYPE"${kind === "TYPE" ? " selected" : ""}>客户类型</option></select></div><div class="field"><label class="required">字典原值</label><input id="dictionary-value" value="${escapeHtml(value)}" ${item?.used ? "readonly" : ""} /></div>${item ? `<div class="field"><label><input id="dictionary-active" type="checkbox"${item.active ? " checked" : ""} /> 启用</label></div>` : ""}`, {
    onSubmit: async () => {
      await api(item ? `/api/customer-dictionaries/${item.id}` : "/api/customer-dictionaries", { method: item ? "PATCH" : "POST", body: JSON.stringify({ kind: document.querySelector("#dictionary-kind").value, value: document.querySelector("#dictionary-value").value, ...(item ? { active: document.querySelector("#dictionary-active").checked } : {}) }) });
      closeDialog(); await go("settings");
    }
  });
}

function customerDictionaryField(id, label, kind, options, current = null, required = false) {
  const items = options.filter(item => item.kind === kind);
  const legacy = current && !items.some(item => item.value === current);
  return `<div class="field"><label${required ? ' class="required"' : ""}>${label}</label><select id="${id}"><option value="">${required ? "请选择" : "未选择"}</option>${legacy ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}（历史/停用值，仅可原样保留）</option>` : ""}${items.map(item => `<option value="${escapeHtml(item.value)}"${item.value === current ? " selected" : ""}>${escapeHtml(item.value)}</option>`).join("")}</select></div>`;
}

function openDialog(title, body, { submitLabel = "保存", wide = false, extraWide = false, dialogClass = "", replace = false, onSubmit } = {}) {
  if (dialogRoot.firstElementChild) {
    if (replace) {
      activeDraftAutosave?.dispose();
      disposeInlinePdfViewers(dialogRoot);
      dialogRoot.replaceChildren();
    } else {
      activeDraftAutosave?.suspend();
      dialogStack.push({ element: dialogRoot.firstElementChild, autosave: activeDraftAutosave, focus: document.activeElement });
      dialogRoot.replaceChildren();
    }
  }
  activeDraftAutosave = null;
  const safeDialogClass = String(dialogClass).split(/\s+/).filter(item => /^[a-z0-9-]+$/i.test(item)).join(" ");
  dialogRoot.innerHTML = `<div class="dialog-backdrop"><section class="dialog ${wide ? "wide" : ""} ${extraWide ? "extra-wide" : ""} ${safeDialogClass}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><div class="dialog-head"><h2>${escapeHtml(title)}</h2><button class="dialog-close" data-action="close-dialog" aria-label="关闭">×</button></div><div class="dialog-body">${body}</div><div class="dialog-foot"><div class="form-error" id="dialog-error" role="alert"></div><button class="button" data-action="close-dialog">取消</button>${onSubmit ? `<button class="button primary" id="dialog-submit">${escapeHtml(submitLabel)}</button>` : ""}</div></section></div>`;
  const submitButton = document.querySelector("#dialog-submit");
  submitButton?.addEventListener("click", async () => {
    if (submitButton.disabled) return;
    const errorEl = document.querySelector("#dialog-error");
    errorEl.textContent = "";
    const originalLabel = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = "正在保存…";
    try {
      await onSubmit(errorEl);
    } catch (error) {
      errorEl.textContent = error.details?.map?.(item => item.message).join("；") || error.message;
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = originalLabel;
    }
  });
  setTimeout(() => document.querySelector(".dialog input, .dialog select, .dialog textarea")?.focus(), 0);
  initializeInlinePdfViewers(dialogRoot);
}

function closeDialog() {
  document.querySelector(".system-confirm-backdrop")?.remove();
  activeDraftAutosave?.dispose();
  activeDraftAutosave = null;
  disposeInlinePdfViewers(dialogRoot);
  dialogRoot.replaceChildren();
  const previous = dialogStack.pop();
  if (previous) {
    dialogRoot.append(previous.element);
    activeDraftAutosave = previous.autosave;
    activeDraftAutosave?.resume();
    if (previous.focus?.isConnected) previous.focus.focus({ preventScroll: true });
  }
}

function closeAllDialogs() {
  document.querySelector(".system-confirm-backdrop")?.remove();
  activeDraftAutosave?.dispose();
  activeDraftAutosave = null;
  disposeInlinePdfViewers(dialogRoot);
  for (const item of dialogStack) { item.autosave?.dispose(); disposeInlinePdfViewers(item.element); }
  dialogStack.length = 0;
  dialogRoot.replaceChildren();
}

async function openCustomerDialog({ initialName = "", onCreated = null, fromQuote = false } = {}) {
  const isPresales = state.user.role === "PRESALES";
  const users = isPresales ? [] : (await api("/api/assignable-users")).items;
  const ownerField = isPresales
    ? `<div class="field"><label>当前负责人</label><input value="${escapeHtml(state.user.displayName)}" readonly aria-label="当前负责人" /></div>`
    : `<div class="field"><label class="required">当前负责人</label><select id="customer-new-owner"><option value="">请选择售前负责人</option>${users.map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.displayName)}</option>`).join("")}</select></div>`;
  const dictionaryOptions = (await api("/api/customer-dictionaries")).items;
  const today = localDateTimeValue().slice(0, 10);
  openDialog("新增客户", `${fromQuote ? `<div class="notice">请先完善客户信息，保存后将返回报价单。</div>` : ""}<div class="form-grid"><div class="field full"><label class="required">客户全称</label><input id="customer-new-name" value="${escapeHtml(initialName)}" /></div><div class="field"><label>简称</label><input id="customer-new-short" /></div>${ownerField}<div class="field"><label class="required">登记时间</label><input id="customer-new-registered-on" type="date" value="${today}" /></div><div class="field"><label class="required">客户阶段</label><select id="customer-new-status"><option>初期接洽</option><option>现场调研</option><option>方案&报价</option><option>报价完成&商务洽谈</option><option>合同签订完成</option><option>丢标</option><option>中止</option></select></div>${customerDictionaryField("customer-new-source", "客户来源", "SOURCE", dictionaryOptions, null, true)}${customerDictionaryField("customer-new-type", "客户类型", "TYPE", dictionaryOptions, null, true)}<div class="field full"><label class="required">行业</label><input id="customer-new-industry" /></div>${chinaRegionFields({ provinceId: "customer-new-province", cityId: "customer-new-city", required: true })}<div class="field full"><label class="required">客户需求</label><textarea id="customer-new-need"></textarea></div></div>`, {
    submitLabel: "保存客户",
    onSubmit: async () => {
      const fields = [["customer-new-name", "客户全称"], ["customer-new-registered-on", "登记时间"], ["customer-new-status", "客户阶段"], ["customer-new-source", "客户来源"], ["customer-new-type", "客户类型"], ["customer-new-industry", "行业"], ["customer-new-province", "省份"], ["customer-new-city", "城市"], ["customer-new-need", "客户需求"]];
      const missing = fields.filter(([id]) => !document.querySelector(`#${id}`).value.trim()).map(([, label]) => label);
      const ownerId = isPresales ? state.user.id : document.querySelector("#customer-new-owner").value;
      if (!ownerId) missing.splice(1, 0, "当前负责人");
      if (missing.length) throw new Error(`请填写：${missing.join("、")}`);
      const customer = await api("/api/customers", { method: "POST", body: JSON.stringify({ fullName: document.querySelector("#customer-new-name").value, shortName: document.querySelector("#customer-new-short").value, ownerId, registeredOn: document.querySelector("#customer-new-registered-on").value, status: document.querySelector("#customer-new-status").value, source: document.querySelector("#customer-new-source").value, customerType: document.querySelector("#customer-new-type").value, industry: document.querySelector("#customer-new-industry").value, province: document.querySelector("#customer-new-province").value, city: document.querySelector("#customer-new-city").value, needSummary: document.querySelector("#customer-new-need").value }) });
      closeDialog();
      showToast("客户已保存");
      if (onCreated) { await onCreated(customer); return; }
      await go(state.page === "dashboard" ? "dashboard" : "customers");
    }
  });
  bindChinaRegionSelects("customer-new-province", "customer-new-city");
}

function openRegisteredOnDialog(customerId) {
  openDialog("补录客户登记时间", `<div class="notice">历史导入时缺失的日期会保持“日期未知”；本次补录将写入审计日志。</div><div class="field"><label class="required">登记时间</label><input id="customer-date-value" type="date" /></div>`, {
    submitLabel: "保存补录",
    onSubmit: async () => {
      await api(`/api/customers/${customerId}/registered-on`, { method: "PATCH", body: JSON.stringify({ registeredOn: document.querySelector("#customer-date-value").value }) });
      closeDialog();
      showToast("登记时间已补录并记录审计");
      await go("customers");
    }
  });
}

const followupMethodLabels = { PHONE: "电话", WECHAT: "微信", ONSITE: "现场", MEETING: "会议", EMAIL: "邮件", OTHER: "其他" };

function localDateTimeValue(date = new Date()) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

function auditSummaryText(log) {
  if (log.action === "CUSTOMER_STATUS_CHANGED") return `${log.summary.before || "—"} → ${log.summary.after || "—"}`;
  if (log.action === "CUSTOMER_UPDATED") return `变更字段：${(log.summary.changedFields || []).map(field => customerFieldLabels[field] || field).join("、") || "无"}`;
  if (log.summary.reason) return `原因：${log.summary.reason}`;
  if (log.summary.comment) return `意见：${log.summary.comment}`;
  if (log.summary.category) return `文件类别：${displayEnum(log.summary.category, { ...storedFileLabels, ...contractFileLabels }, "其他归档文件")}`;
  return "已由服务端记录";
}

function customerTabButton(key, label, count = null) {
  return `<button role="tab" aria-selected="false" data-customer-tab="${key}">${escapeHtml(label)}${count === null ? "" : `<span>${count}</span>`}</button>`;
}

function activateCustomerTab(key) {
  const dialog = document.querySelector(".customer-workspace");
  if (!dialog) return;
  const selected = dialog.querySelector(`[data-customer-tab="${key}"]`) ? key : "overview";
  dialog.querySelectorAll("[data-customer-tab]").forEach(button => {
    const active = button.dataset.customerTab === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  dialog.querySelectorAll("[data-customer-panel]").forEach(panel => { panel.hidden = panel.dataset.customerPanel !== selected; });
}

async function openCoreCustomerDetail(customerId, activeTab = "overview", { replace = false, workspace = null } = {}) {
  if (!workspace) {
    openDialog("查看客户档案", `<div class="empty" role="status">正在加载客户资料…</div>`, { extraWide: true, dialogClass: "customer-archive-dialog", replace });
    const loadingDialog = document.querySelector(".dialog");
    try {
      workspace = await api(`/api/customers/${customerId}/core-workspace`);
    } catch (error) {
      if (!loadingDialog.isConnected) return;
      state.customerWorkspace = null;
      openDialog("查看客户档案", `<div class="notice danger" role="alert">${escapeHtml(error.message)}</div><button class="button" data-customer-retry="${escapeHtml(customerId)}">重新加载</button>`, { extraWide: true, dialogClass: "customer-archive-dialog", replace: true });
      return;
    }
    if (!loadingDialog.isConnected) return;
  }
  state.customerWorkspace = workspace;
  const { customer, permissions, contacts, quotes } = workspace;
  const tabs = [["overview", "概览"], ["contacts", "联系人"], ["quotes", "报价"]];
  const tabCounts = { overview: null, contacts: contacts.length, quotes: quotes.length };
  const customerActions = `${permissions.canEditCustomer ? `<button class="button small" data-customer-edit="${customer.id}">编辑客户主档 / 阶段</button>` : ""}${permissions.canSupplementRegisteredOn ? `<button class="button small" data-customer-date="${customer.id}">补录登记时间</button>` : ""}`;
  openDialog("查看客户档案", `<div class="customer-workspace core-customer-workspace">
    <div class="customer-workspace-head"><div><span class="tag">${escapeHtml(customer.status)}</span><strong>${escapeHtml(customer.owner.displayName)}</strong><small>登记时间：${escapeHtml(customer.registeredOn || "日期未知")} · 更新于 ${formatTime(customer.updatedAt)}</small></div><div class="actions">${customerActions}</div></div>
    <nav class="customer-tabs" role="tablist" aria-label="客户档案区域">${tabs.map(([key, label]) => customerTabButton(key, label, tabCounts[key])).join("")}</nav>
    <section class="customer-panel" role="tabpanel" data-customer-panel="overview">
      <div class="customer-master-grid"><div><span>客户全称</span><strong>${escapeHtml(customer.fullName)}</strong></div><div><span>简称</span><strong>${escapeHtml(customer.shortName || "—")}</strong></div><div><span>客户来源</span><strong>${escapeHtml(customer.source || "—")}</strong></div><div><span>客户类型</span><strong>${escapeHtml(customer.customerType || "—")}</strong></div><div><span>行业</span><strong>${escapeHtml(customer.industry || "—")}</strong></div><div><span>所在区域</span><strong>${escapeHtml([customer.province, customer.city, customer.district].filter(Boolean).join(" · ") || "—")}</strong></div><div class="full"><span>详细地址</span><strong>${escapeHtml(customer.address || "—")}</strong></div><div class="full"><span>客户需求</span><p>${escapeHtml(customer.needSummary)}</p></div><div class="full"><span>客户情况总结</span><p>${escapeHtml(customer.summary || "—")}</p></div><div class="full"><span>备注</span><p>${escapeHtml(customer.notes || "—")}</p></div></div>
    </section>
    <section class="customer-panel" role="tabpanel" data-customer-panel="contacts" hidden><div class="card-head"><h2>联系人</h2>${permissions.canMaintainActivity ? `<button class="button small primary" data-contact-new="${customer.id}">+ 新增联系人</button>` : `<span class="tag">只读</span>`}</div>${contacts.length ? `<div class="table-wrap"><table><thead><tr><th>姓名</th><th>部门 / 职务</th><th>联系方式</th><th>决策角色 / 备注</th><th>操作</th></tr></thead><tbody>${contacts.map(contact => `<tr><td><strong>${escapeHtml(contact.name)}</strong></td><td>${escapeHtml([contact.department, contact.title].filter(Boolean).join(" / ") || "—")}</td><td>${escapeHtml([contact.mobile, contact.wechat, contact.email].filter(Boolean).join("；") || "—")}</td><td>${escapeHtml(contact.decisionRole || "—")}<br><small>${escapeHtml(contact.notes || "")}</small></td><td>${permissions.canMaintainActivity ? `<button class="button small" data-contact-edit="${contact.id}" data-customer-id="${customer.id}">编辑</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">暂无联系人</div>`}</section>
    <section class="customer-panel" role="tabpanel" data-customer-panel="quotes" hidden><div class="card-head"><h2>报价</h2>${permissions.canMaintainActivity ? "" : `<span class="tag">按既有审批规则操作</span>`}</div>${quotes.length ? `<div class="table-wrap"><table><thead><tr><th>报价</th><th>原含税合计</th><th>报价金额</th><th>状态</th><th>操作</th></tr></thead><tbody>${quotes.map(item => `<tr><td><strong>${escapeHtml(item.quoteNumber)} · ${escapeHtml(item.versionLabel)}</strong></td><td>${formatMoney(item.subtotalTaxedCents)}</td><td><strong>${formatMoney(item.finalDiscountCents)}</strong></td><td><span class="tag ${item.status === "APPROVED" ? "green" : item.status.includes("RETURNED") ? "red" : "orange"}">${escapeHtml(quoteStatusLabel(item))}</span></td><td><div class="actions"><button class="button small" data-quote-view="${item.id}">查看</button>${permissions.canMaintainActivity && item.status === "DRAFT" ? `<button class="button small" data-quote-edit="${item.id}">${item.sourceKind === "UPLOADED" ? "重新上传" : "编辑"}</button><button class="button small primary" data-quote-submit="${item.id}">发送审批</button>` : ""}${canDecideQuote(item) ? `<button class="button small primary" data-quote-decision="${item.id}">处理审批</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">暂无报价</div>`}</section>
  </div>`, { extraWide: true, dialogClass: "customer-archive-dialog", replace: true });
  activateCustomerTab(tabs.some(([key]) => key === activeTab) ? activeTab : "overview");
}

async function openCustomerDetail(customerId, activeTab = "overview", { replace = false } = {}) {
  if (isCoreLaunch()) return openCoreCustomerDetail(customerId, activeTab, { replace });
  openDialog("查看客户档案", `<div class="empty" role="status">正在加载客户完整档案…</div>`, { extraWide: true, dialogClass: "customer-archive-dialog", replace });
  const loadingDialog = document.querySelector(".dialog");
  let workspace;
  try {
    workspace = await api(`/api/customers/${customerId}/workspace`);
  } catch (error) {
    if (!loadingDialog.isConnected) return;
    state.customerWorkspace = null;
    openDialog("查看客户档案", `<div class="notice danger" role="alert">${escapeHtml(error.message)}</div><button class="button" data-customer-retry="${escapeHtml(customerId)}">重新加载</button>`, { extraWide: true, dialogClass: "customer-archive-dialog", replace: true });
    return;
  }
  if (!loadingDialog.isConnected) return;
  if (workspace.directoryOnly) return openCoreCustomerDetail(customerId, activeTab, { workspace });
  state.customerWorkspace = workspace;
  const { customer, permissions, projects, contacts, followups, reminders, surveys, quotes, contracts, files, businessAttachments, auditLogs } = workspace;
  const directAttachments = businessAttachments?.customer || { mode: "CURRENT", items: [] };
  const followupAttachments = businessAttachments?.followups || {};
  const tabCounts = { overview: null, contacts: contacts.length, followups: followups.length, reminders: reminders.length, surveys: surveys.length, quotes: quotes.length, contracts: contracts.length, files: files.length + directAttachments.items.length };
  const customerActions = `${permissions.canEditCustomer ? `<button class="button small" data-customer-edit="${customer.id}">编辑客户主档 / 阶段</button>` : ""}${permissions.canSupplementRegisteredOn ? `<button class="button small" data-customer-date="${customer.id}">补录登记时间</button>` : ""}`;
  const importOrigins = customer.importOrigins || [];
  const duplicateRelations = customer.duplicateRelations || [];
  openDialog("查看客户档案", `<div class="customer-workspace">
    <div class="customer-workspace-head"><div><span class="tag">${escapeHtml(customer.status)}</span><strong>${escapeHtml(customer.owner.displayName)}</strong><small>登记时间：${escapeHtml(customer.registeredOn || "日期未知")} · 更新于 ${formatTime(customer.updatedAt)}</small></div><div class="actions">${customerActions}</div></div>
    <nav class="customer-tabs" role="tablist" aria-label="客户档案区域">${CUSTOMER_DETAIL_TABS.map(([key, label]) => customerTabButton(key, label, tabCounts[key])).join("")}</nav>
    <section class="customer-panel" role="tabpanel" data-customer-panel="overview">
      <div class="customer-master-grid"><div><span>客户全称</span><strong>${escapeHtml(customer.fullName)}</strong></div><div><span>简称</span><strong>${escapeHtml(customer.shortName || "—")}</strong></div><div><span>客户来源</span><strong>${escapeHtml(customer.source || "—")}</strong></div><div><span>客户类型</span><strong>${escapeHtml(customer.customerType || "—")}</strong></div><div><span>行业</span><strong>${escapeHtml(customer.industry || "—")}</strong></div><div><span>所在区域</span><strong>${escapeHtml([customer.province, customer.city, customer.district].filter(Boolean).join(" · ") || "—")}</strong></div><div class="full"><span>详细地址 / 坐标</span><strong>${escapeHtml(customer.address || "—")}　${customer.longitude === null || customer.latitude === null ? "坐标未登记" : `${customer.longitude}, ${customer.latitude}`}</strong></div><div class="full"><span>客户需求</span><p>${escapeHtml(customer.needSummary)}</p></div><div class="full"><span>客户情况总结</span><p>${escapeHtml(customer.summary || "—")}</p></div><div class="full"><span>备注</span><p>${escapeHtml(customer.notes || "—")}</p></div></div>
      <section class="detail-section"><div class="card-head"><h2>项目机会</h2>${permissions.canMaintainActivity ? `<button class="button small" data-project-new="${customer.id}">+ 新建项目</button>` : `<span class="tag">只读</span>`}</div>${projects.length ? `<ul class="list">${projects.map(project => `<li><div><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.summary || "暂无说明")}</small></div><span class="tag ${project.active ? "green" : ""}">${project.active ? "进行中" : "已停用"}</span></li>`).join("")}</ul>` : `<div class="empty">暂无项目机会</div>`}</section>
      ${importOrigins.length ? `<section class="detail-section"><div class="card-head"><h2>历史导入来源</h2></div><ul class="list">${importOrigins.map(origin => `<li><div><strong>${escapeHtml(origin.sourceFileName)} · ${escapeHtml(origin.sheetName)} 第 ${origin.sourceRowNumber} 行</strong><small>批次 ${origin.batchId.slice(0, 8)} · ${formatTime(origin.importedAt)} · ${escapeHtml(origin.operatedBy.displayName)}</small></div><span>${escapeHtml(origin.originalStatus || "—")}${origin.originalStatus !== origin.mappedStatus ? ` → ${escapeHtml(origin.mappedStatus)}` : ""}</span></li>`).join("")}</ul></section>` : ""}
      ${duplicateRelations.length ? `<section class="detail-section"><div class="card-head"><h2>疑似重复 / 同名主体关系</h2></div><ul class="list">${duplicateRelations.map(item => `<li><div><strong>${escapeHtml(item.relatedCustomer.name)}</strong><small>${escapeHtml(item.reason)}</small></div><span class="tag orange">${escapeHtml(displayEnum(item.type, duplicateRelationTypeLabels, "其他主体关系"))}</span></li>`).join("")}</ul></section>` : ""}
    </section>
    <section class="customer-panel" role="tabpanel" data-customer-panel="contacts" hidden><div class="card-head"><h2>联系人</h2>${permissions.canMaintainActivity ? `<button class="button small primary" data-contact-new="${customer.id}">+ 新增联系人</button>` : `<span class="tag">只读</span>`}</div>${contacts.length ? `<div class="table-wrap"><table><thead><tr><th>姓名</th><th>部门 / 职务</th><th>内部联系方式</th><th>决策角色 / 备注</th><th>操作</th></tr></thead><tbody>${contacts.map(contact => `<tr><td><strong>${escapeHtml(contact.name)}</strong></td><td>${escapeHtml([contact.department, contact.title].filter(Boolean).join(" / ") || "—")}</td><td>${escapeHtml([contact.mobile, contact.wechat, contact.email].filter(Boolean).join("；") || "—")}</td><td>${escapeHtml(contact.decisionRole || "—")}<br><small>${escapeHtml(contact.notes || "")}</small></td><td>${permissions.canMaintainActivity ? `<button class="button small" data-contact-edit="${contact.id}" data-customer-id="${customer.id}">编辑</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">暂无联系人</div>`}</section>
    <section class="customer-panel" role="tabpanel" data-customer-panel="followups" hidden><div class="card-head"><h2>跟进时间线</h2><button class="button small" data-followups-export="${customer.id}">导出跟进 Word</button>${permissions.canMaintainActivity ? `<button class="button small primary" data-followup-new="${customer.id}">+ 新增跟进</button>` : `<span class="tag">只读</span>`}</div>${followups.length ? `<div class="timeline-list">${followups.map(item => `<article><div class="timeline-head"><strong>${followupMethodLabels[item.method]} · ${formatFollowupTime(item)}</strong><span>${escapeHtml(item.recordedBy.displayName)}</span></div><p>${escapeHtml(item.content)}</p>${item.customerFeedback || item.historical ? `<p><strong>客户反馈：</strong>${escapeHtml(item.customerFeedback || "原文未记录")}</p>` : ""}<p><strong>下一步：</strong>${escapeHtml(item.nextAction || (item.historical ? "原文未记录" : "—"))}</p><small>${item.participants.length || item.historical ? `参与人员：${escapeHtml(item.participants.join("、") || "原文未记录")}　` : ""}${item.contact ? `联系人：${escapeHtml(item.contact.name)}　` : ""}${item.project ? `项目：${escapeHtml(item.project.name)}` : ""}${item.updatedAt !== item.createdAt ? `　修改于 ${formatTime(item.updatedAt)}` : ""}</small>${item.source ? followupSourceDetails(item.source) : ""}${permissions.canMaintainActivity ? `<div class="actions section-gap"><button class="button small" data-followup-edit="${item.id}" data-customer-id="${customer.id}">纠正记录</button></div>` : ""}${attachmentBlock({ title: "跟进附件", data: followupAttachments[item.id], targetType: "FOLLOWUP", targetId: item.id, writable: permissions.canMaintainActivity, compact: true })}</article>`).join("")}</div>` : `<div class="empty">暂无跟进记录</div>`}</section>
    <section class="customer-panel" role="tabpanel" data-customer-panel="reminders" hidden><div class="card-head"><h2>提醒</h2>${permissions.canCreateReminder ? `<button class="button small primary" data-customer-reminder-new="${customer.id}">+ ${state.user.role === "PRESALES" ? "新建本人提醒" : "指派提醒"}</button>` : ""}</div>${reminders.length ? `<div class="table-wrap"><table><thead><tr><th>事项 / 关联对象</th><th>负责人 / 来源</th><th>提醒时间</th><th>优先级</th><th>状态</th></tr></thead><tbody>${reminders.map(item => { const target = item.businessObject?.target ? encodeURIComponent(JSON.stringify(item.businessObject.target)) : ""; return `<tr><td><strong>${escapeHtml(item.title)}</strong><br><button class="text-button reminder-object" data-reminder-target="${target}">${escapeHtml(item.businessObject?.label || "关联对象已失效")}</button><br><small>${escapeHtml(item.notes || "")}</small></td><td>${escapeHtml(item.assignee.displayName)}<br><small>${item.source === "LEADER" ? `由 ${escapeHtml(item.assignedBy.displayName)} 指派` : "本人创建"}</small></td><td>${formatTime(item.remindAt)}</td><td>${escapeHtml(displayEnum(item.priority, reminderPriorityLabels, "未设置"))}</td><td><span class="tag ${item.status === "COMPLETED" ? "green" : item.status === "OVERDUE" ? "red" : "orange"}">${escapeHtml(displayEnum(item.status, reminderStatusLabels, "状态待确认"))}</span></td></tr>`; }).join("")}</tbody></table></div>` : `<div class="empty">暂无关联提醒</div>`}</section>
    <section class="customer-panel" role="tabpanel" data-customer-panel="surveys" hidden><div class="card-head"><h2>软件调研</h2>${permissions.canMaintainActivity ? `<button class="button small primary" data-customer-survey-new="${customer.id}">+ 新建调研</button>` : `<span class="tag">只读</span>`}</div>${surveys.length ? `<ul class="list">${surveys.map(item => `<li><div><strong>${escapeHtml(item.title)} · V${item.versionNumber}</strong><small>${escapeHtml(item.project.name)} · ${escapeHtml(item.template.code)} ${escapeHtml(item.template.version)} · ${formatTime(item.updatedAt)}</small></div><div class="actions">${statusTag(item.status)}<button class="button small" data-survey-open="${item.id}">${permissions.canMaintainActivity ? "查看 / 填写" : "查看"}</button><button class="button small" data-survey-history="${item.id}">历史</button></div></li>`).join("")}</ul>` : `<div class="empty">暂无软件调研</div>`}</section>
    <section class="customer-panel" role="tabpanel" data-customer-panel="quotes" hidden><div class="card-head"><h2>报价</h2>${permissions.canMaintainActivity ? "" : `<span class="tag">按既有审批规则操作</span>`}</div>${quotes.length ? `<div class="table-wrap"><table><thead><tr><th>报价 / 项目</th><th>原含税合计</th><th>报价金额</th><th>状态</th><th>操作</th></tr></thead><tbody>${quotes.map(item => `<tr><td><strong>${escapeHtml(item.quoteNumber)} · ${escapeHtml(item.versionLabel)}</strong><br><small>${escapeHtml(item.project.name)}</small></td><td>${formatMoney(item.subtotalTaxedCents)}</td><td><strong>${formatMoney(item.finalDiscountCents)}</strong></td><td><span class="tag ${item.status === "APPROVED" ? "green" : item.status.includes("RETURNED") ? "red" : "orange"}">${escapeHtml(quoteStatusLabel(item))}</span>${item.pendingManagerIssue ? `<br><small>${escapeHtml(item.pendingManagerIssue.message)}</small>` : ""}</td><td><div class="actions"><button class="button small" data-quote-view="${item.id}">查看</button>${permissions.canMaintainActivity && item.status === "DRAFT" ? `<button class="button small" data-quote-edit="${item.id}">${item.sourceKind === "UPLOADED" ? "重新上传" : "编辑"}</button><button class="button small primary" data-quote-submit="${item.id}">提交审批</button>` : ""}${canDecideQuote(item) ? `<button class="button small primary" data-quote-decision="${item.id}">处理审批</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">暂无报价</div>`}</section>
    <section class="customer-panel" role="tabpanel" data-customer-panel="contracts" hidden><div class="card-head"><h2>合同</h2>${permissions.canMaintainActivity ? `<button class="button small primary" data-customer-contract-new="${customer.id}">+ 创建合同草稿</button>` : `<span class="tag">只读</span>`}</div>${contracts.length ? `<div class="table-wrap"><table><thead><tr><th>合同编号 / 项目</th><th>引用报价</th><th>合同总价</th><th>模板 / 状态</th><th>操作</th></tr></thead><tbody>${contracts.map(item => `<tr><td><strong>${escapeHtml(item.contractNumber)}</strong><br><small>${escapeHtml(item.project.name)}</small></td><td>${escapeHtml(item.quoteReference.quoteNumber)} · ${escapeHtml(item.quoteReference.versionLabel)}<br><small>终审 ${formatTime(item.quoteReference.approvedAt)}</small></td><td>${formatMoney(item.amountCents)}</td><td>${escapeHtml(item.template.version)}<br><span class="tag ${item.status === "SIGNED" ? "green" : item.status === "VOID" ? "red" : "orange"}">${escapeHtml(displayEnum(item.status, contractStatusLabels, "状态待确认"))}</span></td><td><button class="button small primary" data-contract-open="${item.id}">查看 / 处理</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">暂无合同</div>`}</section>
    <section class="customer-panel" role="tabpanel" data-customer-panel="files" hidden>${attachmentBlock({ title: "客户通用附件", data: directAttachments, targetType: "CUSTOMER", targetId: customer.id, writable: permissions.canMaintainActivity })}<section class="detail-section"><div class="card-head"><h2>系统生成及合同归档</h2><span class="tag">不可覆盖</span></div>${files.length ? `<ul class="list">${files.map(file => `<li><div><strong>${escapeHtml(displayEnum(file.category, file.source === "CONTRACT_FILE" ? contractFileLabels : storedFileLabels, "其他归档文件"))} · ${escapeHtml(file.originalName)}</strong><small>${file.contractNumber ? `合同 ${escapeHtml(file.contractNumber)} · ` : ""}${formatTime(file.createdAt)} · ${(file.sizeBytes / 1024).toFixed(1)} KB · SHA-256 ${escapeHtml(file.sha256.slice(0, 16))}…</small></div><button class="button small" ${file.source === "CONTRACT_FILE" ? `data-contract-download="${file.id}"` : `data-file-download="${file.id}"`}>下载</button></li>`).join("")}</ul>` : `<div class="empty">暂无系统生成或合同归档文件</div>`}</section><section class="detail-section"><div class="card-head"><h2>操作日志</h2><span class="tag">最近 ${auditLogs.length} 条</span></div>${auditLogs.length ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>操作</th><th>操作人</th><th>说明</th></tr></thead><tbody>${auditLogs.map(log => `<tr><td>${formatTime(log.createdAt)}</td><td><strong>${escapeHtml(displayEnum(log.action, auditActionLabels, "其他系统操作"))}</strong></td><td>${escapeHtml(log.actor?.displayName || "系统")}</td><td>${escapeHtml(auditSummaryText(log))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">暂无操作日志</div>`}</section></section>
  </div>`, { extraWide: true, dialogClass: "customer-archive-dialog", replace: true });
  activateCustomerTab(activeTab);
}

async function refreshCustomerDetail(customerId, activeTab = "overview") {
  const replace = Boolean(document.querySelector(".customer-workspace"));
  await openCustomerDetail(customerId, activeTab, { replace });
}

async function refreshQuoteContext() {
  const customerId = state.customerWorkspace?.customer?.id;
  if (customerId && document.querySelector(".customer-workspace")) return refreshCustomerDetail(customerId, "quotes");
  return go("quotes");
}

async function openCustomerEditDialog(customerId) {
  const customer = state.customerWorkspace?.customer?.id === customerId ? state.customerWorkspace.customer : await api(`/api/customers/${customerId}`);
  const dictionaryOptions = (await api("/api/customer-dictionaries")).items;
  openDialog("编辑客户主档与阶段", `<div class="notice">负责人变更仍使用客户转让流程；来源和类型只能选启用字典项；历史/停用值可原样保留。</div><div class="form-grid"><div class="field full"><label class="required">客户全称</label><input id="customer-edit-name" value="${escapeHtml(customer.fullName)}" /></div><div class="field"><label>简称</label><input id="customer-edit-short" value="${escapeHtml(customer.shortName || "")}" /></div><div class="field"><label class="required">客户阶段</label><select id="customer-edit-status">${customerStatuses.map(status => `<option${customer.status === status ? " selected" : ""}>${escapeHtml(status)}</option>`).join("")}</select></div><div class="field"><label>登记时间（历史缺失可保持未知）</label><input id="customer-edit-registered-on" type="date" value="${escapeHtml(customer.registeredOn || "")}" /></div>${customerDictionaryField("customer-edit-source", "客户来源", "SOURCE", dictionaryOptions, customer.source)}${customerDictionaryField("customer-edit-type", "客户类型", "TYPE", dictionaryOptions, customer.customerType)}<div class="field"><label>行业</label><input id="customer-edit-industry" value="${escapeHtml(customer.industry || "")}" /></div>${chinaRegionFields({ provinceId: "customer-edit-province", cityId: "customer-edit-city", province: customer.province || "", city: customer.city || "" })}<div class="field"><label>区县</label><input id="customer-edit-district" value="${escapeHtml(customer.district || "")}" /></div><div class="field full"><label>详细地址</label><input id="customer-edit-address" value="${escapeHtml(customer.address || "")}" /></div><div class="field"><label>经度</label><input id="customer-edit-longitude" type="number" min="-180" max="180" step="any" value="${escapeHtml(customer.longitude ?? "")}" /></div><div class="field"><label>纬度</label><input id="customer-edit-latitude" type="number" min="-90" max="90" step="any" value="${escapeHtml(customer.latitude ?? "")}" /></div><div class="field full"><label class="required">客户需求</label><textarea id="customer-edit-need">${escapeHtml(customer.needSummary)}</textarea></div><div class="field full"><label>客户情况总结</label><textarea id="customer-edit-summary">${escapeHtml(customer.summary || "")}</textarea></div><div class="field full"><label>备注</label><textarea id="customer-edit-notes">${escapeHtml(customer.notes || "")}</textarea></div></div>`, {
    wide: true,
    submitLabel: "保存并记录审计",
    onSubmit: async () => {
      await api(`/api/customers/${customerId}`, { method: "PATCH", body: JSON.stringify({ fullName: document.querySelector("#customer-edit-name").value, shortName: document.querySelector("#customer-edit-short").value, status: document.querySelector("#customer-edit-status").value, registeredOn: document.querySelector("#customer-edit-registered-on").value, source: document.querySelector("#customer-edit-source").value, customerType: document.querySelector("#customer-edit-type").value, industry: document.querySelector("#customer-edit-industry").value, province: document.querySelector("#customer-edit-province").value, city: document.querySelector("#customer-edit-city").value, district: document.querySelector("#customer-edit-district").value, address: document.querySelector("#customer-edit-address").value, longitude: document.querySelector("#customer-edit-longitude").value, latitude: document.querySelector("#customer-edit-latitude").value, needSummary: document.querySelector("#customer-edit-need").value, summary: document.querySelector("#customer-edit-summary").value, notes: document.querySelector("#customer-edit-notes").value }) });
      closeDialog(); showToast("客户主档已更新并记录审计"); await refreshCustomerDetail(customerId, "overview");
    }
  });
  bindChinaRegionSelects("customer-edit-province", "customer-edit-city");
}

async function openContactDialog(customerId, contactId = null) {
  let contact = null;
  if (contactId) {
    const workspace = state.customerWorkspace?.customer?.id === customerId ? state.customerWorkspace : await api(`/api/customers/${customerId}/workspace`);
    contact = workspace.contacts.find(item => item.id === contactId);
    if (!contact) throw new Error("联系人不存在或当前账号无权访问");
  }
  openDialog(contact ? "编辑联系人" : "新增联系人", `<div class="form-grid"><div class="field"><label class="required">姓名</label><input id="contact-name" value="${escapeHtml(contact?.name || "")}" /></div><div class="field"><label>部门</label><input id="contact-department" value="${escapeHtml(contact?.department || "")}" /></div><div class="field"><label>职务</label><input id="contact-title" value="${escapeHtml(contact?.title || "")}" /></div><div class="field"><label>决策角色</label><input id="contact-role" value="${escapeHtml(contact?.decisionRole || "")}" /></div><div class="field"><label>手机</label><input id="contact-mobile" value="${escapeHtml(contact?.mobile || "")}" /></div><div class="field"><label>微信</label><input id="contact-wechat" value="${escapeHtml(contact?.wechat || "")}" /></div><div class="field full"><label>邮箱</label><input id="contact-email" type="email" value="${escapeHtml(contact?.email || "")}" /></div><div class="field full"><label>备注</label><textarea id="contact-notes">${escapeHtml(contact?.notes || "")}</textarea></div></div>`, {
    submitLabel: "保存联系人",
    onSubmit: async () => {
      const body = JSON.stringify({ name: document.querySelector("#contact-name").value, department: document.querySelector("#contact-department").value, title: document.querySelector("#contact-title").value, decisionRole: document.querySelector("#contact-role").value, mobile: document.querySelector("#contact-mobile").value, wechat: document.querySelector("#contact-wechat").value, email: document.querySelector("#contact-email").value, notes: document.querySelector("#contact-notes").value });
      await api(contact ? `/api/contacts/${contact.id}` : `/api/customers/${customerId}/contacts`, { method: contact ? "PATCH" : "POST", body });
      closeDialog(); showToast(contact ? "联系人已更新" : "联系人已保存"); await refreshCustomerDetail(customerId, "contacts");
    }
  });
}

function openProjectDialog(customerId) {
  openDialog("新建项目机会", `<div class="field"><label class="required">项目名称</label><input id="project-name" /></div><div class="field"><label>项目说明</label><textarea id="project-summary"></textarea></div>`, {
    submitLabel: "保存项目",
    onSubmit: async () => {
      await api(`/api/customers/${customerId}/projects`, { method: "POST", body: JSON.stringify({ name: document.querySelector("#project-name").value, summary: document.querySelector("#project-summary").value }) });
      closeDialog();
      showToast("项目机会已保存");
      await refreshCustomerDetail(customerId);
    }
  });
}

async function openFollowupDialog(customerId, followupId = null) {
  const [contacts, projects, workspace] = await Promise.all([
    api(`/api/customers/${customerId}/contacts`),
    api(`/api/customers/${customerId}/projects`),
    followupId && state.customerWorkspace?.customer?.id !== customerId ? api(`/api/customers/${customerId}/workspace`) : Promise.resolve(state.customerWorkspace)
  ]);
  const followup = followupId ? workspace?.followups.find(item => item.id === followupId) : null;
  if (followupId && !followup) throw new Error("跟进记录不存在或当前账号无权访问");
  const dayPrecision = followup?.occurredPrecision === "DAY";
  openDialog(followup ? "纠正跟进记录" : "新增跟进与下一步提醒", `${followup ? `<div class="notice warning">历史跟进不覆盖旧值；本次修改必须填写纠正原因，服务端将保存修改前快照。</div>` : ""}<div class="form-grid"><div class="field"><label class="required">跟进方式</label><select id="followup-method">${Object.entries(followupMethodLabels).map(([value, label]) => `<option value="${value}"${followup?.method === value ? " selected" : ""}>${label}</option>`).join("")}</select></div><div class="field"><label class="required">${dayPrecision ? "跟进日期（日精度）" : "跟进时间"}</label><input id="followup-time" type="${dayPrecision ? "date" : "datetime-local"}" value="${dayPrecision ? escapeHtml(followup.occurredAt) : followup ? localDateTimeValue(new Date(followup.occurredAt)) : localDateTimeValue()}" /></div><div class="field"><label>项目</label><select id="followup-project"><option value="">未关联</option>${projects.items.map(project => `<option value="${project.id}"${followup?.project?.id === project.id ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}</select></div><div class="field"><label>联系人</label><select id="followup-contact"><option value="">未关联</option>${contacts.items.map(contact => `<option value="${contact.id}"${followup?.contact?.id === contact.id ? " selected" : ""}>${escapeHtml(contact.name)}</option>`).join("")}</select></div><div class="field full"><label>参与人员（顿号分隔）</label><input id="followup-participants" value="${escapeHtml(followup?.participants.join("、") || "")}" /></div><div class="field full"><label class="required">沟通内容</label><textarea id="followup-content">${escapeHtml(followup?.content || "")}</textarea></div><div class="field full"><label>客户反馈</label><textarea id="followup-feedback">${escapeHtml(followup?.customerFeedback || "")}</textarea></div><div class="field full"><label class="${followup?.historical ? "" : "required"}">下一步行动${followup?.historical ? "（原文未记录时可留空）" : ""}</label><input id="followup-next" value="${escapeHtml(followup?.nextAction || "")}" /></div>${followup ? `<div class="field full"><label class="required">纠正原因</label><textarea id="followup-change-reason"></textarea></div>` : `<div class="field full checkbox-field"><label><input id="followup-reminder-enabled" type="checkbox" /> 同时创建下一步提醒</label></div><div class="field"><label>提醒时间</label><input id="followup-reminder-time" type="datetime-local" /></div><div class="field"><label>优先级</label><select id="followup-reminder-priority"><option value="MEDIUM">中</option><option value="HIGH">高</option><option value="LOW">低</option></select></div>`}</div>`, {
    wide: true,
    submitLabel: followup ? "保存纠正并留痕" : "保存跟进",
    onSubmit: async () => {
      const payload = { method: document.querySelector("#followup-method").value, occurredAt: dayPrecision ? document.querySelector("#followup-time").value : new Date(document.querySelector("#followup-time").value).toISOString(), projectId: document.querySelector("#followup-project").value || null, contactId: document.querySelector("#followup-contact").value || null, participants: document.querySelector("#followup-participants").value.split(/[、,，]/).map(value => value.trim()).filter(Boolean), content: document.querySelector("#followup-content").value, customerFeedback: document.querySelector("#followup-feedback").value, nextAction: document.querySelector("#followup-next").value };
      let reminderEnabled = false;
      if (followup) {
        payload.changeReason = document.querySelector("#followup-change-reason").value;
        await api(`/api/followups/${followup.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        reminderEnabled = document.querySelector("#followup-reminder-enabled").checked;
        const reminderTime = document.querySelector("#followup-reminder-time").value;
        payload.nextReminder = reminderEnabled ? { remindAt: reminderTime ? new Date(reminderTime).toISOString() : "", priority: document.querySelector("#followup-reminder-priority").value } : null;
        await api(`/api/customers/${customerId}/followups`, { method: "POST", body: JSON.stringify(payload) });
      }
      closeDialog(); showToast(followup ? "跟进记录已纠正并保留旧值" : reminderEnabled ? "跟进和下一步提醒已保存" : "跟进记录已保存"); await refreshCustomerDetail(customerId, "followups");
    }
  });
}

async function openReminderDialog(preselectedCustomerId = null) {
  const allTargets = (await api("/api/reminders/targets")).items;
  const targets = preselectedCustomerId ? allTargets.filter(target => target.customerId === preselectedCustomerId) : allTargets;
  if (!targets.length) {
    openDialog("新建提醒", `<div class="notice warning">当前账号没有可创建或指派提醒的客户。</div>`);
    return;
  }
  openDialog(state.user.role === "PRESALES" ? "新建本人提醒" : "新建或指派提醒", `<div class="form-grid"><div class="field full"><label class="required">关联客户与负责人</label><select id="reminder-target">${targets.map(target => `<option value="${target.customerId}" data-assignee="${target.assigneeId}">${escapeHtml(target.customerName)} · ${escapeHtml(target.assigneeName)}</option>`).join("")}</select></div><div class="field full"><label>关联业务对象</label><select id="reminder-related"><option value="">客户档案（默认）</option></select><small id="reminder-related-state">正在加载有权限的联系人、调研、报价和合同…</small></div><div class="field full"><label class="required">提醒事项</label><input id="reminder-title" /></div><div class="field"><label class="required">提醒时间</label><input id="reminder-time" type="datetime-local" /></div><div class="field"><label>优先级</label><select id="reminder-priority"><option value="MEDIUM">中</option><option value="HIGH">高</option><option value="LOW">低</option></select></div><div class="field full"><label>备注</label><textarea id="reminder-notes"></textarea></div></div>`, {
    submitLabel: "保存提醒",
    onSubmit: async () => {
      const time = document.querySelector("#reminder-time").value;
      const target = document.querySelector("#reminder-target");
      const related = document.querySelector("#reminder-related").selectedOptions[0];
      await api("/api/reminders", { method: "POST", body: JSON.stringify({ customerId: target.value, assigneeId: target.selectedOptions[0]?.dataset.assignee, relatedType: related?.dataset.type || null, relatedId: related?.dataset.id || null, title: document.querySelector("#reminder-title").value, remindAt: time ? new Date(time).toISOString() : "", priority: document.querySelector("#reminder-priority").value, notes: document.querySelector("#reminder-notes").value }) });
      closeDialog();
      showToast("提醒已保存并记录来源");
      if (preselectedCustomerId) await refreshCustomerDetail(preselectedCustomerId, "reminders");
      else await go("dashboard");
    }
  });
  let relatedRequest = 0;
  const loadRelated = async () => {
    const requestId = ++relatedRequest;
    const customerId = document.querySelector("#reminder-target")?.value;
    const select = document.querySelector("#reminder-related");
    const status = document.querySelector("#reminder-related-state");
    if (!select || !customerId) return;
    select.disabled = true;
    status.textContent = "正在加载有权限的业务对象…";
    try {
      const result = await api(`/api/reminders/related-targets?customerId=${encodeURIComponent(customerId)}`);
      if (requestId !== relatedRequest || !select.isConnected) return;
      select.innerHTML = `<option value="">客户档案（默认）</option>${result.items.map(item => `<option data-type="${item.type}" data-id="${item.id}">${escapeHtml(item.label)}</option>`).join("")}`;
      status.textContent = result.items.length ? "仅显示当前账号有权关联的业务对象" : "该客户暂无可关联的具体业务对象";
    } catch (error) { if (requestId === relatedRequest && status.isConnected) status.textContent = error.message; }
    finally { if (requestId === relatedRequest && select.isConnected) select.disabled = false; }
  };
  document.querySelector("#reminder-target").addEventListener("change", loadRelated);
  await loadRelated();
}

function parseScaledDecimal(value, decimalPlaces, label) {
  const raw = String(value ?? "").trim();
  if (raw.includes(",") && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) throw new Error(`${label}格式无效`);
  const text = raw.replaceAll(",", "");
  const match = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length || 0) > decimalPlaces) throw new Error(`${label}格式无效，最多 ${decimalPlaces} 位小数`);
  const scaled = Number(match[1]) * (10 ** decimalPlaces) + Number((match[2] || "").padEnd(decimalPlaces, "0"));
  if (!Number.isSafeInteger(scaled)) throw new Error(`${label}超出安全范围`);
  return scaled;
}

function quoteCustomerContact(meta = {}) {
  const legacyUserContact = !meta.customerContactSource
    && meta.customerContactName
    && meta.customerContactName === meta.sellerName
    && meta.customerPhone === meta.sellerPhone;
  return {
    name: legacyUserContact ? "" : (meta.customerContactName || ""),
    phone: legacyUserContact ? "" : (meta.customerPhone || ""),
    legacyUserContact
  };
}

function quoteItemsTable(quote) {
  const meta = quote.metadata || {};
  const contact = quoteCustomerContact(meta);
  const rows = items => items.map(item => `<tr><td>${item.lineNo}</td><td>${escapeHtml(item.itemName)}</td><td>${escapeHtml(item.subitemName || "—")}</td><td>${escapeHtml(item.unit)}</td><td>${item.quantityMilli / 1000}</td><td>${formatMoney(item.untaxedUnitPriceCents)}</td><td>${formatMoney(item.untaxedAmountCents)}</td><td>${formatMoney(item.taxedAmountCents)}</td><td>${escapeHtml(item.notes || "—")}</td></tr>`).join("");
  return `<div class="quote-view-meta"><div><span>客户名称</span><strong>${escapeHtml(meta.customerName || quote.customer.name)}</strong></div><div><span>报价日期</span><strong>${escapeHtml(meta.quoteDate || "—")}</strong></div><div><span>有效期</span><strong>${escapeHtml(meta.validity || "—")}</strong></div><div><span>客户联系人</span><strong>${escapeHtml(contact.name || "—")}</strong></div><div><span>客户联系电话</span><strong>${escapeHtml(contact.phone || "—")}</strong></div><div><span>报价人</span><strong>${escapeHtml(meta.sellerName || "—")}</strong></div></div>
    <section class="quote-preview-section"><div class="card-head"><div><span class="section-kicker">对客金额</span><h2>项目总价</h2></div><strong>${formatMoney(quote.finalDiscountCents)}</strong></div><div class="table-wrap"><table><thead><tr><th>序号</th><th>项目 / 型号</th><th>子项</th><th>单位</th><th>数量</th><th>未税单价</th><th>未税金额</th><th>含税金额</th><th>备注</th></tr></thead><tbody>${rows(quote.items)}</tbody><tfoot><tr><td colspan="7">原含税合计</td><td><strong>${formatMoney(quote.subtotalTaxedCents)}</strong></td><td></td></tr>${quote.discountAmountCents > 0 ? `<tr><td colspan="7">优惠金额</td><td>${formatMoney(quote.discountAmountCents)}</td><td></td></tr>` : ""}<tr><td colspan="7">优惠后合计 / 合同总价来源</td><td><strong>${formatMoney(quote.finalDiscountCents)}</strong></td><td></td></tr></tfoot></table></div></section>
    <section class="quote-preview-section"><div class="card-head"><div><span class="section-kicker">费用构成</span><h2>项目费用明细</h2></div><span>${quote.detailItems?.length || 0} 项</span></div>${quote.detailItems?.length ? `<div class="table-wrap"><table><thead><tr><th>序号</th><th>项目</th><th>子项</th><th>单位</th><th>数量</th><th>未税单价</th><th>未税金额</th><th>含税金额</th><th>备注</th></tr></thead><tbody>${rows(quote.detailItems)}</tbody><tfoot><tr><td colspan="7">明细含税合计</td><td><strong>${formatMoney(quote.detailSubtotalTaxedCents)}</strong></td><td></td></tr></tfoot></table></div>` : `<div class="empty">未填写项目费用明细</div>`}</section>
    <section class="quote-terms"><div><span>交期</span><strong>${escapeHtml(meta.deliveryTerms || "—")}</strong></div><div><span>付款方式</span><strong>${escapeHtml(meta.paymentTerms || "—")}</strong></div><div><span>开户行</span><strong>${escapeHtml(meta.bankName || "—")}</strong></div><div><span>账号</span><strong>${escapeHtml(meta.bankAccount || "—")}</strong></div>${quote.notes ? `<div class="full"><span>注意事项</span><strong>${escapeHtml(quote.notes)}</strong></div>` : ""}</section>`;
}

function quoteReadonlyRows(items, section, allocations = []) {
  if (!items?.length) {
    const columns = section === "DETAIL" ? 10 : 9;
    return `<tr><td colspan="${columns}" class="quote-readonly-empty">未填写</td></tr>`;
  }
  return items.map((item, index) => `<tr><td class="qe-index-static">${index + 1}</td><td>${escapeHtml(item.itemName)}</td>${section === "DETAIL" ? `<td>${escapeHtml(item.subitemName || "—")}</td>` : ""}<td class="qe-unit-static">${escapeHtml(item.unit)}</td><td>${item.quantityMilli / 1000}</td><td class="qe-money">${plainQuoteMoney(item.untaxedUnitPriceCents)}</td><td class="qe-money">${plainQuoteMoney(item.untaxedAmountCents + (allocations[index] || 0))}</td><td class="qe-money"><strong>${plainQuoteMoney(item.taxedAmountCents)}</strong></td><td>${escapeHtml(item.notes || "—")}</td><td class="qe-action"></td></tr>`).join("");
}

function quoteReadonlyPaper(quote) {
  const meta = quote.metadata || {};
  const contact = quoteCustomerContact(meta);
  const rates = new Set((quote.items || []).map(item => item.taxRateBps));
  const singleRate = rates.size === 1 ? [...rates][0] : null;
  const finalUntaxed = ["RECONCILE_V1", "ALLOCATE_V2"].includes(quote.roundingPolicy) && quote.finalDiscountCents === quote.subtotalTaxedCents ? plainQuoteMoney(quote.subtotalUntaxedCents)
    : singleRate === null ? "—" : plainQuoteMoney(Math.round(quote.finalDiscountCents * 10_000 / (10_000 + singleRate)));
  const taxLabel = singleRate === null ? "各行所列税率" : `${singleRate / 100}%`;
  const detailAdjustment = quote.roundingPolicy === "ALLOCATE_V2" ? 0 : Number(quote.detailRoundingAdjustmentCents || 0);
  return `<article class="quote-paper quote-paper-readonly"><header class="quote-paper-header"><img class="quote-logo-img" src="/assets/quote-logo.png" alt="河南海弘软件技术有限公司 Logo" /><h1>软 件 报 价 单</h1></header><section class="quote-paper-meta quote-reference-meta"><label><span>客　　户：</span><input value="${escapeHtml(meta.customerName || quote.customer.name)}" readonly /></label><label><span>报价单位：</span><input value="河南海弘软件技术有限公司" readonly class="fixed-val" /></label><label><span>编　　号：</span><input value="${escapeHtml(quote.quoteNumber)}" readonly /></label><label><span>地　　址：</span><input value="河南省鹤壁经济技术开发区渤海路 396 号" readonly class="fixed-val" /></label><label><span>联 系 人：</span><input value="${escapeHtml(contact.name || "—")}" readonly /></label><label><span>邮　　编：</span><input value="458030" readonly class="fixed-val" /></label><label><span>日　　期：</span><input value="${escapeHtml(meta.quoteDate || "—")}" readonly /></label><label><span>有 效 期：</span><input value="${escapeHtml(meta.validity || "—")}" readonly /></label><label><span>手　　机：</span><input value="${escapeHtml(contact.phone || "—")}" readonly /></label><label><span>电　　话：</span><input value="0392-3357155" readonly class="fixed-val" /></label></section>
    <section class="quote-paper-section"><h2>项目总价</h2><div class="table-wrap"><table class="quote-editor-table quote-summary-table"><thead><tr><th>序号</th><th>项目/型号</th><th>单位</th><th>数量</th><th>未税<br>单价(元)</th><th>未税<br>金额(元)</th><th>含税<br>金额(元)</th><th>备注</th><th></th></tr></thead><tbody>${quoteReadonlyRows(quote.items, "SUMMARY")}</tbody><tfoot><tr><td colspan="5" class="qe-total-label">合计：</td><td>${plainQuoteMoney(quote.subtotalUntaxedCents)}</td><td>${plainQuoteMoney(quote.subtotalTaxedCents)}</td><td></td><td class="qe-action"></td></tr>${quote.discountAmountCents > 0 ? `<tr class="quote-final-row"><td colspan="5" class="qe-total-label">优惠后合计：</td><td>${finalUntaxed}</td><td><strong>${plainQuoteMoney(quote.finalDiscountCents)}</strong></td><td class="qe-discount-note">优惠 ${plainQuoteMoney(quote.discountAmountCents)} 元</td><td class="qe-action"></td></tr>` : ""}</tfoot></table></div></section>
    <section class="quote-paper-section"><h2>项目费用明细</h2><div class="table-wrap"><table class="quote-editor-table quote-detail-table"><thead><tr><th>序号</th><th>项目</th><th>子项</th><th>单位</th><th>数量</th><th>未税<br>单价(元)</th><th>未税<br>金额(元)</th><th>含税<br>金额(元)</th><th>备注</th><th></th></tr></thead><tbody>${quoteReadonlyRows(quote.detailItems, "DETAIL", quote.roundingPolicy === "ALLOCATE_V2" ? quote.detailRoundingAllocationsCents : [])}</tbody><tfoot>${detailAdjustment ? `<tr><td colspan="6" class="qe-total-label">尾差调整：</td><td>${detailAdjustment > 0 ? "+" : ""}${plainQuoteMoney(detailAdjustment)}</td><td>—</td><td>四舍五入</td><td class="qe-action"></td></tr>` : ""}<tr><td colspan="6" class="qe-total-label">合计：</td><td>${plainQuoteMoney(quote.detailSubtotalUntaxedCents)}</td><td>${plainQuoteMoney(quote.detailSubtotalTaxedCents)}</td><td></td><td class="qe-action"></td></tr><tr><td colspan="10" class="quote-note-cell">${escapeHtml(quote.notes || "—")}</td></tr></tfoot></table></div></section>
    <section class="quote-paper-terms"><div class="quote-uppercase-line">含 <strong>${escapeHtml(taxLabel)}</strong> 增值税，合计金额（大写）：<strong>${escapeHtml(quoteAmountUppercase(quote.finalDiscountCents))}</strong></div><label><span>交　　期：</span><input value="${escapeHtml(meta.deliveryTerms || "—")}" readonly /></label><label><span>付款方式：</span><input value="${escapeHtml(meta.paymentTerms || "—")}" readonly /></label><label><span>开 户 行：</span><input value="${escapeHtml(meta.bankName || "—")}" readonly /></label><label><span>账　　号：</span><input value="${escapeHtml(meta.bankAccount || "—")}" readonly /></label></section><p class="quote-service-copy">倘若您对以上内容有任何疑义，请及时与我们联系。我们将竭诚为您服务！</p><section class="quote-sign"><label><span>报 价 人：</span><input value="${escapeHtml(meta.sellerName || "—")}" readonly /></label><label><span>手　　机：</span><input value="${escapeHtml(meta.sellerPhone || "—")}" readonly /></label><label><span>邮　　箱：</span><input value="${escapeHtml(meta.sellerEmail || "—")}" readonly /></label></section></article>`;
}

function quoteEditorRow(item = {}, section = "SUMMARY") {
  const taxRate = item.taxRateBps !== undefined ? item.taxRateBps / 100 : 13;
  const defaultUnit = section === "SUMMARY" ? "套" : "人天";
  return `<tr class="quote-editor-row" data-quote-section="${section}"><td class="qe-index"></td><td><textarea class="qe-name" rows="1" placeholder="${section === "SUMMARY" ? "项目 / 型号" : "费用所属项目"}">${escapeHtml(item.itemName || "")}</textarea></td>${section === "DETAIL" ? `<td><textarea class="qe-subitem" rows="1" placeholder="子项">${escapeHtml(item.subitemName || "")}</textarea></td>` : ""}<td><select class="qe-unit" aria-label="单位">${["人天", "项", "套", "种类", "年", "台"].map(value => `<option${(item.unit || defaultUnit) === value ? " selected" : ""}>${value}</option>`).join("")}</select></td><td><input class="qe-quantity" inputmode="decimal" value="${item.quantityMilli ? item.quantityMilli / 1000 : "1"}" aria-label="数量" /></td><td class="qe-money"><span class="qe-unit-preview">—</span></td><td class="qe-money"><span class="qe-untaxed-preview">—</span></td><td><input class="qe-taxed" inputmode="decimal" value="${item.taxedAmountCents !== undefined ? plainQuoteMoney(item.taxedAmountCents) : ""}" placeholder="0.00" aria-label="含税金额" /><input class="qe-tax" type="hidden" value="${taxRate}" /></td><td><textarea class="qe-notes" rows="1" placeholder="可选">${escapeHtml(item.notes || "")}</textarea></td><td class="qe-action"><button class="text-button qe-remove" type="button" aria-label="移除此行">×</button></td></tr>`;
}

function quoteRowHasContent(row) {
  return [".qe-name", ".qe-subitem", ".qe-taxed", ".qe-notes"].some(selector => row.querySelector(selector)?.value.trim());
}

function collectQuoteItems(section = "SUMMARY") {
  const label = section === "SUMMARY" ? "项目总价" : "项目费用明细";
  const rows = [...document.querySelectorAll(`.quote-editor-row[data-quote-section="${section}"]`)].filter(quoteRowHasContent);
  if (section === "SUMMARY" && !rows.length) throw new Error("项目总价至少需要填写一行");
  return rows.map((row, index) => {
    row.querySelectorAll(".quote-required-missing").forEach(element => element.classList.remove("quote-required-missing"));
    const name = row.querySelector(".qe-name");
    const unit = row.querySelector(".qe-unit");
    const quantity = row.querySelector(".qe-quantity");
    const taxed = row.querySelector(".qe-taxed");
    const missing = [];
    if (!name.value.trim()) { missing.push("项目"); name.classList.add("quote-required-missing"); }
    if (!unit.value.trim()) { missing.push("单位"); unit.classList.add("quote-required-missing"); }
    if (!quantity.value.trim()) { missing.push("数量"); quantity.classList.add("quote-required-missing"); }
    if (!taxed.value.trim()) { missing.push("含税金额"); taxed.classList.add("quote-required-missing"); }
    if (missing.length) throw new Error(`${label}第 ${index + 1} 行请填写：${missing.join("、")}`);
    return {
      category: label,
      itemName: name.value.trim(),
      subitemName: row.querySelector(".qe-subitem")?.value.trim() || null,
      unit: unit.value.trim(),
      quantityMilli: parseScaledDecimal(quantity.value, 3, `${label}第 ${index + 1} 行数量`),
      pricingMode: "TAXED_TOTAL",
      taxedAmountCents: parseScaledDecimal(taxed.value, 2, `${label}第 ${index + 1} 行含税金额`),
      taxRateBps: parseScaledDecimal(row.querySelector(".qe-tax").value, 2, `${label}第 ${index + 1} 行税率`),
      notes: row.querySelector(".qe-notes").value.trim() || null
    };
  });
}

function collectQuoteMetadata() {
  const customerName = document.querySelector("#quote-customer-display").value.trim();
  const customerContactName = document.querySelector("#quote-contact-name").value.trim();
  const customerPhone = document.querySelector("#quote-contact-phone").value.trim();
  const sellerName = document.querySelector("#quote-seller-name").value;
  const sellerPhone = document.querySelector("#quote-seller-phone").value;
  const sellerEmail = document.querySelector("#quote-seller-email").value;
  if (!customerName) throw new Error("请填写客户名称");
  if (!sellerPhone || !sellerEmail) throw new Error("请先在左下角账号资料中维护手机号码和邮箱");
  return {
    customerName,
    quoteDate: document.querySelector("#quote-date").value,
    validity: document.querySelector("#quote-validity").value,
    customerContactName,
    customerPhone,
    customerContactSource: "CUSTOMER_MANUAL",
    deliveryTerms: document.querySelector("#quote-delivery").value,
    paymentTerms: document.querySelector("#quote-payment").value,
    bankName: document.querySelector("#quote-bank").value,
    bankAccount: document.querySelector("#quote-account").value,
    sellerName,
    sellerPhone,
    sellerEmail
  };
}

function collectQuotePayload() {
  const items = collectQuoteItems("SUMMARY");
  const detailItems = collectQuoteItems("DETAIL");
  const mismatch = quoteDetailTotalsMismatch(items, detailItems);
  if (mismatch) throw new Error(quoteDetailTotalsMismatchMessage(mismatch));
  return { items, detailItems, metadata: collectQuoteMetadata(), finalDiscountCents: parseScaledDecimal(document.querySelector("#quote-final-price").value, 2, "最终优惠价"), notes: document.querySelector("#quote-notes").value };
}

function plainQuoteMoney(cents) {
  return (Number(cents || 0) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function quoteAmountUppercase(cents) {
  const value = Number(cents || 0);
  if (!Number.isSafeInteger(value) || value < 0) return "金额待校验";
  if (value === 0) return "零元整";
  const digits = "零壹贰叁肆伍陆柒捌玖";
  const units = ["分", "角", "元", "拾", "佰", "仟", "万", "拾", "佰", "仟", "亿", "拾", "佰", "仟", "兆"];
  const parts = String(value).split("").reverse().map((digit, index) => ({ digit: Number(digit), unit: units[index] || "" }));
  let result = "";
  let pendingZero = false;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const { digit, unit } = parts[index];
    if (digit === 0) {
      if (["兆", "亿", "万", "元"].includes(unit) && result && !result.endsWith(unit)) result += unit;
      pendingZero = Boolean(result) && !["兆", "亿", "万", "元"].includes(unit);
      continue;
    }
    if (pendingZero && !result.endsWith("零")) result += "零";
    result += `${digits[digit]}${unit}`;
    pendingZero = false;
  }
  result = result.replace(/亿万/g, "亿").replace(/零+/g, "零").replace(/零(兆|亿|万|元)/g, "$1");
  if (value % 100 === 0) return `${result.replace(/元.*$/, "元")}整`;
  if (value % 10 === 0 && !result.endsWith("角")) result += "整";
  return result;
}

function updateQuoteEditorSummary() {
  let subtotal = 0;
  let subtotalUntaxed = 0;
  let detailSubtotal = 0;
  let detailSubtotalUntaxed = 0;
  const summaryTaxRates = new Set();
  const roundingItems = { SUMMARY: [], DETAIL: [] };
  const detailRows = [];
  for (const row of document.querySelectorAll(".quote-editor-row")) {
    try {
      const quantity = parseScaledDecimal(row.querySelector(".qe-quantity").value, 3, "数量");
      const taxed = parseScaledDecimal(row.querySelector(".qe-taxed").value, 2, "含税金额");
      const tax = parseScaledDecimal(row.querySelector(".qe-tax").value, 2, "税率");
      const untaxed = Math.round(taxed * 10_000 / (10_000 + tax));
      const unitPrice = Math.round(untaxed * 1000 / quantity);
      roundingItems[row.dataset.quoteSection]?.push({ pricingMode: "TAXED_TOTAL", taxRateBps: tax, taxedAmountCents: taxed, untaxedAmountCents: untaxed });
      if (row.dataset.quoteSection === "DETAIL") detailRows.push(row);
      row.querySelector(".qe-unit-preview").textContent = plainQuoteMoney(unitPrice);
      row.querySelector(".qe-untaxed-preview").textContent = plainQuoteMoney(untaxed);
      if (row.dataset.quoteSection === "SUMMARY") {
        subtotal += taxed;
        subtotalUntaxed += untaxed;
        summaryTaxRates.add(tax);
      }
      else { detailSubtotal += taxed; detailSubtotalUntaxed += untaxed; }
    } catch {
      row.querySelector(".qe-unit-preview").textContent = "待校验";
      row.querySelector(".qe-untaxed-preview").textContent = "待校验";
    }
  }
  const finalInput = document.querySelector("#quote-final-price");
  if (finalInput && !finalInput.dataset.touched) finalInput.value = plainQuoteMoney(subtotal);
  document.querySelector("#quote-subtotal-untaxed").textContent = plainQuoteMoney(subtotalUntaxed);
  document.querySelector("#quote-subtotal-preview").textContent = plainQuoteMoney(subtotal);
  const taxRateLabel = document.querySelector("#quote-tax-rate-label");
  if (taxRateLabel) taxRateLabel.textContent = summaryTaxRates.size === 1 ? `${[...summaryTaxRates][0] / 100}%` : summaryTaxRates.size > 1 ? "各行所列税率" : "13%";
  let finalCents = subtotal;
  try { finalCents = parseScaledDecimal(finalInput.value, 2, "最终优惠价"); } catch { /* 由提交时显示错误 */ }
  const singleTaxRate = summaryTaxRates.size === 1 ? [...summaryTaxRates][0] : null;
  document.querySelector("#quote-final-untaxed").textContent = finalCents > 0 && finalCents === subtotal ? plainQuoteMoney(subtotalUntaxed)
    : finalCents > 0 && singleTaxRate !== null ? plainQuoteMoney(Math.round(finalCents * 10_000 / (10_000 + singleTaxRate))) : "—";
  document.querySelector("#quote-discount-note").textContent = subtotal > finalCents ? `优惠 ${plainQuoteMoney(subtotal - finalCents)} 元` : "";
  const roundingAdjustment = quoteDetailRoundingAdjustment(roundingItems.SUMMARY, roundingItems.DETAIL);
  const allocations = quoteDetailRoundingAllocations(roundingItems.SUMMARY, roundingItems.DETAIL);
  detailRows.forEach((row, index) => {
    row.querySelector(".qe-untaxed-preview").textContent = plainQuoteMoney(roundingItems.DETAIL[index].untaxedAmountCents + allocations[index]);
  });
  document.querySelector("#quote-detail-untaxed").textContent = plainQuoteMoney(detailSubtotalUntaxed + roundingAdjustment);
  document.querySelector("#quote-detail-preview").textContent = plainQuoteMoney(detailSubtotal);
  document.querySelector("#quote-amount-upper").textContent = quoteAmountUppercase(finalCents);
}

function resizeQuoteTextarea(textarea) {
  if (!textarea?.matches?.(".quote-editor-table textarea")) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 24), 120)}px`;
}

function setQuoteDiscountVisible(visible) {
  const row = document.querySelector("#quote-discount-row");
  const toggle = document.querySelector("[data-quote-discount-toggle]");
  const input = document.querySelector("#quote-final-price");
  if (!row || !toggle || !input) return;
  row.hidden = !visible;
  toggle.textContent = visible ? "取消优惠" : "+ 设置优惠";
  toggle.setAttribute("aria-expanded", String(visible));
  if (visible) input.focus();
  else {
    delete input.dataset.touched;
    updateQuoteEditorSummary();
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

async function openQuoteEditor(versionId = null, preselectedCustomerId = null) {
  if (!state.user.phone || !state.user.email) {
    openProfileDialog({ resumeQuote: true, quoteVersionId: versionId, preselectedCustomerId });
    return;
  }
  const [customersResult, projectsResult, quote] = await Promise.all([
    api("/api/customers"),
    api("/api/projects"),
    versionId ? api(`/api/quote-versions/${versionId}`) : Promise.resolve(null)
  ]);
  const customers = customersResult.items;
  const projects = projectsResult.items;
  if (!quote && !customers.length) {
    await openCustomerDialog({ fromQuote: true, onCreated: customer => openQuoteEditor(null, customer.id) });
    return;
  }
  const selectedCustomerId = quote?.customer.id || (customers.some(item => item.id === preselectedCustomerId) ? preselectedCustomerId : customers[0]?.id) || "";
  const rows = quote?.items?.length ? quote.items : [{}];
  const detailRows = quote?.detailItems?.length ? quote.detailItems : [{}];
  const meta = quote?.metadata || {};
  const today = new Date().toLocaleDateString("en-CA");
  const selectedCustomer = customers.find(customer => customer.id === selectedCustomerId);
  const sellerName = meta.sellerName || state.user.displayName || "";
  const sellerPhone = meta.sellerPhone || state.user.phone || "";
  const sellerEmail = meta.sellerEmail || state.user.email || "";
  const customerName = meta.customerName || quote?.customer.name || selectedCustomer?.fullName || "";
  const customerContact = quoteCustomerContact(meta);
  const customerContactName = customerContact.name;
  const customerPhone = customerContact.phone;
  const pendingQuoteFiles = [];
  const pendingQuotePreviews = new WeakMap();
  const hasDiscount = Boolean(quote && quote.discountAmountCents > 0);
  openDialog(quote ? "编辑报价" : "创建报价", `<div id="quote-editor" class="quote-editor-shell quote-reference-layout">${quote ? `<div class="quote-editor-save-state">内容自动保存；填写中的不完整行不会阻止继续编辑。<span id="draft-autosave-status" class="draft-save-status" aria-live="polite"></span></div>` : ""}<article class="quote-paper"><header class="quote-paper-header"><img class="quote-logo-img" src="/assets/quote-logo.png" alt="河南海弘软件技术有限公司 Logo" /><h1>软 件 报 价 单</h1></header><datalist id="quote-customer-options">${customers.map(item => `<option value="${escapeHtml(item.fullName)}"></option>${item.shortName ? `<option value="${escapeHtml(item.shortName)}"></option>` : ""}`).join("")}</datalist><section class="quote-paper-meta quote-reference-meta"><label><span>客　　户：</span><input id="quote-customer-display" list="quote-customer-options" value="${escapeHtml(customerName)}" placeholder="输入或选择客户名称" /></label><label><span>报价单位：</span><input value="河南海弘软件技术有限公司" readonly class="fixed-val" /></label><label><span>编　　号：</span><input id="quote-number" value="${escapeHtml(quote?.quoteNumber || "")}" readonly class="fixed-val" placeholder="保存后自动生成" /></label><label><span>地　　址：</span><input value="河南省鹤壁经济技术开发区渤海路 396 号" readonly class="fixed-val" /></label><label><span>联 系 人：</span><input id="quote-contact-name" value="${escapeHtml(sellerName)}" readonly class="fixed-val" /></label><label><span>邮　　编：</span><input value="458030" readonly class="fixed-val" /></label><label><span>日　　期：</span><input id="quote-date" value="${escapeHtml(meta.quoteDate || today)}" placeholder="YYYY-MM-DD" /></label><label><span>有 效 期：</span><input id="quote-validity" value="${escapeHtml(meta.validity || "30 天")}" /></label><label><span>手　　机：</span><input id="quote-contact-phone" value="${escapeHtml(sellerPhone)}" readonly class="fixed-val" /></label><label><span>电　　话：</span><input value="0392-3357155" readonly class="fixed-val" /></label></section>
    <section class="quote-paper-section"><h2>项目总价</h2><div class="table-wrap"><table class="quote-editor-table quote-summary-table"><thead><tr><th>序号</th><th>项目/型号</th><th>单位</th><th>数量</th><th>未税<br>单价(元)</th><th>未税<br>金额(元)</th><th>含税<br>金额(元)</th><th>备注</th><th></th></tr></thead><tbody id="quote-summary-items">${rows.map(item => quoteEditorRow(item, "SUMMARY")).join("")}</tbody><tfoot><tr><td colspan="5" class="qe-total-label">合计：</td><td id="quote-subtotal-untaxed">0.00</td><td id="quote-subtotal-preview">0.00</td><td></td><td class="qe-action"></td></tr><tr id="quote-discount-row" class="quote-final-row"${hasDiscount ? "" : " hidden"}><td colspan="5" class="qe-total-label">优惠后合计：</td><td id="quote-final-untaxed">—</td><td><input id="quote-final-price" inputmode="decimal" value="${quote ? plainQuoteMoney(quote.finalDiscountCents) : ""}" ${hasDiscount ? "data-touched=\"true\"" : ""} placeholder="填写优惠后金额" /></td><td id="quote-discount-note" class="qe-discount-note"></td><td class="qe-action"></td></tr></tfoot></table></div><div class="quote-add-row-wrap"><button class="quote-add-row" type="button" data-add-quote-row="SUMMARY">+ 添加总价行</button><button class="quote-add-row" type="button" data-quote-discount-toggle aria-expanded="${hasDiscount}">${hasDiscount ? "取消优惠" : "+ 设置优惠"}</button></div></section>
    <section class="quote-paper-section"><h2>项目费用明细</h2><div class="table-wrap"><table class="quote-editor-table quote-detail-table"><thead><tr><th>序号</th><th>项目</th><th>子项</th><th>单位</th><th>数量</th><th>未税<br>单价(元)</th><th>未税<br>金额(元)</th><th>含税<br>金额(元)</th><th>备注</th><th></th></tr></thead><tbody id="quote-detail-items">${detailRows.map(item => quoteEditorRow(item, "DETAIL")).join("")}</tbody><tfoot><tr><td colspan="6" class="qe-total-label">合计：</td><td id="quote-detail-untaxed">0.00</td><td id="quote-detail-preview">0.00</td><td></td><td class="qe-action"></td></tr><tr><td colspan="10" class="quote-note-cell"><textarea id="quote-notes" rows="1" placeholder="备注 / 注意事项（必填）">${escapeHtml(quote?.notes || "注：不含第三方设备、系统开放及开发接口协议费用")}</textarea></td></tr></tfoot></table></div><div class="quote-add-row-wrap"><button class="quote-add-row" type="button" data-add-quote-row="DETAIL">+ 添加明细行</button></div></section>
    <section class="quote-paper-terms"><div class="quote-uppercase-line">含 <strong id="quote-tax-rate-label">13%</strong> 增值税，合计金额（大写）：<strong id="quote-amount-upper">零元整</strong></div><label><span>交　　期：</span><input id="quote-delivery" value="${escapeHtml(meta.deliveryTerms || "按双方合同约定")}" /></label><label><span>付款方式：</span><input id="quote-payment" value="${escapeHtml(meta.paymentTerms || "按双方合同约定")}" /></label><label><span>开 户 行：</span><input id="quote-bank" value="${escapeHtml(meta.bankName || "")}" /></label><label><span>账　　号：</span><input id="quote-account" value="${escapeHtml(meta.bankAccount || "")}" /></label></section><p class="quote-service-copy">倘若您对以上内容有任何疑义，请及时与我们联系。我们将竭诚为您服务！</p><section class="quote-sign"><label><span>报 价 人：</span><input id="quote-seller-name" value="${escapeHtml(sellerName)}" readonly class="fixed-val" /></label><label><span>手　　机：</span><input id="quote-seller-phone" value="${escapeHtml(sellerPhone)}" readonly class="fixed-val" /></label><label><span>邮　　箱：</span><input id="quote-seller-email" type="email" value="${escapeHtml(sellerEmail)}" readonly class="fixed-val" /></label></section></article>${quote ? quoteInlineAttachments(quote.attachments, quote.id) : `<section id="quote-pending-inline" class="quote-inline-attachments" hidden></section>`}<div class="quote-system-panel">${quote ? `${quoteApprovalTimeline(quote)}${attachmentBlock({ title: "报价附件", data: quote.attachments, targetType: "QUOTE_VERSION", targetId: quote.id, writable: true })}` : `<section class="detail-section pending-quote-attachments"><div class="card-head"><h3>报价附件 <span class="muted" id="pending-quote-file-count">(0)</span></h3><button class="button small" type="button" id="pending-quote-file-pick">+ 添加文件</button><input id="pending-quote-files" class="attachment-file-input" type="file" accept=".docx" multiple /></div><ul class="list attachment-list" id="pending-quote-file-list"><li class="empty attachment-empty">暂无附件</li></ul><small class="attachment-help">仅支持 Word（DOCX），单文件不超过 20 MB。</small></section>`}</div></div>`, {
    extraWide: true,
    dialogClass: "quote-editor-dialog",
    submitLabel: quote ? "保存修改" : "保存报价",
    onSubmit: async () => {
      if (quote) await activeDraftAutosave?.flush();
      const payload = collectQuotePayload();
      if (quote) await api(`/api/quote-versions/${quote.id}`, { method: "PATCH", body: JSON.stringify({ ...payload, expectedDraftEtag: activeDraftAutosave?.getState().etag }) });
      else {
        const enteredName = document.querySelector("#quote-customer-display").value.trim();
        const exactMatches = customers.filter(item => item.fullName === enteredName || item.shortName === enteredName);
        if (exactMatches.length > 1) throw new Error("客户名称有重复，请输入客户全称");
        const customer = exactMatches[0];
        if (!customer) {
          await openCustomerDialog({ initialName: enteredName, fromQuote: true, onCreated: async createdCustomer => {
            customers.push(createdCustomer);
            const input = document.querySelector("#quote-customer-display");
            const list = document.querySelector("#quote-customer-options");
            if (input) input.value = createdCustomer.fullName;
            if (list) list.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(createdCustomer.fullName)}"></option>`);
            setTimeout(() => document.querySelector("#dialog-submit")?.click(), 0);
          } });
          return;
        }
        let project = projects.find(item => item.customerId === customer.id && item.active !== false);
        if (!project) project = await api(`/api/customers/${encodeURIComponent(customer.id)}/projects`, { method: "POST", body: JSON.stringify({ name: `${customer.shortName || customer.fullName} 报价`, summary: "报价单内部关联" }) });
        const created = await api("/api/quotes", { method: "POST", body: JSON.stringify({ ...payload, customerId: customer.id, projectId: project.id }) });
        try {
          for (const file of pendingQuoteFiles) {
            const form = new FormData();
            form.set("targetType", "QUOTE_VERSION");
            form.set("targetId", created.id);
            form.set("requestKey", crypto.randomUUID());
            form.set("file", file, file.name);
            await api("/api/attachments/upload", { method: "POST", body: form });
          }
        } catch (error) {
          closeDialog();
          await refreshQuoteContext();
          showToast(`报价已保存，但有附件未上传：${error.message}`);
          return;
        }
      }
      closeDialog();
      showToast(pendingQuoteFiles.length ? "报价及附件已保存，当前状态为未发送" : "报价已保存，当前状态为未发送");
      await refreshQuoteContext();
    }
  });
  const customerContactInput = document.querySelector("#quote-contact-name");
  const customerPhoneInput = document.querySelector("#quote-contact-phone");
  if (customerContactInput) {
    customerContactInput.value = customerContactName;
    customerContactInput.readOnly = false;
    customerContactInput.classList.remove("fixed-val");
    customerContactInput.placeholder = "";
  }
  if (customerPhoneInput) {
    customerPhoneInput.value = customerPhone;
    customerPhoneInput.readOnly = false;
    customerPhoneInput.classList.remove("fixed-val");
    customerPhoneInput.placeholder = "";
  }
  const quoteEditorRoot = document.querySelector("#quote-editor");
  const renderPendingQuoteFiles = () => {
    const list = quoteEditorRoot.querySelector("#pending-quote-file-list");
    const count = quoteEditorRoot.querySelector("#pending-quote-file-count");
    if (!list || !count) return;
    count.textContent = `(${pendingQuoteFiles.length})`;
    list.innerHTML = pendingQuoteFiles.length ? pendingQuoteFiles.map((file, index) => `<li><div><strong>${escapeHtml(file.name)}</strong><small>${(file.size / 1024).toFixed(1)} KB</small></div><div class="actions"><button class="button small" type="button" data-pending-quote-file-preview="${index}">在线查看</button><button class="button small danger" type="button" data-pending-quote-file-remove="${index}">移除</button></div></li>`).join("") : `<li class="empty attachment-empty">暂无附件</li>`;
    const inline = quoteEditorRoot.querySelector("#quote-pending-inline");
    if (!inline) return;
    inline.hidden = !pendingQuoteFiles.length;
    inline.innerHTML = pendingQuoteFiles.map((file, index) => {
      const preview = pendingQuotePreviews.get(file);
      const content = preview?.html ? `<iframe class="quote-inline-attachment-frame" sandbox="allow-same-origin" title="${escapeHtml(file.name)} 内容预览" data-pending-inline-index="${index}"></iframe>`
        : `<div class="quote-inline-preview-status">${escapeHtml(preview?.error || "正在加载附件内容…")}</div>`;
      return `<article class="quote-inline-attachment"><h3>附件 ${index + 1}：${escapeHtml(file.name)}</h3>${content}</article>`;
    }).join("");
    for (const frame of inline.querySelectorAll("[data-pending-inline-index]")) {
      const file = pendingQuoteFiles[Number(frame.dataset.pendingInlineIndex)];
      frame.srcdoc = pendingQuotePreviews.get(file)?.html || "";
    }
  };
  const loadPendingQuotePreview = file => {
    const existing = pendingQuotePreviews.get(file);
    if (existing?.html) return Promise.resolve(existing.html);
    if (existing?.promise) return existing.promise;
    const promise = (async () => {
      try {
        const form = new FormData();
        form.set("file", file, file.name);
        const preview = await api("/api/quote-attachments/preview", { method: "POST", body: form });
        pendingQuotePreviews.set(file, { html: preview.html });
        return preview.html;
      } catch (error) {
        pendingQuotePreviews.set(file, { error: `无法在线查看：${error.message}` });
        throw error;
      } finally {
        if (pendingQuoteFiles.includes(file)) renderPendingQuoteFiles();
      }
    })();
    pendingQuotePreviews.set(file, { promise });
    return promise;
  };
  document.querySelector("#pending-quote-file-pick")?.addEventListener("click", () => document.querySelector("#pending-quote-files")?.click());
  document.querySelector("#pending-quote-files")?.addEventListener("change", event => {
    for (const file of event.target.files || []) {
      const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
      if (extension !== ".docx") { showToast(`${file.name}：仅支持 Word（DOCX）`); continue; }
      if (file.size > 20 * 1024 * 1024) { showToast(`${file.name}：文件不能超过 20 MB`); continue; }
      if (!pendingQuoteFiles.some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) {
        pendingQuoteFiles.push(file);
        void loadPendingQuotePreview(file).catch(() => {});
      }
    }
    event.target.value = "";
    renderPendingQuoteFiles();
  });
  document.querySelector("#quote-editor").addEventListener("click", async event => {
    const discountToggle = event.target.closest("[data-quote-discount-toggle]");
    if (discountToggle) {
      setQuoteDiscountVisible(document.querySelector("#quote-discount-row").hidden);
      return;
    }
    const previewButton = event.target.closest("[data-pending-quote-file-preview]");
    if (previewButton && !previewButton.disabled) {
      const file = pendingQuoteFiles[Number(previewButton.dataset.pendingQuoteFilePreview)];
      if (!file) return;
      previewButton.disabled = true;
      try {
        const html = await loadPendingQuotePreview(file);
        openDialog("查看附件", `<iframe id="pending-quote-preview-frame" class="attachment-preview-frame" sandbox="allow-same-origin" title="附件内容预览"></iframe>`, { extraWide: true });
        document.querySelector("#pending-quote-preview-frame").srcdoc = html;
      } catch (error) { showToast(error.message); }
      finally { previewButton.disabled = false; }
      return;
    }
    const remove = event.target.closest("[data-pending-quote-file-remove]");
    if (!remove) return;
    pendingQuoteFiles.splice(Number(remove.dataset.pendingQuoteFileRemove), 1);
    renderPendingQuoteFiles();
  });
  document.querySelector("#quote-editor").addEventListener("input", event => {
    if (event.target.id === "quote-final-price") event.target.dataset.touched = "true";
    event.target.classList?.remove("quote-required-missing");
    resizeQuoteTextarea(event.target);
    updateQuoteEditorSummary();
  });
  document.querySelector("#quote-editor").addEventListener("change", event => {
    event.target.classList?.remove("quote-required-missing");
    updateQuoteEditorSummary();
  });
  document.querySelector("#quote-editor").addEventListener("focusin", event => {
    if (event.target.matches?.(".qe-taxed, #quote-final-price")) event.target.value = event.target.value.replaceAll(",", "");
  });
  document.querySelector("#quote-editor").addEventListener("focusout", event => {
    if (!event.target.matches?.(".qe-taxed, #quote-final-price") || !event.target.value.trim()) return;
    try { event.target.value = plainQuoteMoney(parseScaledDecimal(event.target.value, 2, "金额")); } catch { /* 提交时说明格式错误 */ }
  });
  document.querySelectorAll(".quote-editor-table textarea").forEach(resizeQuoteTextarea);
  updateQuoteEditorSummary();
  if (quote) {
    startDialogAutosave({
      root: document.querySelector("#quote-editor"),
      initialEtag: quote.draftEtag,
      initialSavedAt: quote.draftSavedAt || quote.createdAt,
      collect: collectQuotePayload,
      save: payload => api(`/api/quote-versions/${quote.id}`, { method: "PATCH", body: JSON.stringify(payload) }),
      delay: 2500
    });
  }
}

function quoteHandoffSection(quote) {
  return `${quote.pendingManagerIssue ? `<div class="notice">${escapeHtml(quote.pendingManagerIssue.message)}</div>` : quote.pendingManager ? `<div class="notice">当前待审研发部经理：${escapeHtml(quote.pendingManager.displayName)}</div>` : ""}${quote.handoffs?.length ? `<section class="detail-section"><h2>研发部经理交接记录</h2><ul class="list">${quote.handoffs.map(item => `<li><div><strong>${escapeHtml(item.previousManager?.displayName || "未设置")} → ${escapeHtml(item.newManager.displayName)}</strong><small>${escapeHtml(item.operatedBy.displayName)} · ${formatTime(item.createdAt)} · ${escapeHtml(item.reason)}</small></div></li>`).join("")}</ul></section>` : ""}`;
}

function quoteVersionArchive(quote) {
  const history = Array.isArray(quote.versionHistory) ? [...quote.versionHistory].reverse() : [];
  if (!history.length) return "";
  return `<section class="detail-section quote-version-archive"><div class="card-head"><div><h2>历史报价与文件</h2><small>每次调价或退回均保留原报价、审批记录和当时锁定的附件</small></div><span class="tag">${history.length} 个历史版本</span></div><ul class="list">${history.map(version => `<li><div><strong>${escapeHtml(version.versionLabel)} · ${escapeHtml(quoteStatusLabel(version))}</strong><small>创建于 ${formatTime(version.createdAt)}${version.submittedAt ? ` · 发送于 ${formatTime(version.submittedAt)}` : ""} · ${version.approvals?.length || 0} 条审批记录</small></div><button class="button small" type="button" data-quote-view="${version.id}">查看原报价与文件</button></li>`).join("")}</ul></section>`;
}

function quoteApprovalTimeline(quote, { showCurrentQuoteLink = false } = {}) {
  const approvals = Array.isArray(quote.approvals) ? quote.approvals : [];
  const history = Array.isArray(quote.versionHistory) ? quote.versionHistory : [];
  const records = [
    ...history.flatMap(version => {
      const entries = Array.isArray(version.approvals) ? version.approvals : [];
      const reference = { versionId: version.id, versionLabel: version.versionLabel, canView: version.canView !== false };
      return entries.length ? entries.map(approval => ({ ...approval, ...reference })) : [{ ...reference, noApproval: true }];
    }),
    ...approvals.map(approval => ({ ...approval, versionId: quote.id, versionLabel: quote.versionLabel, canView: true }))
  ];
  const currentStage = approvalStageLabels[quote.currentApprovalStage];
  const pendingReviewer = quote.currentApprovalStage === "MANAGER" ? quote.pendingManager?.displayName : null;
  const previous = history.at(-1);
  const pendingText = ["PENDING_MANAGER", "PENDING_VP"].includes(quote.status) && currentStage
    ? `当前待${currentStage}${pendingReviewer ? `（${pendingReviewer}）` : ""}`
    : quote.status === "APPROVED" ? "审批已全部完成" : ["MANAGER_RETURNED", "VP_RETURNED"].includes(quote.status) ? "审批已退回" : previous && ["MANAGER_RETURNED", "VP_RETURNED"].includes(previous.status) ? `上版 ${previous.versionLabel} 已退回；当前版本修改后可重新发送` : previous?.status === "APPROVED" ? `上版 ${previous.versionLabel} 已审批；当前为调价新版本` : "报价尚未发送审批";
  return `<section class="quote-approval-panel"><div class="quote-approval-heading"><div><span class="section-kicker">内部审核留痕</span><h2>审批记录</h2></div><span class="tag ${quote.status === "APPROVED" ? "green" : "orange"}">${escapeHtml(quoteStatusLabel(quote))}</span></div><div class="quote-approval-current">${escapeHtml(pendingText)}</div>${records.length ? `<div class="table-wrap"><table class="quote-approval-records">
    <colgroup><col class="quote-col-version" /><col class="quote-col-stage" /><col class="quote-col-reviewer" /><col class="quote-col-result" /><col class="quote-col-time" /><col /><col class="quote-col-action" /></colgroup>
    <thead><tr><th>版本</th><th>审核环节</th><th>审核人</th><th>审核结果</th><th>审核时间</th><th>备注</th><th>操作</th></tr></thead><tbody>${records.map(approval => {
      const comment = String(approval.comment || "");
      const canView = approval.canView && approval.versionId && (showCurrentQuoteLink || approval.versionId !== quote.id);
      return `<tr><td data-label="版本">${escapeHtml(approval.versionLabel)}</td><td data-label="审核环节">${approval.noApproval ? "—" : escapeHtml(approvalStageLabels[approval.stage] || "报价审核")}</td><td data-label="审核人">${approval.noApproval ? "—" : escapeHtml(approval.approver.displayName)}</td><td data-label="审核结果">${approval.noApproval ? "尚无审批" : `<span class="tag ${approval.decision === "APPROVED" ? "green" : "red"}">${escapeHtml(displayEnum(approval.decision, approvalDecisionLabels, "已处理"))}</span>`}</td><td data-label="审核时间">${approval.noApproval ? "—" : formatTime(approval.createdAt)}</td><td class="quote-record-comment-cell" data-label="备注">${comment.trim() ? `<button class="text-button quote-record-comment" type="button" data-quote-comment aria-label="查看完整审批备注">${escapeHtml(comment)}</button>` : "—"}</td><td class="quote-record-action" data-label="操作">${canView ? `<button class="button small quote-record-file" type="button" data-quote-view="${escapeHtml(approval.versionId)}" aria-label="查看 ${escapeHtml(approval.versionLabel)} 的报价单">查看报价</button>` : "—"}</td></tr>`;
    }).join("")}</tbody></table></div>` : `<div class="empty compact">尚无审批记录；发送后将自动记录审核人、审核时间和备注。</div>`}</section>`;
}

let quoteCommentHint = null;
let quoteCommentHideTimer;

function hideQuoteCommentHint() {
  clearTimeout(quoteCommentHideTimer);
  if (!quoteCommentHint) return;
  quoteCommentHint.trigger.removeAttribute("aria-describedby");
  quoteCommentHint.tooltip.remove();
  quoteCommentHint = null;
}

function showQuoteCommentHint(trigger, pinned = false) {
  clearTimeout(quoteCommentHideTimer);
  if (quoteCommentHint?.trigger === trigger) {
    if (pinned) quoteCommentHint.pinned = true;
    return;
  }
  hideQuoteCommentHint();
  const tooltip = document.createElement("div");
  tooltip.id = "quote-comment-hint";
  tooltip.className = "quote-comment-hint";
  tooltip.setAttribute("role", "tooltip");
  tooltip.textContent = trigger.textContent;
  const container = trigger.closest(".dialog-backdrop") || document.body;
  container.append(tooltip);
  const anchor = trigger.getBoundingClientRect();
  const margin = 8;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const below = anchor.bottom + margin;
  const top = below + height + margin <= window.innerHeight ? below : anchor.top - height - margin;
  tooltip.style.left = `${Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))}px`;
  tooltip.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`;
  trigger.setAttribute("aria-describedby", tooltip.id);
  quoteCommentHint = { trigger, tooltip, pinned };
}

function quoteExportedFiles(quote) {
  const files = Array.isArray(quote.exportedFiles) ? quote.exportedFiles : [];
  if (!files.length) return "";
  return `<section class="detail-section"><div class="card-head"><h2>已导出 Word</h2></div><ul class="list">${files.map(file => `<li><div><strong>${escapeHtml(file.originalName)}</strong><small>${formatTime(file.createdAt)}</small></div><button class="button small" type="button" data-file-download="${escapeHtml(file.id)}">下载原文件</button></li>`).join("")}</ul></section>`;
}

function quotePaperContent(quote) {
  if (quote.sourceKind !== "UPLOADED") return `${quoteReadonlyPaper(quote)}${quoteInlineAttachments(quote.attachments, quote.id)}`;
  return quoteInlineAttachments(quote.attachments, quote.id, "报价单");
}

function quoteBindingPanel(binding) {
  if (!binding) return "";
  const customer = binding.customer, amount = binding.amount;
  const messages = (binding.fixedFields?.issues || []).map(issue => issue.message);
  if (customer.status === "MISMATCH") messages.push(`客户名称不一致：文件为“${customer.actual}”，所选客户为“${customer.expected}”。请更换文件；如果选错客户，请重新上传并选择正确客户。`);
  else if (customer.status === "UNRECOGNIZED" && !binding.fixedFields?.issues?.some(issue => issue.field === "客户")) messages.push("无法识别文件中的客户名称，请检查报价单。");
  if (amount.status === "MISMATCH") messages.push(`含税总额不一致：文件为 ${formatMoney(amount.actualCents)}，填写为 ${formatMoney(amount.expectedCents)}。请修正金额或更换报价文件。`);
  else if (amount.status === "UNRECOGNIZED") messages.push("未能识别报价单的最终含税总额，金额未核对。");
  if (!messages.length) return "";
  const blocking = binding.hasMismatch || binding.fixedFields?.errorCount || customer.status === "UNRECOGNIZED";
  return `<section class="quote-binding-check ${blocking ? "is-error" : "is-warning"}" role="status"><strong>${blocking ? "报价单有待处理的问题" : "金额未核对，可继续上传和送审"}</strong>${messages.map(message => `<p>${escapeHtml(message)}</p>`).join("")}</section>`;
}

function quoteUploadedWordSource(quote, writable = false) {
  if (quote.sourceKind !== "UPLOADED") return "";
  const items = attachmentItemsFor(quote.attachments, "QUOTE_VERSION", quote.id, "QUOTE_WORD");
  if (!writable && !items.length) return "";
  return attachmentBlock({ title: "Word 源文件（选填）", data: quote.attachments, targetType: "QUOTE_VERSION", targetId: quote.id, targetKey: "QUOTE_WORD", writable, uploadedSource: true });
}

async function openQuoteDocumentReview(versionId) {
  const preview = await api(`/api/quote-versions/${encodeURIComponent(versionId)}/document-review/boundary`);
  openDialog("检查主报价", quoteBoundaryOptions(preview), {
    wide: true,
    submitLabel: "开始检查",
    onSubmit: async () => {
      const value = document.querySelector("#quote-review-boundary").value;
      if (value === "") throw new Error("请选择主报价结束位置");
      const review = await api(`/api/quote-versions/${encodeURIComponent(versionId)}/document-review`, { method: "POST", body: JSON.stringify({
        endIndex: Number(value), attachmentVersionId: preview.attachmentVersionId, draftEtag: preview.draftEtag
      }) });
      closeDialog();
      const slot = [...document.querySelectorAll("[data-quote-review-slot]")].find(item => item.dataset.quoteReviewSlot === versionId);
      if (slot) {
        slot.innerHTML = quoteReviewPanel(review, { canCheck: true, versionId });
        const confirmation = document.querySelector("#uploaded-review-confirm");
        if (confirmation) confirmation.checked = false;
        showToast(review.errorCount ? "检查完成，请先修正明确问题" : "检查完成，请核对待确认项目");
      } else {
        openDialog("检查结果", quoteReviewPanel(review, { canCheck: true, versionId }), { wide: true });
      }
    }
  });
}

async function openUploadedQuoteSubmitDialog(quote) {
  const versionId = quote.id;
  const binding = (await api(`/api/quote-versions/${encodeURIComponent(versionId)}/binding-check`)).binding;
  openDialog("发送审批", `<div class="quote-editor-shell quote-reference-layout">${quoteBindingPanel(binding)}${quotePaperContent(quote)}<div class="quote-system-panel"><div class="notice">发送后依次由研发部经理、综合部经理和副总经理审核。</div>${quoteHandoffSection(quote)}${quoteApprovalTimeline(quote)}</div></div>`, {
    extraWide: true,
    dialogClass: "quote-editor-dialog",
    submitLabel: "确认发送审批",
    onSubmit: async () => {
      await api(`/api/quote-versions/${encodeURIComponent(versionId)}/submit`, { method: "POST", body: JSON.stringify({}) });
      closeDialog(); showToast("报价已发送研发部经理审核"); await refreshQuoteContext();
    }
  });
}

async function openUploadedQuoteEditor(versionId = null) {
  let quote = versionId ? await api(`/api/quote-versions/${versionId}`) : null;
  const initialBinding = quote ? (await api(`/api/quote-versions/${encodeURIComponent(versionId)}/binding-check`)).binding : null;
  const [customersResult, projectsResult] = await Promise.all([api("/api/customers"), api("/api/projects")]);
  const customers = customersResult.items;
  const projects = projectsResult.items;
  if (!quote && !customers.length) {
    await openCustomerDialog({ fromQuote: true, onCreated: () => openUploadedQuoteEditor() });
    return;
  }
  const selectedCustomer = quote?.customer.id || "";
  let source = quote?.attachments?.items?.find(item => !item.targetKey);
  let pdfRequestKey = crypto.randomUUID();
  let bindingGeneration = 0;
  const showBindingResult = binding => {
    const slot = document.querySelector("#uploaded-binding-result");
    if (slot) slot.innerHTML = quoteBindingPanel(binding);
  };
  openDialog(quote ? "重新上传报价单" : "上传报价单", `<div class="field"><label class="required" for="uploaded-quote-customer">客户</label><select id="uploaded-quote-customer" ${quote ? "disabled" : ""}><option value="">请选择客户</option>${customers.map(customer => `<option value="${escapeHtml(customer.id)}"${customer.id === selectedCustomer ? " selected" : ""}>${escapeHtml(customer.fullName)}</option>`).join("")}</select></div><div class="field"><label class="required" for="uploaded-quote-amount">报价单含税总额（元）</label><input id="uploaded-quote-amount" inputmode="decimal" value="${quote ? plainQuoteMoney(quote.finalDiscountCents) : ""}" placeholder="请按文件填写" /></div><div class="field"><label class="required" for="uploaded-quote-file">PDF 报价单</label><input id="uploaded-quote-file" type="file" accept=".pdf,application/pdf" /><small>上传后自动检查客户、金额及固定信息。</small></div><div id="uploaded-binding-result" aria-live="polite">${quoteBindingPanel(initialBinding)}</div>${quote ? `<div class="notice">原文件与审批记录会保留。</div>` : ""}`, {
    wide: true,
    submitLabel: "保存报价",
    onSubmit: async () => {
      const customerId = document.querySelector("#uploaded-quote-customer").value;
      const amountCents = parseScaledDecimal(document.querySelector("#uploaded-quote-amount").value, 2, "报价单含税总额");
      const file = document.querySelector("#uploaded-quote-file").files[0];
      if (!customerId) throw new Error("请选择客户");
      if (quote && customerId !== quote.customer.id) throw new Error("已保存的报价不能更改关联客户，请重新创建报价");
      if (!amountCents) throw new Error("请填写报价单含税总额");
      if (!file) throw new Error("请选择 PDF 报价单");
      if (file && !/\.pdf$/i.test(file.name)) throw new Error("请上传 PDF 报价单");
      const generation = bindingGeneration;
      let binding;
      if (file) {
        const form = new FormData(); form.set("customerId", customerId); form.set("amountCents", String(amountCents)); form.set("file", file, file.name);
        binding = await api("/api/uploaded-quotes/preflight", { method: "POST", body: form });
      } else {
        binding = (await api(`/api/quote-versions/${encodeURIComponent(quote.id)}/binding-check`, { method: "POST", body: JSON.stringify({ amountCents }) })).binding;
      }
      if (generation !== bindingGeneration) throw new Error("填写内容已变化，请重新核对后保存");
      showBindingResult(binding);
      if (binding?.hasMismatch || binding?.customer?.status === "UNRECOGNIZED" || binding?.fixedFields?.errorCount) throw new Error("报价单有问题，请按上方提示修改后重新上传");
      if (!quote) {
        const customer = customers.find(item => item.id === customerId);
        if (!customer) throw new Error("客户不存在，请刷新后重试");
        let project = projects.find(item => item.customerId === customerId && item.active !== false);
        if (!project) project = await api(`/api/customers/${encodeURIComponent(customerId)}/projects`, { method: "POST", body: JSON.stringify({ name: `${customer.shortName || customer.fullName} 报价`, summary: "报价单内部关联" }) });
        quote = await api("/api/uploaded-quotes", { method: "POST", body: JSON.stringify({ customerId, projectId: project.id, amountCents }) });
        document.querySelector("#uploaded-quote-customer").disabled = true;
      }
      if (file) {
        const form = new FormData();
        form.set("targetType", "QUOTE_VERSION"); form.set("targetId", quote.id); form.set("requestKey", pdfRequestKey);
        form.set("amountCents", String(amountCents)); form.set("expectedDraftEtag", String(quote.draftEtag));
        if (source) { form.set("attachmentId", source.id); form.set("expectedCurrentVersionId", source.currentVersionId); }
        form.set("file", file, file.name);
        source = await api("/api/attachments/upload", { method: "POST", body: form });
        quote = await api(`/api/quote-versions/${encodeURIComponent(quote.id)}`);
      }
      closeDialog();
      showToast(binding?.amount?.status === "UNRECOGNIZED" ? "报价已上传，金额未能自动核对" : "报价已上传，可发送审批");
      await refreshQuoteContext();
    }
  });
  const inspectSelectedFile = async () => {
    const customerId = document.querySelector("#uploaded-quote-customer")?.value;
    const value = document.querySelector("#uploaded-quote-amount")?.value;
    const file = document.querySelector("#uploaded-quote-file")?.files?.[0];
    const slot = document.querySelector("#uploaded-binding-result");
    if (!customerId || !value || !file || !/\.pdf$/i.test(file.name) || !slot) return;
    const generation = bindingGeneration;
    try {
      const amountCents = parseScaledDecimal(value, 2, "报价单含税总额");
      if (!amountCents) return;
      slot.textContent = "正在核对文件中的客户和金额…";
      const form = new FormData(); form.set("customerId", customerId); form.set("amountCents", String(amountCents)); form.set("file", file, file.name);
      const binding = await api("/api/uploaded-quotes/preflight", { method: "POST", body: form });
      if (generation === bindingGeneration && slot.isConnected !== false) showBindingResult(binding);
    } catch (error) {
      if (generation === bindingGeneration && slot.isConnected !== false) slot.textContent = error.message;
    }
  };
  document.querySelector("#uploaded-quote-customer")?.addEventListener?.("change", () => { bindingGeneration++; const slot = document.querySelector("#uploaded-binding-result"); if (slot) slot.innerHTML = ""; void inspectSelectedFile(); });
  document.querySelector("#uploaded-quote-amount")?.addEventListener?.("input", () => { bindingGeneration++; const slot = document.querySelector("#uploaded-binding-result"); if (slot) slot.innerHTML = ""; });
  document.querySelector("#uploaded-quote-amount")?.addEventListener?.("change", () => { void inspectSelectedFile(); });
  document.querySelector("#uploaded-quote-file")?.addEventListener?.("change", () => { bindingGeneration++; pdfRequestKey = crypto.randomUUID(); const slot = document.querySelector("#uploaded-binding-result"); if (slot) slot.innerHTML = ""; void inspectSelectedFile(); });
}

async function openQuoteView(versionId) {
  const quote = await api(`/api/quote-versions/${versionId}`);
  const attachmentWritable = quote.status === "DRAFT" && ["PRESALES", "ADMIN"].includes(state.user.role);
  const binding = quote.sourceKind === "UPLOADED" && quote.status === "DRAFT" ? (await api(`/api/quote-versions/${encodeURIComponent(versionId)}/binding-check`)).binding : null;
  const review = quote.sourceKind === "UPLOADED" && quote.status !== "DRAFT" ? (await api(`/api/quote-versions/${encodeURIComponent(versionId)}/document-review`)).review : null;
  const amountWarning = review?.amountVerification === "UNRECOGNIZED" ? `<div class="notice warning">未能识别报价单的最终含税总额，金额未核对。</div>` : "";
  openDialog(quote.versionLabel ? `查看报价 · ${quote.versionLabel}` : "查看报价", `<div class="quote-editor-shell quote-reference-layout">${quoteBindingPanel(binding)}${amountWarning}${quotePaperContent(quote)}<div class="quote-system-panel">${quoteHandoffSection(quote)}${quoteApprovalTimeline(quote)}${quote.sourceKind === "UPLOADED" ? "" : `${attachmentBlock({ title: quote.status === "DRAFT" ? "报价附件" : "审批附件", data: quote.attachments, targetType: "QUOTE_VERSION", targetId: quote.id, writable: attachmentWritable })}`}</div></div>`, { extraWide: true, dialogClass: "quote-editor-dialog" });
}

async function openApprovedQuoteRevisionDialog(versionId) {
  const quote = await api(`/api/quote-versions/${versionId}`);
  const notice = quote.sourceKind === "UPLOADED" ? "系统将建立新的报价版本；请重新上传调整后的 PDF 并重新审批。原文件和审批记录会保留。" : "不会覆盖已审批版本。系统将复制当前内容和附件，建立新的“未发送”版本；修改价格后必须重新走完整三级审批。";
  openDialog("调整价格", `<div class="notice warning">${notice}</div><div class="field"><label class="required">调整原因</label><textarea id="quote-revision-reason" placeholder="例如：客户调整采购范围，需重新核价"></textarea></div>${quoteApprovalTimeline(quote, { showCurrentQuoteLink: true })}`, {
    wide: true,
    submitLabel: "创建调价版本",
    onSubmit: async () => {
      const created = await api(`/api/quote-versions/${versionId}/revise`, { method: "POST", body: JSON.stringify({ reason: document.querySelector("#quote-revision-reason").value }) });
      closeDialog();
      showToast(`已创建 ${created.versionLabel}，原审批版本保持不变`);
      if (created.sourceKind === "UPLOADED") await openUploadedQuoteEditor(created.id);
      else await openQuoteEditor(created.id);
    }
  });
}

async function openQuoteDecisionDialog(versionId) {
  const quote = await api(`/api/quote-versions/${versionId}`);
  const review = quote.sourceKind === "UPLOADED" ? (await api(`/api/quote-versions/${encodeURIComponent(versionId)}/document-review`)).review : null;
  const amountWarning = review?.amountVerification === "UNRECOGNIZED" ? `<div class="notice warning">未能识别报价单的最终含税总额，金额未核对。</div>` : "";
  let selectedDecision = "APPROVED";
  let commentInput;
  const comments = { APPROVED: "通过", REJECTED: "" };
  openDialog("处理审批", `<div class="quote-editor-shell quote-reference-layout">${amountWarning}${quotePaperContent(quote)}<div class="quote-system-panel">${quoteHandoffSection(quote)}${quoteApprovalTimeline(quote)}${quote.sourceKind === "UPLOADED" ? "" : attachmentBlock({ title: "审批附件", data: quote.attachments, targetType: "QUOTE_VERSION", targetId: quote.id })}<section class="quote-decision-panel"><fieldset class="quote-decision-options"><legend>审批结果</legend><div class="quote-decision-choices"><label class="quote-decision-choice"><input type="radio" name="quote-decision" value="APPROVED" checked /><span>通过</span></label><label class="quote-decision-choice"><input type="radio" name="quote-decision" value="REJECTED" /><span>退回</span></label></div></fieldset><div class="field"><label id="quote-comment-label" for="quote-comment">审批备注</label><textarea id="quote-comment" rows="1" placeholder="可填写审批备注">通过</textarea></div></section></div></div>`, {
    extraWide: true,
    dialogClass: "quote-editor-dialog quote-approval-dialog",
    submitLabel: "确认审批",
    onSubmit: async () => {
      const comment = commentInput.value.trim();
      if (selectedDecision === "REJECTED" && !comment) { commentInput.focus(); throw new Error("退回时请填写原因"); }
      await api(`/api/quote-versions/${versionId}/decision`, { method: "POST", body: JSON.stringify({ decision: selectedDecision, comment: comment || "通过" }) });
      closeDialog();
      showToast("审批结果和完整快照已保存");
      await refreshQuoteContext();
    }
  });
  const panel = document.querySelector(".quote-decision-panel");
  commentInput = panel.querySelector("#quote-comment");
  const commentLabel = panel.querySelector("#quote-comment-label");
  for (const option of panel.querySelectorAll('input[name="quote-decision"]')) {
    option.addEventListener("change", () => {
      if (!option.checked || option.value === selectedDecision) return;
      comments[selectedDecision] = commentInput.value;
      selectedDecision = option.value;
      commentInput.value = comments[selectedDecision];
      const rejected = selectedDecision === "REJECTED";
      commentLabel.textContent = rejected ? "退回原因" : "审批备注";
      commentLabel.classList.toggle("required", rejected);
      commentInput.required = rejected;
      commentInput.placeholder = rejected ? "请填写退回原因" : "可填写审批备注";
    });
  }
}

function reminderCenterRow(item, mine) {
  const pending = ["PENDING", "OVERDUE"].includes(item.status);
  const actionButton = (action, label) => `<button class="button small" data-reminder-action="${action}" data-reminder-id="${item.id}" data-customer-id="${item.customerId}">${label}</button>`;
  const target = item.businessObject?.target ? encodeURIComponent(JSON.stringify(item.businessObject.target)) : "";
  return `<li><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.customerName)} · 负责人：${escapeHtml(item.assignee.displayName)} · ${formatTime(item.remindAt)} · ${item.source === "LEADER" ? `指派人：${escapeHtml(item.assignedBy.displayName)}` : "本人创建"}${item.handlingReason ? ` · 处理原因：${escapeHtml(item.handlingReason)}` : ""}</small><button class="text-button reminder-object" data-reminder-target="${target}">${escapeHtml(item.businessObject?.label || "关联对象已失效")}</button><span class="tag">${escapeHtml(displayEnum(item.status, reminderStatusLabels, "状态待确认"))}</span></div><div class="actions">${mine && pending ? `<button class="button small" data-reminder-postpone="${item.id}" data-source="${item.source}">延期</button><button class="button small primary" data-reminder-complete="${item.id}">完成</button>${item.source === "LEADER" ? actionButton("REPORT_UNABLE", "无法完成") : actionButton("CANCEL", "取消")}` : ""}${item.canResolve ? actionButton("CONFIRM_CLOSE", "确认关闭") + actionButton("RESTORE", "恢复执行") + actionButton("REASSIGN", "重新指派") : ""}<button class="button small" data-reminder-history="${item.id}">处理历史</button></div></li>`;
}

async function openReminderCenter() {
  const canAssign = ["MANAGER", "VP", "ADMIN"].includes(state.user.role);
  const [mine, assigned] = await Promise.all([
    api("/api/reminders?view=mine&includeCompleted=true"),
    canAssign ? api("/api/reminders?view=assigned&includeCompleted=true") : Promise.resolve({ items: [] })
  ]);
  openDialog("查看提醒", `<div class="notice">无法完成必须填写原因，由当前有权指派人或管理员确认。重新指派仅能交给客户当前负责人，不改变客户访问权。</div><section class="detail-section"><h2>我的待办与最近完成</h2>${mine.items.length ? `<ul class="list">${mine.items.map(item => reminderCenterRow(item, true)).join("")}</ul>` : `<div class="empty">暂无提醒</div>`}</section>${canAssign ? `<section class="detail-section"><div class="card-head"><h2>${state.user.role === "ADMIN" ? "指派事项管理" : "我指派的事项（含待确认）"}</h2><button class="button small" data-action="new-reminder">+ 指派提醒</button></div>${assigned.items.length ? `<ul class="list">${assigned.items.map(item => reminderCenterRow(item, false)).join("")}</ul>` : `<div class="empty">暂无指派事项</div>`}</section>` : ""}`, { wide: true });
}

async function openReminderResolutionDialog(id, action, customerId) {
  const labels = { REPORT_UNABLE: "上报无法完成", CONFIRM_CLOSE: "确认关闭", RESTORE: "恢复执行", REASSIGN: "重新指派", CANCEL: "取消本人提醒" };
  const targets = action === "REASSIGN" ? (await api("/api/reminders/targets")).items.filter(item => item.customerId === customerId) : [];
  openDialog(labels[action], `<div class="notice">保留原内容、原到期时间及每次处理历史；本操作不替代报价或合同审批。${action === "REASSIGN" ? "如需更换客户负责人，请先通过客户转让流程。" : ""}</div>${action === "REASSIGN" ? `<div class="field"><label>客户当前负责人</label><select id="reminder-new-assignee">${targets.map(item => `<option value="${item.assigneeId}">${escapeHtml(item.assigneeName)}</option>`).join("")}</select></div>` : ""}<div class="field"><label class="required">处理原因</label><textarea id="reminder-resolution-reason"></textarea></div>`, {
    submitLabel: "确认并留痕",
    onSubmit: async () => {
      const reason = document.querySelector("#reminder-resolution-reason").value.trim();
      if (!reason) throw new Error("请填写处理原因");
      await api(`/api/reminders/${id}`, { method: "PATCH", body: JSON.stringify({ action, reason, ...(action === "REASSIGN" ? { assigneeId: document.querySelector("#reminder-new-assignee").value } : {}) }) });
      closeDialog(); await go("dashboard"); await openReminderCenter();
    }
  });
}

async function openReminderHistory(id) {
  const events = (await api(`/api/reminders/${id}/events`)).items;
  openDialog("查看提醒历史", `<ul class="list">${events.map(item => `<li><div><strong>${escapeHtml(displayEnum(item.type, reminderEventTypeLabels, "其他处理"))}</strong><small>${escapeHtml(item.actor.displayName)} · ${formatTime(item.createdAt)} · ${escapeHtml(item.reason || "—")}</small><small>${item.before?.status ? escapeHtml(displayEnum(item.before.status, reminderStatusLabels, "状态待确认")) : "新建"} → ${escapeHtml(displayEnum(item.after.status, reminderStatusLabels, "状态待确认"))} · 原到期 ${formatTime(item.after.original_remind_at)}</small></div></li>`).join("")}</ul>`, { wide: true });
}

function openPostponeDialog(id, source) {
  openDialog("延期提醒", `<div class="field"><label class="required">新的提醒时间</label><input id="postpone-time" type="datetime-local" /></div><div class="field"><label class="${source === "LEADER" ? "required" : ""}">延期原因</label><textarea id="postpone-reason"></textarea></div>`, {
    submitLabel: "确认延期",
    onSubmit: async () => {
      const time = document.querySelector("#postpone-time").value;
      await api(`/api/reminders/${id}`, { method: "PATCH", body: JSON.stringify({ action: "POSTPONE", remindAt: time ? new Date(time).toISOString() : "", reason: document.querySelector("#postpone-reason").value }) });
      closeDialog();
      showToast("提醒已延期，原提醒时间已保留");
      await go("dashboard");
    }
  });
}

async function openUserDialog() {
  const current = await api("/api/users");
  const managers = current.items.filter(user => user.role === "MANAGER" && user.positionCode === "GENERAL_MANAGER" && user.active);
  openDialog("创建独立账号", `<div class="form-grid"><div class="field"><label class="required">用户名</label><input id="user-username" autocomplete="off" /></div><div class="field"><label class="required">姓名</label><input id="user-name" /></div><div class="field"><label class="required">角色</label><select id="user-role"><option value="PRESALES">售前人员</option><option value="MANAGER">研发经理</option><option value="GENERAL_MANAGER">综合部经理（直属经理 / 报价二审）</option><option value="VP">副总经理</option><option value="ADMIN">系统管理员</option></select></div><div class="field"><label>直属综合部经理</label><select id="user-manager"><option value="">无</option>${managers.map(user => `<option value="${user.id}">${escapeHtml(user.displayName)}</option>`).join("")}</select></div><div class="field full"><label class="required">初始密码（至少 12 位）</label><input id="user-password" type="password" autocomplete="new-password" /></div><div class="field full"><label>负责区域（用顿号分隔）</label><input id="user-regions" placeholder="例如：江苏省、浙江省" /></div></div>`, {
    submitLabel: "创建用户",
    onSubmit: async () => {
      const selectedRole = document.querySelector("#user-role").value;
      await api("/api/users", { method: "POST", body: JSON.stringify({ username: document.querySelector("#user-username").value, displayName: document.querySelector("#user-name").value, password: document.querySelector("#user-password").value, role: selectedRole === "GENERAL_MANAGER" ? "MANAGER" : selectedRole, positionCode: selectedRole === "GENERAL_MANAGER" ? "GENERAL_MANAGER" : selectedRole === "MANAGER" ? "RND_MANAGER" : null, managerId: document.querySelector("#user-manager").value || null, regions: document.querySelector("#user-regions").value.split(/[、,，]/).map(value => value.trim()).filter(Boolean) }) });
      document.querySelector("#user-password").value = "";
      closeDialog();
      showToast("独立账号已创建，密码未回显");
      await go("settings");
    }
  });
}

function openPasswordResetDialog(userId) {
  const user = state.users.find(item => item.id === userId);
  openDialog("重置密码", `<p>账号：<strong>${escapeHtml(user?.displayName || "用户")}</strong></p><div class="notice warning">重置后所有旧会话立即失效，下次登录必须先修改临时密码。密码不在页面或日志中回显。</div><div class="field"><label class="required">新密码（至少 12 位）</label><input id="reset-password" type="password" autocomplete="new-password" /></div><div class="field"><label class="required">再次输入</label><input id="reset-password-confirm" type="password" autocomplete="new-password" /></div>`, {
    submitLabel: "确认重置",
    onSubmit: async () => {
      const password = document.querySelector("#reset-password").value;
      if (password !== document.querySelector("#reset-password-confirm").value) throw new Error("两次输入的密码不一致");
      await api(`/api/users/${userId}/reset-password`, { method: "POST", body: JSON.stringify({ newPassword: password }) });
      document.querySelector("#reset-password").value = "";
      document.querySelector("#reset-password-confirm").value = "";
      closeDialog();
      showToast("密码已重置，原会话已撤销");
    }
  });
}

function openUserStatusDialog(userId, active) {
  const user = state.users.find(item => item.id === userId);
  openDialog(`${active ? "启用" : "停用"}账号`, `<div class="notice ${active ? "" : "warning"}">将${active ? "启用" : "停用"}账号：${escapeHtml(user?.displayName || "")}${active ? "。" : "。停用后历史客户、跟进和审批记录仍保留，现有会话立即失效。"}</div>`, {
    submitLabel: `确认${active ? "启用" : "停用"}`,
    onSubmit: async () => {
      await api(`/api/users/${userId}/status`, { method: "PATCH", body: JSON.stringify({ active }) });
      closeDialog();
      showToast(`账号已${active ? "启用" : "停用"}`);
      await go("settings");
    }
  });
}

function openManagerChangeDialog(userId) {
  const user = state.users.find(item => item.id === userId);
  const managers = state.users.filter(item => item.role === "MANAGER" && item.positionCode === "GENERAL_MANAGER" && item.active && item.id !== user.managerId);
  openDialog("变更负责人", `<p>售前人员：<strong>${escapeHtml(user.displayName)}</strong></p><div class="notice">只保留一名当前直属综合部经理；本次变更将记录原负责人、新负责人、生效时间、操作人和原因。</div><div class="field"><label class="required">新的综合部经理</label><select id="new-manager">${managers.map(manager => `<option value="${manager.id}">${escapeHtml(manager.displayName)}</option>`).join("")}</select></div><div class="field"><label class="required">变更原因</label><textarea id="manager-change-reason"></textarea></div>`, {
    submitLabel: "确认变更",
    onSubmit: async () => {
      await api(`/api/users/${userId}/manager`, { method: "POST", body: JSON.stringify({ managerId: document.querySelector("#new-manager").value, reason: document.querySelector("#manager-change-reason").value }) });
      closeDialog();
      showToast("直属综合部经理已变更并保留历史");
      await go("settings");
    }
  });
}

async function openManagerHistory(userId) {
  const user = state.users.find(item => item.id === userId);
  const history = await api(`/api/users/${userId}/manager-history`);
  openDialog("查看负责人历史", `<p>售前人员：<strong>${escapeHtml(user?.displayName || "售前人员")}</strong></p>` + (history.items.length ? `<ul class="list">${history.items.map(item => `<li><div><strong>${escapeHtml(item.previousManager?.displayName || "初始关联")} → ${escapeHtml(item.newManager.displayName)}</strong><small>${formatTime(item.effectiveAt)} · 操作人：${escapeHtml(item.changedBy?.displayName || "系统初始化")}</small></div><span>${escapeHtml(item.reason)}</span></li>`).join("")}</ul>` : `<div class="empty">暂无变更记录</div>`), { wide: true });
}

async function openQuoteSubmitDialog(versionId) {
  const quote = await api(`/api/quote-versions/${versionId}`);
  if (quote.sourceKind === "UPLOADED") return openUploadedQuoteSubmitDialog(quote);
  openDialog("发送审批", `<div class="quote-editor-shell quote-reference-layout">${quotePaperContent(quote)}<div class="quote-system-panel"><div class="notice warning">发送后依次由研发部经理、综合部经理和副总经理审核。审核中的报价和附件需退回后才能修改。</div>${quote.sourceKind === "UPLOADED" ? `<div class="contract-confirmations"><label><input id="uploaded-quote-confirm" type="checkbox" /> <span>我已核对含税总额与上传的报价原文件一致</span></label></div>` : ""}${quoteHandoffSection(quote)}${quoteApprovalTimeline(quote)}${attachmentBlock({ title: "报价附件", data: quote.attachments, targetType: "QUOTE_VERSION", targetId: quote.id, uploadedSource: quote.sourceKind === "UPLOADED" })}</div></div>`, {
    extraWide: true,
    dialogClass: "quote-editor-dialog",
    submitLabel: "确认发送审批",
    onSubmit: async () => {
      if (quote.sourceKind === "UPLOADED" && !document.querySelector("#uploaded-quote-confirm")?.checked) throw new Error("请确认含税总额与报价原文件一致");
      await api(`/api/quote-versions/${versionId}/submit`, { method: "POST", body: JSON.stringify({ amountConfirmed: quote.sourceKind === "UPLOADED" }) });
      closeDialog();
      showToast("报价已发送研发部经理审核");
      await refreshQuoteContext();
    }
  });
}

document.addEventListener("click", async event => {
  const quoteComment = event.target.closest("[data-quote-comment]");
  if (quoteComment) {
    if (quoteCommentHint?.trigger === quoteComment && quoteCommentHint.pinned) hideQuoteCommentHint();
    else showQuoteCommentHint(quoteComment, true);
    return;
  }
  if (quoteCommentHint && !quoteCommentHint.tooltip.contains(event.target)) hideQuoteCommentHint();
  const page = event.target.closest("[data-page]");
  if (page) { await go(page.dataset.page); return; }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "close-dialog") { await requestCloseDialog(); return; }
  if (action === "new-customer") await openCustomerDialog();
  if (action === "new-reminder") await openReminderDialog();
  if (action === "new-dictionary") openDictionaryDialog();
  if (action === "open-reminders") await openReminderCenter();
  if (action === "edit-profile") openProfileDialog();
  if (action === "new-user") await openUserDialog();
  if (action === "new-survey-template") openSurveyTemplateCreateDialog();
  if (action === "new-quote") await openQuoteEditor();
  if (action === "new-uploaded-quote") await openUploadedQuoteEditor();
  if (action === "download-quote-template") {
    try { await downloadQuoteTemplate(); } catch (error) { showToast(error.message); }
    return;
  }
  if (action === "apply-quote-filters") {
    state.quoteFilters = { query: document.querySelector("#quote-search")?.value.trim() || "", status: document.querySelector("#quote-status-filter")?.value || "" };
    await renderQuotes(document.querySelector("#content"), { reload: false });
  }
  if (action === "reset-quote-filters") {
    state.quoteFilters = { query: "", status: "" };
    await renderQuotes(document.querySelector("#content"), { reload: false });
  }
  if (action === "new-survey") await openNewSurveyDialog();
  if (action === "new-sop") await openSopEditor();
  if (event.target.closest("[data-contract-new]")) await openContractCreateDialog();
  if (event.target.closest("[data-contract-template-upload]")) openContractTemplateUploadDialog();
  if (action === "search-sop") {
    state.sopFilters = { role: document.querySelector("#sop-role").value, stage: document.querySelector("#sop-stage").value, query: document.querySelector("#sop-query").value.trim() };
    await go("sop");
  }
  if (action === "reset-sop") {
    state.sopFilters = { role: "", stage: "", query: "" };
    await go("sop");
  }
  const quoteAddRow = event.target.closest("[data-add-quote-row]");
  if (quoteAddRow) {
    const section = quoteAddRow.dataset.addQuoteRow;
    document.querySelector(section === "DETAIL" ? "#quote-detail-items" : "#quote-summary-items")?.insertAdjacentHTML("beforeend", quoteEditorRow({}, section));
    document.querySelectorAll(".quote-editor-table textarea").forEach(resizeQuoteTextarea);
    updateQuoteEditorSummary();
  }
  if (action === "search-customers") {
    state.customerFilters = readCustomerFilters();
    await renderCustomers(document.querySelector("#content"));
  }
  if (action === "reset-customer-filters") {
    state.customerFilters = { search: "", ownerId: "", status: "", source: "", customerType: "", industry: "", region: "", registeredFrom: "", registeredTo: "" };
    await renderCustomers(document.querySelector("#content"));
  }
  if (action === "reset-map-filters") {
    state.mapFilters = { ownerId: "", status: "", region: "" };
    await renderMap(document.querySelector("#content"));
  }
  if (action === "logout") {
    await api("/api/auth/logout", { method: "POST" });
    resetBusinessState();
    state.user = null;
    state.csrfToken = null;
    renderLogin();
  }
  const complete = event.target.closest("[data-reminder-complete]");
  if (complete && !complete.disabled) {
    complete.disabled = true;
    try {
      await api(`/api/reminders/${complete.dataset.reminderComplete}`, { method: "PATCH", body: JSON.stringify({ action: "COMPLETE" }) });
      closeDialog(); showToast("提醒已完成"); await go("dashboard");
    } catch (error) { showToast(error.message); }
    finally { if (complete.isConnected) complete.disabled = false; }
  }
  const postpone = event.target.closest("[data-reminder-postpone]");
  if (postpone) openPostponeDialog(postpone.dataset.reminderPostpone, postpone.dataset.source);
  const resolution = event.target.closest("[data-reminder-action]");
  if (resolution) {
    try { await openReminderResolutionDialog(resolution.dataset.reminderId, resolution.dataset.reminderAction, resolution.dataset.customerId); }
    catch (error) { showToast(error.message); }
  }
  const reminderHistory = event.target.closest("[data-reminder-history]");
  if (reminderHistory) {
    try { await openReminderHistory(reminderHistory.dataset.reminderHistory); }
    catch (error) { showToast(error.message); }
  }
  const reminderTarget = event.target.closest("[data-reminder-target]");
  if (reminderTarget?.dataset.reminderTarget) {
    try {
      const target = reminderTargetAction(JSON.parse(decodeURIComponent(reminderTarget.dataset.reminderTarget)));
      if (!target) throw new Error("关联对象已失效");
      if (target.action === "customer") await openCustomerDetail(target.id, target.tab);
      if (target.action === "survey") await openSurveyEditor(target.id);
      if (target.action === "quote") await openQuoteView(target.id);
      if (target.action === "contract") await openContractDetail(target.id);
    } catch (error) { showToast(error.message); }
  }
  const boardStatus = event.target.closest("[data-customer-board-status]");
  if (boardStatus) {
    const selected = boardStatus.dataset.customerBoardStatus;
    state.customerFilters.status = state.customerFilters.status === selected ? "" : selected;
    await renderCustomers(document.querySelector("#content"));
  }
  const mapCustomer = event.target.closest("[data-map-customer]");
  if (mapCustomer) openMapCustomer(mapCustomer.dataset.mapCustomer);
  const mapZoom = event.target.closest("[data-map-zoom]");
  if (mapZoom) {
    const viewport = document.querySelector(".china-geo-map-host")?.mapViewport;
    if (mapZoom.dataset.mapZoom === "in") viewport?.zoomIn();
    if (mapZoom.dataset.mapZoom === "out") viewport?.zoomOut();
    if (mapZoom.dataset.mapZoom === "reset") viewport?.reset();
  }
  const mapProvince = event.target.closest("[data-map-province]");
  if (mapProvince) openMapProvince(mapProvince.dataset.mapProvince);
  const mapRegion = event.target.closest("[data-map-region-owner]");
  if (mapRegion) openMapRegion(mapRegion.dataset.mapRegionOwner, mapRegion.dataset.mapRegionName);
  const mapPick = event.target.closest("[data-map-pick]");
  if (mapPick) startMapPointPicker(mapPick.dataset.mapPick);
  const mapDetail = event.target.closest("[data-map-detail-type]");
  if (mapDetail) {
    try {
      if (mapDetail.dataset.mapDetailType === "CUSTOMER") await openCustomerDetail(mapDetail.dataset.mapDetailId);
      if (mapDetail.dataset.mapDetailType === "QUOTE_VERSION") await openQuoteView(mapDetail.dataset.mapDetailId);
    } catch (error) { showToast(error.message); }
  }
  const mapCustomerRegion = event.target.closest("[data-map-customer-region]");
  if (mapCustomerRegion) {
    closeDialog();
    state.customerFilters = { ...state.customerFilters, region: mapCustomerRegion.dataset.mapCustomerRegion, status: "" };
    await go("customers");
  }
  const mapCanvas = event.target.closest(".map-canvas");
  if (mapCanvas && state.mapImageReady && state.mapPickerCustomerId && !event.target.closest("[data-map-customer],[data-map-region-owner]")) {
    const bounds = mapCanvas.getBoundingClientRect();
    const left = ((event.clientX - bounds.left) / bounds.width) * 100;
    const top = ((event.clientY - bounds.top) / bounds.height) * 100;
    const customerId = state.mapPickerCustomerId;
    const expectedAssetSha256 = state.mapPickerAssetSha256;
    state.mapPickerCustomerId = null;
    state.mapPickerAssetSha256 = null;
    mapCanvas.classList.remove("picking");
    confirmMapPoint(customerId, { xPercent: left, yPercent: top }, expectedAssetSha256);
  }
  const customerOpen = event.target.closest("[data-customer-open]");
  if (customerOpen && !customerOpen.disabled) {
    customerOpen.disabled = true;
    try { await openCustomerDetail(customerOpen.dataset.customerOpen); } finally { if (customerOpen.isConnected) customerOpen.disabled = false; }
  }
  const customerRetry = event.target.closest("[data-customer-retry]");
  if (customerRetry) await openCustomerDetail(customerRetry.dataset.customerRetry, "overview", { replace: true });
  const customerTab = event.target.closest("[data-customer-tab]");
  if (customerTab) activateCustomerTab(customerTab.dataset.customerTab);
  const customerEdit = event.target.closest("[data-customer-edit]");
  if (customerEdit) await openCustomerEditDialog(customerEdit.dataset.customerEdit);
  const sopContext = event.target.closest("[data-sop-context]");
  if (sopContext) {
    closeDialog();
    state.sopFilters = { role: "", stage: sopContext.dataset.sopContext, query: "" };
    await go("sop");
  }
  const customerDate = event.target.closest("[data-customer-date]");
  if (customerDate) openRegisteredOnDialog(customerDate.dataset.customerDate);
  const contactNew = event.target.closest("[data-contact-new]");
  if (contactNew) await openContactDialog(contactNew.dataset.contactNew);
  const contactEdit = event.target.closest("[data-contact-edit]");
  if (contactEdit) await openContactDialog(contactEdit.dataset.customerId, contactEdit.dataset.contactEdit);
  const projectNew = event.target.closest("[data-project-new]");
  if (projectNew) openProjectDialog(projectNew.dataset.projectNew);
  const followupNew = event.target.closest("[data-followup-new]");
  if (followupNew) await openFollowupDialog(followupNew.dataset.followupNew);
  const followupEdit = event.target.closest("[data-followup-edit]");
  if (followupEdit) await openFollowupDialog(followupEdit.dataset.customerId, followupEdit.dataset.followupEdit);
  const customerReminderNew = event.target.closest("[data-customer-reminder-new]");
  if (customerReminderNew) await openReminderDialog(customerReminderNew.dataset.customerReminderNew);
  const customerSurveyNew = event.target.closest("[data-customer-survey-new]");
  if (customerSurveyNew) await openNewSurveyDialog(customerSurveyNew.dataset.customerSurveyNew);
  const customerQuoteNew = event.target.closest("[data-customer-quote-new]");
  if (customerQuoteNew) await openQuoteEditor(null, customerQuoteNew.dataset.customerQuoteNew);
  const customerContractNew = event.target.closest("[data-customer-contract-new]");
  if (customerContractNew) await openContractCreateDialog(customerContractNew.dataset.customerContractNew);
  const quoteRemove = event.target.closest(".qe-remove");
  if (quoteRemove) {
    const row = quoteRemove.closest("tr");
    const count = document.querySelectorAll(`.quote-editor-row[data-quote-section="${row.dataset.quoteSection}"]`).length;
    if (count > 1) row.remove();
    else row.querySelectorAll("input").forEach(input => { if (!input.classList.contains("qe-tax")) input.value = input.classList.contains("qe-quantity") ? "1" : ""; });
    updateQuoteEditorSummary();
  }
  const quoteView = event.target.closest("[data-quote-view]");
  const quoteDocumentReview = event.target.closest("[data-quote-document-review]");
  if (quoteDocumentReview) {
    try { await openQuoteDocumentReview(quoteDocumentReview.dataset.quoteDocumentReview); }
    catch (error) { showToast(error.message); }
  }
  if (quoteView && !quoteView.disabled) {
    quoteView.disabled = true;
    try {
      await openQuoteView(quoteView.dataset.quoteView);
    } catch (error) { showToast(error.message); }
    finally { quoteView.disabled = false; }
  }
  const quoteEdit = event.target.closest("[data-quote-edit]");
  if (quoteEdit) {
    const quote = await api(`/api/quote-versions/${quoteEdit.dataset.quoteEdit}`);
    if (quote.sourceKind === "UPLOADED") await openUploadedQuoteEditor(quote.id);
    else await openQuoteEditor(quote.id);
  }
  const quoteSubmit = event.target.closest("[data-quote-submit]");
  if (quoteSubmit) await openQuoteSubmitDialog(quoteSubmit.dataset.quoteSubmit);
  const quoteDecision = event.target.closest("[data-quote-decision]");
  if (quoteDecision) await openQuoteDecisionDialog(quoteDecision.dataset.quoteDecision);
  const quoteRevise = event.target.closest("[data-quote-revise]");
  if (quoteRevise) await openApprovedQuoteRevisionDialog(quoteRevise.dataset.quoteRevise);
  const quoteExport = event.target.closest("[data-quote-export]");
  const quotePreviewExport = event.target.closest("[data-quote-preview-export]");
  if (quotePreviewExport && !quotePreviewExport.disabled) {
    quotePreviewExport.disabled = true;
    try { await downloadQuotePreview(quotePreviewExport.dataset.quotePreviewExport); }
    catch (error) { showToast(error.message); }
    finally { quotePreviewExport.disabled = false; }
  }
  const followupsExport = event.target.closest("[data-followups-export]");
  if (followupsExport && !followupsExport.disabled) {
    followupsExport.disabled = true;
    try {
      const file = await api(`/api/customers/${followupsExport.dataset.followupsExport}/followups/export-docx`, { method: "POST", body: "{}" });
      downloadFile(file.id);
    } catch (error) { showToast(error.message); }
    finally { followupsExport.disabled = false; }
  }
  if (quoteExport) {
    const file = await api(`/api/quote-versions/${quoteExport.dataset.quoteExport}/export-docx`, { method: "POST", body: "{}" });
    downloadFile(file.id);
  }
  const contractOpen = event.target.closest("[data-contract-open]");
  if (contractOpen) await openContractDetail(contractOpen.dataset.contractOpen);
  const contractGenerate = event.target.closest("[data-contract-generate]");
  if (contractGenerate) {
    contractGenerate.disabled = true;
    try {
      await api(`/api/contracts/${contractGenerate.dataset.contractGenerate}/generate`, { method: "POST", body: "{}" });
      closeDialog(); showToast("系统原始合同 Word 已生成并不可覆盖归档"); await go("contracts"); await openContractDetail(contractGenerate.dataset.contractGenerate);
    } catch (error) {
      contractGenerate.disabled = false;
      showToast(error.details?.map?.(item => item.message).join("；") || error.message);
    }
  }
  const contractArchive = event.target.closest("[data-contract-archive]");
  if (contractArchive) openContractArchiveDialog(contractArchive.dataset.contractArchive);
  const contractEdit = event.target.closest("[data-contract-edit]");
  if (contractEdit) await openContractEditDialog(contractEdit.dataset.contractEdit);
  const contractNotes = event.target.closest("[data-contract-notes]");
  if (contractNotes) await openContractNotesDialog(contractNotes.dataset.contractNotes);
  const contractStatus = event.target.closest("[data-contract-confirm-status]");
  if (contractStatus) openContractStatusConfirmation(contractStatus.dataset.contractConfirmStatus, contractStatus.dataset.customerName);
  const contractDownload = event.target.closest("[data-contract-download]");
  if (contractDownload) downloadContractFile(contractDownload.dataset.contractDownload);
  const fileDownload = event.target.closest("[data-file-download]");
  if (fileDownload) downloadFile(fileDownload.dataset.fileDownload);
  const attachmentDownload = event.target.closest("[data-attachment-download]");
  if (attachmentDownload) downloadAttachment(attachmentDownload.dataset.attachmentDownload, attachmentDownload.dataset.versionId || "");
  const attachmentPreview = event.target.closest("[data-attachment-preview]");
  if (attachmentPreview) previewAttachment(attachmentPreview.dataset.attachmentPreview, attachmentPreview.dataset.versionId || "");
  const attachmentSnapshotDownload = event.target.closest("[data-attachment-snapshot-download]");
  if (attachmentSnapshotDownload) downloadAttachmentSnapshot(attachmentSnapshotDownload.dataset.attachmentSnapshotDownload);
  const attachmentSnapshotPreview = event.target.closest("[data-attachment-snapshot-preview]");
  if (attachmentSnapshotPreview) previewAttachmentSnapshot(attachmentSnapshotPreview.dataset.attachmentSnapshotPreview);
  const attachmentPick = event.target.closest("[data-attachment-pick]");
  if (attachmentPick) {
    const input = document.getElementById(attachmentPick.dataset.attachmentPick);
    if (input) {
      delete input.dataset.attachmentId;
      delete input.dataset.currentVersion;
      input.value = "";
      input.click();
    }
  }
  const attachmentReplace = event.target.closest("[data-attachment-replace]");
  if (attachmentReplace) {
    const input = document.getElementById(attachmentReplace.dataset.fileInput);
    if (input) {
      input.dataset.attachmentId = attachmentReplace.dataset.attachmentReplace;
      input.dataset.currentVersion = attachmentReplace.dataset.currentVersion;
      input.value = "";
      input.click();
    }
  }
  const attachmentDelete = event.target.closest("[data-attachment-delete]");
  if (attachmentDelete && !attachmentDelete.disabled) {
    const attachmentId = attachmentDelete.dataset.attachmentDelete;
    const block = attachmentDelete.closest("[data-attachment-block]");
    const { targetType, targetId } = block.dataset;
    openDialog("删除附件", `<div class="notice">文件字节和历史审批快照仍会保留。</div><div class="field"><label class="required">删除原因</label><textarea id="attachment-delete-reason"></textarea></div>`, {
      submitLabel: "确认删除",
      onSubmit: async () => {
        const reason = document.querySelector("#attachment-delete-reason").value.trim();
        if (!reason) throw new Error("请填写删除原因");
        await api(`/api/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE", body: JSON.stringify({ reason }) });
        closeDialog();
        showToast("附件已从当前业务记录移除，历史字节和快照保持不变");
        await refreshAttachmentBlocks(targetType, targetId);
      }
    });
  }
  const templatePublish = event.target.closest("[data-contract-template-publish]");
  if (templatePublish) {
    await api(`/api/contract-templates/${templatePublish.dataset.contractTemplatePublish}/publish`, { method: "POST", body: "{}" });
    showToast("合同模板已发布，历史版本保持不变"); await go("contracts");
  }
  const surveyOpen = event.target.closest("[data-survey-open]");
  if (surveyOpen) await openSurveyEditor(surveyOpen.dataset.surveyOpen);
  const surveyHistory = event.target.closest("[data-survey-history]");
  if (surveyHistory) await openSurveyHistory(surveyHistory.dataset.surveyHistory);
  const surveyComplete = event.target.closest("[data-survey-complete]");
  if (surveyComplete) openSurveyCompleteDialog(surveyComplete.dataset.surveyComplete);
  const surveyExport = event.target.closest("[data-survey-export]");
  if (surveyExport) {
    const file = await api(`/api/surveys/${surveyExport.dataset.surveyExport}/export-docx`, { method: "POST", body: "{}" });
    downloadFile(file.id);
  }
  const surveyRowRemove = event.target.closest("[data-action='remove-survey-row']");
  if (surveyRowRemove) {
    surveyRowRemove.closest("[data-survey-table-row]").remove();
    updateSurveyEditorProgress();
  }
  const importOpen = event.target.closest("[data-import-open]");
  if (importOpen) await renderImportJob(importOpen.dataset.importOpen);
  const sopOpen = event.target.closest("[data-sop-open]");
  if (sopOpen) await openSopDetail(sopOpen.dataset.sopOpen);
  const sopHistory = event.target.closest("[data-sop-history]");
  if (sopHistory) await openSopHistory(sopHistory.dataset.sopHistory);
  const sopPublish = event.target.closest("[data-sop-publish]");
  if (sopPublish) await openSopEditor(sopPublish.dataset.sopPublish);
  const userReset = event.target.closest("[data-user-reset]");
  const dictionaryEdit = event.target.closest("[data-dictionary-edit]");
  if (dictionaryEdit) openDictionaryDialog(dictionaryEdit.dataset.dictionaryEdit);
  const dictionaryCandidate = event.target.closest("[data-dictionary-candidate]");
  if (dictionaryCandidate) openDictionaryDialog(null, Number(dictionaryCandidate.dataset.dictionaryCandidate));
  const dictionaryDelete = event.target.closest("[data-dictionary-delete]");
  if (dictionaryDelete) openDialog("删除未使用字典项", `<div class="notice warning">服务端将重新检查历史引用；已使用项只能停用。</div>`, { submitLabel: "确认删除", onSubmit: async () => { await api(`/api/customer-dictionaries/${dictionaryDelete.dataset.dictionaryDelete}`, { method: "DELETE" }); closeDialog(); await go("settings"); } });
  const surveyTemplatePreview = event.target.closest("[data-survey-template-preview]");
  if (surveyTemplatePreview) await openSurveyTemplatePreview(surveyTemplatePreview.dataset.surveyTemplatePreview);
  const surveyTemplateEdit = event.target.closest("[data-survey-template-edit]");
  if (surveyTemplateEdit) await openSurveyTemplateEditor(surveyTemplateEdit.dataset.surveyTemplateEdit);
  const surveyTemplateCopy = event.target.closest("[data-survey-template-copy]");
  if (surveyTemplateCopy) openSurveyTemplateCreateDialog(surveyTemplateCopy.dataset.surveyTemplateCopy);
  const surveyTemplatePublish = event.target.closest("[data-survey-template-publish]");
  if (surveyTemplatePublish) openSurveyTemplatePublishDialog(surveyTemplatePublish.dataset.surveyTemplatePublish);
  if (userReset) openPasswordResetDialog(userReset.dataset.userReset);
  const userStatus = event.target.closest("[data-user-status]");
  if (userStatus) openUserStatusDialog(userStatus.dataset.userStatus, userStatus.dataset.active === "true");
  const userManager = event.target.closest("[data-user-manager]");
  if (userManager) openManagerChangeDialog(userManager.dataset.userManager);
  const userHistory = event.target.closest("[data-user-history]");
  if (userHistory) await openManagerHistory(userHistory.dataset.userHistory);
});

document.addEventListener("change", async event => {
  const mapFilter = event.target.closest("[data-map-filter]");
  if (mapFilter && state.page === "map") {
    state.mapFilters = {
      ownerId: document.querySelector("#map-owner")?.value || "",
      status: document.querySelector("#map-status")?.value || "",
      region: state.mapFilters.region || ""
    };
    try { await renderMap(document.querySelector("#content")); }
    catch (error) { showToast(error.message); }
    return;
  }
  const input = event.target.closest("[data-attachment-file]");
  if (!input || !input.files?.[0]) return;
  const file = input.files[0];
  const block = input.closest("[data-attachment-block]");
  const buttons = block ? [...block.querySelectorAll("button")] : [];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const form = new FormData();
    form.set("targetType", input.dataset.targetType);
    form.set("targetId", input.dataset.targetId);
    if (input.dataset.targetKey) form.set("targetKey", input.dataset.targetKey);
    if (input.dataset.attachmentId) form.set("attachmentId", input.dataset.attachmentId);
    if (input.dataset.currentVersion) form.set("expectedCurrentVersionId", input.dataset.currentVersion);
    form.set("requestKey", crypto.randomUUID());
    form.set("file", file, file.name);
    await api("/api/attachments/upload", { method: "POST", body: form });
    showToast(input.dataset.attachmentId ? "附件新版本已上传，历史版本保留" : "附件已上传并记录摘要");
    await refreshAttachmentBlocks(input.dataset.targetType, input.dataset.targetId);
  } catch (error) { showToast(error.message); }
  finally {
    input.value = "";
    buttons.forEach(button => { if (button.isConnected) button.disabled = false; });
  }
});

document.addEventListener("pointerover", event => {
  if (event.pointerType !== "mouse") return;
  const trigger = event.target.closest("[data-quote-comment]");
  if (trigger) showQuoteCommentHint(trigger);
  else if (quoteCommentHint?.tooltip.contains(event.target)) clearTimeout(quoteCommentHideTimer);
});

document.addEventListener("pointerout", event => {
  if (event.pointerType !== "mouse" || !quoteCommentHint || quoteCommentHint.pinned) return;
  const { trigger, tooltip } = quoteCommentHint;
  if (!trigger.contains(event.target) && !tooltip.contains(event.target)) return;
  if (trigger.contains(event.relatedTarget) || tooltip.contains(event.relatedTarget) || trigger.matches(":focus-visible")) return;
  clearTimeout(quoteCommentHideTimer);
  quoteCommentHideTimer = setTimeout(hideQuoteCommentHint, 120);
});

document.addEventListener("focusin", event => {
  if (event.target.matches("[data-quote-comment]:focus-visible")) showQuoteCommentHint(event.target);
});

document.addEventListener("focusout", event => {
  if (quoteCommentHint?.trigger === event.target) hideQuoteCommentHint();
});

document.addEventListener("scroll", event => {
  if (quoteCommentHint && !quoteCommentHint.tooltip.contains(event.target)) hideQuoteCommentHint();
}, true);
window.addEventListener("resize", hideQuoteCommentHint);

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (quoteCommentHint?.tooltip.isConnected) {
      hideQuoteCommentHint();
      return;
    }
    const confirmation = document.querySelector(".system-confirm-backdrop");
    if (confirmation) confirmation.querySelector("[data-confirm-cancel]")?.click();
    else void requestCloseDialog();
  }
  if (event.key === "Enter" && event.target.id === "quote-search") {
    state.quoteFilters = { query: event.target.value.trim(), status: document.querySelector("#quote-status-filter")?.value || "" };
    renderQuotes(document.querySelector("#content"), { reload: false }).catch(error => showToast(error.message));
  }
});

async function bootstrap() {
  try { state.runtime = await api("/api/runtime"); } catch { /* 保守沿用首发模式，避免配置读取失败时暴露延期模块。 */ }
  try {
    const session = await api("/api/auth/session");
    state.user = session.user;
    state.csrfToken = session.csrfToken;
    if (state.user.mustChangePassword) return renderPasswordChange();
    renderShell();
    await go(defaultPageForUser());
  } catch {
    renderLogin();
  }
}

bootstrap();
