const customers = [
  { id: 1, name: "东湾示例制造有限公司", short: "东湾制造", status: "现场调研", owner: "陈楠", region: "华东", city: "示例市", industry: "装备制造", source: "销售推荐", date: "2026-08-12", need: "MES 与设备数据采集", recent: "2026-08-23 14:30", x: 71, y: 43 },
  { id: 2, name: "北辰样板装备有限公司", short: "北辰装备", status: "方案&报价", owner: "陈楠", region: "华北", city: "样板市", industry: "汽车零部件", source: "展会", date: "2026-07-28", need: "线束 MES 与质量追溯", recent: "2026-08-22 09:15", x: 42, y: 26 },
  { id: 3, name: "南岭演示科技有限公司", short: "南岭科技", status: "初期接洽", owner: "王悦", region: "华南", city: "演示市", industry: "电子制造", source: "网络", date: "2026-08-18", need: "注塑 MES", recent: "2026-08-21 16:00", x: 49, y: 78 },
  { id: 4, name: "西江虚构工业有限公司", short: "西江工业", status: "报价完成&商务洽谈", owner: "赵川", region: "华东", city: "虚构市", industry: "机械加工", source: "老客户推荐", date: "2026-06-05", need: "PLM 与 ERP 接口", recent: "2026-08-20 11:20", x: 79, y: 57 },
  { id: 5, name: "中原测试材料有限公司", short: "中原材料", status: "合同签订完成", owner: "孙琪", region: "华北", city: "测试市", industry: "新材料", source: "销售推荐", date: "2026-04-11", need: "生产执行与看板", recent: "2026-08-18 10:10", x: 33, y: 37 },
  { id: 6, name: "滨海占位实业有限公司", short: "滨海实业", status: "中止", owner: "刘晨", region: "华南", city: "占位市", industry: "家电", source: "展会", date: "2026-03-03", need: "设备联网评估", recent: "2026-08-10 13:40", x: 61, y: 70 }
];

const navItems = [
  ["dashboard", "▦", "工作台"], ["customers", "♙", "客户管理"], ["reminders", "◷", "跟进提醒"],
  ["map", "⌖", "分布地图"], ["research", "▤", "软件调研"], ["quotes", "¥", "报价管理"],
  ["contracts", "▧", "合同管理"], ["sop", "☷", "岗位职责与 SOP"]
];

const roleProfiles = {
  presales: { name: "陈楠", role: "售前人员", avatar: "陈", note: "仅可查看本人负责客户" },
  manager: { name: "周主管", role: "部门负责人", avatar: "周", note: "可查看全部客户并处理一级审批" },
  vp: { name: "林副总", role: "副总经理", avatar: "林", note: "可查看审批所需资料并处理终审" }
};

const state = {
  page: location.hash.slice(1) || "dashboard",
  role: "presales",
  customerView: "table",
  customerFilter: "",
  customerTab: "overview",
  selectedCustomer: 1,
  quoteStatus: "待部门负责人审核",
  quoteVersion: "V1.0",
  researchStatus: "草稿",
  activeSop: "跟进规范",
  contractQty: 1,
  contractPrice: 126000,
  activePin: null
};

function visibleCustomers() {
  if (state.role === "presales") return customers.filter(c => c.owner === "陈楠");
  if (state.role === "vp") return customers.filter(c => [2, 4].includes(c.id));
  return customers;
}

function setPage(page) {
  state.page = page;
  location.hash = page;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
  document.querySelector(".sidebar")?.classList.remove("open");
}

function pageHead(title, subtitle, actions = "") {
  return `<div class="page-head"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${actions}</div></div>`;
}

function statusTag(status) {
  const map = { "初期接洽":"blue", "现场调研":"orange", "方案&报价":"blue", "报价完成&商务洽谈":"orange", "合同签订完成":"green", "丢标":"red", "中止":"" };
  return `<span class="tag ${map[status] || ""}">${status}</span>`;
}

function renderNav() {
  document.querySelector("#main-nav").innerHTML = `<div class="nav-list">${navItems.map(([key, icon, label]) => `
    <button class="nav-item ${state.page === key || (state.page === "customer-detail" && key === "customers") ? "active" : ""}" data-page="${key}">
      <span class="nav-icon">${icon}</span><span>${label}</span>
    </button>`).join("")}</div>`;
}

