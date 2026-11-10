const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function quoteReviewPanel(review, { canCheck = false, versionId = "" } = {}) {
  const action = canCheck ? `<button class="button small" type="button" data-quote-document-review="${escapeHtml(versionId)}">${review ? "重新检查" : "检查主报价"}</button>` : "";
  if (!review) return `<section class="detail-section quote-document-review"><div class="card-head"><h3>主报价检查</h3>${action}</div><p>${canCheck ? "当前文件尚无有效检查结果。上传或修改文件及金额后，请重新检查。" : "该版本没有保存主报价检查记录。"}</p></section>`;
  const messages = review.issues.map(item => `<li class="quote-review-issue ${item.severity === "ERROR" ? "is-error" : "is-review"}"><strong>${escapeHtml(item.severity === "ERROR" ? "需修改" : "人工核对")} · ${escapeHtml(item.title)}</strong><span>${escapeHtml(item.location)}：${escapeHtml(item.message)}</span></li>`).join("");
  const summary = review.errorCount ? `发现 ${review.errorCount} 项需修改，${review.reviewCount} 项需人工核对` : `未发现明确错误，${review.reviewCount} 项需人工核对`;
  const when = review.createdAt && !Number.isNaN(Date.parse(review.createdAt)) ? new Date(review.createdAt).toLocaleString("zh-CN", { hour12: false }) : "";
  return `<section class="detail-section quote-document-review" data-review-id="${escapeHtml(review.id)}"><div class="card-head"><div><h3>主报价检查</h3><small>截至 ${escapeHtml(review.boundaryLocation)}；附件未参与检查${review.reviewerName ? ` · ${escapeHtml(review.reviewerName)}` : ""}${when ? ` · ${escapeHtml(when)}` : ""}</small></div>${action}</div><p class="quote-review-summary ${review.errorCount ? "is-error" : ""}">${escapeHtml(summary)}</p><ul class="quote-review-issues">${messages}</ul>${review.manualConfirmed ? `<p class="quote-review-confirmed">提交人已确认核对待核对项目。</p>` : ""}</section>`;
}

export function quoteBoundaryOptions(preview) {
  const options = preview.units.map(unit => `<option value="${unit.index}"${unit.index === preview.suggestedEndIndex ? " selected" : ""}>${escapeHtml(unit.location)} · ${escapeHtml(unit.text)}</option>`).join("");
  const help = preview.format === "PDF" && preview.suggestedEndIndex !== null
    ? "已识别报价人邮箱，结束位置须包含邮箱行；如识别位置不正确，请检查文件后重新上传。"
    : "通常选择报价人信息区的邮箱行末；识别不准时可选择正确的位置。";
  return `<p class="quote-review-intro">${escapeHtml(preview.reason)}。系统检查从文件开头到所选位置的内容，后续附件不参与检查。</p><div class="field"><label class="required" for="quote-review-boundary">主报价结束位置</label><select id="quote-review-boundary"><option value="">请选择结束位置</option>${options}</select></div><p class="muted">${help}</p>`;
}
