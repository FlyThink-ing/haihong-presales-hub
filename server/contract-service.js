import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { audit } from "./audit.js";
import { generateContractFromTemplate, loadPublishedTemplate } from "./contract-template-service.js";
import { nowIso } from "./database.js";
import { AppError, assert, QUOTE_STATUSES, ROLES } from "./domain.js";
import { removeManagedFile, resolveManagedPath, safeDownloadName, storeManagedBuffer, validateUploadedFile } from "./file-service.js";
import { canReadCustomer } from "./permissions.js";
import { calculateQuoteItems } from "./quote-service.js";
import { sha256 } from "./security.js";
import { updateCustomer } from "./customer-service.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CONTRACT_STATUSES = Object.freeze(["DRAFT", "GENERATED", "SIGNING", "SIGNED", "VOID"]);
const PARTY_FIELDS = Object.freeze([
  "partyAName", "licenseScope", "partyALegalRepresentative", "partyARepresentative",
  "partyAZip", "partyAAddress", "partyAPhone"
]);
const MANUAL_FIELDS = Object.freeze(["contractNumber", "signLocation", "signDate"]);
const SENSITIVE_CHANGE_FIELDS = Object.freeze(["amount", "scope", "quantity", "unitPrice", "taxRate"]);
const COMPARISON_FIELDS = Object.freeze([
  "category", "itemName", "subitemName", "unit", "quantityMilli",
  "untaxedUnitPriceCents", "taxRateBps", "untaxedAmountCents", "taxedAmountCents"
]);

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function cleanText(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function asBoolean(value) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "on";
}

