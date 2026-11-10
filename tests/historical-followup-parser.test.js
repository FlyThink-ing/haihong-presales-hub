import assert from "node:assert/strict";
import test from "node:test";
import { parseHistoricalFollowups, sourceIdentity, validCalendarDay } from "../server/historical-followup-parser.js";

test("历史段落只承认完整合法日期和显式方式，日精度不补时刻", () => {
  const rows = parseHistoricalFollowups("2024年2月29日（电话）：虚构沟通\n2026-08-01 微信：虚构记录\n2026/8/2 远程：虚构支持\n2026.8.3 未注明方式的虚构内容");
  assert.deepEqual(rows.map(row => row.occurredOn), ["2024-02-29", "2026-08-01", "2026-08-02", "2026-08-03"]);
  assert.deepEqual(rows.map(row => row.method), ["PHONE", "WECHAT", "OTHER", "OTHER"]);
  assert.deepEqual(rows.map(row => row.rawMethod), ["电话", "微信", "远程", ""]);
  assert.ok(rows.every(row => row.precision === "DAY" && row.errors.length === 0));
  assert.equal(validCalendarDay("2026-02-29"), false);
  assert.equal(validCalendarDay("2000-02-29"), true);
  assert.equal(validCalendarDay("1900-02-29"), false);
  assert.equal(validCalendarDay("2026-99-99"), false);
});

test("缺年、非法日期、不能判断与多行续文原样保留待核对，不截断长文本", () => {
  const raw = "前置说明\r\n8月1日 电话：缺年\r\n2026-02-30 现场：非法日期\r\n2026-08-03 电话：第一行\r\n无法判断归属的续文\r\n2026-08-04（现场）：" + "虚构长文本".repeat(1200);
  const rows = parseHistoricalFollowups(raw);
  assert.equal(rows.map(row => row.rawText).join(""), raw);
  assert.equal(rows.length, 5);
  assert.ok(rows.slice(0, 4).every(row => row.errors.length > 0));
  assert.ok(rows[3].errors.includes("MULTILINE_REVIEW_REQUIRED"));
  assert.equal(rows[4].errors.length, 0);
  assert.ok(rows[4].rawText.endsWith("虚构长文本".repeat(1200)));
  assert.equal(parseHistoricalFollowups("2026-08-04 09:30 电话：含时分需核对")[0].errors.includes("TIME_REVIEW_REQUIRED"), true);
  assert.equal(parseHistoricalFollowups("2026-08-04T09:30:00 电话：不能丢弃实际时间")[0].errors.includes("TIME_REVIEW_REQUIRED"), true);
  assert.equal(parseHistoricalFollowups("2026-08-04：电话：虚构明确标记")[0].method, "PHONE");
  assert.equal(parseHistoricalFollowups("2026-08-04 方式：视频；虚构未知方式")[0].rawMethod, "视频");
  assert.equal(parseHistoricalFollowups("2026-08-04 方式：视频；虚构未知方式")[0].method, "OTHER");
});

test("日期与时分之间的冒号、括号和时段标记不能降成日精度，纯日期方式仍可预览", () => {
  const timePrefixes = [
    "：09:30", ":09：30", ": 上午9点30分", "（09:30）", "(09:30)",
    "：（上午9点30分）", ": (下午3时30分)", "（下午 3:30）", "【中午12：30】",
    "[凌晨0:30]", "：晚上9点30分", ": 早上9时30分", "（AM 9:30）", "(PM 3:30)",
    " 09:30", "T09:30:00"
  ];
  for (const prefix of timePrefixes) {
    const raw = `2026-08-04${prefix} 电话：虚构记录`;
    const [row] = parseHistoricalFollowups(raw);
    assert.deepEqual(row.errors, ["TIME_REVIEW_REQUIRED"], prefix);
    assert.equal(row.occurredOn, null, prefix);
    assert.equal(row.rawDate, "2026-08-04", prefix);
    assert.equal(row.rawText, raw, prefix);
  }
  for (const suffix of [" 电话：虚构记录", "：电话：虚构记录", ": 微信：虚构记录", "（现场）：虚构记录", "(会议)：虚构记录", "【邮件】：虚构记录", " 远程：虚构记录"]) {
    const raw = `2026-08-04${suffix}`;
    const [row] = parseHistoricalFollowups(raw);
    assert.deepEqual(row.errors, [], suffix);
    assert.equal(row.occurredOn, "2026-08-04", suffix);
    assert.equal(row.precision, "DAY", suffix);
    assert.equal(row.rawText, raw, suffix);
  }
});

test("来源唯一键不依赖可重建批次或导入行 ID", () => {
  const source = { sourceSha256: "a".repeat(64), sheetName: "信息收集", cellReference: "H3", paragraphNumber: 1 };
  assert.equal(sourceIdentity({ ...source, jobId: "one", rowId: "one" }), sourceIdentity({ ...source, jobId: "two", rowId: "two" }));
  assert.notEqual(sourceIdentity(source), sourceIdentity({ ...source, paragraphNumber: 2 }));
  assert.notEqual(sourceIdentity(source), sourceIdentity({ ...source, sourceSha256: "b".repeat(64) }));
});
