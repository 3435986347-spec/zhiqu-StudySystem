// 后台四页（监管后台、账号管理、反馈管理、共享计划审核）—— 第三十一轮从 zhiqu-api.js 挪过来的页面模块（方案第 4 步的第二块）。
//
// 页面模块的形状：导出 boots（页面文件名 → 启动函数），壳的 route() 在过了后台页的门（ZQUI.isAdminPage + 服务端角色）之后才 import 它，
// 所以普通用户直达后台页时连这个文件都不下载。用到的壳里的东西都从 zqShared 来：bind() 把它们解构成同名的局部变量 ——
// 这样挪过来的代码一个字不用改（api.get、esc(...)、$('#…') 照旧），而「用了壳没给的东西」由 SettingsDialogTest 的模块判据扫出来。
// 这几页本来就画在页面上（不是弹窗里），所以用壳的 $ / $all 在整页上找元素。
//
// 第七十七轮（界面打磨第 8 步的最后一段）：样子都在样式表（.zq-admin-* / .zq-acct-* / .zq-review-*），这里只管类、data-state 和 aria-*；
// 画各块的函数导出给 admin-check.js 在 node 里真跑（替身照接口真实的回包写）。

let api, esc, $, $all, empty, fmtDate, d10, safe, toast, askConfirm, askText, showInfo, openModal, planCategory, planCategoryOptions, freqLabel, icon, latestOnly;
export function bind(sh) {
  ({ api, esc, $, $all, empty, fmtDate, d10, safe, toast, askConfirm, askText, showInfo, openModal, planCategory, planCategoryOptions, freqLabel, icon, latestOnly } = sh);
}
/** 按钮提交着不重发（连点只发一次）；失败了 safe 说出来，按钮放开可以再点（第七十七轮：反馈的关闭、账号的启用 / 禁用、审核的通过 / 下架原来连点就发几次） */
function once(button, name, fn) {
  if (button.disabled) return;
  button.disabled = true;
  safe(name, fn).finally(function () { button.disabled = false; });
}
let feedbackList = [];       // 原来是壳的 state.feedback —— 只有反馈管理用
let feedbackFilter = 'all';  // 关掉一条之后照原来的筛选重画（原来整个筛选条重建、回到「全部」）

export const boots = {
  'admin.html': (sh) => { bind(sh); return bootAdmin(); },
  'account-admin.html': (sh) => { bind(sh); return bootAccountAdmin(); },
  'feedback-admin.html': (sh) => { bind(sh); return bootFeedbackAdmin(); },
  'shared-plan-admin.html': (sh) => { bind(sh); return bootSharedPlanAdmin(); }
};

// ── 监管后台 ────────────────────────────────────────────────

/**
 * 六个数，都是接口真有的字段（第七十七轮）：原来有三个读 traffic.todayRequests / aiRequests / rateLimited —— 接口从来没有，永远是 0。
 * 颜色看数据：开放反馈 > 0 才强调、运行异常 > 0 才红（原来不管是不是 0 都是红的）。
 * errorCount、averageLatencyMs 统计的是流量监控里最近 totalRecorded 个请求（它只留最近 800 个）。
 */
