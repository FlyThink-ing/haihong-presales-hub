// 当两张表表达同一含税总额、且税率相同时，单行反算取整可能产生几分尾差。
// 以总价表为准，记录两张表各自反算造成的分位差异。
export function quoteDetailRoundingAdjustment(summaryItems, detailItems) {
  if (!summaryItems?.length || !detailItems?.length) return 0;
  const all = [...summaryItems, ...detailItems];
  if (all.some(item => item.pricingMode !== "TAXED_TOTAL" || !Number.isSafeInteger(item.taxRateBps)
    || !Number.isSafeInteger(item.taxedAmountCents) || !Number.isSafeInteger(item.untaxedAmountCents))) return 0;
  if (new Set(all.map(item => item.taxRateBps)).size !== 1) return 0;
  const total = (items, key) => items.reduce((sum, item) => sum + item[key], 0);
  const summaryTaxed = total(summaryItems, "taxedAmountCents");
  const detailTaxed = total(detailItems, "taxedAmountCents");
  if (!Number.isSafeInteger(summaryTaxed) || summaryTaxed <= 0 || summaryTaxed !== detailTaxed) return 0;
  const difference = total(summaryItems, "untaxedAmountCents") - total(detailItems, "untaxedAmountCents");
  return Number.isSafeInteger(difference) && Math.abs(difference) <= Math.ceil(all.length / 2) ? difference : 0;
}

// 按反算时的舍入方向逐分分配，保证展示明细之和与总价一致；原始含税金额不变。
export function quoteDetailRoundingAllocations(summaryItems, detailItems) {
  const difference = quoteDetailRoundingAdjustment(summaryItems, detailItems);
  const allocations = (detailItems || []).map(() => 0);
  if (!difference) return allocations;
  const direction = Math.sign(difference);
  const order = detailItems.map((item, index) => ({
    index,
    residual: item.taxedAmountCents * 10_000 / (10_000 + item.taxRateBps) - item.untaxedAmountCents
  })).sort((a, b) => direction * (b.residual - a.residual) || a.index - b.index);
  let remaining = Math.abs(difference);
  while (remaining > 0) {
    let progressed = false;
    for (const { index } of order) {
      if (direction < 0 && detailItems[index].untaxedAmountCents + allocations[index] <= 0) continue;
      allocations[index] += direction;
      remaining -= 1;
      progressed = true;
      if (!remaining) break;
    }
    if (!progressed) throw new Error("无法在费用明细中分摊舍入差额");
  }
  return allocations;
}

export function quoteDetailTotalsMismatch(summaryItems, detailItems) {
  if (!detailItems?.length) return null;
  const total = items => items.reduce((sum, item) => sum + item.taxedAmountCents, 0);
  const summaryCents = total(summaryItems);
  const detailCents = total(detailItems);
  return summaryCents === detailCents ? null : { summaryCents, detailCents };
}

export function quoteDetailTotalsMismatchMessage(mismatch) {
  const money = cents => (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `项目总价含税合计为 ${money(mismatch.summaryCents)} 元，费用明细含税合计为 ${money(mismatch.detailCents)} 元，请调整一致后再保存或发送审批。`;
}
