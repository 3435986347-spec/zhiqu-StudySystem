// 看板（第四十八轮，界面打磨第 5 步）—— 从发布的 assets/pages/dashboard.js 里抠出画日历、清单、四象限、临近截止的那几个函数真跑（假的最小 DOM）。
//
//   用法：node src/test/resources/js/dashboard-check.js <dashboard.js 的路径>
//   原来：本周日历每天五个灰块「08:00 例…」、标题截到一两个字；清单只能看今天；临近截止每条一个一模一样的「DDL」。
//   现在：一天一格（点、件数、今天、选中），点一天清单换成那一天的（以后的日子没有「完成」）；截止写还有几天。
//   由 DashboardLookTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('/** 一个日子里最多画几个点');
if (a < 0) throw new Error('抠不到 renderWeek 那一段');
const body = src.slice(a);

function el(id) {
  const classes = new Set(), attrs = {};
  const node = {
    id, innerHTML: '', textContent: '', onclick: null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return on; } },
    setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
  return node;
}
const hosts = { '#zq-week': el('zq-week'), '#zq-today': el('zq-today'), '#zq-today-title': el('zq-today-title'), '#zq-quad': el('zq-quad'), '#zq-ddl': el('zq-ddl') };
// innerHTML 里的按钮：按属性认出来、做成假元素（同一次渲染的同一批）
const made = new Map();
function buttonsIn(host, attr) {
  const key = host.id + '|' + attr + '|' + host.innerHTML;
  if (made.has(key)) return made.get(key);
  const re = new RegExp('<button[^>]*' + attr + '="([^"]*)"[^>]*>', 'g');
  const out = [];
  let m;
  while ((m = re.exec(host.innerHTML))) {
    const b = el();
    const tag = m[0];
    b.setAttribute(attr, m[1]);
    for (const c of ((tag.match(/class="([^"]*)"/) || [])[1] || '').split(/\s+/).filter(Boolean)) b.classList.add(c);
    const pressed = tag.match(/aria-pressed="([^"]*)"/);
    if (pressed) b.setAttribute('aria-pressed', pressed[1]);
    out.push(b);
  }
  made.set(key, out);
  return out;
}
const $ = (sel) => hosts[sel] || null;
const $all = (sel, root) => {
  if (sel === '[data-day]') return buttonsIn(root, 'data-day');
  if (sel === '#zq-week [data-day]') return buttonsIn(hosts['#zq-week'], 'data-day');
  if (sel === '[data-task-done]') return buttonsIn(root, 'data-task-done');
  return [];
};
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const state = {};
const fns = new Function('$', '$all', 'esc', 'empty', 'qKey', 'qLabel', 'fmtDate', 'hm', 'today', 'state', 'safe', 'api', 'bootDashboard',
  body + '\nreturn { renderWeek, showDay, renderToday, renderQuadrants, daysUntil, dueLabel, renderDeadlines };')(
  $, $all, esc, (t) => '<div class="zq-empty">' + t + '</div>', (q) => 'q' + (q || 4), (q) => ['', '重要且紧急', '重要不紧急', '紧急不重要', '不重要不紧急'][q] || '',
  (v) => String(v || '').replace('T', ' ').slice(0, 16), (v) => (v ? String(v).slice(11, 16) : ''), () => '2026-10-08', state, () => {}, {}, () => {});

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail !== undefined ? '  →  ' + JSON.stringify(detail) : '')); fail++; }
}