function sameFlatObject(left, right) {
  const leftKeys = Object.keys(left || {}).sort();
  const rightKeys = Object.keys(right || {}).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function money(cents) {
  return `¥${(Number(cents) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function quantity(milli) {
  return (Number(milli) / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
}

function taxRate(bps) {
  return `${(Number(bps) / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`;
}

export function summarizeContractBodyItems(items) {
  assert(Array.isArray(items) && items.length > 0, 409, "CONTRACT_BODY_PRICE_ITEMS_MISSING", "终审报价快照没有可用于合同正文的报价明细");
  const first = items[0];
  const heterogeneous = items.some(item => item.unit !== first.unit
    || item.untaxedUnitPriceCents !== first.untaxedUnitPriceCents
    || item.taxRateBps !== first.taxRateBps);
  if (heterogeneous) {
    return {
      ok: false,
      code: "CONTRACT_BODY_PRICE_TABLE_HETEROGENEOUS",
      message: "当前合同模板正文仅支持一条或单位、未税单价、税率完全相同的多条报价明细；请管理员改用支持正文多行价格表的新版合同模板"
    };
  }
  const quantityMilli = items.reduce((sum, item) => sum + item.quantityMilli, 0);
  const untaxedAmountCents = items.reduce((sum, item) => sum + item.untaxedAmountCents, 0);
  const taxedAmountCents = items.reduce((sum, item) => sum + item.taxedAmountCents, 0);
  assert([quantityMilli, untaxedAmountCents, taxedAmountCents].every(Number.isSafeInteger), 409, "CONTRACT_BODY_PRICE_SUM_INVALID", "终审报价快照正文汇总结果超出安全整数范围");
  return {
    ok: true,
    productNames: items.map(item => item.subitemName ? `${item.itemName}（${item.subitemName}）` : item.itemName).join("、"),
    unit: first.unit,
    quantityMilli,
    untaxedUnitPriceCents: first.untaxedUnitPriceCents,
    untaxedAmountCents,
    taxRateBps: first.taxRateBps,
    taxedAmountCents
  };
}

function localCalendarDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function chineseMoneyUpper(cents) {
  assert(Number.isSafeInteger(cents) && cents >= 0, 500, "CONTRACT_AMOUNT_INVALID", "合同金额无法转换为人民币大写");
  if (cents === 0) return "人民币零元整";
  const digits = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
  const smallUnits = ["", "拾", "佰", "仟"];
  const groupUnits = ["", "万", "亿", "兆"];
  const integerPart = Math.floor(cents / 100);
  const jiao = Math.floor((cents % 100) / 10);
  const fen = cents % 10;

  function groupText(group) {
    let result = "";
    let pendingZero = false;
    for (let position = 3; position >= 0; position -= 1) {
      const divisor = 10 ** position;
      const digit = Math.floor(group / divisor) % 10;
      if (digit === 0) {
        if (result) pendingZero = true;
      } else {
        if (pendingZero) result += "零";
        result += digits[digit] + smallUnits[position];
        pendingZero = false;
      }
    }
    return result;
  }

  let integerText = "";
  if (integerPart > 0) {
    const groups = [];
    let rest = integerPart;
    while (rest > 0) {
      groups.push(rest % 10_000);
      rest = Math.floor(rest / 10_000);
    }
    let zeroBetween = false;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      if (group === 0) {
        if (integerText) zeroBetween = true;
        continue;
      }
      if (integerText && (zeroBetween || group < 1000)) integerText += "零";
      integerText += groupText(group) + groupUnits[index];
      zeroBetween = false;
    }
  } else {
    integerText = "零";
  }
  let decimalText = "";
  if (jiao) decimalText += `${digits[jiao]}角`;
  if (fen) decimalText += `${jiao ? "" : "零"}${digits[fen]}分`;
  return `人民币${integerText}元${decimalText || "整"}`;
}

function quoteRow(db, versionId) {
  const row = db.prepare(`
    SELECT qv.*, q.customer_id, q.project_id, q.quote_number,
      c.full_name AS customer_name, p.name AS project_name
    FROM quote_versions qv
    JOIN quotes q ON q.id = qv.quote_id
    JOIN customers c ON c.id = q.customer_id
    JOIN projects p ON p.id = q.project_id
    WHERE qv.id = ?
  `).get(versionId);
  if (!row) throw new AppError(404, "QUOTE_VERSION_NOT_FOUND", "报价版本不存在");
  return row;
}

export function approvedQuoteSnapshot(db, versionId, { allowVoid = false } = {}) {
  const quote = quoteRow(db, versionId);
  assert(quote.status === QUOTE_STATUSES.APPROVED || (allowVoid && quote.status === QUOTE_STATUSES.VOID), 422, "QUOTE_NOT_APPROVED", "只有终审通过且未作废的报价可以生成合同");
  assert(quote.snapshot_json && sha256(quote.snapshot_json) === quote.snapshot_hash, 409, "QUOTE_SNAPSHOT_INVALID", "报价内容快照校验失败，禁止生成合同");
  const approvalRow = db.prepare(`
    SELECT qas.snapshot_json, qas.snapshot_hash, qas.created_at
    FROM quote_approval_snapshots qas
    JOIN quote_approvals qa ON qa.id = qas.approval_id
    WHERE qas.quote_version_id = ? AND qa.stage = 'VP' AND qa.decision = 'APPROVED'
    ORDER BY qas.created_at DESC, qas.rowid DESC LIMIT 1
  `).get(versionId);
  assert(approvalRow?.snapshot_json && sha256(approvalRow.snapshot_json) === approvalRow.snapshot_hash, 409, "QUOTE_APPROVAL_SNAPSHOT_INVALID", "报价终审快照校验失败，禁止生成合同");
  const approvalSnapshot = parseJson(approvalRow.snapshot_json, null);
  const snapshot = approvalSnapshot?.content;
  assert(snapshot?.quoteVersionId === versionId && sha256(JSON.stringify(snapshot)) === quote.snapshot_hash, 409, "QUOTE_APPROVAL_CONTENT_INVALID", "报价终审快照与锁定内容不一致，禁止生成合同");
  assert(snapshot.sourceKind !== "UPLOADED", 422, "UPLOADED_QUOTE_CONTRACT_UNAVAILABLE", "上传的报价文件不能自动生成合同，请使用系统报价流程");
  assert(snapshot.customer?.id === quote.customer_id && snapshot.project?.id === quote.project_id, 409, "QUOTE_APPROVAL_REFERENCE_INVALID", "报价终审快照客户或项目不一致");
  const calculated = calculateQuoteItems(snapshot.items);
  assert(calculated.subtotalUntaxedCents === snapshot.subtotalUntaxedCents && calculated.subtotalTaxedCents === snapshot.subtotalTaxedCents, 409, "QUOTE_SNAPSHOT_AMOUNT_INVALID", "报价审批快照金额复核失败，禁止生成合同");
  assert(Number.isSafeInteger(snapshot.finalDiscountCents) && snapshot.finalDiscountCents > 0 && snapshot.finalDiscountCents <= snapshot.subtotalTaxedCents && snapshot.discountAmountCents === snapshot.subtotalTaxedCents - snapshot.finalDiscountCents, 409, "QUOTE_SNAPSHOT_DISCOUNT_INVALID", "报价审批快照优惠金额复核失败，禁止生成合同");
  const approvals = approvalSnapshot.approvals || [];
  const requiredStages = Array.isArray(snapshot.approvalWorkflow) ? snapshot.approvalWorkflow : ["MANAGER", "VP"];
  assert(approvals.length === requiredStages.length && approvals.every((item, index) => item.stage === requiredStages[index] && item.decision === "APPROVED"), 409, "QUOTE_APPROVAL_CHAIN_INVALID", "报价终审快照缺少完整的顺序通过记录");
  const userNames = new Map(db.prepare(`SELECT id, display_name FROM users`).all().map(user => [user.id, user.display_name]));
  const quoteReference = {
    quoteVersionId: versionId,
    quoteNumber: snapshot.quoteNumber,
    revision: snapshot.revision,
    versionLabel: `V${snapshot.revision}.0`,
    approvedAt: approvalRow.created_at,
    approvals: approvals.map(item => ({ stage: item.stage, decision: item.decision, comment: item.comment, createdAt: item.createdAt, approver: { id: item.approverId, displayName: userNames.get(item.approverId) || "未知审批人" } }))
  };
  return { quote, snapshot, approvals, quoteReference, approvalSnapshotHash: approvalRow.snapshot_hash, approvedAt: approvalRow.created_at };
}

function requireContractReader(db, actor, customerId) {
  assert(canReadCustomer(db, actor, customerId) || actor.role === ROLES.ADMIN, 404, "CONTRACT_NOT_FOUND", "合同不存在或当前账号无权访问");
}

function requireContractEditor(db, actor, customerId) {
  assert([ROLES.PRESALES, ROLES.ADMIN].includes(actor.role) && (actor.role === ROLES.ADMIN || canReadCustomer(db, actor, customerId)), 403, "CONTRACT_EDIT_FORBIDDEN", "仅客户当前负责人或管理员可以维护合同");
}

export function preflightContract(db, actor, input) {
  const { quote, snapshot, quoteReference, approvalSnapshotHash, approvedAt } = approvedQuoteSnapshot(db, input.quoteVersionId);
  requireContractReader(db, actor, quote.customer_id);
  const template = db.prepare(`SELECT * FROM contract_templates WHERE id = ? AND is_published = 1`).get(input.templateId);
  assert(template, 422, "CONTRACT_TEMPLATE_NOT_PUBLISHED", "必须选择已发布的合同模板版本");
  const attachment = input.attachment || {};
  const issues = [];
  const bodySummary = summarizeContractBodyItems(snapshot.items);
  if (!bodySummary.ok) issues.push({ field: "quoteVersionId", code: bodySummary.code, message: bodySummary.message });
  if (input.customerId !== undefined && input.customerId !== snapshot.customer.id) issues.push({ field: "customerId", message: "合同客户与报价客户不一致" });
  if (input.projectId !== undefined && input.projectId !== snapshot.project.id) issues.push({ field: "projectId", message: "合同项目与报价项目不一致" });
  if (input.contractAmountCents !== undefined && input.contractAmountCents !== snapshot.finalDiscountCents) issues.push({ field: "contractAmountCents", message: "合同金额与已审批报价最终优惠价不一致" });
  if (attachment.subtotalCents !== undefined && attachment.subtotalCents !== snapshot.subtotalTaxedCents) issues.push({ field: "attachment.subtotalCents", message: "附件明细含税合计与已审批报价原合计不一致" });
  if (attachment.finalDiscountCents !== undefined && attachment.finalDiscountCents !== snapshot.finalDiscountCents) issues.push({ field: "attachment.finalDiscountCents", message: "附件最终优惠价与已审批报价不一致" });

  if (attachment.items !== undefined) {
    let actualItems = [];
    try {
      actualItems = calculateQuoteItems((attachment.items || []).map(item => {
        const { untaxedAmountCents: _untaxed, taxedAmountCents: _taxed, ...sourceFields } = item;
        return sourceFields;
      })).items;
    } catch (error) {
      if (error instanceof AppError) issues.push({ field: "attachmentItems", message: error.message });
      else throw error;
    }
    if (actualItems.length !== snapshot.items.length) {
      issues.push({ field: "attachmentItems", message: "附件明细行数与已审批报价不一致" });
    } else {
      for (let index = 0; index < snapshot.items.length; index += 1) {
        for (const field of COMPARISON_FIELDS) {
          if ((actualItems[index]?.[field] ?? null) !== (snapshot.items[index]?.[field] ?? null)) {
            issues.push({ field: `attachmentItems[${index}].${field}`, message: `附件第 ${index + 1} 行${field}与已审批报价不一致` });
          }
        }
      }
    }
  }
  const maintenanceFeeCents = Math.round(snapshot.finalDiscountCents / 10);
  return {
    ok: issues.length === 0,
    issues,
    quoteVersion: { id: quote.id, quoteNumber: quote.quote_number, revision: quote.revision, approvedAt },
    customer: snapshot.customer,
    project: snapshot.project,
    template: { id: template.id, version: template.version, sha256: template.sha256, fixedFingerprint: template.fixed_fingerprint },
    approvalSnapshotHash,
    quoteReference,
    expectedAmountCents: snapshot.finalDiscountCents,
    expectedSubtotalCents: snapshot.subtotalTaxedCents,
    expectedDiscountAmountCents: snapshot.subtotalTaxedCents - snapshot.finalDiscountCents,
    expectedItems: snapshot.items,
    bodySummary: bodySummary.ok ? bodySummary : null,
    expectedAmountUpper: chineseMoneyUpper(snapshot.finalDiscountCents),
    maintenanceFeeCents,
    maintenanceFeeUpper: chineseMoneyUpper(maintenanceFeeCents)
  };
}

function normalizedContractInput(input, preflight) {
  const party = input.partyA || {};
  const today = localCalendarDate();
  return {
    contractNumber: cleanText(input.contractNumber, 100),
    customerId: preflight.customer.id,
    projectId: preflight.project.id,
    quoteVersionId: input.quoteVersionId,
    templateId: input.templateId,
    amountCents: preflight.expectedAmountCents,
    maintenanceFeeCents: preflight.maintenanceFeeCents,
    signedLocation: cleanText(input.signedLocation || "鹤壁", 100),
    signedOn: cleanText(input.signedOn || today, 10),
    partyAName: cleanText(party.name ?? input.partyAName ?? preflight.customer.name, 300),
    licenseScope: cleanText(party.licenseScope ?? input.licenseScope ?? preflight.customer.name, 300),
    partyALegalRepresentative: cleanText(party.legalRepresentative ?? input.partyALegalRepresentative, 100),
    partyARepresentative: cleanText(party.representative ?? input.partyARepresentative, 100),
    partyAZip: cleanText(party.zip ?? input.partyAZip, 20),
    partyAAddress: cleanText(party.address ?? input.partyAAddress, 300),
    partyAPhone: cleanText(party.phone ?? input.partyAPhone, 100),
    signingNotes: cleanText(input.signingNotes, 2000),
    confirmations: input.confirmations && typeof input.confirmations === "object" ? input.confirmations : {}
  };
}

export function createContractDraft(db, actor, input) {
  assert(actor.role === ROLES.PRESALES || actor.role === ROLES.ADMIN, 403, "CONTRACT_CREATE_FORBIDDEN", "仅客户负责人或管理员可以创建合同草稿");
  const contractNumber = cleanText(input.contractNumber, 100);
  assert(contractNumber, 400, "CONTRACT_NUMBER_REQUIRED", "合同编号不能为空");
  const preflight = preflightContract(db, actor, input);
  assert(preflight.ok, 422, "CONTRACT_PREFLIGHT_FAILED", "合同预检未通过，禁止创建合同草稿", preflight.issues);
  requireContractEditor(db, actor, preflight.customer.id);
  const normalized = normalizedContractInput({ ...input, contractNumber }, preflight);
  assert(normalized.partyAName === preflight.customer.name, 422, "CONTRACT_PARTY_A_CUSTOMER_MISMATCH", "甲方完整法定名称必须与报价客户一致");
  assert(normalized.licenseScope === normalized.partyAName, 422, "CONTRACT_LICENSE_SCOPE_MISMATCH", "本期使用权范围必须等于甲方完整法定名称");
  const id = randomUUID();
  const timestamp = nowIso();
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO contracts (
          id, contract_number, customer_id, project_id, quote_version_id, template_id,
          amount_cents, maintenance_fee_cents, signed_location, signed_on,
          party_a_name, license_scope, party_a_legal_representative, party_a_representative,
          party_a_zip, party_a_address, party_a_phone, confirmations_json,
          signing_notes, notes_updated_by, notes_updated_at,
          status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)
      `).run(
        id, normalized.contractNumber, normalized.customerId, normalized.projectId, normalized.quoteVersionId, normalized.templateId,
        normalized.amountCents, normalized.maintenanceFeeCents, normalized.signedLocation, normalized.signedOn,
        normalized.partyAName, normalized.licenseScope, normalized.partyALegalRepresentative, normalized.partyARepresentative,
        normalized.partyAZip, normalized.partyAAddress, normalized.partyAPhone, JSON.stringify(normalized.confirmations),
        normalized.signingNotes || null, normalized.signingNotes ? actor.id : null, normalized.signingNotes ? timestamp : null,
        actor.id, timestamp, timestamp
      );
      const attachmentId = randomUUID();
      const attachmentSnapshot = JSON.stringify({
        schemaVersion: 2,
        quoteVersionId: normalized.quoteVersionId,
        approvalSnapshotHash: preflight.approvalSnapshotHash,
        quoteReference: preflight.quoteReference,
        subtotalCents: preflight.expectedSubtotalCents,
        finalDiscountCents: preflight.expectedAmountCents,
        items: preflight.expectedItems
      });
      const hasLegacyTotal = db.pragma("table_info(contract_attachment_versions)").some(item => item.name === "total_cents");
      if (hasLegacyTotal) {
        db.prepare(`
          INSERT INTO contract_attachment_versions (id, contract_id, revision, kind, snapshot_json, total_cents, subtotal_cents, final_discount_cents, created_by, created_at)
          VALUES (?, ?, 1, 'PRICE_DETAIL', ?, ?, ?, ?, ?, ?)
        `).run(attachmentId, id, attachmentSnapshot, preflight.expectedAmountCents, preflight.expectedSubtotalCents, preflight.expectedAmountCents, actor.id, timestamp);
      } else {
        db.prepare(`
          INSERT INTO contract_attachment_versions (id, contract_id, revision, kind, snapshot_json, subtotal_cents, final_discount_cents, created_by, created_at)
          VALUES (?, ?, 1, 'PRICE_DETAIL', ?, ?, ?, ?, ?)
        `).run(attachmentId, id, attachmentSnapshot, preflight.expectedSubtotalCents, preflight.expectedAmountCents, actor.id, timestamp);
      }
      audit(db, { actorId: actor.id, action: "CONTRACT_DRAFT_CREATED", entityType: "CONTRACT", entityId: id, summary: { quoteVersionId: normalized.quoteVersionId, templateVersion: preflight.template.version, approvalSnapshotHash: preflight.approvalSnapshotHash, amountCents: preflight.expectedAmountCents, signingNotesLength: normalized.signingNotes.length } });
    })();
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw new AppError(409, "CONTRACT_NUMBER_EXISTS", "合同编号已存在");
    throw error;
  }
  return getContract(db, actor, id);
}

