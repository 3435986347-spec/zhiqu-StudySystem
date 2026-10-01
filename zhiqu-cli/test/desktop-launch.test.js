// 默认连本机桌面应用、它却没开（用户 2026-09-28 的记录里第一次敲 zhiqu 直接「连不上服务器」，还报了两遍）：
// macOS 上替用户把应用打开、等它起来；连的是别的服务器、或者不是 macOS，就照原样报错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureLocalServer } from '../src/desktop.js';
import { fakeUi } from './helpers.js';

const refused = () => Object.assign(new Error('连不上服务器（连接被拒绝）'), { code: 'ECONNREFUSED' });
function api(failures) {
  let n = failures;
  const calls = [];
  return { calls, async get(p, opts) { calls.push([p, opts]); if (n-- > 0) throw refused(); return { cliLatest: '0.1.0' }; } };
}
const instant = async () => {};

test('本机桌面应用没开（连接被拒）：打开它、等它起来，然后接着用', async () => {
  const ui = fakeUi([]);
  const a = api(3);
  let launched = 0;
  const r = await ensureLocalServer({ api: a, server: 'http://127.0.0.1:47615', ui, platform: 'darwin', launch: async () => { launched++; return true; }, wait: instant });
  assert.equal(r, 'ok');
  assert.equal(launched, 1);
  assert.match(ui.text(), /桌面应用没开，正在打开它/);
  assert.ok(a.calls.every(([, opts]) => opts && opts.retry === false), '探测不该带三次重试（原来光探测就要 1.3 秒）');
});

test('已经开着：一次探测就过，不打开、不说话', async () => {
  const ui = fakeUi([]);
  let launched = 0;
  const r = await ensureLocalServer({ api: api(0), server: 'http://127.0.0.1:47615', ui, platform: 'darwin', launch: async () => { launched++; return true; }, wait: instant });
  assert.equal(r, 'ok');
  assert.equal(launched, 0);
  assert.equal(ui.text(), '');
});

test('连的是别的服务器 / 不是 macOS：不替用户开任何东西，交给后面照常报错', async () => {
  for (const [server, platform] of [['https://zhiqu.example.com', 'darwin'], ['http://127.0.0.1:47615', 'linux'], ['http://127.0.0.1:18080', 'darwin']]) {
    let launched = 0;
    const r = await ensureLocalServer({ api: api(99), server, ui: fakeUi([]), platform, launch: async () => { launched++; return true; }, wait: instant });
    assert.equal(r, 'skip', `${server} ${platform}`);
    assert.equal(launched, 0);
  }
});

test('打开之后连上了、但服务器报的是别的错（比如 500）：不再干等，交给后面照常报', async () => {
  let n = 0;
  const a = { async get() { n += 1; if (n === 1) throw refused(); throw Object.assign(new Error('服务器暂时不可用（HTTP 500）'), { status: 500, code: null }); } };
  const r = await ensureLocalServer({ api: a, server: 'http://127.0.0.1:47615', ui: fakeUi([]), platform: 'darwin', launch: async () => true, wait: instant });
  assert.equal(r, 'skip');
  assert.equal(n, 2, '起来之后第一次探测就该停下');
});

test('没装应用 / 等不到它起来：说清楚怎么办，返回 failed（不再叠一句「连不上」）', async () => {
  const ui = fakeUi([]);
  const r = await ensureLocalServer({ api: api(99), server: 'http://127.0.0.1:47615', ui, platform: 'darwin', launch: async () => false, wait: instant });
  assert.equal(r, 'failed');
  assert.match(ui.text(), /没找到知趣象限应用/);
  const ui2 = fakeUi([]);
  const r2 = await ensureLocalServer({ api: api(99), server: 'http://127.0.0.1:47615', ui: ui2, platform: 'darwin', launch: async () => true, wait: instant, timeoutMs: 0 });
  assert.equal(r2, 'failed');
  assert.match(ui2.text(), /还没起来/);
});
