// 迷你番茄钟（第五十轮）—— 从发布的 assets/pages/mini.js 里抠出画法和按钮那一段真跑（假的最小 DOM、假的壳里的钟）；
// 再从 zhiqu-api.js 里抠出 updatePomoCount，看迷你窗只有「第 N 轮」那一块时也填得上。
//
//   用法：node src/test/resources/js/mini-check.js <mini.js 的路径> <zhiqu-api.js 的路径>
//   由 MiniPomodoroTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const api = fs.readFileSync(process.argv[3], 'utf8');
const a = src.indexOf('/** 进度环的周长（r = 18） */');
if (a < 0) throw new Error('抠不到 mini.js 的画法那一段');
const body = src.slice(a);

function node(id, extra) {
  const attrs = {}, cls = new Set();
  return Object.assign({
    id, textContent: '', dataset: {}, onclick: null, titleSets: 0,
    set title(v) { this._title = v; this.titleSets++; }, get title() { return this._title; },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
    classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
  }, extra || {});
}
const ic = { innerHTML: '<svg play>' };
const els = {
  '#zq-mini-time': node('time'), '#zq-mini-note': node('note'), '#zq-mini-ring': node('ring'),
  '#zq-mini-go': node('go', { querySelector: (q) => (q === '.zq-ic' ? ic : null) }), '#zq-mini-expand': node('expand'), '.zq-main': node('main'),
};
els['#zq-mini-go'].setAttribute('aria-label', '开始专注');
const calls = [];
let view = { phase: 'idle', left: 0, total: 0, taskId: null, taskTitle: '' };
let subs = 0;
const pomo = {
  view: () => view,
  clock: (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'),
  start: (o) => calls.push(['start', o]), pause: () => calls.push(['pause']),
  subscribe: (fn) => { subs++; fn(view); },
};
const window = {};
const location = { href: 'mini.html' };
// 壳的 miniBridge（第五十一轮起在壳里）：照它的样子读 window.webkit
const miniBridge = () => (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.zqMini) || null;
const fns = new Function('$', 'pomo', 'icon', 'miniBridge', 'window', 'location', body.replace(/^export /gm, '') + '\nreturn { wireMini, drawMini };')(
  (q) => els[q] || null, pomo, (n) => '<svg ' + n + '>', miniBridge, window, location);

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail !== undefined ? '  →  ' + JSON.stringify(detail) : '')); fail++; }
}
const T = () => ({ time: els['#zq-mini-time'].textContent, note: els['#zq-mini-note'].textContent, label: els['#zq-mini-go'].getAttribute('aria-label'),
  icon: ic.innerHTML, ring: els['#zq-mini-ring'].getAttribute('stroke-dasharray'), running: els['.zq-main'].classList.contains('is-running'),
  paused: els['.zq-main'].classList.contains('is-paused') });

fns.wireMini();
fns.wireMini();
judge('按钮只接一次、只订一次（重新启动也不接两遍）', subs === 1, subs);
let t = T();
judge('新账号、待开始：25:00、「开始专注」、环是空的（连圆头的那个点也藏起来）', t.time === '25:00' && t.note === '开始专注' && t.label === '开始专注' && /^0\.0 /.test(t.ring) && els['#zq-mini-ring'].getAttribute('visibility') === 'hidden' && !t.running, t);
const sets0 = els['#zq-mini-go'].titleSets;
fns.drawMini(view);
judge('一秒一次重画，按钮的提示没变就不重写（不然停在按钮上的提示一直被重新挂）', els['#zq-mini-go'].titleSets === sets0, els['#zq-mini-go'].titleSets);

view = { phase: 'idle', left: 2700, total: 2700, taskId: 7, taskTitle: '写周报' };
fns.drawMini(view);
judge('做完过一个之后待开始：时间是上一次的时长，小字是上一次的任务', T().time === '45:00' && T().note === '写周报', T());
els['#zq-mini-go'].onclick();
judge('待开始时点：照上一次的时长和任务再来一个', JSON.stringify(calls.pop()) === JSON.stringify(['start', { minutes: 45, taskId: 7, taskTitle: '写周报' }]), calls);
view = { phase: 'idle', left: 0, total: 0, taskId: null, taskTitle: '' };
els['#zq-mini-go'].onclick();
judge('什么都没做过时点：25 分钟、不关联任务', JSON.stringify(calls.pop()) === JSON.stringify(['start', { minutes: 25, taskId: null, taskTitle: '' }]), calls);

