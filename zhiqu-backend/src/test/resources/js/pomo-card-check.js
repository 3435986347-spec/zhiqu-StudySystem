// 看板的番茄钟卡片（第四十九轮）—— 从发布的 assets/pages/dashboard.js 里抠出 wirePomo / drawPomo 真跑（假的最小 DOM、假的壳里的钟）。
//
//   用法：node src/test/resources/js/pomo-card-check.js <dashboard.js 的路径>
//   钟在壳里（pomo-shared-check.js 管）；这里只看卡片：画得对不对、按钮交给壳的哪一样、看板重新取的时候按钮不会接两遍。
//   由 PomodoroSharedTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('/** 环的周长（r = 80） */'), b = src.indexOf('/** 一个日子里最多画几个点', a);
if (a < 0 || b < 0) throw new Error('抠不到番茄钟卡片那一段');
const body = src.slice(a, b);

const attrs = {};
function node(id, extra) {
  return Object.assign({ id, textContent: '', disabled: false, dataset: {}, onclick: null, onchange: null,
    setAttribute: (k, v) => { attrs[id + '.' + k] = String(v); } }, extra || {});
}
function select(id, opts) {
  const s = node(id, { options: opts.map(([value, text]) => ({ value, text })), selectedIndex: 0 });
  Object.defineProperty(s, 'value', {
    get: () => (s.options[s.selectedIndex] || {}).value || '',
    set: (v) => { const i = s.options.findIndex((o) => o.value === String(v)); if (i >= 0) s.selectedIndex = i; },
  });
  s.querySelector = (q) => { const m = /option\[value="([^"]*)"\]/.exec(q); return m && s.options.find((o) => o.value === m[1]) || null; };
  s.appendChild = (o) => { s.options.push({ value: o.value, text: o.textContent }); };
  return s;
}
const els = {
  '#zq-pomo-time': node('time'), '#zq-pomo-ring': node('ring'), '#zq-pomo-phase': node('phase'),
  '#zq-pomo-start': node('start'), '#zq-pomo-reset': node('reset'),
  '#zq-pomo-min': select('min', [['25', '25 分钟'], ['45', '45 分钟'], ['60', '60 分钟']]),
  '#zq-pomo-task': select('task', [['', '（不指定任务）'], ['7', '写周报']]),
};
const document = { activeElement: null, createElement: () => ({ value: '', textContent: '' }) };
const calls = [];
let view = { phase: 'idle', left: 0, total: 0, taskId: null, taskTitle: '' };
let subs = 0;
const pomo = {
  view: () => view,
  clock: (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'),
  start: (o) => calls.push(['start', o]), pause: () => calls.push(['pause']), reset: () => calls.push(['reset']),
  setTask: (id, title) => calls.push(['setTask', id, title]),
  subscribe: (fn) => { subs++; fn(view); },
};
const fns = new Function('$', 'pomo', 'document', body + '\nreturn { wirePomo, drawPomo };')((q) => els[q] || null, pomo, document);

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail !== undefined ? '  →  ' + JSON.stringify(detail) : '')); fail++; }
}
const T = () => ({ time: els['#zq-pomo-time'].textContent, phase: els['#zq-pomo-phase'].textContent, btn: els['#zq-pomo-start'].textContent,
  minDisabled: els['#zq-pomo-min'].disabled, min: els['#zq-pomo-min'].value, task: els['#zq-pomo-task'].value, ring: attrs['ring.stroke-dasharray'] });

fns.wirePomo();
fns.wirePomo();   // 看板重新取（换周、记完一个、跨零点）又跑一遍
judge('看板重新取几遍，按钮只接一次、只订一次', subs === 1, subs);
let t = T();
judge('待开始：时间是下拉框的时长、环是空的、按钮写「开始」', t.time === '25:00' && t.phase === '待开始' && t.btn === '开始' && !t.minDisabled && /^0\.0 /.test(t.ring), t);
els['#zq-pomo-min'].value = '45';
els['#zq-pomo-min'].onchange();
judge('待开始时换时长：时间跟着变成 45:00', T().time === '45:00', T());
els['#zq-pomo-task'].value = '7';
els['#zq-pomo-start'].onclick();
judge('点开始：交给壳，带上时长和任务（id 和名字 —— 迷你窗要显示名字）',
  JSON.stringify(calls.pop()) === JSON.stringify(['start', { minutes: 45, taskId: 7, taskTitle: '写周报' }]), calls);

view = { phase: 'running', id: 'x', total: 1500, left: 897, taskId: 9, taskTitle: '读论文' };
fns.drawPomo(view);
t = T();
judge('在跑：14:57、专注中、按钮写「暂停」、时长锁住并且是这一个钟的 25 分钟、环走了四成多',
  t.time === '14:57' && t.phase === '专注中' && t.btn === '暂停' && t.minDisabled && t.min === '25' && t.ring.startsWith((603 / 1500 * 2 * Math.PI * 80).toFixed(1) + ' '), t);
judge('在跑的那一个关联的任务不在下拉框里（别的页换的、做完了的）：补一项、选上它',
  t.task === '9' && els['#zq-pomo-task'].options.some((o) => o.value === '9' && o.text === '读论文'), els['#zq-pomo-task'].options);
els['#zq-pomo-start'].onclick();
judge('在跑时点按钮：暂停', JSON.stringify(calls.pop()) === '["pause"]', calls);
els['#zq-pomo-task'].value = '7';
els['#zq-pomo-task'].onchange();
judge('专注到一半换任务：告诉壳（记的时候算新的那个）', JSON.stringify(calls.pop()) === JSON.stringify(['setTask', 7, '写周报']), calls);
document.activeElement = els['#zq-pomo-task'];
els['#zq-pomo-task'].value = '';
fns.drawPomo(view);
judge('人正在选任务的时候，一秒一次的重画不把下拉框拨回去', els['#zq-pomo-task'].value === '', T());
document.activeElement = null;

view = { phase: 'paused', id: 'x', total: 1500, left: 897, taskId: 9, taskTitle: '读论文' };
fns.drawPomo(view);
judge('暂停着：还是 14:57、已暂停、按钮写「继续」', T().time === '14:57' && T().phase === '已暂停' && T().btn === '继续' && T().minDisabled, T());

view = { phase: 'done', id: 'x', total: 1500, left: 1500, taskId: 9, taskTitle: '读论文' };
els['#zq-pomo-min'].disabled = false;
els['#zq-pomo-min'].value = '60';
fns.drawPomo(view);
judge('做完了：写「已完成」，时间回到下拉框的时长、可以再开始', T().phase === '已完成' && T().time === '60:00' && T().btn === '开始' && !T().minDisabled, T());
els['#zq-pomo-reset'].onclick();
judge('重置：交给壳', JSON.stringify(calls.pop()) === '["reset"]', calls);

console.log(fail ? fail + ' FAIL' : 'ALL-GREEN');
process.exit(fail ? 1 : 0);
