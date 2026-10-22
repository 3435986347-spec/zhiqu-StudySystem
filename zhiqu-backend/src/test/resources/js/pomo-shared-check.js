// 番茄钟全站共用一个钟（第四十九轮）—— 直接跑 assets/zhiqu-api.js 里发布的那一段。
//
//   用法：node src/test/resources/js/pomo-shared-check.js <zhiqu-api.js 的路径>
//   打印 ALL-GREEN 且退出码 0 = 全绿。由 PomodoroSharedTest 调用。
//
// 一个「标签页」= 把那一段代码再实例化一次（各自的 pomoObs、各自的标题），几个标签页共用一份 localStorage、一把锁 —— 和浏览器里一样。
// 钟是假的：clock.now 是墙上的钟（可以往回拨），clock.mono 是单调时钟（performance.now）。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const START = '  var POMO_PREFIX = ';
const END = '  /** 周期给人看的样子（第十九轮）';
const a = src.indexOf(START), b = src.indexOf(END, a);
if (a < 0 || b < 0) throw new Error('抠不到番茄钟那一段（' + START.trim() + ' … ' + END.trim() + '）');
const code = src.slice(a, b);

const clock = { now: Date.UTC(2026, 9, 9, 1, 0, 0), mono: 100000 };   // 东八区 2026-10-09 09:00
function advance(ms) { clock.now += ms; clock.mono += ms; }
class FakeDate extends Date {
  constructor(...args) { if (args.length) super(...args); else super(clock.now); }
  static now() { return clock.now; }
}
function ymd(ms) { const d = new Date(ms); return d.toISOString().slice(0, 10); }
const OFFSET = 480 * 60000;

let store = new Map();
let storageBroken = false;
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { if (storageBroken) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
  removeItem: (k) => { if (storageBroken) throw new Error('SecurityError'); store.delete(k); },
};
let lockChain = Promise.resolve();
let useLocks = true;
const navigator = {
  get locks() {
    return useLocks ? { request: (name, cb) => { const p = lockChain.then(() => cb()); lockChain = p.catch(() => {}); return p; } } : undefined;
  }
};
const records = [], notices = [], toasts = [];
let asks = 0;
function settle() { return new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setTimeout(r, 0))); }

function badgeEl() {
  const kids = { '.zq-side-pomo-label': { textContent: '专注中' }, '.zq-side-pomo-time': { textContent: '' } };
  const cls = new Set();
  return {
    hidden: true, title: '', kids,
    querySelector: (q) => kids[q] || null,
    classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, has: (c) => cls.has(c) },
  };
}

function tab(name, opts) {
  opts = opts || {};
  const t = { name, afterRecords: 0, updates: 0, badge: badgeEl() };
  t.document = {
    title: name, hidden: !!opts.hidden,
    addEventListener() {}, removeEventListener() {},
    querySelector: (q) => (q === '#zq-side .zq-side-pomo' ? t.badge : null),
  };
  const env = {
    state: { user: { id: opts.user == null ? 1 : opts.user } },
    localStorage, navigator, Date: FakeDate,
    performance: { now: () => clock.mono },
    document: t.document,
    window: { zqApi: { afterRecord: () => { t.afterRecords++; } }, addEventListener() {} },
    page: opts.page || 'tasks.html',
    clock: { skew: 0, offsetMinutes: 480 },
    setTimeout: () => 0, setInterval: () => 0,
    toast: (m, kind) => toasts.push(name + ':' + (kind === 'error' ? '[错] ' : '') + m),
    pageNotify: (title, body, tag) => notices.push(name + ':' + title + '|' + tag),
    askNotifyPermission: () => { asks++; },
    recordPomodoro: (rec) => { records.push(Object.assign({ by: name }, rec)); return Promise.resolve({ sent: 1, failed: [], waiting: 0 }); },
    updatePomoCount: () => { t.updates++; },
    businessDate: (ms) => ymd((ms == null ? clock.now : ms) + OFFSET),
    today: () => ymd(clock.now + OFFSET),
    ymdUTC: (d) => d.toISOString().slice(0, 10),
    writeKey: (() => { let n = 0; return () => 'ui-' + name + '-' + (++n); })(),
  };
  t.api = new Function(...Object.keys(env), code + '\nreturn { pomo, pomoTick, pomoView, readPomo, writePomo };')(...Object.values(env));
  return t;
}
function reset() {
  store = new Map(); storageBroken = false; useLocks = true; lockChain = Promise.resolve();
  records.length = 0; notices.length = 0; toasts.length = 0; asks = 0;
  clock.now = Date.UTC(2026, 9, 9, 1, 0, 0); clock.mono = 100000;
}

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}
const show = (x) => JSON.stringify(x);

