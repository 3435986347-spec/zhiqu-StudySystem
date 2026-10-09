// 首页轮播（第四十六轮）—— 从发布的 index.html 里抠出那一段内联脚本真跑（假的最小 DOM）。
//
//   用法：node src/test/resources/js/home-tour-check.js <index.html 的路径>
//   用户 2026-10-06：「主页轮播图需要改一下」→「截图要换，轮播样式也改」。原来 4.5 秒横着滑一张：鼠标停在上面照样滑、
//   系统设了「减少动态效果」照样滑、标签页在后台也一直在滑。现在：6 秒换一张；停在上面 / 焦点在里面 / 后台不换；点过、按过之后不再自己换；
//   减少动态效果就不自己换；页签按左右键 / Home / End 走（roving tabindex），说明那一行跟着换。
//   由 HomeCarouselTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const a = html.indexOf('/* ── 首页轮播（第四十六轮）──');
const b = html.indexOf('})();', a);
if (a < 0 || b < 0) throw new Error('index.html 里抠不到轮播那一段脚本');
const body = html.slice(a, b + 5);

function el(id, attrs = {}) {
  const classes = new Set();
  const handlers = {};
  const a2 = Object.assign({}, attrs);
  return {
    id, tabIndex: 0, textContent: '',
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return on; } },
    setAttribute: (k, v) => { a2[k] = String(v); }, getAttribute: (k) => (k in a2 ? a2[k] : null),
    addEventListener: (t, f) => { (handlers[t] = handlers[t] || []).push(f); },
    fire(t, ev = {}) { (handlers[t] || []).forEach((f) => f(Object.assign({ preventDefault() { ev.prevented = true; } }, ev))); },
    focus() { doc.activeElement = this; },
    contains: (x) => false,
  };
}
let doc;
function setup({ reduce = false, hidden = false } = {}) {
  const tabs = [0, 1, 2, 3].map((k) => el('tab' + k));
  const slides = [0, 1, 2, 3].map((k) => el('slide' + k, { 'data-cap': '说明' + k }));
  const cap = el('zq-tour-cap');
  const root = el('zq-tour');
  const inside = new Set([...tabs, ...slides]);
  root.contains = (x) => inside.has(x);
  root.querySelectorAll = (sel) => (sel === '[role="tab"]' ? tabs : sel === '[role="tabpanel"]' ? slides : []);
  const docHandlers = {};
  const timers = [];
  doc = {
    hidden, activeElement: null,
    getElementById: (id) => ({ 'zq-tour': root, 'zq-tour-cap': cap }[id] || null),
    addEventListener: (t, f) => { (docHandlers[t] = docHandlers[t] || []).push(f); },
  };
  const window = { matchMedia: (q) => ({ matches: reduce && q.includes('prefers-reduced-motion') }) };
  new Function('document', 'window', 'setTimeout', 'clearTimeout', body)(
    doc, window,
    (f, ms) => { timers.push({ f, ms, live: true }); return timers.length; },
    (id) => { if (id && timers[id - 1]) timers[id - 1].live = false; });
  const live = () => timers.filter((t) => t.live);
  const tick = () => { const t = live(); t.forEach((x) => { x.live = false; x.f(); }); return t.map((x) => x.ms); };
  const on = () => tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
  return { tabs, slides, cap, root, live, tick, on, visibility: () => (docHandlers.visibilitychange || []).forEach((f) => f()) };
}

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail !== undefined ? '  →  ' + JSON.stringify(detail) : '')); fail++; }
}

let t = setup();
judge('一开始是第一张：页签选中、图片露出、说明是它的', t.on() === 0 && t.slides[0].classList.contains('is-on') && t.cap.textContent === '说明0');
judge('roving tabindex：只有选中的页签能 Tab 到', t.tabs.map((x) => x.tabIndex).join() === '0,-1,-1,-1', t.tabs.map((x) => x.tabIndex));
judge('6 秒后换下一张', t.live().length === 1 && t.live()[0].ms === 6000, t.live().map((x) => x.ms));
t.tick();
judge('换过去：页签、图片、说明一起换', t.on() === 1 && t.slides[1].classList.contains('is-on') && !t.slides[0].classList.contains('is-on') && t.cap.textContent === '说明1');
t.tick(); t.tick(); t.tick();
judge('最后一张之后回到第一张', t.on() === 0);

t.root.fire('pointerenter');
judge('鼠标停在上面：不换', t.live().length === 0);
t.root.fire('pointerleave');
judge('移开：接着换', t.live().length === 1);
t.root.fire('focusin');
judge('焦点在里面（键盘走进来）：不换', t.live().length === 0);
t.root.fire('focusout', { relatedTarget: t.tabs[2] });
judge('焦点在里面挪来挪去：还是不换', t.live().length === 0);
t.root.fire('focusout', { relatedTarget: null });
judge('焦点出去了：接着换', t.live().length === 1);

doc.hidden = true; t.visibility();
judge('标签页到后台：不换', t.live().length === 0);
doc.hidden = false; t.visibility();
judge('回到前台：接着换', t.live().length === 1);

t.tabs[2].fire('click');
judge('点页签：换到那一张', t.on() === 2 && t.slides[2].classList.contains('is-on') && t.cap.textContent === '说明2');
judge('点过之后不再自己换（你在看哪一张就是哪一张）', t.live().length === 0);

t = setup();
const k = { key: 'ArrowRight' };
t.tabs[0].fire('keydown', k);
judge('右键：下一张、焦点跟过去', t.on() === 1 && doc.activeElement === t.tabs[1] && k.prevented === true);
t.tabs[1].fire('keydown', { key: 'ArrowLeft' }); t.tabs[0].fire('keydown', { key: 'ArrowLeft' });
judge('左键在第一张上：绕到最后一张', t.on() === 3 && doc.activeElement === t.tabs[3]);
t.tabs[3].fire('keydown', { key: 'Home' });
judge('Home：第一张', t.on() === 0);
t.tabs[0].fire('keydown', { key: 'End' });
judge('End：最后一张；tabindex 跟着走', t.on() === 3 && t.tabs.map((x) => x.tabIndex).join() === '-1,-1,-1,0');
const other = { key: 'a' };
t.tabs[3].fire('keydown', other);
judge('别的键：不拦、不换', t.on() === 3 && !other.prevented);
judge('按过键之后不再自己换', t.live().length === 0);

t = setup({ reduce: true });
judge('系统设了「减少动态效果」：不自己换', t.live().length === 0 && t.on() === 0);
t.tabs[1].fire('click');
judge('减少动态效果时点页签照样换', t.on() === 1);

t = setup({ hidden: true });
judge('在后台打开的页面：先不换', t.live().length === 0);

console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
