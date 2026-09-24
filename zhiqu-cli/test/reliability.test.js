// 可靠性与速度：不加载 TLS、重试只在安全的时候发生、流式的空闲超时、存档失败下次补。
// 用 test/fixtures/fake-harness.js 在本进程起一个假服务器，故障都是脚本化的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api, ApiError } from '../src/api.js';
import { archiveTurn, flushArchive, runTurn } from '../src/agent.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { startFakeHarness } from './fixtures/fake-harness.js';
import { fakeUi, tmpdir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('速度：加载 zhiqu 的全部模块不许顺带加载 TLS（NODE_USE_SYSTEM_CA=1 时它要 1 秒多）', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(path.join(here, '..', 'src', 'cli.js'))}); console.log(process.moduleLoadList.filter((m) => /NativeModule (tls|https)$/.test(m)).join(','))`],
  { encoding: 'utf8' });
  assert.equal(out.trim(), '', `加载了：${out}`);
});

test('GET 遇到 503 重试，第三次成功就当没事发生；业务错误（code != 200）不重试', { timeout: 20_000 }, async () => {
  let n = 0;
  const server = http.createServer((req, res) => {
    n++;
    if (req.url === '/api/harness/me' && n <= 2) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/harness/me' ? { code: 200, data: { ok: true } } : { code: 500, message: '模型没配' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = new Api({ server: `http://127.0.0.1:${server.address().port}` });
  try {
    assert.deepEqual(await api.get('/api/harness/me'), { ok: true });
    assert.equal(n, 3);
    n = 100;
    await assert.rejects(api.get('/api/harness/models'), /模型没配/);
    assert.equal(n, 101, '业务错误不该重试');
  } finally { server.close(); }
});