export function adminMetrics(overview) {
  var t = (overview && overview.traffic) || {};
  var n = function (v) { return Number(v) || 0; };
  var recent = '最近 ' + n(t.totalRecorded) + ' 个请求';
  return [
    { label: '注册用户', value: n(overview.userCount), note: '总量', state: '' },
    { label: '开放反馈', value: n(overview.feedbackOpenCount), note: '待处理', state: n(overview.feedbackOpenCount) ? 'attention' : '' },
    { label: '运行异常', value: n(overview.runtimeIssueOpenCount), note: '待处理', state: n(overview.runtimeIssueOpenCount) ? 'bad' : '' },
    { label: '近 15 分钟请求', value: n(t.last15Minutes), note: '最近 1 分钟 ' + n(t.lastMinute), state: '' },
    { label: '出错的请求', value: n(t.errorCount), note: recent + '里', state: '' },
    { label: '平均耗时', value: n(t.averageLatencyMs) + ' ms', note: recent, state: '' }
  ];
}
export function metricCard(m) {
  return '<article class="zq-stat zq-admin-stat"' + (m.state ? ' data-state="' + m.state + '"' : '') + '><span class="zq-stat-label">' + esc(m.label) + '</span>'
    + '<strong class="zq-stat-num zq-num">' + esc(m.value) + '</strong><span class="zq-admin-stat-note">' + esc(m.note) + '</span></article>';
}
/** 近 15 分钟一分钟一根（后端补满了没有请求的分钟）：和专注统计同一套柱子 —— 有数的写数、零只留底线、高度是 --v */
export function trafficBars(buckets) {
  var keys = Object.keys(buckets || {});
  if (!keys.length) return empty('近 15 分钟暂无请求');
  var vals = keys.map(function (k) { return Number(buckets[k]) || 0; });
  var max = Math.max.apply(null, vals.concat([1]));
  return keys.map(function (k, i) {
    var v = vals[i];
    return '<div class="zq-bar' + (v ? '' : ' is-zero') + '" title="' + esc(k) + '：' + v + ' 次">'
      + '<span class="zq-bar-val zq-num">' + (v || '') + '</span>'
      + '<span class="zq-bar-fill" style="--v:' + (v / max).toFixed(3) + '"></span>'
      + '<span class="zq-bar-label">' + esc(k) + '</span></div>';
  }).join('');
}

