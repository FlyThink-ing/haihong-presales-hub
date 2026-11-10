import { sha256 } from "./security.js";

export function validCalendarDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function sourceIdentity({ sourceSha256, sheetName, cellReference, paragraphNumber }) {
  return sha256(JSON.stringify([sourceSha256.toLowerCase(), sheetName, cellReference, paragraphNumber]));
}

const DATE_PREFIX = /^\s*(\d{4}(?:年\d{1,2}月\d{1,2}日|[-/.]\d{1,2}[-/.]\d{1,2}))(?!\d)/;
const DATE_LIKE = /^\s*\d{1,4}(?:年|月|[-/.])\d/;
const METHODS = { 电话: "PHONE", 微信: "WECHAT", 现场: "ONSITE", 会议: "MEETING", 邮件: "EMAIL", 远程: "OTHER", 其他: "OTHER" };

export function parseHistoricalFollowups(value) {
  const raw = String(value ?? "");
  if (!raw.trim()) return [];
  // 保留每个分隔换行，确保所有 rawText 拼接后仍等于原单元格全文。
  const lines = raw.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean);
  const blocks = [];
  for (const line of lines) {
    if (!blocks.length || DATE_LIKE.test(line)) blocks.push(line);
    else blocks[blocks.length - 1] += line;
  }
  return blocks.map((rawText, index) => {
    const first = rawText.split(/\r\n|\r|\n/)[0];
    const match = first.match(DATE_PREFIX);
    const rawDate = match?.[1] || first.match(/^\s*(\d{1,4}(?:年|月|[-/.])\d{1,2}(?:月|日|[-/.])?\d{0,2}日?)/)?.[1] || "";
    const parts = match?.[1].match(/\d+/g);
    const occurredOn = parts ? `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}` : null;
    const rest = match ? first.slice(match[0].length) : "";
    const method = rest.match(/^[\s:：,，、-]*[（(【[]?\s*(电话|微信|现场|会议|邮件|远程|其他)(?=[）)\]】\s:：,，、-]|$)/);
    const explicitMethod = rest.match(/^[\s:：,，、-]*方式\s*[:：]\s*([^\s,，;；:：]+)/);
    const rawMethod = explicitMethod?.[1] || method?.[1] || "";
    const errors = [];
    if (!match) errors.push(rawDate ? "DATE_YEAR_REQUIRED" : "DATE_UNRECOGNIZED");
    else if (!validCalendarDay(occurredOn)) errors.push("DATE_INVALID");
    // 仅识别日期后的时间提示并送核对，不解析时刻或时区；冒号/括号不能掩盖原文时分。
    if (/^[\s:：,，、（(【\[]*(?:(?:T|上午|下午|中午|晚上|凌晨|早上|早晨|傍晚|AM|PM)[\s:：,，、（(【\[]*)?\d{1,2}\s*[:：时点]\s*\d{0,2}/i.test(rest)) errors.push("TIME_REVIEW_REQUIRED");
    if (rawText.trimEnd().split(/\r\n|\r|\n/).length > 1) errors.push("MULTILINE_REVIEW_REQUIRED");
    return { paragraphNumber: index + 1, rawDate, rawMethod, rawText, occurredOn: errors.length ? null : occurredOn, precision: "DAY", method: METHODS[rawMethod] || "OTHER", errors };
  });
}
