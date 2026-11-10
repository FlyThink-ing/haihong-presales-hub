const clean = value => String(value ?? "").replace(/[\s\u3000]+/g, "");
const FOOTER_HINTS = [
  /^(?:交期|交货期)[:：]?/,
  /^(?:付款方式|付款条款)[:：]?/,
  /^(?:开户行|开户银行)[:：]?/,
  /^(?:账号|帐号|账户|银行账号)[:：]?/
];
const LABEL = /^(?:报价人|报价员|手机号|手机|联系电话|电话|邮箱|电子邮箱|E-?mail|交期|交货期|付款方式|付款条款|开户行|开户银行|账号|帐号|账户|银行账号|客户名称|客户|报价单位|报价公司|报价日期|日期|有效期|报价单编号|报价编号|编号)[:：]/i;

function segmentsForLine(items) {
  const segments = [];
  for (const item of [...items].sort((a, b) => a.x - b.x)) {
    const current = segments.at(-1);
    const gap = current ? item.x - current.right : Infinity;
    const threshold = Math.max(26, Math.min(42, Math.max(item.height, current?.height || 0) * 2.5));
    if (!current || gap > threshold) {
      segments.push({ text: item.text, x: item.x, right: item.x + item.width, height: item.height });
    } else {
      current.text += `${gap > Math.max(1.5, item.height * 0.3) ? " " : ""}${item.text}`;
      current.right = Math.max(current.right, item.x + item.width);
      current.height = Math.max(current.height, item.height);
    }
  }
  return segments;
}

export function groupPdfLines(items) {
  const entries = items.filter(item => item.text.trim() && Number.isFinite(item.x) && Number.isFinite(item.y))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const item of entries) {
    const existing = lines.at(-1);
    if (existing && Math.abs(existing.y - item.y) <= 2) existing.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }
  return lines.sort((a, b) => b.y - a.y).map(line => ({ ...line, segments: segmentsForLine(line.items) }));
}

function verifiedEmailEnd(units) {
  const hints = new Set();
  let seller = false;
  for (let index = 0; index < units.length; index++) {
    const text = clean(units[index].text);
    FOOTER_HINTS.forEach((pattern, i) => { if (pattern.test(text)) hints.add(i); });
    if (hints.size >= 2 && /^(?:报价人|报价员)[:：]?/.test(text)) seller = true;
    if (!seller || !/^(?:邮箱|电子邮箱|E-?mail)[:：]?/i.test(text)) continue;
    let value = text.replace(/^(?:邮箱|电子邮箱|E-?mail)[:：]?/i, "");
    let end = index;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && units[index + 1]?.page === units[index].page
      && Math.abs(units[index].pdfY - units[index + 1].pdfY) <= 26) {
      value += clean(units[index + 1].text);
      end = index + 1;
    }
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return end;
  }
  return null;
}

export function buildPdfLayout(pages) {
  const units = [], lines = [], limitations = [];
  for (const page of pages) {
    if (page.rotation % 360 !== 0) limitations.push(`第 ${page.page} 页方向已旋转，需人工核对文字和表格位置`);
    if (!page.items.length) limitations.push(`第 ${page.page} 页未提取到文字，需人工核对`);
    for (const [lineIndex, line] of groupPdfLines(page.items).entries()) {
      const entry = { page: page.page, line: lineIndex + 1, y: line.y, items: line.items, startIndex: units.length };
      for (const [segmentIndex, segment] of line.segments.entries()) {
        const value = segment.text.trim();
        if (!value) continue;
        units.push({ index: units.length, text: value, location: `第${page.page}页 第${lineIndex + 1}行${line.segments.length > 1 ? ` 第${segmentIndex + 1}段` : ""}`,
          page: page.page, pdfY: line.y, pdfX: segment.x, pdfFieldEligible: LABEL.test(clean(value)), pdfNoBorrow: true });
      }
      entry.endIndex = units.length - 1;
      lines.push(entry);
    }
  }
  const emailEnd = verifiedEmailEnd(units);
  const keptUnits = emailEnd === null ? units : units.slice(0, emailEnd + 1);
  const keptLines = emailEnd === null ? lines : lines.filter(line => line.startIndex <= emailEnd);
  const uncertainPages = new Set(keptLines.filter(line => line.items.some(item => item.rotated || item.text.includes("\ufffd"))).map(line => line.page));
  for (const page of uncertainPages) limitations.push(`第 ${page} 页有旋转或无法识别的文字，需人工核对`);
  return { format: "PDF", units: keptUnits, lines: keptLines, limitations, emailEnd };
}
