import { sha256 } from "./security.js";

export const MUNICH_VISIT_SHEET = "慕尼黑客户拜访记录";
export const MUNICH_VISIT_FIELDS = Object.freeze([
  { key: "sequence", label: "序号" },
  { key: "customerName", label: "客户名称" },
  { key: "intention", label: "意向" },
  { key: "industry", label: "行业" },
  { key: "needSummary", label: "客户需求" },
  { key: "contactName", label: "接洽人" },
  { key: "registeredOn", label: "登记时间" },
  { key: "salesText", label: "售前" },
  { key: "notes", label: "备注" },
  { key: "plannedVisitOn", label: "计划拜访日期" },
  { key: "visitStatus", label: "拜访状态" }
]);

function rawText(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  return String(value ?? "");
}

function candidateText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

export function visitDateCandidate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86_400_000));
    return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
  }
  const raw = String(value ?? "").trim().replace(/[年/.]/g, "-").replace(/月/g, "-").replace(/日/g, "");
  const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const normalized = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const date = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== normalized ? null : normalized;
}

export function visitSourceIdentity({ sourceSha256, sheetName, rowNumber }) {
  return sha256(JSON.stringify([String(sourceSha256).toLowerCase(), sheetName, Number(rowNumber)]));
}

export function validateMunichVisitHeaders(labels) {
  const actual = labels.map(value => String(value ?? "").trim());
  const expected = MUNICH_VISIT_FIELDS.map(field => field.label);
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function parseMunichVisitRow(values, formulaKeys = []) {
  const rawFields = Object.fromEntries(MUNICH_VISIT_FIELDS.map(field => [field.label, rawText(values[field.key])]));
  const customerName = candidateText(values.customerName, 200);
  const registeredOn = visitDateCandidate(values.registeredOn);
  const plannedVisitOn = visitDateCandidate(values.plannedVisitOn);
  const contactRaw = String(values.contactName ?? "").trim();
  const contactName = contactRaw && contactRaw.length <= 50 && /^[\p{L}·• ]+$/u.test(contactRaw) ? contactRaw : null;
  const errors = [];
  const warnings = [];
  if (!customerName) errors.push("CUSTOMER_NAME_REQUIRED");
  if (String(values.customerName ?? "").trim().length > 200) errors.push("CUSTOMER_NAME_TOO_LONG");
  if (String(values.needSummary ?? "").trim().length > 2_000) errors.push("CUSTOMER_NEED_TOO_LONG");
  if (String(values.industry ?? "").trim().length > 200) errors.push("CUSTOMER_INDUSTRY_TOO_LONG");
  if (String(values.notes ?? "").trim().length > 2_000) errors.push("CUSTOMER_NOTES_TOO_LONG");
  if (String(values.registeredOn ?? "").trim() && !registeredOn) errors.push("REGISTERED_ON_INVALID");
  if (String(values.plannedVisitOn ?? "").trim() && !plannedVisitOn) errors.push("PLANNED_VISIT_ON_INVALID");
  for (const key of formulaKeys) errors.push(`FORMULA_REVIEW_REQUIRED:${key}`);
  if (contactRaw && !contactName) warnings.push("CONTACT_NAME_REVIEW_REQUIRED");
  return {
    rawFields,
    normalized: {
      customerName,
      intention: candidateText(values.intention, 100) || null,
      industry: candidateText(values.industry, 200) || null,
      needSummary: candidateText(values.needSummary, 2_000) || null,
      contactName,
      contactRaw: contactRaw || null,
      registeredOn,
      salesText: candidateText(values.salesText, 200) || null,
      notes: candidateText(values.notes, 2_000) || null,
      plannedVisitOn,
      visitStatus: candidateText(values.visitStatus, 100) || null
    },
    errors: [...new Set(errors)],
    warnings
  };
}
