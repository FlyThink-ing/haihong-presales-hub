import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { audit } from "../server/audit.js";
import { publicUser } from "../server/auth-service.js";
import { loadConfig } from "../server/config.js";
import { createProject, createFollowup } from "../server/customer-activity-service.js";
import { createCustomer } from "../server/customer-service.js";
import { createDatabase } from "../server/database.js";
import { AppError } from "../server/domain.js";

export const MAP_DEMO_DATASET_VERSION = "presales-map-v1";
const MAP_DEMO_MARKER = `DEMO_DATASET:${MAP_DEMO_DATASET_VERSION}`;
const MAP_DEMO_AUDIT_ACTION = "DEMO_MAP_DATA_SEEDED_V1";

const CUSTOMER_DEFINITIONS = [
  { owner: "demo_presales_north", name: "【地图演示】京北自动化设备有限公司", short: "地图演示-京北自动化", status: "初期接洽", province: "北京市", city: "北京市", district: "昌平区", longitude: 116.23, latitude: 40.22, industry: "自动化设备" },
  { owner: "demo_presales_north", name: "【地图演示】冀中汽车部件有限公司", short: "地图演示-冀中汽配", status: "现场调研", province: "河北省", city: "保定市", district: "莲池区", industry: "汽车零部件" },
  { owner: "demo_presales_east", name: "【地图演示】苏南光电科技有限公司", short: "地图演示-苏南光电", status: "现场调研", province: "江苏省", city: "苏州市", district: "吴中区", longitude: 120.63, latitude: 31.26, industry: "光电制造" },
  { owner: "demo_presales_east", name: "【地图演示】金陵制药装备有限公司", short: "地图演示-金陵制药装备", status: "方案&报价", province: "江苏省", city: "南京市", district: "江宁区", industry: "制药装备" },
  { owner: "demo_presales_east", name: "【地图演示】甬城精密工业有限公司", short: "地图演示-甬城精密", status: "初期接洽", province: "浙江省", city: "宁波市", district: "鄞州区", longitude: 121.55, latitude: 29.87, industry: "精密制造" },
  { owner: "demo_presales_central", name: "【地图演示】豫北电子制造有限公司", short: "地图演示-豫北电子", status: "现场调研", province: "河南省", city: "鹤壁市", district: "淇滨区", longitude: 114.3, latitude: 35.75, industry: "电子制造" },
  { owner: "demo_presales_central", name: "【地图演示】中原食品科技有限公司", short: "地图演示-中原食品", status: "方案&报价", province: "河南省", city: "郑州市", district: "高新区", industry: "食品制造" },
  { owner: "demo_presales_south", name: "【地图演示】珠江智能家电有限公司", short: "地图演示-珠江家电", status: "报价完成&商务洽谈", province: "广东省", city: "佛山市", district: "顺德区", longitude: 113.12, latitude: 23.02, industry: "家电制造" },
  { owner: "demo_presales_south", name: "【地图演示】鹏城医疗器械有限公司", short: "地图演示-鹏城医疗", status: "初期接洽", province: "广东省", city: "深圳市", district: "宝安区", industry: "医疗器械" },
  { owner: "demo_presales_southwest", name: "【地图演示】天府包装科技有限公司", short: "地图演示-天府包装", status: "现场调研", province: "四川省", city: "成都市", district: "双流区", longitude: 104.04, latitude: 30.57, industry: "包装印刷" }
];

function dateOnly(daysAgo) {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() - daysAgo);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function dateTime(daysAgo) {
  const value = new Date();
  value.setHours(10, 0, 0, 0);
  value.setDate(value.getDate() - daysAgo);
  return value.toISOString();
}

function readActiveUser(db, username, expectedRole) {
  const row = db.prepare(`SELECT id, username, display_name, role, manager_id, phone, regions_json, home_city, is_active, must_change_password FROM users WHERE username = ?`).get(username);
  if (!row || row.role !== expectedRole || !row.is_active) throw new AppError(409, "MAP_DEMO_ACCOUNT_REQUIRED", `缺少已启用的演示账号 ${username}`);
  return publicUser(row);
}

function summary(db) {
  const customers = db.prepare(`SELECT province, status FROM customers WHERE notes LIKE ? ORDER BY province, status`).all(`%${MAP_DEMO_MARKER}%`);
  return {
    version: MAP_DEMO_DATASET_VERSION,
    customers: customers.length,
    provinceCounts: db.prepare(`SELECT province, COUNT(*) AS count FROM customers WHERE notes LIKE ? GROUP BY province ORDER BY count DESC, province`).all(`%${MAP_DEMO_MARKER}%`),
    activeCustomers: customers.filter(customer => !["丢标", "中止"].includes(customer.status)).length
  };
}