function renderDashboard() {
  const count = visibleCustomers().length;
  const approvalText = state.role === "manager" ? "待一级审批" : state.role === "vp" ? "待终审" : "退回待修改";
  return `${pageHead("工作台", `${roleProfiles[state.role].name}，以下是你当前需要处理的事项`, `
    <button class="button" data-action="export-word">导出可编辑 Word</button>
    <button class="button primary" data-action="new-followup">+ 新增跟进</button>`)}
    <div class="notice"><strong>权限范围：</strong>${roleProfiles[state.role].note}。原型中的名称、联系方式、金额和地址均为虚构演示内容。</div>
    <section class="grid grid-4">
      <div class="card metric"><div class="metric-label">本人可见客户</div><div class="metric-value">${count}</div><div class="metric-note">现场调研 1 · 方案报价 1</div></div>
      <div class="card metric"><div class="metric-label">未来 7 天提醒</div><div class="metric-value">4</div><div class="metric-note">今日需要处理 2 项</div></div>
      <div class="card metric danger"><div class="metric-label">已逾期提醒</div><div class="metric-value">1</div><div class="metric-note">最长逾期 1 天</div></div>
      <div class="card metric"><div class="metric-label">${approvalText}</div><div class="metric-value">1</div><div class="metric-note">报价编号 Q-DEMO-002</div></div>
    </section>
    <section class="grid grid-3" style="margin-top:16px">
      <div class="card span-2">
        <div class="card-head"><h2>待办与提醒</h2><button class="text-button" data-page="reminders">查看全部</button></div>
        <ul class="list">
          <li class="list-row"><div class="list-main"><strong>确认软件调研参与人员</strong><small>东湾示例制造有限公司 · 今天 15:00</small></div><div class="list-side"><span class="tag orange">高优先级</span></div></li>
          <li class="list-row"><div class="list-main"><strong>准备线束 MES 报价说明</strong><small>北辰样板装备有限公司 · 明天 10:00</small></div><div class="list-side"><span class="tag blue">待处理</span></div></li>
          <li class="list-row"><div class="list-main"><strong>补充上次电话沟通结果</strong><small>东湾示例制造有限公司 · 昨天 17:00</small></div><div class="list-side"><span class="tag red">已逾期</span></div></li>
        </ul>
      </div>
      <div class="card">
        <div class="card-head"><h2>客户状态分布</h2><span class="tag outline">仅当前权限</span></div>
        <div class="card-body">
          <div class="list-row"><span>初期接洽</span><strong>${state.role === "manager" ? 1 : 0}</strong></div>
          <div class="list-row"><span>现场调研</span><strong>1</strong></div>
          <div class="list-row"><span>方案&报价</span><strong>1</strong></div>
          <div class="list-row"><span>商务洽谈及以后</span><strong>${state.role === "manager" ? 2 : 0}</strong></div>
        </div>
      </div>
    </section>
    <section class="grid grid-2" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><h2>快速入口</h2></div>
        <div class="card-body quick-actions">
          <button class="quick-action" data-action="new-customer"><b>＋ 新增客户</b><span>建立客户主档案</span></button>
          <button class="quick-action" data-action="new-followup"><b>＋ 新增跟进</b><span>记录电话或拜访</span></button>
          <button class="quick-action" data-page="research"><b>▤ 开始调研</b><span>关联客户和项目</span></button>
          <button class="quick-action" data-page="quotes"><b>¥ 创建报价</b><span>引用已完成调研</span></button>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>最近跟进客户</h2></div>
        <ul class="list">${visibleCustomers().slice(0,3).map(c => `<li class="list-row"><div class="list-main"><a href="#" class="customer-link" data-customer="${c.id}">${c.short}</a><small>${c.need}</small></div><small>${c.recent.slice(5)}</small></li>`).join("")}</ul>
      </div>
    </section>`;
}

function renderCustomers() {
  let list = visibleCustomers();
  if (state.customerFilter) list = list.filter(c => `${c.name}${c.status}${c.region}${c.industry}`.includes(state.customerFilter));
  const scopeText = state.role === "presales" ? "当前仅展示负责人为“陈楠”的 2 家客户；其他售前客户不可搜索、不可查看。" : state.role === "vp" ? "当前仅展示与待审批报价相关的必要客户资料。" : "部门负责人可查看全部 6 家演示客户。";
  return `${pageHead("客户管理", "查询客户主档案、状态和最近跟进", `<button class="button" data-action="import-preview">导入预览</button><button class="button" data-action="export-word">导出可编辑 Word</button><button class="button primary" data-action="new-customer">+ 新增客户</button>`)}
    <div class="notice"><strong>数据权限演示：</strong>${scopeText}</div>
    <div class="card filters">
      <input class="control grow" id="customer-filter" value="${state.customerFilter}" placeholder="客户名称 / 行业 / 区域" />
      <select class="control"><option>全部状态</option><option>初期接洽</option><option>现场调研</option><option>方案&报价</option></select>
      <select class="control" ${state.role === "presales" ? "disabled" : ""}><option>${state.role === "presales" ? "负责人：陈楠" : "全部负责人"}</option></select>
      <div class="segmented"><button class="${state.customerView === "table" ? "active" : ""}" data-view="table">表格</button><button class="${state.customerView === "kanban" ? "active" : ""}" data-view="kanban">看板</button></div>
    </div>
    ${state.customerView === "table" ? `<div class="card table-wrap"><table><thead><tr><th>客户名称</th><th>状态</th><th>需求</th><th>行业 / 区域</th><th>负责人</th><th>最近跟进</th><th>操作</th></tr></thead><tbody>${list.map(c => `<tr><td><a href="#" class="customer-link" data-customer="${c.id}">${c.name}</a></td><td>${statusTag(c.status)}</td><td>${c.need}</td><td>${c.industry}<br><small>${c.region} · ${c.city}</small></td><td>${c.owner}</td><td>${c.recent}</td><td><button class="text-button" data-customer="${c.id}">查看详情</button></td></tr>`).join("")}</tbody></table>${list.length ? "" : '<div class="empty-state">当前权限和筛选条件下没有可见客户</div>'}</div>` : renderKanban(list)}`;
}

function renderKanban(list) {
  const groups = ["初期接洽", "现场调研", "方案&报价", "报价完成&商务洽谈"];
  return `<div class="kanban">${groups.map(g => `<div class="kanban-col"><div class="kanban-title"><span>${g}</span><span>${list.filter(c=>c.status===g).length}</span></div>${list.filter(c=>c.status===g).map(c=>`<button class="kanban-card" data-customer="${c.id}" style="width:100%;text-align:left"><strong>${c.short}</strong><small>${c.need}</small><small>${c.owner} · ${c.region}</small></button>`).join("")}</div>`).join("")}</div>`;
}

