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
import { appSessionId, createBridge, desktopTarget, runHosted } from '../src/host/code-host.js';
import { runTurn, TurnBusyError } from '../src/agent.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi } from './helpers.js';
import { SessionStore } from '../src/session.js';
import { WorkState } from '../src/state.js';
import { ProjectMemory } from '../src/memory.js';
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
      if (req.url.startsWith('/api/harness/memory/brief')) {
        if (gateway.brief === 403) { res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 403, message: '没有权限' })); return undefined; }
        return json(gateway.brief || { enabled: false });
      }
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

// ── 第一百四十五轮：应用里的会话写会话记录（docs/app-resume-plan.md 第 1 步）──────────────────────────

const sent = (body) => JSON.stringify(body.messages);
const countOf = (text, needle) => text.split(needle).length - 1;

test('应用会话：同一个 sessionId 的第二轮看得见第一轮的工具结果；记录在项目的 .zhiqu/sessions/、命令行读得回来（对照：不给 id 照旧只有拍扁的问答）', async (t) => {
  const root = tmpdir();
  write(root, 'a.txt', 'SECRET-IN-FILE-42\n');
  const g = await gateway(t, [{ calls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: '第一轮看完了' }, { text: '第二轮答了' }]);
  const first = await runDesktop(desktopRun(g.url, { root, sessionId: 'app-12', message: '看看 a.txt' }));
  assert.equal(first.result.conclusion, '第一轮看完了');
  const history = [{ id: 31, role: 'user', content: '看看 a.txt' }, { id: 32, role: 'assistant', content: '第一轮看完了' }];
  await runDesktop(desktopRun(g.url, { root, sessionId: 'app-12', message: '里面写的是什么', history }));
  const second = sent(g.streams[2]);
  assert.ok(second.includes('SECRET-IN-FILE-42'), `第二轮发给模型的消息里没有第一轮读到的内容：${second.slice(0, 600)}`);
  assert.equal(countOf(second, '看看 a.txt'), 1, '第一轮那句话在历史里出现了不止一次（记录里有了，又拍扁放了一遍）');

  const store = new SessionStore(root);
  const row = store.list().find((s) => s.id === 'app-12');
  assert.ok(row, '索引里没有这段会话：命令行的 /resume 列不出来');
  assert.equal(row.via, 'app');
  assert.equal(row.title, '看看 a.txt');
  const loaded = store.load('app-12');
  assert.ok(loaded.messages.some((m) => (m.tool_calls || []).some((c) => c.function.name === 'read_file')), '记录里没有工具调用');
  assert.ok(loaded.messages.some((m) => m.role === 'tool' && String(m.content).includes('SECRET-IN-FILE-42')));
  assert.equal(fs.existsSync(path.join(root, '.zhiqu', 'state.json')), false, '还在用整个文件夹共用的那张状态卡');
  assert.ok(fs.existsSync(path.join(root, '.zhiqu', 'sessions', 'app-12.state.json')), '状态卡没跟着会话走');

  // 对照组：不给 id —— 第二轮只有拍扁的问答，读到的内容没了
  const root2 = tmpdir();
  write(root2, 'a.txt', 'SECRET-IN-FILE-42\n');
  const g2 = await gateway(t, [{ calls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: '第一轮看完了' }, { text: '第二轮答了' }]);
  await runDesktop(desktopRun(g2.url, { root: root2, message: '看看 a.txt' }));
  await runDesktop(desktopRun(g2.url, { root: root2, message: '里面写的是什么', history }));
  assert.ok(!sent(g2.streams[2]).includes('SECRET-IN-FILE-42'), '对照组不成立：没有记录时第二轮也看到了');
  assert.equal(fs.existsSync(path.join(root2, '.zhiqu', 'sessions')), false, '没给 id 却建了会话记录');
});

