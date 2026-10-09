// 例行计划页的行为判据（第五十六轮，界面打磨第 8 步）—— 直接 import 发布的 assets/pages/routines.js，壳的东西用替身。
//
//   用法：node src/test/resources/js/routines-check.js <zhiqu-api.js 的路径>
//   退出码 0 = 全绿；非 0 = 有判据红了，逐条打印在上面。由 RoutinesLookTest 调用。
//
// 这一轮页面只放「今天」和「全部例行计划」，新建 / 从任务生成是两个弹窗、同一套设置。钉的是：
//   1 「今天」按服务端给的打卡状态画（打过的变淡、写「已完成」），打卡记到那一行的日期；原来不管今天轮不轮到都给「标记完成」
//   2 「全部」进行中在前、没开始、已结束（变淡）在后；删除是图标按钮；没有内联样式
//   3 两种设置读出来的提交内容：每周不选星期不让交（原来服务端悄悄按今天定）、时长 / 时间 / 日期的毛病说出来
//   4 弹窗：建好才清草稿、关弹窗；提交着再点不重发；从任务生成一个一个去勾，中途失败说出生成了几个
//      —— 原来的 InlineFormResetTest（表单常驻在页面上，建好要清空）挪到这里，换成真点
//   5 「完成」「删除」走 safe（原来没接，靠壳的 unhandledrejection 兜底）；「完成」提交着不重发
//   6 零点（dayReload）只重新取「全部」和「今天」，不取任务、不重新接按钮
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const shellPath = path.resolve(process.argv[2]);
const src = fs.readFileSync(shellPath, 'utf8');

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}

// 壳里那份 freqLabel（例行计划、参考计划、后台、AI 草稿都用）
const fa = src.indexOf('  function freqLabel(frequency, daysOfWeek) {');
const fb = src.indexOf('\n  }\n', fa);
if (fa < 0 || fb < 0) throw new Error('抠不到 freqLabel');
const freqLabel = new Function(src.slice(fa, fb + 4) + '\nreturn freqLabel;')();

const DAY = '2026-10-10';   // 周六
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 假元素：够 routines.js 用的那几样 */
function el(props) {
  return Object.assign({
    value: '', checked: false, disabled: false, hidden: false, textContent: '', innerHTML: '', dataset: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    onclick: null, onchange: null
  }, props || {});
}

/** 一套替身：页面上的元素按选择器放在 dom / domAll 里，弹窗打开时把弹窗里的也放进去 */
function harness(opts) {
  opts = opts || {};
  const h = { posts: [], gets: [], dels: [], safeNames: [], errors: [], toasts: [], drafts: 0, modals: [], closed: 0 };
  h.dom = { '#zq-rt': el(), '#zq-rt-today': el(), '#zq-rt-count': el(), '#zq-rt-today-count': el(), '#zq-rt-new': el(), '#zq-rt-from-tasks': el() };
  h.domAll = {};
  let postN = 0;
  h.sh = {
    api: {
      get: async (u) => {
        h.gets.push(u);
        if (u === '/routine/list') return opts.list || [];
        if (u.startsWith('/routine/instances')) return opts.items || [];
        if (u.startsWith('/task/page')) return { items: opts.tasks || [] };
        return null;
      },
      post: async (u, body) => {
        postN++;
        h.posts.push({ u, body });
        await new Promise((r) => setTimeout(r, 5));
        if (opts.failPost && opts.failPost(postN)) throw new Error('服务器说不行');
        return {};
      },
      del: async (u) => { h.dels.push(u); }
    },
    esc, today: () => DAY, freqLabel, qLabel: String, sLabel: String, normalizeTask: (t) => t,
    empty: (s) => '<p class="zq-empty">' + s + '</p>',
    icon: (n) => '<svg data-icon="' + n + '"></svg>',
    $: (sel) => (sel in h.dom ? h.dom[sel] : h.find(sel)),
    $all: (sel) => (h.domAll[sel] || []).slice(),
    safe: async (name, fn) => { h.safeNames.push(name); try { return await fn(); } catch (e) { h.errors.push(name + '：' + e.message); } },
    toast: (m, kind) => h.toasts.push((kind || '') + m),
    askConfirm: async () => true,
    latestOnly: () => () => true,
    keepDraft: () => ({ clear() { h.drafts++; } }),
    openModal: (o) => {
      const handle = { close() { h.closed++; } };
      h.modals.push(o);
      o.onMount({}, handle);
      return handle;
    }
  };
  // 选择器里带状态的（按下的那个）现算
  h.find = (sel) => {
    if (sel === '[data-freq][aria-pressed="true"]') return (h.domAll['[data-freq]'] || []).find((b) => b.getAttribute('aria-pressed') === 'true') || null;
    return null;
  };
  return h;
}
/** 弹窗里的设置：分段、七个星期、时间、时长、提醒（withText 再加名字、说明、开始 / 结束） */
function mountSettings(h, withText) {
  const freq = ['DAILY', 'WEEKLY'].map((f, i) => el({ dataset: { freq: f }, attrs: { 'aria-pressed': String(i === 0) } }));
  const days = [1, 2, 3, 4, 5, 6, 7].map((d) => el({ dataset: { day: String(d) }, attrs: { 'aria-pressed': String(d === 6) } }));
  Object.assign(h.dom, {
    '[data-rt-days]': el({ hidden: true }), '#zq-rtf-time': el({ value: '08:00' }), '#zq-rtf-dur': el({ value: '30' }), '#zq-rtf-remind': el({ checked: true }),
    '#zq-rtf-cancel': el(), '#zq-rtf-ok': el({ textContent: '创建' })
  });
  if (withText) Object.assign(h.dom, { '#zq-rtf-title': el(), '#zq-rtf-desc': el(), '#zq-rtf-start': el({ value: DAY }), '#zq-rtf-end': el() });
  h.domAll['[data-freq]'] = freq;
  h.domAll['[data-day]'] = days;
  Object.defineProperty(h.domAll, '[data-day][aria-pressed="true"]', { get: () => days.filter((b) => b.getAttribute('aria-pressed') === 'true'), configurable: true });
  return { freq, days };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));