export function updateContractDraft(db, actor, contractId, input) {
  const row = contractRow(db, contractId);
  requireContractEditor(db, actor, row.customer_id);
  assert(row.status === "DRAFT", 409, "CONTRACT_NOT_DRAFT", "只有合同草稿可以修改人工字段");
  if (input.expectedDraftEtag !== undefined) {
    assert(Number.isSafeInteger(input.expectedDraftEtag) && input.expectedDraftEtag >= 0, 400, "DRAFT_ETAG_INVALID", "草稿版本标识无效");
    assert(input.expectedDraftEtag === row.draft_etag, 409, "DRAFT_VERSION_CHANGED", "草稿已在其他页面更新，请重新打开后继续编辑");
  }
  const current = getContract(db, actor, contractId);
  const party = input.partyA || {};
  const next = {
    contractNumber: cleanText(input.contractNumber ?? row.contract_number, 100),
    signedLocation: cleanText(input.signedLocation ?? row.signed_location, 100),
    signedOn: cleanText(input.signedOn ?? row.signed_on, 10),
    partyAName: cleanText(party.name ?? row.party_a_name, 300),
    licenseScope: cleanText(party.licenseScope ?? row.license_scope, 300),
    partyALegalRepresentative: cleanText(party.legalRepresentative ?? row.party_a_legal_representative, 100),
    partyARepresentative: cleanText(party.representative ?? row.party_a_representative, 100),
    partyAZip: cleanText(party.zip ?? row.party_a_zip, 20),
    partyAAddress: cleanText(party.address ?? row.party_a_address, 300),
    partyAPhone: cleanText(party.phone ?? row.party_a_phone, 100),
    signingNotes: input.signingNotes === undefined ? cleanText(row.signing_notes, 2000) : cleanText(input.signingNotes, 2000),
    confirmations: input.confirmations && typeof input.confirmations === "object" ? input.confirmations : current.confirmations
  };
  assert(next.contractNumber, 400, "CONTRACT_NUMBER_REQUIRED", "合同编号不能为空");
  assert(next.partyAName === current.customer.name, 422, "CONTRACT_PARTY_A_CUSTOMER_MISMATCH", "甲方完整法定名称必须与报价客户一致");
  assert(next.licenseScope === next.partyAName, 422, "CONTRACT_LICENSE_SCOPE_MISMATCH", "本期使用权范围必须等于甲方完整法定名称");
  const timestamp = nowIso();
  const signingNotesChanged = next.signingNotes !== cleanText(row.signing_notes, 2000);
  const confirmationsChanged = !sameFlatObject(next.confirmations, current.confirmations);
  const fieldsChanged = next.contractNumber !== row.contract_number || next.signedLocation !== row.signed_location || next.signedOn !== cleanText(row.signed_on, 10)
    || next.partyAName !== row.party_a_name || next.licenseScope !== row.license_scope || next.partyALegalRepresentative !== cleanText(row.party_a_legal_representative, 100)
    || next.partyARepresentative !== cleanText(row.party_a_representative, 100) || next.partyAZip !== cleanText(row.party_a_zip, 20)
    || next.partyAAddress !== cleanText(row.party_a_address, 300) || next.partyAPhone !== cleanText(row.party_a_phone, 100) || signingNotesChanged || confirmationsChanged;
  if (!fieldsChanged) return current;
  const nextDraftEtag = row.draft_etag + 1;
  const automatic = input.saveMode === "AUTO";
  try {
    const result = db.prepare(`
      UPDATE contracts SET contract_number = ?, signed_location = ?, signed_on = ?,
        party_a_name = ?, license_scope = ?, party_a_legal_representative = ?, party_a_representative = ?,
        party_a_zip = ?, party_a_address = ?, party_a_phone = ?, confirmations_json = ?,
        signing_notes = ?, notes_updated_by = ?, notes_updated_at = ?, updated_at = ?, draft_etag = ?, draft_saved_at = ?
      WHERE id = ? AND draft_etag = ?
    `).run(next.contractNumber, next.signedLocation, next.signedOn, next.partyAName, next.licenseScope, next.partyALegalRepresentative, next.partyARepresentative, next.partyAZip, next.partyAAddress, next.partyAPhone, JSON.stringify(next.confirmations), next.signingNotes || null, signingNotesChanged ? actor.id : row.notes_updated_by, signingNotesChanged ? timestamp : row.notes_updated_at, timestamp, nextDraftEtag, timestamp, contractId, row.draft_etag);
    assert(result.changes === 1, 409, "DRAFT_VERSION_CHANGED", "草稿已在其他页面更新，请重新打开后继续编辑");
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw new AppError(409, "CONTRACT_NUMBER_EXISTS", "合同编号已存在");
    throw error;
  }
  if (automatic) return getContract(db, actor, contractId);
  audit(db, { actorId: actor.id, action: "CONTRACT_DRAFT_UPDATED", entityType: "CONTRACT", entityId: contractId, summary: { confirmedFields: Object.keys(next.confirmations).filter(key => asBoolean(next.confirmations[key])), confirmedBlankFields: PARTY_FIELDS.filter(field => asBoolean(next.confirmations[field]) && !({ partyAName: next.partyAName, licenseScope: next.licenseScope, partyALegalRepresentative: next.partyALegalRepresentative, partyARepresentative: next.partyARepresentative, partyAZip: next.partyAZip, partyAAddress: next.partyAAddress, partyAPhone: next.partyAPhone })[field]), signingNotesChanged } });
  return getContract(db, actor, contractId);
}

