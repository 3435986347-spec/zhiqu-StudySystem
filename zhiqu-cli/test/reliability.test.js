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

test('没登录的 POST（设备码登录，服务器不认幂等键）连接中途被掐断不重试（服务器可能已经处理了）；连接被拒才重试', { timeout: 20_000 }, async () => {
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

/**
 * 认幂等键的假服务器（照 IdempotentWriteAspect 的样子）：同一个键只做一次、再来交回上次的结果。
 * script 依次决定每一下请求的命运：'ok' 正常回；'lost' 做完了、回应断在半路；'502' 做完了、代理回 502；
 * 'busy' 回「上一次还在处理」（409，不做）；'refused' 不在这里模拟（用关着的端口）。
 */
async function idempotentServer(script) {
  const done = new Map();   // 键 → 结果
  const seen = [];          // 每一下请求带的键
  let n = 0, executed = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const key = req.headers['idempotency-key'] || null;
      seen.push(key);
      const fate = script[Math.min(n++, script.length - 1)];
      if (fate === 'busy') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 409, message: '上一次提交还在处理，请稍后再试' })); return; }
      if (!key || !done.has(key)) { executed++; const r = { id: executed, body: JSON.parse(body || '{}') }; if (key) done.set(key, r); }
      const data = key ? done.get(key) : { id: executed };
      if (fate === 'lost') { req.socket.destroy(); return; }
      if (fate === '502') { res.writeHead(502); res.end('<html>bad gateway</html>'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 200, data }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, seen, get executed() { return executed; },
    setScript(next) { script = next; n = 0; seen.length = 0; },
    close() { server.closeAllConnections(); server.close(); },
  };
}

test('登录后的 POST 带幂等键：回应断在半路 / 502 / 「还在处理」都用同一个键重来，服务器只做了一次（第二十二轮）', { timeout: 20_000 }, async () => {
  const s = await idempotentServer(['lost', '502', 'ok']);
  try {
    const api = new Api({ server: s.url, token: 't' });
    const r = await api.post('/api/harness/tools/call', { name: 'create_study_plan', arguments: { title: 'A' } });
    assert.equal(s.seen.length, 3, '应当重来两次');
    assert.ok(s.seen[0] && s.seen.every((k) => k === s.seen[0]), `每一下都该带同一个键：${s.seen}`);
    assert.equal(s.executed, 1, '服务器只该做一次');
    assert.equal(r.id, 1);
    s.setScript(['busy', 'ok']);
    await api.post('/api/harness/tools/call', { name: 'create_study_plan', arguments: { title: 'B' } });
    assert.equal(s.seen.length, 2, '「上一次还在处理」（409）等一下再来');
  } finally { s.close(); }
});

test('重来也没回应：照实说「不确定有没有做成」；模型照原样再调（内容完全一样）沿用那个键 —— 草稿不会多一份', { timeout: 20_000 }, async () => {
  const s = await idempotentServer(['lost']);
  try {
    const api = new Api({ server: s.url, token: 't' });
    const call = { sessionId: 's', name: 'create_study_plan', arguments: { title: '线代' } };
    await assert.rejects(api.post('/api/harness/tools/call', call), (e) => {
      assert.equal(e.uncertain, true);
      assert.match(e.message, /不确定这一下有没有做成；内容不变再来一次不会重复/);
      return true;
    });
    const lostKey = s.seen[0];
    assert.equal(s.executed, 1);
    s.setScript(['ok']);
    const again = await api.post('/api/harness/tools/call', call);
    assert.equal(s.seen[0], lostKey, '内容一样的下一次该沿用没弄清的那个键');
    assert.equal(again.id, 1, '交回的是上一次做的那一份');
    assert.equal(s.executed, 1, '服务器还是只做了一次');
    s.setScript(['ok']);
    await api.post('/api/harness/tools/call', call);
    assert.notEqual(s.seen[0], lostKey, '那一次弄清了之后，再来是新的一次');
    s.setScript(['ok']);
    await api.post('/api/harness/tools/call', { ...call, arguments: { title: '高数' } });
    assert.equal(s.executed, 3, '内容不同的是另一件事');
  } finally { s.close(); }
  const refused = new Api({ server: 'http://127.0.0.1:1', token: 't' });
  await assert.rejects(refused.post('/x', {}), (e) => {
    assert.equal(e.uncertain, false, '连接被拒 = 请求没到服务器，确定没做，不说「不确定」');
    assert.match(e.message, /连接被拒绝/);
    return true;
  });
});

