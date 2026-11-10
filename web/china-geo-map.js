const SVG_NS = "http://www.w3.org/2000/svg";
const OWNER_COLORS = ["#2d6da3", "#2e8a67", "#8a5ba7", "#c76c35", "#5578b8", "#b3535d", "#4b8791", "#8b7443"];
const DEFAULT_FILL = "#e8eef4";
const COUNT_FILLS = ["#e8eef4", "#d9ebfb", "#9fcdf2", "#5a9fd4", "#22669e"];
const INACTIVE_STATUSES = new Set(["丢标", "中止"]);

export function normalizeProvinceName(value) {
  return String(value || "").trim().replace(/特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|省|市$/g, "");
}

function visitPositions(value, visit) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
    visit(value[0], value[1]);
    return;
  }
  for (const item of value) visitPositions(item, visit);
}

export function createGeoProjection(collection, width = 960, height = 640, padding = 24) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const feature of collection?.features || []) visitPositions(feature.geometry?.coordinates, (x, y) => {
    bounds.minX = Math.min(bounds.minX, x); bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x); bounds.maxY = Math.max(bounds.maxY, y);
  });
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite) || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) throw new Error("地图坐标范围无效");
  const scale = Math.min((width - padding * 2) / (bounds.maxX - bounds.minX), (height - padding * 2) / (bounds.maxY - bounds.minY));
  const usedWidth = (bounds.maxX - bounds.minX) * scale;
  const usedHeight = (bounds.maxY - bounds.minY) * scale;
  const offsetX = (width - usedWidth) / 2;
  const offsetY = (height - usedHeight) / 2;
  return {
    width, height, bounds,
    project(longitude, latitude) {
      return { x: offsetX + (longitude - bounds.minX) * scale, y: offsetY + (bounds.maxY - latitude) * scale };
    }
  };
}

