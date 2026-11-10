import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "./security.js";

const BUNDLED_ASSET_PATH = fileURLToPath(new URL("../web/assets/china.json", import.meta.url));
const EXPECTED_PROVINCE_COUNT = 34;
const ALLOWED_GEOMETRIES = new Set(["Polygon", "MultiPolygon"]);
let cached;

function invalid(message) {
  return { status: "INVALID", message };
}

function walkCoordinates(value, visit) {
  if (!Array.isArray(value)) return false;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    if (!Number.isFinite(value[0]) || !Number.isFinite(value[1])) return false;
    visit(value[0], value[1]);
    return true;
  }
  return value.length > 0 && value.every(item => walkCoordinates(item, visit));
}

export function validateChinaGeoJsonResource(assetPath = BUNDLED_ASSET_PATH) {
  if (!fs.existsSync(assetPath)) return { status: "MISSING", message: "尚未安装中国省级行政区 GeoJSON 资源" };
  const stat = fs.statSync(assetPath);
  if (assetPath === BUNDLED_ASSET_PATH && cached?.mtimeMs === stat.mtimeMs && cached?.size === stat.size) return cached.value;
  let buffer;
  let collection;
  try {
    buffer = fs.readFileSync(assetPath);
    collection = JSON.parse(buffer.toString("utf8"));
  } catch {
    return invalid("中国省级行政区 GeoJSON 不是有效 JSON");
  }
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) return invalid("地图资源必须是 GeoJSON FeatureCollection");
  const provinceNames = new Set();
  let coordinateCount = 0;
  const bounds = { minLongitude: Infinity, minLatitude: Infinity, maxLongitude: -Infinity, maxLatitude: -Infinity };
  for (const feature of collection.features) {
    if (feature?.type !== "Feature" || !ALLOWED_GEOMETRIES.has(feature.geometry?.type)) return invalid("地图资源只允许 Polygon 或 MultiPolygon 要素");
    const valid = walkCoordinates(feature.geometry.coordinates, (longitude, latitude) => {
      coordinateCount += 1;
      bounds.minLongitude = Math.min(bounds.minLongitude, longitude);
      bounds.minLatitude = Math.min(bounds.minLatitude, latitude);
      bounds.maxLongitude = Math.max(bounds.maxLongitude, longitude);
      bounds.maxLatitude = Math.max(bounds.maxLatitude, latitude);
    });
    if (!valid) return invalid("地图资源包含无效坐标");
    const name = String(feature.properties?.name || "").trim();
    if (name) {
      if (provinceNames.has(name)) return invalid("地图资源包含重复省级行政区名称");
      provinceNames.add(name);
    }
  }
  if (provinceNames.size !== EXPECTED_PROVINCE_COUNT) return invalid(`地图资源应包含 ${EXPECTED_PROVINCE_COUNT} 个具名省级行政区`);
  if (coordinateCount < 1000 || bounds.minLongitude < 70 || bounds.maxLongitude > 140 || bounds.minLatitude < 0 || bounds.maxLatitude > 60) return invalid("地图资源坐标范围不符合中国区域数据的安全校验范围");
  const digest = sha256(buffer);
  const result = {
    status: "READY",
    message: "已加载用户提供的中国省级行政区 GeoJSON",
    assetUrl: `/assets/china.json?v=${digest.slice(0, 16)}`,
    sha256: digest,
    sourceType: "USER_PROVIDED",
    reviewNumber: null,
    sourceUrl: null,
    coordinateSystem: "UNDECLARED",
    provinceCount: provinceNames.size,
    featureCount: collection.features.length,
    coordinateCount,
    bounds
  };
  if (assetPath === BUNDLED_ASSET_PATH) cached = { mtimeMs: stat.mtimeMs, size: stat.size, value: result };
  return result;
}

export const __test = { walkCoordinates, BUNDLED_ASSET_PATH };
