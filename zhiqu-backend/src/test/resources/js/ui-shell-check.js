// 页面切换（第三十九轮）—— 在 node 里真跑发布的 assets/zhiqu-ui.js（假的最小 DOM），不从源码里抠。
//
//   用法：node src/test/resources/js/ui-shell-check.js <zhiqu-ui.js 的路径>
//   判这几件事：
//   1. 哪些页面一打开先遮住主内容区（zq-booting）：只有后台页和两个旧地址的跳转页；别的页面一打开就露出骨架。
//      第一版把这个判断放在 NAV 定义之前 —— isAdminPage 读 NAV.admin 时 NAV 还是 undefined，抛了被 try 吞掉，后台页就不遮了。
//      源码判据看不出这种错（写法都对，只是先后不对），所以真跑。
//   2. 左下角的名字：上一页记下的先画上，但只认同一张令牌（换了账号不认）；名字是用户填的，进 innerHTML 之前要转义。
//   3. 侧栏的收起按钮（第四十三轮）：是品牌那一行里的一个小图标按钮（原来是导航最上面一整条带「收起」二字的按钮）；
//      只有图标，所以名字靠 aria-label，而且要跟着收起 / 展开换。
//   4. 两侧可收起的面板（AI 助手、Wiki，第四十四轮）：开关只是面板图标（原来收起后的竖条上竖排着面板的名字），名字在提示和 aria-label 里。
//   5. 悬停提示（第四十五轮）：桌面应用的 WKWebView 不显示原生的 title 提示（用户：「鼠标悬停的时候也没有显示名字」），zhiqu-ui.js 自己画。
//   6. 文件拖到页面上没人接的地方（第四十七轮 review）：浏览器 / 桌面应用默认会「打开那个文件」、整页换掉 —— 没人接的地方不让放。
//   由 PageSwitchSmoothnessTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');

function el(tag) {
  const classes = new Set();
  const attrs = {};
  const node = {
    tagName: tag || 'div', style: {}, dataset: {}, innerHTML: '', textContent: '', innerText: '', className: '', children: [],
    nodeType: 1, parentNode: null, isConnected: true, offsetWidth: 80, offsetHeight: 24, scrollWidth: 0, clientWidth: 0,
    rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, getBoundingClientRect: () => node.rect,
    hasAttribute: (k) => k in attrs,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c), toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : on; if (v) classes.add(c); else classes.delete(c); return v; },
    },
    setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null), removeAttribute: (k) => { delete attrs[k]; },
    addEventListener() {}, removeEventListener() {}, contains: () => false, focus() {},
    appendChild(c) { node.children.push(c); return c; }, insertBefore(c) { node.children.unshift(c); return c; },
    querySelectorAll: () => [],
  };
  const found = {};
  node.querySelector = (sel) => (found[sel] = found[sel] || el());
  node._found = found;
  return node;
}
function storage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

/** 在 pathname 页面上把 zhiqu-ui.js 跑一遍，返回 html 元素、侧栏、window */
function load(pathname, session, local, panels) {
  const html = el('html');
  const side = el('aside');
  const docH = {}, docOptions = {}, winH = {}, timers = [];
  const document = {
    readyState: 'complete', documentElement: html, body: el('body'),
    getElementById: (id) => (id === 'zq-side' ? side : null),
    querySelector: () => null, querySelectorAll: (sel) => (sel === '[data-zq-collapse]' && panels ? panels : []), createElement: (t) => el(t),
    addEventListener: (t, f, options) => {
      (docH[t] = docH[t] || []).push(f);
      (docOptions[t] = docOptions[t] || []).push(options);
    },
  };
  const window = {
    location: { pathname, hash: '', search: '' }, document,
    localStorage: storage(local), sessionStorage: storage(session),
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    innerWidth: 1440, innerHeight: 900,
    addEventListener: (t, f) => { (winH[t] = winH[t] || []).push(f); }, clearTimeout: (id) => { if (id && timers[id - 1]) timers[id - 1].live = false; },
    setTimeout: (f, ms) => { timers.push({ f, ms, live: true }); return timers.length; },
  };
  window.window = window;
  const ctx = vm.createContext(Object.assign({ console }, window));
  vm.runInContext(src, ctx, { filename: 'zhiqu-ui.js' });
  return { html, side, ui: window.ZQUI, session: window.sessionStorage, docH, docOptions, winH, timers, body: document.body, document };
}

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail !== undefined ? '  →  ' + JSON.stringify(detail) : '')); fail++; }
}