test('应用会话：别处（普通聊天）接着说的几轮拍扁成「只有文字」追加一次；记录里有的不重复；没有消息号的前情只在第一次带', async (t) => {
  const root = tmpdir();
  const g = await gateway(t, [{ text: '答一' }, { text: '答二' }, { text: '答三' }]);
  const h1 = [{ role: 'user', content: '【前情摘要：前面 9 条已压缩】PACKED-SUMMARY' }, { id: 5, role: 'user', content: '聊天里问的 ALPHA' }, { id: 6, role: 'assistant', content: '聊天里答的 ALPHA' }];
  await runDesktop(desktopRun(g.url, { root, sessionId: 'app-7', message: '代码一', history: h1 }));
  const s1 = sent(g.streams[0]);
  assert.ok(s1.includes('PACKED-SUMMARY') && s1.includes('聊天里答的 ALPHA'), '第一轮没带上前面的对话');

  const h2 = [...h1, { id: 7, role: 'user', content: '代码一' }, { id: 8, role: 'assistant', content: '答一' },
    { id: 9, role: 'user', content: '聊天里又问 BETA' }, { id: 10, role: 'assistant', content: '聊天里答 BETA' }];
  await runDesktop(desktopRun(g.url, { root, sessionId: 'app-7', message: '代码二', history: h2 }));
  const s2 = sent(g.streams[1]);
  assert.equal(countOf(s2, '聊天里答 BETA'), 1, `别处说的那一轮没带上、或者带了两遍：${s2.slice(0, 800)}`);
  assert.match(s2, /只有文字/);
  assert.equal(countOf(s2, 'PACKED-SUMMARY'), 1, '前情摘要又放了一遍');
  assert.equal(countOf(s2, '聊天里答的 ALPHA'), 1, '对过账的又放了一遍');
  assert.equal(countOf(s2, '代码一'), 1, '记录里有的那一轮（宿主自己跑的）又拍扁放了一遍');
  assert.equal(countOf(s2, '答一'), 1, '记录里有的那一轮的回答又拍扁放了一遍');

  // 同样的问答再来一轮：什么都不补
  const h3 = [...h2, { id: 11, role: 'user', content: '代码二' }, { id: 12, role: 'assistant', content: '答二' }];
  await runDesktop(desktopRun(g.url, { root, sessionId: 'app-7', message: '代码三', history: h3 }));
  const s3 = sent(g.streams[2]);
  assert.equal(countOf(s3, '聊天里答 BETA'), 1);
  assert.equal(countOf(s3, '代码二'), 1);
});

test('应用会话：同一句话说两遍（「继续」）按顺序对账，不会把别处说的那句当成记录里已经有的', async (t) => {
  const root = tmpdir();
  const g = await gateway(t, [{ text: '一' }, { text: '二' }, { text: '三' }]);
  await runDesktop(desktopRun(g.url, { root, sessionId: 'app-8', message: '继续', history: [] }));
  const h = [{ id: 1, role: 'user', content: '继续' }, { id: 2, role: 'assistant', content: '一' },
    { id: 3, role: 'user', content: '继续' }, { id: 4, role: 'assistant', content: '聊天里的 GAMMA' }];
  await runDesktop(desktopRun(g.url, { root, sessionId: 'app-8', message: '再来', history: h }));
  assert.equal(countOf(sent(g.streams[1]), '聊天里的 GAMMA'), 1, '别处那一句「继续」被当成记录里已经有的、吞掉了');
  // 对过账之前说过的话不再参与对账：上一轮（「再来」）没存进对话（存档失败），之后在聊天里又说了一句「继续」——
  // 它比上次的对账点新，是别处说的，要带上；不能拿对账点之前那句「继续」把它对掉
  const h2 = [...h, { id: 7, role: 'user', content: '继续' }, { id: 8, role: 'assistant', content: '聊天里的 DELTA' }];
  await runDesktop(desktopRun(g.url, { root, sessionId: 'app-8', message: '第三句', history: h2 }));
  assert.equal(countOf(sent(g.streams[2]), '聊天里的 DELTA'), 1, '对账点之前的「继续」把别处新说的那句对掉了');
});

