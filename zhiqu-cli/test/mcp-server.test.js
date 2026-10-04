// zhiqu mcp（第二十九轮）：把知识 Wiki、任务、计划草稿、长期记忆做成 MCP 服务器给别家客户端用。
// 前半用假的 api 直接调 handle()；最后一条真的起 `zhiqu mcp` 进程、对着假的 /api/harness/** 走一遍 stdio。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServer, EXPOSED_TOOLS } from '../src/mcp-server.js';
import { PROTOCOL_VERSION } from '../src/mcp.js';
import { startFakeHarness } from './fixtures/fake-harness.js';
import { tmpdir } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'zhiqu.js');
const fn = (name, extra = {}) => ({ type: 'function', function: { name, description: `${name} 的说明`, parameters: { type: 'object', properties: {} }, ...extra } });

function fakeRemote({ fail = null } = {}) {
  const posts = [];
  const gets = [];
  return {
    posts,
    gets,
    async get(p) {
      gets.push(p);
      // 服务器上还有别的（比如以后加的、只给命令行的）—— 不在 EXPOSED_TOOLS 里的不该转出去
      return [...EXPOSED_TOOLS.map((n) => fn(n)), fn('internal_only')];
    },
    async post(p, body) {
      posts.push({ p, body });
      if (p !== '/api/harness/tools/call') return {};
      if (fail) throw fail;
      return { content: `结果：${body.name}`, drafts: body.name === 'create_study_plan' ? [{ title: '计划草稿' }] : [] };
    },
  };
}
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

test('握手：协商协议版本（认得的照回、不认得的回自己的）；通知不回；不认识的方法 -32601', async () => {
  const s = createMcpServer({ api: fakeRemote() });
  const init = await s.handle(rpc(1, 'initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'claude-code' } }));
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'zhiqu');
  const odd = await s.handle(rpc(2, 'initialize', { protocolVersion: '1999-01-01' }));
  assert.equal(odd.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await s.handle(rpc(3, 'ping'))).result, {});
  assert.equal((await s.handle(rpc(4, 'resources/list'))).error.code, -32601);
});

test('列工具：只转 EXPOSED_TOOLS 里的；读的那几个标 readOnlyHint，改任务状态不标；参数 schema 原样给', async () => {
  const s = createMcpServer({ api: fakeRemote() });
  const { tools } = (await s.handle(rpc(1, 'tools/list'))).result;
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPOSED_TOOLS].sort());
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ['search_wiki', 'read_wiki_page', 'list_tasks', 'read_memory']) assert.equal(by[n].annotations.readOnlyHint, true, n);
  for (const n of ['update_task_status', 'create_wiki_patch', 'create_study_plan', 'propose_memory']) assert.equal(by[n].annotations.readOnlyHint, false, n);
  assert.equal(by.list_tasks.inputSchema.type, 'object');
});

test('调工具：带同一个会话 id 转给服务器（会话只开一次、用客户端的名字起名）；草稿要说明要到网页确认', async () => {
  const api = fakeRemote();
  const s = createMcpServer({ api });
  await s.handle(rpc(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'Claude Code' } }));
  const a = await s.handle(rpc(2, 'tools/call', { name: 'list_tasks', arguments: {} }));
  const b = await s.handle(rpc(3, 'tools/call', { name: 'create_study_plan', arguments: { tasks: [{ title: 't' }] } }));
  assert.equal(a.result.isError, false);
  assert.equal(a.result.content[0].text, '结果：list_tasks');
  assert.match(b.result.content[0].text, /草稿：计划草稿.*网页里确认/);
  const calls = api.posts.filter((x) => x.p === '/api/harness/tools/call');
  assert.equal(calls.length, 2);
  assert.match(calls[0].body.sessionId, /^mcp-[0-9a-f]{16}$/);
  assert.equal(calls[1].body.sessionId, calls[0].body.sessionId, '一个 MCP 进程是一段会话');
  assert.deepEqual(calls[1].body.arguments, { tasks: [{ title: 't' }] });
  const opens = api.posts.filter((x) => x.p === '/api/harness/sessions');
  assert.equal(opens.length, 1);
  assert.equal(opens[0].body.title, 'MCP · Claude Code');
});

test('出错：不在清单里的工具、服务器出错都回 isError（是工具结果，不是协议错误），不在清单里的不发到服务器', async () => {
  const api = fakeRemote({ fail: new Error('连不上服务器') });
  const s = createMcpServer({ api });
  const local = await s.handle(rpc(1, 'tools/call', { name: 'internal_only', arguments: {} }));
  assert.equal(local.result.isError, true);
  assert.equal(api.posts.filter((x) => x.p === '/api/harness/tools/call').length, 0);
  const down = await s.handle(rpc(2, 'tools/call', { name: 'search_wiki', arguments: { query: 'x' } }));
  assert.equal(down.result.isError, true);
  assert.match(down.result.content[0].text, /连不上服务器/);
  assert.equal(down.error, undefined);
});

test('没登录：列工具和调工具都说「先 zhiqu login」，一个请求都不发', async () => {
  const api = fakeRemote();
  const s = createMcpServer({ api, loggedIn: false });
  assert.match((await s.handle(rpc(1, 'tools/list'))).error.message, /zhiqu login/);
  const call = await s.handle(rpc(2, 'tools/call', { name: 'list_tasks' }));
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /zhiqu login/);
  assert.equal(api.gets.length + api.posts.length, 0);
});

test('真的起 zhiqu mcp：stdout 里每一行都是协议消息（一个字的日志都没有），用令牌调到服务器，stdin 关了就退出', async () => {
  const fake = await startFakeHarness();
  try {
    const child = spawn(process.execPath, [BIN, 'mcp'], {
      env: { ...process.env, ZHIQU_SERVER: fake.url, ZHIQU_TOKEN: 'zqp_test_token', ZHIQU_HOME: tmpdir() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    for (const m of [rpc(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 't' } }),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      rpc(2, 'tools/list'),
      rpc(3, 'tools/call', { name: 'search_wiki', arguments: { query: '周报' } })]) {
      child.stdin.write(`${JSON.stringify(m)}\n`);
    }
    child.stdin.end();
    const code = await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('stdin 关了之后 10 秒还没退出')), 10_000))]);
    assert.equal(code, 0);
    const lines = out.trim().split('\n');
    const msgs = lines.map((l) => JSON.parse(l));   // 有一行不是 JSON 就在这里抛
    assert.deepEqual(msgs.map((m) => m.id), [1, 2, 3], `stdout：${out}`);
    assert.ok(msgs.every((m) => m.jsonrpc === '2.0'));
    assert.deepEqual(msgs[1].result.tools.map((t) => t.name), ['search_wiki']);
    assert.match(msgs[2].result.content[0].text, /远程结果/);
    const call = fake.requests.find((r) => r.route === 'POST /api/harness/tools/call');
    assert.equal(call.auth, 'Bearer zqp_test_token');
    assert.equal(call.body.name, 'search_wiki');
    assert.match(call.body.sessionId, /^mcp-/);
  } finally {
    await fake.close();
  }
});