export function seedMapDemoData({ db, admin }) {
  if (admin.role !== "ADMIN" || !admin.active) throw new AppError(403, "MAP_DEMO_ADMIN_REQUIRED", "只有已启用管理员可以写入地图演示数据");
  const completed = db.prepare(`SELECT 1 FROM audit_logs WHERE action = ? AND entity_type = 'SYSTEM' AND entity_id = ? LIMIT 1`).get(MAP_DEMO_AUDIT_ACTION, MAP_DEMO_DATASET_VERSION);
  if (completed) return { alreadySeeded: true, ...summary(db) };
  const partialCount = db.prepare(`SELECT COUNT(*) AS count FROM customers WHERE notes LIKE ?`).get(`%${MAP_DEMO_MARKER}%`).count;
  if (partialCount) throw new AppError(409, "MAP_DEMO_DATA_PARTIAL", "检测到未完成的地图演示数据批次；系统不会覆盖或重复补写，请从写入前备份恢复后重试");
  for (const [kind, value] of [["SOURCE", "演示-销售推荐"], ["TYPE", "演示-新客户"]]) {
    const option = db.prepare(`SELECT is_active FROM customer_dictionary_options WHERE kind = ? AND value = ?`).get(kind, value);
    if (!option?.is_active) throw new AppError(409, "MAP_DEMO_DICTIONARY_REQUIRED", `缺少已启用的演示字典项 ${value}`);
  }
  const owners = new Map([...new Set(CUSTOMER_DEFINITIONS.map(item => item.owner))].map(username => [username, readActiveUser(db, username, "PRESALES")]));
  CUSTOMER_DEFINITIONS.forEach((definition, index) => {
    const owner = owners.get(definition.owner);
    const customer = createCustomer(db, owner, {
      fullName: definition.name,
      shortName: definition.short,
      source: "演示-销售推荐",
      customerType: "演示-新客户",
      registeredOn: dateOnly(12 + index * 3),
      status: definition.status,
      needSummary: `地图聚合演示：计划了解 ${definition.industry} 场景下的 MES 需求，便于安排同区域集中拜访。`,
      industry: definition.industry,
      province: definition.province,
      city: definition.city,
      district: definition.district,
      address: "演示地址（非真实地址）",
      longitude: definition.longitude,
      latitude: definition.latitude,
      summary: "虚构客户，仅用于验证省份数量、阶段筛选和拜访清单。",
      notes: `【地图演示数据】${MAP_DEMO_MARKER}；禁止用于真实业务或对外发送。`
    });
    const project = createProject(db, owner, customer.id, { name: `${definition.short} MES 项目（地图演示）`, summary: "用于地图聚合和出差拜访清单演示。" });
    createFollowup(db, owner, customer.id, {
      projectId: project.id,
      method: index % 3 === 0 ? "ONSITE" : index % 3 === 1 ? "PHONE" : "WECHAT",
      occurredAt: dateTime(2 + index * 2),
      participants: [owner.displayName],
      content: "【地图演示跟进】已完成一次虚构沟通，用于展示最近跟进排序。",
      customerFeedback: "演示反馈，不代表真实客户意见。",
      nextAction: "出差前确认拜访价值、参与人员和沟通目标。"
    });
  });
  audit(db, { actorId: admin.id, action: MAP_DEMO_AUDIT_ACTION, entityType: "SYSTEM", entityId: MAP_DEMO_DATASET_VERSION, summary: { marker: MAP_DEMO_MARKER, customers: CUSTOMER_DEFINITIONS.map(item => item.name), warning: "全部为虚构地图演示数据" } });
  return { alreadySeeded: false, ...summary(db) };
}

function option(argv, name, fallback = undefined) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export function main(argv = process.argv.slice(2)) {
  if (!argv.includes("--confirm-map-demo-data")) throw new AppError(400, "MAP_DEMO_CONFIRMATION_REQUIRED", "必须显式传入 --confirm-map-demo-data；该命令会写入虚构地图演示客户");
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  try {
    const admin = readActiveUser(db, option(argv, "--admin", "admin"), "ADMIN");
    const result = seedMapDemoData({ db, admin });
    console.log(result.alreadySeeded ? "地图演示数据已存在，本次未重复写入。" : "地图演示数据写入完成。");
    console.log(JSON.stringify(result, null, 2));
  } finally { db.close(); }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  try { main(); }
  catch (error) {
    console.error(`地图演示数据写入失败 [${error.code || error.name || "UNKNOWN"}]：${error.message}`);
    process.exitCode = 1;
  }
}

export const __test = { CUSTOMER_DEFINITIONS, MAP_DEMO_MARKER };