async function bootAdmin() {
  var overview = await api.get('/admin/overview');
  var host = $('#zq-metrics');
  if (host) host.innerHTML = adminMetrics(overview).map(metricCard).join('');
  var bars = $('#zq-traffic');
  if (bars) bars.innerHTML = trafficBars((overview.traffic || {}).minuteBuckets);
  await bootAdminIssues();
  await bootAdminRag();
  var refresh = $('#zq-admin-refresh'); if (refresh) refresh.onclick = function () { safe('刷新后台', bootAdmin); };
}
async function bootAdminIssues() {
  var host = $('#zq-health');
  if (!host) return;
  var list = await api.get('/admin/runtime-issues?status=OPEN');
  host.innerHTML = list.slice(0, 8).map(function (i) {
    return '<div class="zq-admin-issue"><div class="zq-admin-issue-head"><strong>' + esc(i.category || i.severity || '异常') + '</strong><span class="zq-num">' + esc(fmtDate(i.createdAt)) + '</span></div>'
      + '<p>' + esc(i.message || '') + '</p></div>';
  }).join('') || empty('当前没有开放异常');
}
async function bootAdminRag() {
  var host = $('#zq-rag-status');
  if (!host) return;
  var status;
  try {
    status = await api.get('/admin/rag/status');
  } catch (error) {
    host.innerHTML = '<div class="zq-empty">RAG 状态读取失败：' + esc(error.message || '未知错误') + '</div>';
    return;
  }
  var sidecar = status.sidecar || {}, active = status.activeGeneration || {};
  var jobs = status.jobs || {}, metrics = status.metrics || {};
  var deadJobs = Number(jobs.DEAD || 0) ? await api.get('/admin/rag/jobs?status=DEAD') : [];
  var generations = (status.generations || []).slice(0, 6);
  var expected = Number(active.expectedSourceCount || 0);
  var progress = expected ? Math.round(Number(active.indexedSourceCount || 0) / expected * 100) : 0;
  host.innerHTML = '<div class="zq-admin-tiles">'
    + ragMetric('服务状态', status.enabled ? (sidecar.ready ? '可用' : '未就绪') : '未启用', sidecar.ready ? 'ok' : 'warn')
    + ragMetric('活动索引', active.indexVersion || '尚未启用', '')
    + ragMetric('索引进度', active.id ? progress + '%' : '—', 'primary')
    + ragMetric('任务积压', Number(jobs.PENDING || 0) + Number(jobs.RETRY || 0), Number(jobs.DEAD || 0) ? 'bad' : '')
    + '</div><div class="zq-admin-facts">'
    + '<span>查询 P50：<b class="zq-num">' + esc(metrics.queryP50Ms == null ? '—' : metrics.queryP50Ms + ' ms') + '</b></span>'
    + '<span>查询 P95：<b class="zq-num">' + esc(metrics.queryP95Ms == null ? '—' : metrics.queryP95Ms + ' ms') + '</b></span>'
    + '<span>关键词降级：<b class="zq-num">' + esc(metrics.fallbackCount || 0) + '</b></span>'
    + '<span>越权候选丢弃：<b class="zq-num">' + esc(metrics.crossScopeDrops || 0) + '</b></span>'
    + '<span>DEAD：<b class="zq-num">' + esc(jobs.DEAD || 0) + '</b></span></div>'
    + (generations.length ? '<div class="zq-admin-list">' + generations.map(function (item) {
        var canActivate = item.status === 'READY' || item.status === 'RETIRED';
        var canDiscard = item.status === 'FAILED';
        return '<div class="zq-admin-line">'
          + '<span class="zq-num zq-admin-line-id">#' + esc(item.id) + '</span><strong>' + esc(item.status) + '</strong>'
          + '<span class="zq-admin-line-text">' + esc(item.indexVersion || '') + ' · ' + esc(item.indexedSourceCount || 0) + '/' + esc(item.expectedSourceCount || 0) + '</span>'
          + (canActivate ? '<button type="button" class="zq-btn-ghost zq-btn-xs" data-rag-activate="' + esc(item.id) + '">' + (item.status === 'RETIRED' ? '回滚' : '启用') + '</button>' : '')
          + (canDiscard ? '<button type="button" class="zq-btn-ghost zq-btn-xs is-danger" data-rag-discard="' + esc(item.id) + '">丢弃</button>' : '') + '</div>';
      }).join('') + '</div>' : '')
    + (deadJobs.length ? '<details class="zq-admin-dead"><summary>失败任务（' + deadJobs.length + '）</summary><div>' + deadJobs.slice(0, 10).map(function (job) {
        return '<div class="zq-admin-line"><span class="zq-num">#' + esc(job.id) + '</span><span class="zq-admin-line-text">' + esc(job.operation) + ' · ' + esc(job.lastError || '未知错误') + '</span>'
          + '<button type="button" class="zq-btn-ghost zq-btn-xs" data-rag-retry="' + esc(job.id) + '">重试</button></div>';
      }).join('') + '</div></details>' : '')
    + '<div class="zq-admin-btns"><button type="button" class="zq-btn-ghost zq-sm" id="zq-rag-refresh">刷新状态</button>'
    + '<button type="button" class="zq-btn-ghost zq-sm" id="zq-rag-rebuild">新建重建代次</button></div>';
  var refresh = $('#zq-rag-refresh');
  if (refresh) refresh.onclick = function () { safe('刷新 RAG 状态', bootAdminRag); };
  var rebuild = $('#zq-rag-rebuild');
  if (rebuild) rebuild.onclick = async function () {
    if (!await askConfirm({ title: '重建语义索引', message: '系统会创建新索引代次，当前活动索引会继续提供服务。确认开始？', okText: '开始重建' })) return;
    safe('创建重建任务', async function () { await api.post('/admin/rag/rebuild', {}); toast('已创建重建代次'); await bootAdminRag(); });
  };
  $all('[data-rag-activate]', host).forEach(function (button) {
    button.onclick = function () { safe('启用索引代次', async function () { await api.post('/admin/rag/generations/' + button.dataset.ragActivate + '/activate', {}); toast('索引代次已启用'); await bootAdminRag(); }); };
  });
  $all('[data-rag-retry]', host).forEach(function (button) {
    button.onclick = function () { safe('重试索引任务', async function () { await api.post('/admin/rag/jobs/' + button.dataset.ragRetry + '/retry', {}); toast('任务已重新排队'); await bootAdminRag(); }); };
  });
  $all('[data-rag-discard]', host).forEach(function (button) {
    button.onclick = async function () {
      if (!await askConfirm({ title: '丢弃失败索引', message: '将删除该失败代次已生成的向量数据，且不能恢复。确认继续？', okText: '确认丢弃' })) return;
      safe('丢弃失败索引代次', async function () {
        await api.post('/admin/rag/generations/' + button.dataset.ragDiscard + '/discard', {});
        toast('失败索引已进入清理队列');
        await bootAdminRag();
      });
    };
  });
}
function ragMetric(label, value, state) {
  return '<div class="zq-admin-tile"><span>' + esc(label) + '</span><strong' + (state ? ' data-state="' + state + '"' : '') + '>' + esc(value) + '</strong></div>';
}