function ringPath(ring, project) {
  return ring.map((position, index) => {
    const point = project(position[0], position[1]);
    return `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  }).join(" ") + " Z";
}

export function geometryPath(geometry, project) {
  const polygons = geometry?.type === "Polygon" ? [geometry.coordinates] : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
  return polygons.flatMap(polygon => polygon.map(ring => ringPath(ring, project))).join(" ");
}

function geometryCenter(feature) {
  for (const candidate of [feature?.properties?.centroid, feature?.properties?.center]) {
    if (Array.isArray(candidate) && Number.isFinite(candidate[0]) && Number.isFinite(candidate[1])) return candidate;
  }
  const values = [];
  visitPositions(feature?.geometry?.coordinates, (x, y) => values.push([x, y]));
  if (!values.length) return null;
  const xs = values.map(item => item[0]);
  const ys = values.map(item => item[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

function matchingAssignment(provinceName, representatives) {
  const normalized = normalizeProvinceName(provinceName);
  for (const representative of representatives || []) {
    for (const region of representative.regionSummaries || []) {
      const candidate = normalizeProvinceName(region.name);
      if (candidate && (candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate))) return { ownerId: representative.id, ownerName: representative.displayName, regionName: region.name };
    }
  }
  return null;
}

function ownerPalette(representatives) {
  return new Map((representatives || []).map((representative, index) => [representative.id, OWNER_COLORS[index % OWNER_COLORS.length]]));
}

function customerCountFill(count, maximum) {
  if (!count) return DEFAULT_FILL;
  if (maximum <= 1) return COUNT_FILLS[2];
  const level = Math.max(1, Math.min(4, Math.ceil((count / maximum) * 4)));
  return COUNT_FILLS[level];
}

export function summarizeCustomersByProvince(customers = []) {
  const groups = new Map();
  for (const customer of customers) {
    const name = String(customer.province || "").trim();
    const key = normalizeProvinceName(name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, name, customers: [], customerCount: 0, activeCount: 0, statusCounts: {} });
    const group = groups.get(key);
    group.customers.push(customer);
    group.customerCount += 1;
    if (!INACTIVE_STATUSES.has(customer.status)) group.activeCount += 1;
    group.statusCounts[customer.status] = (group.statusCounts[customer.status] || 0) + 1;
  }
  return [...groups.values()].sort((left, right) => right.customerCount - left.customerCount || right.activeCount - left.activeCount || left.name.localeCompare(right.name, "zh-CN"));
}

export function buildChinaMapModel(collection, customers = [], representatives = []) {
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) throw new Error("地图文件格式无效");
  const projection = createGeoProjection(collection);
  const colors = ownerPalette(representatives);
  const provinceByName = new Map();
  const regions = collection.features.map((feature, index) => {
    const name = String(feature.properties?.name || "").trim();
    const assignment = name ? matchingAssignment(name, representatives) : null;
    const center = geometryCenter(feature);
    const model = {
      id: String(feature.properties?.adcode || `feature-${index}`), name, assignment,
      path: geometryPath(feature.geometry, projection.project),
      fill: name ? DEFAULT_FILL : "none",
      center: center ? projection.project(center[0], center[1]) : null,
      isSupplementary: !name,
      customers: [], customerCount: 0, activeCount: 0, statusCounts: {}
    };
    if (name) provinceByName.set(normalizeProvinceName(name), { feature, model, center });
    return model;
  });
  const provinceCounts = new Map();
  const points = [];
  const unplaced = [];
  for (const customer of customers) {
    const longitude = Number(customer.coordinates?.longitude);
    const latitude = Number(customer.coordinates?.latitude);
    let rawPosition;
    let positionType;
    const provinceEntry = provinceByName.get(normalizeProvinceName(customer.province));
    if (Number.isFinite(longitude) && Number.isFinite(latitude) && longitude >= projection.bounds.minX && longitude <= projection.bounds.maxX && latitude >= projection.bounds.minY && latitude <= projection.bounds.maxY) {
      rawPosition = [longitude, latitude];
      positionType = "EXACT";
    } else {
      rawPosition = provinceEntry?.center;
      positionType = "PROVINCE_CENTER";
    }
    if (!rawPosition) { unplaced.push(customer); continue; }
    if (provinceEntry) provinceEntry.model.customers.push(customer);
    const base = projection.project(rawPosition[0], rawPosition[1]);
    const provinceKey = normalizeProvinceName(customer.province) || "exact";
    const sequence = provinceCounts.get(provinceKey) || 0;
    provinceCounts.set(provinceKey, sequence + 1);
    const radius = positionType === "PROVINCE_CENTER" && sequence ? 8 + Math.floor(sequence / 8) * 5 : 0;
    const angle = sequence * 2.399963229728653;
    points.push({
      customer, positionType,
      x: base.x + Math.cos(angle) * radius,
      y: base.y + Math.sin(angle) * radius,
      color: colors.get(customer.owner?.id) || "#c2413a"
    });
  }
  const maximumProvinceCount = Math.max(0, ...regions.map(region => region.customers.length));
  for (const region of regions) {
    region.customerCount = region.customers.length;
    region.activeCount = region.customers.filter(customer => !INACTIVE_STATUSES.has(customer.status)).length;
    region.statusCounts = Object.fromEntries(region.customers.reduce((counts, customer) => counts.set(customer.status, (counts.get(customer.status) || 0) + 1), new Map()));
    if (!region.isSupplementary) region.fill = customerCountFill(region.customerCount, maximumProvinceCount);
  }
  return { projection, regions, points, unplaced, colors, maximumProvinceCount };
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

export function calculateZoomViewBox({ viewBox, pointerX, pointerY, nextScale, baseWidth, baseHeight }) {
  const scale = Math.max(1, Math.min(3, nextScale));
  const width = baseWidth / scale;
  const height = baseHeight / scale;
  const anchorX = viewBox.x + pointerX * viewBox.width;
  const anchorY = viewBox.y + pointerY * viewBox.height;
  return {
    x: Math.max(0, Math.min(baseWidth - width, anchorX - pointerX * width)),
    y: Math.max(0, Math.min(baseHeight - height, anchorY - pointerY * height)),
    width,
    height,
    scale
  };
}

function enableMapViewport(container, svg, width, height, onZoomChange) {
  let viewBox = { x: 0, y: 0, width, height, scale: 1 };
  let drag = null;
  const apply = () => {
    svg.setAttribute("viewBox", `${viewBox.x.toFixed(2)} ${viewBox.y.toFixed(2)} ${viewBox.width.toFixed(2)} ${viewBox.height.toFixed(2)}`);
    container.classList.toggle("is-zoomed", viewBox.scale > 1);
    onZoomChange?.(viewBox.scale);
  };
  const zoomTo = (nextScale, pointerX = .5, pointerY = .5) => {
    const next = calculateZoomViewBox({ viewBox, pointerX, pointerY, nextScale, baseWidth: width, baseHeight: height });
    if (next.scale === viewBox.scale) return false;
    viewBox = next;
    apply();
    return true;
  };
  container.addEventListener("wheel", event => {
    const rect = container.getBoundingClientRect();
    const changed = zoomTo(viewBox.scale + (event.deltaY < 0 ? .25 : -.25), Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)));
    if (changed) event.preventDefault();
  }, { passive: false });
  container.addEventListener("pointerdown", event => {
    if (event.button !== 0 || viewBox.scale <= 1 || event.target.closest?.("[data-map-province]")) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    container.setPointerCapture?.(event.pointerId);
    container.classList.add("is-dragging");
  });
  container.addEventListener("pointermove", event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = container.getBoundingClientRect();
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    drag.x = event.clientX; drag.y = event.clientY;
    viewBox = {
      ...viewBox,
      x: Math.max(0, Math.min(width - viewBox.width, viewBox.x - dx * (viewBox.width / rect.width))),
      y: Math.max(0, Math.min(height - viewBox.height, viewBox.y - dy * (viewBox.height / rect.height)))
    };
    apply();
  });
  const stopDragging = event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    container.releasePointerCapture?.(event.pointerId);
    container.classList.remove("is-dragging");
  };
  container.addEventListener("pointerup", stopDragging);
  container.addEventListener("pointercancel", stopDragging);
  apply();
  return {
    zoomIn: () => zoomTo(viewBox.scale + .25),
    zoomOut: () => zoomTo(viewBox.scale - .25),
    reset: () => { viewBox = { x: 0, y: 0, width, height, scale: 1 }; apply(); },
    getScale: () => viewBox.scale
  };
}

export function renderChinaGeoMap(container, collection, options = {}) {
  const model = buildChinaMapModel(collection, options.customers, options.representatives);
  container.replaceChildren();
  const svg = svgElement("svg", { viewBox: `0 0 ${model.projection.width} ${model.projection.height}`, role: "img", "aria-label": "中国省级行政区客户业务分布示意图" });
  const title = svgElement("title");
  title.textContent = "中国省级行政区客户业务分布示意图";
  svg.append(title);
  const regionsLayer = svgElement("g", { class: "china-map-regions" });
  for (const region of model.regions) {
    const path = svgElement("path", { d: region.path, class: region.isSupplementary ? "china-map-supplementary" : "china-map-province", fill: region.fill, "fill-rule": "evenodd" });
    if (region.name) {
      const description = svgElement("title");
      description.textContent = `${region.name} · ${region.customerCount} 家可见客户${region.assignment ? ` · ${region.assignment.ownerName}负责` : ""}`;
      path.append(description);
      if (region.customerCount) {
        path.dataset.mapProvince = region.name;
        path.setAttribute("tabindex", "0"); path.setAttribute("role", "button");
      }
    }
    regionsLayer.append(path);
  }
  svg.append(regionsLayer);
  const labelsLayer = svgElement("g", { class: "china-map-province-labels", "aria-label": "各省名称及客户数量" });
  const labelOffsets = { 北京市: [38, -22], 天津市: [44, 18], 上海市: [38, 5], 江苏省: [26, -16], 浙江省: [30, 15], 香港特别行政区: [34, 12], 澳门特别行政区: [-32, 15] };
  for (const region of model.regions.filter(item => item.name && item.customerCount && item.center)) {
    const [offsetX, offsetY] = labelOffsets[region.name] || [0, 0];
    const shortName = normalizeProvinceName(region.name);
    const labelText = `${shortName} · ${region.customerCount}`;
    const labelWidth = Math.max(54, labelText.length * 10 + 14);
    const group = svgElement("g", { class: "china-map-province-label", transform: `translate(${(region.center.x + offsetX).toFixed(2)} ${(region.center.y + offsetY).toFixed(2)})`, tabindex: "0", role: "button", "aria-label": `${region.name}，${region.customerCount} 家客户` });
    group.dataset.mapProvince = region.name;
    const background = svgElement("rect", { x: (-labelWidth / 2).toFixed(1), y: "-13", width: labelWidth, height: "26", rx: "8", class: "china-map-label-background" });
    const text = svgElement("text", { y: "4", "text-anchor": "middle", class: "china-map-label-text" });
    const name = svgElement("tspan");
    name.textContent = shortName;
    const separator = svgElement("tspan", { class: "china-map-label-separator" });
    separator.textContent = " · ";
    const count = svgElement("tspan", { class: "china-map-label-count" });
    count.textContent = String(region.customerCount);
    text.append(name, separator, count);
    const description = svgElement("title");
    description.textContent = `${region.name} · ${region.customerCount} 家客户 · 其中推进中 ${region.activeCount} 家`;
    group.append(background, text, description);
    labelsLayer.append(group);
  }
  svg.append(labelsLayer);
  container.append(svg);
  container.mapViewport = enableMapViewport(container, svg, model.projection.width, model.projection.height, options.onZoomChange);
  container.addEventListener("keydown", event => {
    if (!["Enter", " "].includes(event.key)) return;
    const target = event.target.closest?.("[data-map-province]");
    if (!target) return;
    event.preventDefault(); target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return model;
}

export const __test = { customerCountFill, geometryCenter, matchingAssignment };