// 1. 遮不遮
const held = ['admin.html', 'account-admin.html', 'feedback-admin.html', 'shared-plan-admin.html', 'profile.html', 'achievement.html'];
const shown = ['ai-assistant.html', 'dashboard.html', 'tasks.html', 'routines.html', 'shared-plans.html', 'knowledge-wiki.html', 'statistics.html'];
for (const p of held) judge(p + ' 先遮住主内容区（要么被劝返、要么马上跳走）', load('/' + p).html.classList.contains('zq-booting'));
for (const p of shown) judge(p + ' 一打开就露出骨架，不遮', !load('/' + p).html.classList.contains('zq-booting'));
judge('大小写不同也认得出后台页', load('/Admin.html').html.classList.contains('zq-booting'));

// 2. 左下角
const token = 'header.payload.signature-of-this-session-0123456789';
const cache = (owner, name) => JSON.stringify({ owner, name, account: 'acc', avatar: '', admin: true });
let r = load('/dashboard.html', { token, 'zq.sideUser': cache(token.slice(-24), '<img src=x onerror=alert(1)>王') });
let btn = r.side._found['.zq-user'];
judge('同一张令牌：上一页记下的名字先画上', btn && btn.innerHTML.includes('王') && btn.innerHTML.includes('管理员'), btn && btn.innerHTML);
judge('名字转义了（用户填的，进 innerHTML）', btn && !btn.innerHTML.includes('<img') && btn.innerHTML.includes('&lt;img'), btn && btn.innerHTML);
judge('名字记到按钮上（头像菜单顶上那一行从这里读）', btn && btn.dataset.name === '<img src=x onerror=alert(1)>王', btn && btn.dataset);

r = load('/dashboard.html', { token: 'another-session-token-entirely-different-xyz', 'zq.sideUser': cache(token.slice(-24), '别人') });
btn = r.side._found['.zq-user'];
judge('换了令牌（换了账号）：不认上一个人的名字，先空着', btn && !btn.innerHTML.includes('别人') && btn.innerHTML.includes('&nbsp;'), btn && btn.innerHTML);

r = load('/tasks.html', { token });
btn = r.side._found['.zq-user'];
judge('没有记下的：两行空白占位（高度不变）', btn && btn.innerHTML.includes('&nbsp;') && !btn.innerHTML.includes('普通用户'), btn && btn.innerHTML);
r.ui.paintUser(btn, { name: '李四', account: 'lisi', avatar: '', admin: false });
const saved = JSON.parse(r.session.getItem('zq.sideUser') || 'null');
judge('/auth/info 回来画一次就记下，按这张令牌记', saved && saved.name === '李四' && saved.owner === token.slice(-24), saved);
judge('令牌本身不进这份记录', !String(r.session.getItem('zq.sideUser')).includes(token), r.session.getItem('zq.sideUser'));

// 3. 收起按钮
/** 从 at 处的 <div 开始，找到和它配对的 </div>，返回整段 */
function divAt(html, at) {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = at;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(at, re.lastIndex);
  }
  return '';
}
r = load('/dashboard.html', { token });
const sideHtml = r.side.innerHTML;
const brandAt = sideHtml.indexOf('<div class="zq-brand">');
const brand = brandAt < 0 ? '' : divAt(sideHtml, brandAt);
judge('侧栏有品牌那一行', brand.includes('zq-brand-badge'), sideHtml.slice(0, 200));
const toggle = (brand.match(/<button[^>]*class="zq-side-toggle"[^>]*>[\s\S]*?<\/button>/) || [''])[0];
judge('收起按钮在品牌那一行里（不再是导航最上面单独一整条）', toggle !== '', brand);
judge('整个侧栏只有这一个收起按钮', (sideHtml.match(/class="zq-side-toggle"/g) || []).length === 1, sideHtml);
judge('收起按钮只有图标，没有字', toggle.includes('<svg') && toggle.replace(/<[^>]*>/g, '').trim() === '', toggle);
// 只有图标，名字全靠 aria-label：启动时由 applySideCollapsed 按收起与否写上
let tg = r.side._found['.zq-side-toggle'];
judge('展开着：按钮叫「收起导航栏」', tg && tg.getAttribute('aria-label') === '收起导航栏' && tg.title === '收起导航栏', tg && [tg.getAttribute('aria-label'), tg.title]);
r = load('/dashboard.html', { token }, { 'zq-side-collapsed': '1' });
tg = r.side._found['.zq-side-toggle'];
judge('收起着：按钮改叫「展开导航栏」（读屏软件念的也跟着换）', r.side.classList.contains('is-collapsed') && tg && tg.getAttribute('aria-label') === '展开导航栏',
  tg && [r.side.classList.contains('is-collapsed'), tg.getAttribute('aria-label')]);

