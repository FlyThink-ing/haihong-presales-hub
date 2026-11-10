import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { audit } from "../server/audit.js";
import { createUser, publicUser } from "../server/auth-service.js";
import { loadConfig } from "../server/config.js";
import { createContact, createFollowup, createProject } from "../server/customer-activity-service.js";
import { createCustomerDictionaryOption } from "../server/customer-dictionary-service.js";
import { createCustomer } from "../server/customer-service.js";
import { createDatabase } from "../server/database.js";
import { AppError } from "../server/domain.js";
import {
  archiveContractFile,
  confirmSignedContractCustomerStatus,
  createContractDraft,
  generateContractDocument
} from "../server/contract-service.js";
import { resolveManagedPath } from "../server/file-service.js";
import { calculateQuoteItems, createQuote, decideQuote, submitQuote } from "../server/quote-service.js";
import { actOnReminder, createReminder } from "../server/reminder-service.js";
import { completeSurvey, createSurvey, listSurveyTemplates } from "../server/survey-service.js";

export const DEMO_DATASET_VERSION = "presales-business-flow-v1";
const DEMO_MARKER = `DEMO_DATASET:${DEMO_DATASET_VERSION}`;
const DEMO_AUDIT_ACTION = "DEMO_DATA_SEEDED_V1";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CONFIRMATION_FIELDS = [
  "partyAName", "licenseScope", "partyALegalRepresentative", "partyARepresentative",
  "partyAZip", "partyAAddress", "partyAPhone", "contractNumber", "signLocation", "signDate"
];

const ACCOUNT_DEFINITIONS = [
  { key: "manager", username: "demo_manager", displayName: "演示-研发经理", role: "MANAGER", positionCode: "RND_MANAGER" },
  { key: "generalManager", username: "demo_general_manager", displayName: "演示-综合部经理", role: "MANAGER", positionCode: "GENERAL_MANAGER" },
  { key: "vp", username: "demo_vp", displayName: "演示-副总经理", role: "VP" },
  { key: "north", username: "demo_presales_north", displayName: "演示售前-华北", role: "PRESALES", regions: ["北京市", "天津市", "河北省"], homeCity: "北京市" },
  { key: "east", username: "demo_presales_east", displayName: "演示售前-华东", role: "PRESALES", regions: ["上海市", "江苏省", "浙江省"], homeCity: "上海市" },
  { key: "central", username: "demo_presales_central", displayName: "演示售前-中原", role: "PRESALES", regions: ["山东省", "河南省", "安徽省"], homeCity: "郑州市" },
  { key: "south", username: "demo_presales_south", displayName: "演示售前-华南", role: "PRESALES", regions: ["广东省", "福建省", "广西壮族自治区"], homeCity: "广州市" },
  { key: "southwest", username: "demo_presales_southwest", displayName: "演示售前-西南", role: "PRESALES", regions: ["四川省", "重庆市", "云南省"], homeCity: "成都市" }
];

