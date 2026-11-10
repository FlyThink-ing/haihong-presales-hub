import { AppError, assert, ROLES } from "./domain.js";
import { canReadCustomer } from "./permissions.js";
import { getAttachmentPreview, validateQuoteAttachmentFormat } from "./attachment-service.js";
import { getQuoteVersion } from "./quote-service.js";
import { currentReviewSource } from "./quote-review-repository.js";
import { parseQuoteDocument } from "./quote-document-parser.js";
import { inspectQuoteBinding } from "./quote-binding.js";

function amountValue(value) {
  const text = String(value ?? "");
  assert(/^\d+$/.test(text), 400, "QUOTE_AMOUNT_INVALID", "请填写有效的报价单含税总额");
  const amount = Number(text);
  assert(Number.isSafeInteger(amount) && amount > 0, 400, "QUOTE_AMOUNT_INVALID", "请填写有效的报价单含税总额");
  return amount;
}

export async function preflightQuoteFile(db, actor, input, file) {
  assert([ROLES.ADMIN, ROLES.PRESALES].includes(actor.role), 403, "QUOTE_CREATE_FORBIDDEN", "仅售前人员或管理员可以创建报价");
  assert(canReadCustomer(db, actor, input.customerId), 404, "CUSTOMER_NOT_FOUND", "客户不存在或当前账号无权访问");
  const customer = db.prepare(`SELECT full_name, short_name, owner_id FROM customers WHERE id = ?`).get(input.customerId);
  const amount = amountValue(input.amountCents);
  const format = await validateQuoteAttachmentFormat(file, ".pdf");
  assert(canReadCustomer(db, actor, input.customerId), 404, "CUSTOMER_NOT_FOUND", "客户不存在或当前账号无权访问");
  const current = db.prepare(`SELECT full_name, short_name, owner_id FROM customers WHERE id = ?`).get(input.customerId);
  assert(current && current.owner_id === customer.owner_id && current.full_name === customer.full_name && current.short_name === customer.short_name, 409, "QUOTE_CUSTOMER_CHANGED", "客户信息已变化，请重新核对");
  return inspectQuoteBinding(format.quotePdfParsed, { customerName: customer.full_name, customerShortName: customer.short_name, amountCents: amount });
}

export async function currentQuoteBinding(db, config, actor, versionId, amountOverride) {
  const quote = getQuoteVersion(db, actor, versionId);
  if (quote.sourceKind !== "UPLOADED" || quote.status !== "DRAFT") return null;
  const before = currentReviewSource(db, versionId);
  if (before.sources.length !== 1 || before.sources[0].mime_type !== "application/pdf") return null;
  const customer = db.prepare(`SELECT full_name, short_name FROM customers WHERE id = ?`).get(before.version.customer_id);
  const amount = amountOverride === undefined ? before.version.final_discount_cents : amountValue(amountOverride);
  const source = before.sources[0];
  const file = getAttachmentPreview(db, config, actor, source.attachment_id, source.current_version_id);
  const parsed = await parseQuoteDocument(file);
  // Do not report an inspection for a file, amount, owner or customer that changed while parsing.
  getQuoteVersion(db, actor, versionId);
  const after = currentReviewSource(db, versionId);
  const customerNow = db.prepare(`SELECT full_name, short_name FROM customers WHERE id = ?`).get(after.version.customer_id);
  if (after.sources.length !== 1 || after.sources[0].current_version_id !== source.current_version_id || after.sources[0].sha256 !== source.sha256
    || after.version.status !== before.version.status || after.version.current_version_id !== before.version.current_version_id
    || after.version.draft_etag !== before.version.draft_etag || after.version.final_discount_cents !== before.version.final_discount_cents
    || after.version.owner_id !== before.version.owner_id || after.transferCount !== before.transferCount
    || !customerNow || customerNow.full_name !== customer.full_name || customerNow.short_name !== customer.short_name)
    throw new AppError(409, "QUOTE_BINDING_CHANGED", "报价、文件或客户资料已变化，请重新核对");
  return inspectQuoteBinding(parsed, { customerName: customer.full_name, customerShortName: customer.short_name, amountCents: amount });
}
