// 连的是本机桌面应用的地址、它却没在跑（用户 2026-09-28 的记录里第一次敲 zhiqu 直接「连不上服务器」，还报了两遍）。
// 第十二轮起 macOS 上替用户把应用打开、等它起来；第一百二十五轮起 Mac 版桌面应用打开的就是网站、不在本机跑后端 ——
// 再打开它只会白等 40 秒，改成直接说清楚、给出换到网站的命令。连的是别的服务器、或者不是 macOS，照原样报错。
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

test('本机 47615 连接被拒（新的 Mac 桌面应用不带后端）：不去打开应用、不干等，说清楚并给出换到网站的命令', async () => {
  const ui = fakeUi([]);
  const a = api(99);
  const started = Date.now();
  const r = await ensureLocalServer({ api: a, server: 'http://127.0.0.1:47615', ui, platform: 'darwin', website: 'https://zhiqustudy.com' });
  assert.equal(r, 'failed');
  assert.equal(a.calls.length, 1, '探测一次就够：没人会在 47615 上起来');
  assert.ok(a.calls.every(([, opts]) => opts && opts.retry === false), '探测不该带三次重试（原来光探测就要 1.3 秒）');
  assert.ok(Date.now() - started < 1000, '不该再等桌面应用起来');
  assert.match(ui.text(), /打开的就是网站/);
  assert.match(ui.text(), /zhiqu login --server https:\/\/zhiqustudy\.com/);
});

test('默认服务器还是本机（仓库里没改过）：不叫人「换到」同一个本机地址', async () => {
  const ui = fakeUi([]);
  const r = await ensureLocalServer({ api: api(99), server: 'http://127.0.0.1:47615', ui, platform: 'darwin', website: 'http://127.0.0.1:47615' });
  assert.equal(r, 'failed');
  assert.doesNotMatch(ui.text(), /zhiqu login --server/);
});

test('47615 上有人（旧版桌面应用还开着）：一次探测就过，不说话', async () => {
  const ui = fakeUi([]);
  const r = await ensureLocalServer({ api: api(0), server: 'http://127.0.0.1:47615', ui, platform: 'darwin', website: 'https://zhiqustudy.com' });
  assert.equal(r, 'ok');
  assert.equal(ui.text(), '');
});

test('连的是别的服务器 / 不是 macOS / 不是连接被拒：交给后面照常报错', async () => {
  for (const [server, platform] of [['https://zhiqu.example.com', 'darwin'], ['http://127.0.0.1:47615', 'win32'], ['http://127.0.0.1:18080', 'darwin']]) {
    const a = api(99);
    const r = await ensureLocalServer({ api: a, server, ui: fakeUi([]), platform, website: 'https://zhiqustudy.com' });
    assert.equal(r, 'skip', `${server} ${platform}`);
    assert.equal(a.calls.length, 0, `${server} ${platform} 不该探测`);
  }
  const other = { async get() { throw Object.assign(new Error('服务器暂时不可用（HTTP 500）'), { status: 500, code: null }); } };
  assert.equal(await ensureLocalServer({ api: other, server: 'http://127.0.0.1:47615', ui: fakeUi([]), platform: 'darwin' }), 'skip');
});

test('换到网站的说法照地址从哪来的说：环境变量、项目设置、命令行参数各说各的（login 只写用户配置，照着做下一次还是老地址）', async () => {
  const { resolveSettings } = await import('../src/config.js');
  const { tmpdir, write } = await import('./helpers.js');
  const home = tmpdir();
  const root = tmpdir();
  const saved = { home: process.env.ZHIQU_HOME, server: process.env.ZHIQU_SERVER };
  process.env.ZHIQU_HOME = home;
  delete process.env.ZHIQU_SERVER;
  const hint = async (source) => {
    const ui = fakeUi([]);
    await ensureLocalServer({ api: api(99), server: 'http://127.0.0.1:47615', ui, platform: 'darwin', website: 'https://zhiqustudy.com', source });
    return ui.text();
  };
  try {
    write(home, 'config.json', JSON.stringify({ server: 'http://127.0.0.1:47615' }));
    assert.equal(resolveSettings(root).serverSource, 'user');
    assert.match(await hint(resolveSettings(root).serverSource), /zhiqu login --server https:\/\/zhiqustudy\.com/);

    write(root, '.zhiqu/settings.json', JSON.stringify({ server: 'http://127.0.0.1:47615' }));
    assert.equal(resolveSettings(root).serverSource, 'project');
    const project = await hint(resolveSettings(root).serverSource);
    assert.match(project, /\.zhiqu\/settings\.json/);
    assert.doesNotMatch(project, /zhiqu login --server/, '地址从项目设置来，叫人 login 也换不过去');

    process.env.ZHIQU_SERVER = 'http://127.0.0.1:47615';
    assert.equal(resolveSettings(root).serverSource, 'env');
    const env = await hint(resolveSettings(root).serverSource);
    assert.match(env, /ZHIQU_SERVER/);
    assert.doesNotMatch(env, /zhiqu login --server/);

    assert.equal(resolveSettings(root, { server: 'http://127.0.0.1:47615' }).serverSource, 'flag');
    assert.match(await hint('flag'), /--server https:\/\/zhiqustudy\.com/);
  } finally {
    if (saved.home == null) delete process.env.ZHIQU_HOME; else process.env.ZHIQU_HOME = saved.home;
    if (saved.server == null) delete process.env.ZHIQU_SERVER; else process.env.ZHIQU_SERVER = saved.server;
  }
});
