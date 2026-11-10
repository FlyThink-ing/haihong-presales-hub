import { CUSTOMER_STATUSES, ROLES } from "./domain.js";
import { listMapCustomers } from "./customer-service.js";
import { publicMapResource, validateMapResource } from "./map-resource.js";
import { validateChinaGeoJsonResource } from "./china-geojson-resource.js";
import { managedUserIds } from "./permissions.js";

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "zh-CN"));
}

function parseRegions(value) {
  try {
    const result = JSON.parse(value || "[]");
    return Array.isArray(result) ? result.map(item => String(item).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function customerInRegion(customer, region) {
  const value = String(region || "").trim();
  if (!value) return true;
  return [customer.province, customer.city, customer.district].some(item => String(item || "").includes(value));
}

function canEditPoint(actor, customer) {
  return actor.role === ROLES.ADMIN || (actor.role === ROLES.PRESALES && customer.owner.id === actor.id);
}

function visibilityScope(actor) {
  if (actor.role === ROLES.ADMIN) return { code: "ALL", label: "全部客户", description: "管理员可查看全部售前客户分布" };
  if (actor.role === ROLES.MANAGER) return { code: "DIRECT_REPORTS", label: "直属团队", description: "仅展示直属售前负责的客户" };
  if (actor.role === ROLES.VP) return { code: "QUOTE_APPROVAL", label: "终审相关", description: "仅展示待终审或已终审报价关联客户" };
  return { code: "OWN", label: "我的客户", description: "仅展示本人当前负责的客户" };
}

function vpQuoteTarget(db, customerId) {
  const row = db.prepare(`
    SELECT qv.id FROM quote_versions qv JOIN quotes q ON q.id = qv.quote_id
    WHERE q.customer_id = ? AND (qv.status = 'APPROVED' OR (qv.status = 'PENDING_VP' AND COALESCE(qv.approval_stage, 'VP') = 'VP'))
    ORDER BY CASE qv.status WHEN 'PENDING_VP' THEN 0 ELSE 1 END, qv.created_at DESC, qv.rowid DESC LIMIT 1
  `).get(customerId);
  return row ? { type: "QUOTE_VERSION", id: row.id } : null;
}

function customerMapView(db, actor, customer, resource) {
  const storedPoint = customer.mapPoint;
  const pointMatchesCurrentMap = resource.status === "READY" && storedPoint?.assetSha256 === resource.sha256;
  return {
    id: customer.id,
    name: customer.fullName,
    status: customer.status,
    owner: customer.owner,
    province: customer.province,
    city: customer.city,
    district: customer.district,
    region: [customer.province, customer.city, customer.district].filter(Boolean).join(" · ") || "未配置区域",
    address: customer.address,
    coordinates: Number.isFinite(customer.longitude) && Number.isFinite(customer.latitude) ? { longitude: customer.longitude, latitude: customer.latitude } : null,
    lastFollowupAt: customer.lastFollowupAt,
    mapPosition: pointMatchesCurrentMap ? { xPercent: storedPoint.xPercent, yPercent: storedPoint.yPercent } : null,
    mapPointStatus: pointMatchesCurrentMap ? "CURRENT" : storedPoint ? "RECONFIRM_REQUIRED" : "UNSET",
    canEditPoint: canEditPoint(actor, customer),
    detailTarget: actor.role === ROLES.VP ? vpQuoteTarget(db, customer.id) : { type: "CUSTOMER", id: customer.id }
  };
}

export function getMapOverview(db, storagePath, actor, filters = {}) {
  const resource = validateMapResource(storagePath);
  const scopeCustomers = listMapCustomers(db, actor, {}, { limit: 5000 });
  const customers = listMapCustomers(db, actor, filters, { limit: 5000 });
  const visibleOwnerIds = actor.role === ROLES.VP ? unique(scopeCustomers.map(customer => customer.owner.id)) : managedUserIds(db, actor);
  const users = visibleOwnerIds.length ? db.prepare(`
    SELECT id, display_name, regions_json FROM users
    WHERE id IN (${visibleOwnerIds.map(() => "?").join(",")}) ${actor.role === ROLES.VP ? "" : "AND role = 'PRESALES' AND is_active = 1"} ORDER BY display_name
  `).all(...visibleOwnerIds) : [];
  const ownerFilter = String(filters.ownerId || "").trim();
  const regionFilter = String(filters.region || "").trim();
  const anchorByName = new Map((resource.status === "READY" ? resource.regionAnchors : []).map(anchor => [anchor.name, anchor]));
  const representatives = users.filter(user => !ownerFilter || user.id === ownerFilter).map(user => {
    const regions = parseRegions(user.regions_json);
    const filteredRegions = regionFilter ? regions.filter(region => region.includes(regionFilter) || regionFilter.includes(region)) : regions;
    return {
      id: user.id,
      displayName: user.display_name,
      regions: filteredRegions,
      customerCount: customers.filter(customer => customer.owner.id === user.id).length,
      regionSummaries: filteredRegions.map(region => ({
        name: region,
        anchor: anchorByName.get(region) || null,
        customerCount: customers.filter(customer => customer.owner.id === user.id && customerInRegion(customer, region)).length
      }))
    };
  }).filter(user => !regionFilter || user.customerCount > 0 || user.regions.length > 0);
  const views = customers.map(customer => customerMapView(db, actor, customer, resource));
  return {
    offlineBasemap: publicMapResource(resource),
    provinceMap: validateChinaGeoJsonResource(),
    visibilityScope: visibilityScope(actor),
    representatives,
    customerPoints: views.filter(customer => customer.mapPointStatus === "CURRENT"),
    unlocatedCustomers: views.filter(customer => customer.mapPointStatus !== "CURRENT"),
    filterOptions: {
      owners: users.map(user => ({ id: user.id, displayName: user.display_name })),
      statuses: CUSTOMER_STATUSES,
      regions: unique([
        ...scopeCustomers.flatMap(customer => [customer.province, customer.city, customer.district]),
        ...users.flatMap(user => parseRegions(user.regions_json))
      ])
    }
  };
}

export const __test = { customerInRegion, parseRegions, visibilityScope };
