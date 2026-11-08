// 页面在桌面应用里不装 Service Worker、在浏览器里照常装（第一百二十六轮）—— 直接跑 assets/zhiqu-api.js 里发布的 maintainShellCache。
// 桌面里装上的话：服务器停了 / 断网时它拿缓存的页面顶上，WebKit 当成载入成功，外壳就不说「连不上」（用户在真窗口里照出来的）。
//   用法：node src/test/resources/js/shell-cache-desktop-check.js <zhiqu-api.js 的路径>；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

function cut(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a + startMarker.length);
  if (a < 0 || b < 0) throw new Error('抠不到：' + startMarker);
  return src.slice(a, b);
}
// 两段都是发布的原文：它前面那个延时常量 + maintainShellCache（到后面的 token() 为止）；desktopBridge 一整个函数
const maintain = cut('  var SHELL_CACHE_DELAY_MS', '  function token() {');
const bridge = cut('  function desktopBridge() {', '  /** 迷你番茄钟的桥');

function page({ desktop, readyState = 'complete' }) {
  const registered = [];
  const timers = [];
  const listeners = {};
  const window = {
    webkit: desktop ? { messageHandlers: { zqNotify: { postMessage() {} } } } : undefined,
    addEventListener: (name, fn) => { listeners[name] = fn; },
  };
  const navigator = {
    serviceWorker: { register: (url) => { registered.push(url); return Promise.resolve({ update: () => Promise.resolve() }); } },
  };
  const location = { protocol: 'https:' };
  const document = { readyState };
  const setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const run = new Function('window', 'navigator', 'location', 'document', 'setTimeout',
    bridge + maintain + '\nmaintainShellCache();');
  run(window, navigator, location, document, setTimeout);
  // 页面加载完再过一会儿才注册（第一百二十轮）：把排着的都跑掉
  if (listeners.load) listeners.load();
  for (let i = 0; i < timers.length; i++) timers[i].fn();
  return registered;
}

let fail = 0;
function judge(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + '  →  ' + g + '（应为 ' + w + '）'); fail++; }
}

// 对照：浏览器里照常注册（不然「桌面里没注册」可能只是什么都没跑）
judge('浏览器里：照常注册 Service Worker', page({ desktop: false }), ['/service-worker.js']);
judge('浏览器里、页面还在加载：等加载完照样注册', page({ desktop: false, readyState: 'loading' }), ['/service-worker.js']);
judge('桌面应用里（有外壳的桥）：不注册', page({ desktop: true }), []);
judge('桌面应用里、页面还在加载：也不注册', page({ desktop: true, readyState: 'loading' }), []);

if (fail) { console.log(fail + ' 条红'); process.exit(1); }
console.log('ALL-GREEN');