function renderCustomerDetail() {
  const c = customers.find(x => x.id === state.selectedCustomer) || customers[0];
  if (!visibleCustomers().some(x => x.id === c.id)) return `<div class="notice danger"><strong>无权查看：</strong>该客户不在当前账号的数据权限范围内。</div><button class="button" data-page="customers">返回客户列表</button>`;
  const tabs = [["overview","概览"],["contacts","联系人"],["followups","跟进记录"],["reminders","提醒"],["research","软件调研"],["quotes","报价"],["contracts","合同"],["logs","附件与操作日志"]];
  return `<div class="breadcrumb"><button data-page="customers">客户管理</button> / 客户详情</div>
    <section class="card profile-head"><div><h1>${c.name}</h1><div class="profile-meta"><span>${statusTag(c.status)}</span><span>负责人：${c.owner}</span><span>${c.industry}</span><span>${c.region} · ${c.city}</span></div></div><div class="actions"><button class="button" data-action="export-word">导出可编辑 Word</button><button class="button primary" data-action="new-followup">+ 新增跟进</button></div></section>
    <div class="tabs">${tabs.map(([k,l])=>`<button class="tab ${state.customerTab===k?"active":""}" data-tab="${k}">${l}</button>`).join("")}</div>
    <div class="tab-panel">${renderCustomerTab(c)}</div>`;
}

function renderCustomerTab(c) {
  if (state.customerTab === "overview") return `<div class="grid grid-3"><div class="card span-2"><div class="card-head"><h2>客户概览</h2><button class="text-button" data-action="edit-placeholder">编辑</button></div><div class="card-body"><dl class="detail-list"><dt>客户需求</dt><dd>${c.need}</dd><dt>客户来源</dt><dd>${c.source}</dd><dt>登记时间</dt><dd>${c.date}</dd><dt>所在区域</dt><dd>${c.region} · ${c.city} · 示例区（虚构地址）</dd><dt>机会总结</dt><dd>客户处于需求梳理阶段，已确认近期安排业务访谈；需继续核实接口范围与实施边界。</dd><dt>协同人员</dt><dd>方案顾问 A（虚构）</dd></dl></div></div><div class="card"><div class="card-head"><h2>下一步</h2></div><div class="card-body"><strong>完成现场调研准备</strong><p style="color:var(--muted);line-height:1.6">计划时间：2026-08-25 15:00<br>负责人：${c.owner}</p><button class="button small" data-action="go-reminders">查看提醒</button></div></div></div>`;
  if (state.customerTab === "contacts") return `<div class="card"><div class="card-head"><h2>联系人（内部可见）</h2><button class="button small" data-action="edit-placeholder">+ 新增联系人</button></div><div class="table-wrap"><table><thead><tr><th>姓名</th><th>部门 / 职务</th><th>联系方式</th><th>决策角色</th></tr></thead><tbody><tr><td>联系人 A（虚构）</td><td>生产部 / 职务占位</td><td>手机：13*********<br>微信：演示账号（虚构）</td><td>业务参与人</td></tr><tr><td>联系人 B（虚构）</td><td>信息部 / 职务占位</td><td>邮箱：demo@example.invalid</td><td>技术评估人</td></tr></tbody></table></div></div>`;
  if (state.customerTab === "followups") return `<div class="card"><div class="card-head"><h2>跟进时间线</h2><button class="button primary small" data-action="new-followup">+ 新增跟进</button></div><div class="card-body timeline"><article class="timeline-item"><h3>现场 · 需求预沟通</h3><div class="timeline-time">2026-08-23 14:30 · 记录人：${c.owner}</div><p>与客户演示联系人确认现状、调研范围及计划参与部门。</p><p><strong>客户反馈：</strong>希望先梳理生产、质量与设备数据采集流程。</p><p><strong>下一步：</strong>准备调研问题清单并确认参会人员。</p><span class="tag blue">已同步提醒</span></article><article class="timeline-item"><h3>电话 · 初次需求确认</h3><div class="timeline-time">2026-08-19 10:20 · 记录人：${c.owner}</div><p>确认客户为内部演示机会，了解初步产品方向和计划周期。</p><small>修改记录：2026-08-19 10:42 补充下一步行动（历史保留）</small></article></div></div>`;
  if (state.customerTab === "reminders") return renderReminderCard();
  if (state.customerTab === "research") return `<div class="card"><div class="card-head"><h2>软件调研记录</h2><button class="button primary small" data-page="research">继续填写</button></div><div class="table-wrap"><table><thead><tr><th>调研名称</th><th>关联项目</th><th>模板版本</th><th>状态</th><th>最后修改</th></tr></thead><tbody><tr><td>MES 现状与需求调研</td><td>${c.need}</td><td>MES-BASE V1.2</td><td><span class="tag orange">草稿 65%</span></td><td>${c.owner} · 08-23 16:40</td></tr></tbody></table></div></div>`;
  if (state.customerTab === "quotes") return `<div class="card"><div class="card-head"><h2>关联报价</h2><button class="button primary small" data-page="quotes">创建报价</button></div><div class="table-wrap"><table><thead><tr><th>报价编号</th><th>版本</th><th>金额</th><th>状态</th><th>更新时间</th></tr></thead><tbody><tr><td>Q-DEMO-002</td><td>V1.0</td><td class="amount">¥ 126,000.00</td><td><span class="tag blue">${state.quoteStatus}</span></td><td>2026-08-23</td></tr></tbody></table></div></div>`;
  if (state.customerTab === "contracts") return `<div class="card"><div class="card-head"><h2>关联合同</h2><button class="button primary small" data-page="contracts">生成合同</button></div><div class="empty-state">审批完成的报价可在此生成合同；当前报价状态：${state.quoteStatus}</div></div>`;
  return `<div class="grid grid-2"><div class="card"><div class="card-head"><h2>附件版本</h2></div><ul class="list"><li class="list-row"><div class="list-main"><strong>调研问题清单_演示版.docx</strong><small>上传人：${c.owner} · 2026-08-23</small></div><span class="tag">V1</span></li></ul></div><div class="card"><div class="card-head"><h2>操作日志</h2></div><ul class="list"><li class="list-row"><div class="list-main"><strong>客户状态变更</strong><small>初期接洽 → 现场调研 · ${c.owner}</small></div><small>08-23 16:42</small></li><li class="list-row"><div class="list-main"><strong>新增跟进记录</strong><small>保留原始记录与修改痕迹</small></div><small>08-23 14:30</small></li></ul></div></div>`;
}

