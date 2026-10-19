// 后台四页的行为判据（第七十七轮，界面打磨第 8 步的最后一段）—— 直接 import 发布的 assets/pages/admin.js，壳的东西用替身。
//
//   用法：node src/test/resources/js/admin-check.js <assets/pages/admin.js 的路径>
//   退出码 0 = 全绿；非 0 = 有判据红了，逐条打印在上面。由 AdminLookTest 调用。
//
// 替身照接口真实的回包写（第六十九轮的教训：Wiki 健康检查的替身返回后端从来没有的 issues，判据和实现一起错了许多轮）——
// 下面的 OVERVIEW / FEEDBACK / USERS / PLAN 是第七十七轮从验证库里真取回来的样子（字段一个不改，只删了用不到的长列表）。钉的是：
//   1 六个数只用接口真有的字段（原来三个读 todayRequests / aiRequests / rateLimited，永远是 0）；颜色看数据
//   2 请求量的柱子：零只留底线、有数的写数、高度是 --v
//   3 反馈：筛选写个数、按下的是 aria-pressed；「关闭」走 safe、提交着不重发、关完照原来的筛选重画
//   4 账号：一行里没有内联样式、写「注册于」的日期、删除是危险色；连着查两次，先发的晚回来不盖掉后发的
//   5 共享计划：认不出的分类写「其他」（接口把代码原样当名字回来）、状态写人话
const path = require('path');
const { pathToFileURL } = require('url');