view = { phase: 'running', id: 'x', left: 897, total: 1500, taskId: 7, taskTitle: '写周报' };
fns.drawMini(view);
t = T();
judge('在跑：14:57、小字是任务名、按钮是「暂停」（图标换成暂停）、环走了四成', t.time === '14:57' && t.note === '写周报' && t.label === '暂停'
  && t.icon === '<svg pause>' && t.running && els['#zq-mini-ring'].getAttribute('visibility') === 'visible' && t.ring.startsWith((603 / 1500 * 2 * Math.PI * 18).toFixed(1) + ' ') && els['#zq-mini-go'].title === '暂停', t);
els['#zq-mini-go'].onclick();
judge('在跑时点：暂停', JSON.stringify(calls.pop()) === '["pause"]', calls);
view = Object.assign({}, view, { taskId: null, taskTitle: '' });
fns.drawMini(view);
judge('在跑、没关联任务：小字写「专注中」', T().note === '专注中', T());

view = { phase: 'paused', id: 'x', left: 897, total: 1500, taskId: 7, taskTitle: '写周报' };
fns.drawMini(view);
t = T();
judge('暂停着：还是 14:57、「已暂停」、按钮是「继续」（图标换回开始）、时间变灰的类', t.time === '14:57' && t.note === '已暂停' && t.label === '继续' && t.icon === '<svg play>' && t.paused && !t.running, t);
els['#zq-mini-go'].onclick();
judge('暂停着点：接着走（交给壳的 start，壳认得暂停着的）', calls.pop()[0] === 'start', calls);

view = { phase: 'done', id: 'x', left: 1500, total: 1500, taskId: 7, taskTitle: '写周报' };
fns.drawMini(view);
judge('刚做完：「专注结束」（窄胶囊里放得下），时间回到整段、按钮是「开始专注」', T().note === '专注结束' && T().time === '25:00' && T().label === '开始专注', T());

// 展开
els['#zq-mini-expand'].onclick();
judge('浏览器里（没有外壳的桥）点展开：去看板', location.href === 'dashboard.html', location.href);
location.href = 'mini.html';
const posted = [];
window.webkit = { messageHandlers: { zqMini: { postMessage: (m) => posted.push(m) } } };
els['#zq-mini-expand'].onclick();
judge('桌面应用里点展开：告诉外壳（第 3 步把主窗口叫回来），迷你窗自己不跳走', JSON.stringify(posted) === '[{"action":"expand"}]' && location.href === 'mini.html', { posted, href: location.href });
window.webkit.messageHandlers.zqMini.postMessage = () => { throw new Error('bridge gone'); };
els['#zq-mini-expand'].onclick();
judge('桥坏了：照浏览器的办法去看板（不是点了没反应）', location.href === 'dashboard.html', location.href);

// 壳的 updatePomoCount：迷你窗只有「第 N 轮」那一块
const u = api.indexOf('  async function updatePomoCount() {');
const uEnd = api.indexOf('\n  }\n', u);
if (u < 0 || uEnd < 0) throw new Error('抠不到 updatePomoCount');
const round = { textContent: '' };
const count = new Function('$', 'pendingPomodoros', 'today', 'api', 'd10', api.slice(u, uEnd) + '\n  }\nreturn updatePomoCount;')(
  (q) => (q === '#zq-pomo-round' ? round : null), () => [], () => '2026-10-09',
  { get: async () => [{ studyDate: '2026-10-09', durationMinutes: 25 }, { studyDate: '2026-10-09', durationMinutes: 25 }, { studyDate: '2026-10-08', durationMinutes: 25 }] },
  (v) => String(v).slice(0, 10));
count().then(() => {
  judge('只有「第 N 轮」那一块（迷你窗）：照样填上，按今天的个数 + 1（昨天的不算）', round.textContent === '今天第 3 轮', round.textContent);
  console.log(fail ? fail + ' FAIL' : 'ALL-GREEN');
  process.exit(fail ? 1 : 0);
});