const CUSTOMER_DEFINITIONS = [
  {
    key: "initial", owner: "north", fullName: "【演示】华北精密制造有限公司", shortName: "演示-华北精密", source: "演示-销售推荐", customerType: "演示-新客户", registeredDaysAgo: 5,
    status: "初期接洽", needSummary: "希望先了解 MES 在生产报工、质量追溯和设备数据采集方面的能力。", industry: "机械加工", province: "北京市", city: "北京市", district: "顺义区",
    summary: "已完成首次电话沟通，等待安排线上产品介绍。", nextAction: "发送标准方案并确认首次演示时间", method: "PHONE", decisionRole: "需求发起人"
  },
  {
    key: "survey", owner: "east", fullName: "【演示】江南电子科技有限公司", shortName: "演示-江南电子", source: "演示-行业展会", customerType: "演示-新客户", registeredDaysAgo: 18,
    status: "现场调研", needSummary: "需要打通计划、工单、报工、物料追溯和看板，先开展现场业务调研。", industry: "电子装配", province: "江苏省", city: "苏州市", district: "工业园区",
    summary: "现场调研已完成并确认，等待整理方案。", nextAction: "根据调研结论编制蓝图方案", method: "ONSITE", decisionRole: "项目负责人"
  },
  {
    key: "quoteDraft", owner: "central", fullName: "【演示】齐鲁新能源装备有限公司", shortName: "演示-齐鲁新能源", source: "演示-老客户转介绍", customerType: "演示-新客户", registeredDaysAgo: 24,
    status: "方案&报价", needSummary: "需要新能源装备装配过程防错、质量追溯和生产透明化。", industry: "新能源装备", province: "山东省", city: "济南市", district: "高新区",
    summary: "方案边界已初步确认，报价仍处于草稿。", nextAction: "核对接口数量后完善报价草稿", method: "MEETING", decisionRole: "技术决策人"
  },
  {
    key: "managerPending", owner: "south", fullName: "【演示】岭南食品工业有限公司", shortName: "演示-岭南食品", source: "演示-行业展会", customerType: "演示-新客户", registeredDaysAgo: 31,
    status: "方案&报价", needSummary: "希望覆盖配方、批次、生产执行和全流程质量追溯。", industry: "食品制造", province: "广东省", city: "佛山市", district: "顺德区",
    summary: "报价已提交，等待研发经理审核。", nextAction: "跟进研发经理审核意见", method: "WECHAT", decisionRole: "采购负责人"
  },
  {
    key: "vpPending", owner: "southwest", fullName: "【演示】蜀川汽车零部件有限公司", shortName: "演示-蜀川汽配", source: "演示-销售推荐", customerType: "演示-存量客户", registeredDaysAgo: 40,
    status: "方案&报价", needSummary: "现有 ERP 需对接 MES，实现工序防错、条码追溯和 OEE 分析。", industry: "汽车零部件", province: "四川省", city: "成都市", district: "龙泉驿区",
    summary: "研发经理和综合部经理已审核通过，等待副总经理终审。", nextAction: "准备优惠依据供副总经理终审", method: "EMAIL", decisionRole: "商务决策人"
  },
  {
    key: "contractDraft", owner: "north", fullName: "【演示】燕赵智能装备有限公司", shortName: "演示-燕赵装备", source: "演示-老客户转介绍", customerType: "演示-新客户", registeredDaysAgo: 52,
    status: "报价完成&商务洽谈", needSummary: "建设离散制造 MES，覆盖工单、报工、质量、追溯及设备接口。", industry: "智能装备", province: "河北省", city: "石家庄市", district: "高新区",
    summary: "报价三级审批完成，合同草稿已建立，待核对甲方信息。", nextAction: "与客户核对合同抬头和签章信息", method: "MEETING", decisionRole: "总经理"
  },
  {
    key: "contractGenerated", owner: "east", fullName: "【演示】钱塘医药制造有限公司", shortName: "演示-钱塘医药", source: "演示-销售推荐", customerType: "演示-存量客户", registeredDaysAgo: 64,
    status: "报价完成&商务洽谈", needSummary: "需要符合医药生产追溯要求的 MES，并与现有 ERP、LIMS 对接。", industry: "医药制造", province: "浙江省", city: "杭州市", district: "钱塘区",
    summary: "系统原始合同 Word 已生成，进入线下签章沟通。", nextAction: "发送合同原始版并收集签章反馈", method: "EMAIL", decisionRole: "法务负责人"
  },
  {
    key: "signed", owner: "central", fullName: "【演示】中州新材料有限公司", shortName: "演示-中州新材", source: "演示-行业展会", customerType: "演示-新客户", registeredDaysAgo: 78,
    status: "报价完成&商务洽谈", needSummary: "需要覆盖生产计划、配料、过程参数、质量检验和成品追溯。", industry: "新材料", province: "河南省", city: "洛阳市", district: "涧西区",
    summary: "演示合同已完成归档，并明确确认客户状态更新。", nextAction: "组织项目启动会并移交实施", method: "ONSITE", decisionRole: "董事长"
  },
  {
    key: "lost", owner: "south", fullName: "【演示】海峡包装制品有限公司", shortName: "演示-海峡包装", source: "演示-销售推荐", customerType: "演示-新客户", registeredDaysAgo: 92,
    status: "丢标", needSummary: "需要印刷包装生产排程、工艺和质量追溯。", industry: "包装印刷", province: "福建省", city: "厦门市", district: "集美区",
    summary: "部门审核退回后重新核价，最终客户选择其他供应商。", nextAction: "归档丢标原因并保持年度回访", method: "PHONE", decisionRole: "采购经理"
  },
  {
    key: "stopped", owner: "southwest", fullName: "【演示】山城机电有限公司", shortName: "演示-山城机电", source: "演示-老客户转介绍", customerType: "演示-存量客户", registeredDaysAgo: 105,
    status: "中止", needSummary: "计划升级车间生产管理，但客户年度预算暂未获批。", industry: "机电制造", province: "重庆市", city: "重庆市", district: "渝北区",
    summary: "客户因预算冻结主动中止，保留明年重新启动可能。", nextAction: "下年度预算季重新确认项目计划", method: "WECHAT", decisionRole: "生产负责人"
  }
];