let fail = 0, count = 0;
function judge(name, cond, detail) {
  count++;
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail !== undefined ? '  →  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); fail++; }
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── 真实回包（第七十七轮从验证库取的） ───────────────────────────
const OVERVIEW = {
  traffic: { totalRecorded: 286, lastMinute: 61, last15Minutes: 286, errorCount: 3, averageLatencyMs: 8, uniqueIpLastHour: 1,
    statusBuckets: { 200: 283, 400: 3 },
    minuteBuckets: { '09:36': 0, '09:37': 0, '09:38': 0, '09:39': 111, '09:40': 0, '09:41': 0, '09:42': 0, '09:43': 0, '09:44': 0, '09:45': 0, '09:46': 0, '09:47': 0, '09:48': 0, '09:49': 0, '09:50': 175 },
    hotPaths: [], recent: [] },
  userCount: 11, feedbackOpenCount: 15, runtimeIssueOpenCount: 0
};
const FEEDBACK = () => [
  { id: 13, userId: 9, username: 'r77chenl6tk0', nickname: '陈一', content: '看板的日历在窄窗口里日期会挤到一起，希望能换行显示。', status: 'OPEN', ipAddress: '127.0.0.1', userAgent: 'node', createdAt: '2026-10-19T09:39:40', updatedAt: '2026-10-19T09:39:40', deleted: 0 },
  { id: 14, userId: 10, username: 'r77wangl6tk0', nickname: '王二', content: '希望例行计划可以设置「每月第一个周一」这种规则。', status: 'OPEN', createdAt: '2026-10-19T09:39:40', updatedAt: '2026-10-19T09:39:40', deleted: 0 },
  { id: 2, userId: 3, username: 'narrow', nickname: null, content: '<img src=x onerror=alert(1)>', status: 'CLOSED', createdAt: '2026-09-28T13:38:00', updatedAt: '2026-09-28T13:38:00', deleted: 0 }
];
const USER = { id: 9, username: 'r77chenl6tk0', nickname: '陈一', role: 'USER', status: 1, email: 'r77chenl6tk0@example.com', avatar: null, achievementPoints: 10, totalStudyMinutes: 0, consecutiveDays: 0,
  feedbackCount: 2, feedbackOpenCount: 2, runtimeIssueCount: 0, runtimeIssueOpenCount: 0, createdAt: '2026-10-19T09:39:40', updatedAt: '2026-10-19T09:39:39' };
const PLAN_OTHER = { id: 1, title: '旧的计划', description: 'x', category: 'OTHER', categoryName: 'OTHER', targetAudience: '', status: 'APPROVED', applyCount: 0, likeCount: 0, liked: false,
  createdAt: '2026-09-28T13:38:00', creator: { id: 3, nickname: null, avatar: null, username: 'LRmum0rqzp' } };
const PLAN_MEETING = { id: 3, title: '每周例会准备', description: '例会前一天整理进展和风险', category: 'MEETING', categoryName: '会议与汇报', status: 'APPROVED', createdAt: '2026-10-19T09:39:41', creator: { id: 10, nickname: '王二', username: 'r77wangl6tk0' } };

// ── 假元素：够 admin.js 用的那几样 ─────────────────────────────
function el(props) {
  return Object.assign({
    innerHTML: '', textContent: '', value: '', disabled: false, dataset: {}, attrs: {}, onclick: null, listeners: {},
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    querySelector() { return null; }
  }, props || {});
}
/** 从一段 innerHTML 里找带某个 data-xxx 的元素，造成假按钮（同一段 HTML 每次找到同一批） */
function fromHtml(host, attr) {
  host._found = host._found || {};
  if (host._found[attr] && host._found[attr].html === host.innerHTML) return host._found[attr].els;
  const camel = attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const els = [...host.innerHTML.matchAll(new RegExp('<([a-z0-9]+)([^>]*?)\\s' + attr + '="([^"]*)"([^>]*)>', 'g'))].map((m) => {
    const tagAttrs = m[2] + ' ' + attr + '="' + m[3] + '"' + m[4];
    const dataset = {};
    for (const a of tagAttrs.matchAll(/data-([a-z-]+)="([^"]*)"/g)) dataset[a[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = a[2];
    return el({ dataset, tag: m[1] });
  });
  host._found[attr] = { html: host.innerHTML, els };
  return els;
}

(async () => {
  const m = await import(pathToFileURL(path.resolve(process.argv[2])).href);
  const latestSeq = {};
  const safeErrors = [];
  const calls = [];
  const dom = {};
  let api = {};
  const sh = {
    esc, empty: (t) => '<div class="zq-empty">' + esc(t) + '</div>',
    fmtDate: (v) => String(v || '').replace('T', ' ').slice(0, 16), d10: (v) => String(v || '').slice(0, 10),
    safe: async (name, fn) => { try { return await fn(); } catch (e) { safeErrors.push(name + '：' + e.message); } },
    toast() {}, askConfirm: async () => true, askText: async () => '', showInfo: async () => {}, openModal: (o) => { calls.push(['modal', o.title]); return { close() {} }; },
    planCategory: (k) => ({ PROJECT: ['PROJECT', '项目推进'], MEETING: ['MEETING', '会议与汇报'] })[k],
    planCategoryOptions: () => '', freqLabel: () => '每天', icon: (n) => '<svg data-i="' + n + '"></svg>',
    latestOnly: (key) => { const mine = (latestSeq[key] = (latestSeq[key] || 0) + 1); return () => latestSeq[key] === mine; },
    $: (sel, root) => (root ? null : dom[sel] || null),
    $all: (sel, root) => {
      if (root) { const a = /\[(data-[a-z-]+)\]/.exec(sel); return a ? fromHtml(root, a[1]) : []; }
      return dom[sel] || [];
    }
  };
  // admin.js 在 bind 时把 sh.api 解构成自己的变量：之后换替身（反馈 / 账号各一套）要经过这个外壳转发
  const apiShell = { get: (...a) => api.get(...a), put: (...a) => api.put(...a), post: (...a) => api.post(...a), del: (...a) => api.del(...a) };
  Object.defineProperty(sh, 'api', { value: apiShell });
  m.bind(sh);

  // 1 六个数
  const metrics = m.adminMetrics(OVERVIEW);
  const byLabel = Object.fromEntries(metrics.map((x) => [x.label, x]));
  judge('六个数都是接口真有的：近 15 分钟请求 = last15Minutes、出错的请求 = errorCount、平均耗时 = averageLatencyMs',
    byLabel['近 15 分钟请求'].value === 286 && byLabel['出错的请求'].value === 3 && byLabel['平均耗时'].value === '8 ms' && byLabel['注册用户'].value === 11, metrics);
  judge('不再摆三个永远是 0 的（今日请求 / AI 调用 / 限流拦截）', !metrics.some((x) => /今日请求|AI 调用|限流拦截/.test(x.label)) && metrics.length === 6, metrics.map((x) => x.label));
  judge('说明写清统计的范围：最近 1 分钟、最近 N 个请求', byLabel['近 15 分钟请求'].note === '最近 1 分钟 61' && byLabel['平均耗时'].note === '最近 286 个请求', metrics);
  judge('颜色看数据：开放反馈 15 → attention，运行异常 0 → 不上色', byLabel['开放反馈'].state === 'attention' && byLabel['运行异常'].state === '', metrics);
  judge('开放反馈 0 → 不上色（没有要处理的就不强调）', m.adminMetrics(Object.assign({}, OVERVIEW, { feedbackOpenCount: 0 })).find((x) => x.label === '开放反馈').state === '');
  judge('运行异常 > 0 → bad',m.adminMetrics(Object.assign({}, OVERVIEW, { runtimeIssueOpenCount: 2 })).find((x) => x.label === '运行异常').state === 'bad');
  const card = m.metricCard(byLabel['开放反馈']);
  judge('数字卡片：data-state、没有内联样式', card.includes('data-state="attention"') && !card.includes('style='), card);

  // 2 柱子
  const bars = m.trafficBars(OVERVIEW.traffic.minuteBuckets);
  judge('15 根柱子，一分钟一根', (bars.match(/class="zq-bar[" ]/g) || []).length === 15, bars.slice(0, 200));
  judge('零只留底线（is-zero、不写 0）、有数的写数', (bars.match(/zq-bar is-zero/g) || []).length === 13 && bars.includes('>175</span>') && !/zq-bar-val zq-num">0</.test(bars), bars.slice(0, 300));
  judge('高度是 --v（最高那根 1.000），没有别的内联样式', bars.includes('--v:1.000') && bars.includes('--v:0.634') && (bars.match(/style="/g) || []).length === 15 && !/style="(?!--v:)/.test(bars), bars.slice(0, 300));
  judge('没有桶：说「近 15 分钟暂无请求」', m.trafficBars({}).includes('近 15 分钟暂无请求'));

  // 3 反馈
  let list = FEEDBACK();
  let putCalls = [], releasePut = null, failNext = false;
  api = {
    get: async (url) => { calls.push(['get', url]); return JSON.parse(JSON.stringify(list)); },
    put: (url) => { putCalls.push(url); return new Promise((res, rej) => { releasePut = () => { if (failNext) { failNext = false; rej(new Error('网络断了')); } else { list = list.map((f) => (url.includes('/' + f.id + '/') ? Object.assign({}, f, { status: 'CLOSED' }) : f)); res(true); } }; }); }
  };
  const seg = ['all', 'OPEN', 'CLOSED'].map((k) => { const c = el(); const b = el({ dataset: { fb: k } }); b.querySelector = (q) => (q === '.zq-seg-count' ? c : null); b.count = c; return b; });
  const listHost = el();
  dom['#zq-filters [data-fb]'] = seg;
  dom['#zq-list'] = listHost;
  await m.boots['feedback-admin.html'](sh);
  judge('筛选写个数：全部 3、待处理 2、已关闭 1', seg.map((b) => b.count.textContent).join(',') === '3,2,1', seg.map((b) => b.count.textContent));
  judge('一开始按下的是「全部」（aria-pressed）', seg.map((b) => b.attrs['aria-pressed']).join(',') === 'true,false,false', seg.map((b) => b.attrs['aria-pressed']));
  judge('反馈的内容被转义', listHost.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;') && !listHost.innerHTML.includes('<img src=x'), listHost.innerHTML.slice(-200));
  seg[1].onclick();
  judge('点「待处理」：只剩两条、按下的换成它', (listHost.innerHTML.match(/class="zq-card zq-feedback"/g) || []).length === 2 && seg[1].attrs['aria-pressed'] === 'true' && seg[0].attrs['aria-pressed'] === 'false');
  let closers = fromHtml(listHost, 'data-close-feedback');
  closers[0].onclick(); closers[0].onclick(); closers[0].onclick();
  judge('「关闭」连点三下：只发一次', putCalls.length === 1 && closers[0].disabled === true, putCalls);
  releasePut(); await settle(); await settle(); await settle();
  judge('关完：照原来的筛选（待处理）重画，剩一条；个数跟着变（3 / 1 / 2）', (listHost.innerHTML.match(/class="zq-card zq-feedback"/g) || []).length === 1 && seg[1].attrs['aria-pressed'] === 'true'
    && seg.map((b) => b.count.textContent).join(',') === '3,1,2', { pressed: seg.map((b) => b.attrs['aria-pressed']), counts: seg.map((b) => b.count.textContent) });
  closers = fromHtml(listHost, 'data-close-feedback');
  failNext = true;
  closers[0].onclick();
  releasePut(); await settle(); await settle(); await settle();
  judge('关闭失败：走 safe 说出来（原来没接）、按钮放开可以再点', safeErrors.some((x) => x.startsWith('关闭反馈：网络断了')) && closers[0].disabled === false, { safeErrors, disabled: closers[0].disabled });

  // 4 账号
  const row = m.accountRow(USER);
  judge('一行账号：没有内联样式、写注册日期、删除是危险色', !row.includes('style=') && /zq-acct-joined" title="注册于 [^"]*">2026-10-19<\/span>/.test(row) && row.includes('is-danger" data-delete-user="9"') && row.includes('class="zq-acct-row"'), row);
  judge('禁用的账号：is-off、按钮是「启用」、data-next=1', m.accountRow(Object.assign({}, USER, { status: 0 })).includes('zq-acct-row is-off') && m.accountRow(Object.assign({}, USER, { status: 0 })).includes('data-next="1">启用'));
  const rows = el(), countEl = el(), search = el({ value: '' }), role = el({ value: '' }), query = el();
  Object.assign(dom, { '#zq-rows': rows, '#zq-acct-count': countEl, '#zq-acct-search': search, '#zq-acct-role': role, '#zq-acct-query': query });
  const pending = [];
  api = { get: (url) => new Promise((res) => pending.push({ url, res })), put: async () => true, post: async () => ({}), del: async () => true };
  const boot = m.boots['account-admin.html'](sh);
  await settle();
  pending.shift().res({ records: [USER], total: 1 });
  await boot;
  judge('载入：个数写在自己那一格（不盖掉说明）', countEl.textContent === '共 1 个账号' && rows.innerHTML.includes('陈一'), countEl.textContent);
  search.value = '先查的'; query.onclick(); await settle();
  search.value = '后查的'; role.value = 'ADMIN'; query.onclick(); await settle();
  const [first, second] = pending.splice(0);
  judge('查询带上关键字和角色（角色用下拉的值）', second && /keyword=%E5%90%8E%E6%9F%A5%E7%9A%84/.test(second.url) && /role=ADMIN/.test(second.url), [first && first.url, second && second.url]);
  second.res({ records: [Object.assign({}, USER, { id: 2, nickname: '后查到的' })], total: 1 });
  await settle(); await settle();
  first.res({ records: [Object.assign({}, USER, { id: 1, nickname: '先查到的' })], total: 1 });
  await settle(); await settle();
  judge('连着查两次、先发的晚回来：不盖掉后发的结果', rows.innerHTML.includes('后查到的') && !rows.innerHTML.includes('先查到的'), rows.innerHTML.slice(0, 160));

  // 5 共享计划
  judge('认不出的分类：接口回 categoryName = OTHER（代码原样）→ 写「其他」', m.planCategoryName(PLAN_OTHER) === '其他', m.planCategoryName(PLAN_OTHER));
  judge('认得的分类照接口给的名字', m.planCategoryName(PLAN_MEETING) === '会议与汇报');
  judge('接口没给名字时用壳里的分类表', m.planCategoryName({ category: 'PROJECT' }) === '项目推进');
  const rc = m.reviewCard(PLAN_OTHER, '', true);
  judge('审核卡片：标题是按钮（键盘点得到）、没有内联样式、写「其他」不写 OTHER', rc.includes('<button type="button" class="zq-review-title" data-sp-view="1"') && !rc.includes('style=') && rc.includes('>其他</span>') && !rc.includes('>OTHER<') && rc.includes('zq-review is-dim'), rc);
  judge('状态的人话：PENDING → 待审核 …', m.PLAN_STATUS_NAMES.PENDING === '待审核' && m.PLAN_STATUS_NAMES.OFFLINE === '已下架');
  {
    const reviews = el(), pend = el();
    Object.assign(dom, { '#zq-reviews': reviews, '#zq-pending': pend });
    const reviewPuts = [];
    let release;
    api = { get: async () => [Object.assign({}, PLAN_MEETING, { id: 8, status: 'PENDING' }), PLAN_OTHER], put: (url) => { reviewPuts.push(url); return new Promise((r) => { release = r; }); } };
    await m.boots['shared-plan-admin.html'](sh);
    judge('分组写个数：待审核 1、已发布 1', pend.textContent === '待审核 1 个 · 已发布 1 个' && reviews.innerHTML.includes('<h2 class="zq-review-section">待审核 · 1</h2>'), pend.textContent);
    const ok = fromHtml(reviews, 'data-sp-ok')[0];
    ok.onclick(); ok.onclick(); ok.onclick();
    judge('「通过」连点三下：只发一次审核', reviewPuts.length === 1 && /\/admin\/shared-plans\/8\/review\?action=APPROVE$/.test(reviewPuts[0]), reviewPuts);
    release(true); await settle(); await settle();
  }

  if (count < 25) throw new Error('只跑了 ' + count + ' 条 —— 扫空了？');
  console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('加载失败：' + e.stack); process.exit(1); });
