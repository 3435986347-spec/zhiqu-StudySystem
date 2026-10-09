// 任务页（第五十二轮，界面打磨第 6 步）—— 从发布的 assets/pages/tasks.js 里抠出工具条和行的画法真跑（假的最小 DOM）。
//
//   用法：node src/test/resources/js/tasks-check.js <tasks.js 的路径>
//   原来：五个下拉 +「查询」、没有搜索；每一行一长串内联样式（列宽拼两遍），彩色底的象限徽标，编辑 / 删除一直摆着，截止和提醒各一列（最少 880px 宽）。
//   由 TasksLookTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('/** 搜索框打字停多久才查');
if (a < 0) throw new Error('抠不到工具条那一段');
const body = src.slice(a);

// ── 假的最小 DOM：按 id / 选择器认得出来的那几个 ──
function el(extra) {
  const attrs = {}, cls = new Set();
  return Object.assign({
    value: '', textContent: '', innerHTML: '', hidden: false, dataset: {}, onclick: null, onchange: null, listeners: {},
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
    insertAdjacentHTML(_, html) { this.innerHTML += html; },
  }, extra || {});
}
const segs = ['', '0', '1', '2'].map((s) => { const b = el(); b.dataset.status = s; b.setAttribute('aria-pressed', s === '' ? 'true' : 'false'); return b; });
const els = {
  '#zq-task-q': el(), '#zq-task-quadrant': el(), '#zq-task-priority': el(), '#zq-task-sort': el({ value: 'updatedAt:desc' }),
  '#zq-task-more': el(), '#zq-task-more-label': el({ textContent: '筛选' }), '#zq-task-filters': el({ hidden: true }), '#zq-task-clear': el(),
  '#zq-task-new': el(), '#zq-rows': el(), '#zq-task-count': el(),
};
els['#zq-task-more'].setAttribute('aria-expanded', 'false');
const $ = (sel, root) => {
  if (root && sel === '[data-clear-filters]') return root.innerHTML.includes('data-clear-filters') ? (root.clearBtn = root.clearBtn || el()) : null;
  if (root) return null;
  if (sel === '.zq-task-tools .zq-seg [aria-pressed="true"]') return segs.find((b) => b.getAttribute('aria-pressed') === 'true') || null;
  return els[sel] || null;
};
const $all = (sel) => (sel === '.zq-task-tools .zq-seg button' ? segs : []);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NOW = Date.UTC(2026, 9, 9, 2, 0, 0);   // 东八区 2026-10-09 10:00
const serverTime = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || '')); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) - 480 * 60000 : NaN; };
const state = {};
const gets = [];
let respond = () => Promise.resolve({ items: [], total: 0 });
const api = { get: (url) => { gets.push(url); return respond(url); } };
// 假的计时器：排着队，flushTimers() 时才跑 —— 看得出「打字停一下才查」
let timers = [], timerId = 0;
const fakeSetTimeout = (fn) => { const id = ++timerId; timers.push({ id, fn }); return id; };
const fakeClearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
const flushTimers = () => { const due = timers; timers = []; due.forEach((t) => t.fn()); };
let latestSeq = 0;
const latestOnly = () => { const mine = ++latestSeq; return () => latestSeq === mine; };
const fns = new Function('api', 'esc', '$', '$all', 'empty', 'fmtDate', 'safe', 'askConfirm', 'state', 'latestOnly', 'normalizeTask', 'qKey', 'qLabel', 'pLabel', 'sLabel',
  'openTaskForm', 'icon', 'nowMs', 'serverTime', 'today', 'setTimeout', 'clearTimeout',
  body + '\nreturn { taskParams, extraCount, isFiltered, shortWhen, taskRowHtml, countText, wireTools, loadTasks, renderTaskRows, readFilters };')(
  api, esc, $, $all, (t) => '<div class="zq-empty">' + t + '</div>', (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : '—'),
  (name, fn) => Promise.resolve().then(fn), () => Promise.resolve(true), state, latestOnly, (t) => t, (q) => 'q' + q,
  (q) => ['', '重要且紧急', '重要不紧急', '紧急不重要', '不重要不紧急'][q], (p) => ['低', '中', '高', '紧急'][p], (s) => ['待办', '进行中', '已完成'][s],
  () => {}, (n) => '<svg ' + n + '>', () => NOW, serverTime, () => '2026-10-09', fakeSetTimeout, fakeClearTimeout);

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail !== undefined ? '  →  ' + JSON.stringify(detail) : '')); fail++; }
}
const P = (f) => fns.taskParams(Object.assign({ keyword: '', status: '', quadrant: '', priority: '', sort: 'updatedAt:desc' }, f)).toString();