// 4. 两侧面板的开关
function panel(dir, label) {
  const p = el('aside');
  p.setAttribute('data-zq-collapse', dir);
  p.setAttribute('data-zq-label', label);
  return p;
}
const left = panel('left', 'Notebook · 资料'), rightP = panel('right', '执行轨迹 · 产物');
r = load('/ai-assistant.html', { token }, {}, [left, rightP]);
const stripTags = (h) => String(h).replace(/<[^>]*>/g, '').trim();
for (const [p, dir, label] of [[left, 'left', 'Notebook · 资料'], [rightP, 'right', '执行轨迹 · 产物']]) {
  const cbtn = p.children.find((c) => c.className === 'zq-cbtn');
  const rail = p.children.find((c) => c.className === 'zq-rail');
  judge(dir + '：面板上装好了收起按钮和收起后的竖条', !!cbtn && !!rail, p.children.map((c) => c.className));
  if (!cbtn || !rail) continue;
  judge(dir + '：收起按钮是「收起面板」的图标', cbtn.innerHTML === r.ui.icon('panel-' + dir + '-close') && cbtn.innerHTML.includes('<svg'), cbtn.innerHTML.slice(0, 80));
  judge(dir + '：收起按钮有名字（只有图标，读屏靠它）', cbtn.title === '收起「' + label + '」' && cbtn.getAttribute('aria-label') === cbtn.title, [cbtn.title, cbtn.getAttribute('aria-label')]);
  const x = (rail.innerHTML.match(/<button[^>]*class="zq-xbtn"[^>]*>[\s\S]*?<\/button>/) || [''])[0];
  judge(dir + '：竖条上是「展开面板」的图标按钮', x.includes(r.ui.icon('panel-' + dir + '-open')), rail.innerHTML.slice(0, 120));
  judge(dir + '：竖条上的按钮只有图标、名字在提示和 aria-label 里', stripTags(x) === '' && x.includes('aria-label="展开「' + label + '」"') && x.includes('title="展开「' + label + '」"'), x.slice(0, 160));
  judge(dir + '：面板的名字还在（手机上收起的面板是页签，要显示字）', rail.innerHTML.includes('<div class="zq-rlabel">' + label + '</div>'), rail.innerHTML);
}

