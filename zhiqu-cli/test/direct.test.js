// 直连供应商（第一百二十九轮）：用户自己填完整 URL，两种协议都翻译成服务器那套事件。
// 判据只看「发出去的请求对不对」和「翻译出来的事件对不对」——真的去连内网模型没法在判据里做。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DirectModel, toAnthropicMessages } from '../src/direct.js';
import { ApiError } from '../src/api.js';
import { normalizeDirect } from '../src/config.js';

/** 起一个假供应商：记下收到的请求，按给定的分片回 SSE */
async function fakeProvider(chunks, { status = 200, body = '' } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (status !== 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const c of chunks) res.write(c);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1/anything`, seen, close: () => new Promise((r) => server.close(r)) };
}

const collect = async (model, body = { messages: [{ role: 'user', content: 'hi' }] }) => {
  const events = [];
  await model.stream(body, (name, data) => events.push({ name, data }));
  return events;
};

test('OpenAI 兼容：正文、思考、工具调用分片都翻成服务器那套事件', async () => {
  const p = await fakeProvider([
    'data: {"choices":[{"delta":{"reasoning_content":"先看一眼"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    const model = new DirectModel({ url: p.url, key: 'sk-1', model: 'qwen' });
    const events = await collect(model);
    assert.deepEqual(events.filter((e) => e.name === 'delta').map((e) => e.data.text), ['你好']);
    assert.deepEqual(events.filter((e) => e.name === 'reasoning').map((e) => e.data.text), ['先看一眼']);
    assert.deepEqual(events.filter((e) => e.name === 'tool_call').map((e) => e.data.name), ['read_file']);
    const done = events.find((e) => e.name === 'done').data;
    assert.equal(done.message.content, '你好');
    assert.equal(done.message.tool_calls.length, 1);
    assert.equal(done.message.tool_calls[0].id, 'c1');
    assert.deepEqual(JSON.parse(done.message.tool_calls[0].function.arguments), { path: 'a.txt' });
    assert.equal(done.finishReason, 'tool_calls');
    // 请求本身：地址原样用（不拼 /chat/completions）、模型名来自配置、带 Bearer
    assert.equal(p.seen[0].url, '/v1/anything');
    assert.equal(p.seen[0].body.model, 'qwen');
    assert.equal(p.seen[0].body.stream, true);
    assert.equal(p.seen[0].headers.authorization, 'Bearer sk-1');
  } finally { await p.close(); }
});

test('Anthropic：system 提到顶层、tool_use 的 input 由分片拼回来、tool_result 并进同一条 user', async () => {
  const p = await fakeProvider([
    'event: message_start\ndata: {"message":{"usage":{"input_tokens":10}}}\n\n',
    'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
    'event: content_block_start\ndata: {"index":1,"content_block":{"type":"tool_use","id":"tu1","name":"read_file"}}\n\n',
    'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
    'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}\n\n',
    'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
    'event: message_stop\ndata: {}\n\n',
  ]);
  try {
    const model = new DirectModel({ protocol: 'anthropic', url: p.url, key: 'ak-1', model: 'claude-x' });
    const events = await collect(model, {
      maxTokens: 1234,
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '读 a.txt' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '内容' },
        { role: 'tool', tool_call_id: 'c2', content: '另一份' },
      ],
      tools: [{ type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    });
    const done = events.find((e) => e.name === 'done').data;
    assert.equal(done.message.content, '好');
    assert.deepEqual(JSON.parse(done.message.tool_calls[0].function.arguments), { path: 'a.txt' });
    assert.equal(done.finishReason, 'tool_use');
    assert.equal(done.usage.promptTokens, 10);
    const body = p.seen[0].body;
    assert.equal(body.system, '你是助手');
    assert.equal(body.max_tokens, 1234);
    assert.equal(body.tools[0].input_schema.type, 'object', '工具要翻成 input_schema');
    assert.equal(p.seen[0].headers['x-api-key'], 'ak-1');
    assert.equal(p.seen[0].headers['anthropic-version'], '2023-06-01');
    // 两条 tool 结果并进同一条 user（Anthropic 要求 user/assistant 交替）
    const users = body.messages.filter((m) => m.role === 'user');
    assert.equal(users.length, 2);
    assert.equal(users[1].content.length, 2);
    assert.equal(users[1].content[0].type, 'tool_result');
  } finally { await p.close(); }
});

test('接口报错：说清是哪一步、地址是用户填的所以要把地址带上', async () => {
  const p = await fakeProvider([], { status: 401, body: '{"error":"bad key"}' });
  try {
    const model = new DirectModel({ url: p.url, model: 'm' });
    await assert.rejects(collect(model), (e) => {
      assert.match(e.message, /HTTP 401/);
      assert.match(e.message, /密钥/);
      assert.equal(e.beforeOutput, true);
      return true;
    });
  } finally { await p.close(); }
});

test('toAnthropicMessages：system 提出来、tool_calls 变 tool_use 块', () => {
  const { system, messages } = toAnthropicMessages([
    { role: 'system', content: 'A' },
    { role: 'system', content: 'B' },
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '答', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] },
  ]);
  assert.equal(system, 'A\n\nB');
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1].content.map((b) => b.type), ['text', 'tool_use']);
  assert.deepEqual(messages[1].content[1].input, { x: 1 });
});

test('配置：没 url 或没模型名就当没配；地址不校验格式（内网 http 照收）；只认用户级', () => {
  assert.equal(normalizeDirect(null), null);
  assert.equal(normalizeDirect({ url: 'http://x' }), null, '没有模型名用不了');
  assert.equal(normalizeDirect({ model: 'm' }), null, '没有地址用不了');
  const d = normalizeDirect({ url: 'http://10.0.0.5:8000/v1/chat/completions', model: 'qwen', protocol: '乱写' });
  assert.equal(d.url, 'http://10.0.0.5:8000/v1/chat/completions', '地址原样用，不补 /v1、不改协议');
  assert.equal(d.protocol, 'openai', '认不出的协议按 openai');
  assert.equal(d.contextWindow, 64_000);
  assert.equal(d.maxTokens, 8192);
});

test('连不上：是可重试的 ApiError（callModel 只认这个才会重来）', async () => {
  const model = new DirectModel({ url: 'http://127.0.0.1:1/v1/chat', model: 'm' });
  await assert.rejects(collect(model), (e) => {
    assert.ok(e instanceof ApiError, '不是 ApiError 的话 callModel 不会重试');
    assert.equal(e.retryable, true, '连接被拒是临时错误，要能重来');
    assert.match(e.message, /连不上 127\.0\.0\.1:1/);
    assert.match(e.message, /地址是/, '地址是用户填的，出错要带上');
    return true;
  });
});

test('说了一半断掉：标成 beforeOutput=false，别自动重来（会重复输出）', async () => {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '说到一半' } }] })}\n\n`);
      setTimeout(() => res.destroy(), 20);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const model = new DirectModel({ url: `http://127.0.0.1:${server.address().port}/v1/chat`, model: 'm' });
    await assert.rejects(collect(model), (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.beforeOutput, false, '已经出过字了，重来会让用户看到重复内容');
      assert.match(e.message, /回复中断了/);
      return true;
    });
  } finally { await new Promise((r) => server.close(r)); }
});
