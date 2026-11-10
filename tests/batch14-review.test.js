import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createContact, createFollowup } from "../server/customer-activity-service.js";
import { updateCustomerMapPoint } from "../server/customer-service.js";
import { getMapOverview } from "../server/map-service.js";
import { createQuote, decideQuote, submitQuote } from "../server/quote-service.js";
import { actOnReminder, createReminder, getReminder, listReminderEvents, listReminders } from "../server/reminder-service.js";
import { sha256 } from "../server/security.js";
import { createSurvey } from "../server/survey-service.js";
import { publicMapResource, validateMapResource } from "../server/map-resource.js";
import { buildCustomerFilterQuery, createLatestRequestGate } from "../web/core-use-ui.js";
import { addCustomerAndProject, sampleQuoteInput, setupBase, startTestApi } from "./test-utils.js";

const VALID_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=", "base64");

function writeReadyMap(storagePath, asset = VALID_PNG) {
  const directory = path.join(storagePath, "maps");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "synthetic.png"), asset);
  fs.writeFileSync(path.join(directory, "china-standard-map.json"), JSON.stringify({
    reviewNumber: "GS(2026)1234号", sourceUrl: "https://bzdt.tianditu.gov.cn/synthetic-only",
    assetFile: "synthetic.png", sha256: sha256(asset), preserveOriginal: true, noCrop: true,
    noBoundaryModification: true, regionAnchors: [{ name: "测试省甲", xPercent: 50, yPercent: 40 }]
  }));
  return sha256(asset);
}

function approvalObjects(f) {
  const { customer, project } = addCustomerAndProject(f.db, f.salesA, "权限复核");
  const contact = createContact(f.db, f.salesA, customer.id, { name: "虚构受限联系人" });
  const followup = createFollowup(f.db, f.salesA, customer.id, { method: "PHONE", occurredAt: "2026-09-01T08:00:00.000Z", content: "虚构跟进", nextAction: "虚构下一步" }).followup;
  const survey = createSurvey(f.db, f.salesA, { templateId: "MES-PRESALES-SURVEY:A/0", customerId: customer.id, projectId: project.id, title: "虚构受限调研" });
  const quote = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id, "REVIEW"));
  submitQuote(f.db, f.salesA, quote.id);
  decideQuote(f.db, f.manager, quote.id, { decision: "APPROVED", comment: "虚构终审" });
  decideQuote(f.db, f.generalManager, quote.id, { decision: "APPROVED", comment: "虚构综合部审核" });
  return { customer, project, quote, targets: [{ type: "CONTACT", id: contact.id }, { type: "FOLLOWUP", id: followup.id }, { type: "SURVEY", id: survey.id }] };
}

test("副总不能通过 HTTP 已知对象 ID 绕过提醒候选范围，拒绝无写入", async () => {
  const f = setupBase();
  const api = await startTestApi(f.db, f.admin, [f.vp]);
  try {
    const { customer, project, quote, targets } = approvalObjects(f);
    const draft = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id, "DRAFT-REVIEW"));
    targets.push({ type: "QUOTE_VERSION", id: draft.id });
    const candidates = await api.request(f.vp, `/api/reminders/related-targets?customerId=${customer.id}`);
    assert.deepEqual(candidates.body.items.map(item => item.type), ["QUOTE_VERSION"]);
    const input = { customerId: customer.id, assigneeId: f.salesA.id, title: "虚构提醒", remindAt: "2026-09-08T08:00:00.000Z" };
    const before = f.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs`).get().count;
    for (const target of targets) {
      const response = await api.request(f.vp, "/api/reminders", "POST", { ...input, relatedType: target.type, relatedId: target.id });
      assert.equal(response.status, 400, target.type);
      assert.equal(response.body.error.code, "REMINDER_RELATED_TARGET_INVALID");
    }
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM reminders`).get().count, 0);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM reminder_events`).get().count, 0);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs`).get().count, before);
    const allowed = await api.request(f.vp, "/api/reminders", "POST", { ...input, relatedType: "QUOTE_VERSION", relatedId: quote.id });
    assert.equal(allowed.status, 201);
    assert.equal(allowed.body.businessObject.id, quote.id);
    assert.equal((await api.request(f.vp, "/api/reminders", "POST", input)).status, 201);
  } finally { await api.close(); f.db.close(); }
});