const task = (id, q, extra = {}) => Object.assign({ id, kind: 'TASK', quadrant: q, title: '任务' + id, time: '10:00', status: 0 }, extra);
const routine = (id, extra = {}) => Object.assign({ id, kind: 'ROUTINE', title: '例行' + id, time: '', completed: false }, extra);
const many = Array.from({ length: 11 }, (_, i) => task(100 + i, (i % 4) + 1));
const days = [
  { date: '2026-10-05', day: 5, weekday: '周一', today: false, items: [task(1, 1, { status: 2 }), routine(2, { completed: true })] },
  { date: '2026-10-06', day: 6, weekday: '周二', today: false, items: [] },
  { date: '2026-10-07', day: 7, weekday: '周三', today: false, items: many },
  { date: '2026-10-08', day: 8, weekday: '周四', today: true, items: [task(3, 2), routine(4)] },
  { date: '2026-10-09', day: 9, weekday: '周五', today: false, items: [task(5, 3)] },
  { date: '2026-10-10', day: 10, weekday: '周六', today: false, items: [] },
  { date: '2026-10-11', day: 11, weekday: '周日', today: false, items: [] },
];
state.weekDays = days;
fns.renderWeek(days);
const week = hosts['#zq-week'].innerHTML;
const cells = week.split('<button type="button" class="zq-day').slice(1);
judge('日历：一天一格，七格都是按钮', cells.length === 7);
judge('日历：不再画「08:00 例…」那种截断的条目（格子里没有任务标题）', !/任务\d|例行\d/.test(week), week.slice(0, 200));
judge('日历：今天那格标了 is-today、默认选中（aria-pressed）', / is-today is-on" data-day="2026-10-08"[^>]*aria-pressed="true"/.test(week));
judge('日历：一件事一个点，颜色是象限（q1…q4），例行计划是 r，做完的变淡', cells[0].includes('<i class="q1 done"></i>') && cells[0].includes('<i class="r done"></i>') && cells[3].includes('<i class="q2"></i><i class="r"></i>'), cells[0]);
judge('日历：最多 8 个点，多了写「+N」', (cells[2].match(/<i /g) || []).length === 8 && cells[2].includes('+3'), cells[2]);
judge('日历：写几项；没有的写「—」', cells[0].includes('>2 项<') && cells[1].includes('>—<'));
judge('日历：读屏念得出是哪天、几项', cells[2].includes('aria-label="周三 2026-10-07，11 项"') && cells[1].includes('没有安排'));

fns.renderToday(days[3].items, days[3].date);
judge('清单：今天的标题是「今天」、每条都有「完成」', hosts['#zq-today-title'].textContent === '今天' && (hosts['#zq-today'].innerHTML.match(/data-task-done=/g) || []).length === 2);
judge('清单：一条一行（zq-agenda-row），不再一条一张带底色的卡片', (hosts['#zq-today'].innerHTML.match(/class="zq-agenda-row/g) || []).length === 2 && !/background:var\(--zq-tint\)/.test(hosts['#zq-today'].innerHTML));
judge('清单：例行计划没填时间也画得出来（时间用 hm 补，没有就空着）', hosts['#zq-today'].innerHTML.includes('例行4'));

const dayBtn = (date) => $all('[data-day]', hosts['#zq-week']).find((b) => b.getAttribute('data-day') === date);
dayBtn('2026-10-09').onclick();
judge('点周五：标题换成「10/09 周五」，清单是那天的', hosts['#zq-today-title'].textContent === '10/09 周五' && hosts['#zq-today'].innerHTML.includes('任务5') && !hosts['#zq-today'].innerHTML.includes('任务3'));
judge('点周五：以后的日子不给「完成」（还没到）', !hosts['#zq-today'].innerHTML.includes('data-task-done'));
judge('点周五：选中的格子换过去（is-on、aria-pressed），记在 state.dashDay', dayBtn('2026-10-09').classList.contains('is-on') && dayBtn('2026-10-09').getAttribute('aria-pressed') === 'true'
  && !dayBtn('2026-10-08').classList.contains('is-on') && state.dashDay === '2026-10-09');
dayBtn('2026-10-05').onclick();
judge('点过去的一天（周一）：有「完成」（补打卡）', hosts['#zq-today-title'].textContent === '10/05 周一' && hosts['#zq-today'].innerHTML.includes('data-task-done'));
dayBtn('2026-10-06').onclick();
judge('点一天空的：说这一天没有安排', hosts['#zq-today'].innerHTML.includes('这一天没有安排'));
dayBtn('2026-10-08').onclick();
judge('点回今天：标题回到「今天」，state.dashDay 清掉', hosts['#zq-today-title'].textContent === '今天' && state.dashDay === null);
fns.renderWeek(days);
judge('重新画日历：选中的还是记着的那天', /is-today is-on/.test(hosts['#zq-week'].innerHTML));

judge('还有几天：今天 0、明天 1、三天后 3、逾期 -2、日期坏了 null', JSON.stringify([fns.daysUntil('2026-10-08T18:00:00'), fns.daysUntil('2026-10-09T09:00:00'), fns.daysUntil('2026-10-11'), fns.daysUntil('2026-10-06T23:59:59'), fns.daysUntil('坏了')]) === '[0,1,3,-2,null]');
judge('还有几天的说法', [fns.dueLabel(0), fns.dueLabel(1), fns.dueLabel(3), fns.dueLabel(-2), fns.dueLabel(null)].join('|') === '今天|明天|3 天后|逾期 2 天|');
fns.renderDeadlines([{ title: '交方案', deadline: '2026-10-08T18:00:00' }, { title: '写周报', deadline: '2026-10-12T18:00:00' }, { title: '报销', deadline: '2026-10-06T12:00:00' }]);
const ddl = hosts['#zq-ddl'].innerHTML;
judge('临近截止：右边写还有几天，不再是一模一样的「DDL」', ddl.includes('>今天<') && ddl.includes('>4 天后<') && ddl.includes('>逾期 2 天<') && !ddl.includes('>DDL<'), ddl.slice(0, 300));
judge('临近截止：今天和逾期的标红（is-near），以后的不标', (ddl.match(/is-near/g) || []).length === 2);

fns.renderQuadrants([{ quadrant: 1, total: 3, items: [{ title: '季度汇报' }] }, { quadrant: 2, total: 0, items: [] }]);
const quad = hosts['#zq-quad'].innerHTML;
// 第八十一轮：小点的颜色在样式表（.zq-qdot[data-q]），这里认 data-q；整段 HTML 里不许再有内联的样子
judge('四象限：象限色只在名字前的小点上，不再整片彩色底、顶上彩边', quad.includes('<i class="zq-qdot" data-q="q1"></i>') && !/-bg\)|border-top:3px|style=/.test(quad));
judge('四象限：写件数；空的说没有待办', quad.includes('>3 项<') && quad.includes('没有待办'));

console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