(async () => {
  // ── 1. 存下来、换一页还在 ──
  reset();
  let board = tab('看板', { page: 'dashboard.html' });
  await board.api.pomo.start({ minutes: 25, taskId: 7, taskTitle: '写周报' });
  advance(3000);
  const next = tab('AI 助手');     // 切到别的页 = 新的一页、从存储里读
  next.api.pomoTick();
  let v = next.api.pomoView();
  judge('看板上开始的，切到别的页还在：同一个钟、同一个任务（原来切页就没了）',
    v.phase === 'running' && v.left === 1497 && v.taskId === 7 && v.taskTitle === '写周报', show(v));
  judge('点「开始」时问通知授权（在这一下点击里）', asks === 1, 'asks=' + asks);
  judge('侧栏那一行：别的页显示「专注中 24:57」，带上任务名的提示',
    next.badge.hidden === false && next.badge.kids['.zq-side-pomo-label'].textContent === '专注中' && next.badge.kids['.zq-side-pomo-time'].textContent === '24:57'
      && /写周报/.test(next.badge.title), show({ hidden: next.badge.hidden, kids: next.badge.kids, title: next.badge.title }));
  board.api.pomoTick();
  judge('看板本页不显示侧栏那一行（卡片就在那）', board.badge.hidden === true);

  // ── 2. 按结束时刻倒数 ──
  advance(10 * 60000);             // 后台标签页一跳都没跳（被浏览器限住了）、合了盖子
  next.api.pomoTick();
  judge('按结束时刻倒数：十分钟一跳没跳，回来还剩 14:57（不是停在原地）', next.api.pomoView().left === 897, show(next.api.pomoView()));

  // ── 3. 暂停、继续 ──
  await next.api.pomo.pause();
  advance(5 * 60000);
  board.api.pomoTick(); next.api.pomoTick();
  judge('暂停：五分钟过去，两页都还是 14:57、已暂停',
    board.api.pomoView().phase === 'paused' && board.api.pomoView().left === 897 && next.api.pomoView().left === 897, show(board.api.pomoView()));
  judge('暂停着：侧栏写「已暂停」、变灰', next.badge.kids['.zq-side-pomo-label'].textContent === '已暂停' && next.badge.classList.has('is-paused'));
  await board.api.pomo.start({ minutes: 45 });
  advance(2000);
  v = next.api.pomoView();
  judge('继续：接着剩下的走（不是按下拉框重新来 45 分钟），还是同一次专注',
    v.phase === 'running' && v.left === 895 && v.total === 1500 && v.id === board.api.pomoView().id, show(v));
  await board.api.pomo.start({ minutes: 25 });
  judge('已经在跑时再点开始：什么都不变', next.api.pomoView().left === 895 && records.length === 0);

  // ── 4. 到点：只记一次、只提醒一次；每一页都挂标题 ──
  board.api.pomoTick(); next.api.pomoTick();
  const id = next.api.pomoView().id;
  await next.api.pomo.setTask(9, '读论文');
  advance(895 * 1000);
  board.api.pomoTick(); next.api.pomoTick();   // 两页同一刻看到到点（锁还没轮到谁）
  await settle();
  judge('到点：两页同时看到，只记一次，幂等键就是这次专注的 id，记的是专注到一半换上的任务',
    records.length === 1 && records[0].key === id && records[0].durationMinutes === 25 && records[0].taskId === 9 && records[0].day === '2026-10-09',
    show(records));
  judge('只响一次、只弹一个通知', notices.length === 1 && /专注结束\|zq-pomodoro/.test(notices[0]), show(notices));
  const finisher = records[0].by === '看板' ? board : next, other = finisher === board ? next : board;
  other.api.pomoTick();   // 另一页的下一跳（浏览器里是 storage 事件、一秒一跳）
  judge('两页的标题都挂上「✓ 专注结束」（不知道人在看哪一页）',
    board.document.title === '✓ 专注结束 — 看板' && next.document.title === '✓ 专注结束 — AI 助手', board.document.title + ' / ' + next.document.title);
  judge('看板写「已完成」，侧栏那一行收起', board.api.pomoView().phase === 'done' && next.badge.hidden === true, show(board.api.pomoView()));
  other.api.pomoTick(); finisher.api.pomoTick();
  judge('记上了：另一页刷新看板（今天的个数），记的那一页不再刷一遍（它自己刷过）',
    other.afterRecords === 1 && finisher.afterRecords === 0, other.name + '=' + other.afterRecords + ' ' + finisher.name + '=' + finisher.afterRecords);
  advance(16 * 60000);
  judge('做完过了一阵：回到「待开始」，时长留着', board.api.pomoView().phase === 'idle' && board.api.pomoView().total === 1500, show(board.api.pomoView()));

  // ── 5. 一页都没开着的时候到点了 ──
  reset();
  clock.now = Date.UTC(2026, 9, 9, 0, 0, 0);      // 东八区 08:00 开始，08:25 到点
  board = tab('看板', { page: 'dashboard.html' });
  await board.api.pomo.start({ minutes: 25 });
  const lateId = board.api.pomoView().id;
  advance(2 * 3600000);                           // 关了浏览器，10:00 才再打开
  const later = tab('任务');
  later.api.pomoTick();
  await settle();
  later.api.pomoTick();
  judge('关着的时候到点了：下次打开哪一页都补上，幂等键照旧是 id、记到那一天',
    records.length === 1 && records[0].key === lateId && records[0].day === '2026-10-09', show(records));
  judge('过了 15 分钟才发现：不响、不弹、不挂标题，只说一句几点到的', notices.length === 0 && later.document.title === '任务'
    && toasts.some((t) => /番茄钟在 08:25 到点了/.test(t)), show({ notices, toasts, title: later.document.title }));

  reset();
  clock.now = Date.UTC(2026, 9, 9, 15, 30, 0);    // 东八区 10-09 23:30 开始，23:55 到点，第二天 09:00 才打开
  board = tab('看板');
  await board.api.pomo.start({ minutes: 25 });
  advance(9.5 * 3600000);
  tab('看板').api.pomoTick();
  await settle();
  judge('跨了天才补上的：记到结束那天 10-09（不带的话记到了打开的 10-10），提示里带日期',
    records.length === 1 && records[0].day === '2026-10-09' && toasts.some((t) => /番茄钟在 10\/09 23:55 到点了/.test(t)), show({ records, toasts }));

  // ── 6. 钟往回拨 ──
  for (const order of ['同一刻', '一前一后']) {
    reset();
    const A = tab('A'), B = tab('B');
    await A.api.pomo.start({ minutes: 25 });
    advance(60000);
    A.api.pomoTick(); B.api.pomoTick();
    const before = A.api.pomoView().left;   // 24:00
    clock.now -= 10 * 60000; clock.mono += 1000;   // 校时：真钟往回拨十分钟，其实过了一秒
    if (order === '同一刻') { A.api.pomoTick(); B.api.pomoTick(); await settle(); }
    else { A.api.pomoTick(); await settle(); B.api.pomoTick(); await settle(); }
    A.api.pomoTick(); B.api.pomoTick(); await settle();
    const after = B.api.pomoView().left;
    judge('钟往回拨十分钟（两页' + order + '看到）：剩下的只少了真过去的那一秒 —— 不多出十分钟，也不被两页各挪一遍少掉十分钟',
      before === 1440 && after === 1439 && A.api.pomoView().left === 1439, 'before=' + before + ' after=' + after + ' A=' + A.api.pomoView().left);
  }
  reset();
  let lid = tab('合盖');
  await lid.api.pomo.start({ minutes: 25 });
  lid.api.pomoTick();
  clock.now += 5 * 60000;   // 合上盖子五分钟：真钟走了，单调时钟没走
  lid.api.pomoTick(); await settle();
  judge('合上笔记本五分钟：照样少了五分钟（真钟往前走不算拨钟）', lid.api.pomoView().left === 1200, show(lid.api.pomoView()));

  // ── 7. 重置、别的账号、退出 ──
  reset();
  const A = tab('A'), B = tab('B');
  await A.api.pomo.start({ minutes: 25 });
  await B.api.pomo.reset();
  A.api.pomoTick();
  judge('一页按了重置：两页都回到待开始，存储里没了', A.api.pomoView().phase === 'idle' && store.size === 0 && A.badge.hidden === true, show([...store]));
  await A.api.pomo.start({ minutes: 25 });
  const someoneElse = tab('别人', { user: 2 });
  judge('同一个浏览器换了个账号：看不到上一个人的番茄钟', someoneElse.api.pomoView().phase === 'idle');
  A.api.writePomo(null);
  judge('退出时删掉（任务名不留在公用电脑上）', store.size === 0);

  // ── 8. 存不进 localStorage（隐私模式、存满了）──
  reset();
  storageBroken = true;
  const priv = tab('隐私');
  await priv.api.pomo.start({ minutes: 25 });
  advance(60000);
  priv.api.pomoTick();
  judge('存不进存储：这一页照样能用（和原来一样只活在这一页）', priv.api.pomoView().phase === 'running' && priv.api.pomoView().left === 1440, show(priv.api.pomoView()));

  // ── 9. 没有 Web Locks 的浏览器 ──
  reset();
  useLocks = false;
  const X = tab('X'), Y = tab('Y');
  await X.api.pomo.start({ minutes: 25 });
  advance(25 * 60000);
  X.api.pomoTick(); Y.api.pomoTick();
  await settle();
  judge('没有 Web Locks：照样只记一次（标完「做完」才轮到另一页看）', records.length === 1 && notices.length === 1, show({ records, notices }));

  // ── 10. 到点那一刻点了暂停 ──
  reset();
  const P = tab('P');
  await P.api.pomo.start({ minutes: 25 });
  advance(25 * 60000 + 500);
  await P.api.pomo.pause();
  await settle();
  judge('到点那一刻点了暂停：不停在 00:00 的「已暂停」，照样做完、记上', P.api.pomoView().phase === 'done' && records.length === 1, show(P.api.pomoView()));

  reset();
  const J = tab('J');
  await J.api.pomo.start({ minutes: 1 });
  advance(55000); J.api.pomoTick();                        // 还剩 5 秒
  clock.now += 20000 - 10 * 60000; clock.mono += 20000;    // 真过去了 20 秒，其间钟往回拨了十分钟
  await J.api.pomo.pause(); await settle();
  J.api.pomoTick(); await settle();
  judge('钟往回拨、其实已经过了点，这时点了暂停：不会停在负数的「已暂停」（暂停着就再也不会到点），照样做完、记上',
    J.api.pomoView().phase === 'done' && records.length === 1, show({ v: J.api.pomoView(), records: records.length }));

  console.log(fail ? fail + ' FAIL' : 'ALL-GREEN');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
