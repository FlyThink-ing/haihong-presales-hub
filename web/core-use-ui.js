export function buildCustomerFilterQuery(filters = {}) {
  const params = new URLSearchParams();
  for (const key of ["search", "ownerId", "status", "source", "customerType", "industry", "region", "registeredFrom", "registeredTo"]) {
    const value = String(filters[key] || "").trim();
    if (value) params.set(key, value);
  }
  return params.toString();
}

export function createLatestRequestGate() {
  let latest = 0;
  return {
    begin() { latest += 1; return latest; },
    invalidate() { latest += 1; },
    isCurrent(requestId) { return requestId === latest; }
  };
}

export function normalizedMapPosition(value) {
  const xPercent = value?.xPercent;
  const yPercent = value?.yPercent;
  if (typeof xPercent !== "number" || typeof yPercent !== "number" || !Number.isFinite(xPercent) || !Number.isFinite(yPercent) || xPercent < 0 || xPercent > 100 || yPercent < 0 || yPercent > 100) return null;
  return { left: xPercent, top: yPercent };
}

export function reminderTargetAction(target) {
  if (!target) return null;
  if (target.page === "customer") return { action: "customer", id: target.customerId, tab: target.tab || "overview" };
  if (["survey", "quote", "contract"].includes(target.page)) return { action: target.page, id: target.id };
  return null;
}

export function shouldShowSignedStatusSuggestion(contract) {
  return Boolean(contract?.status === "SIGNED" && contract?.customerStatusSuggestion?.requiresConfirmation);
}