function dateOnly(daysFromToday = 0) {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + daysFromToday);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function dateTime(daysFromToday = 0, hour = 9) {
  const value = new Date();
  value.setHours(hour, 0, 0, 0);
  value.setDate(value.getDate() + daysFromToday);
  return value.toISOString();
}

function randomPassword() {
  return `${randomBytes(24).toString("base64url")}aA1!`;
}

function completeSurveyResponse(schema) {
  const answers = {};
  for (const module of schema.modules || []) {
    for (const question of module.questions || []) {
      answers[question.id] = {
        record: question.required ? `演示调研记录：已核对 ${question.prompt}` : "",
        solution: question.required ? "演示建议：在项目蓝图阶段进一步确认边界。" : ""
      };
    }
  }
  const tables = {};
  for (const table of schema.tables || []) {
    tables[table.key] = [Object.fromEntries((table.fields || []).map(field => {
      if (field.type === "number") return [field.key, field.required ? 1 : 0];
      if (field.type === "select") return [field.key, (field.options || [""])[0]];
      return [field.key, field.required ? `演示-${field.label}` : ""];
    }))];
  }
  return { answers, tables };
}

function quoteInput(record, number, { itemCount = 2, unitPriceCents = 2_000_000, discountCents = 20_000 } = {}) {
  const names = ["MES生产执行模块", "质量追溯模块", "设备数据采集模块"];
  const items = Array.from({ length: itemCount }, (_, index) => ({
    category: index === 0 ? "标准模块" : index === 1 ? "实施服务" : "接口服务",
    itemName: names[index],
    subitemName: "演示业务范围",
    unit: "套",
    quantityMilli: 1000,
    untaxedUnitPriceCents: unitPriceCents,
    taxRateBps: 600,
    notes: "仅用于演示完整业务流程"
  }));
  const totals = calculateQuoteItems(items);
  return {
    quoteNumber: number,
    customerId: record.customer.id,
    projectId: record.project.id,
    notes: `【演示报价】${DEMO_MARKER}；所有金额与范围均为虚构。`,
    metadata: {
      customerContactName: `演示客户联系人-${record.definition.shortName}`,
      customerPhone: "000-0000-0000",
      customerContactSource: "CUSTOMER_MANUAL"
    },
    finalDiscountCents: totals.subtotalTaxedCents - discountCents,
    items
  };
}

