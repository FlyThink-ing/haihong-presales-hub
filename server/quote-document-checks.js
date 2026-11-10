import { checkPdfTables } from "./quote-pdf-tables.js";
const normalize = value => String(value ?? "").replace(/[\s\u3000]+/g, "");
const LABEL = /^(?:报价人|报价员|手机|手机号|联系电话|电话|邮箱|电子邮箱|交期|交货期|付款方式|付款条款|开户行|开户银行|账号|帐号|账户|银行账号|客户|客户名称|报价单位|报价日期|日期|有效期|编号|报价编号|报价单编号)[:：]?/i;
const REQUIRED_STANDARD_MARKERS = [
  [/^(?:客户名称|客户)[:：]?\{\{客户\}\}/, "客户名称"],
  [/^(?:报价单编号|报价编号|编号)[:：]?\{\{编号\}\}/, "报价编号"],
  [/^(?:报价日期|日期)[:：]?\{\{日期\}\}/, "报价日期"],
  [/大写[）)]?[:：]?\{\{大写金额\}\}/, "大写金额"],
  [/^(?:报价人|报价员)[:：]?\{\{报价人\}\}/, "报价人"],
  [/^(?:手机号|手机|联系电话|电话)[:：]?\{\{报价人电话\}\}/, "报价人电话"],
  [/^(?:电子邮箱|邮箱|E-?mail)[:：]?\{\{报价人邮箱\}\}/i, "报价人邮箱"]
];

export function field(units, pattern, start = 0) {
  for (let index = start; index < units.length; index++) {
    if (units[index].pdfFieldEligible === false) continue;
    const text = normalize(units[index].text);
    const match = text.match(pattern);
    if (!match) continue;
    let value = text.slice(match[0].length).replace(/^[:：]/, "");
    let valueIndex = index;
    if (!value && !units[index].pdfNoBorrow && units[index + 1] && !LABEL.test(normalize(units[index + 1].text))) { value = normalize(units[index + 1].text); valueIndex = index + 1; }
    return { found: true, value, location: units[index].location, index, valueIndex };
  }
  return { found: false, value: "", location: "主报价", index: -1 };
}

function cents(value) {
  const text = normalize(value).replace(/[¥￥元]/g, "").replace(/,/g, "");
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const match = text.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  const result = Number(match[2]) * 100 + Number((match[3] || "").padEnd(2, "0"));
  return Number.isSafeInteger(result) ? (match[1] ? -result : result) : null;
}

function upperCents(value) {
  const text = normalize(value).replace(/^人民币/, "").replace(/圆/g, "元").replace(/萬/g, "万").replace(/億/g, "亿");
  if (!/^[零壹贰貳叁參肆伍陆陸柒捌玖拾佰仟万亿元角分整正]+$/.test(text) || !text.includes("元")) return null;
  if ((text.match(/元/g) || []).length !== 1 || (text.match(/万/g) || []).length > 1 || (text.match(/亿/g) || []).length > 1) return null;
  const digits = { 零: 0, 壹: 1, 贰: 2, 貳: 2, 叁: 3, 參: 3, 肆: 4, 伍: 5, 陆: 6, 陸: 6, 柒: 7, 捌: 8, 玖: 9 };
  const small = { 拾: 10, 佰: 100, 仟: 1000 };
  const [integer, fraction] = text.split("元");
  if (integer.includes("万") && integer.includes("亿") && integer.indexOf("万") < integer.indexOf("亿")) return null;
  if (!/^(?:整|正|(?:零?[壹贰貳叁參肆伍陆陸柒捌玖]角)?(?:零?[壹贰貳叁參肆伍陆陸柒捌玖]分)?(?:整|正)?)$/.test(fraction)) return null;
  let total = 0, section = 0, digit = 0;
  let lastSmallUnit = 10000, pendingDigit = false;
  for (const char of integer) {
    if (Object.hasOwn(digits, char)) {
      if (char !== "零" && pendingDigit) return null;
      digit = digits[char]; pendingDigit = char !== "零";
    }
    else if (small[char]) { if (small[char] >= lastSmallUnit) return null; section += (digit || 1) * small[char]; digit = 0; pendingDigit = false; lastSmallUnit = small[char]; }
    else if (char === "万") { total += (section + digit) * 10000; section = 0; digit = 0; pendingDigit = false; lastSmallUnit = 10000; }
    else if (char === "亿") { total = (total + section + digit) * 100000000; section = 0; digit = 0; pendingDigit = false; lastSmallUnit = 10000; }
    else return null;
  }
  let amount = (total + section + digit) * 100;
  const angle = fraction.match(/([壹贰貳叁參肆伍陆陸柒捌玖])角/);
  const fen = fraction.match(/([壹贰貳叁參肆伍陆陸柒捌玖])分/);
  if (angle) amount += digits[angle[1]] * 10;
  if (fen) amount += digits[fen[1]];
  return Number.isSafeInteger(amount) ? amount : null;
}

