import assert from "node:assert/strict";
import test from "node:test";
import { createSopDocument, getSopDocument, listSopDocuments, listSopFilters, listSopVersions, publishSopVersion } from "../server/sop-service.js";
import { setupBase } from "./test-utils.js";

test("SOP 知识库按岗位、阶段和关键词查询，所有登录角色只读可见", () => {
  const { db, salesA, manager, vp } = setupBase();
  try {
    const all = listSopDocuments(db, salesA);
    assert.equal(all.length, 12);
    assert.equal(listSopDocuments(db, manager, { role: "售前顾问" }).every(item => item.roles.includes("售前顾问")), true);
    assert.deepEqual(listSopDocuments(db, salesA, { stage: "前期调研" }).map(item => item.code), ["PRE_SURVEY"]);
    assert.equal(listSopDocuments(db, vp, { query: "变更确认单" }).some(item => item.code === "CHANGE_MANAGEMENT"), true);
    const duties = all.find(item => item.code === "PRESALES_DUTIES");
    assert.equal(duties.title, "售前顾问工作职责");
    assert.equal(duties.body.split("\n").filter(line => line.startsWith("- ")).length, 16);
    assert.doesNotMatch(duties.body, /15\s*项/);
    const visit = all.find(item => item.code === "CUSTOMER_VISIT");
    assert.match(visit.body, /第二责任人：部门经理[\s\S]*根据需要协调开发实施人员配合现场沟通/);
    assert.match(visit.body, /协助人员：无/);
    assert.doesNotMatch(visit.body, /协助事项/);
    const globalRules = all.find(item => item.code === "GLOBAL_RULES");
    assert.match(globalRules.body, /不存在项目自动享有的免费额度/);
    assert.match(globalRules.body, /部门经理书面审批后才可对外承诺/);
    assert.match(globalRules.body, /重新完成完整三级报价审批并执行合同变更留痕/);
    assert.doesNotMatch(globalRules.body, /适度免费服务额度/);
    const filters = listSopFilters(db, salesA);
    assert.equal(filters.roles.includes("项目经理"), true);
    assert.equal(filters.stages.includes("项目验收"), true);
    const first = getSopDocument(db, salesA, all[0].documentId);
    assert.equal(first.current, true);
    assert.equal(first.versionNumber, "1.0");
    assert.equal(listSopVersions(db, manager, first.documentId).length, 1);
    const serialized = JSON.stringify(all);
    assert.doesNotMatch(serialized, /@hacint\.com\.cn/i);
    assert.doesNotMatch(serialized, /1[3-9]\d{9}/);
  } finally {
    db.close();
  }
});

test("仅管理员可以发布 SOP，新版本成为当前版且历史版本不可覆盖", () => {
  const { db, admin, manager, salesA } = setupBase();
  const firstInput = {
    versionNumber: "A/0",
    title: "虚构测试岗位规范",
    roles: ["虚构测试岗位"],
    stages: ["虚构测试阶段"],
    keywords: ["虚构关键词"],
    body: "虚构首版正文，仅用于自动化测试。",
    updateSummary: "虚构首版发布说明"
  };
  try {
    assert.throws(() => createSopDocument(db, salesA, firstInput), error => error.code === "SOP_ADMIN_FORBIDDEN");
    const created = createSopDocument(db, admin, firstInput);
    assert.equal(created.versionNumber, "A/0");
    assert.equal(getSopDocument(db, manager, created.documentId).body, firstInput.body);
    assert.throws(() => publishSopVersion(db, salesA, created.documentId, { ...firstInput, versionNumber: "A/1" }), error => error.code === "SOP_ADMIN_FORBIDDEN");

    const second = publishSopVersion(db, admin, created.documentId, {
      ...firstInput,
      versionNumber: "A/1",
      body: "虚构第二版正文，仅用于自动化测试。",
      updateSummary: "虚构第二版更新说明"
    });
    assert.equal(second.versionNumber, "A/1");
    assert.equal(second.body, "虚构第二版正文，仅用于自动化测试。");
    assert.equal(second.publishedBy.id, admin.id);
    assert.ok(Date.parse(second.publishedAt));
    const history = listSopVersions(db, salesA, created.documentId);
    assert.equal(history.length, 2);
    assert.equal(history.find(item => item.versionNumber === "A/0").body, firstInput.body);
    assert.equal(history.find(item => item.versionNumber === "A/0").current, false);
    assert.throws(() => publishSopVersion(db, admin, created.documentId, { ...firstInput, versionNumber: "A/1" }), error => error.code === "SOP_VERSION_DUPLICATE");
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = ? AND action = 'SOP_VERSION_PUBLISHED'`).get(created.documentId).count, 2);
  } finally {
    db.close();
  }
});