function renderReminderCard() {
  return `<div class="card"><div class="card-head"><h2>提醒</h2><button class="button primary small" data-action="new-reminder">+ 新建提醒</button></div><ul class="list"><li class="list-row" data-reminder-row><div class="list-main"><strong>确认软件调研参与人员</strong><small>2026-08-25 15:00 · 东湾示例制造有限公司 · 高优先级</small></div><div class="actions"><button class="button small" data-action="postpone">延期</button><button class="button small primary" data-action="complete-reminder">完成</button></div></li><li class="list-row"><div class="list-main"><strong>补充电话沟通结果</strong><small>原定 2026-08-23 17:00 · 已逾期</small></div><span class="tag red">已逾期</span></li></ul></div>`;
}

function renderReminders() {
  return `${pageHead("跟进提醒", "集中处理到期、逾期和未来 7 天行动", `<button class="button" data-action="export-word">导出可编辑 Word</button><button class="button primary" data-action="new-reminder">+ 新建提醒</button>`)}
  <div class="card filters"><select class="control"><option>待处理与逾期</option><option>已完成</option><option>已取消</option></select><select class="control"><option>全部优先级</option><option>高</option><option>中</option></select><input class="control grow" placeholder="搜索客户或提醒事项" /></div>${renderReminderCard()}`;
}

function renderMap() {
  const reps = [{n:"陈楠",r:"华东、华北",c:2},{n:"王悦",r:"华南",c:1},{n:"赵川",r:"华东",c:1},{n:"孙琪",r:"华北",c:1},{n:"刘晨",r:"华南",c:1}];
  const pins = visibleCustomers();
  return `${pageHead("分布地图", "查看售前负责区域与客户分布点，不采集实时定位或行动轨迹")}
    <div class="card filters"><select class="control" id="map-owner"><option value="">全部售前人员</option>${[...new Set(pins.map(c=>c.owner))].map(o=>`<option>${o}</option>`).join("")}</select><select class="control"><option>全部客户状态</option><option>现场调研</option><option>方案&报价</option></select><select class="control"><option>全部区域</option><option>华东</option><option>华北</option><option>华南</option></select><span class="tag outline">示意地图 · 非真实坐标</span></div>
    <div class="map-layout"><div class="map-canvas"><div class="map-grid"></div><div class="region region-north"></div><div class="region region-east"></div><div class="region region-south"></div><span class="region-label" style="left:29%;top:13%">华北负责区域</span><span class="region-label" style="right:17%;top:23%">华东负责区域</span><span class="region-label" style="left:37%;bottom:13%">华南负责区域</span>${pins.map(c=>`<button class="map-pin" data-pin="${c.id}" data-owner="${c.owner}" style="left:${c.x}%;top:${c.y}%" aria-label="查看${c.short}"><span class="pin-dot"><span>${c.owner[0]}</span></span></button>`).join("")}<div class="map-popover hidden" id="map-popover"></div></div>
    <aside class="card"><div class="card-head"><h2>售前区域分工</h2></div><div class="card-body region-summary">${reps.map(r=>`<div class="region-card"><strong>${r.n}</strong><span>负责区域：${r.r}</span><span>区域内演示客户：${state.role === "presales" && r.n!=="陈楠" ? "无权查看" : r.c+" 家"}</span></div>`).join("")}</div></aside></div>`;
}

