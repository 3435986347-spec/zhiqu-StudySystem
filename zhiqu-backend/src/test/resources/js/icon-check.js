// 图标（第四十二轮，docs/ui-plan.md 第 2 步）—— 在 node 里真跑发布的 assets/zhiqu-ui.js（假的最小 DOM）。
//
//   用法：node src/test/resources/js/icon-check.js <zhiqu-ui.js 的路径> <图标名> [<图标名> …]
//   图标名由 IconSetTest 从源码里扫出来（NAV 的第三项、icon('…')、data-zq-icon="…"）交给这里 —— 判的是「代码里用到的名字」和「画得出来的名字」这一对：
//   拼错一个、少画一个，页面上就是一块空白，一个字都不报（icon() 对认不出的名字给空串）。
//   打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');
const names = process.argv.slice(3);
if (!names.length) { console.log('FAIL  没给图标名 —— 扫空了？'); process.exit(1); }

function el() {
  const attrs = {};
  return { innerHTML: '', style: {}, dataset: {}, attrs,
    setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null),
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], appendChild: (c) => c };
}
const placeholders = [el(), el()];
placeholders[0].setAttribute('data-zq-icon', 'plus');
placeholders[1].setAttribute('data-zq-icon', 'no-such-icon');
const html = el();
const document = { readyState: 'complete', documentElement: html, body: el(), getElementById: () => null,
  querySelector: () => null, querySelectorAll: (sel) => (sel === '[data-zq-icon]' ? placeholders : []), addEventListener() {}, createElement: () => el() };
const window = { location: { pathname: '/dashboard.html', hash: '', search: '' }, document,
  localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), addEventListener() {}, setTimeout: () => 0 };
window.window = window;
vm.runInContext(src, vm.createContext(Object.assign({ console }, window)));
const ui = window.ZQUI;

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail !== undefined ? '  →  ' + JSON.stringify(detail) : '')); fail++; }
}
judge('ZQUI.icon 在', ui && typeof ui.icon === 'function');
for (const n of names) {
  const svg = ui.icon(n);
  judge('「' + n + '」画得出来：24 格的线性 SVG、读屏忽略',
    /^<svg class="zq-icon" [^>]*viewBox="0 0 24 24"[^>]*stroke="currentColor"[^>]*aria-hidden="true"[^>]*>/.test(svg) && /<(path|rect|circle|line|polyline)\b/.test(svg) && svg.endsWith('</svg>'),
    svg.slice(0, 80));
}
judge('认不出的名字给空串（不报错、不画别的）', ui.icon('no-such-icon') === '' && ui.icon('') === '' && ui.icon(undefined) === '');
judge('启动时 data-zq-icon 占位被填上', placeholders[0].innerHTML.startsWith('<svg class="zq-icon"'), placeholders[0].innerHTML.slice(0, 40));
judge('认不出的占位留空', placeholders[1].innerHTML === '');
placeholders[0].innerHTML = 'kept';
ui.paintIcons();
judge('同一个占位只填一次（再调 paintIcons 不覆盖）', placeholders[0].innerHTML === 'kept');

console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
