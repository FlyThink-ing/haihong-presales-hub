import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { audit } from "../server/audit.js";
import { createUser, publicUser } from "../server/auth-service.js";
import { loadConfig } from "../server/config.js";
import { createDatabase, nowIso } from "../server/database.js";
import { AppError } from "../server/domain.js";
import { calculateQuoteItems, createQuote, decideQuote, submitQuote } from "../server/quote-service.js";

export const TEST_ROSTER_VERSION = "provided-roster-v1";
const TEST_ROSTER_MARKER = `TEST_ROSTER:${TEST_ROSTER_VERSION}`;
const DEMO_ACCOUNT_MAPPING = [
  ["demo_presales_north", "PRESALES", 0],
  ["demo_presales_east", "PRESALES", 1],
  ["demo_presales_central", "PRESALES", 2],
  ["demo_presales_south", "PRESALES", 3],
  ["demo_presales_southwest", "PRESALES", 4],
  ["demo_manager", "RND_MANAGER", 0],
  ["demo_general_manager", "GENERAL_MANAGER", 0],
  ["demo_vp", "VP", 0]
];

const ROLE_LABELS = {
  "售前顾问": { role: "PRESALES", positionCode: null, kind: "PRESALES" },
  "研发部经理": { role: "MANAGER", positionCode: "RND_MANAGER", kind: "RND_MANAGER" },
  "综合部经理": { role: "MANAGER", positionCode: "GENERAL_MANAGER", kind: "GENERAL_MANAGER" },
  "副总经理": { role: "VP", positionCode: null, kind: "VP" },
  "系统管理员": { role: "ADMIN", positionCode: null, kind: "ADMIN" }
};

function ensure(condition, code, message) {
  if (!condition) throw new AppError(400, code, message);
}

function normalizeRoster(input) {
  ensure(Array.isArray(input), "TEST_ROSTER_INVALID", "人员名单必须是数组");
  const seen = new Set();
  const roster = input.map((item, index) => {
    const username = String(item?.username || "").trim();
    const displayName = String(item?.displayName || "").trim();
    const roleLabel = String(item?.roleLabel || "").trim();
    const phone = String(item?.phone || "").trim();
    const email = String(item?.email || "").trim().toLowerCase();
    const mapped = ROLE_LABELS[roleLabel];
    ensure(/^[a-z][a-z0-9._-]{2,49}$/i.test(username), "TEST_ROSTER_USERNAME_INVALID", `第 ${index + 1} 行用户名无效`);
    ensure(displayName, "TEST_ROSTER_NAME_REQUIRED", `第 ${index + 1} 行姓名不能为空`);
    ensure(mapped, "TEST_ROSTER_ROLE_INVALID", `第 ${index + 1} 行角色不受支持`);
    ensure(phone.length >= 5 && phone.length <= 30, "TEST_ROSTER_PHONE_INVALID", `第 ${index + 1} 行手机号码无效`);
    ensure(email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), "TEST_ROSTER_EMAIL_INVALID", `第 ${index + 1} 行邮箱无效`);
    ensure(!seen.has(username.toLowerCase()), "TEST_ROSTER_USERNAME_DUPLICATE", "人员名单存在重复用户名");
    seen.add(username.toLowerCase());
    return { ...item, ...mapped, username, displayName, roleLabel, phone, email, order: index };
  });
  ensure(roster.filter(item => item.kind === "PRESALES").length === 5, "TEST_ROSTER_PRESALES_COUNT", "测试名单必须包含 5 名售前顾问");
  for (const kind of ["RND_MANAGER", "GENERAL_MANAGER", "VP", "ADMIN"]) {
    ensure(roster.filter(item => item.kind === kind).length === 1, "TEST_ROSTER_ROLE_COUNT", `测试名单必须且只能包含 1 名 ${kind}`);
  }
  return roster;
}

function generatedPassword() {
  return `${randomBytes(24).toString("base64url")}aA1!`;
}

function readUser(db, username) {
  return db.prepare(`SELECT id, username, display_name, role, manager_id, position_code, phone, email, regions_json, home_city, is_active, must_change_password FROM users WHERE username = ?`).get(username);
}