test("副总读取历史提醒及事件时不返回无权关联元数据，普通角色仍能读取", async () => {
  const f = setupBase();
  const api = await startTestApi(f.db, f.admin, [f.vp]);
  try {
    const { customer, targets } = approvalObjects(f);
    for (const target of targets) {
      const reminder = createReminder(f.db, f.manager, { customerId: customer.id, assigneeId: f.salesA.id, title: "虚构历史提醒", remindAt: "2026-09-08T08:00:00.000Z", relatedType: target.type, relatedId: target.id });
      // 模拟旧版本曾允许副总写入的关联；不读取真实数据库。
      f.db.prepare(`UPDATE reminders SET assigned_by = ? WHERE id = ?`).run(f.vp.id, reminder.id);
      actOnReminder(f.db, f.salesA, reminder.id, { action: "POSTPONE", remindAt: "2026-09-09T08:00:00.000Z", reason: "虚构延期" });
      const current = getReminder(f.db, f.vp, reminder.id);
      assert.equal(current.businessObject, null);
      assert.equal(current.relatedType, null);
      assert.equal(current.relatedId, null);
      assert.equal(listReminders(f.db, f.vp, { view: "assigned" }).find(item => item.id === reminder.id).businessObject, null);
      const listResponse = await api.request(f.vp, "/api/reminders?view=assigned");
      assert.equal(listResponse.status, 200);
      assert.ok(!JSON.stringify(listResponse.body).includes(target.id));
      const eventsResponse = await api.request(f.vp, `/api/reminders/${reminder.id}/events`);
      assert.equal(eventsResponse.status, 200);
      assert.ok(!JSON.stringify(eventsResponse.body).includes(target.id));
      for (const event of listReminderEvents(f.db, f.vp, reminder.id)) {
        for (const snapshot of [event.before, event.after].filter(Boolean)) {
          assert.equal(snapshot.related_type, null);
          assert.equal(snapshot.related_id, null);
        }
      }
      assert.equal(getReminder(f.db, f.salesA, reminder.id).businessObject.id, target.id);
      assert.equal(listReminderEvents(f.db, f.admin, reminder.id)[0].after.related_id, target.id);
    }
  } finally { await api.close(); f.db.close(); }
});

