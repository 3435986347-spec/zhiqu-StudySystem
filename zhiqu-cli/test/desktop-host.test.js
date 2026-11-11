// 桌面版本机代码助手（第一百二十九轮，docs/desktop-remote-plan.md 第 2 步）：Mac 桌面外壳起 code-host.js，run 里带 local: { server, token }。
// 宿主直接连服务器网关（假的，在这里起）、命令在真的系统沙箱里跑（没有沙箱的机器上那几条明说跳过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createBridge, desktopTarget, runHosted } from '../src/host/code-host.js';
import { detectSandbox } from '../src/tools/sandbox.js';
import { tmpdir, write } from './helpers.js';

const TOKEN = 'zqp_desktopTestToken_0123456789abcdefXYZ';
const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host', 'code-host.js');
const box = detectSandbox();
const noBox = box ? false : '这台机器没有可用的系统沙箱（macOS Seatbelt / Linux bubblewrap），本机代码助手的命令判据跑不了';

/**
 * 假的服务器网关：replies 依次是模型的回答（{ text } / { calls } / { hang }）。记下每个请求的方法、路径、Authorization 头、正文。
 * 令牌不对回 401（和真的一样：过滤器不认 → 没登录）。/ping 给沙箱联网的判据用。
 */
async function gateway(t, replies, { tools = [] } = {}) {
  const seen = [];
  const streams = [];
  const hanging = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body: raw });
      if (req.url === '/ping') { res.end('pong-from-gateway'); return; }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 401, message: '未登录' })); return; }
      const json = (v) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: v })); };
      if (req.url.startsWith('/api/harness/models')) return json({ models: [{ id: 3, label: 'a', modelName: 'a', toolCalling: true, effectiveContextWindow: 100000 }, { id: 7, label: 'b', modelName: 'b', toolCalling: true, effectiveContextWindow: 100000 }], defaultModelId: 3 });
      if (req.url.startsWith('/api/harness/tools/call')) return json({ content: '远程工具的结果' });
      if (req.url.startsWith('/api/harness/tools')) return json(tools);
      if (req.url.startsWith('/api/harness/model/stream')) {
        const body = JSON.parse(raw);
        streams.push(body);
        const r = replies[Math.min(streams.length - 1, replies.length - 1)];
        res.setHeader('Content-Type', 'text/event-stream');
        const send = (name, data) => res.write(`event:${name}\ndata:${JSON.stringify(data)}\n\n`);
        if (r.hang) { hanging.push(res); for (const w of gateway.waiters.splice(0)) w(); return undefined; }
        send('start', { contextWindow: 100000, droppedMessages: 0, elidedToolOutputs: 0 });
        const calls = (r.calls || []).map((c, i) => ({ id: `c${streams.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
        const message = { role: 'assistant', content: r.text || '' };
        if (calls.length) message.tool_calls = calls;
        send('done', { message, finishReason: calls.length ? 'tool_calls' : 'stop', maxTokens: 16000, usage: { promptTokens: 100, completionTokens: 7, cachedTokens: 0, estimated: false } });
        return res.end();
      }
      return json({});
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, streams, hanging };
}
gateway.waiters = [];
const hung = () => new Promise((resolve) => gateway.waiters.push(resolve));

/** 外壳那一头：宿主写出来的每一行都收着 */
function shellSide() {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buf = '';
  output.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  const bridge = createBridge({ input, output });
  return { bridge, input, lines };
}

function desktopRun(url, extra = {}) {
  return { type: 'run', root: extra.root || tmpdir(), home: extra.home || tmpdir(), message: extra.message || '看一下', history: [], canWrite: false, canShell: false,
    shellWrite: false, sandboxNetwork: 'on', maxRounds: 8, timeoutMs: 60_000, model: { id: 7 }, effort: 'instant', local: { server: url, token: TOKEN }, ...extra };
}

/** 跑一轮，连最后那行 result 一起拿回来（和 main() 一样经 bridge.line 写） */
async function runDesktop(run) {
  const side = shellSide();
  const result = await runHosted(side.bridge, run);
  side.lines.push(side.bridge.line(result));
  return { result, lines: side.lines, side };
}

const toolNames = (body) => (body.tools || []).map((t) => t.function.name);

test('本机模式：模型和远程工具直接走给的服务器，令牌只在 Authorization 头里；发给外壳的每一行都不带令牌、也不要 model / exec / tool', async (t) => {
  const g = await gateway(t, [{ calls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: '看过了：a.txt 里是 hello' }]);
  const root = tmpdir();
  write(root, 'a.txt', 'hello\n');
  const { result, lines } = await runDesktop(desktopRun(g.url, { root }));
  assert.equal(result.error, null, result.error);
  assert.equal(result.conclusion, '看过了：a.txt 里是 hello');
  assert.ok(g.seen.length >= 3, `请求太少：${g.seen.map((s) => s.url).join(', ')}`);
  for (const s of g.seen) {
    assert.equal(s.auth, `Bearer ${TOKEN}`, `${s.method} ${s.url} 没带令牌`);
    assert.ok(!s.body.includes(TOKEN), `${s.url} 的正文里带了令牌`);
  }
  assert.ok(g.seen.some((s) => s.url.startsWith('/api/harness/models')), '没问服务器要模型列表');
  assert.equal(g.streams[0].modelId, 7, '没用页面选的那个模型');
  for (const l of lines) {
    assert.ok(!l.includes(TOKEN), `发给外壳的一行带了令牌：${l.slice(0, 200)}`);
    assert.ok(!['model', 'exec', 'tool'].includes(JSON.parse(l).type), `本机模式不该往外壳要 ${JSON.parse(l).type}`);
  }
  assert.ok(lines.some((l) => JSON.parse(l).type === 'trace'), '一步都没交给外壳（网页的步骤列表要用）');
});

test('本机模式：调工具前的那一句马上成一条 note，排在工具前面；结论不拿它', async (t) => {
  const g = await gateway(t, [
    { text: '先看 a.txt 里有什么', calls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    { text: '看过了' },
  ]);
  const root = tmpdir();
  write(root, 'a.txt', 'hello\n');
  const { result, lines } = await runDesktop(desktopRun(g.url, { root }));
  const steps = lines.map((l) => JSON.parse(l)).filter((m) => m.type === 'trace').map((m) => m.step);
  const noteAt = steps.findIndex((s) => s.kind === 'note' && s.status === 'ok');
  const readAt = steps.findIndex((s) => s.kind === 'read' && s.status === 'running');
  assert.ok(noteAt >= 0 && readAt > noteAt, `判断没排在读取前面：${steps.map((s) => s.kind + ':' + s.status).join(' ')}`);
  assert.equal(steps[noteAt].title, '先看 a.txt 里有什么');
  assert.equal(steps[noteAt].detail, undefined);
  assert.equal(result.conclusion, '看过了');
  assert.ok(!result.conclusion.includes('先看'));
});

test('本机模式：没给对服务器 / 令牌 / 家目录就不跑，一个请求都不发', async (t) => {
  const g = await gateway(t, [{ text: '不该到这里' }]);
  for (const [run, words] of [
    [desktopRun(g.url, { local: { server: g.url, token: '' } }), '令牌'],
    [desktopRun(g.url, { local: { server: g.url, token: 'eyJhbGciOiJIUzI1NiJ9.x.y' } }), '令牌'],
    [desktopRun(g.url, { local: { server: 'file:///etc/passwd', token: TOKEN } }), '服务器'],
    [desktopRun(g.url, { home: 'relative/home' }), '家目录'],
  ]) {
    const { result, lines } = await runDesktop(run);
    assert.ok(String(result.error).includes(words), `应该说缺${words}：${result.error}`);
    for (const l of lines) assert.ok(!l.includes(TOKEN), l);
  }
  assert.equal(g.seen.length, 0, `没过门却发了请求：${g.seen.map((s) => s.url).join(', ')}`);
  assert.equal(desktopTarget({ root: '/x' }), null, '不是桌面版（后端起的那一份）照旧');
});

test('本机模式：服务器回的错误里带着令牌，交给外壳的那一行里也换成 zqp_…', async (t) => {
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 500, message: `坏令牌 ${String(req.headers.authorization).replace('Bearer ', '')} 不认` }));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const { result, lines } = await runDesktop(desktopRun(`http://127.0.0.1:${srv.address().port}`));
  assert.ok(result.error, '对照组：服务器报错了，这一轮应该带着错误收尾');
  for (const l of lines) assert.ok(!l.includes(TOKEN), `令牌跟着服务器的错误漏给了外壳：${l.slice(0, 300)}`);
  assert.ok(lines.some((l) => l.includes('zqp_…')), '错误里的令牌没换成 zqp_…');
});

test('本机模式：令牌失效时照实说（不是命令行那句「请运行 zhiqu login」）', async (t) => {
  const g = await gateway(t, [{ text: 'x' }]);
  const { result } = await runDesktop(desktopRun(g.url, { local: { server: g.url, token: 'zqp_expiredOrRevoked_0123456789' } }));
  assert.match(String(result.error), /令牌失效/);
  assert.ok(!String(result.error).includes('zhiqu login'), result.error);
  assert.match(result.conclusion, /令牌失效/);
});

test('本机模式：写文件只成草稿，磁盘上的不变；没给写就不下发写的工具；只读档的远程工具只留读的', async (t) => {
  const g = await gateway(t, [{ calls: [{ name: 'write_file', args: { path: 'new.txt', content: '新内容\n' } }] }, { text: '改动已生成草稿，确认后生效' }],
    { tools: [{ type: 'function', function: { name: 'search_wiki', description: '搜', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'create_study_plan', description: '写计划草稿', parameters: { type: 'object', properties: {} } } }] });
  const root = tmpdir();
  const { result } = await runDesktop(desktopRun(g.url, { root, canWrite: true, message: '新建 new.txt' }));
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false, '本机代码助手直接写了用户的磁盘（要先成草稿、确认了才写）');
  assert.deepEqual(result.drafts.map((d) => d.path), ['new.txt']);
  assert.equal(result.drafts[0].content, '新内容\n');
  assert.ok(toolNames(g.streams[0]).includes('create_study_plan'), '能写的档位：远程工具照服务器给的全下发');

  const g2 = await gateway(t, [{ text: '只看了' }], { tools: [{ type: 'function', function: { name: 'search_wiki', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'create_study_plan', parameters: { type: 'object', properties: {} } } }] });
  await runDesktop(desktopRun(g2.url, { canWrite: false }));
  const names = toolNames(g2.streams[0]);
  for (const w of ['write_file', 'edit_file', 'apply_patch', 'delete_file', 'create_study_plan']) assert.ok(!names.includes(w), `只读档下发了 ${w}`);
  assert.ok(names.includes('search_wiki') && names.includes('read_file'));
});

test('本机模式（真沙箱）：读不到家目录；家目录按 run.home 算 —— 工作区就是家目录时 .ssh 照样挡，家目录下的工具链读得到', { skip: noBox }, async (t) => {
  const home = tmpdir('zhiqu-fake-home-');
  write(home, '.ssh/id_rsa', 'SECRET-KEY-DO-NOT-READ\n');
  write(home, 'notes.txt', 'PRIVATE-NOTES\n');
  write(home, '.cargo/registry/x.txt', 'TOOLCHAIN-OK\n');
  // 工作区就是家目录：工作区整个放读，只靠「家目录下的秘密」那一层挡 .ssh —— 照宿主自己的 HOME 算的话挡的是别处
  const g = await gateway(t, [{ calls: [{ name: 'shell', args: { command: 'cat .ssh/id_rsa; echo "rc=$?"' } }] }, { text: '看过了' }]);
  const { result } = await runDesktop(desktopRun(g.url, { root: home, home, canShell: true }));
  const out1 = String(g.streams[1].messages.at(-1).content);
  assert.ok(out1.includes('rc=') && !out1.includes('SECRET-KEY'), `工作区就是家目录时 .ssh 漏出去了：${out1.slice(0, 300)}`);
  assert.equal(result.error, null);

  // 工作区在别处：家目录读不到，家目录下的工具链（.cargo/registry）读得到
  const g2 = await gateway(t, [{ calls: [{ name: 'shell', args: { command: `cat ${home}/notes.txt; echo "notes=$?"; cat ${home}/.cargo/registry/x.txt; echo "tool=$?"` } }] }, { text: '看过了' }]);
  await runDesktop(desktopRun(g2.url, { home, canShell: true }));
  const out2 = String(g2.streams[1].messages.at(-1).content);
  assert.ok(!out2.includes('PRIVATE-NOTES') && /notes=[1-9]/.test(out2), `读到了家目录：${out2.slice(0, 400)}`);
  assert.ok(out2.includes('TOOLCHAIN-OK') && out2.includes('tool=0'), `家目录下的工具链读不到（家目录没按 run.home 算）：${out2.slice(0, 400)}`);
});

test('本机模式（真沙箱）：联网按外壳给的档 —— on 连得上、off 连不上、认不出的照断网；写工作区要 auto 档（shellWrite）', { skip: noBox }, async (t) => {
  for (const [network, reachable] of [['on', true], ['off', false], ['yes-please', false]]) {
    // 连的是假网关自己的 /ping（就在本机）：on 放行一切；off 和认不出的什么网都不给
    const target = await gateway(t, []);
    const g = await gateway(t, [{ calls: [{ name: 'shell', args: { command: `curl -s -m 3 ${target.url}/ping || echo unreachable` } }] }, { text: '好了' }]);
    await runDesktop(desktopRun(g.url, { canShell: true, sandboxNetwork: network }));
    const out = String(g.streams[1].messages.at(-1).content);
    assert.equal(out.includes('pong-from-gateway'), reachable, `联网档 ${network}：${out.slice(0, 300)}`);
  }
  for (const [shellWrite, wrote] of [[true, true], [false, false]]) {
    const root = tmpdir();
    const g = await gateway(t, [{ calls: [{ name: 'shell', args: { command: 'echo hi > made.txt; echo "rc=$?"' } }] }, { text: '好了' }]);
    await runDesktop(desktopRun(g.url, { root, canShell: true, canWrite: true, shellWrite }));
    assert.equal(fs.existsSync(path.join(root, 'made.txt')), wrote, `shellWrite=${shellWrite}`);
  }
});

test('本机模式（真沙箱）：外壳叫停 —— 中断、照实说「被你停下了」、后台命令跟着收掉', { skip: noBox }, async (t) => {
  const marker = `sleep ${3000 + Math.floor(Math.random() * 900)}`;
  const g = await gateway(t, [{ calls: [{ name: 'shell', args: { command: marker, background: true } }] }, { hang: true }]);
  const side = shellSide();
  const waiting = hung();
  const running = runHosted(side.bridge, desktopRun(g.url, { canShell: true }));
  await waiting;
  assert.equal(spawnSync('pgrep', ['-f', marker]).status, 0, '对照组：后台命令应该在跑');
  side.input.write(`${JSON.stringify({ type: 'stop' })}\n`);
  const result = await running;
  assert.equal(result.stopped, true);
  assert.equal(result.aborted, true);
  assert.match(result.conclusion, /被你停下了/);
  let alive = true;
  for (let i = 0; i < 40 && alive; i += 1) { alive = spawnSync('pgrep', ['-f', marker]).status === 0; if (alive) await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(alive, false, `叫停之后后台命令还在：${marker}`);
});

/** 真起一个宿主进程（外壳就是这样起的） */
function spawnHost(run) {
  const child = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: tmpdir() } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stdin.write(`${JSON.stringify(run)}\n`);
  const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, lines: out.split('\n').filter(Boolean) })));
  return { child, done };
}

for (const [how, act] of [['SIGTERM', (c) => c.kill('SIGTERM')], ['一行 stop', (c) => c.stdin.write('{"type":"stop"}\n')], ['关掉 stdin', (c) => c.stdin.end()]]) {
  test(`真进程：模型半天不回时外壳叫停（${how}）—— 交一行 result（被你停下了）、退出码 0、令牌不出现`, async (t) => {
    const g = await gateway(t, [{ hang: true }]);
    const waiting = hung();
    const { child, done } = spawnHost(desktopRun(g.url));
    t.after(() => { try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } });
    await waiting;
    act(child);
    const { code, lines } = await done;
    assert.equal(code, 0);
    const last = JSON.parse(lines.at(-1));
    assert.equal(last.type, 'result', lines.join('\n'));
    assert.equal(last.stopped, true);
    assert.match(last.conclusion, /被你停下了/);
    for (const l of lines) assert.ok(!l.includes(TOKEN), l);
  });
}
