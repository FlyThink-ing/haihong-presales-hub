export const ROLES = Object.freeze({
  PRESALES: "PRESALES",
  MANAGER: "MANAGER",
  VP: "VP",
  ADMIN: "ADMIN"
});

export const CUSTOMER_STATUSES = Object.freeze([
  "初期接洽",
  "现场调研",
  "方案&报价",
  "报价完成&商务洽谈",
  "合同签订完成",
  "丢标",
  "中止"
]);

export const QUOTE_STATUSES = Object.freeze({
  DRAFT: "DRAFT",
  PENDING_MANAGER: "PENDING_MANAGER",
  MANAGER_RETURNED: "MANAGER_RETURNED",
  PENDING_VP: "PENDING_VP",
  VP_RETURNED: "VP_RETURNED",
  APPROVED: "APPROVED",
  VOID: "VOID"
});

export const QUOTE_APPROVAL_STAGES = Object.freeze({
  MANAGER: "MANAGER",
  GENERAL_MANAGER: "GENERAL_MANAGER",
  VP: "VP"
});

export const MANAGER_POSITIONS = Object.freeze({
  RND_MANAGER: "RND_MANAGER",
  GENERAL_MANAGER: "GENERAL_MANAGER"
});

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assert(condition, status, code, message, details) {
  if (!condition) throw new AppError(status, code, message, details);
}