function renderResearch() {
  return `${pageHead("软件调研", "MES 现状与需求调研 · 东湾示例制造有限公司", `<button class="button" data-action="export-word">导出可编辑 Word</button>`)}
    <div class="notice"><strong>关联：</strong>东湾示例制造有限公司 / MES 与设备数据采集项目　<span class="tag orange">${state.researchStatus}</span>　模板 MES-BASE V1.2</div>
    <div class="grid grid-3"><div class="span-2"><section class="question-group"><h2 class="question-title">一、企业与生产概况</h2><div class="question"><label>1. 主要产品及生产模式</label><textarea class="control" style="width:100%;min-height:70px" data-autosave>演示填写：多品种、小批量，按订单组织生产。</textarea></div><div class="question"><label>2. 当前主要生产管理方式</label><div class="option-row"><label><input type="checkbox" checked data-autosave> ERP</label><label><input type="checkbox" checked data-autosave> Excel</label><label><input type="checkbox" data-autosave> 纸质单据</label></div></div></section><section class="question-group"><h2 class="question-title">二、现场流程与数据采集</h2><div class="question"><label>3. 计划纳入本期调研的业务环节</label><div class="option-row"><label><input type="checkbox" checked data-autosave> 生产</label><label><input type="checkbox" checked data-autosave> 质量</label><label><input type="checkbox" data-autosave> 仓储</label><label><input type="checkbox" checked data-autosave> 设备</label></div></div><div class="question"><label>4. 设备接口与数据来源说明</label><textarea class="control" style="width:100%;min-height:85px" data-autosave placeholder="记录接口类型、设备数量和待核实事项">部分设备具备标准接口，具体协议与点位数量待现场核实。</textarea></div></section></div>
    <aside class="card"><div class="card-head"><h2>填写进度</h2></div><div class="card-body"><div class="metric-value">65%</div><p style="color:var(--muted)">已填写 13 / 20 项<br>最后修改：陈楠 · 刚刚</p><hr style="border:0;border-top:1px solid var(--line);margin:16px 0"><p><strong>状态说明</strong></p><p style="color:var(--muted);line-height:1.6">草稿可继续填写；完成确认后可被报价引用。历史记录始终保留当前模板版本。</p></div></aside></div>
    <div class="form-actions"><span class="autosave" id="autosave-label">✓ 草稿已自动保存（原型模拟）</span><button class="button" data-action="copy-research">复制历史调研</button><button class="button primary" data-action="complete-research">完成确认</button></div>`;
}

function quoteSteps() {
  const idx = state.quoteStatus === "待部门负责人审核" ? 1 : state.quoteStatus === "待副总经理审核" ? 2 : state.quoteStatus === "审批完成" ? 3 : 0;
  return `<div class="card stepper"><div class="step ${idx>0?"done":"active"}">报价草稿</div><div class="step ${idx>1?"done":idx===1?"active":""}">部门负责人审核</div><div class="step ${idx>2?"done":idx===2?"active":""}">副总经理审核</div><div class="step ${idx===3?"active":""}">审批完成并锁定</div></div>`;
}

function renderQuotes() {
  const locked = state.quoteStatus !== "草稿" && state.quoteStatus !== "部门负责人退回" && state.quoteStatus !== "副总经理退回";
  const canManager = state.role === "manager" && state.quoteStatus === "待部门负责人审核";
  const canVp = state.role === "vp" && state.quoteStatus === "待副总经理审核";
  return `${pageHead("报价编制与审批", "报价 Q-DEMO-002 · ${state.quoteVersion} · 北辰样板装备有限公司", `<button class="button" data-action="export-word">导出可编辑 Word</button><button class="button" data-action="copy-quote">复制为新版本</button>`)}${quoteSteps()}
    ${locked ? `<div class="notice warning"><strong>当前版本已锁定：</strong>报价进入审批后编制人不可修改，审批人只能通过或退回。退回后可修改并重新提交。</div>` : ""}
    <div class="grid grid-3"><section class="card span-2"><div class="card-head"><h2>报价明细</h2><span class="tag blue">引用：线束 MES 调研（已完成）</span></div><div class="table-wrap"><table class="attachment-table"><thead><tr><th>分类</th><th>项目 / 子项</th><th>单位</th><th>数量</th><th>未税单价</th><th>税率</th><th>含税金额</th></tr></thead><tbody><tr><td>标准模块</td><td>生产执行基础模块</td><td>套</td><td>1</td><td class="amount">80,000.00</td><td>6%</td><td class="amount">84,800.00</td></tr><tr><td>定制化需求</td><td>线束工序追溯扩展</td><td>项</td><td>1</td><td class="amount">30,000.00</td><td>6%</td><td class="amount">31,800.00</td></tr><tr><td>实施部署</td><td>部署与培训</td><td>项</td><td>1</td><td class="amount">10,000.00</td><td>6%</td><td class="amount">10,600.00</td></tr></tbody><tfoot><tr><td colspan="6" style="text-align:right"><strong>最终优惠价</strong></td><td class="amount"><strong>¥ 126,000.00</strong></td></tr></tfoot></table></div><div class="card-body"><button class="button small" ${locked?"disabled":""}>+ 添加报价项</button> <span class="tag green">金额校验通过</span></div></section>
    <aside class="card"><div class="card-head"><h2>审批记录</h2></div><div class="card-body"><div class="approval-box done"><strong>提交报价 · 陈楠</strong><small>2026-08-23 17:20 · ${state.quoteVersion}</small></div><div class="approval-box ${state.quoteStatus==="待部门负责人审核"?"active":state.quoteStatus!=="待部门负责人审核"?"done":""}"><strong>部门负责人 · 周主管</strong><small>${state.quoteStatus==="待部门负责人审核"?"等待审批":state.quoteStatus==="审批完成"||state.quoteStatus==="待副总经理审核"?"已通过 · 报价结构与金额无误":"等待处理"}</small></div><div class="approval-box ${state.quoteStatus==="待副总经理审核"?"active":state.quoteStatus==="审批完成"?"done":""}"><strong>副总经理 · 林副总</strong><small>${state.quoteStatus==="待副总经理审核"?"等待终审":state.quoteStatus==="审批完成"?"已通过 · 审批完成并锁定":"待上一级通过"}</small></div></div></aside></div>
    <div class="form-actions">${canManager||canVp?`<button class="button danger" data-action="reject-quote">退回并填写意见</button><button class="button primary" data-action="approve-quote">${canManager?"通过并提交副总经理":"终审通过"}</button>`:`<span class="autosave">${state.role === "presales" ? "当前账号为编制人，无审批权限" : "当前没有待本角色处理的审批"}</span>`}</div>`;
}