function contractInput(record, quote, templateId, number, { confirmed = true } = {}) {
  return {
    contractNumber: number,
    customerId: record.customer.id,
    projectId: record.project.id,
    quoteVersionId: quote.id,
    templateId,
    contractAmountCents: quote.finalDiscountCents,
    signedLocation: "鹤壁",
    signedOn: dateOnly(0),
    signingNotes: `【演示合同】${DEMO_MARKER}；仅供理解业务流程，不构成真实交易或法律签署。`,
    partyA: {
      name: record.customer.fullName,
      licenseScope: record.customer.fullName,
      legalRepresentative: "演示法定代表人",
      representative: "演示甲方代表",
      zip: "000000",
      address: "演示地址（非真实地址）",
      phone: "000-00000000"
    },
    confirmations: Object.fromEntries(CONFIRMATION_FIELDS.map(field => [field, confirmed]))
  };
}

function summary(db) {
  const scalar = sql => db.prepare(sql).get().count;
  return {
    version: DEMO_DATASET_VERSION,
    accounts: scalar("SELECT COUNT(*) AS count FROM users WHERE username LIKE 'demo_%'"),
    customers: scalar("SELECT COUNT(*) AS count FROM customers WHERE notes LIKE '%DEMO_DATASET:presales-business-flow-v1%'"),
    contacts: scalar("SELECT COUNT(*) AS count FROM contacts ct JOIN customers c ON c.id = ct.customer_id WHERE c.notes LIKE '%DEMO_DATASET:presales-business-flow-v1%'"),
    followups: scalar("SELECT COUNT(*) AS count FROM followups f JOIN customers c ON c.id = f.customer_id WHERE c.notes LIKE '%DEMO_DATASET:presales-business-flow-v1%'"),
    surveys: scalar("SELECT COUNT(*) AS count FROM surveys s JOIN customers c ON c.id = s.customer_id WHERE c.notes LIKE '%DEMO_DATASET:presales-business-flow-v1%'"),
    quotes: scalar("SELECT COUNT(*) AS count FROM quotes q JOIN customers c ON c.id = q.customer_id WHERE c.notes LIKE '%DEMO_DATASET:presales-business-flow-v1%'"),
    contracts: scalar("SELECT COUNT(*) AS count FROM contracts ct JOIN customers c ON c.id = ct.customer_id WHERE c.notes LIKE '%DEMO_DATASET:presales-business-flow-v1%'"),
    reminders: scalar("SELECT COUNT(*) AS count FROM reminders r JOIN customers c ON c.id = r.customer_id WHERE c.notes LIKE '%DEMO_DATASET:presales-business-flow-v1%'"),
    quoteStatuses: db.prepare(`SELECT qv.status, COUNT(*) AS count FROM quote_versions qv JOIN quotes q ON q.id = qv.quote_id JOIN customers c ON c.id = q.customer_id WHERE c.notes LIKE ? GROUP BY qv.status ORDER BY qv.status`).all(`%${DEMO_MARKER}%`),
    contractStatuses: db.prepare(`SELECT ct.status, COUNT(*) AS count FROM contracts ct JOIN customers c ON c.id = ct.customer_id WHERE c.notes LIKE ? GROUP BY ct.status ORDER BY ct.status`).all(`%${DEMO_MARKER}%`)
  };
}

function readAdmin(db, username) {
  const row = db.prepare(`SELECT id, username, display_name, role, manager_id, phone, regions_json, home_city, is_active, must_change_password FROM users WHERE username = ?`).get(username);
  if (!row || row.role !== "ADMIN" || !row.is_active) throw new AppError(400, "DEMO_ADMIN_INVALID", "指定账号必须是已启用的管理员");
  return publicUser(row);
}