// ── 条件 → 查询参数 ──
judge('什么都不筛：只带排序（最近改过的在前）', P({}) === 'sortBy=updatedAt&sortOrder=desc', P({}));
judge('状态「待办」是 0、优先级「低」是 0：都要带上（下拉框给的是字符串「0」；哪天改成按数字判「选了没有」，0 就成了「没选」）', P({ status: '0', priority: '0' }) === 'status=0&priority=0&sortBy=updatedAt&sortOrder=desc', P({ status: '0', priority: '0' }));
judge('象限、排序「截止早的在前」', P({ quadrant: '1', sort: 'deadline:asc' }) === 'quadrant=1&sortBy=deadline&sortOrder=asc', P({ quadrant: '1', sort: 'deadline:asc' }));
judge('关键词去掉前后空格；全是空格等于没给', P({ keyword: '  周报 ' }).endsWith('&keyword=%E5%91%A8%E6%8A%A5') && !P({ keyword: '   ' }).includes('keyword'), [P({ keyword: '  周报 ' }), P({ keyword: '   ' })]);
judge('「筛选」上的数：象限、优先级（0 也算）、不是默认的排序', fns.extraCount({ quadrant: '2', priority: '0', sort: 'priority:desc' }) === 3
  && fns.extraCount({ quadrant: '', priority: '', sort: 'updatedAt:desc' }) === 0);
judge('筛过没有：只改排序不算（列表里的还是全部）', !fns.isFiltered({ keyword: ' ', status: '', quadrant: '', priority: '', sort: 'deadline:asc' })
  && fns.isFiltered({ keyword: '', status: '2', quadrant: '', priority: '' }));

// ── 时间写短 ──
judge('今年的不写年份、别的年份只写日期、没有写「—」', fns.shortWhen('2026-10-14T09:00:00', '2026') === '10-14 09:00'
  && fns.shortWhen('2025-12-31T18:00:00', '2026') === '2025-12-31' && fns.shortWhen(null, '2026') === '—');

// ── 一行 ──
const base = { id: 7, title: '写<b>周报</b>', description: '给林', quadrant: 1, priority: 3, status: 0, deadline: '2026-10-09T09:00:00', reminderTime: '2026-10-09T08:30:00' };
let row = fns.taskRowHtml(base, NOW, '2026');
judge('一行里没有内联样式（列宽只在样式表里写一处）', !/style=/.test(row), row);
judge('标题转义了、点标题就编辑；编辑 / 删除是两个图标按钮、读屏念得出是哪一条',
  row.includes('class="zq-task-title" data-edit-task="7"') && row.includes('写&lt;b&gt;周报&lt;/b&gt;') && !row.includes('<b>')
  && row.includes('aria-label="编辑「写&lt;b&gt;周报&lt;/b&gt;」"') && row.includes('class="zq-icon-btn is-danger" data-del-task="7"') && row.includes('<svg pencil>') && row.includes('<svg trash-2>'), row);
judge('象限是小圆点 + 名字（类名，不是整块彩色底）', row.includes('<span class="zq-task-quad"><i class="q1"></i>重要且紧急</span>'), row);
judge('过了截止时间、没做完：截止红字，提醒是下面一行小字', row.includes('zq-task-when zq-num is-overdue')
  && row.includes('>10-09 09:00</span>') && row.includes('class="zq-task-remind zq-num" title="提醒时间">提醒 10-09 08:30</span>'), row);
row = fns.taskRowHtml(Object.assign({}, base, { status: 2 }), NOW, '2026');
judge('做完了的：整行变淡，过了截止也不标红', row.includes('zq-task-row zq-task-grid is-done') && !row.includes('is-overdue'), row);
row = fns.taskRowHtml(Object.assign({}, base, { status: 1, deadline: '2026-10-20T18:00:00', reminderTime: null, description: '' }), NOW, '2026');
judge('进行中的状态胶囊重一点；没到截止不标红；没有提醒就没有那一行；没有说明就没有那一行', row.includes('zq-task-status is-doing') && !row.includes('is-overdue')
  && !row.includes('zq-task-remind') && !row.includes('zq-task-desc'), row);
judge('状态胶囊的说明在提示里（原来是页脚一行字）', row.includes('title="点一下换到下一个状态：待办 → 进行中 → 已完成"'), row);

// ── 页头的数 ──
judge('共几条 / 找到几条 / 先显示几条 / 搜索看到上限要说出来', fns.countText(300, 100, false, false) === '共 300 条（先显示 100 条）'
  && fns.countText(12, 12, true, false) === '找到 12 条' && fns.countText(40, 40, true, true) === '找到 40 条 · 只在前 5000 条里找了', fns.countText(40, 40, true, true));

