import { field } from "./quote-document-checks.js";
import { checkPdfTables } from "./quote-pdf-tables.js";
import { checkFixedQuoteFields } from "./quote-fixed-check.js";
import { AppError } from "./domain.js";

const normalizeName = value => String(value ?? "").normalize("NFKC").replace(/[\s\u3000]+/g, "").toLowerCase();

// Compare only fields actually extracted from the main quotation. The file name is never used as evidence.
export function inspectQuoteBinding(parsed, { customerName, customerShortName, amountCents }) {
  const fixedFields = checkFixedQuoteFields(parsed);
  const end = parsed.boundary?.endIndex;
  const units = parsed.units.slice(0, (Number.isInteger(end) ? end : fixedFields.endIndex) + 1);
  const customer = field(units, /^(?:客户名称|客户)[:：]?/);
  const actualName = customer.value && customer.value.length <= 200 ? customer.value : null;
  const possibleNames = [customerName, customerShortName].filter(Boolean).map(normalizeName);
  const uncertain = Boolean(parsed.limitations?.length);
  const customerStatus = !actualName || uncertain ? "UNRECOGNIZED"
    : possibleNames.includes(normalizeName(actualName)) ? "MATCH" : "MISMATCH";
  if (!Number.isInteger(end)) return {
    customer: { status: customerStatus, expected: customerName, actual: actualName },
    amount: { status: "UNRECOGNIZED", expectedCents: amountCents, actualCents: null },
    hasMismatch: customerStatus === "MISMATCH", needsReview: true, fixedFields
  };
  const totals = checkPdfTables(parsed.lines, end, () => {}, { uncertain });
  const total = totals.final;
  const amountStatus = total === null || totals.finalFormula ? "UNRECOGNIZED" : total === amountCents ? "MATCH" : "MISMATCH";
  return {
    customer: { status: customerStatus, expected: customerName, actual: actualName },
    amount: { status: amountStatus, expectedCents: amountCents, actualCents: total },
    hasMismatch: customerStatus === "MISMATCH" || amountStatus === "MISMATCH",
    needsReview: customerStatus === "UNRECOGNIZED" || amountStatus === "UNRECOGNIZED", fixedFields
  };
}

export function requireMatchingQuoteBinding(binding) {
  if (!binding.hasMismatch) return;
  const details = [];
  if (binding.customer.status === "MISMATCH") details.push({ message: `客户不一致：文件为“${binding.customer.actual}”，所选客户为“${binding.customer.expected}”。` });
  if (binding.amount.status === "MISMATCH") {
    const money = value => (value / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    details.push({ message: `金额不一致：文件为 ${money(binding.amount.actualCents)} 元，填写为 ${money(binding.amount.expectedCents)} 元。` });
  }
  throw new AppError(422, "QUOTE_BINDING_MISMATCH", "报价文件与所选客户或填写金额不一致", details);
}

export function requireQuoteBindingReview(binding) {
  if (binding.customer.status === "UNRECOGNIZED") throw new AppError(422, "QUOTE_CUSTOMER_UNRECOGNIZED", "无法识别报价单中的客户名称，请检查文件后重新上传");
}