test("地图区域人员独立按角色取启用名单，零客户仍可显示和筛选且不扩大副总范围", () => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-review-roster-"));
  try {
    writeReadyMap(storagePath);
    assert.ok(getMapOverview(f.db, storagePath, f.admin).representatives.some(item => item.id === f.salesOther.id && item.regions.length === 0 && item.customerCount === 0));
    f.db.prepare(`UPDATE users SET regions_json = ? WHERE id = ?`).run(JSON.stringify(["非直属测试省"]), f.salesOther.id);
    const ids = rows => rows.map(item => item.id).sort();
    const manager = getMapOverview(f.db, storagePath, f.manager);
    assert.deepEqual(ids(manager.representatives), [f.salesA.id, f.salesB.id].sort());
    assert.deepEqual(ids(manager.filterOptions.owners), [f.salesA.id, f.salesB.id].sort());
    assert.ok(manager.representatives.every(item => item.customerCount === 0));
    assert.equal(manager.representatives.find(item => item.id === f.salesA.id).regionSummaries[0].anchor.name, "测试省甲");
    assert.ok(!manager.filterOptions.regions.includes("非直属测试省"));
    assert.deepEqual(ids(getMapOverview(f.db, storagePath, f.admin).representatives), [f.salesA.id, f.salesB.id, f.salesOther.id].sort());
    assert.deepEqual(ids(getMapOverview(f.db, storagePath, f.salesA).representatives), [f.salesA.id]);
    assert.deepEqual(ids(getMapOverview(f.db, storagePath, f.manager, { ownerId: f.salesB.id, region: "测试省乙", status: "现场调研" }).representatives), [f.salesB.id]);
    assert.deepEqual(getMapOverview(f.db, storagePath, f.manager, { ownerId: f.salesOther.id }).representatives, []);
    assert.deepEqual(getMapOverview(f.db, storagePath, f.manager, { region: "非直属测试省" }).representatives, []);
    assert.deepEqual(getMapOverview(f.db, storagePath, f.vp).representatives, []);
    const { customer, quote } = approvalObjects(f);
    const vpMap = getMapOverview(f.db, storagePath, f.vp);
    assert.deepEqual(ids(vpMap.filterOptions.owners), [f.salesA.id]);
    assert.deepEqual(vpMap.unlocatedCustomers[0].detailTarget, { type: "QUOTE_VERSION", id: quote.id });
    f.db.prepare(`UPDATE users SET is_active = 0 WHERE id = ?`).run(f.salesA.id);
    assert.deepEqual(ids(getMapOverview(f.db, storagePath, f.manager).representatives), [f.salesB.id]);
    assert.deepEqual(ids(getMapOverview(f.db, storagePath, f.admin).filterOptions.owners), [f.salesB.id, f.salesOther.id].sort());
    assert.ok(!getMapOverview(f.db, storagePath, f.manager).unlocatedCustomers.some(item => item.id === customer.id));
    assert.ok(getMapOverview(f.db, storagePath, f.admin).unlocatedCustomers.some(item => item.id === customer.id));
  } finally { f.db.close(); fs.rmSync(storagePath, { recursive: true, force: true }); }
});

