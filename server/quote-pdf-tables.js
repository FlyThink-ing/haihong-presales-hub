const compact = value => String(value ?? "").replace(/[\s\u3000]+/g, "");
const center = item => item.x + item.width / 2;
function money(value) {
  const text = compact(value).replace(/[¥￥元]/g, "").replace(/,/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : null;
}

function headerFor(line, pageLines) {
  if (!line.items.some(item => compact(item.text) === "序号")) return null;
  const nearby = pageLines.filter(other => Math.abs(other.y - line.y) <= 9).flatMap(other => other.items);
  const find = pattern => nearby.find(item => pattern.test(compact(item.text)));
  const seq = find(/^序号$/), name = find(/^(?:项目\/?型号|项目型号|项目名称|项目)$/);
  const sub = find(/^子项$/), unit = find(/^单位$/), quantity = find(/^数量$/), gross = find(/^含税$/);
  const net = nearby.filter(item => compact(item.text) === "未税").sort((a, b) => a.x - b.x);
  if (!seq || !name || !unit || !quantity || !gross || net.length !== 2) return null;
  return { kind: sub ? "detail" : "summary", columns: { seq: center(seq), name: center(name), ...(sub ? { sub: center(sub) } : {}), unit: center(unit), quantity: center(quantity), unitPrice: center(net[0]), net: center(net[1]), gross: center(gross), ...(find(/^备注$/) ? { note: center(find(/^备注$/)) } : {}) } };
}

function cellsFor(line, columns) {
  const keys = Object.entries(columns).sort((a, b) => a[1] - b[1]);
  const cells = {};
  for (const item of line.items) {
    const position = item.x + Math.min(item.width / 2, 15);
    let key = keys[0][0], distance = Infinity;
    for (const [candidate, x] of keys) {
      if (Math.abs(x - position) < distance) { key = candidate; distance = Math.abs(x - position); }
    }
    let value = item.text.trim();
    // Long project names can start close to the sequence-number column in exported PDFs.
    if (key === "seq" && !/^\d{1,4}$/.test(compact(value))) key = "name";
    // Word-to-PDF sometimes joins a monetary value and the adjacent remark into one run.
    if (key === "gross" && columns.note && item.x + item.width > (columns.gross + columns.note) / 2) {
      const match = value.match(/^([¥￥]?[\d,]+(?:\.\d{1,2})?)(?:\s|$)/);
      if (match) value = match[1];
    }
    cells[key] = [cells[key], value].filter(Boolean).join(" ");
  }
  return cells;
}

export function checkPdfTables(lines, endIndex, issue, { uncertain = false, rate = null } = {}) {
  const selected = lines.filter(line => line.endIndex <= endIndex);
  const byPage = new Map();
  for (const line of selected) {
    if (!byPage.has(line.page)) byPage.set(line.page, []);
    byPage.get(line.page).push(line);
  }
  const groups = [];
  let active = null, discount = null, discountFound = false;
  for (const line of selected) {
    const header = headerFor(line, byPage.get(line.page));
    if (header) {
      if (active && active.kind === header.kind && !active.totalSeen && line.page !== active.page) {
        active.columns = header.columns; active.page = line.page;
      } else {
        active = { ...header, page: line.page, sum: 0, netSum: 0, count: 0, netCount: 0, reliable: !uncertain, sequences: [], total: null, netTotal: null, totalSeen: false };
        groups.push(active);
      }
      continue;
    }
    if (!active) continue;
    const text = compact(line.items.map(item => item.text).join(""));
    const cells = cellsFor(line, active.columns);
    const location = `第${line.page}页 第${line.line}行`;
    if (/优惠后合计|最终优惠价|最终报价/.test(text)) {
      discountFound = true; discount = money(cells.gross);
      if (discount === null) issue("REVIEW", "PDF_DISCOUNT", "优惠后金额待核对", "未能可靠识别优惠后的金额，请人工核对。", location);
      continue;
    }
    // Later, differently structured tables may also contain subtotals. Do not replace this table's total with theirs.
    if (active.totalSeen) continue;
    if (line.items.some(item => /^(?:合计|总计|小计)[:：]?$/.test(compact(item.text)))) {
      active.totalSeen = true;
      active.total = money(cells.gross);
      active.netTotal = money(cells.net);
      active.totalLocation = location;
      if (active.total === null) issue("REVIEW", "PDF_TOTAL", "表格合计待核对", "未能可靠识别表格合计，请人工核对。", location);
      continue;
    }
    const seq = compact(cells.seq);
    if (!/^\d{1,4}$/.test(seq)) continue; // Description-only continuation lines are not separate items.
    const gross = money(cells.gross), net = money(cells.net), unitPrice = money(cells.unitPrice);
    const qty = Number(compact(cells.quantity));
    if (!cells.unit || !Number.isFinite(qty) || qty <= 0 || gross === null) {
      active.reliable = false;
      issue("REVIEW", "PDF_ROW", "报价明细待核对", "未能完整识别单位、数量或含税金额，请核对该行。", location);
      continue;
    }
    active.count++; active.sequences.push(Number(seq));
    if (!Number.isSafeInteger(active.sum + gross)) { active.reliable = false; continue; }
    active.sum += gross;
    if (net !== null && Number.isSafeInteger(active.netSum + net)) { active.netSum += net; active.netCount++; }
    if (unitPrice !== null && net !== null && Math.abs(Math.round(unitPrice * qty) - net) > Math.max(2, Math.ceil(qty / 2) + 1))
      issue("REVIEW", "UNIT_PRICE", "未税金额待核对", "单价、数量与未税金额存在差异，请核对计价方式。", location);
    if (rate !== null && net !== null && Math.abs(Math.round(net * (100 + rate) / 100) - gross) > 2)
      issue("REVIEW", "TAX_AMOUNT", "税额待核对", "未税金额、税率与含税金额存在差异，请核对。", location);
  }
  for (const group of groups) {
    if (!group.count || group.sequences.some((sequence, index) => sequence !== index + 1)) group.reliable = false;
    if (!group.reliable) issue("REVIEW", "PDF_TABLE_COMPLEX", "项目表需人工核对", "表格存在跨页、合并或内容识别不完整，请核对各项及合计。", "项目表");
    if (group.reliable && group.total !== null && group.sum !== group.total)
      issue("ERROR", "TOTAL_ROW", "明细合计不一致", "已识别的含税明细之和与表内含税合计不一致，请核对。", group.totalLocation);
    if (group.reliable && group.netTotal !== null && group.netCount === group.count && Math.abs(group.netSum - group.netTotal) > 1)
      issue("REVIEW", "PDF_NET_TOTAL", "未税金额合计待核对", "未税明细与未税合计有差异，请核对计价及舍入方式。", group.totalLocation);
  }
  const summaries = groups.filter(group => group.kind === "summary" && group.total !== null);
  const details = groups.filter(group => group.kind === "detail" && group.total !== null);
  if (!groups.length || summaries.length !== 1 || details.length !== 1)
    issue("REVIEW", "TABLE_UNRECOGNIZED", "项目表需人工核对", "未能唯一识别项目总价及费用明细，请人工核对。", "项目表");
  const s = summaries.length === 1 ? summaries[0] : null, d = details.length === 1 ? details[0] : null;
  if (s && d && s.total !== d.total) issue(s.reliable && d.reliable ? "ERROR" : "REVIEW", "SUMMARY_DETAIL", "项目总价与费用明细不一致", "两处含税合计不同，请核对。", "金额汇总");
  if (rate === null) issue("REVIEW", "TAX_RATE", "税率待核对", "税率未能唯一识别，请核对含税和未税金额。", "金额汇总");
  return { summary: s?.total ?? null, detail: d?.total ?? null, final: discountFound ? discount : (s?.total ?? null), finalFormula: uncertain || !s?.reliable || (discountFound && discount === null) };
}