test('POST 连接中途被掐断不重试（服务器可能已经处理了 —— 比如草稿已经建了）；连接被拒才重试', { timeout: 20_000 }, async () => {
  let hits = 0;
  const server = http.createServer((req) => { hits++; req.socket.destroy(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const api = new Api({ server: `http://127.0.0.1:${server.address().port}` });
    await assert.rejects(api.post('/api/harness/tools/call', { name: 'create_study_plan' }), ApiError);
    assert.equal(hits, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
  const refused = new Api({ server: 'http://127.0.0.1:1' });
  const t = Date.now();
  await assert.rejects(refused.post('/x', {}), /连接被拒绝/);
  assert.ok(Date.now() - t >= 250, '连接被拒的 POST 应当等一下再试一次');
});

function ctxFor(api, root = tmpdir()) {
  const store = new SessionStore(root);
  return {
    ui: fakeUi(), api, root, mode: 'auto', maxRounds: 5, local: new LocalTools({ root }), store, session: store.create(),
    messages: [], allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: 'm', effectiveContextWindow: 64000 },
  };
}

test('模型调用：还没有任何输出时断了（闪断 / 502）就重试；说出来；最后成功', { timeout: 20_000 }, async () => {
  const s = await startFakeHarness({ model: [{ drop: true }, { status: 502 }, { text: '好了' }] });
  try {
    const ctx = ctxFor(new Api({ server: s.url }));
    const r = await runTurn(ctx, '你好');
    assert.equal(r.finalText, '好了');
    assert.equal(s.requests.filter((q) => q.route.endsWith('/model/stream')).length, 3);
    assert.match(ctx.ui.text(), /后重试（第 2 次）/);
  } finally { await s.close(); }
});

test('模型调用：已经输出了一半才断线 —— 不重试（重来会让用户看到重复内容、工具调用也可能重复），把原因报出来', { timeout: 20_000 }, async () => {
  const s = await startFakeHarness({ model: [{ dropAfterText: '我先写一半' }, { text: '不该走到这里' }] });
  try {
    const ctx = ctxFor(new Api({ server: s.url }));
    await assert.rejects(runTurn(ctx, '你好'), /中途断开/);
    assert.equal(s.requests.filter((q) => q.route.endsWith('/model/stream')).length, 1);
  } finally { await s.close(); }
});

test('模型调用：重试有上限（最多三次），全失败就把原因报出来', { timeout: 20_000 }, async () => {
  const s = await startFakeHarness({ model: [{ status: 503 }] });
  try {
    const ctx = ctxFor(new Api({ server: s.url }));
    await assert.rejects(runTurn(ctx, '你好'), /暂时不可用/);
    assert.equal(s.requests.filter((q) => q.route.endsWith('/model/stream')).length, 3);
  } finally { await s.close(); }
});

test('流式空闲超时：连接还在但一直没数据，按时断开并说明；有心跳就不算空闲', { timeout: 20_000 }, async () => {
  const s = await startFakeHarness({ model: [{ hang: true }, { thinkMs: 400, heartbeat: true, text: '想好了' }] });
  try {
    const api = new Api({ server: s.url });
    const t = Date.now();
    await assert.rejects(api.stream('/api/harness/model/stream', {}, () => {}, { idleTimeoutMs: 300 }), (e) => {
      assert.match(e.message, /没有收到任何数据/);
      assert.equal(e.retryable, true);
      return true;
    });
    assert.ok(Date.now() - t < 3000);
    const got = [];
    await api.stream('/api/harness/model/stream', {}, (name) => got.push(name), { idleTimeoutMs: 200 });
    assert.ok(got.includes('done'), '服务器一直在发心跳，空闲超时不该触发');
  } finally { await s.close(); }
});

test('存档：发不出去不挡这一轮；下一轮连同新的一起补，顺序不乱', async () => {
  let fail = true;
  const got = [];
  const api = {
    async post(pathname, body) {
      if (fail) throw new ApiError('服务器暂时不可用', { retryable: true });
      got.push(body.messages[0].content);
      return {};
    },
  };
  const ctx = ctxFor(api);
  await archiveTurn(ctx, '第一句', { steps: [], finalText: '一' });
  assert.equal(ctx.archivePending.length, 1);
  assert.match(ctx.ui.text(), /下一轮会补上/);
  fail = false;
  await archiveTurn(ctx, '第二句', { steps: [], finalText: '二' });
  await flushArchive(ctx);
  assert.deepEqual(got, ['第一句', '第二句']);
  assert.equal(ctx.archivePending.length, 0);
});

test('同一个工作区两个进程同时建会话：索引一条都不丢', { timeout: 20_000 }, async () => {
  const root = tmpdir();
  const script = `import { SessionStore } from ${JSON.stringify(path.join(here, '..', 'src', 'session.js'))};
    const s = new SessionStore(${JSON.stringify(root)}); for (let i = 0; i < 40; i++) { const m = s.create({ title: 'x' + i }); s.touch(m.id, { messages: i }); }`;
  const { spawn } = await import('node:child_process');
  await Promise.all([0, 1, 2].map(() => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`退出码 ${code}`))));
  })));
  const store = new SessionStore(root);
  assert.equal(store.list().length, 120, '并发写索引丢了会话');
  const fs = await import('node:fs');
  assert.ok(!fs.existsSync(path.join(root, '.zhiqu', 'setup.json.lock')), '锁要放掉');
});

test('锁文件是崩溃留下的（超过 10 秒没动）：清掉再拿，不卡住', async () => {
  const fs = await import('node:fs');
  const root = tmpdir();
  const store = new SessionStore(root);
  store.ensure();
  const lock = path.join(root, '.zhiqu', 'setup.json.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const t = Date.now();
  store.create({ title: 'after crash' });
  assert.ok(Date.now() - t < 1000);
  assert.equal(store.list().length, 1);
});

test('Windows：npm.cmd 改成 node 直接跑 npm-cli.js（不经过 shell）；别的 .cmd 明确拒绝', async () => {
  const { planLaunch } = await import('../src/tools/exec.js');
  const npm = planLaunch({ command: 'npm', binary: 'C:\\nodejs\\npm.cmd', args: ['test'], platform: 'win32',
    exists: (f) => f === 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', nodePath: 'C:\\nodejs\\node.exe' });
  assert.deepEqual(npm, { binary: 'C:\\nodejs\\node.exe', args: ['C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'test'] });
  assert.match(planLaunch({ command: 'mvn', binary: 'C:\\m\\mvn.cmd', args: [], platform: 'win32', exists: () => false }).error, /交给 shell 解析/);
  assert.deepEqual(planLaunch({ command: 'node', binary: '/usr/bin/node', args: ['a.js'], platform: 'darwin' }), { binary: '/usr/bin/node', args: ['a.js'] });
});