function rowsFor(units) {
  const groups = [];
  const map = new Map();
  for (const unit of units) {
    if (unit.tableId === null || unit.tableId === undefined) {
      groups.push({ text: unit.text, location: unit.location, cells: null });
      continue;
    }
    const key = `${unit.tableId}:${unit.row}`;
    let row = map.get(key);
    if (!row) {
      row = { key, tableId: unit.tableId, location: unit.location, cells: new Map(), merged: false };
      map.set(key, row); groups.push(row);
    }
    row.merged ||= Boolean(unit.isMerged);
    const old = row.cells.get(unit.column);
    row.cells.set(unit.column, { text: [old?.text, unit.text].filter(Boolean).join(" "), location: old?.location || unit.location, fill: unit.fill || old?.fill || "", numFmt: unit.numFmt || old?.numFmt || "", isFormula: Boolean(unit.isFormula || old?.isFormula), unresolvedFormula: Boolean(unit.unresolvedFormula || old?.unresolvedFormula) });
  }
  for (const row of groups) if (row.cells) row.text = [...row.cells.values()].map(cell => cell.text).join(" ");
  return groups;
}

function headers(row) {
  if (!row.cells || row.merged) return null;
  const mapped = {};
  for (const [column, cell] of row.cells) {
    const value = normalize(cell.text).replace(/[（(]元[)）]/g, "");
    if (/^(?:项目\/?型号|项目型号|项目名称|项目)$/.test(value)) mapped.name = column;
    else if (/^子项/.test(value)) mapped.subitem = column;
    else if (/^单位$/.test(value)) mapped.unit = column;
    else if (/^数量/.test(value)) mapped.quantity = column;
    else if (/^未税单价/.test(value)) mapped.unitPrice = column;
    else if (/^未税金额/.test(value)) mapped.net = column;
    else if (/^(?:含税金额|价税合计)/.test(value)) mapped.gross = column;
  }
  return mapped.name && mapped.unit && mapped.quantity && mapped.gross ? mapped : null;
}