test('没弄清的键按单调时钟算 10 分钟：系统时钟往前跳一小时（校时、休眠醒来）不会让它提前作废、再做一份（第二十一轮的规矩）', { timeout: 20_000 }, async () => {
  const s = await idempotentServer(['lost']);
  const real = Date.now;
  try {
    const api = new Api({ server: s.url, token: 't' });
    const call = { sessionId: 's', name: 'create_study_plan', arguments: { title: '钟跳了' } };
    await assert.rejects(api.post('/api/harness/tools/call', call), (e) => e.uncertain === true);
    const lostKey = s.seen[0];
    s.setScript(['ok']);
    Date.now = () => real() + 3600 * 1000;
    await api.post('/api/harness/tools/call', call);
    assert.equal(s.seen[0], lostKey, '系统时钟一跳，没弄清的那个键就被当成过期了 —— 服务器还记得它，换了新键就是再做一份');
    assert.equal(s.executed, 1);
  } finally {
    Date.now = real;
    s.close();
  }
});

test('模型的流好好结束了却没有 done（服务器收尾时关了流）：安静模式下已经收到的那段也要打出来', { timeout: 20_000 }, async () => {
  const s = await startFakeHarness({ model: [{ endAfterText: '说到一半' }] });
  try {
    const ctx = ctxFor(new Api({ server: s.url }));
    await assert.rejects(runTurn(ctx, '你好'), /没有正常结束/);
    assert.match(ctx.ui.text(), /断开前已经收到的[\s\S]*说到一半/, '流没有 done 就结束时，收到的那一段就这么没了');
  } finally { await s.close(); }
});

test('存档：回应丢了（服务器其实收到了），下一轮补发内容不变、沿用同一个键 —— 网页上不会多出一份', { timeout: 20_000 }, async () => {
  const s = await idempotentServer(['lost']);
  try {
    const ctx = ctxFor(new Api({ server: s.url, token: 't' }));
    await archiveTurn(ctx, '第一句', { steps: [], finalText: '一' });
    assert.equal(ctx.archivePending.length, 1, '没拿到回应，留在队列里');
    const firstKey = s.seen[0];
    s.setScript(['ok']);
    await archiveTurn(ctx, '第二句', { steps: [], finalText: '二' });
    await flushArchive(ctx);
    assert.equal(ctx.archivePending.length, 0);
    assert.ok(firstKey, '存档要带键');
    assert.equal(s.seen[0], firstKey, '补发那一条沿用的是没弄清的那个键');
    assert.equal(s.executed, 2, '两条存档，各一份');
  } finally { s.close(); }
});

test('服务器卡住（接了连接、一个字节都不回）：等满超时只再等一次、重来前说一声，最后说「N 秒没有回应」而不是 ETIMEDOUT（第二十二轮：原来一声不吭 91 秒）', { timeout: 20_000 }, async () => {
  let hits = 0;
  const server = http.createServer(() => { hits++; });   // 不回
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const notes = [];
  try {
    const api = new Api({ server: `http://127.0.0.1:${server.address().port}`, token: 't', onRetry: (why) => notes.push(why) });
    const t = Date.now();
    await assert.rejects(api.get('/api/harness/me', { timeoutMs: 1000 }), (e) => {
      assert.match(e.message, /服务器 1 秒没有回应/);
      assert.doesNotMatch(e.message, /ETIMEDOUT/);
      return true;
    });
    assert.equal(hits, 2, '卡住的服务器只再等一次');
    assert.ok(Date.now() - t < 4000);
    assert.equal(notes.length, 1, '重来之前要说一声');
    assert.match(notes[0], /1 秒没有回应/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('「再试一次」：同时卡住的几个请求只说一遍；过一会儿同一个原因又卡住，照样要说', async () => {
  const { retryNoter } = await import('../src/cli.js');
  let now = 0;
  const said = [];
  const note = retryNoter((t) => said.push(t), () => now);
  note('服务器 15 秒没有回应');
  note('服务器 15 秒没有回应');
  note('服务器 15 秒没有回应');
  assert.equal(said.length, 1, '同一刻一起卡住的只说一遍');
  now += 60_000;
  note('服务器 15 秒没有回应');
  assert.equal(said.length, 2, '一分钟之后同一个原因又卡住：不说的话终端又是一片空白');
  note('连接被拒绝');
  assert.equal(said.length, 3, '换了原因要说');
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

test('模型调用：已经输出了一半才断线 —— 不重试（重来会让用户看到重复内容、工具调用也可能重复），把原因报出来、已经收到的那段打出来', { timeout: 20_000 }, async () => {
  const s = await startFakeHarness({ model: [{ dropAfterText: '我先写一半' }, { text: '不该走到这里' }] });
  try {
    const ctx = ctxFor(new Api({ server: s.url }));
    await assert.rejects(runTurn(ctx, '你好'), (e) => {
      // 断的是和我们服务器的连接（服务器重启、网络断了），不是模型 —— 第二十二轮
      assert.match(e.message, /中途断开了：和服务器 http:\/\/127\.0\.0\.1:\d+ 的连接断了/);
      return true;
    });
    assert.equal(s.requests.filter((q) => q.route.endsWith('/model/stream')).length, 1);
    assert.match(ctx.ui.text(), /断开前已经收到的[\s\S]*我先写一半/, '安静模式下断开前收到的那一段要打出来，不能就这么没了');
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