function preflight(db, admin) {
  const completed = db.prepare(`SELECT 1 FROM audit_logs WHERE action = ? AND entity_type = 'SYSTEM' AND entity_id = ? LIMIT 1`).get(DEMO_AUDIT_ACTION, DEMO_DATASET_VERSION);
  if (completed) return { alreadySeeded: true, summary: summary(db) };
  const partialAccounts = db.prepare(`SELECT COUNT(*) AS count FROM users WHERE username LIKE 'demo_%'`).get().count;
  const partialCustomers = db.prepare(`SELECT COUNT(*) AS count FROM customers WHERE notes LIKE ?`).get(`%${DEMO_MARKER}%`).count;
  if (partialAccounts || partialCustomers) throw new AppError(409, "DEMO_DATA_PARTIAL", "检测到未完成的演示数据批次；请先从写入前备份恢复或由管理员核对后处理，系统不会自动覆盖或删除已有记录");
  const template = db.prepare(`SELECT id, version FROM contract_templates WHERE is_published = 1 AND status = 'PUBLISHED' ORDER BY published_at DESC, rowid DESC LIMIT 1`).get();
  if (!template) throw new AppError(409, "DEMO_TEMPLATE_REQUIRED", "请先发布可用的合同模板，再生成完整演示流程");
  const surveyTemplate = listSurveyTemplates(db)[0];
  if (!surveyTemplate) throw new AppError(409, "DEMO_SURVEY_TEMPLATE_REQUIRED", "系统缺少已启用的软件调研模板");
  if (admin.role !== "ADMIN") throw new AppError(403, "DEMO_ADMIN_REQUIRED", "只有管理员可以写入演示数据");
  return { alreadySeeded: false, template, surveyTemplate };
}