function contractRow(db, contractId) {
  const row = db.prepare(`
    SELECT c.*, customer.full_name AS customer_name, customer.status AS customer_status, project.name AS project_name,
      template.version AS template_version, template.sha256 AS template_sha256,
      template.fixed_fingerprint AS template_fixed_fingerprint,
      notes_editor.display_name AS notes_updated_by_name
    FROM contracts c
    JOIN customers customer ON customer.id = c.customer_id
    JOIN projects project ON project.id = c.project_id
    JOIN contract_templates template ON template.id = c.template_id
    LEFT JOIN users notes_editor ON notes_editor.id = c.notes_updated_by
    WHERE c.id = ?
  `).get(contractId);
  if (!row) throw new AppError(404, "CONTRACT_NOT_FOUND", "合同不存在或当前账号无权访问");
  return row;
}

function fileView(row) {
  return {
    id: row.id,
    category: row.category,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    declaredScopeChanged: Boolean(row.declared_scope_changed),
    declaration: parseJson(row.declaration_json, {}),
    uploadedBy: { id: row.uploaded_by, displayName: row.uploaded_by_name },
    createdAt: row.created_at
  };
}

export function getContract(db, actor, contractId) {
  const row = contractRow(db, contractId);
  requireContractReader(db, actor, row.customer_id);
  const attachmentRow = db.prepare(`SELECT * FROM contract_attachment_versions WHERE contract_id = ? AND kind = 'PRICE_DETAIL' ORDER BY revision DESC LIMIT 1`).get(contractId);
  const attachmentSnapshot = attachmentRow ? parseJson(attachmentRow.snapshot_json, {}) : null;
  let generationSnapshot = null;
  if (row.generation_snapshot_json) {
    assert(sha256(row.generation_snapshot_json) === row.generation_snapshot_hash, 409, "CONTRACT_GENERATION_SNAPSHOT_INVALID", "合同生成快照摘要不一致");
    generationSnapshot = parseJson(row.generation_snapshot_json, null);
    assert(generationSnapshot, 409, "CONTRACT_GENERATION_SNAPSHOT_INVALID", "合同生成快照无法读取");
  }
  const verifiedQuoteReference = generationSnapshot?.quoteReference || attachmentSnapshot?.quoteReference || approvedQuoteSnapshot(db, row.quote_version_id, { allowVoid: true }).quoteReference;
  const files = db.prepare(`
    SELECT cf.*, u.display_name AS uploaded_by_name
    FROM contract_files cf JOIN users u ON u.id = cf.uploaded_by
    WHERE cf.contract_id = ? ORDER BY cf.created_at, cf.rowid
  `).all(contractId).map(fileView);
  const canEdit = [ROLES.PRESALES, ROLES.ADMIN].includes(actor.role) && (actor.role === ROLES.ADMIN || canReadCustomer(db, actor, row.customer_id));
  return {
    id: row.id,
    contractNumber: row.contract_number,
    status: row.status,
    customer: { id: row.customer_id, name: row.customer_name },
    project: { id: row.project_id, name: row.project_name },
    quoteVersionId: row.quote_version_id,
    quoteReference: verifiedQuoteReference,
    template: { id: row.template_id, version: row.template_version, sha256: row.template_sha256, fixedFingerprint: row.template_fixed_fingerprint },
    locked: {
      amountCents: row.amount_cents,
      amountUpper: chineseMoneyUpper(row.amount_cents),
      maintenanceFeeCents: row.maintenance_fee_cents,
      maintenanceFeeUpper: chineseMoneyUpper(row.maintenance_fee_cents),
      attachment: attachmentSnapshot
    },
    partyA: {
      name: row.party_a_name,
      licenseScope: row.license_scope,
      legalRepresentative: row.party_a_legal_representative,
      representative: row.party_a_representative,
      zip: row.party_a_zip,
      address: row.party_a_address,
      phone: row.party_a_phone
    },
    manual: { contractNumber: row.contract_number, signLocation: row.signed_location, signDate: row.signed_on },
    confirmations: parseJson(row.confirmations_json, {}),
    fixedTerms: { editable: false, message: "乙方信息、交付周期、付款条款、验收、知识产权、售后比例、变更和法律条款来自已发布模板固定正文，不开放编辑。" },
    signingNotes: { value: row.signing_notes || "", updatedBy: row.notes_updated_by ? { id: row.notes_updated_by, displayName: row.notes_updated_by_name } : null, updatedAt: row.notes_updated_at },
    generationSigningNotes: generationSnapshot?.signingNotes || null,
    generationSnapshotHash: row.generation_snapshot_hash,
    generatedAt: row.generated_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    draftEtag: row.draft_etag,
    draftSavedAt: row.draft_saved_at,
    files,
    customerStatusSuggestion: row.status === "SIGNED" && row.customer_status !== "合同签订完成" && canEdit ? {
      targetStatus: "合同签订完成",
      message: "建议将客户状态更新为合同签订完成",
      requiresConfirmation: true
    } : null
  };
}