// ── 反馈管理 ────────────────────────────────────────────────

/** 筛选：全部 / 待处理（OPEN，没写状态的也算）/ 已关闭 */
export function feedbackShown(list, filter) {
  return (list || []).filter(function (f) {
    var status = String(f.status || 'OPEN').toUpperCase();
    return filter === 'all' ? true : status === filter;
  });
}
export function feedbackCard(f) {
  var open = String(f.status || 'OPEN').toUpperCase() !== 'CLOSED';
  return '<article class="zq-card zq-feedback"><div class="zq-feedback-head">'
    + '<span class="zq-badge" data-state="' + (open ? 'open' : 'closed') + '">' + (open ? '待处理' : '已关闭') + '</span>'
    + '<strong>' + esc(f.nickname || f.username || ('用户 #' + (f.userId || ''))) + '</strong><span class="zq-num">' + esc(fmtDate(f.createdAt)) + '</span>'
    + (open ? '<button type="button" class="zq-btn-ghost zq-btn-xs" data-close-feedback="' + esc(f.id) + '">关闭</button>' : '') + '</div>'
    + '<p>' + esc(f.content || '') + '</p></article>';
}
async function bootFeedbackAdmin() {
  feedbackList = await api.get('/admin/feedback');
  // 筛选条写在页面里（.zq-seg），这里只接上、写个数（原来每次载入都重建一遍，关掉一条就回到「全部」）
  $all('#zq-filters [data-fb]').forEach(function (b) {
    b.onclick = function () { feedbackFilter = b.dataset.fb; renderFeedbackList(); };
  });
  renderFeedbackList();
}
function renderFeedbackList() {
  var all = feedbackList || [];
  $all('#zq-filters [data-fb]').forEach(function (b) {
    b.setAttribute('aria-pressed', b.dataset.fb === feedbackFilter ? 'true' : 'false');
    var count = b.querySelector('.zq-seg-count');
    if (count) count.textContent = feedbackShown(all, b.dataset.fb).length;
  });
  var host = $('#zq-list'); if (!host) return;
  host.innerHTML = feedbackShown(all, feedbackFilter).map(feedbackCard).join('') || empty(feedbackFilter === 'CLOSED' ? '还没有关闭的反馈' : '暂无反馈');
  $all('[data-close-feedback]', host).forEach(function (b) {
    // 走 safe：失败了要说（原来没接，失败只落到壳的 unhandledrejection）
    b.onclick = function () {
      once(b, '关闭反馈', async function () {
        await api.put('/admin/feedback/' + b.dataset.closeFeedback + '/close');
        feedbackList = await api.get('/admin/feedback');
        renderFeedbackList();
      });
    };
  });
}

// ── 账号管理 ────────────────────────────────────────────────

