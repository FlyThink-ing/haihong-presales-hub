import { field } from "./quote-document-checks.js";
import { AppError } from "./domain.js";

const compact = value => String(value ?? "").replace(/[\s\u3000]+/g, "");
const blank = value => !value || /^(?:待填写|待补充|待定|未填写|无|N\/?A|[-—_－•*.]{2,}|\{\{.*\}\})$/i.test(compact(value));
const attachmentHeading = text => /^附件(?:[一二三四五六七八九十\d]+|[：:\-—.、]|$)/.test(compact(text));

// Only the main quotation is inspected; its seller email is the expected end marker.
export function checkFixedQuoteFields(parsed) {
  const suggested = parsed.boundary?.endIndex;
  const firstAttachment = parsed.units.findIndex(unit => attachmentHeading(unit.text));
  const verifiedBoundary = Number.isInteger(suggested) && (firstAttachment < 0 || suggested < firstAttachment);
  const last = verifiedBoundary ? suggested : firstAttachment >= 0 ? firstAttachment - 1 : parsed.units.length - 1;
  const units = parsed.units.slice(0, last + 1);
  const definitions = [
    ["客户", /^(?:客户名称|客户)[:：]?/],
    ["日期", /^(?:报价日期|日期)[:：]?/],
    ["开户行", /^(?:开户银行|开户行)[:：]?/],
    ["账号", /^(?:银行账号|账号|帐号|账户)[:：]?/],
    ["报价人", /^(?:报价人|报价员)[:：]?/]
  ];
  const issues = [];
  const report = (name, result) => {
    if (!result.found) issues.push({ field: name, code: "NOT_RECOGNIZED", message: `未能识别${name}，请检查报价单后重新上传。` });
    else if (blank(result.value)) issues.push({ field: name, code: "REQUIRED", message: `报价单中的${name}未填写，请补充后重新上传。` });
  };
  let seller;
  for (const [name, pattern] of definitions) {
    const result = field(units, pattern);
    report(name, result);
    if (name === "报价人") seller = result;
  }
  const sellerIndex = seller?.index >= 0 ? seller.index : units.length;
  const phone = field(units, /^(?:手机号|手机|联系电话|电话)[:：]?/, sellerIndex);
  const email = field(units, /^(?:电子邮箱|邮箱|E-?mail)[:：]?/i, sellerIndex);
  report("报价人电话", phone);
  if (email.value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value) && units[email.valueIndex + 1]) {
    const next = units[email.valueIndex + 1];
    if (next.page === units[email.index]?.page && Math.abs(next.pdfY - units[email.index]?.pdfY) <= 26) {
      const combined = email.value + compact(next.text);
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(combined)) email.value = combined;
    }
  }
  report("报价人邮箱", email);
  if (email.found && !blank(email.value) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value))
    issues.push({ field: "报价人邮箱", code: "INCOMPLETE", message: "报价单中的报价人邮箱不完整，请补充后重新上传。" });
  if (!verifiedBoundary && !issues.some(issue => issue.field === "报价人邮箱"))
    issues.push({ field: "报价人邮箱", code: "BOUNDARY_UNRECOGNIZED", message: "无法定位主报价的报价人邮箱，请检查报价单后重新上传。" });
  return { issues, endIndex: last, errorCount: issues.length, reviewCount: 0 };
}

export function requireFixedQuoteFields(result) {
  if (result.errorCount) throw new AppError(422, "QUOTE_FIXED_FIELDS_REQUIRED", "报价单有必填字段未能确认，请修改后重新上传", result.issues.map(issue => ({ message: issue.message })));
}