export function listContracts(db, actor) {
  let ids;
  if (actor.role === ROLES.ADMIN) {
    ids = db.prepare(`SELECT id FROM contracts ORDER BY created_at DESC`).all();
  } else if (actor.role === ROLES.PRESALES) {
    ids = db.prepare(`SELECT c.id FROM contracts c JOIN customers customer ON customer.id = c.customer_id WHERE customer.owner_id = ? ORDER BY c.created_at DESC`).all(actor.id);
  } else if (actor.role === ROLES.MANAGER) {
    ids = db.prepare(`SELECT c.id FROM contracts c JOIN customers customer ON customer.id = c.customer_id JOIN users owner ON owner.id = customer.owner_id WHERE owner.manager_id = ? ORDER BY c.created_at DESC`).all(actor.id);
  } else {
    ids = [];
  }
  return ids.map(row => getContract(db, actor, row.id));
}

function validateGenerationConfirmations(contract) {
  const issues = [];
  assert(contract.partyA.name === contract.customer.name, 422, "CONTRACT_PARTY_A_CUSTOMER_MISMATCH", "甲方完整法定名称必须与报价客户一致");
  assert(contract.partyA.licenseScope === contract.partyA.name, 422, "CONTRACT_LICENSE_SCOPE_MISMATCH", "本期使用权范围必须等于甲方完整法定名称");
  assert(contract.manual.contractNumber, 422, "CONTRACT_NUMBER_REQUIRED", "合同编号不能为空");
  assert(contract.manual.signLocation, 422, "CONTRACT_SIGN_LOCATION_REQUIRED", "签订地点不能为空");
  assert(isValidCalendarDate(contract.manual.signDate), 422, "CONTRACT_SIGN_DATE_INVALID", "签订日期必须为有效日历日期");
  for (const field of [...PARTY_FIELDS, ...MANUAL_FIELDS]) {
    if (!asBoolean(contract.confirmations[field])) issues.push({ field: `confirmations.${field}`, message: `${field}必须由经办人逐项确认` });
  }
  assert(issues.length === 0, 422, "CONTRACT_CONFIRMATION_REQUIRED", "待人工确认字段尚未逐项确认", issues);
}

