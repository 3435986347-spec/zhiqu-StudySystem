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
//   由 PageSwitchSmoothnessTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');

function el(tag) {
  const classes = new Set();
  const attrs = {};
  const node = {
    tagName: tag || 'div', style: {}, dataset: {}, innerHTML: '', textContent: '', className: '', children: [],
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
  const document = {
    readyState: 'complete', documentElement: html, body: el('body'),
    getElementById: (id) => (id === 'zq-side' ? side : null),
    querySelector: () => null, querySelectorAll: (sel) => (sel === '[data-zq-collapse]' && panels ? panels : []), addEventListener() {}, createElement: (t) => el(t),
  };
  const window = {
    location: { pathname, hash: '', search: '' }, document,
    localStorage: storage(local), sessionStorage: storage(session),
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {}, setTimeout: () => 0, clearTimeout() {},
  };
  window.window = window;
  const ctx = vm.createContext(Object.assign({ console }, window));
  vm.runInContext(src, ctx, { filename: 'zhiqu-ui.js' });
  return { html, side, ui: window.ZQUI, session: window.sessionStorage };
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

console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