function upsertRosterUser(db, actor, item, managerId) {
  const existing = readUser(db, item.username);
  if (!existing) {
    const created = createUser(db, {
      username: item.username,
      displayName: item.displayName,
      role: item.role,
      positionCode: item.positionCode,
      managerId: item.role === "PRESALES" ? managerId : null,
      phone: item.phone,
      email: item.email,
      regions: [],
      homeCity: null,
      password: generatedPassword()
    }, actor.id);
    if (created.role !== "ADMIN") db.prepare(`UPDATE users SET must_change_password = 1 WHERE id = ?`).run(created.id);
    return publicUser(readUser(db, item.username));
  }

  const nextManagerId = item.role === "PRESALES" ? managerId : null;
  db.prepare(`
    UPDATE users
    SET display_name = ?, role = ?, manager_id = ?, position_code = ?, phone = ?, email = ?,
        regions_json = '[]', home_city = NULL, is_active = 1,
        must_change_password = CASE WHEN role = 'ADMIN' AND ? = 'ADMIN' THEN must_change_password ELSE 1 END
    WHERE id = ?
  `).run(item.displayName, item.role, nextManagerId, item.positionCode, item.phone, item.email, item.role, existing.id);
  if (existing.role !== item.role || existing.manager_id !== nextManagerId) {
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(existing.id);
  }
  audit(db, {
    actorId: actor.id,
    action: "TEST_ROSTER_USER_SYNCED",
    entityType: "USER",
    entityId: existing.id,
    summary: { role: item.role, positionCode: item.positionCode, managerId: nextManagerId }
  });
  return publicUser(readUser(db, item.username));
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function userReferenceColumns(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  const references = [];
  for (const { name } of tables) {
    if (name === "user_manager_history") continue;
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all();
    for (const foreignKey of foreignKeys) {
      if (foreignKey.table === "users" && foreignKey.to === "id") references.push({ table: name, column: foreignKey.from });
    }
  }
  return references;
}

function reassignDemoReferences(db, accounts) {
  const byKind = new Map();
  for (const account of accounts) {
    const items = byKind.get(account.kind) || [];
    items.push(account);
    byKind.set(account.kind, items);
  }
  const references = userReferenceColumns(db);
  let changedReferences = 0;
  for (const [demoUsername, kind, index] of DEMO_ACCOUNT_MAPPING) {
    const demo = readUser(db, demoUsername);
    const target = byKind.get(kind)?.[index];
    if (!demo || !target) continue;
    for (const reference of references) {
      const result = db.prepare(`UPDATE ${quoteIdentifier(reference.table)} SET ${quoteIdentifier(reference.column)} = ? WHERE ${quoteIdentifier(reference.column)} = ?`).run(target.id, demo.id);
      changedReferences += result.changes;
    }
    db.prepare(`UPDATE users SET is_active = 0, manager_id = NULL WHERE id = ?`).run(demo.id);
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(demo.id);
  }
  return changedReferences;
}

function rosterQuoteInput(actor, customer, project, quoteNumber, index) {
  const items = [{
    category: "软件产品",
    itemName: `MES 测试流程模块 ${index}`,
    subitemName: "仅用于测试三级报价审批",
    unit: "套",
    quantityMilli: 1000,
    untaxedUnitPriceCents: 1_000_000 + index * 100_000,
    taxRateBps: 1300,
    notes: "测试数据，禁止对外发送"
  }];
  const calculated = calculateQuoteItems(items);
  return {
    quoteNumber,
    customerId: customer.id,
    projectId: project.id,
    notes: "【测试流程】按当前正式人员关系生成，禁止对外发送。",
    metadata: {
      customerName: customer.full_name,
      customerContactName: "演示客户联系人",
      customerPhone: "000-0000-0000",
      customerContactSource: "CUSTOMER_MANUAL",
      sellerName: actor.displayName,
      sellerPhone: actor.phone,
      sellerEmail: actor.email
    },
    finalDiscountCents: calculated.subtotalTaxedCents,
    items
  };
}

function seedRosterQuoteFlow(db, accounts) {
  const prefix = "TEST-ROSTER-Q-";
  const existing = db.prepare(`SELECT COUNT(*) AS count FROM quotes WHERE quote_number LIKE ?`).get(`${prefix}%`).count;
  if (existing === 6) return existing;
  ensure(existing === 0, "TEST_ROSTER_FLOW_PARTIAL", "检测到不完整的人员名单测试报价，系统不会自动覆盖");
  const sales = accounts.filter(item => item.kind === "PRESALES");
  const researchManager = accounts.find(item => item.kind === "RND_MANAGER");
  const generalManager = accounts.find(item => item.kind === "GENERAL_MANAGER");
  const vicePresident = accounts.find(item => item.kind === "VP");
  const records = sales.map(actor => {
    const customer = db.prepare(`SELECT id, full_name FROM customers WHERE owner_id = ? AND notes LIKE '%DEMO_DATASET:presales-business-flow-v1%' ORDER BY created_at LIMIT 1`).get(actor.id);
    ensure(customer, "TEST_ROSTER_CUSTOMER_REQUIRED", "每名售前至少需要一个已映射的演示客户");
    const project = db.prepare(`SELECT id FROM projects WHERE customer_id = ? ORDER BY created_at LIMIT 1`).get(customer.id);
    ensure(project, "TEST_ROSTER_PROJECT_REQUIRED", "演示客户缺少可用于报价的测试项目");
    return { actor, customer, project };
  });
  const make = (record, number) => createQuote(db, record.actor, rosterQuoteInput(record.actor, record.customer, record.project, `${prefix}${String(number).padStart(3, "0")}`, number));

  make(records[0], 1);
  const pendingResearch = make(records[1], 2);
  submitQuote(db, records[1].actor, pendingResearch.id);

  const pendingGeneral = make(records[2], 3);
  submitQuote(db, records[2].actor, pendingGeneral.id);
  decideQuote(db, researchManager, pendingGeneral.id, { decision: "APPROVED", comment: "测试流程：研发经理一级审核通过。" });

  const pendingVicePresident = make(records[3], 4);
  submitQuote(db, records[3].actor, pendingVicePresident.id);
  decideQuote(db, researchManager, pendingVicePresident.id, { decision: "APPROVED", comment: "测试流程：研发经理一级审核通过。" });
  decideQuote(db, generalManager, pendingVicePresident.id, { decision: "APPROVED", comment: "测试流程：综合部经理二级审核通过。" });

  const approved = make(records[4], 5);
  submitQuote(db, records[4].actor, approved.id);
  decideQuote(db, researchManager, approved.id, { decision: "APPROVED", comment: "测试流程：研发经理一级审核通过。" });
  decideQuote(db, generalManager, approved.id, { decision: "APPROVED", comment: "测试流程：综合部经理二级审核通过。" });
  decideQuote(db, vicePresident, approved.id, { decision: "APPROVED", comment: "测试流程：副总经理终审通过。" });

  const returned = make(records[0], 6);
  submitQuote(db, records[0].actor, returned.id);
  decideQuote(db, researchManager, returned.id, { decision: "APPROVED", comment: "测试流程：研发经理一级审核通过。" });
  decideQuote(db, generalManager, returned.id, { decision: "REJECTED", comment: "测试退回：请重新核对优惠依据和实施范围。" });
  return 6;
}

function resultSummary(db, accounts, changedReferences, rosterFlowQuotes) {
  const accountIds = accounts.map(item => item.id);
  const placeholders = accountIds.map(() => "?").join(",");
  return {
    version: TEST_ROSTER_VERSION,
    activeRosterAccounts: db.prepare(`SELECT COUNT(*) AS count FROM users WHERE id IN (${placeholders}) AND is_active = 1`).get(...accountIds).count,
    inactiveDemoAccounts: db.prepare(`SELECT COUNT(*) AS count FROM users WHERE username LIKE 'demo_%' AND is_active = 0`).get().count,
    demoCustomersOwnedByRoster: db.prepare(`SELECT COUNT(*) AS count FROM customers WHERE notes LIKE '%DEMO_DATASET:presales-business-flow-v1%' AND owner_id IN (${placeholders})`).get(...accountIds).count,
    demoQuoteVersions: db.prepare(`SELECT COUNT(*) AS count FROM quote_versions qv JOIN quotes q ON q.id = qv.quote_id JOIN customers c ON c.id = q.customer_id WHERE c.notes LIKE '%DEMO_DATASET:presales-business-flow-v1%'`).get().count,
    rosterFlowQuotes,
    changedReferences
  };
}

export function applyTestRoster({ db, input, adminUsername = "admin", seedFlow = false }) {
  const roster = normalizeRoster(input);
  const existingAdmin = readUser(db, adminUsername);
  ensure(existingAdmin?.role === "ADMIN" && existingAdmin.is_active, "TEST_ROSTER_ADMIN_INVALID", "指定管理员账号不存在、未启用或角色不正确");
  const actor = publicUser(existingAdmin);
  const managerDefinition = roster.find(item => item.kind === "GENERAL_MANAGER");
  const ordered = [
    managerDefinition,
    roster.find(item => item.kind === "RND_MANAGER"),
    roster.find(item => item.kind === "VP"),
    roster.find(item => item.kind === "ADMIN"),
    ...roster.filter(item => item.kind === "PRESALES").sort((a, b) => a.order - b.order)
  ];

  return db.transaction(() => {
    const accounts = [];
    let managerId = null;
    for (const definition of ordered) {
      const account = upsertRosterUser(db, actor, definition, managerId);
      accounts.push({ ...account, kind: definition.kind });
      if (definition.kind === "GENERAL_MANAGER") managerId = account.id;
    }
    const changedReferences = reassignDemoReferences(db, accounts);
    const alreadyRecorded = db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'TEST_ROSTER_APPLIED' AND entity_id = ?`).get(TEST_ROSTER_VERSION);
    if (!alreadyRecorded) {
      audit(db, {
        actorId: actor.id,
        action: "TEST_ROSTER_APPLIED",
        entityType: "SYSTEM",
        entityId: TEST_ROSTER_VERSION,
        summary: {
          marker: TEST_ROSTER_MARKER,
          usernames: roster.map(item => item.username),
          roles: roster.map(item => item.roleLabel),
          phonesOrEmailsLogged: false,
          appliedAt: nowIso()
        }
      });
    }
    const rosterFlowQuotes = seedFlow ? seedRosterQuoteFlow(db, accounts) : db.prepare(`SELECT COUNT(*) AS count FROM quotes WHERE quote_number LIKE 'TEST-ROSTER-Q-%'`).get().count;
    return resultSummary(db, accounts, changedReferences, rosterFlowQuotes);
  })();
}

function readOneJsonLine() {
  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  return new Promise((resolve, reject) => {
    reader.once("line", line => {
      reader.close();
      try { resolve(JSON.parse(line)); } catch { reject(new AppError(400, "TEST_ROSTER_JSON_INVALID", "人员名单 JSON 无效")); }
    });
    reader.once("close", () => reject(new AppError(400, "TEST_ROSTER_INPUT_REQUIRED", "请通过标准输入提供一行人员名单 JSON")));
  });
}

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export async function main(argv = process.argv.slice(2)) {
  if (!argv.includes("--confirm-test-roster")) throw new AppError(400, "TEST_ROSTER_CONFIRMATION_REQUIRED", "必须显式传入 --confirm-test-roster");
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  if (config.dataMode !== "TEST") throw new AppError(409, "TEST_DATA_MODE_REQUIRED", "该命令只能在 HH_DATA_MODE=TEST 的测试环境执行");
  const inputFile = option(argv, "--input-file", "");
  let input;
  if (inputFile) {
    try { input = JSON.parse(fs.readFileSync(path.resolve(inputFile), "utf8")); }
    catch { throw new AppError(400, "TEST_ROSTER_JSON_INVALID", "人员名单文件不存在或 JSON 无效"); }
  } else input = await readOneJsonLine();
  const db = createDatabase(config.databasePath);
  try {
    const result = applyTestRoster({ db, input, adminUsername: option(argv, "--admin", "admin"), seedFlow: true });
    console.log("测试人员名单与演示流程已同步；未输出或保存任何明文密码。");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  main().catch(error => {
    console.error(`测试人员名单同步失败 [${error.code || error.name || "UNKNOWN"}]：${error.message}`);
    process.exitCode = 1;
  });
}
