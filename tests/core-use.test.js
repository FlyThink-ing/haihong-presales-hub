import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContact, createFollowup } from "../server/customer-activity-service.js";
import { listCustomers, transferCustomer, updateCustomer, updateCustomerMapPoint } from "../server/customer-service.js";
import { createCustomerDictionaryOption } from "../server/customer-dictionary-service.js";
import { getMapOverview } from "../server/map-service.js";
import { createQuote, decideQuote, submitQuote } from "../server/quote-service.js";
import { createReminder, listReminderRelatedTargets, listReminders } from "../server/reminder-service.js";
import { sha256 } from "../server/security.js";
import { buildCustomerFilterQuery, createLatestRequestGate, normalizedMapPosition, reminderTargetAction, shouldShowSignedStatusSuggestion } from "../web/core-use-ui.js";
import { addCustomerAndProject, sampleQuoteInput, setupBase, startTestApi } from "./test-utils.js";

const VALID_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=", "base64");

function writeReadyMap(storagePath, { asset = VALID_PNG, regionAnchors = [{ name: "测试省甲", xPercent: 63.5, yPercent: 42.25 }] } = {}) {
  const mapDirectory = path.join(storagePath, "maps");
  fs.mkdirSync(mapDirectory, { recursive: true });
  fs.writeFileSync(path.join(mapDirectory, "virtual-map.png"), asset);
  const digest = sha256(asset);
  fs.writeFileSync(path.join(mapDirectory, "china-standard-map.json"), JSON.stringify({
    reviewNumber: "GS(2026)1234号",
    sourceUrl: "https://bzdt.tianditu.gov.cn/virtual-test-only",
    assetFile: "virtual-map.png",
    sha256: digest,
    preserveOriginal: true,
    noCrop: true,
    noBoundaryModification: true,
    regionAnchors
  }));
  return digest;
}

test("客户筛选和阶段统计严格继承当前权限", () => {
  const f = setupBase();
  try {
    const a = addCustomerAndProject(f.db, f.salesA, "筛选甲").customer;
    const b = addCustomerAndProject(f.db, f.salesB, "筛选乙").customer;
    addCustomerAndProject(f.db, f.salesOther, "筛选其他");
    createCustomerDictionaryOption(f.db, f.admin, { kind: "SOURCE", value: "虚构展会" });
    createCustomerDictionaryOption(f.db, f.admin, { kind: "SOURCE", value: "虚构转介绍" });
    createCustomerDictionaryOption(f.db, f.admin, { kind: "TYPE", value: "重点客户" });
    createCustomerDictionaryOption(f.db, f.admin, { kind: "TYPE", value: "普通客户" });
    updateCustomer(f.db, f.salesA, a.id, { source: "虚构展会", customerType: "重点客户", industry: "虚构制造行业", status: "现场调研", needSummary: `虚构长需求-${"甲".repeat(800)}` });
    updateCustomer(f.db, f.salesB, b.id, { source: "虚构转介绍", customerType: "普通客户", status: "方案&报价" });

    assert.deepEqual(listCustomers(f.db, f.salesA, { source: "虚构展会", status: "现场调研" }).map(item => item.id), [a.id]);
    assert.deepEqual(listCustomers(f.db, f.manager, { ownerId: f.salesB.id, customerType: "普通客户" }).map(item => item.id), [b.id]);
    assert.equal(listCustomers(f.db, f.admin, { region: "测试省" }).length, 3);
    assert.throws(() => listCustomers(f.db, f.salesA, { status: "不存在状态" }), error => error.code === "CUSTOMER_FILTER_STATUS_INVALID");
    assert.throws(() => listCustomers(f.db, f.salesA, { registeredFrom: "2026-09-02", registeredTo: "2026-09-01" }), error => error.code === "CUSTOMER_FILTER_DATE_RANGE_INVALID");

  } finally {
    f.db.close();
  }
});

