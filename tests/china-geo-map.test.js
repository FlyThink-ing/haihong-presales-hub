import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateChinaGeoJsonResource } from "../server/china-geojson-resource.js";
import { getMapOverview } from "../server/map-service.js";
import { buildChinaMapModel, calculateZoomViewBox, createGeoProjection, geometryPath, normalizeProvinceName, summarizeCustomersByProvince } from "../web/china-geo-map.js";
import { addCustomerAndProject, setupBase } from "./test-utils.js";

const assetPath = new URL("../web/assets/china.json", import.meta.url);

test("用户提供的中国 GeoJSON 通过结构校验且不冒充官方标准地图", () => {
  const resource = validateChinaGeoJsonResource();
  assert.equal(resource.status, "READY");
  assert.equal(resource.provinceCount, 34);
  assert.equal(resource.featureCount, 35);
  assert.equal(resource.coordinateCount, 25240);
  assert.equal(resource.sha256, "99adfeded5223848bbe37a0a12f8023e11ee12161c7800521c27db42fdeac275");
  assert.equal(resource.sourceType, "USER_PROVIDED");
  assert.equal(resource.reviewNumber, null);
  assert.equal(resource.sourceUrl, null);
  assert.equal(resource.coordinateSystem, "UNDECLARED");
  assert.match(resource.assetUrl, /^\/assets\/china\.json\?v=[a-f0-9]{16}$/);
});

test("GeoJSON 校验拒绝缺省省级要素和越界坐标", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hh-china-map-invalid-"));
  try {
    const incomplete = path.join(directory, "incomplete.json");
    fs.writeFileSync(incomplete, JSON.stringify({ type: "FeatureCollection", features: [] }));
    assert.equal(validateChinaGeoJsonResource(incomplete).status, "INVALID");
    const invalid = path.join(directory, "invalid.json");
    fs.writeFileSync(invalid, "not-json");
    assert.equal(validateChinaGeoJsonResource(invalid).status, "INVALID");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("地图模型区分经纬度精确点、省级估算点和无法定位客户", () => {
  const collection = JSON.parse(fs.readFileSync(assetPath, "utf8"));
  const representatives = [{ id: "sales-a", displayName: "虚构售前甲", regionSummaries: [{ name: "河南省", customerCount: 2 }] }];
  const customers = [
    { id: "exact", name: "虚构精确客户", status: "现场调研", province: "河南省", coordinates: { longitude: 113.62, latitude: 34.75 }, owner: { id: "sales-a", displayName: "虚构售前甲" } },
    { id: "estimated", name: "虚构估算客户", status: "初期接洽", province: "河南", coordinates: null, owner: { id: "sales-a", displayName: "虚构售前甲" } },
    { id: "unplaced", name: "虚构未定位客户", status: "初期接洽", province: "", coordinates: null, owner: { id: "sales-a", displayName: "虚构售前甲" } }
  ];
  const model = buildChinaMapModel(collection, customers, representatives);
  assert.equal(model.regions.filter(region => region.name).length, 34);
  assert.equal(model.regions.find(region => region.name === "河南省").assignment.ownerId, "sales-a");
  assert.equal(model.points.find(point => point.customer.id === "exact").positionType, "EXACT");
  assert.equal(model.points.find(point => point.customer.id === "estimated").positionType, "PROVINCE_CENTER");
  assert.equal(model.regions.find(region => region.name === "河南省").customerCount, 2);
  assert.equal(model.regions.find(region => region.name === "河南省").activeCount, 2);
  assert.notEqual(model.regions.find(region => region.name === "河南省").fill, model.regions.find(region => region.name === "海南省").fill);
  assert.deepEqual(model.unplaced.map(customer => customer.id), ["unplaced"]);
  assert.ok(model.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.equal(normalizeProvinceName("广西壮族自治区"), "广西");
  const projection = createGeoProjection(collection);
  const henan = collection.features.find(feature => feature.properties?.name === "河南省");
  assert.match(geometryPath(henan.geometry, projection.project), /^M[\d.]+,[\d.]+/);
  assert.deepEqual(summarizeCustomersByProvince(customers).map(item => [item.name, item.customerCount]), [["河南省", 2]]);
});

test("地图接口保留权限范围并返回客户结构化区域和可选经纬度", () => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-china-map-service-"));
  try {
    const { customer } = addCustomerAndProject(f.db, f.salesA, "地图字段");
    f.db.prepare(`UPDATE customers SET province = ?, city = ?, district = ?, longitude = ?, latitude = ? WHERE id = ?`).run("河南省", "郑州市", "中原区", 113.62, 34.75, customer.id);
    const overview = getMapOverview(f.db, storagePath, f.salesA);
    assert.equal(overview.provinceMap.status, "READY");
    const view = [...overview.customerPoints, ...overview.unlocatedCustomers].find(item => item.id === customer.id);
    assert.equal(view.province, "河南省");
    assert.equal(view.city, "郑州市");
    assert.equal(view.district, "中原区");
    assert.deepEqual(view.coordinates, { longitude: 113.62, latitude: 34.75 });
    assert.ok(!JSON.stringify(overview).includes("assetPath"));
  } finally { f.db.close(); fs.rmSync(storagePath, { recursive: true, force: true }); }
});

test("地图页面以省名和数量的单一标记及自动筛选为主", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const mapSource = fs.readFileSync(new URL("../web/china-geo-map.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  assert.match(source, /省名后的数字是当前权限和筛选范围内的客户数/);
  assert.match(source, /点击省份色块、名称或数量查看客户清单/);
  assert.match(source, /data-map-province=/);
  assert.match(source, /data-map-filter/);
  assert.match(source, /选择后自动更新地图和排行/);
  assert.doesNotMatch(source, /data-action="apply-map-filters"/);
  assert.doesNotMatch(source, /已录经纬度/);
  assert.match(source, /function openMapProvince/);
  assert.match(source, /在客户管理中查看该省/);
  assert.match(mapSource, /class: "china-map-province-label"/);
  assert.doesNotMatch(mapSource, /class: "china-map-points"/);
  assert.match(css, /\.china-map-province-label/);
  assert.match(css, /\.map-province-ranking/);
});

test("地图使用直接滚轮缩放和拖动平移且两栏不再制造底部空白", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const mapSource = fs.readFileSync(new URL("../web/china-geo-map.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  assert.match(source, /滚轮直接缩放/);
  assert.match(source, /data-map-zoom="reset"/);
  assert.doesNotMatch(source, /toggle-map-expanded|退出放大/);
  assert.match(mapSource, /addEventListener\("wheel"/);
  assert.match(mapSource, /addEventListener\("pointermove"/);
  assert.match(mapSource, /event\.target\.closest\?\.\("\[data-map-province\]"\)/);
  assert.match(mapSource, /preventDefault\(\)/);
  assert.match(css, /\.map-layout \{[^}]*align-items: start/);
  assert.match(css, /\.china-geo-map-host \{[^}]*aspect-ratio: 3 \/ 2/);
  assert.match(css, /\.china-geo-map-host\.is-zoomed/);
  assert.doesNotMatch(css, /\.china-geo-map-panel\.is-expanded/);
  assert.deepEqual(calculateZoomViewBox({ viewBox: { x: 0, y: 0, width: 960, height: 640 }, pointerX: .5, pointerY: .5, nextScale: 2, baseWidth: 960, baseHeight: 640 }), { x: 240, y: 160, width: 480, height: 320, scale: 2 });
});