// ── 工具条：改了就查；「筛选」展开 / 上面写数；清除；连着打字只认最后一次 ──
(async () => {
  fns.wireTools();
  fns.wireTools();   // bootTasks 每次刷新都跑：只接一次
  judge('工具条只接一次（搜索框的监听没有挂两份）', els['#zq-task-q'].listeners.input.length === 1, els['#zq-task-q'].listeners.input.length);
  segs[1].onclick();
  await new Promise((r) => setTimeout(r, 5));
  judge('点「待办」：马上查 status=0，分段只亮它', gets[gets.length - 1].includes('status=0') && segs.filter((b) => b.getAttribute('aria-pressed') === 'true').length === 1
    && segs[1].getAttribute('aria-pressed') === 'true', { last: gets[gets.length - 1] });
  els['#zq-task-more'].onclick();
  judge('「筛选」展开第二行', els['#zq-task-filters'].hidden === false && els['#zq-task-more'].getAttribute('aria-expanded') === 'true');
  els['#zq-task-quadrant'].value = '2';
  els['#zq-task-quadrant'].onchange();
  await new Promise((r) => setTimeout(r, 5));
  judge('改象限：马上查，「筛选」上写 1', gets[gets.length - 1].includes('quadrant=2') && els['#zq-task-more-label'].textContent === '筛选 · 1' && els['#zq-task-more'].classList.contains('is-active'),
    { last: gets[gets.length - 1], label: els['#zq-task-more-label'].textContent });

  // 打字：每个字都查的话打「周报」要发好几趟 —— 停一下才查，回车马上查
  const before = gets.length;
  ['周', '周报', '周报 '].forEach((v) => { els['#zq-task-q'].value = v; els['#zq-task-q'].listeners.input.forEach((fn) => fn()); });
  judge('连着打字：一个字都还没查（等停下来）', gets.length === before, gets.slice(before));
  flushTimers();
  await new Promise((r) => setTimeout(r, 5));
  judge('停下来之后：只查了一趟，带的是最后那个关键词（去掉了空格）', gets.length === before + 1 && gets[gets.length - 1].includes('keyword=%E5%91%A8%E6%8A%A5') && !gets[gets.length - 1].includes('%20'),
    gets.slice(before));
  els['#zq-task-q'].value = '周';
  els['#zq-task-q'].listeners.input.forEach((fn) => fn());
  els['#zq-task-q'].listeners.keydown.forEach((fn) => fn({ key: 'Enter', preventDefault() {} }));
  await new Promise((r) => setTimeout(r, 5));
  flushTimers();
  await new Promise((r) => setTimeout(r, 5));
  judge('按回车：马上查，等着的那一趟不再发', gets.length === before + 2 && /keyword=%E5%91%A8&offset=/.test(gets[gets.length - 1]),
    gets.slice(before));

  // 连着打字：两趟在路上，先发的后回来 —— 只画最后一次的
  let release = [];
  respond = (url) => new Promise((r) => release.push(() => r(url.includes('keyword=%E5%91%A8%E6%8A%A5') ? { items: [{ id: 2, title: '周报', quadrant: 1, priority: 1, status: 0 }], total: 1 }
    : { items: [{ id: 1, title: '周', quadrant: 1, priority: 1, status: 0 }, { id: 3, title: '周末', quadrant: 1, priority: 1, status: 0 }], total: 2 })));
  els['#zq-task-q'].value = '周';
  const first = fns.loadTasks();
  els['#zq-task-q'].value = '周报';
  const second = fns.loadTasks();
  release[1](); await second; release[0](); await first;
  judge('先发的「周」后回来：不盖掉「周报」的结果', state.tasks.length === 1 && state.tasks[0].title === '周报' && els['#zq-task-count'].textContent === '找到 1 条',
    { tasks: state.tasks, count: els['#zq-task-count'].textContent });

  respond = () => Promise.resolve({ items: [], total: 0 });
  await fns.loadTasks();
  judge('筛过、没有结果：说「没有符合条件的任务」，给一个「清除筛选」', els['#zq-rows'].innerHTML.includes('没有符合条件的任务') && els['#zq-rows'].innerHTML.includes('data-clear-filters'));
  els['#zq-rows'].clearBtn.onclick();
  await new Promise((r) => setTimeout(r, 5));
  judge('点「清除筛选」：搜索框空了、状态回到「全部」、象限回到全部、「筛选」上没有数，并且重新查了',
    els['#zq-task-q'].value === '' && segs[0].getAttribute('aria-pressed') === 'true' && els['#zq-task-quadrant'].value === '' && els['#zq-task-more-label'].textContent === '筛选'
    && gets[gets.length - 1] === '/task/page?sortBy=updatedAt&sortOrder=desc&offset=0&limit=100', { last: gets[gets.length - 1] });
  judge('什么都没筛、一条都没有：说「还没有任务」（不给清除筛选）', els['#zq-rows'].innerHTML.includes('还没有任务') && !els['#zq-rows'].innerHTML.includes('data-clear-filters'));

  console.log(fail ? fail + ' FAIL' : 'ALL-GREEN');
  process.exit(fail ? 1 : 0);
})();