/**
 * 一行账号。列宽只写在样式表的 .zq-acct-row 一处（表头和行同一个类），都是定宽 —— 表头和每一行是各自的网格，按内容宽就各算各的、表头对不上列；
 * 操作那一列原来给了 128px，三个按钮要 168px，右对齐之后往左溢出，盖住了日期。那一列原来叫「最近活跃」、写的是 updatedAt（资料最后一次改），现在是「注册于」。
 * 手机上一行叠成几行（样式表的 @media），不横着滚；表头藏起来，日期前面由样式表补上「注册于」。
 */
export function accountRow(u) {
  var disabled = Number(u.status) === 0;
  var admin = u.role === 'ADMIN';
  var id = esc(u.id);
  return '<div class="zq-acct-row' + (disabled ? ' is-off' : '') + '">'
    + '<div class="zq-acct-who"><span class="zq-acct-avatar">' + esc((u.nickname || u.username || '知').slice(0, 1)) + '</span><span class="zq-acct-name">' + esc(u.nickname || u.username) + '</span></div>'
    + '<span class="zq-acct-mail">' + esc(u.email || u.username) + '</span>'
    + '<span><span class="zq-badge" data-state="' + (admin ? 'admin' : 'user') + '">' + (admin ? '管理员' : '普通用户') + '</span></span>'
    + '<span class="zq-acct-status" data-state="' + (disabled ? 'off' : 'on') + '">' + (disabled ? '已禁用' : '正常') + '</span>'
    + '<span class="zq-num zq-acct-meta">' + esc(u.achievementPoints || 0) + ' 点</span>'
    + '<span class="zq-num zq-acct-meta zq-acct-joined" title="注册于 ' + esc(fmtDate(u.createdAt)) + '">' + esc(d10(u.createdAt)) + '</span>'
    + '<span class="zq-acct-acts"><button type="button" class="zq-btn-ghost zq-btn-xs" data-reset-user="' + id + '">重置密码</button>'
    + '<button type="button" class="zq-btn-ghost zq-btn-xs" data-toggle-user="' + id + '" data-next="' + (disabled ? 1 : 0) + '">' + (disabled ? '启用' : '禁用') + '</button>'
    + '<button type="button" class="zq-btn-ghost zq-btn-xs is-danger" data-delete-user="' + id + '">删除</button></span></div>';
}
let accountQuery = { keyword: '', role: '' };
async function bootAccountAdmin() {
  var searchInput = $('#zq-acct-search'), roleSel = $('#zq-acct-role'), queryBtn = $('#zq-acct-query');
  var query = function () { accountQuery = { keyword: searchInput ? searchInput.value.trim() : '', role: roleSel ? roleSel.value : '' }; return loadAccounts(); };
  if (queryBtn) queryBtn.onclick = function () { safe('查询账号', query); };
  if (searchInput) searchInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); safe('查询账号', query); } });
  await loadAccounts();
}
async function loadAccounts() {
  var host = $('#zq-rows'); if (!host) return;
  // 只画最后一次查询的结果：连按回车、改了条件马上又查，先发的那次晚回来不盖掉后发的
  var current = latestOnly('accounts');
  var qs = 'page=1&size=100';
  if (accountQuery.keyword) qs += '&keyword=' + encodeURIComponent(accountQuery.keyword);
  if (accountQuery.role) qs += '&role=' + encodeURIComponent(accountQuery.role);
  var list = await api.get('/admin/users?' + qs);
  if (!current()) return;
  var records = list.records || [];
  host.innerHTML = records.map(accountRow).join('') || empty(accountQuery.keyword || accountQuery.role ? '没有符合条件的账号' : '暂无账号');
  // 个数单独一处（原来写进表下那一格，把「禁用后该账号无法登录，数据保留」盖掉了）
  var count = $('#zq-acct-count');
  if (count) count.textContent = '共 ' + (list.total || records.length) + ' 个账号';
  $all('[data-delete-user]', host).forEach(function (b) { b.onclick = async function () { if (await askConfirm({ title: '删除账号', message: '确认删除该账号？其数据将按软删除规则处理。', okText: '删除', danger: true })) safe('删除账号', async function () { await api.del('/admin/users/' + b.dataset.deleteUser); await loadAccounts(); }); }; });
  $all('[data-toggle-user]', host).forEach(function (b) {
    b.onclick = function () { once(b, '更新状态', async function () { await api.put('/admin/users/' + b.dataset.toggleUser + '/status?status=' + b.dataset.next); await loadAccounts(); }); };
  });
  $all('[data-reset-user]', host).forEach(function (b) { b.onclick = async function () { if (await askConfirm({ title: '重置密码', message: '重置该账号密码为随机临时密码？原密码将立即失效。', okText: '重置' })) safe('重置密码', async function () { var res = await api.post('/admin/users/' + b.dataset.resetUser + '/reset-password', {}); var pw = res && res.tempPassword ? res.tempPassword : '(已重置)'; await showInfo({ title: '密码已重置', html: '<p class="zq-admin-note">临时密码（请复制并转交用户，登录后尽快修改）：</p><div class="zq-mono zq-admin-secret">' + esc(pw) + '</div>' }); }); }; });
}