test("地图仅叠加有权客户点位，人工选点重新鉴权并记录前后值", () => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-core-map-"));
  try {
    const { customer, project } = addCustomerAndProject(f.db, f.salesA, "地图甲");
    const firstMapSha = writeReadyMap(storagePath);
    f.db.prepare(`UPDATE customers SET longitude = 113.62, latitude = 34.75 WHERE id = ?`).run(customer.id);
    const updated = updateCustomerMapPoint(f.db, storagePath, f.salesA, customer.id, { xPercent: 61.25, yPercent: 44.5, expectedAssetSha256: firstMapSha, reason: "虚构原图点位确认" });
    assert.deepEqual(updated.mapPoint, { xPercent: 61.25, yPercent: 44.5, assetSha256: firstMapSha });
    assert.deepEqual([updated.longitude, updated.latitude], [113.62, 34.75]);
    assert.throws(() => updateCustomerMapPoint(f.db, storagePath, f.salesA, customer.id, { xPercent: -1, yPercent: 50, expectedAssetSha256: firstMapSha, reason: "非法百分比" }), error => error.code === "CUSTOMER_COORDINATE_INVALID");
    assert.throws(() => updateCustomerMapPoint(f.db, storagePath, f.manager, customer.id, { xPercent: 40, yPercent: 35, expectedAssetSha256: firstMapSha, reason: "领导无权代改" }), error => error.code === "CUSTOMER_MAP_POINT_FORBIDDEN");
    assert.throws(() => updateCustomerMapPoint(f.db, storagePath, f.salesOther, customer.id, { xPercent: 40, yPercent: 35, expectedAssetSha256: firstMapSha, reason: "越权" }), error => error.code === "CUSTOMER_NOT_FOUND");
    const salesMap = getMapOverview(f.db, storagePath, f.salesA, { status: "初期接洽", region: "测试省" });
    assert.equal(salesMap.offlineBasemap.status, "READY");
    assert.equal(salesMap.customerPoints.length, 1);
    assert.deepEqual(salesMap.customerPoints[0].mapPosition, { xPercent: 61.25, yPercent: 44.5 });
    assert.equal(salesMap.customerPoints[0].detailTarget.type, "CUSTOMER");
    assert.equal(salesMap.representatives[0].displayName, f.salesA.displayName);
    assert.deepEqual(salesMap.representatives[0].regionSummaries[0].anchor, { name: "测试省甲", xPercent: 63.5, yPercent: 42.25 });
    assert.ok(salesMap.representatives[0].regionSummaries.some(region => region.name === "测试省甲"));
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'CUSTOMER_MAP_POINT_UPDATED' AND entity_id = ?`).get(customer.id).count, 1);

    const secondMapSha = writeReadyMap(storagePath, { asset: Buffer.concat([VALID_PNG, Buffer.from("synthetic-map-b")]), regionAnchors: [] });
    assert.notEqual(secondMapSha, firstMapSha);
    const changedMap = getMapOverview(f.db, storagePath, f.salesA);
    assert.equal(changedMap.customerPoints.length, 0);
    assert.equal(changedMap.unlocatedCustomers[0].mapPointStatus, "RECONFIRM_REQUIRED");
    assert.equal(changedMap.representatives[0].regionSummaries[0].anchor, null);
    const beforeRace = f.db.prepare(`SELECT map_asset_sha256 FROM customers WHERE id = ?`).get(customer.id);
    assert.throws(() => updateCustomerMapPoint(f.db, storagePath, f.salesA, customer.id, { xPercent: 58, yPercent: 39, expectedAssetSha256: firstMapSha, reason: "使用旧页面提交" }), error => error.code === "MAP_RESOURCE_CHANGED");
    assert.deepEqual(f.db.prepare(`SELECT map_asset_sha256 FROM customers WHERE id = ?`).get(customer.id), beforeRace);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'CUSTOMER_MAP_POINT_UPDATED' AND entity_id = ?`).get(customer.id).count, 1);
    updateCustomerMapPoint(f.db, storagePath, f.salesA, customer.id, { xPercent: 58, yPercent: 39, expectedAssetSha256: secondMapSha, reason: "虚构更换底图后重新确认" });
    assert.equal(getMapOverview(f.db, storagePath, f.salesA).customerPoints.length, 1);

    const quote = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id, "MAP-VP"));
    submitQuote(f.db, f.salesA, quote.id);
    decideQuote(f.db, f.manager, quote.id, { decision: "APPROVED", comment: "虚构地图终审权限" });
    decideQuote(f.db, f.generalManager, quote.id, { decision: "APPROVED", comment: "虚构综合部审核" });
    const vpMap = getMapOverview(f.db, storagePath, f.vp);
    assert.equal(vpMap.customerPoints.length, 1);
    assert.deepEqual(vpMap.customerPoints[0].detailTarget, { type: "QUOTE_VERSION", id: quote.id });
    transferCustomer(f.db, f.manager, customer.id, { newOwnerId: f.salesB.id, reason: "虚构地图区域交接" });
    assert.equal(getMapOverview(f.db, storagePath, f.salesA).customerPoints.length, 0);
    assert.throws(() => updateCustomerMapPoint(f.db, storagePath, f.salesA, customer.id, { xPercent: 55, yPercent: 38, expectedAssetSha256: secondMapSha, reason: "转让后越权" }), error => error.code === "CUSTOMER_NOT_FOUND");
  } finally {
    f.db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test("提醒关联对象按客户归属校验，跳转信息随转让即时失权", () => {
  const f = setupBase();
  try {
    const { customer } = addCustomerAndProject(f.db, f.salesA, "提醒关联");
    const other = addCustomerAndProject(f.db, f.salesB, "提醒异客").customer;
    const contact = createContact(f.db, f.salesA, customer.id, { name: "虚构联系人", title: "经理", mobile: "00000000000" });
    const otherContact = createContact(f.db, f.salesB, other.id, { name: "异客联系人" });
    const followup = createFollowup(f.db, f.salesA, customer.id, { method: "PHONE", occurredAt: "2026-08-31T08:00:00.000Z", content: "虚构关联沟通", nextAction: "虚构后续动作" }).followup;
    const related = listReminderRelatedTargets(f.db, f.salesA, customer.id);
    assert.ok(related.some(item => item.type === "CONTACT" && item.id === contact.id));
    assert.ok(related.some(item => item.type === "FOLLOWUP" && item.id === followup.id && item.target.tab === "followups"));
    assert.throws(() => createReminder(f.db, f.salesA, { customerId: customer.id, relatedType: "CONTACT", relatedId: otherContact.id, title: "虚构错误关联", remindAt: "2026-09-05T08:00:00.000Z" }), error => error.code === "REMINDER_RELATED_TARGET_INVALID");
    const reminder = createReminder(f.db, f.salesA, { customerId: customer.id, relatedType: "FOLLOWUP", relatedId: followup.id, title: "虚构跟进提醒", remindAt: "2026-09-05T08:00:00.000Z" });
    assert.equal(reminder.businessObject.label, "跟进记录：2026-08-31");
    assert.equal(listReminders(f.db, f.salesA)[0].businessObject.target.tab, "followups");
    transferCustomer(f.db, f.manager, customer.id, { newOwnerId: f.salesB.id, reason: "虚构提醒客户转让" });
    assert.equal(listReminders(f.db, f.salesA).length, 0);
    assert.throws(() => listReminderRelatedTargets(f.db, f.salesA, customer.id), error => error.code === "CUSTOMER_NOT_FOUND");
  } finally {
    f.db.close();
  }
});

test("客户与地图 HTTP 入口执行服务端权限和筛选门禁", async () => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-core-http-"));
  const api = await startTestApi(f.db, f.admin, [f.salesA, f.salesOther, f.manager, f.vp], { storagePath });
  try {
    const customer = addCustomerAndProject(f.db, f.salesA, "HTTP收口").customer;
    const stageCustomer = addCustomerAndProject(f.db, f.salesA, "HTTP阶段计数").customer;
    createCustomerDictionaryOption(f.db, f.admin, { kind: "SOURCE", value: "虚构HTTP来源" });
    updateCustomer(f.db, f.salesA, customer.id, { source: "虚构HTTP来源", status: "现场调研" });
    updateCustomer(f.db, f.salesA, stageCustomer.id, { source: "虚构HTTP来源", status: "方案&报价" });
    const filtered = await api.request(f.salesA, "/api/customers?status=%E7%8E%B0%E5%9C%BA%E8%B0%83%E7%A0%94&source=%E8%99%9A%E6%9E%84HTTP%E6%9D%A5%E6%BA%90");
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.body.items.map(item => item.id), [customer.id]);
    assert.equal(filtered.body.statusCounts["现场调研"], 1);
    assert.equal(filtered.body.statusCounts["方案&报价"], 1);
    assert.ok(filtered.body.filterOptions.owners.some(item => item.id === f.salesA.id));
    assert.equal((await api.request(f.salesOther, `/api/customers/${customer.id}/map-point`, "PATCH", { xPercent: 50, yPercent: 40, expectedAssetSha256: "0".repeat(64), reason: "越权" })).status, 404);
    const missingMapPoint = await api.request(f.salesA, `/api/customers/${customer.id}/map-point`, "PATCH", { xPercent: 50, yPercent: 40, expectedAssetSha256: "0".repeat(64), reason: "缺图禁止" });
    assert.equal(missingMapPoint.status, 409);
    assert.equal(missingMapPoint.body.error.code, "MAP_RESOURCE_UNAVAILABLE");
    const map = await api.request(f.salesA, "/api/map?status=%E7%8E%B0%E5%9C%BA%E8%B0%83%E7%A0%94");
    assert.equal(map.status, 200);
    assert.equal(map.body.customerPoints.length, 0);
    assert.equal(map.body.offlineBasemap.status, "MISSING");
    writeReadyMap(storagePath);
    const manifestPath = path.join(storagePath, "maps", "china-standard-map.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
    const invalidMapPoint = await api.request(f.salesA, `/api/customers/${customer.id}/map-point`, "PATCH", { xPercent: 50, yPercent: 40, expectedAssetSha256: manifest.sha256, reason: "坏图禁止" });
    assert.equal(invalidMapPoint.status, 409);
    assert.equal(invalidMapPoint.body.error.code, "MAP_RESOURCE_UNAVAILABLE");
    const mapASha = writeReadyMap(storagePath);
    const mapBSha = writeReadyMap(storagePath, { asset: Buffer.concat([VALID_PNG, Buffer.from("synthetic-http-map-b")]) });
    const auditBeforeRace = f.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'CUSTOMER_MAP_POINT_UPDATED' AND entity_id = ?`).get(customer.id).count;
    const staleMapPoint = await api.request(f.salesA, `/api/customers/${customer.id}/map-point`, "PATCH", { xPercent: 50, yPercent: 40, expectedAssetSha256: mapASha, reason: "HTTP旧页面竞态" });
    assert.equal(staleMapPoint.status, 409);
    assert.equal(staleMapPoint.body.error.code, "MAP_RESOURCE_CHANGED");
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'CUSTOMER_MAP_POINT_UPDATED' AND entity_id = ?`).get(customer.id).count, auditBeforeRace);
    assert.equal((await api.request(f.salesA, `/api/customers/${customer.id}/map-point`, "PATCH", { xPercent: 50, yPercent: 40, expectedAssetSha256: mapBSha, reason: "虚构HTTP原图选点" })).status, 200);
    assert.equal((await api.request(f.salesA, "/api/map?status=%E7%8E%B0%E5%9C%BA%E8%B0%83%E7%A0%94")).body.customerPoints.length, 1);
    assert.equal((await api.request(f.salesA, "/api/customers/export-docx", "POST", {})).status, 404);
  } finally {
    await api.close();
    f.db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test("筛选、地图坐标、提醒跳转和合同建议的前端纯函数保持可重复", () => {
  assert.equal(buildCustomerFilterQuery({ search: " 虚构客户 ", status: "现场调研", source: "" }), "search=%E8%99%9A%E6%9E%84%E5%AE%A2%E6%88%B7&status=%E7%8E%B0%E5%9C%BA%E8%B0%83%E7%A0%94");
  assert.deepEqual(normalizedMapPosition({ xPercent: 61.25, yPercent: 44.5 }), { left: 61.25, top: 44.5 });
  assert.equal(normalizedMapPosition({ xPercent: -1, yPercent: 44.5 }), null);
  assert.equal(normalizedMapPosition({ xPercent: null, yPercent: 44.5 }), null);
  const requestGate = createLatestRequestGate();
  const firstRequest = requestGate.begin();
  const finalRequest = requestGate.begin();
  assert.equal(requestGate.isCurrent(firstRequest), false);
  assert.equal(requestGate.isCurrent(finalRequest), true);
  requestGate.invalidate();
  assert.equal(requestGate.isCurrent(finalRequest), false);
  assert.deepEqual(reminderTargetAction({ page: "customer", customerId: "c1", tab: "followups" }), { action: "customer", id: "c1", tab: "followups" });
  assert.equal(reminderTargetAction({ page: "unknown", id: "x" }), null);
  assert.equal(shouldShowSignedStatusSuggestion({ status: "SIGNED", customerStatusSuggestion: { requiresConfirmation: true } }), true);
  assert.equal(shouldShowSignedStatusSuggestion({ status: "SIGNING", customerStatusSuggestion: { requiresConfirmation: true } }), false);

  const appSource = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const cssSource = fs.readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  assert.doesNotMatch(appSource, /data-customer-view="board"/);
  assert.match(appSource, /data-contract-confirm-status/);
  assert.match(appSource, /data-reminder-target/);
  assert.match(appSource, /data-map-pick/);
  assert.match(appSource, /区域与客户分布（清单模式）/);
  assert.match(appSource, /安装自然资源部标准地图原图后/);
  assert.match(appSource, /function resetBusinessState\(\)/);
  assert.match(appSource, /customerRenderGate\.isCurrent\(requestId\)/);
  assert.doesNotMatch(appSource, /customerRenderedFilters/);
  assert.match(cssSource, /@media \(max-width: 520px\)/);
  assert.match(cssSource, /\.map-overlay/);
  assert.match(cssSource, /\.map-list-fallback/);
});

test("客户列表过期响应不覆盖最终筛选", async () => {
  const gate = createLatestRequestGate();
  const rendered = { filters: null, customer: null };
  const applyResponse = async ({ requestId, delay, filters, customer }) => {
    await new Promise(resolve => setTimeout(resolve, delay));
    if (!gate.isCurrent(requestId)) return;
    rendered.filters = { ...filters };
    rendered.customer = customer;
  };

  const firstRequest = gate.begin();
  const first = applyResponse({ requestId: firstRequest, delay: 20, filters: { status: "初期接洽" }, customer: "旧响应客户" });
  const finalRequest = gate.begin();
  const final = applyResponse({ requestId: finalRequest, delay: 1, filters: { status: "现场调研" }, customer: "最终筛选客户" });
  await Promise.all([first, final]);

  assert.deepEqual(rendered, { filters: { status: "现场调研" }, customer: "最终筛选客户" });
});
