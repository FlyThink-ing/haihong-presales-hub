import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./security.js";

const OFFICIAL_HOST = "bzdt.tianditu.gov.cn";
const REVIEW_NUMBER_PATTERN = /^GS\(\d{4}\)\d{4,}号$/;
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function invalid(message) {
  return { status: "INVALID", message };
}

function validatedRegionAnchors(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const names = new Set();
  const anchors = [];
  for (const item of value) {
    const name = String(item?.name || "").trim();
    const xPercent = item?.xPercent;
    const yPercent = item?.yPercent;
    if (!name || name.length > 100 || names.has(name) || typeof xPercent !== "number" || typeof yPercent !== "number" || !Number.isFinite(xPercent) || !Number.isFinite(yPercent) || xPercent < 0 || xPercent > 100 || yPercent < 0 || yPercent > 100) return null;
    names.add(name);
    anchors.push({ name, xPercent, yPercent });
  }
  return anchors;
}

function hasExpectedImageSignature(buffer, extension) {
  if (extension === ".png") return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
}

export function validateMapResource(storagePath) {
  const mapDirectory = path.resolve(storagePath, "maps");
  const manifestPath = path.join(mapDirectory, "china-standard-map.json");
  if (!fs.existsSync(manifestPath)) {
    return { status: "MISSING", message: "尚未安装经确认的自然资源部标准地图离线资源" };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return invalid("中国标准地图清单不是有效 JSON");
  }
  if (!REVIEW_NUMBER_PATTERN.test(manifest.reviewNumber || "")) return invalid("地图清单缺少有效审图号");
  let source;
  try { source = new URL(manifest.sourceUrl); } catch { return invalid("地图来源地址无效"); }
  if (source.protocol !== "https:" || source.hostname !== OFFICIAL_HOST) return invalid("地图来源必须是自然资源部标准地图服务");
  if (manifest.preserveOriginal !== true || manifest.noCrop !== true || manifest.noBoundaryModification !== true) {
    return invalid("地图清单必须确认原样保存、不裁切且不修改边界");
  }
  const assetFile = String(manifest.assetFile || "");
  if (!assetFile || path.basename(assetFile) !== assetFile || !ALLOWED_EXTENSIONS.has(path.extname(assetFile).toLowerCase())) {
    return invalid("地图文件名无效，仅允许同目录 JPG 或 PNG 原图");
  }
  const assetPath = path.resolve(mapDirectory, assetFile);
  if (path.dirname(assetPath) !== mapDirectory || !fs.existsSync(assetPath)) return invalid("地图原图文件不存在");
  const assetBuffer = fs.readFileSync(assetPath);
  if (!hasExpectedImageSignature(assetBuffer, path.extname(assetFile).toLowerCase())) return invalid("地图原图内容与 PNG/JPEG 扩展名不一致或文件签名无效");
  const actualSha256 = sha256(assetBuffer);
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256 || "") || actualSha256 !== String(manifest.sha256).toLowerCase()) {
    return invalid("地图原图摘要与清单不一致，禁止加载");
  }
  const regionAnchors = validatedRegionAnchors(manifest.regionAnchors);
  if (!regionAnchors) return invalid("区域锚点必须是名称唯一且横纵坐标均为 0 至 100 的显式配置");
  return {
    status: "READY",
    message: "已加载经校验的中国标准地图原图",
    reviewNumber: manifest.reviewNumber,
    sourceUrl: manifest.sourceUrl,
    assetFile,
    sha256: actualSha256,
    regionAnchors,
    assetPath,
    assetBuffer
  };
}

export function publicMapResource(resource) {
  const { assetPath: _assetPath, assetBuffer: _assetBuffer, ...publicFields } = resource;
  return resource.status === "READY" ? { ...publicFields, assetUrl: `/api/map/basemap?expectedAssetSha256=${resource.sha256}` } : publicFields;
}

export const __test = { hasExpectedImageSignature, validatedRegionAnchors };