// ── 共享计划审核 ──────────────────────────────────────────────

/** 状态的人话（详情标题原来写代码 PENDING） */
export const PLAN_STATUS_NAMES = { PENDING: '待审核', APPROVED: '已发布', OFFLINE: '已下架', REJECTED: '已驳回' };
/**
 * 分类名：接口给的名字 → 壳里分类表 → 认不出的写「其他」。分类表里找不到的 key，接口把代码原样当名字回来（categoryName = 'OTHER'），
 * 原来就照写出了「OTHER」：名字和代码一样的不算名字。
 */
export function planCategoryName(p) {
  var fromApi = p.categoryName && p.categoryName !== p.category ? p.categoryName : '';
  return fromApi || (planCategory(p.category) || [])[1] || '其他';
}
export function reviewCard(p, actions, dim) {
  var creator = (p.creator && (p.creator.nickname || p.creator.username)) || p.creatorNickname || p.username || '匿名';
  return '<article class="zq-card zq-review' + (dim ? ' is-dim' : '') + '">'
    + '<div class="zq-review-head"><span class="zq-badge">' + esc(planCategoryName(p)) + '</span><span class="zq-num">' + esc(fmtDate(p.createdAt)) + '</span></div>'
    + '<h3><button type="button" class="zq-review-title" data-sp-view="' + esc(p.id) + '" title="点击查看完整内容">' + esc(p.title || p.name || '未命名') + '<span>查看' + icon('chevron-right') + '</span></button></h3>'
    + '<p>' + esc(p.description || '（无简介）') + '</p>'
    + '<div class="zq-review-foot"><span>' + esc(creator) + '</span><span class="zq-review-acts">' + actions + '</span></div></article>';
}
async function bootSharedPlanAdmin() {
  var list = await api.get('/admin/shared-plans');
  var host = $('#zq-reviews');
  if (!host) return;
  var groups = { PENDING: [], APPROVED: [], OFFLINE: [], REJECTED: [] };
  (list || []).forEach(function (p) { (groups[String(p.status || '').toUpperCase()] || (groups.PENDING)).push(p); });
  var pendEl = $('#zq-pending');
  if (pendEl) pendEl.textContent = '待审核 ' + groups.PENDING.length + ' 个 · 已发布 ' + groups.APPROVED.length + ' 个';
  var btn = function (attr, id, label, tone) { return '<button type="button" class="zq-btn-ghost zq-btn-xs' + (tone ? ' is-' + tone : '') + '" ' + attr + '="' + esc(id) + '">' + label + '</button>'; };
  function section(title, items, render) {
    if (!items.length) return '';
    return '<h2 class="zq-review-section">' + title + ' · ' + items.length + '</h2>' + items.map(render).join('');
  }
  var html = '';
  html += section('待审核', groups.PENDING, function (p) {
    return reviewCard(p, btn('data-sp-ok', p.id, '通过', 'ok') + btn('data-sp-no', p.id, '驳回', 'danger'));
  });
  html += section('已发布', groups.APPROVED, function (p) {
    return reviewCard(p, btn('data-sp-edit', p.id, '修改') + btn('data-sp-down', p.id, '下架', 'warn'));
  });
  html += section('已下架', groups.OFFLINE, function (p) {
    return reviewCard(p, btn('data-sp-ok', p.id, '重新发布', 'ok') + btn('data-sp-edit', p.id, '修改') + btn('data-sp-del', p.id, '删除', 'danger'), true);
  });
  html += section('已驳回', groups.REJECTED, function (p) {
    return reviewCard(p, btn('data-sp-ok', p.id, '通过', 'ok') + btn('data-sp-del', p.id, '删除', 'danger'), true);
  });
  host.innerHTML = html || empty('暂无共享计划');
  $all('[data-sp-ok]', host).forEach(function (b) { b.onclick = function () { once(b, '通过', async function () { await api.put('/admin/shared-plans/' + b.dataset.spOk + '/review?action=APPROVE'); toast('已通过发布'); await bootSharedPlanAdmin(); }); }; });
  $all('[data-sp-no]', host).forEach(function (b) { b.onclick = async function () { var note = await askText({ title: '驳回共享计划', label: '驳回原因（可选，将展示给提交者）', textarea: true, okText: '驳回' }); if (note === null) return; safe('驳回', async function () { await api.put('/admin/shared-plans/' + b.dataset.spNo + '/review?action=REJECT&note=' + encodeURIComponent(note || '')); toast('已驳回'); await bootSharedPlanAdmin(); }); }; });
  $all('[data-sp-down]', host).forEach(function (b) { b.onclick = function () { once(b, '下架', async function () { await api.put('/admin/shared-plans/' + b.dataset.spDown + '/review?action=TAKEDOWN'); toast('已下架'); await bootSharedPlanAdmin(); }); }; });
  $all('[data-sp-del]', host).forEach(function (b) { b.onclick = async function () { if (!await askConfirm({ title: '删除共享计划', message: '确定删除该共享计划？此操作不可恢复。', okText: '删除', danger: true })) return; safe('删除', async function () { await api.del('/admin/shared-plans/' + b.dataset.spDel); toast('已删除'); await bootSharedPlanAdmin(); }); }; });
  $all('[data-sp-edit]', host).forEach(function (b) { b.onclick = function () { editSharedPlan(b.dataset.spEdit); }; });
  $all('[data-sp-view]', host).forEach(function (t) { t.onclick = function () { viewSharedPlan(t.dataset.spView); }; });
}
function viewSharedPlan(id) {
  safe('计划详情', async function () {
    var d = await api.get('/admin/shared-plans/' + id);
    var itemRow = function (x, extra) {
      return '<div class="zq-review-item"><strong>' + esc(x.title || '') + '</strong>'
        + (x.description ? '<p>' + esc(x.description) + '</p>' : '')
        + '<span class="zq-num">' + esc(extra) + '</span></div>';
    };
    var tasks = (d.tasks || []).map(function (t) {
      return itemRow(t, '第' + (t.relativeStartDay == null ? 0 : t.relativeStartDay) + '天起 · 截止第' + (t.relativeDeadlineDay == null ? '—' : t.relativeDeadlineDay) + '天' + (t.preferredTime ? ' · ' + t.preferredTime : '') + (t.durationMinutes ? ' · ' + t.durationMinutes + '分钟' : ''));
    }).join('');
    var routines = (d.routines || []).map(function (r) {
      return itemRow(r, freqLabel(r.frequency, r.daysOfWeek) + (r.preferredTime ? ' · ' + r.preferredTime : '') + (r.durationMinutes ? ' · ' + r.durationMinutes + '分钟' : '') + ' · 第' + (r.relativeStartDay == null ? 0 : r.relativeStartDay) + '~' + (r.relativeEndDay == null ? '—' : r.relativeEndDay) + '天');
    }).join('');
    var reviews = (d.reviews || []).map(function (rv) {
      return '<div class="zq-review-log"><span class="zq-num">' + esc(fmtDate(rv.createdAt)) + '</span> ' + esc(rv.action || '') + (rv.note ? ' · ' + esc(rv.note) : '') + '</div>';
    }).join('');
    function sec(t, body) { return body ? '<h4 class="zq-review-sec">' + t + '</h4><div class="zq-review-items">' + body + '</div>' : ''; }
    var status = String(d.status || '').toUpperCase();
    openModal({
      // openModal 自己转义标题；状态写人话（原来是代码 PENDING）
      title: (d.title || '共享计划') + ' · ' + (PLAN_STATUS_NAMES[status] || status || '未知状态'),
      width: '560px',
      bodyHtml:
        '<p class="zq-review-desc">' + esc(d.description || '（无简介）') + '</p>'
        + '<div class="zq-review-meta">' + esc(planCategoryName(d)) + (d.targetAudience ? ' · 适用：' + esc(d.targetAudience) : '') + ' · ' + (d.likeCount || 0) + ' 个赞' + ' · 套用 ' + (d.applyCount || 0) + '</div>'
        + sec('一次性任务 · ' + (d.tasks || []).length, tasks || '')
        + sec('例行计划 · ' + (d.routines || []).length, routines || '')
        + sec('审核记录', reviews || '')
        + '<div class="zq-modal-actions"><button type="button" class="zq-btn" data-view-close>关闭</button></div>',
      onMount: function (b, h) { $('[data-view-close]', b).onclick = h.close; }
    });
  });
}
function editSharedPlan(id) {
  safe('加载共享计划', async function () {
    var d = await api.get('/admin/shared-plans/' + id);
    var catOptions = planCategoryOptions(d.category);
    openModal({
      title: '修改共享计划',
      width: '520px',
      bodyHtml:
        '<div class="zq-field"><label class="zq-label" for="zq-sp-title">标题</label><input id="zq-sp-title" class="zq-input" value="' + esc(d.title || '') + '"></div>'
        + '<div class="zq-field"><label class="zq-label" for="zq-sp-cat">分类</label><select id="zq-sp-cat" class="zq-select">' + catOptions + '</select></div>'
        + '<div class="zq-field"><label class="zq-label" for="zq-sp-desc">简介</label><textarea id="zq-sp-desc" class="zq-textarea zq-review-textarea">' + esc(d.description || '') + '</textarea></div>'
        + '<div class="zq-field"><label class="zq-label" for="zq-sp-aud">适用人群（可选）</label><input id="zq-sp-aud" class="zq-input" value="' + esc(d.targetAudience || '') + '"></div>'
        + '<div class="zq-modal-actions"><button type="button" class="zq-btn-ghost" id="zq-sp-cancel">取消</button><button type="button" class="zq-btn" id="zq-sp-save">保存</button></div>',
      onMount: function (bd, h) {
        $('#zq-sp-cancel', bd).onclick = h.close;
        $('#zq-sp-save', bd).onclick = function () {
          var title = $('#zq-sp-title', bd).value.trim(); if (!title) return toast('请填写标题', 'error');
          safe('保存共享计划', async function () {
            await api.put('/admin/shared-plans/' + id, { title: title, category: $('#zq-sp-cat', bd).value, description: $('#zq-sp-desc', bd).value, targetAudience: $('#zq-sp-aud', bd).value });
            h.close(); toast('已保存'); await bootSharedPlanAdmin();
          });
        };
      }
    });
  });
}