function tableChecks(units, issue, format) {
  let current = null, final = null, finalFormula = false;
  const summaryTotals = [], detailTotals = [];
  let discountShown = units.some(unit => /优惠后合计|最终优惠价|最终报价/.test(normalize(unit.text)));
  let discount = null, discountFormula = false;
  let detected = 0;
  const severityFor = (...formulaFlags) => formulaFlags.some(Boolean) ? "REVIEW" : "ERROR";
  const rateMatches = units.flatMap(unit => [...String(unit.text).matchAll(/(\d{1,2}(?:\.\d{1,2})?)\s*[%％]/g)].map(match => Number(match[1])));
  const rates = [...new Set(rateMatches)];
  const rate = rates.length === 1 ? rates[0] : null;
  for (const row of rowsFor(units)) {
    const text = normalize(row.text);
    const header = headers(row);
    if (header) {
      const kind = header.subitem ? "detail" : "summary";
      current = { header, kind, sum: 0, count: 0, reliable: true, hasFormula: false, tableId: row.tableId };
      detected++;
      const fills = [...row.cells.values()].map(cell => cell.fill).filter(fill => /^[0-9A-F]{6}$/.test(fill));
      if (fills.length && !fills.includes("D9D9D9")) issue("REVIEW", "HEADER_COLOR", "表头颜色待核对", "识别到的表头颜色与参考模板不同，请查看版式。", row.location);
      continue;
    }
    if (!current || !row.cells || row.tableId !== current.tableId) continue;
    const values = [...row.cells.values()];
    if (/优惠后合计|最终优惠价|最终报价/.test(text)) {
      discountShown = true;
      const money = values.map(cell => ({ value: cents(cell.text), formula: cell.isFormula })).filter(item => item.value !== null);
      if (money.length) { final = money.at(-1).value; finalFormula = Boolean(money.at(-1).formula); }
      const note = text.match(/优惠(?:金额)?[:：]?([¥￥]?[\d,]+(?:\.\d{1,2})?)/);
      if (note) discount = cents(note[1]);
      continue;
    }
    if (/^优惠金额[:：]?/.test(text)) {
      const money = values.map(cell => ({ value: cents(cell.text), formula: cell.isFormula })).filter(item => item.value !== null);
      if (money.length) { discount = money.at(-1).value; discountFormula = Boolean(money.at(-1).formula); discountShown ||= discount > 0; }
      continue;
    }
    if (/^(?:合计|总计|小计)[:：]?/.test(text)) {
      const money = values.map(cell => ({ value: cents(cell.text), formula: cell.isFormula })).filter(item => item.value !== null);
      if (money.length) {
        const stated = money.at(-1);
        if (current.reliable && current.count && current.sum !== stated.value) issue(severityFor(current.hasFormula, stated.formula), "TOTAL_ROW", "明细合计不一致", "已识别的含税明细之和与表内含税合计不一致，请核对。", row.location);
        if (current.kind === "summary") summaryTotals.push(stated);
        else detailTotals.push(stated);
      }
      current.subtotalSeen = true;
      continue;
    }
    if (current.subtotalSeen) continue;
    const get = key => row.cells.get(current.header[key]);
    const name = get("name"), unit = get("unit"), quantity = get("quantity"), gross = get("gross");
    if (!name?.text?.trim() && !gross?.text?.trim()) continue;
    if (row.merged || gross?.unresolvedFormula) {
      current.reliable = false;
      issue("REVIEW", "COMPLEX_ROW", "表格行需要核对", "存在合并单元格、公式无缓存或字段位置不明确，请人工核对本行。", row.location);
      continue;
    }
    if (name?.text?.trim() && (!unit?.text?.trim() || !quantity?.text?.trim() || !gross?.text?.trim())) {
      current.reliable = false;
      if (!unit?.text?.trim()) issue("ERROR", "UNIT_REQUIRED", "单位未填写", "请填写该行单位。", unit?.location || row.location);
      if (!quantity?.text?.trim()) issue("ERROR", "QUANTITY_REQUIRED", "数量未填写", "请填写该行数量。", quantity?.location || row.location);
      if (!gross?.text?.trim()) issue("ERROR", "GROSS_REQUIRED", "含税金额未填写", "请填写该行含税金额。", gross?.location || row.location);
      continue;
    }
    if (!name || !unit || !quantity || !gross) {
      current.reliable = false;
      issue("REVIEW", "COMPLEX_ROW", "表格行需要核对", "字段位置不明确，请人工核对本行。", row.location);
      continue;
    }
    const value = cents(gross.text);
    if (value === null) {
      current.reliable = false;
      issue("REVIEW", "GROSS_UNREADABLE", "含税金额待核对", "无法确定本行含税金额，请人工检查。", gross.location);
      continue;
    }
    if (!unit.text.trim()) issue("REVIEW", "UNIT_EMPTY", "单位待核对", "未识别到本行单位，若单位由合并单元格共享请人工确认。", unit.location);
    if (!Number.isFinite(Number(normalize(quantity.text))) || Number(normalize(quantity.text)) <= 0) issue("REVIEW", "QUANTITY_INVALID", "数量待核对", "数量未识别或不大于零，请核对。", quantity.location);
    if (value < 0) issue("REVIEW", "NEGATIVE_AMOUNT", "负数金额待核对", "本行存在负数，请核对其业务含义。", gross.location);
    if (Math.abs(value) >= 100000 && !gross.text.includes(",") && !(format === "XLSX" && /#,##/.test(gross.numFmt))) issue("REVIEW", "THOUSANDS", "金额格式待调整", "该金额未识别到千分位，请按公司格式核对。", gross.location);
    if (!/\.\d{2}$/.test(normalize(gross.text).replace(/[元￥¥]/g, "")) && !(format === "XLSX" && /\.00/.test(gross.numFmt))) issue("REVIEW", "DECIMALS", "金额小数位待核对", "请核对金额是否按公司格式展示两位小数。", gross.location);
    if (!Number.isSafeInteger(current.sum + value)) {
      current.reliable = false;
      issue("REVIEW", "TOTAL_OVERFLOW", "金额合计待核对", "金额较大，请人工核对合计。", gross.location);
      continue;
    }
    current.sum += value; current.count++; current.hasFormula ||= Boolean(gross.isFormula);
    const price = get("unitPrice"), net = get("net");
    const unitPrice = price && cents(price.text), netAmount = net && cents(net.text);
    const qty = Number(normalize(quantity.text));
    if (unitPrice !== null && unitPrice !== undefined && netAmount !== null && netAmount !== undefined && Number.isFinite(qty) && qty > 0) {
      const difference = Math.abs(Math.round(unitPrice * qty) - netAmount);
      if (difference > Math.max(2, Math.ceil(qty / 2) + 1)) issue("REVIEW", "UNIT_PRICE", "未税金额待核对", "单价、数量与未税金额的差异超出常见显示舍入范围，请核对计价方式。", net.location);
    }
    if (rate !== null && netAmount !== null && netAmount !== undefined && Number.isSafeInteger(netAmount) && Number.isSafeInteger(value)) {
      const taxed = Math.round(netAmount * (100 + rate) / 100);
      if (Number.isSafeInteger(taxed) && Math.abs(taxed - value) > 2) issue("REVIEW", "TAX_AMOUNT", "税额待核对", "未税金额、税率与含税金额的差异需要核对。", gross.location);
    }
  }
  const summaryItem = summaryTotals.length === 1 ? summaryTotals[0] : null;
  const detailItem = detailTotals.length === 1 ? detailTotals[0] : null;
  const summary = summaryItem?.value ?? null;
  const detail = detailItem?.value ?? null;
  if (!detected) issue("REVIEW", "TABLE_UNRECOGNIZED", "项目表需人工核对", "未能完整识别表头或复杂表格，请核对项目、单位、数量和金额。", "项目表");
  if (rate === null) issue("REVIEW", "TAX_RATE", "税率待核对", "税率未能唯一识别，请核对含税和未税金额。", "金额汇总");
  if (summaryTotals.length > 1 || detailTotals.length > 1) issue("REVIEW", "MULTIPLE_TOTALS", "拆分表格的合计待核对", "识别到多处合计，请核对各表与最终金额的对应关系。", "金额汇总");
  if (discountShown && final === null) issue("REVIEW", "DISCOUNT_UNCLEAR", "优惠后金额待核对", "发现优惠后合计标记，但未能可靠识别具体金额，请人工核对。", "金额汇总");
  if (summary !== null && detail !== null && summary !== detail) issue(severityFor(summaryItem.formula, detailItem.formula), "SUMMARY_DETAIL", "项目总价与费用明细不一致", "两处含税合计不同，请核对。", "金额汇总");
  if (summary !== null && final !== null && discount !== null && summary - final !== discount) issue(severityFor(summaryItem.formula, finalFormula, discountFormula), "DISCOUNT_AMOUNT", "优惠金额不一致", "原含税合计、优惠金额与优惠后金额不一致，请核对。", "金额汇总");
  return { summary, detail, final: final ?? (discountShown ? null : summary), finalFormula: final === null ? Boolean(summaryItem?.formula) : finalFormula };
}

export function checkMainQuote(parsed, endIndex, context) {
  const units = parsed.units.slice(0, endIndex + 1);
  const issues = [];
  const issue = (severity, code, title, message, location) => issues.push({ severity, code, title, message, location });
  const text = units.map(unit => normalize(unit.text)).join("\n");
  const structured = /软件报价单/.test(text) && /项目总价/.test(text) && /(?:项目费用明细|交期|付款方式)/.test(text)
    && !units.some(unit => unit.revision || unit.textBox || unit.unresolvedFormula);
  const missingSeverity = structured && parsed.format !== "PDF" ? "ERROR" : "REVIEW";
  const checkField = (pattern, title, start = 0, strict = false) => {
    const result = field(units, pattern, start);
    if (!result.found) issue(strict && parsed.format !== "PDF" ? "ERROR" : missingSeverity, `FIELD_${title}`, `${title}待核对`, `未能识别${title}，请确认字段完整并按模板填写。`, "主报价");
    else if (!result.value) issue(parsed.format === "PDF" ? "REVIEW" : "ERROR", `FIELD_${title}`, `${title}未填写`, `请填写${title}。`, result.location);
    return result;
  };
  if (!/软件报价单/.test(text)) issue("REVIEW", "TITLE", "报价标题待核对", "未能识别标准报价标题，请核对。", "主报价开头");
  for (const unit of units) {
    const content = normalize(unit.text);
    for (const [pattern, label] of REQUIRED_STANDARD_MARKERS) {
      if (pattern.test(content)) issue("ERROR", "STANDARD_TEMPLATE_UNFILLED", `${label}未填写`, "请在 Word 中将模板占位内容替换为实际信息。", unit.location);
    }
    const expected = /软件报价单/.test(content) ? 44 : /^(?:项目总价|项目费用明细)$/.test(content) ? 24 : null;
    if (expected && unit.fontSizes?.length && !unit.fontSizes.includes(expected)) issue("REVIEW", "HEADING_SIZE", "标题字号待核对", "标题字号与参考模板不同，请核对。", unit.location);
    if (expected && unit.fonts?.length && !unit.fonts.includes("黑体")) issue("REVIEW", "HEADING_FONT", "标题字体待核对", "标题字体与参考模板不同，请核对。", unit.location);
    for (const [typo, suggested] of [["竭成", "竭诚"], ["付款方试", "付款方式"], ["开护行", "开户行"], ["增殖税", "增值税"], ["联糸人", "联系人"], ["客护名称", "客户名称"], ["报价単", "报价单"]]) {
      if (content.includes(typo)) issue("REVIEW", "KNOWN_TYPO", "疑似错别字", `疑似“${typo}”，请核对是否应为“${suggested}”。`, unit.location);
    }
  }
  issue("REVIEW", "LOGO", "公司标识待核对", units.some(unit => unit.image) ? "主报价含有图片，请核对是否为公司 Logo 及其位置。" : "未能从正文确认公司标识，请核对页眉及 Logo。", "主报价开头");
  const company = field(units, /^(?:报价单位|报价公司)[:：]?/);
  if (!company.found || !company.value) issue(missingSeverity, "COMPANY", "报价单位待核对", "未能完整识别报价单位，请核对公司资料。", company.location);
  else if (context.company?.name && normalize(company.value) !== normalize(context.company.name)) issue("ERROR", "COMPANY_MISMATCH", "报价单位不一致", "报价单位与公司标准名称不一致，请核对。", company.location);
  const customer = field(units, /^(?:客户名称|客户)[:：]?/);
  if (!customer.found || !customer.value) issue(missingSeverity, "CUSTOMER", "客户名称待核对", "未能完整识别客户名称，请核对关联客户。", customer.location);
  else if (![context.customerName, context.customerShortName].filter(Boolean).map(normalize).includes(normalize(customer.value))) issue("REVIEW", "CUSTOMER_MISMATCH", "客户名称待核对", "文件客户名称与关联客户名称不同，请核对简称或历史名称。", customer.location);
  checkField(/^(?:报价单编号|报价编号|编号)[:：]?/, "报价编号");
  const date = checkField(/^(?:报价日期|日期)[:：]?/, "报价日期");
  if (date.value) {
    const match = date.value.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
    if (!match) issue("REVIEW", "DATE_FORMAT", "报价日期待核对", "日期格式未能识别，请核对。", date.location);
    else {
      const [, year, month, day] = match.map(Number);
      const value = new Date(Date.UTC(year, month - 1, day));
      if (value.getUTCFullYear() !== year || value.getUTCMonth() + 1 !== month || value.getUTCDate() !== day) issue("ERROR", "DATE_INVALID", "报价日期无效", "请填写有效的报价日期。", date.location);
    }
  }
  checkField(/^(?:有效期)[:：]?/, "有效期");
  checkField(/^(?:交货期|交期)[:：]?/, "交期");
  checkField(/^(?:付款方式|付款条款)[:：]?/, "付款方式");
  const bank = checkField(/^(?:开户银行|开户行)[:：]?/, "开户行");
  const account = checkField(/^(?:银行账号|账号|帐号|账户)[:：]?/, "账号");
  if (bank.value && context.company?.bankName && normalize(bank.value) !== normalize(context.company.bankName)) issue("REVIEW", "BANK_MISMATCH", "开户行待核对", "开户行与系统现有公司资料不同，请核对。", bank.location);
  if (account.value && context.company?.bankAccount && normalize(account.value).replace(/[-－]/g, "") !== normalize(context.company.bankAccount).replace(/[-－]/g, "")) issue("REVIEW", "ACCOUNT_MISMATCH", "收款账号待核对", "账号与系统现有公司资料不同，请核对。", account.location);
  if (!/我们将竭诚为您服务/.test(text)) issue(missingSeverity, "CLOSING", "服务文案待核对", "请核对主报价尾部服务文案及错别字。", "报价尾部");
  const seller = checkField(/^(?:报价人|报价员)[:：]?/, "报价人", 0, true);
  const footer = seller.index >= 0 ? seller.index : units.length;
  const phone = checkField(/^(?:手机号|手机|联系电话|电话)[:：]?/, "报价人手机或电话", footer, true);
  const email = checkField(/^(?:电子邮箱|邮箱|E-?mail)[:：]?/i, "报价人邮箱", footer, true);
  if (email.value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value) && units[email.valueIndex + 1]) {
    const combined = email.value + normalize(units[email.valueIndex + 1].text);
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(combined)) email.value = combined;
  }
  if (phone.value && !/^\+?[\d()（）-]{6,25}$/.test(phone.value)) issue("REVIEW", "PHONE_FORMAT", "报价人电话格式待核对", "电话格式未能确认，请核对。", phone.location);
  if (email.value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value)) issue("ERROR", "EMAIL_FORMAT", "报价人邮箱格式有误", "请核对邮箱地址。", email.location);
  const matches = (context.sellers || []).filter(user => normalize(user.displayName) === normalize(seller.value));
  if (seller.value && matches.length === 1) {
    const user = matches[0];
    if (user.phone && phone.value && normalize(user.phone).replace(/[-－]/g, "") !== normalize(phone.value).replace(/[-－]/g, "")) issue("REVIEW", "SELLER_PHONE", "报价人电话待核对", "电话与该报价人的资料不同，请核对。", phone.location);
    if (user.email && email.value && normalize(user.email).toLowerCase() !== normalize(email.value).toLowerCase()) issue("REVIEW", "SELLER_EMAIL", "报价人邮箱待核对", "邮箱与该报价人的资料不同，请核对。", email.location);
  } else if (seller.value) issue("REVIEW", "SELLER_UNKNOWN", "报价人员待核对", "无法唯一匹配报价人资料，请核对姓名和联系方式。", seller.location);
  for (const limitation of parsed.limitations || []) issue("REVIEW", "PDF_TEXT_LIMIT", "文件内容待核对", limitation, "主报价");
  const rateMatches = [...new Set(units.flatMap(unit => [...String(unit.text).matchAll(/(\d{1,2}(?:\.\d{1,2})?)\s*[%％]/g)].map(match => Number(match[1]))))];
  const totals = parsed.format === "PDF" ? checkPdfTables(parsed.lines, endIndex, issue, { uncertain: Boolean(parsed.limitations?.length), rate: rateMatches.length === 1 ? rateMatches[0] : null }) : tableChecks(units, issue, parsed.format);
  const formulaSeverity = totals.finalFormula ? "REVIEW" : "ERROR";
  if (totals.final !== null && Number.isSafeInteger(context.declaredAmountCents) && totals.final !== context.declaredAmountCents) issue(formulaSeverity, "DECLARED_AMOUNT", "登记金额与文件不一致", "文件中的最终报价与系统登记的含税总额不同，请核对。", "金额汇总");
  else if (totals.final === null) issue("REVIEW", "FINAL_AMOUNT", "最终金额待核对", "未能可靠识别文件中的最终含税金额，请与登记金额核对。", "金额汇总");
  const upperUnit = units.find(unit => /大写/.test(normalize(unit.text)));
  if (!upperUnit) issue("REVIEW", "UPPERCASE_MISSING", "人民币大写待核对", "未能识别人民币大写金额，请核对。", "金额汇总");
  else {
    const upperIndex = units.indexOf(upperUnit);
    const following = units[upperIndex + 1]?.text || "";
    const raw = normalize(`${upperUnit.text}${following}`).split(/大写[）)]?[:：]?/).at(-1).match(/(?:人民币)?[零壹贰貳叁參肆伍陆陸柒捌玖拾佰仟万萬亿億元圆角分整正]+/);
    const value = raw ? upperCents(raw[0]) : null;
    if (value === null) issue("REVIEW", "UPPERCASE_UNREADABLE", "人民币大写待核对", "未能可靠识别人民币大写金额，请核对。", upperUnit.location);
    else if (totals.final !== null && value !== totals.final) issue(formulaSeverity, "UPPERCASE_MISMATCH", "人民币大写不一致", "大写金额与文件最终报价不一致，请核对。", upperUnit.location);
  }
  if (units.some(unit => unit.isFormula)) issue("REVIEW", "FORMULA", "公式结果待核对", "主报价包含公式，系统读取文件中的缓存结果；请在表格软件中重新计算保存并核对。", "主报价");
  if (units.some(unit => unit.revision)) issue("REVIEW", "REVISIONS", "修订内容待核对", "主报价包含修订，需核对最终显示内容。", "主报价");
  if (units.some(unit => unit.textBox)) issue("REVIEW", "TEXT_BOX", "文本框待核对", "主报价包含文本框，需核对文字位置和完整性。", "主报价");
  issue("REVIEW", "VISUAL", "版式需人工核对", "请查看公司标识、字体、表头、分页和遮挡效果；自动检查不等于视觉验收。", "主报价");
  issue("REVIEW", "SPELLING", "错别字需人工核对", "请核对项目名称、专有词和备注的错别字；系统无法识别所有用词问题。", "主报价");
  return { issues, errorCount: issues.filter(item => item.severity === "ERROR").length, reviewCount: issues.filter(item => item.severity === "REVIEW").length,
    checkedThrough: units.at(-1)?.location || "主报价", recognizedTotals: { summaryCents: totals.summary, detailCents: totals.detail, finalCents: totals.final, finalReliable: totals.final !== null && !totals.finalFormula } };
}

export const __test = { cents, upperCents, field, rowsFor, headers, tableChecks };