// 5. 悬停提示
r = load('/knowledge-wiki.html', { token });
const fire = (type, ev) => (r.docH[type] || []).forEach((f) => f(ev));
const runTimers = () => { const due = r.timers.filter((x) => x.live); due.forEach((x) => { x.live = false; x.f(); }); return due.map((x) => x.ms); };
const tipEl = () => r.body.children.find((c) => c.className === 'zq-tip');
const tipOn = () => !!tipEl() && tipEl().classList.contains('is-on');
function hoverable(attrs, opts = {}) {
  const t = el('button');
  Object.entries(attrs).forEach(([k, v]) => t.setAttribute(k, v));
  t.textContent = opts.text || '';
  t.innerText = opts.innerText !== undefined ? opts.innerText : (opts.text || '');
  t.rect = opts.rect || { left: 300, top: 100, right: 328, bottom: 128, width: 28, height: 28 };
  if (opts.strip) t.closest = (sel) => (sel.includes('.zq-rail') ? {} : null);
  return t;
}
let b = hoverable({ title: '展开「目录 · 4 页」' });
fire('pointerover', { pointerType: 'mouse', target: b });
judge('提示：停上去时原生的 title 让开（挪到 data-zq-tip），不然浏览器里出两个', b.getAttribute('title') === null && b.getAttribute('data-zq-tip') === '展开「目录 · 4 页」');
judge('提示：只有图标、没有名字的按钮顺手补上 aria-label', b.getAttribute('aria-label') === '展开「目录 · 4 页」');
let ms = runTimers();
judge('提示：停 0.4 秒才出（扫过去不闪）', ms.length === 1 && ms[0] === 400, ms);
judge('提示：出来了，字是那个名字、role=tooltip', tipOn() && tipEl().textContent === '展开「目录 · 4 页」' && tipEl().getAttribute('role') === 'tooltip', tipEl() && tipEl().textContent);
judge('提示：一般的出在它下面', tipEl() && tipEl().style.top === (128 + 6) + 'px', tipEl() && tipEl().style);
const inner = el('svg'); inner.parentNode = b;
b.contains = (x) => x === inner;
fire('pointerout', { target: b, relatedTarget: inner });
judge('提示：从按钮挪到里面的图标上不收', tipOn());
fire('pointerover', { pointerType: 'mouse', target: inner });
judge('提示：停到里面的图标上还是同一个，不重新计时', tipOn() && r.timers.filter((x) => x.live).length === 0);
fire('pointerout', { target: inner, relatedTarget: null });
judge('提示：移开就收', !tipOn());
const b2 = hoverable({ title: '收起「页面检查」' });
fire('pointerover', { pointerType: 'mouse', target: b2 });
ms = runTimers();
judge('提示：刚出过一个、接着停到旁边那个：立即出', ms[0] === 0 && tipOn() && tipEl().textContent === '收起「页面检查」', ms);
fire('pointerdown', {});
judge('提示：点下去就收', !tipOn());
const touch = hoverable({ title: '展开' });
fire('pointerover', { pointerType: 'touch', target: touch });
judge('提示：触屏不出（点一下会粘住）', r.timers.filter((x) => x.live).length === 0 && touch.getAttribute('title') === '展开');
b.setAttribute('title', '展开「目录 · 5 页」');
fire('pointerover', { pointerType: 'mouse', target: b }); runTimers();
judge('提示：代码之后又写了 title（页数变了）：下次停上去认新的', tipOn() && tipEl().textContent === '展开「目录 · 5 页」', tipEl() && tipEl().textContent);
fire('pointerout', { target: b, relatedTarget: null });
const rail = hoverable({ title: '展开「Notebook · 资料」' }, { strip: true, rect: { left: 10, top: 200, right: 38, bottom: 228, width: 28, height: 28 } });
fire('pointerover', { pointerType: 'mouse', target: rail }); runTimers();
judge('提示：收起的侧栏、面板竖条上的出在旁边（右边）', tipEl().style.left === (38 + 6) + 'px' && tipEl().style.top === (200 + (28 - 24) / 2) + 'px', tipEl().style);
fire('pointerout', { target: rail, relatedTarget: null });
const low = hoverable({ title: '上传文件' }, { rect: { left: 300, top: 870, right: 328, bottom: 898, width: 28, height: 28 } });
fire('pointerover', { pointerType: 'mouse', target: low }); runTimers();
judge('提示：下面放不下就出在上面', tipEl().style.top === (870 - 6 - 24) + 'px', tipEl().style);
fire('pointerout', { target: low, relatedTarget: null });
const nav = hoverable({ title: '看板' }, { text: '看板' });
fire('pointerover', { pointerType: 'mouse', target: nav }); runTimers();
judge('提示：字已经摆在上面了（展开的侧栏）不重复出', !tipOn());
judge('提示：有字的不补 aria-label', nav.getAttribute('aria-label') === null);
fire('pointerout', { target: nav, relatedTarget: null });
const clipped = hoverable({ title: '一个很长很长的 Notebook 名字' }, { text: '一个很长很长的 Notebook 名字' });
clipped.scrollWidth = 400; clipped.clientWidth = 120;
fire('pointerover', { pointerType: 'mouse', target: clipped }); runTimers();
judge('提示：字被截断（省略号）时照出', tipOn());
fire('pointerout', { target: clipped, relatedTarget: null });
const named = hoverable({ title: '发送（⌘/Ctrl + 回车）', 'aria-label': '发送' });
fire('pointerover', { pointerType: 'mouse', target: named });
judge('提示：已经有 aria-label 的不改', named.getAttribute('aria-label') === '发送');
fire('pointerout', { target: named, relatedTarget: null });
const keyed = hoverable({ title: '收起导航栏' });
keyed.matches = (sel) => sel === ':focus-visible';
fire('focusin', { target: keyed });
ms = runTimers();
judge('提示：键盘走到上面时也出（立即）', ms[0] === 0 && tipOn() && tipEl().textContent === '收起导航栏', ms);
fire('focusout', {});
judge('提示：焦点走了就收', !tipOn());