export async function seedDemoData({ db, config, admin }) {
  const readiness = preflight(db, admin);
  if (readiness.alreadySeeded) return { alreadySeeded: true, ...readiness.summary };

  const accounts = {};
  for (const definition of ACCOUNT_DEFINITIONS) {
    const managerId = definition.role === "PRESALES" ? accounts.manager.id : undefined;
    accounts[definition.key] = createUser(db, {
      ...definition,
      managerId,
      password: randomPassword(),
      phone: null
    }, admin.id);
  }

  for (const value of ["演示-销售推荐", "演示-行业展会", "演示-老客户转介绍"]) {
    createCustomerDictionaryOption(db, admin, { kind: "SOURCE", value });
  }
  for (const value of ["演示-新客户", "演示-存量客户"]) {
    createCustomerDictionaryOption(db, admin, { kind: "TYPE", value });
  }

  const records = {};
  for (const [index, definition] of CUSTOMER_DEFINITIONS.entries()) {
    const owner = accounts[definition.owner];
    const customer = createCustomer(db, owner, {
      fullName: definition.fullName,
      shortName: definition.shortName,
      source: definition.source,
      customerType: definition.customerType,
      registeredOn: dateOnly(-definition.registeredDaysAgo),
      status: definition.status,
      needSummary: definition.needSummary,
      industry: definition.industry,
      province: definition.province,
      city: definition.city,
      district: definition.district,
      address: "演示地址（非真实地址）",
      summary: definition.summary,
      notes: `【演示数据】${DEMO_MARKER}；禁止用于真实业务或对外发送。`
    });
    const contact = createContact(db, owner, customer.id, {
      name: `演示联系人${String(index + 1).padStart(2, "0")}`,
      department: index % 2 ? "信息部" : "生产部",
      title: definition.decisionRole,
      mobile: "000-0000-0000",
      wechat: `demo_contact_${String(index + 1).padStart(2, "0")}`,
      email: `demo${String(index + 1).padStart(2, "0")}@example.invalid`,
      decisionRole: definition.decisionRole,
      notes: "虚构联系人，仅用于演示。"
    });
    const project = createProject(db, owner, customer.id, {
      name: `${definition.shortName} MES 项目（演示）`,
      summary: `演示项目：${definition.needSummary}`
    });
    const followup = createFollowup(db, owner, customer.id, {
      projectId: project.id,
      contactId: contact.id,
      method: definition.method,
      occurredAt: dateTime(-Math.max(1, Math.floor(definition.registeredDaysAgo / 3)), 10),
      participants: [owner.displayName, contact.name],
      content: `【演示跟进】${definition.summary}`,
      customerFeedback: "客户反馈内容为虚构，仅用于展示字段和流程。",
      nextAction: definition.nextAction
    }).followup;
    records[definition.key] = { definition, owner, customer, contact, project, followup };
  }

  const surveyResponse = completeSurveyResponse(readiness.surveyTemplate.schema);
  const survey = createSurvey(db, records.survey.owner, {
    templateId: readiness.surveyTemplate.id,
    customerId: records.survey.customer.id,
    projectId: records.survey.project.id,
    title: "【演示】江南电子 MES 软件调研",
    response: surveyResponse
  });
  completeSurvey(db, records.survey.owner, survey.id);

  createReminder(db, records.initial.owner, {
    customerId: records.initial.customer.id,
    assigneeId: records.initial.owner.id,
    relatedType: "FOLLOWUP",
    relatedId: records.initial.followup.id,
    title: "【演示】确认首次产品演示时间",
    remindAt: dateTime(1, 9),
    priority: "MEDIUM",
    notes: "本人创建的待处理提醒。"
  });
  createReminder(db, accounts.manager, {
    customerId: records.initial.customer.id,
    assigneeId: records.initial.owner.id,
    relatedType: "FOLLOWUP",
    relatedId: records.initial.followup.id,
    title: "【演示】负责人指派：补充客户组织架构",
    remindAt: dateTime(2, 14),
    priority: "HIGH",
    notes: "用于展示领导直接指派提醒。"
  });
  const unableReminder = createReminder(db, accounts.manager, {
    customerId: records.survey.customer.id,
    assigneeId: records.survey.owner.id,
    relatedType: "SURVEY",
    relatedId: survey.id,
    title: "【演示】负责人指派：取得设备接口清单",
    remindAt: dateTime(-1, 16),
    priority: "HIGH",
    notes: "用于展示无法完成并等待指派人确认。"
  });
  actOnReminder(db, records.survey.owner, unableReminder.id, {
    action: "REPORT_UNABLE",
    reason: "演示场景：客户设备供应商尚未提供接口文档。"
  });
  const completedReminder = createReminder(db, records.quoteDraft.owner, {
    customerId: records.quoteDraft.customer.id,
    assigneeId: records.quoteDraft.owner.id,
    title: "【演示】确认报价范围",
    remindAt: dateTime(-2, 9),
    priority: "LOW"
  });
  actOnReminder(db, records.quoteDraft.owner, completedReminder.id, { action: "COMPLETE", reason: "演示场景：范围已确认。" });

  const quoteDraft = createQuote(db, records.quoteDraft.owner, quoteInput(records.quoteDraft, "DEMO-Q-001", { itemCount: 1, unitPriceCents: 1_800_000, discountCents: 0 }));
  const managerPending = createQuote(db, records.managerPending.owner, quoteInput(records.managerPending, "DEMO-Q-002", { itemCount: 2, unitPriceCents: 2_000_000, discountCents: 20_000 }));
  submitQuote(db, records.managerPending.owner, managerPending.id);
  const vpPending = createQuote(db, records.vpPending.owner, quoteInput(records.vpPending, "DEMO-Q-003", { itemCount: 2, unitPriceCents: 2_500_000, discountCents: 50_000 }));
  submitQuote(db, records.vpPending.owner, vpPending.id);
  decideQuote(db, accounts.manager, vpPending.id, { decision: "APPROVED", comment: "演示审批：范围与成本核对无误，同意提交副总终审。" });
  decideQuote(db, accounts.generalManager, vpPending.id, { decision: "APPROVED", comment: "演示审批：综合部复核商务条件无误，同意提交副总终审。" });

  async function approvedQuote(record, number, options) {
    const quote = createQuote(db, record.owner, quoteInput(record, number, options));
    submitQuote(db, record.owner, quote.id);
    decideQuote(db, accounts.manager, quote.id, { decision: "APPROVED", comment: "演示审批：部门负责人审核通过。" });
    decideQuote(db, accounts.generalManager, quote.id, { decision: "APPROVED", comment: "演示审批：综合部经理审核通过。" });
    decideQuote(db, accounts.vp, quote.id, { decision: "APPROVED", comment: "演示审批：副总经理终审通过。" });
    return quote;
  }

  const contractDraftQuote = await approvedQuote(records.contractDraft, "DEMO-Q-004", { itemCount: 3, unitPriceCents: 3_000_000, discountCents: 540_000 });
  const generatedQuote = await approvedQuote(records.contractGenerated, "DEMO-Q-005", { itemCount: 2, unitPriceCents: 4_000_000, discountCents: 480_000 });
  const signedQuote = await approvedQuote(records.signed, "DEMO-Q-006", { itemCount: 3, unitPriceCents: 5_000_000, discountCents: 900_000 });

  const returnedQuote = createQuote(db, records.lost.owner, quoteInput(records.lost, "DEMO-Q-007", { itemCount: 1, unitPriceCents: 2_200_000, discountCents: 20_000 }));
  submitQuote(db, records.lost.owner, returnedQuote.id);
  decideQuote(db, accounts.manager, returnedQuote.id, { decision: "REJECTED", comment: "演示退回：报价范围和商务依据需要重新核对。" });

  createContractDraft(db, records.contractDraft.owner, contractInput(records.contractDraft, contractDraftQuote, readiness.template.id, "DEMO-HT-001", { confirmed: false }));
  const generatedContract = createContractDraft(db, records.contractGenerated.owner, contractInput(records.contractGenerated, generatedQuote, readiness.template.id, "DEMO-HT-002"));
  await generateContractDocument(db, config, records.contractGenerated.owner, generatedContract.id);

  const signedContract = createContractDraft(db, records.signed.owner, contractInput(records.signed, signedQuote, readiness.template.id, "DEMO-HT-003"));
  await generateContractDocument(db, config, records.signed.owner, signedContract.id);
  const original = db.prepare(`SELECT storage_key FROM contract_files WHERE contract_id = ? AND category = 'SYSTEM_GENERATED'`).get(signedContract.id);
  const signedBuffer = fs.readFileSync(resolveManagedPath(config, original.storage_key));
  archiveContractFile(db, config, records.signed.owner, signedContract.id, "FINAL_SIGNED", {
    originalname: "DEMO-HT-003-演示签署归档.docx",
    mimetype: DOCX_MIME,
    buffer: signedBuffer
  }, {
    amount: false,
    scope: false,
    quantity: false,
    unitPrice: false,
    taxRate: false,
    confirmed: true,
    note: "演示签署归档：复用系统生成 Word 展示归档流程，不代表真实签字盖章。"
  });
  confirmSignedContractCustomerStatus(db, records.signed.owner, signedContract.id, { confirmed: true });

  audit(db, {
    actorId: admin.id,
    action: DEMO_AUDIT_ACTION,
    entityType: "SYSTEM",
    entityId: DEMO_DATASET_VERSION,
    summary: {
      marker: DEMO_MARKER,
      accounts: ACCOUNT_DEFINITIONS.map(item => item.username),
      customers: CUSTOMER_DEFINITIONS.map(item => item.fullName),
      passwordsDisclosed: false,
      warning: "全部为演示数据，禁止用于真实业务或对外发送"
    }
  });

  return { alreadySeeded: false, ...summary(db), exampleQuoteDraftId: quoteDraft.id };
}

function option(argv, name, fallback = undefined) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export async function main(argv = process.argv.slice(2)) {
  if (!argv.includes("--confirm-demo-data")) {
    throw new AppError(400, "DEMO_CONFIRMATION_REQUIRED", "必须显式传入 --confirm-demo-data；该命令会向当前配置的数据库写入演示记录");
  }
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  try {
    const admin = readAdmin(db, option(argv, "--admin", "admin"));
    const result = await seedDemoData({ db, config, admin });
    console.log(result.alreadySeeded ? "演示数据已存在，本次未重复写入。" : "演示数据写入完成。");
    console.log(JSON.stringify(result, null, 2));
    console.log("演示账号未输出或保存明文密码；如需切换角色体验，请使用管理员页面重置对应账号密码。");
  } finally {
    db.close();
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  main().catch(error => {
    console.error(`演示数据写入失败 [${error.code || error.name || "UNKNOWN"}]：${error.message}`);
    process.exitCode = 1;
  });
}
