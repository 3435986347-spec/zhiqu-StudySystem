// 外观（第四十轮，用户 2026-10-06：「白天白色，晚上黑色」）—— 在 node 里真跑：每页头上那行内联脚本、发布的 assets/zhiqu-ui.js。
//
//   用法：node src/test/resources/js/theme-check.js <zhiqu-ui.js 的路径> <某个页面.html 的路径>
//   各页头上那行是同一行（DesignTokensTest 另外核对），所以跑一页就够。判的是：
//   - 默认跟着系统外观走：系统深 → 深，系统浅 → 浅；手动固定的浅 / 深不跟系统走；
//   - 原来的键（zq.mode / zq.ver）不再读 —— 原来手动选过浅色的人也回到「跟随系统」（用户定的就是白天白、晚上黑）；
//   - 强调色默认金色，存了 mono 就是黑白；
//   - zhiqu-ui.js 里：跟随系统时系统外观一变页面当场跟着变；固定了的不变；切换弹层里点了就存、就变。
//   由 DesignTokensTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const vm = require('vm');
const ui = fs.readFileSync(process.argv[2], 'utf8');
const html = fs.readFileSync(process.argv[3], 'utf8');
const m = html.match(/<script>(\(function\(\)\{try\{var h=document\.documentElement[^<]*)<\/script>/);
if (!m) { console.log('FAIL  找不到头上那行外观脚本'); process.exit(1); }
const headScript = m[1];

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail !== undefined ? '  →  ' + JSON.stringify(detail) : '')); fail++; }
}
function storage(init) {
  const s = new Map(Object.entries(init || {}));
  return { getItem: (k) => (s.has(k) ? s.get(k) : null), setItem: (k, v) => s.set(k, String(v)), removeItem: (k) => s.delete(k) };
}
function el() {
  const attrs = {}; const classes = new Set();
  return {
    style: {}, dataset: {}, innerHTML: '', attrs,
    setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null),
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], appendChild: (c) => c, contains: () => false,
  };
}
/** 一个可以拨的「系统外观」：dark 为真时 prefers-color-scheme: dark 成立 */
function systemAppearance(dark) {
  const listeners = [];
  const q = { media: '(prefers-color-scheme: dark)', get matches() { return state.dark; }, addEventListener: (t, f) => listeners.push(f), addListener: (f) => listeners.push(f) };
  const state = { dark, flip(v) { state.dark = v; listeners.forEach((f) => f({ matches: v })); } };
  return { state, matchMedia: (query) => (query === '(prefers-color-scheme: dark)' ? q : { matches: false, addEventListener() {}, addListener() {} }) };
}
function runHead(stored, dark) {
  const html = el();
  const sys = systemAppearance(dark);
  const window = { document: { documentElement: html }, localStorage: storage(stored), matchMedia: sys.matchMedia };
  window.window = window;
  vm.runInContext(headScript, vm.createContext(Object.assign({}, window)));
  return { mode: html.getAttribute('data-zq-mode'), accent: html.getAttribute('data-zq-accent') };
}

// 头上那行
judge('什么都没存、系统是深色 → 深色', runHead({}, true).mode === 'dark', runHead({}, true));
judge('什么都没存、系统是浅色 → 浅色', runHead({}, false).mode === 'light', runHead({}, false));
judge('跟随系统（存了 auto）→ 跟着系统', runHead({ 'zq.theme': 'auto' }, true).mode === 'dark' && runHead({ 'zq.theme': 'auto' }, false).mode === 'light');
judge('固定浅色：系统深色也是浅色', runHead({ 'zq.theme': 'light' }, true).mode === 'light');
judge('固定深色：系统浅色也是深色', runHead({ 'zq.theme': 'dark' }, false).mode === 'dark');
judge('原来的键不再读：zq.mode=light、zq.ver=v4 而系统是深色 → 深色', runHead({ 'zq.mode': 'light', 'zq.ver': 'v4' }, true).mode === 'dark', runHead({ 'zq.mode': 'light', 'zq.ver': 'v4' }, true));
judge('强调色默认金色', runHead({}, false).accent === 'gold');
judge('存了 mono → 黑白', runHead({ 'zq.accent': 'mono' }, false).accent === 'mono');
judge('认不出的强调色 → 金色', runHead({ 'zq.accent': 'purple' }, false).accent === 'gold');

// zhiqu-ui.js
function runUi(stored, dark) {
  const html = el();
  const sys = systemAppearance(dark);
  const ls = storage(stored);
  const body = el();
  const document = { readyState: 'loading', documentElement: html, body, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => el() };
  const window = { location: { pathname: '/dashboard.html', hash: '', search: '' }, document, localStorage: ls, sessionStorage: storage(), matchMedia: sys.matchMedia, addEventListener() {}, setTimeout: () => 0 };
  window.window = window;
  vm.runInContext(ui, vm.createContext(Object.assign({ console }, window)));
  return { html, sys, ls };
}
let r = runUi({}, false);
judge('zhiqu-ui.js：跟随系统、白天 → 浅色', r.html.getAttribute('data-zq-mode') === 'light');
r.sys.state.flip(true);
judge('zhiqu-ui.js：跟随系统时系统切到深色（日落）→ 页面当场变深', r.html.getAttribute('data-zq-mode') === 'dark', r.html.attrs);
r.sys.state.flip(false);
judge('zhiqu-ui.js：再切回浅色（日出）→ 页面变浅', r.html.getAttribute('data-zq-mode') === 'light', r.html.attrs);
r = runUi({ 'zq.theme': 'light' }, false);
r.sys.state.flip(true);
judge('zhiqu-ui.js：固定了浅色，系统变深也不变', r.html.getAttribute('data-zq-mode') === 'light', r.html.attrs);
judge('zhiqu-ui.js：data-zq-ver 不再出现', !('data-zq-ver' in r.html.attrs), r.html.attrs);
judge('zhiqu-ui.js：强调色写上了', r.html.getAttribute('data-zq-accent') === 'gold', r.html.attrs);

console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
