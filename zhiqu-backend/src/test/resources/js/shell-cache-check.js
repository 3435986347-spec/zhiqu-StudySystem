// 第一百二十轮：Service Worker（连同它的预取）等页面加载完、再过一会儿才注册 —— 跑发布的 maintainShellCache。
// 线上服务器只有 1.5 Mbps：原来一打开就注册，预取的几十个文件和页面自己的脚本抢同一根管子。
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
function slice(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a); if (a < 0 || b < 0) throw Error(start); return source.slice(a, b); }
// 第一百二十六轮起 maintainShellCache 先看桌面应用的桥（桌面里不注册）：把发布的 desktopBridge 一起带上，这里的 window 没有桥 = 浏览器
const code = slice('  var SHELL_CACHE_DELAY_MS', '  function token()') + slice('  function desktopBridge() {', '  /** 迷你番茄钟的桥');

function fixture(readyState) {
  const calls = [];
  const timers = [];
  const listeners = {};
  const env = {
    location: { protocol: 'https:' },
    navigator: { serviceWorker: { register(url) { calls.push(url); return Promise.resolve({ update: () => Promise.resolve() }); } } },
    document: { readyState },
    window: { addEventListener(name, fn, opts) { listeners[name] = { fn, opts }; } },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
  };
  const run = new Function(...Object.keys(env), `${code}\nreturn { maintainShellCache, SHELL_CACHE_DELAY_MS };`)(...Object.values(env));
  return { ...run, calls, timers, listeners };
}

let checks = 0;
function check(name, fn) { try { fn(); checks++; console.log('PASS ' + name); } catch (e) { console.error('FAIL ' + name + ': ' + e.message); process.exitCode = 1; } }

check('页面还在加载：不注册，等 load；load 之后也要等一会儿', () => {
  const f = fixture('loading');
  f.maintainShellCache();
  assert.deepEqual(f.calls, [], '一打开就注册了：预取会和页面抢带宽');
  assert.equal(f.timers.length, 0, 'load 之前就开始计时了');
  assert.ok(f.listeners.load, '没有等 load');
  assert.equal(f.listeners.load.opts && f.listeners.load.opts.once, true, 'load 的监听要只跑一次');
  f.listeners.load.fn();
  assert.deepEqual(f.calls, [], 'load 一到就注册了，没有再等一会儿');
  assert.equal(f.timers.length, 1);
  assert.ok(f.timers[0].ms >= 2000, `只等了 ${f.timers[0].ms}ms`);
  f.timers[0].fn();
  assert.deepEqual(f.calls, ['/service-worker.js']);
});

check('页面已经加载完（模块晚到的情形）：照样等一会儿再注册，只注册一次', () => {
  const f = fixture('complete');
  f.maintainShellCache();
  assert.deepEqual(f.calls, []);
  assert.equal(f.timers.length, 1, '已经加载完了也要计时');
  f.timers[0].fn();
  assert.deepEqual(f.calls, ['/service-worker.js']);
});

check('不是 http(s)（桌面应用的 file:、预览）：什么都不做', () => {
  const f = fixture('complete');
  const env = { location: { protocol: 'file:' } };
  const run = new Function('location', 'navigator', 'document', 'window', 'setTimeout', `${code}\nreturn maintainShellCache;`)(env.location, { serviceWorker: { register() { throw Error('不该注册'); } } }, { readyState: 'complete' }, { addEventListener() { throw Error('不该等'); } }, () => { throw Error('不该计时'); });
  run();
  assert.equal(f.calls.length, 0);
});

if (checks < 3) { console.error(`只跑了 ${checks} 条`); process.exitCode = 1; }
if (!process.exitCode) console.log('ALL-GREEN');