test('应用会话：旧版共用的 .zhiqu/state.json 没做完 → 作为一条说明接进来一次，然后删掉', async (t) => {
  const root = tmpdir();
  const legacy = new WorkState(path.join(root, '.zhiqu', 'state.json'));
  legacy.beginTurn('把 LEGACY-GAME 做完');
  const g = await gateway(t, [{ text: '一' }, { text: '二' }]);
  await runDesktop(desktopRun(g.url, { root, sessionId: 'app-9', message: '接着' }));
  const s1 = sent(g.streams[0]);
  assert.ok(s1.includes('上一轮在这个项目里没做完') && s1.includes('LEGACY-GAME'), `旧状态卡没接上：${s1.slice(0, 500)}`);
  assert.equal(fs.existsSync(path.join(root, '.zhiqu', 'state.json')), false, '旧状态卡没删');
  await runDesktop(desktopRun(g.url, { root, sessionId: 'app-9', message: '再接着' }));
  assert.equal(countOf(sent(g.streams[1]), '上一轮在这个项目里没做完'), 1, '旧状态卡接了两遍');
});

test('应用会话：项目里有别的会话 → 开工就知道最近几段、给 search_sessions；项目笔记进系统提示（对照：不给 id 都没有）', async (t) => {
  const root = tmpdir();
  const cli = new SessionStore(root);
  const prev = cli.create({ title: '命令行里做的 DELTA' });
  cli.append(prev.id, { type: 'message', message: { role: 'user', content: '命令行里做的 DELTA' } });
  new ProjectMemory(path.join(root, '.zhiqu', 'memory'), root).write({ title: 'EPSILON 约定', type: 'convention', text: '测试用 EPSILON 跑' });
  const g = await gateway(t, [{ text: '一' }, { text: '二' }]);
  await runDesktop(desktopRun(g.url, { root, sessionId: 'app-10', message: '开工' }));
  const body = g.streams[0];
  const all = JSON.stringify(body);
  assert.ok(toolNames(body).includes('search_sessions'), `没给 search_sessions：${toolNames(body).join(',')}`);
  assert.ok(all.includes('命令行里做的 DELTA'), '开工时不知道这个项目里最近的会话');
  assert.ok(all.includes('EPSILON'), '项目笔记没进来');

  await runDesktop(desktopRun(g.url, { root, message: '开工' }));
  const plain = g.streams[1];
  assert.ok(!toolNames(plain).includes('search_sessions') && !JSON.stringify(plain).includes('EPSILON'), '对照组不成立：没有记录也有这些');
});

test('应用会话：/review 的结论也记进这段会话', async (t) => {
  const root = tmpdir();
  const g = await gateway(t, [{ text: 'x' }]);
  await runDesktop(desktopRun(g.url, { root, sessionId: 'app-11', message: '/review', command: 'review' }));
  const loaded = new SessionStore(root).load('app-11');
  assert.ok(loaded.messages.some((m) => m.role === 'user' && m.content === '/review'), '审查没记进会话');
  assert.deepEqual(loaded.said, ['/review'], '审查那一句记成了两句（said 和那条消息没配上对）');
});

test('应用会话：id 不合规、临时的、不是桌面版 —— 不建记录', async (t) => {
  const g = await gateway(t, [{ text: '一' }]);
  for (const sessionId of ['../x', 'a/b', '', 'ephemeral-1', 'x'.repeat(65), 12]) {
    const root = tmpdir();
    await runDesktop(desktopRun(g.url, { root, sessionId }));
    assert.equal(fs.existsSync(path.join(root, '.zhiqu', 'sessions')), false, `${JSON.stringify(sessionId)} 建了记录`);
  }
  assert.equal(appSessionId({ sessionId: 'app-1' }, null), null, '后端起的那一份（不是桌面版）也建了记录');
  assert.equal(appSessionId({ sessionId: 'app-1' }, { server: 'x' }), 'app-1');
  // 宿主自己先认（不靠 SessionStore.file 抛错再接住 —— 那样每一轮都多一句「会话记录打不开」）
  for (const bad of ['../x', 'a/b', 'x'.repeat(65), 'app 1']) assert.equal(appSessionId({ sessionId: bad }, { server: 'x' }), null, bad);
});

