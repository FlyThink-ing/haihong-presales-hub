// Synthetic PDF data only. ToUnicode makes Chinese text extraction deterministic without embedding a font.
export function quotePdfFixture(lines = ["软件报价单", "客户：虚构客户有限公司", "日期：2026-11-03", "交期：按约定", "付款方式：按约定", "开户行：虚构银行", "账号：100000000000", "报价人：测试售前", "手机：13000000000", "邮箱：sales@example.invalid"]) {
  const hex = text => [...text].map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const textOf = line => typeof line === "string" ? line : line.text;
  const entries = [...new Set(lines.map(textOf).join(""))].map(char => `<${hex(char)}> <${hex(char)}>`);
  const sections = [];
  for (let index = 0; index < entries.length; index += 80) sections.push(`${Math.min(80, entries.length - index)} beginbfchar\n${entries.slice(index, index + 80).join("\n")}\nendbfchar`);
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${sections.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const content = lines.map((line, index) => `BT /F1 12 Tf ${line.x ?? 50} ${line.y ?? 760 - index * 24} Td <${hex(textOf(line))}> Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 >>",
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>"
  ];
  let pdf = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

export function quoteBindingPdfFixture({ customer = "虚构客户有限公司", gross = "100,000.00", omit = [], blankField = "" } = {}) {
  const at = (text, x, y, key = "") => ({ text: key === blankField && key ? `${text.split("：")[0]}：` : text, x, y, key });
  return quotePdfFixture([
    at(`客户：${customer}`, 40, 790, "客户"), at("日期：2026-11-03", 40, 775, "日期"), at("软件报价单", 40, 760),
    at("未税", 280, 706), at("未税", 345, 706), at("含税", 409, 706),
    at("序号", 46, 700), at("项目/型号", 107, 700), at("单位", 198, 700), at("数量", 232, 700), at("备注", 492, 700),
    at("1", 54, 670), at("虚构设备与系统", 110, 670), at("套", 204, 670), at("1", 240, 670),
    at("88,495.58", 273, 670), at("88,495.58", 338, 670), at(gross, 418, 670),
    at("合计：", 289, 640), at("88,495.58", 338, 640), at(gross, 418, 640),
    // An unrelated hardware table subtotal must not replace the total above.
    at("设备硬件清单", 40, 600), at("合计：", 374, 570), at("5,000.00", 433, 570),
    at("交期：按约定", 40, 550), at("付款方式：按约定", 40, 525), at("开户行：虚构银行", 40, 500, "开户行"), at("账号：100000000000", 40, 475, "账号"),
    at("报价人：测试售前", 40, 450, "报价人"), at("手机：13000000000", 40, 425, "报价人电话"), at("邮箱：sales@example.invalid", 40, 400, "报价人邮箱"),
    at("附件：不检查", 40, 375)
  ].filter(item => !omit.includes(item.key)));
}