(async () => {
  const mod = await import(pathToFileURL(path.join(path.dirname(shellPath), 'pages', 'routines.js')).href);
  for (const fn of ['todayRowsHtml', 'routineRowsHtml', 'readRoutineForm', 'settingsHtml', 'sortRoutines', 'isoWeekday', 'bind']) {
    if (typeof mod[fn] !== 'function') throw new Error('pages/routines.js 没有导出 ' + fn);
  }
  const page = await import(pathToFileURL(path.join(path.dirname(shellPath), 'pages', 'routines.js')).href);

  // ── 1 「今天」 ──
  console.log('── 1 今天：按打卡状态画、记到那一行的日期 ──');
  let h = harness(); mod.bind(h.sh);
  const items = [
    { id: 7, routineId: 7, title: '写日报', preferredTime: '09:00:00', frequency: 'DAILY', durationMinutes: 20, date: '2026-10-09', completed: false },
    { id: 8, routineId: 8, title: '复盘 <b>', preferredTime: '18:30', frequency: 'WEEKLY', daysOfWeek: [6], durationMinutes: 45, date: DAY, completed: true }
  ];
  const t = mod.todayRowsHtml(items, DAY);
  judge('没打卡的：「完成」、不变淡', /<div class="zq-agenda-row"><span class="zq-agenda-time zq-num">09:00<\/span>[\s\S]*?>完成<\/button><\/div>/.test(t), t);
  judge('打过卡的：变淡、「已完成」', /<div class="zq-agenda-row is-done">[\s\S]*?复盘 &lt;b&gt;[\s\S]*?>已完成<\/button>/.test(t), t);
  judge('打卡记到那一行的日期（服务端给的），不是按下去时的今天', t.includes('data-check-routine="7" data-date="2026-10-09"'), t);
  judge('名字转义了', !t.includes('<b>'), t);
  judge('频率 · 时长写出来', t.includes('每周六 · 45 分钟'), t);
  judge('没有内联样式', !/style=/.test(t), t);
  judge('今天没有的：说出来', mod.todayRowsHtml([], DAY).includes('今天没有要做的例行计划'));

  // ── 2 「全部」 ──
  console.log('── 2 全部：进行中在前、没开始、已结束；删除是图标按钮 ──');
  const list = [
    { id: 1, title: '已结束的', startDate: '2026-09-01', endDate: '2026-09-30', preferredTime: '07:00', frequency: 'DAILY', durationMinutes: 10 },
    { id: 2, title: '下周开始', startDate: '2026-10-12', endDate: '2026-11-10', preferredTime: '06:00', frequency: 'DAILY', durationMinutes: 10 },
    { id: 3, title: '晚上的', startDate: '2026-10-01', endDate: '2026-10-30', preferredTime: '21:00', frequency: 'DAILY', durationMinutes: 10 },
    { id: 4, title: '早上的', startDate: '2026-10-01', endDate: '2026-10-30', preferredTime: '08:00', frequency: 'WEEKLY', daysOfWeek: [1, 3, 5], durationMinutes: 30 }
  ];
  judge('排序：进行中（按时间）→ 没开始 → 已结束', mod.sortRoutines(list, DAY).map((r) => r.id).join(',') === '4,3,2,1', mod.sortRoutines(list, DAY).map((r) => r.id).join(','));
  const all = mod.routineRowsHtml(list, DAY);
  judge('没开始的写哪天开始', all.includes('每天 · 10 分钟 · 10/12 开始'), all);
  judge('已结束的变淡、写哪天结束', /<div class="zq-rt-row is-ended">[\s\S]*?已结束（09\/30）/.test(all), all);
  judge('删除是带名字的图标按钮', all.includes('class="zq-icon-btn is-danger" data-del-routine="4" aria-label="删除「早上的」" title="删除"><svg data-icon="trash-2"></svg>'), all);
  judge('每一行没有字按钮（原来「标记完成」「删除」31 行 62 个）', !/>标记完成</.test(all) && !/>删除</.test(all), all);
  judge('「全部」里没有打卡按钮（只给今天轮到的；原来周六也给「每周一、三、五」的）', !all.includes('data-check-routine'), all);
  judge('没有内联样式', !/style=/.test(all), all);
  judge('一个都没有：说出来', mod.routineRowsHtml([], DAY).includes('还没有例行计划'));

  // ── 3 设置读出来的提交内容 ──
  console.log('── 3 两种设置读出来的提交内容 ──');
  const base = { withText: true, title: ' 写日报 ', description: '记三件事', frequency: 'DAILY', days: [6], time: '09:30', duration: '20', startDate: '', endDate: '', reminder: true };
  let r = mod.readRoutineForm(base, DAY);
  judge('新建、每天：名字去空白、从今天开始、结束留空（服务端按 30 天）、不带星期', JSON.stringify(r.body) === JSON.stringify({ title: '写日报', frequency: 'DAILY', durationMinutes: 20, preferredTime: '09:30', reminderEnabled: true, startDate: DAY, description: '记三件事', endDate: '' }), JSON.stringify(r));
  r = mod.readRoutineForm(Object.assign({}, base, { frequency: 'WEEKLY', days: [5, 1, 3] }), DAY);
  judge('每周：带上选的星期（排好序）', r.body && JSON.stringify(r.body.daysOfWeek) === '[1,3,5]', JSON.stringify(r));
  r = mod.readRoutineForm(Object.assign({}, base, { frequency: 'WEEKLY', days: [] }), DAY);
  judge('每周一天都没选：不让交（原来服务端悄悄按今天是星期几定）', r.error === '每周的要选至少一天', JSON.stringify(r));
  judge('新建没写名字：不让交', mod.readRoutineForm(Object.assign({}, base, { title: '  ' }), DAY).error === '请写上名字');
  for (const d of ['0', '1441', '2.5', '', 'abc']) judge('时长「' + d + '」：不让交', !!mod.readRoutineForm(Object.assign({}, base, { duration: d }), DAY).error);
  judge('时间没填：不让交', !!mod.readRoutineForm(Object.assign({}, base, { time: '' }), DAY).error);
  judge('结束在开始之前：不让交', mod.readRoutineForm(Object.assign({}, base, { startDate: '2026-10-10', endDate: '2026-10-01' }), DAY).error === '结束的日子在开始之前');
  r = mod.readRoutineForm({ withText: false, frequency: 'DAILY', days: [], time: '08:00', duration: '30', reminder: false }, DAY);
  judge('从任务生成：从今天开始、不带说明和结束（名字是任务名，提交时补）', r.body && r.body.startDate === DAY && !('endDate' in r.body) && !('description' in r.body) && r.body.reminderEnabled === false, JSON.stringify(r));

  console.log('── 3b 设置的样子 ──');
  const sNew = mod.settingsHtml(DAY, true), sGen = mod.settingsHtml(DAY, false);
  judge('星期七个，默认只按下今天（周六）', (sNew.match(/class="zq-chip" data-day="\d" aria-pressed="true"/g) || []).length === 1 && sNew.includes('data-day="6" aria-pressed="true">周六'), sNew);
  judge('星期那一栏默认藏着（「每天」时用不上）', sNew.includes('<div class="zq-field" data-rt-days hidden>'));
  judge('新建有名字、开始、结束；从任务生成没有', sNew.includes('id="zq-rtf-title"') && sNew.includes('id="zq-rtf-end"') && !sGen.includes('id="zq-rtf-title"') && !sGen.includes('id="zq-rtf-start"'));
  judge('没有内联样式', !/style=/.test(sNew), sNew.match(/style="[^"]*"/));
  process.env.TZ = 'Pacific/Kiritimati';
  judge('星期几按日期算，不看浏览器时区（UTC+14）', mod.isoWeekday('2026-10-10') === 6 && mod.isoWeekday('2026-10-11') === 7 && mod.isoWeekday('2026-10-12') === 1);
  process.env.TZ = 'America/Adak';
  judge('星期几按日期算，不看浏览器时区（UTC−10）', mod.isoWeekday('2026-10-10') === 6 && mod.isoWeekday('2027-01-01') === 5);

  // ── 4 弹窗 ──
  console.log('── 4 新建弹窗：建好才清草稿、关弹窗；提交着再点不重发 ──');
  h = harness(); mod.bind(h.sh);
  await mod.boots['routines.html'](h.sh);
  judge('页头两个按钮接上了', typeof h.dom['#zq-rt-new'].onclick === 'function' && typeof h.dom['#zq-rt-from-tasks'].onclick === 'function');
  mountSettings(h, true);
  h.dom['#zq-rt-new'].onclick();
  judge('打开的是「新建例行计划」', h.modals.length === 1 && h.modals[0].title === '新建例行计划');
  const wk = h.domAll['[data-freq]'][1];
  wk.onclick();
  judge('点「每周」：星期那一栏露出来、按下的换成「每周」', h.dom['[data-rt-days]'].hidden === false && wk.getAttribute('aria-pressed') === 'true' && h.domAll['[data-freq]'][0].getAttribute('aria-pressed') === 'false');
  const mon = h.domAll['[data-day]'][0];
  mon.onclick();
  judge('点「周一」：按下（样子在样式表，这里只看 aria-pressed）', mon.getAttribute('aria-pressed') === 'true');
  h.dom['#zq-rtf-title'].value = '写周报';
  const ok = h.dom['#zq-rtf-ok'];
  ok.onclick(); ok.onclick(); ok.onclick();
  judge('连点三下：提交着只发一次', h.posts.length === 1, h.posts.length + ' 次');
  judge('草稿在请求回来之前没删', h.drafts === 0);
  await tick();
  judge('发出去的是选的那两天', h.posts[0] && JSON.stringify(h.posts[0].body.daysOfWeek) === '[1,6]' && h.posts[0].body.frequency === 'WEEKLY', JSON.stringify(h.posts[0]));
  judge('建好：草稿删了、弹窗关了', h.drafts === 2 && h.closed === 1, 'drafts ' + h.drafts + ' closed ' + h.closed);

  h = harness({ failPost: () => true }); mod.bind(h.sh);
  await mod.boots['routines.html'](h.sh);
  mountSettings(h, true);
  h.dom['#zq-rt-new'].onclick();
  h.dom['#zq-rtf-title'].value = '写周报';
  h.dom['#zq-rtf-ok'].onclick();
  await tick();
  judge('没建上：说出来、弹窗不关、草稿留着、按钮能再点', h.errors.length === 1 && h.closed === 0 && h.drafts === 0 && h.dom['#zq-rtf-ok'].disabled === false, JSON.stringify(h.errors));

  console.log('── 4b 从任务生成：一个一个去勾、中途失败说出生成了几个 ──');
  h = harness({ failPost: (n) => n === 2, tasks: [{ id: 11, title: 'A' }, { id: 12, title: 'B' }, { id: 13, title: 'C' }] }); mod.bind(h.sh);
  await mod.boots['routines.html'](h.sh);
  mountSettings(h, false);
  h.dom['#zq-rt-src'] = el();
  const boxes = ['A', 'B', 'C'].map((n) => el({ checked: true, dataset: { title: n } }));
  h.domAll['input[type="checkbox"]'] = boxes;
  Object.defineProperty(h.domAll, 'input[type="checkbox"]:checked', { get: () => boxes.filter((b) => b.checked), configurable: true });
  h.domAll['[data-src-filter] button'] = [];
  h.dom['#zq-rt-from-tasks'].onclick();
  await tick();
  judge('打开就取了任务', h.gets.some((u) => u.startsWith('/task/page?limit=20')), JSON.stringify(h.gets));
  boxes.forEach((b) => { b.checked = true; });
  const gen = h.dom['#zq-rtf-ok'];
  gen.onclick(); gen.onclick();
  judge('提交着：按钮写「生成中…」、再点不重发', gen.textContent === '生成中…' && h.posts.length === 1, gen.textContent + ' / ' + h.posts.length);
  await tick(60);
  judge('名字是任务名', h.posts[0].body.title === 'A' && h.posts[1].body.title === 'B', JSON.stringify(h.posts.map((p) => p.body.title)));
  judge('第二个失败：说出生成了 1 个', h.errors.length === 1 && h.errors[0].includes('生成了 1 个'), JSON.stringify(h.errors));
  judge('生成了的那个去了勾，没生成的还勾着（再点不会把 A 再来一遍）', boxes[0].checked === false && boxes[1].checked === true && boxes[2].checked === true);
  judge('失败了弹窗不关、按钮写回剩几个', h.closed === 0 && gen.disabled === false && gen.textContent === '生成 2 个', gen.textContent);
  judge('生成了一部分也重新取了列表', h.gets.filter((u) => u === '/routine/list').length >= 2);

  // ── 5 「完成」「删除」 ──
  console.log('── 5 「完成」「删除」走 safe；「完成」提交着不重发 ──');
  h = harness({ items, list }); mod.bind(h.sh);
  const check = el({ dataset: { checkRoutine: '7', date: '2026-10-09' } });
  const del = el({ dataset: { delRoutine: '4' } });
  h.domAll['[data-check-routine]'] = [check];
  h.domAll['[data-del-routine]'] = [del];
  await mod.dayReload['routines.html']();
  judge('画出来了：今天 1 / 2 完成、4 个里 2 个进行中', h.dom['#zq-rt-today-count'].textContent === '1 / 2 完成' && h.dom['#zq-rt-count'].textContent === '2 个进行中', h.dom['#zq-rt-today-count'].textContent + ' / ' + h.dom['#zq-rt-count'].textContent);
  check.onclick(); check.onclick();
  await tick();
  judge('打卡走 safe、只发一次、记到那一行的日期', h.safeNames.includes('打卡') && h.posts.length === 1 && h.posts[0].u === '/routine/7/checkin' && h.posts[0].body.checkDate === '2026-10-09', JSON.stringify(h.posts));
  await del.onclick();
  judge('删除走 safe', h.safeNames.includes('删除例行计划') && h.dels[0] === '/routine/4', JSON.stringify(h.dels));
  h = harness({ items, list, failPost: () => true }); mod.bind(h.sh);
  const check2 = el({ dataset: { checkRoutine: '7', date: DAY } });
  h.domAll['[data-check-routine]'] = [check2];
  await mod.dayReload['routines.html']();
  check2.onclick();
  await tick();
  judge('打卡失败：safe 接住了（说出来），按钮能再点', h.errors.length === 1 && check2.disabled === false, JSON.stringify(h.errors));

  // ── 6 零点 ──
  console.log('── 6 零点：只重新取「全部」和「今天」 ──');
  h = harness(); page.bind(h.sh);
  await page.dayReload['routines.html']();
  judge('取了全部和今天一天', h.gets.includes('/routine/list') && h.gets.includes('/routine/instances?from=' + DAY + '&to=' + DAY), JSON.stringify(h.gets));
  judge('没取任务（那是「从任务生成」弹窗的事）', !h.gets.some((u) => u.startsWith('/task/page')));
  judge('没重新接页头的按钮（没有重跑整页启动）', h.dom['#zq-rt-new'].onclick === null);

  if (fail) { console.log('\nRED: ' + fail + ' 条'); process.exit(1); }
  console.log('\nALL-GREEN');
})().catch((e) => { console.log('加载失败：' + e.stack); process.exit(1); });
