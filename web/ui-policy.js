export const CUSTOMER_CREATE_ROLES = Object.freeze(["PRESALES", "MANAGER", "ADMIN"]);
export const CUSTOMER_DETAIL_TABS = Object.freeze([
  ["overview", "概览"],
  ["contacts", "联系人"],
  ["followups", "跟进"],
  ["reminders", "提醒"],
  ["surveys", "软件调研"],
  ["quotes", "报价"],
  ["contracts", "合同"],
  ["files", "附件与操作日志"]
]);

export function canCreateCustomer(role) {
  return CUSTOMER_CREATE_ROLES.includes(role);
}