// 提示（第四十七轮 review 补的三条）
const nb = hoverable({ title: '官网改版' });
fire('pointerover', { pointerType: 'mouse', target: nb }); runTimers();
fire('pointerout', { target: nb, relatedTarget: null });
nb.setAttribute('title', '');   // 切回普通聊天：标题栏把 title 清空（ai-assistant.js 的 label.title = ''）
fire('pointerover', { pointerType: 'mouse', target: nb }); runTimers();
judge('提示：代码把 title 清空了就不再出（原来出的是上一个 Notebook 的名字）', !tipOn() && nb.getAttribute('data-zq-tip') === null, [tipOn(), nb.getAttribute('data-zq-tip')]);
fire('pointerout', { target: nb, relatedTarget: null });
const scrollH = (r.winH.scroll || []);
const sb = hoverable({ title: '上传文件' });
fire('pointerover', { pointerType: 'mouse', target: sb }); runTimers();
const chatBox = el('div'); chatBox.contains = (x) => false;
scrollH.forEach((f) => f({ target: chatBox }));
judge('提示：别处在滚（AI 回答流式输出、对话区往下跟）不收', tipOn());
const holder = el('div'); holder.contains = (x) => x === sb;
scrollH.forEach((f) => f({ target: holder }));
judge('提示：它所在的那一块滚了就收（提示会和它错开）', !tipOn());
fire('pointerover', { pointerType: 'mouse', target: hoverable({ title: '联网' }) }); runTimers();
scrollH.forEach((f) => f({ target: r.document }));
judge('提示：整页滚了就收', !tipOn());

// 从不取消滚动的公共提示监听必须显式 passive；不能让 WebKit 等待主线程再开始每次滚动。
const assert = require('node:assert/strict');
for (const path of ['/knowledge-wiki.html', '/ai-assistant.html', '/tasks.html']) {
  const shell = load(path);
  assert.equal(shell.docH.wheel.length, 1, path + ' must install one shared wheel listener');
  assert.equal(shell.docOptions.wheel[0].passive, true, path + ' shared tooltip wheel listener blocks asynchronous scrolling');
  assert.equal(shell.docOptions.wheel[0].capture, true, path + ' must still dismiss tips before nested scroll targets');
}
fire('pointerover', { pointerType: 'mouse', target: hoverable({ title: '滚动前的提示' }) }); runTimers();
assert.equal(tipOn(), true);
let wheelCancelled = false;
fire('wheel', { preventDefault() { wheelCancelled = true; } });
assert.equal(tipOn(), false, 'passive wheel must still dismiss the tooltip');
assert.equal(wheelCancelled, false, 'tooltip must never cancel scrolling');
judge('提示：Wiki、AI 助手、任务页的滚轮监听不阻塞滚动，仍会关闭提示', true);

// 6. 文件拖到没人接的地方
function dragEv(types, extra = {}) {
  return Object.assign({ prevented: false, defaultPrevented: false, dataTransfer: { types, dropEffect: 'copy' }, target: el('div'),
    preventDefault() { this.prevented = true; } }, extra);
}
let dv = dragEv(['Files']);
fire('dragover', dv);
judge('拖文件：没人接的地方不让放（拦下 dragover、光标显示不能放）', dv.prevented && dv.dataTransfer.dropEffect === 'none', [dv.prevented, dv.dataTransfer.dropEffect]);
let dp = dragEv(['Files']);
fire('drop', dp);
judge('拖文件：没人接的地方松手什么都不做（不让浏览器打开那个文件）', dp.prevented);
let taken = dragEv(['Files'], { defaultPrevented: true });
fire('dragover', taken);
judge('拖文件：接文件的地方（对话栏）已经接了 —— 不动它的 dropEffect', !taken.prevented && taken.dataTransfer.dropEffect === 'copy');
const fileInput = el('input'); fileInput.closest = (sel) => (sel.includes('input[type="file"]') ? fileInput : null);
let toInput = dragEv(['Files'], { target: fileInput });
fire('dragover', toInput);
judge('拖文件：原生的文件选择框（Wiki 导入）自己接，不拦', !toInput.prevented && toInput.dataTransfer.dropEffect === 'copy');
let words = dragEv(['text/plain']);
fire('dragover', words);
judge('拖的是一段字：不管', !words.prevented);

console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