// ── 第一百四十六轮：两边轮流说（docs/app-resume-plan.md 第 2 步）────────────────────────────────

/** 另一个活着的进程（锁的主人）。用完要等它真退出（被收走），不然 kill(pid, 0) 对僵尸也说「在」 */
async function otherProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(() => { child.kill('SIGKILL'); });
  return { pid: child.pid, stop: async () => { child.kill('SIGKILL'); await exited; } };
}

function foreignLock(root, id, pid, who, { ageMs = 0 } = {}) {
  const file = path.join(root, '.zhiqu', 'sessions', `${id}.turn.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid, who, at: new Date().toISOString() }));
  if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(file, t, t); }
  return file;
}

function cliCtx(root, id, replies) {
  const store = new SessionStore(root);
  const session = fs.existsSync(store.file(id)) ? store.load(id).meta : store.adopt(id);
  const loaded = store.load(id);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds: 30,
    local: new LocalTools({ root }), store, session, messages: loaded.messages,
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 64_000 },
  };
}

test('轮锁：别的活进程拿着就不给；那个进程没了、或者 30 秒没心跳，算遗留、清掉再拿；放掉只删自己的；拿着时有心跳', async (t) => {
  const root = tmpdir();
  const store = new SessionStore(root);
  const other = await otherProcess(t);
  const file = foreignLock(root, 'app-1', other.pid, 'app');
  const busy = store.lockTurn('app-1', 'cli');
  assert.deepEqual({ who: busy.busy && busy.busy.who, pid: busy.busy && busy.busy.pid }, { who: 'app', pid: other.pid }, '别的活进程拿着却给了');

  foreignLock(root, 'app-1', other.pid, 'app', { ageMs: 31_000 });
  const stale = store.lockTurn('app-1', 'cli');
  assert.ok(stale.release && !stale.busy, '30 秒没心跳的锁没清掉');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  stale.release();
  assert.equal(fs.existsSync(file), false, '放掉之后锁文件还在');

  foreignLock(root, 'app-1', other.pid, 'app');
  await other.stop();
  const dead = store.lockTurn('app-1', 'cli');
  assert.ok(!dead.busy, '主人进程已经没了，锁没清掉');
  // 放掉时锁已经是别人的（被当成遗留抢走了）：不删别人的
  foreignLock(root, 'app-1', 999999, 'app');
  dead.release();
  assert.equal(fs.existsSync(file), true, '放掉时删了别人的锁');
  fs.rmSync(file);

  const held = store.lockTurn('app-1', 'cli', { beatMs: 30 });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(Date.now() - fs.statSync(file).mtimeMs < 5_000, '拿着锁时没有心跳（会被别人当成遗留抢走）');
  held.release();
});

test('命令行：这段会话别处正在跑一轮 → 这一句不发、记录一个字不写，照实说是谁在跑', async (t) => {
  const root = tmpdir();
  const ctx = cliCtx(root, 'app-2', [{ text: '不该到这里' }]);
  const before = fs.existsSync(ctx.store.file('app-2')) ? fs.statSync(ctx.store.file('app-2')).size : 0;
  const other = await otherProcess(t);
  foreignLock(root, 'app-2', other.pid, 'app');
  await assert.rejects(runTurn(ctx, '撞上的一句'), (e) => e instanceof TurnBusyError && /在应用里正在跑一轮/.test(e.message));
  assert.equal(ctx.api.requests.length, 0, '撞上了还叫了模型');
  const after = fs.existsSync(ctx.store.file('app-2')) ? fs.statSync(ctx.store.file('app-2')).size : 0;
  assert.equal(after, before, '撞上了还往记录里写了');
  await other.stop();
  await runTurn(ctx, '这次能说了');
  assert.equal(ctx.api.requests.length, 1, '对照组：锁的主人没了照样不让说');
  assert.equal(fs.existsSync(path.join(root, '.zhiqu', 'sessions', 'app-2.turn.lock')), false, '说完没放锁');
});

test('命令行接着说：应用在这期间说过的几轮先读进来（带工具结果），说一声；没人动过就不重读', async (t) => {
  const root = tmpdir();
  write(root, 'a.txt', 'APP-READ-5150\n');
  const g = await gateway(t, [{ calls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: '应用这边读完了' }]);
  // 应用先开的头；命令行 /resume 回这段已有的记录（不是新建）
  const g0 = await gateway(t, [{ text: '应用开头答' }]);
  await runDesktop(desktopRun(g0.url, { root, sessionId: 'app-3', message: '应用开的头', history: [] }));
  const cli = cliCtx(root, 'app-3', [{ text: '命令行一' }, { text: '命令行二' }, { text: '命令行三' }]);
  await runTurn(cli, '命令行先说一句');
  // 应用（真的宿主）接着说了一轮
  await runDesktop(desktopRun(g.url, { root, sessionId: 'app-3', message: '应用里说的那句', history: [] }));
  await runTurn(cli, '命令行再说');
  const sentNow = JSON.stringify(cli.api.requests[1].messages);
  assert.ok(sentNow.includes('APP-READ-5150') && sentNow.includes('应用里说的那句'), `命令行没读进应用那一轮：${sentNow.slice(0, 600)}`);
  assert.equal(countOf(sentNow, '命令行先说一句'), 1, '重读后自己说过的重复了');
  assert.match(cli.ui.text(), /在应用里接着说了 1 句，已经读进来/);
  // 没人动过：不说、不重读（消息原样往后接）
  const notes = (cli.ui.text().match(/已经读进来/g) || []).length;
  await runTurn(cli, '命令行第三句');
  assert.equal((cli.ui.text().match(/已经读进来/g) || []).length, notes, '没人动过也说「读进来了」');
});

test('应用：这段会话命令行里正在跑一轮 → 不叫模型、不碰记录，交一句照实的话（busy）', async (t) => {
  const root = tmpdir();
  const g = await gateway(t, [{ text: '不该到这里' }]);
  const other = await otherProcess(t);
  foreignLock(root, 'app-4', other.pid, 'cli');
  const { result } = await runDesktop(desktopRun(g.url, { root, sessionId: 'app-4', message: '应用这句', history: [{ id: 1, role: 'user', content: '前情' }] }));
  assert.equal(result.busy, true);
  assert.match(result.conclusion, /在命令行里正在跑一轮/);
  assert.equal(g.streams.length, 0, '撞上了还叫了模型');
  assert.equal(fs.existsSync(path.join(root, '.zhiqu', 'sessions', 'app-4.jsonl')), false, '撞上了还往记录里写了（补前情 / 对账）');
  await other.stop();
  const ok = await runDesktop(desktopRun(g.url, { root, sessionId: 'app-4', message: '应用这句' }));
  assert.ok(!ok.result.busy && g.streams.length === 1, '对照组：锁的主人没了照样不让说');
  assert.equal(fs.existsSync(path.join(root, '.zhiqu', 'sessions', 'app-4.turn.lock')), false, '说完没放锁');
});

test('老记录（没有 said 行）对账：用记录里人说的那几条消息；应用里接着命令行的会话时不再把它们拍扁一遍', async (t) => {
  const root = tmpdir();
  const store = new SessionStore(root);
  const meta = store.create({ title: '老的命令行会话' });
  store.append(meta.id, { type: 'message', message: { role: 'user', content: 'OLD-CLI-SAID' } });
  store.append(meta.id, { type: 'message', message: { role: 'assistant', content: 'OLD-CLI-ANSWER' } });
  store.append(meta.id, { type: 'message', message: { role: 'user', content: '（任务清单里还有 2 项没做完）' } });
  store.append(meta.id, { type: 'message', message: { role: 'assistant', content: '好' } });
  assert.deepEqual(store.load(meta.id).said, ['OLD-CLI-SAID'], '老记录的对账没退回用消息、或者把命令行自己补的话当成人说的');
  const g = await gateway(t, [{ text: '应用接上了' }]);
  await runDesktop(desktopRun(g.url, { root, sessionId: meta.id, message: '应用里接着',
    history: [{ id: 3, role: 'user', content: 'OLD-CLI-SAID' }, { id: 4, role: 'assistant', content: 'OLD-CLI-ANSWER' }] }));
  const sentNow = sent(g.streams[0]);
  assert.equal(countOf(sentNow, 'OLD-CLI-ANSWER'), 1, `命令行那一轮在记录里有了，又拍扁放了一遍：${sentNow.slice(0, 600)}`);
});

test('应用：一轮里只拿一次锁（宿主拿着的，runTurn 不再拿 —— 不然会把自己的锁当成遗留的清掉重拿，中间有一段空窗）', async (t) => {
  const root = tmpdir();
  const g = await gateway(t, [{ text: '好' }]);
  const real = SessionStore.prototype.lockTurn;
  let calls = 0;
  SessionStore.prototype.lockTurn = function (...a) { calls += 1; return real.apply(this, a); };
  try {
    await runDesktop(desktopRun(g.url, { root, sessionId: 'app-6', message: '一句' }));
  } finally {
    SessionStore.prototype.lockTurn = real;
  }
  assert.equal(calls, 1, `一轮里拿了 ${calls} 次锁`);
});

test('应用：在本机的 ~/.zhiqu/app-sessions.json 记一条「这段对话的记录在哪个文件夹」（用外壳给的家目录；不给 id 不记）', async (t) => {
  const root = tmpdir();
  const home = tmpdir();
  const g = await gateway(t, [{ text: '好' }]);
  await runDesktop(desktopRun(g.url, { root, home, sessionId: 'app-30', message: '一句' }));
  const index = JSON.parse(fs.readFileSync(path.join(home, '.zhiqu', 'app-sessions.json'), 'utf8'));
  assert.equal(index.sessions['app-30'].root, fs.realpathSync(root));
  const home2 = tmpdir();
  await runDesktop(desktopRun(g.url, { root: tmpdir(), home: home2, message: '一句' }));
  assert.equal(fs.existsSync(path.join(home2, '.zhiqu', 'app-sessions.json')), false, '没给 id 也记了');
});

test('应用：开工时带上用户的长期记忆（和命令行同一段）；服务器还没部署（403）或者开关关着就没有，这一轮照跑', async (t) => {
  const g = await gateway(t, [{ text: '好' }, { text: '好' }, { text: '好' }]);
  gateway.brief = { enabled: true, text: '- 周三上午不开会 ZETA-MEMORY', total: 1, included: 1 };
  t.after(() => { gateway.brief = null; });
  await runDesktop(desktopRun(g.url, { root: tmpdir(), sessionId: 'app-40' }));
  assert.ok(JSON.stringify(g.streams[0].messages).includes('ZETA-MEMORY'), '应用里开的会话开工时没有用户的长期记忆');
  assert.ok(g.seen.some((s) => s.url.startsWith('/api/harness/memory/brief') && s.auth === `Bearer ${TOKEN}`));
  gateway.brief = 403;
  const old = await runDesktop(desktopRun(g.url, { root: tmpdir(), sessionId: 'app-41' }));
  assert.equal(old.result.error, null, `服务器回 403 时这一轮被停掉了：${old.result.error}`);
  assert.ok(!JSON.stringify(g.streams[1].messages).includes('ZETA-MEMORY'));
  gateway.brief = { enabled: false };
  await runDesktop(desktopRun(g.url, { root: tmpdir(), sessionId: 'app-42' }));
  assert.ok(!JSON.stringify(g.streams[2].messages).includes('用户的长期记忆'), '开关关着也带了');
});