function renderContracts() {
  const total = state.contractQty * state.contractPrice;
  const match = total === 126000;
  const quoteApproved = state.quoteStatus === "审批完成";
  return `${pageHead("合同生成与附件", "合同草稿 C-DEMO-001 · 固定正文模板 HH-CONTRACT V2.3", `<button class="button" data-action="export-word">导出可编辑 Word</button>`)}
    <div class="notice warning"><strong>合同变量边界待确认：</strong>合同编号、甲方名称、签订日期、产品名称、金额、交付周期等仅作原型占位；哪些由系统自动填入、哪些需人工确认，暂不作最终决定。</div>
    <div class="grid grid-2"><section><div class="card-head card"><h2>合同正文（只读）</h2><span class="tag outline">🔒 不可在线编辑</span></div><article class="locked-document"><h2>软件产品及实施服务合同</h2><p>合同编号：<u>C-DEMO-001</u></p><p>甲方：<u>北辰样板装备有限公司（虚构）</u></p><p>乙方：<u>海弘（原型占位）</u></p><div class="locked"><strong>第一条 合同标的</strong><br>以下为固定模板条款占位文本。正式合同条款、章节顺序和排版由管理员发布的主模板决定，页面不提供编辑功能。</div><div class="locked"><strong>第二条 交付与验收</strong><br>固定正文条款占位。合同生成时记录模板版本，历史合同不因新模板发布而改变。</div><p>合同金额（演示）：人民币 <strong>126,000.00 元</strong></p></article></section>
    <section class="card"><div class="card-head"><h2>附件一：价格明细</h2><span class="tag ${quoteApproved?"green":"orange"}">引用报价 Q-DEMO-002 ${state.quoteVersion}</span></div><div class="table-wrap"><table class="attachment-table"><thead><tr><th>项目</th><th>数量</th><th>含税单价</th><th>合计</th></tr></thead><tbody><tr><td>线束 MES 软件及实施（演示）</td><td><input id="contract-qty" type="number" min="1" value="${state.contractQty}"></td><td><input id="contract-price" type="number" min="0" value="${state.contractPrice}"></td><td class="amount">¥ ${total.toLocaleString("zh-CN")}.00</td></tr></tbody></table></div><div class="card-body"><div class="notice ${match&&quoteApproved?"":"danger"}" style="margin:0 0 12px"><strong>生成前校验：</strong><br>${quoteApproved?"✓ 已引用审批完成报价":"✕ 报价尚未完成两级审批"}<br>${match?"✓ 附件合计与报价金额一致":"✕ 附件合计与审批报价不一致，请新建报价版本并重新审批"}</div><div class="field"><label>附件备注（可编辑）</label><textarea placeholder="按客户实际情况填写附件备注">本附件明细仅为原型演示，不构成真实报价或合同。</textarea></div></div><div class="form-actions" style="padding:14px"><button class="button">保存附件草稿</button><button class="button primary" data-action="generate-contract" ${match&&quoteApproved?"":"disabled"}>生成正式合同</button></div></section></div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>版本与归档规则</h2></div><div class="card-body grid grid-3"><div><strong>原始生成文件</strong><p style="color:var(--muted)">生成后保留，不允许后续版本覆盖。</p></div><div><strong>Word 修改后回传</strong><p style="color:var(--muted)">最终确认版重新上传归档，并保留初始版本。</p></div><div><strong>已签订合同</strong><p style="color:var(--muted)">禁止删除；后续变化使用新附件或补充协议。</p></div></div></div>`;
}

function renderSop() {
  const docs = {
    "跟进规范": { stage:"客户跟进", version:"V1.3", body:`<h2>客户跟进记录规范</h2><p>适用岗位：售前人员　|　业务阶段：初期接洽至商务洽谈</p><h3>一、记录要求</h3><ol><li>电话、微信、现场、会议及邮件等有效沟通均应形成记录。</li><li>记录应包含沟通内容、客户反馈和下一步行动。</li><li>新增跟进时，应按实际情况同步设置下一次提醒。</li></ol><h3>二、纠正与留痕</h3><p>历史跟进原则上不直接删除；确需纠正时，系统保留修改人、时间和变更摘要。</p>` },
    "调研 SOP": { stage:"软件调研", version:"V1.1", body:`<h2>软件调研 SOP</h2><p>适用岗位：售前人员 / 方案顾问</p><h3>工作步骤</h3><ol><li>选择客户、项目及对应调研模板版本。</li><li>按问题分组记录答案、说明和附件。</li><li>核实待确认事项后完成确认，供报价引用。</li></ol>` },
    "报价审批": { stage:"方案与报价", version:"V2.0", body:`<h2>报价编制及审批 SOP</h2><h3>审批顺序</h3><p>编制人提交 → 部门负责人审核 → 副总经理终审。</p><ul><li>审批人不得直接修改报价内容。</li><li>退回必须填写意见，由编制人修改后重新提交。</li><li>审批完成版本锁定；调整时复制为新版本。</li></ul>` },
    "合同归档": { stage:"合同签订", version:"V1.0", body:`<h2>合同生成与归档 SOP</h2><ol><li>选择已审批报价与已发布合同模板。</li><li>校验客户名称、合同金额、附件合计及报价金额。</li><li>导出可编辑 Word，修改后的最终确认版须回传归档。</li><li>签字盖章版本上传后，历史文件不得覆盖或删除。</li></ol>` }
  };
  const d = docs[state.activeSop];
  return `${pageHead("岗位职责与 SOP", "按岗位、业务阶段和关键词查询已发布的内部规范", `<button class="button" data-action="export-word">导出可编辑 Word</button>`)}
    <div class="card filters"><input class="control grow" id="sop-search" placeholder="搜索岗位、阶段或关键词" /><select class="control"><option>全部岗位</option><option>售前人员</option><option>部门负责人</option></select><select class="control"><option>全部阶段</option><option>客户跟进</option><option>软件调研</option><option>报价审批</option></select></div>
    <div class="sop-layout"><aside class="card sop-menu">${Object.entries(docs).map(([k,v])=>`<button class="${state.activeSop===k?"active":""}" data-sop="${k}"><strong>${k}</strong><br><small>${v.stage} · ${v.version}</small></button>`).join("")}</aside><article class="card document">${d.body}<p><span class="tag green">已发布</span>　版本：${d.version}　发布时间：2026-08-20　更新说明：原型演示内容</p><div class="notice" style="margin-top:18px">普通用户只读；正式内容由管理员维护并保留发布版本。</div></article></div>`;
}