test("HTTP 底图响应绑定地图数据的 SHA：A 数据不能取得 B 图片且刷新后可恢复", async () => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-review-image-"));
  const mapApi = await startTestApi(f.db, f.admin, [f.salesA], { storagePath });
  try {
    const { customer } = addCustomerAndProject(f.db, f.salesA, "底图竞态");
    const digestA = writeReadyMap(storagePath);
    updateCustomerMapPoint(f.db, storagePath, f.salesA, customer.id, { xPercent: 50, yPercent: 40, expectedAssetSha256: digestA, reason: "虚构定位" });
    const dataA = (await mapApi.request(f.salesA, "/api/map")).body;
    assert.equal(dataA.customerPoints.length, 1);
    const imageA = await mapApi.request(f.salesA, dataA.offlineBasemap.assetUrl);
    assert.equal(imageA.status, 200);
    assert.equal(sha256(imageA.body), digestA);
    const digestB = writeReadyMap(storagePath, Buffer.concat([VALID_PNG, Buffer.from("synthetic-b")]));
    const stale = await mapApi.request(f.salesA, dataA.offlineBasemap.assetUrl);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "MAP_RESOURCE_CHANGED");
    for (const query of ["", "?expectedAssetSha256=invalid", `?expectedAssetSha256=${digestB}&expectedAssetSha256=${digestB}`]) {
      assert.equal((await mapApi.request(f.salesA, `/api/map/basemap${query}`)).status, 409);
    }
    const dataB = (await mapApi.request(f.salesA, "/api/map")).body;
    assert.equal(dataB.customerPoints.length, 0);
    assert.equal(dataB.unlocatedCustomers[0].mapPointStatus, "RECONFIRM_REQUIRED");
    assert.notEqual(dataA.offlineBasemap.assetUrl, dataB.offlineBasemap.assetUrl);
    const imageB = await mapApi.request(f.salesA, dataB.offlineBasemap.assetUrl);
    assert.equal(imageB.status, 200);
    assert.equal(sha256(imageB.body), digestB);
    assert.equal("assetBuffer" in dataB.offlineBasemap, false);
    assert.equal("assetPath" in dataB.offlineBasemap, false);
    for (const status of ["MISSING", "INVALID"]) {
      assert.deepEqual(publicMapResource({ status, assetPath: "synthetic-internal-path", assetBuffer: VALID_PNG }), { status });
    }
    const validatedB = validateMapResource(storagePath);
    writeReadyMap(storagePath);
    assert.equal(sha256(validatedB.assetBuffer), digestB);
    assert.equal(f.db.prepare(`SELECT map_asset_sha256 FROM customers WHERE id = ?`).get(customer.id).map_asset_sha256, digestA);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'CUSTOMER_MAP_POINT_UPDATED'`).get().count, 1);
  } finally { await mapApi.close(); f.db.close(); fs.rmSync(storagePath, { recursive: true, force: true }); }
});

test("前端底图加载和错误事件控制叠加层与选点，过期图片事件不改变当前状态", async () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const renderSource = source.slice(source.indexOf("async function renderMap(content)"), source.indexOf("function openMapCustomer(customerId)"));
  const data = { offlineBasemap: { status: "READY", assetUrl: "/api/map/basemap?expectedAssetSha256=synthetic", sha256: "synthetic" }, customerPoints: [], representatives: [], unlocatedCustomers: [], filterOptions: { owners: [], statuses: [], regions: [] } };
  const state = { mapFilters: {}, mapData: null, mapImageReady: false, mapPickerCustomerId: null, mapPickerAssetSha256: null };
  const events = {};
  const classes = new Set();
  const canvas = { classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, remove(name) { classes.delete(name); } } };
  const image = { complete: false, naturalWidth: 0, addEventListener(type, listener) { events[type] = listener; } };
  const pick = { disabled: false };
  const label = { textContent: "" };
  const content = { isConnected: true, innerHTML: "", querySelector(selector) { return { ".map-canvas img": image, ".map-canvas": canvas, ".map-business-layer": label }[selector]; }, querySelectorAll() { return [pick]; } };
  const mapRenderGate = createLatestRequestGate();
  const context = vm.createContext({ state, mapRenderGate, api: async () => data, buildCustomerFilterQuery, normalizedMapPosition: () => null, pageHead: () => "", escapeHtml: value => String(value || ""), selectOptions: (_options, value) => `selected-${value}` });
  vm.runInContext(renderSource, context);
  await context.renderMap(content);
  assert.equal(state.mapImageReady, false);
  assert.equal(pick.disabled, true);
  assert.equal(classes.has("map-image-ready"), false);
  events.error();
  assert.match(label.textContent, /请刷新地图/);
  assert.equal(classes.has("map-image-ready"), false);
  image.naturalWidth = 100;
  events.load();
  assert.equal(state.mapImageReady, true);
  assert.equal(pick.disabled, false);
  assert.equal(classes.has("map-image-ready"), true);
  state.mapPickerCustomerId = "synthetic-customer";
  state.mapPickerAssetSha256 = "synthetic";
  events.error();
  assert.equal(state.mapPickerCustomerId, null);
  assert.equal(state.mapPickerAssetSha256, null);
  assert.equal(pick.disabled, true);
  state.mapData = { ...data };
  events.load();
  assert.equal(state.mapImageReady, false);
  assert.equal(classes.has("map-image-ready"), false);
  const oldImageLoad = events.load;
  const pending = [];
  context.api = route => new Promise((resolve, reject) => pending.push({ route, resolve, reject }));
  state.mapFilters = { ownerId: "old-owner", status: "初期接洽" };
  const oldRequest = context.renderMap(content);
  state.mapFilters = { ownerId: "final-owner", status: "现场调研" };
  const finalRequest = context.renderMap(content);
  oldImageLoad();
  assert.equal(state.mapImageReady, false);
  const finalData = { ...data, offlineBasemap: { ...data.offlineBasemap, sha256: "final-map" } };
  pending[1].resolve(finalData);
  await finalRequest;
  const finalMarkup = content.innerHTML;
  assert.match(finalMarkup, /selected-final-owner/);
  assert.match(finalMarkup, /selected-现场调研/);
  pending[0].resolve(data);
  await oldRequest;
  assert.equal(state.mapData, finalData);
  assert.equal(content.innerHTML, finalMarkup);
  assert.match(pending[0].route, /ownerId=old-owner/);
  assert.match(pending[1].route, /ownerId=final-owner/);
  const staleFailure = context.renderMap(content);
  const afterFailure = context.renderMap(content);
  pending[3].resolve(finalData);
  await afterFailure;
  pending[2].reject(new Error("虚构过期失败"));
  await staleFailure;
  assert.equal(content.innerHTML, finalMarkup);
  mapRenderGate.invalidate();
  events.load();
  assert.equal(state.mapImageReady, false);
  assert.equal(classes.has("map-image-ready"), false);
  const css = fs.readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  assert.match(css, /\.map-canvas:not\(\.map-image-ready\) \.map-overlay\s*\{\s*display:\s*none;/);
  assert.match(source, /if \(!state\.mapImageReady\) return showToast/);
  assert.match(source, /if \(page !== "map"\) mapRenderGate\.invalidate\(\)/);
  assert.match(source, /function resetBusinessState\(\)\s*\{\s*customerRenderGate\.invalidate\(\);\s*mapRenderGate\.invalidate\(\)/);
});

test("无合规底图时仍展示权限内区域和客户清单且不渲染替代边界", async () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const renderSource = source.slice(source.indexOf("async function renderMap(content)"), source.indexOf("function openMapCustomer(customerId)"));
  const data = {
    offlineBasemap: { status: "MISSING", message: "尚未安装经确认的自然资源部标准地图离线资源" },
    customerPoints: [],
    unlocatedCustomers: [{ id: "customer-1", name: "虚构客户甲", status: "现场调研", owner: { id: "sales-1", displayName: "虚构售前甲" }, region: "测试省 · 测试市", lastFollowupAt: "2026-10-14T08:00:00.000Z", mapPointStatus: "UNSET", canEditPoint: true }],
    representatives: [{ id: "sales-1", displayName: "虚构售前甲", regions: ["测试省"], customerCount: 1, regionSummaries: [{ name: "测试省", anchor: null, customerCount: 1 }] }],
    filterOptions: { owners: [{ id: "sales-1", displayName: "虚构售前甲" }], statuses: ["现场调研"], regions: ["测试省"] }
  };
  const state = { mapFilters: {}, mapData: null, mapImageReady: false, mapPickerCustomerId: null, mapPickerAssetSha256: null };
  const content = { isConnected: true, innerHTML: "", querySelector() { return null; }, querySelectorAll() { return []; } };
  const context = vm.createContext({ state, mapRenderGate: createLatestRequestGate(), api: async () => data, buildCustomerFilterQuery, normalizedMapPosition: () => null, pageHead: () => "", escapeHtml: value => String(value || ""), selectOptions: () => "", formatTime: value => value });
  vm.runInContext(renderSource, context);
  await context.renderMap(content);
  assert.match(content.innerHTML, /区域与客户分布（清单模式）/);
  assert.match(content.innerHTML, /虚构售前甲/);
  assert.match(content.innerHTML, /虚构客户甲/);
  assert.match(content.innerHTML, /测试省 · 1/);
  assert.match(content.innerHTML, /data-map-customer="customer-1"/);
  assert.doesNotMatch(content.innerHTML, /<img/);
  assert.doesNotMatch(content.innerHTML, /data-map-pick=/);
  assert.doesNotMatch(content.innerHTML, /map-placeholder/);
});
