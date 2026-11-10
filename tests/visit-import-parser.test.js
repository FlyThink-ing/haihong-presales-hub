import assert from "node:assert/strict";
import test from "node:test";
import { MUNICH_VISIT_FIELDS, parseMunichVisitRow, validateMunichVisitHeaders, visitDateCandidate, visitSourceIdentity } from "../server/visit-import-parser.js";

test("慕尼黑拜访表只接受第2行精确表头，来源键不依赖任务且原字段完整保留", () => {
  const labels = MUNICH_VISIT_FIELDS.map(field => field.label);
  assert.equal(validateMunichVisitHeaders(labels), true);
  assert.equal(validateMunichVisitHeaders(labels.slice(1)), false);
  assert.equal(validateMunichVisitHeaders(labels.map(label => label === "计划拜访日期" ? "实际拜访日期" : label)), false);
  assert.equal(validateMunichVisitHeaders([...labels, "额外列"]), false);
  const source = { sourceSha256: "a".repeat(64), sheetName: "慕尼黑客户拜访记录", rowNumber: 3 };
  assert.equal(visitSourceIdentity({ ...source, jobId: "first" }), visitSourceIdentity({ ...source, jobId: "second" }));
  assert.notEqual(visitSourceIdentity(source), visitSourceIdentity({ ...source, rowNumber: 4 }));
  const input = { sequence: 1, customerName: "虚构拜访客户甲有限公司", intention: "A", industry: "虚构行业", needSummary: "虚构需求", contactName: "虚构联系人甲", registeredOn: new Date("2026-08-01T00:00:00Z"), salesText: "虚构售前甲", notes: "虚构备注", plannedVisitOn: "2026/08/08", visitStatus: "已拜访" };
  const parsed = parseMunichVisitRow(input);
  assert.deepEqual(Object.keys(parsed.rawFields), labels);
  assert.equal(parsed.rawFields.意向, "A");
  assert.equal(parsed.rawFields.拜访状态, "已拜访");
  assert.equal(parsed.rawFields.登记时间, "2026-08-01T00:00:00.000Z");
  assert.equal(parsed.normalized.registeredOn, "2026-08-01");
  assert.equal(parsed.normalized.plannedVisitOn, "2026-08-08");
  assert.deepEqual(parsed.errors, []);
});

test("登记与计划日期严格校验，意向和三种拜访状态只保留原值且不生成业务状态", () => {
  assert.equal(visitDateCandidate("2024年2月29日"), "2024-02-29");
  assert.equal(visitDateCandidate("2026-02-29"), null);
  assert.equal(visitDateCandidate("2026-99-99"), null);
  for (const visitStatus of ["线上沟通", "未沟通", "已拜访"]) {
    const parsed = parseMunichVisitRow({ customerName: "虚构日期客户", intention: "D", registeredOn: "2026-08-01", plannedVisitOn: "2026-08-09", visitStatus });
    assert.equal(parsed.normalized.intention, "D");
    assert.equal(parsed.normalized.visitStatus, visitStatus);
    assert.equal(Object.hasOwn(parsed.normalized, "status"), false);
    assert.equal(Object.hasOwn(parsed.normalized, "occurredOn"), false);
    assert.deepEqual(parsed.errors, []);
  }
  assert.deepEqual(parseMunichVisitRow({ customerName: "虚构日期客户", registeredOn: "2026-02-29", plannedVisitOn: "2026-13-01" }).errors, ["REGISTERED_ON_INVALID", "PLANNED_VISIT_ON_INVALID"]);
});

test("公式、超长值和不明确接洽人保留原文待核对，明确姓名只作为联系人候选", () => {
  const uncertain = parseMunichVisitRow({ customerName: "虚构客户", contactName: "张三、李四/13800000000", notes: "原始备注" }, ["salesText"]);
  assert.equal(uncertain.rawFields.接洽人, "张三、李四/13800000000");
  assert.equal(uncertain.normalized.contactName, null);
  assert.deepEqual(uncertain.warnings, ["CONTACT_NAME_REVIEW_REQUIRED"]);
  assert.deepEqual(uncertain.errors, ["FORMULA_REVIEW_REQUIRED:salesText"]);
  const named = parseMunichVisitRow({ customerName: "虚构客户", contactName: "Zhang San" });
  assert.equal(named.normalized.contactName, "Zhang San");
  assert.deepEqual(named.warnings, []);
  assert.ok(parseMunichVisitRow({ customerName: "虚".repeat(201) }).errors.includes("CUSTOMER_NAME_TOO_LONG"));
});