function render() {
  renderNav();
  const profile = roleProfiles[state.role];
  document.querySelector("#current-user-name").textContent = profile.name;
  document.querySelector("#current-user-role").textContent = profile.role;
  document.querySelector(".avatar").textContent = profile.avatar;
  document.querySelector("#role-note").textContent = profile.note;
  document.querySelector("#role-switch").value = state.role;
  const pages = { dashboard:renderDashboard, customers:renderCustomers, "customer-detail":renderCustomerDetail, reminders:renderReminders, map:renderMap, research:renderResearch, quotes:renderQuotes, contracts:renderContracts, sop:renderSop };
  document.querySelector("#app").innerHTML = (pages[state.page] || renderDashboard)();
}

function showToast(message) {
  const el = document.createElement("div"); el.className = "toast"; el.textContent = message;
  document.querySelector("#toast-root").append(el); setTimeout(()=>el.remove(), 3200);
}

function closeModal() { document.querySelector("#modal-root").innerHTML = ""; }
function showModal(title, body, submitLabel="保存", onSubmit=null) {
  document.querySelector("#modal-root").innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-label="${title}"><div class="modal-head"><h2>${title}</h2><button class="modal-close" data-action="close-modal" aria-label="关闭">×</button></div><div class="modal-body">${body}</div><div class="modal-foot"><button class="button" data-action="close-modal">取消</button><button class="button primary" id="modal-submit">${submitLabel}</button></div></section></div>`;
  document.querySelector(".modal").addEventListener("click", e=>e.stopPropagation());
  document.querySelector("#modal-submit").addEventListener("click", ()=>{ if (onSubmit) onSubmit(); else { closeModal(); showToast(`${title}已保存（原型模拟）`); } });
  setTimeout(()=>document.querySelector(".modal input, .modal textarea, .modal select")?.focus(), 0);
}

function followupModal() {
  showModal("新增跟进与提醒", `<div class="form-grid"><div class="field full"><label class="required">关联客户</label><select><option>东湾示例制造有限公司</option><option>北辰样板装备有限公司</option></select></div><div class="field"><label class="required">跟进方式</label><select><option>电话</option><option>微信</option><option>现场</option><option>会议</option><option>邮件</option></select></div><div class="field"><label class="required">跟进时间</label><input type="datetime-local" value="2026-08-24T10:30"></div><div class="field full"><label class="required">沟通内容</label><textarea placeholder="记录本次沟通的事实内容"></textarea></div><div class="field full"><label>客户反馈</label><textarea></textarea></div><div class="field full"><label class="required">下一步行动</label><input value="发送调研准备清单"></div><div class="field"><label><input type="checkbox" id="with-reminder" checked> 同时设置提醒</label></div><div class="field"><label>提醒时间</label><input type="datetime-local" value="2026-08-25T15:00"></div></div>`, "保存跟进", ()=>{closeModal();showToast("跟进记录已保存，并创建下一步提醒（原型模拟）");});
}

function reminderModal() {
  showModal("新建提醒", `<div class="form-grid"><div class="field full"><label class="required">关联客户</label><select><option>东湾示例制造有限公司</option><option>北辰样板装备有限公司</option></select></div><div class="field full"><label class="required">提醒事项</label><input placeholder="输入要处理的事项"></div><div class="field"><label class="required">提醒时间</label><input type="datetime-local" value="2026-08-25T15:00"></div><div class="field"><label>优先级</label><select><option>中</option><option>高</option><option>低</option></select></div><div class="field full"><label>备注</label><textarea></textarea></div></div>`);
}

function customerModal() {
  showModal("新增客户", `<div class="form-grid"><div class="field full"><label class="required">客户名称</label><input placeholder="仅输入内部业务客户，原型请使用虚构名称"></div><div class="field"><label>客户来源</label><select><option>销售推荐</option><option>展会</option><option>网络</option></select></div><div class="field"><label>客户状态</label><select><option>初期接洽</option><option>现场调研</option></select></div><div class="field"><label>行业</label><input></div><div class="field"><label>所在区域</label><select><option>华东</option><option>华北</option><option>华南</option></select></div><div class="field full"><label class="required">客户需求</label><textarea></textarea></div></div>`);
}

document.addEventListener("click", e => {
  const pageEl = e.target.closest("[data-page]"); if (pageEl) { e.preventDefault(); setPage(pageEl.dataset.page); return; }
  const customerEl = e.target.closest("[data-customer]"); if (customerEl) { e.preventDefault(); state.selectedCustomer=Number(customerEl.dataset.customer);state.customerTab="overview";setPage("customer-detail");return; }
  const tab = e.target.closest("[data-tab]"); if (tab) { state.customerTab=tab.dataset.tab;render();return; }
  const view = e.target.closest("[data-view]"); if (view) { state.customerView=view.dataset.view;render();return; }
  const sop = e.target.closest("[data-sop]"); if (sop) { state.activeSop=sop.dataset.sop;render();return; }
  const pin = e.target.closest("[data-pin]"); if (pin) {
    const c=customers.find(x=>x.id===Number(pin.dataset.pin)); const pop=document.querySelector("#map-popover");
    pop.classList.remove("hidden"); pop.style.left=`min(${Math.max(3,c.x-8)}%, calc(100% - 230px))`; pop.style.top=`${Math.min(72,c.y+3)}%`; pop.innerHTML=`<h3>${c.name}</h3><p>状态：${c.status}</p><p>负责人：${c.owner}</p><p>最近跟进：${c.recent}</p><button class="text-button" data-customer="${c.id}">查看详情 →</button>`; return;
  }
  const a = e.target.closest("[data-action]"); if (!a) return;
  const action = a.dataset.action;
  if (action === "new-followup") followupModal();
  if (action === "new-reminder") reminderModal();
  if (action === "new-customer") customerModal();
  if (action === "close-modal") closeModal();
  if (action === "go-reminders") setPage("reminders");
  if (action === "export-word") showToast("已加入“可编辑 Word”导出任务（原型不生成实际文件）");
  if (action === "import-preview") showModal("历史客户导入预览", `<div class="notice">原型仅演示流程，不读取真实 Excel 文件。</div><ol><li>字段映射</li><li>格式校验</li><li>重复客户检查</li><li>确认导入并输出失败清单</li></ol>`, "确认演示");
  if (action === "edit-placeholder") showToast("已进入编辑状态（低保真原型占位）");
  if (action === "copy-research") showToast("已复制历史调研为新草稿，并保留原模板版本");
  if (action === "complete-research") { state.researchStatus="已完成";render();showToast("调研已完成确认，可供报价引用"); }
  if (action === "copy-quote") { state.quoteVersion="V1.1";state.quoteStatus="草稿";render();showToast("已复制为 V1.1 草稿，原审批版本保留"); }
  if (action === "approve-quote") { state.quoteStatus=state.role==="manager"?"待副总经理审核":"审批完成";render();showToast(state.role==="manager"?"一级审批通过，已提交副总经理":"终审通过，报价版本已锁定"); }
  if (action === "reject-quote") showModal("退回报价", `<div class="field"><label class="required">退回意见</label><textarea id="reject-reason" placeholder="退回时必须填写具体意见"></textarea><small>审批人不能直接修改报价内容。</small></div>`, "确认退回", ()=>{const reason=document.querySelector("#reject-reason").value.trim();if(!reason){showToast("请填写退回意见");return;}state.quoteStatus=state.role==="manager"?"部门负责人退回":"副总经理退回";closeModal();render();showToast("报价已退回编制人，意见已记录");});
  if (action === "complete-reminder") { a.closest("[data-reminder-row]")?.remove(); showToast("提醒已完成，操作已记录"); }
  if (action === "postpone") showModal("延期提醒", `<div class="field"><label class="required">新提醒时间</label><input type="datetime-local" value="2026-08-26T15:00"><small>系统将保留原提醒时间。</small></div>`, "确认延期");
  if (action === "generate-contract") showToast("合同已生成并保留原始 Word 版本（原型模拟）");
});

document.addEventListener("input", e => {
  if (e.target.id === "customer-filter") { state.customerFilter=e.target.value; }
  if (e.target.matches("[data-autosave]")) { const label=document.querySelector("#autosave-label"); if(label){label.textContent="正在保存草稿…";setTimeout(()=>label.textContent="✓ 草稿已自动保存（原型模拟）",500);} }
});

document.addEventListener("change", e => {
  if (e.target.id === "contract-qty" || e.target.id === "contract-price") { state.contractQty=Number(document.querySelector("#contract-qty").value)||0;state.contractPrice=Number(document.querySelector("#contract-price").value)||0;render(); }
  if (e.target.id === "role-switch") { state.role=e.target.value;state.page="dashboard";state.customerTab="overview";location.hash="dashboard";render();showToast(`已切换为${roleProfiles[state.role].role}视角`); }
  if (e.target.id === "map-owner") document.querySelectorAll(".map-pin").forEach(p=>p.classList.toggle("hidden",!!e.target.value&&p.dataset.owner!==e.target.value));
});

document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); if (e.key === "Enter" && e.target.id === "customer-filter") render(); });
document.querySelector("#menu-button").addEventListener("click", ()=>document.querySelector(".sidebar").classList.toggle("open"));
document.querySelector("#global-search").addEventListener("keydown", e=>{ if(e.key==="Enter"){state.customerFilter=e.target.value.trim();setPage("customers");} });
window.addEventListener("hashchange", ()=>{const p=location.hash.slice(1);if(p&&p!==state.page){state.page=p;render();}});
render();