export async function generateContractDocument(db, config, actor, contractId) {
  const row = contractRow(db, contractId);
  requireContractEditor(db, actor, row.customer_id);
  assert(row.status === "DRAFT", 409, "CONTRACT_NOT_DRAFT", "只有草稿合同可以生成原始 Word");
  const existing = db.prepare(`SELECT 1 FROM contract_files WHERE contract_id = ? AND category = 'SYSTEM_GENERATED'`).get(contractId);
  assert(!existing, 409, "CONTRACT_ORIGINAL_EXISTS", "系统生成的原始 Word 已归档，不可覆盖");
  const contract = getContract(db, actor, contractId);
  validateGenerationConfirmations(contract);
  const preflight = preflightContract(db, actor, {
    quoteVersionId: row.quote_version_id,
    templateId: row.template_id,
    customerId: row.customer_id,
    projectId: row.project_id,
    contractAmountCents: row.amount_cents,
    attachment: {
      subtotalCents: contract.locked.attachment?.subtotalCents,
      finalDiscountCents: contract.locked.attachment?.finalDiscountCents,
      items: contract.locked.attachment?.items
    }
  });
  const bodySummary = summarizeContractBodyItems(preflight.expectedItems);
  assert(bodySummary.ok, 422, bodySummary.code, bodySummary.message);
  assert(preflight.ok, 422, "CONTRACT_PREFLIGHT_FAILED", "合同生成前校验未通过", preflight.issues);
  assert(row.maintenance_fee_cents === preflight.maintenanceFeeCents, 409, "CONTRACT_MAINTENANCE_FEE_MISMATCH", "年度维护费与终审报价最终优惠价的 10% 不一致");
  const publishedTemplate = await loadPublishedTemplate(db, config, row.template_id);
  const values = {
    contractNumber: contract.manual.contractNumber,
    signLocation: contract.manual.signLocation,
    signDate: contract.manual.signDate,
    partyAName: contract.partyA.name,
    licenseScope: contract.partyA.licenseScope,
    partyALegalRepresentative: contract.partyA.legalRepresentative,
    partyARepresentative: contract.partyA.representative,
    partyAZip: contract.partyA.zip,
    partyAAddress: contract.partyA.address,
    partyAPhone: contract.partyA.phone,
    productNames: bodySummary.productNames,
    bodyUnit: bodySummary.unit,
    bodyQuantity: quantity(bodySummary.quantityMilli),
    bodyUntaxedUnitPrice: money(bodySummary.untaxedUnitPriceCents),
    bodyUntaxedAmount: money(bodySummary.untaxedAmountCents),
    bodyTaxRate: taxRate(bodySummary.taxRateBps),
    bodyTaxedAmount: money(bodySummary.taxedAmountCents),
    bodySubtotal: money(preflight.expectedSubtotalCents),
    contractAmount: money(preflight.expectedAmountCents),
    contractAmountUpper: preflight.expectedAmountUpper,
    maintenanceFee: money(preflight.maintenanceFeeCents),
    maintenanceFeeUpper: preflight.maintenanceFeeUpper
  };
  const generated = await generateContractFromTemplate(publishedTemplate.buffer, values, {
    subtotalTaxedCents: preflight.expectedSubtotalCents,
    finalDiscountCents: preflight.expectedAmountCents,
    items: preflight.expectedItems
  });
  const generationSnapshot = {
    schemaVersion: 1,
    quoteVersionId: row.quote_version_id,
    quoteReference: preflight.quoteReference,
    approvalSnapshotHash: preflight.approvalSnapshotHash,
    template: { id: row.template_id, version: publishedTemplate.row.version, sha256: publishedTemplate.row.sha256, fixedFingerprint: generated.fixedFingerprint },
    locked: {
      items: preflight.expectedItems,
      bodyPriceSummary: bodySummary,
      subtotalCents: preflight.expectedSubtotalCents,
      finalDiscountCents: preflight.expectedAmountCents,
      amountUpper: preflight.expectedAmountUpper,
      maintenanceFeeCents: preflight.maintenanceFeeCents,
      maintenanceFeeUpper: preflight.maintenanceFeeUpper
    },
    partyA: contract.partyA,
    manual: contract.manual,
    confirmations: contract.confirmations,
    signingNotes: contract.signingNotes,
    generatedBy: actor.id,
    generatedAt: nowIso()
  };
  const confirmedBlankFields = PARTY_FIELDS.filter(field => {
    const valueKey = {
      partyAName: "name",
      licenseScope: "licenseScope",
      partyALegalRepresentative: "legalRepresentative",
      partyARepresentative: "representative",
      partyAZip: "zip",
      partyAAddress: "address",
      partyAPhone: "phone"
    }[field];
    return !contract.partyA[valueKey] && asBoolean(contract.confirmations[field]);
  });
  const snapshotJson = JSON.stringify(generationSnapshot);
  const stored = storeManagedBuffer(config, { directory: "contracts", extension: ".docx", buffer: generated.buffer });
  const fileId = randomUUID();
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO contract_files (id, contract_id, category, original_name, storage_key, mime_type, size_bytes, sha256, declared_scope_changed, declaration_json, uploaded_by, created_at)
        VALUES (?, ?, 'SYSTEM_GENERATED', ?, ?, ?, ?, ?, 0, '{}', ?, ?)
      `).run(fileId, contractId, safeDownloadName(`${contract.contractNumber}-系统生成原始版.docx`, "合同-系统生成原始版.docx"), stored.storageKey, DOCX_MIME, stored.sizeBytes, stored.sha256, actor.id, generationSnapshot.generatedAt);
      db.prepare(`UPDATE contracts SET status = 'GENERATED', generation_snapshot_json = ?, generation_snapshot_hash = ?, generated_at = ?, updated_at = ? WHERE id = ?`)
        .run(snapshotJson, sha256(snapshotJson), generationSnapshot.generatedAt, generationSnapshot.generatedAt, contractId);
      audit(db, { actorId: actor.id, action: "CONTRACT_DOCX_GENERATED", entityType: "CONTRACT", entityId: contractId, summary: { fileId, sha256: stored.sha256, approvalSnapshotHash: preflight.approvalSnapshotHash, templateSha256: publishedTemplate.row.sha256, amountCents: preflight.expectedAmountCents, maintenanceFeeCents: preflight.maintenanceFeeCents, confirmedBlankFields } });
    })();
  } catch (error) {
    removeManagedFile(config, stored.storageKey);
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw new AppError(409, "CONTRACT_ORIGINAL_EXISTS", "系统生成的原始 Word 已归档，不可重复生成或覆盖");
    throw error;
  }
  return getContract(db, actor, contractId);
}

function archiveCategoryRule(category) {
  if (category === "WORD_EDITED") return "CONTRACT_EDITED_DOCX";
  if (category === "FINAL_SIGNED") return "CONTRACT_SIGNED_FILE";
  throw new AppError(400, "CONTRACT_FILE_CATEGORY_INVALID", "归档文件类别无效");
}

function normalizedDeclaration(input) {
  const declaration = {};
  for (const field of SENSITIVE_CHANGE_FIELDS) declaration[field] = asBoolean(input?.[field]);
  declaration.changed = SENSITIVE_CHANGE_FIELDS.some(field => declaration[field]);
  declaration.confirmed = asBoolean(input?.confirmed);
  declaration.note = cleanText(input?.note, 500);
  return declaration;
}

export function archiveContractFile(db, config, actor, contractId, category, file, declarationInput) {
  const row = contractRow(db, contractId);
  requireContractEditor(db, actor, row.customer_id);
  assert(["GENERATED", "SIGNING"].includes(row.status), 409, "CONTRACT_NOT_GENERATED", "必须先生成并归档系统原始 Word");
  const declaration = normalizedDeclaration(declarationInput);
  assert(declaration.confirmed, 422, "CONTRACT_CHANGE_DECLARATION_REQUIRED", "必须逐项声明外部修改是否涉及金额或范围关键字段");
  if (category === "FINAL_SIGNED") {
    assert(!declaration.changed, 422, "CONTRACT_FINAL_SCOPE_CHANGED", "外部修改涉及金额、范围、数量、单价或税率，禁止标记最终版；请回报价创建新版本并重新完成三级审批");
    const previousChanged = db.prepare(`SELECT 1 FROM contract_files WHERE contract_id = ? AND category = 'WORD_EDITED' AND declared_scope_changed = 1 LIMIT 1`).get(contractId);
    assert(!previousChanged, 422, "CONTRACT_HISTORY_SCOPE_CHANGED", "历史外部修改版已声明涉及金额、范围、数量、单价或税率，禁止通过本次无变化声明绕过；请回报价创建新版本并重新完成三级审批");
  }
  const rule = archiveCategoryRule(category);
  const format = validateUploadedFile(file, rule);
  const stored = storeManagedBuffer(config, { directory: "contracts", extension: format.extension, buffer: file.buffer });
  const id = randomUUID();
  const timestamp = nowIso();
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO contract_files (id, contract_id, category, original_name, storage_key, mime_type, size_bytes, sha256, declared_scope_changed, declaration_json, uploaded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, contractId, category, safeDownloadName(file.originalname, `${category}${format.extension}`), stored.storageKey, format.mimeType, stored.sizeBytes, stored.sha256, declaration.changed ? 1 : 0, JSON.stringify(declaration), actor.id, timestamp);
      const nextStatus = category === "FINAL_SIGNED" ? "SIGNED" : "SIGNING";
      db.prepare(`UPDATE contracts SET status = ?, updated_at = ? WHERE id = ?`).run(nextStatus, timestamp, contractId);
      audit(db, { actorId: actor.id, action: category === "FINAL_SIGNED" ? "CONTRACT_FINAL_SIGNED_ARCHIVED" : "CONTRACT_EDITED_WORD_ARCHIVED", entityType: "CONTRACT", entityId: contractId, summary: { fileId: id, sha256: stored.sha256, declaration, nextStatus } });
    })();
  } catch (error) {
    removeManagedFile(config, stored.storageKey);
    throw error;
  }
  return getContract(db, actor, contractId);
}

export function updateSigningNotes(db, actor, contractId, notes) {
  const row = contractRow(db, contractId);
  requireContractEditor(db, actor, row.customer_id);
  assert(row.status !== "VOID", 409, "CONTRACT_VOID", "已作废合同不可修改签订备注");
  const text = cleanText(notes, 2000);
  const timestamp = nowIso();
  db.prepare(`UPDATE contracts SET signing_notes = ?, notes_updated_by = ?, notes_updated_at = ?, updated_at = ? WHERE id = ?`).run(text || null, actor.id, timestamp, timestamp, contractId);
  audit(db, { actorId: actor.id, action: "CONTRACT_SIGNING_NOTES_UPDATED", entityType: "CONTRACT", entityId: contractId, summary: { length: text.length } });
  return getContract(db, actor, contractId);
}

export function voidContract(db, actor, contractId, reason) {
  const row = contractRow(db, contractId);
  requireContractEditor(db, actor, row.customer_id);
  const text = cleanText(reason, 500);
  assert(text, 400, "CONTRACT_VOID_REASON_REQUIRED", "作废必须填写原因");
  assert(CONTRACT_STATUSES.includes(row.status) && row.status !== "VOID", 409, "CONTRACT_ALREADY_VOID", "合同已作废");
  const timestamp = nowIso();
  db.prepare(`UPDATE contracts SET status = 'VOID', updated_at = ? WHERE id = ?`).run(timestamp, contractId);
  audit(db, { actorId: actor.id, action: "CONTRACT_VOIDED", entityType: "CONTRACT", entityId: contractId, summary: { reason: text, previousStatus: row.status } });
  return getContract(db, actor, contractId);
}

export function confirmSignedContractCustomerStatus(db, actor, contractId, input = {}) {
  const row = contractRow(db, contractId);
  requireContractEditor(db, actor, row.customer_id);
  assert(input.confirmed === true, 400, "CONTRACT_CUSTOMER_STATUS_CONFIRMATION_REQUIRED", "必须明确确认后才能更新客户状态");
  assert(row.status === "SIGNED", 409, "CONTRACT_NOT_SIGNED", "只有已签订合同可以建议更新客户状态");
  if (row.customer_status === "合同签订完成") return getContract(db, actor, contractId);
  db.transaction(() => {
    updateCustomer(db, actor, row.customer_id, { status: "合同签订完成" });
    audit(db, {
      actorId: actor.id,
      action: "CONTRACT_CUSTOMER_STATUS_CONFIRMED",
      entityType: "CONTRACT",
      entityId: contractId,
      summary: { customerId: row.customer_id, before: row.customer_status, after: "合同签订完成", confirmedByUser: true }
    });
  })();
  return getContract(db, actor, contractId);
}

export function getContractFileDownload(db, config, actor, fileId) {
  const row = db.prepare(`
    SELECT cf.*, c.customer_id
    FROM contract_files cf JOIN contracts c ON c.id = cf.contract_id
    WHERE cf.id = ?
  `).get(fileId);
  assert(row, 404, "CONTRACT_FILE_NOT_FOUND", "合同文件不存在或当前账号无权下载");
  requireContractReader(db, actor, row.customer_id);
  const absolutePath = resolveManagedPath(config, row.storage_key);
  assert(fs.existsSync(absolutePath), 404, "CONTRACT_FILE_MISSING", "合同归档文件缺失，请联系管理员");
  audit(db, { actorId: actor.id, action: "CONTRACT_FILE_DOWNLOADED", entityType: "CONTRACT_FILE", entityId: fileId, summary: { contractId: row.contract_id, category: row.category } });
  return { absolutePath, downloadName: safeDownloadName(row.original_name, path.basename(absolutePath)), mimeType: row.mime_type };
}

export const __test = { isValidCalendarDate, localCalendarDate, normalizedDeclaration, validateGenerationConfirmations };
