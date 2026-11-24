// 缓存与用量（第一百四十轮，docs/memory-plan.md 第 4 步）。
// 量：每次调用的用量记进会话记录、每句话报命中、连着没命中提醒、压缩的判断以供应商报的实际值为准。
// 稳：系统提示里的档位和日期开工时定下，变了追加一条；压缩后的原话不再置顶进系统提示。
// 标：直连 Claude 照网关那套标三处断点，被拒逐级退回。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { announceEnvChange, LOW_HIT_STREAK, PREFIX_SUMMARY_ASK, runTurn, setMode, systemText, usageNote, usedTokens, workOf } from '../src/agent.js';
import { estimateMessages, estimateTokens } from '../src/compact.js';
import { cacheBoundary, DirectModel, markAnthropic, markOpenAi } from '../src/direct.js';
import { generatedOrigin } from '../src/origins.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { answerTaskSwitch, fakeApi, fakeUi, tmpdir, write } from './helpers.js';

function makeCtx({ replies = [{ text: '好' }], window = 64_000, root = tmpdir(), mode = 'auto' } = {}) {
  const store = new SessionStore(root);
  return {
    ui: fakeUi([]), api: answerTaskSwitch(fakeApi(replies)), root, mode, maxRounds: 40,
    local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: window },
  };
}
const call = (name, args) => ({ calls: [{ name, args }] });
const usage = (promptTokens, cachedTokens) => ({ promptTokens, completionTokens: 5, ...(cachedTokens == null ? {} : { cachedTokens }), estimated: false });
const events = (ctx) => fs.readFileSync(ctx.store.file(ctx.session.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('用量：每次模型调用记进会话记录；一句话结束报输入、命中、压缩几次；供应商没报命中就不说命中', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n');
  const ctx = makeCtx({ root, replies: [{ ...call('read_file', { path: 'a.js' }), usage: usage(10_000, 1_000) }, { text: '读完了', usage: usage(11_000, 10_000) }] });
  const r = await runTurn(ctx, '读 a.js');
  const rows = events(ctx).filter((e) => e.type === 'usage');
  assert.deepEqual(rows.map((e) => [e.prompt, e.cached, e.estimated]), [[10_000, 1_000, false], [11_000, 10_000, false]]);
  assert.deepEqual(r.usage, { prompt: 21_000, completion: 10, cached: 11_000, reported: true, calls: 2 });
  assert.equal(usageNote(r), '· 这一句输入 21K（缓存命中 52%）');
  assert.equal(usageNote({ ...r, compactions: 2, clears: 1 }), '· 这一句输入 21K（缓存命中 52%），压缩 2 次，清理 1 批');
  assert.equal(usageNote({ usage: { prompt: 900, completion: 1, cached: 0, reported: false, calls: 1 } }), '· 这一句输入 900', '没报命中 ≠ 命中 0%');
  assert.equal(usageNote({ usage: { prompt: 0, calls: 0 } }), '');
  // 接回这段会话：多出来的 usage 行不碍事
  assert.equal(ctx.store.load(ctx.session.id).messages.length, ctx.messages.length);
  // 供应商没报的：记 null
  const quiet = makeCtx({ replies: [{ text: '好', usage: usage(5_000, null) }] });
  const q = await runTurn(quiet, 'x');
  assert.equal(events(quiet).find((e) => e.type === 'usage').cached, null);
  assert.equal(q.usage.reported, false, '没报就是没报：不能算成命中 0%');
  assert.equal(usageNote(q), '· 这一句输入 5000');
});

test('连着 5 次请求缓存都没怎么命中：提醒一次「前缀在变」；中间命中过一次就重新数；没报命中的不算', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n');
  const reads = (n, u) => Array.from({ length: n }, (_, i) => ({ ...call('read_file', { path: 'a.js', offset: 1, limit: 10 + i }), usage: u }));
  assert.equal(LOW_HIT_STREAK, 5);
  const low = makeCtx({ root, replies: [...reads(6, usage(50_000, 2_000)), { text: '好', usage: usage(50_000, 2_000) }] });
  await runTurn(low, '读');
  assert.equal((low.ui.text().match(/缓存都没怎么命中/g) || []).length, 1, low.ui.text());
  const mixed = makeCtx({ root, replies: [...reads(4, usage(50_000, 2_000)), ...reads(1, usage(50_000, 45_000)), ...reads(4, usage(50_000, 2_000)), { text: '好', usage: usage(50_000, 45_000) }] });
  await runTurn(mixed, '读');
  assert.ok(!/缓存都没怎么命中/.test(mixed.ui.text()), '中间命中过一次：不到连着 5 次');
  const unreported = makeCtx({ root, replies: [...reads(7, usage(50_000, null)), { text: '好', usage: usage(50_000, null) }] });
  await runTurn(unreported, '读');
  assert.ok(!/缓存都没怎么命中/.test(unreported.ui.text()), '供应商没报命中数：不能当成没命中');
  const small = makeCtx({ root, replies: [...reads(7, usage(900, 0)), { text: '好', usage: usage(900, 0) }] });
  await runTurn(small, '读');
  assert.ok(!/缓存都没怎么命中/.test(small.ui.text()), '请求很小（不到缓存的门槛）的不算');
});

test('现在背着多少：有供应商报的实际值就用「实际值 + 之后新增的估算」；离谱的不信；历史换过就作废', async () => {
  const ctx = makeCtx();
  ctx.messages = [{ role: 'user', content: '字'.repeat(4000) }];
  const est = estimateTokens(systemText(ctx)) + estimateMessages(ctx.messages);
  assert.equal(usedTokens(ctx), est, '没有实际值：全靠估');
  // 实际比估的多（工具表也占地方）：以实际为准，后面新增的照估
  ctx.actual = { ref: ctx.messages, len: 1, prompt: est + 3000 };
  ctx.messages.push({ role: 'assistant', content: '字'.repeat(500) });
  assert.equal(usedTokens(ctx), est + 3000 + 504);
  ctx.messages = ctx.messages.slice();   // 压缩 / 清理之后是另一份数组
  assert.equal(usedTokens(ctx), estimateTokens(systemText(ctx)) + estimateMessages(ctx.messages), '历史换过：实际值作废');
  // 一句话跑下来：合理的实际值被记下，离谱的（假模型报 10）不信
  const real = makeCtx({ replies: [{ text: '好', usage: usage(4200, 0) }] });
  real.messages = [{ role: 'user', content: '字'.repeat(4000) }];
  await runTurn(real, '接着');
  assert.equal(real.actual.prompt, 4200);
  const bogus = makeCtx({ replies: [{ text: '好', usage: usage(10, 0) }] });
  bogus.messages = [{ role: 'user', content: '字'.repeat(4000) }];
  await runTurn(bogus, '接着');
  assert.equal(bogus.actual, null, '估 4000 多、报 10：这个数不能信');
  // 实际值顶到了八成：估算还差得远，照样压
  const tight = makeCtx({ window: 20_000, replies: [{ ...call('list_files', { path: '.' }), usage: usage(16_500, 0) }, { text: '## 目标\n摘要' }, { text: '好了，要问你？' }] });
  for (let i = 0; i < 6; i++) tight.messages.push({ role: 'user', content: `第 ${i} 件事` }, { role: 'assistant', content: '说'.repeat(1300) });
  await runTurn(tight, '接着');
  assert.equal(tight.api.requests.filter((r) => !r.tools.length).length, 1, `估算只有一万出头，供应商报的是 16500（工具表等没估到）：该压了\n${tight.ui.text()}`);
});

test('服务器替我们裁过：下一轮开头自己压缩，不再照原样发', async () => {
  const ctx = makeCtx({ window: 20_000, replies: [call('list_files', { path: '.' }), { text: '## 目标\n摘要' }, { text: '好了，要问你？' }] });
  for (let i = 0; i < 6; i++) ctx.messages.push({ role: 'user', content: `第 ${i} 件事` }, { role: 'assistant', content: '说'.repeat(1300) });
  const real = ctx.api.stream.bind(ctx.api);
  let n = 0;
  // 第一次干活的请求（带工具表的）才说裁过：开头那一问「是不是换了一件事」不算
  ctx.api.stream = (p, body, on) => real(p, body, (name, data) => on(name, name === 'start' && body.tools.length && ++n === 1 ? { ...data, droppedMessages: 4, contextWindow: 20_000, estimatedPromptTokens: 9_000 } : data));
  const r = await runTurn(ctx, '接着');
  assert.equal(ctx.api.requests.filter((x) => !x.tools.length).length, 1, '离八成还远，但服务器说它裁过：这边估少了，马上压');
  assert.equal(r.compactions, 1);
  assert.match(ctx.messages[0].content, /之前对话的摘要/);
  assert.equal(ctx.serverBudget, 9_000, '服务器那边放得下多少记下来：以后到它之前就自己压（它的线比这边的八成低）');
  // 之后：估算到了服务器那条线的九成五就压，不等八成
  const later = makeCtx({ window: 20_000, replies: [{ text: '## 目标\n摘要' }, { text: '好了，要问你？' }] });
  later.serverBudget = 9_000;
  for (let i = 0; i < 7; i++) later.messages.push({ role: 'user', content: `第 ${i} 件事` }, { role: 'assistant', content: '说'.repeat(1300) });
  await runTurn(later, '接着');
  assert.equal(later.api.requests.filter((x) => !x.tools.length).length, 1, '九千多：没到八成（一万六），但已经过了服务器放得下的量');
});

test('系统提示里的档位和日期开工时定下：之后变了追加一条说明，系统提示一个字都不改', async () => {
  const ctx = makeCtx({ mode: 'plan', replies: [call('list_files', { path: '.' }), call('list_files', { path: '.', depth: 2 }), { text: '好了，要问你？' }] });
  const before = systemText(ctx);
  assert.match(before, /当前档位：plan/);
  // 第一次调模型之后档位变了（计划被批准 / 用户 /mode）
  const real = ctx.api.stream.bind(ctx.api);
  let n = 0;
  ctx.api.stream = async (...a) => { if (++n === 2) setMode(ctx, 'auto'); return real(...a); };
  await runTurn(ctx, '看看');
  const systems = ctx.api.requests.map((r) => r.messages[0].content);
  assert.ok(systems.every((s) => s === before), '档位变了，系统提示却跟着变了：后面的缓存全部重来');
  const said = ctx.messages.filter((m) => m.role === 'user' && /^（档位变了/.test(String(m.content)));
  assert.equal(said.length, 1);
  assert.match(said[0].content, /以这一条为准：现在是 auto（全自动）/);
  assert.equal(generatedOrigin(said[0].content), 'system');
  assert.ok(JSON.stringify(ctx.api.requests.at(-1).messages).includes('档位变了'), '下一次请求里要带上');
  // 过了零点
  ctx.envFrozen.saidToday = '2000-01-01';
  assert.equal(announceEnvChange(ctx), true);
  assert.match(ctx.messages.at(-1).content, /^（日期变了：现在是 \d{4}-\d\d-\d\d）$/);
  assert.equal(announceEnvChange(ctx), false, '说过一次就不再说');
  assert.equal(systemText(ctx), before);
  // 换了会话：重新定
  ctx.session = ctx.store.create();
  assert.match(systemText(ctx), /当前档位：auto/);
  // 子 agent 各定各的（探索型是只读的）
  assert.match(systemText({ ...ctx, mode: 'plan', subagent: { id: 'a1', role: 'explorer' } }), /当前档位：plan/);
});

test('压缩之后：用户的原话跟着状态卡回到历史里，不再置顶进系统提示（系统提示不变，最前面那段缓存照样命中）', async () => {
  const ctx = makeCtx({ window: 12_000, replies: [{ text: '## 目标\n摘要' }, call('list_files', { path: '.' }), { text: '好了，要问你？' }] });
  for (let i = 0; i < 8; i++) ctx.messages.push({ role: 'user', content: `第 ${i} 件事` }, { role: 'assistant', content: '说'.repeat(1300) });
  const before = systemText(ctx);
  await runTurn(ctx, '把 login 改掉，但 localhost 的不要动');
  const requests = ctx.api.requests.filter((r) => r.tools.length);
  assert.ok(requests.length >= 2 && ctx.api.requests.some((r) => !r.tools.length), '这个样本要真的压缩过');
  assert.ok(requests.every((r) => r.messages[0].content === before), '压缩之后系统提示变了');
  assert.ok(!before.includes('localhost'));
  assert.ok(ctx.messages.some((m) => /^（对话刚压缩过/.test(String(m.content)) && m.content.includes('把 login 改掉，但 localhost 的不要动')), '原话要在还回去的状态卡里');
  // 原话已经被压掉、只在状态卡里：系统提示里也不放（压缩之后由状态卡带回历史）
  const carded = makeCtx();
  workOf(carded).beginTurn('只在状态卡里的原话');
  carded.request = { text: '只在状态卡里的原话' };
  carded.messages = [{ role: 'user', content: '【之前对话的摘要】x' }];
  assert.ok(!systemText(carded).includes('只在状态卡里的原话'), '原话又置顶进了系统提示：系统提示一变，最前面那段缓存跟着重来');
  // 没有状态卡的（子 agent、更早的会话）：照旧置顶
  const legacy = { ...makeCtx(), subagent: { id: 'a1', role: 'worker' }, request: { text: '老办法置顶的原话' }, messages: [{ role: 'user', content: '【之前对话的摘要】x' }] };
  assert.ok(systemText(legacy).includes('老办法置顶的原话'));
});

// ── 直连 ───────────────────────────────────────────────────────────────

const compacted = [
  { role: 'system', content: '你是 zhiqu' },
  { role: 'user', content: '【之前对话的摘要（已压缩，原文 40 条）】\n#### 第 1 段\n## 目标\n改天空' },
  { role: 'assistant', content: '好的，我已经了解之前的进展，接着做。' },
  { role: 'user', content: '（对话刚压缩过。下面是命令行记着的工作状态……）\n\n## 工作状态' },
  { role: 'assistant', content: '接着改' },
  { role: 'user', content: '继续' },
];

test('断点标在哪（和网关 PromptCacheMarks 同一个规矩）：压缩留下的那一段的结尾；没压缩过没有；它就是最后一条时不重复标', () => {
  assert.equal(cacheBoundary(compacted), 3, '标在还回去的工作状态那条上：它后面才是会变的');
  assert.equal(cacheBoundary(compacted.slice(0, 3)), 1, '只有摘要：标在摘要上');
  assert.equal(cacheBoundary(compacted.slice(0, 4)), -1, '它就是最后一条：那里本来就标');
  assert.equal(cacheBoundary([{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }]), -1);
  const a = markAnthropic({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: '（对话刚压缩过）' }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }, true);
  assert.deepEqual(a.system, [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
  assert.deepEqual(a.messages[0].content[0].cache_control, { type: 'ephemeral' }, '历史里的断点是 5 分钟');
  assert.ok(!a.messages[2].content[0].cache_control && a.messages[2].content[1].cache_control, '最后一条的最后一块');
  assert.equal(JSON.stringify(a).split('cache_control').length - 1, 3);
  assert.equal(JSON.stringify(markAnthropic({ system: 's', messages: [] }, false)).includes('ttl'), false);
  const o = markOpenAi({ messages: compacted }, true);
  assert.equal(JSON.stringify(o).split('cache_control').length - 1, 3);
  assert.equal(typeof compacted[0].content, 'string', '不改传进来的那一份');
});

async function provider(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push(body);
      const out = handler(raw, seen.length);
      res.writeHead(out.status, { 'Content-Type': out.status === 200 ? 'text/event-stream' : 'application/json' });
      res.end(out.body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1/messages`, seen, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
const ANTHROPIC_OK = 'event: message_start\ndata: {"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":7}}}\n\nevent: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"好"}}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n';
const OPENAI_OK = 'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const send = async (model, messages = compacted) => { const ev = []; await model.stream({ messages, tools: [] }, (n, d) => ev.push([n, d])); return ev; };

test('直连 Claude：三处断点、最前一段 1 小时（原来一个都不标）；不认 1 小时的退回 5 分钟并记住；连标记都不认的去掉并记住', async (t) => {
  const ok = await provider(() => ({ status: 200, body: ANTHROPIC_OK }));
  t.after(() => ok.close());
  await send(new DirectModel({ protocol: 'anthropic', url: ok.url, model: 'claude-opus-5-5' }));
  assert.equal(JSON.stringify(ok.seen[0]).split('cache_control').length - 1, 3, JSON.stringify(ok.seen[0]).slice(0, 400));
  assert.equal(ok.seen[0].system[0].cache_control.ttl, '1h');

  const noTtl = await provider((raw) => (raw.includes('"ttl"') ? { status: 400, body: '{"error":{"message":"cache_control.ttl: Extra inputs are not permitted"}}' } : { status: 200, body: ANTHROPIC_OK }));
  t.after(() => noTtl.close());
  const m1 = new DirectModel({ protocol: 'anthropic', url: noTtl.url, model: 'claude-opus-5-5' });
  await send(m1);
  assert.equal(noTtl.seen.length, 2, '带 1 小时被拒，退回 5 分钟再发一次');
  assert.ok(!JSON.stringify(noTtl.seen[1]).includes('ttl') && JSON.stringify(noTtl.seen[1]).includes('cache_control'));
  await send(m1);
  assert.equal(noTtl.seen.length, 3, '记住了：下一次直接带 5 分钟的');

  const noMarks = await provider((raw) => (raw.includes('cache_control') ? { status: 400, body: '{"error":{"message":"messages[0].content must be a string"}}' } : { status: 200, body: OPENAI_OK }));
  t.after(() => noMarks.close());
  const m2 = new DirectModel({ protocol: 'openai', url: noMarks.url, model: 'Claude-relay' });
  const ev = await send(m2);
  assert.equal(noMarks.seen.length, 3, '1 小时、5 分钟、不带');
  assert.ok(ev.some(([n]) => n === 'done'));
  await send(m2);
  assert.equal(noMarks.seen.length, 4, '记住了：不再挨 400');
  assert.ok(!JSON.stringify(noMarks.seen[3]).includes('cache_control'));
});

test('直连：别的原因的 400 去掉标记也不行，照常报错、不记；DeepSeek 这类自动缓存的不标', async (t) => {
  const bad = await provider(() => ({ status: 400, body: '{"error":{"message":"invalid model"}}' }));
  t.after(() => bad.close());
  const m = new DirectModel({ protocol: 'anthropic', url: bad.url, model: 'claude-x' });
  await assert.rejects(send(m), /HTTP 400/);
  assert.equal(bad.seen.length, 3);
  assert.equal(m.cacheMode, 2, '错不在标记：下一次还标');
  const ds = await provider(() => ({ status: 200, body: OPENAI_OK }));
  t.after(() => ds.close());
  await send(new DirectModel({ protocol: 'openai', url: ds.url, model: 'deepseek-flash' }));
  assert.ok(!JSON.stringify(ds.seen[0]).includes('cache_control'));
  assert.equal(typeof ds.seen[0].messages[0].content, 'string', '请求和原来一模一样');
});

// ── 摘要接在原前缀后面（默认关）────────────────────────────────────────

test('摘要接在原来的前缀后面问（开了才这样）：同一份系统提示、工具表、历史，最后加一句；模型没照做就退回老办法', async () => {
  const filled = (replies, on) => {
    const ctx = makeCtx({ window: 12_000, replies });
    ctx.summaryOnPrefix = on;
    for (let i = 0; i < 8; i++) ctx.messages.push({ role: 'user', content: `第 ${i} 件事` }, { role: 'assistant', content: '说'.repeat(1300) });
    return ctx;
  };
  const on = filled([{ text: '## 目标\n接在前缀后面写的摘要' }, { text: '好了，要问你？' }], true);
  const history = on.messages.map((m) => m.content);
  await runTurn(on, '接着');
  const ask = on.api.requests[0];
  assert.equal(ask.messages.at(-1).content, PREFIX_SUMMARY_ASK);
  assert.equal(ask.messages[0].content, on.api.requests[1].messages[0].content, '系统提示要和干活时一模一样');
  assert.deepEqual(ask.messages.slice(1, 1 + history.length).map((m) => m.content), history, '前面的历史原样在：这一段才命中得了缓存');
  assert.deepEqual(ask.tools.map((x) => x.function.name), on.api.requests[1].tools.map((x) => x.function.name), '工具表也要一样');
  assert.equal(ask.reasoning, 'instant');
  assert.match(on.messages[0].content, /接在前缀后面写的摘要/);
  assert.equal(on.api.requests.length, 2, '一次摘要、一次干活');
  // 模型没照做（接着调工具）：那个调用不执行，退回按记录写摘要
  const stubborn = filled([call('list_files', { path: '.' }), { text: '## 目标\n老办法写的摘要' }, { text: '好了，要问你？' }], true);
  await runTurn(stubborn, '接着');
  assert.match(stubborn.messages[0].content, /老办法写的摘要/);
  assert.equal(stubborn.api.requests[1].tools.length, 0, '第二次是老办法：不带工具');
  assert.ok(!stubborn.messages.some((m) => m.role === 'tool'), '摘要时模型调的工具不执行');
  // 默认关：还是老办法
  const off = filled([{ text: '## 目标\n摘要' }, { text: '好了，要问你？' }], undefined);
  await runTurn(off, '接着');
  assert.equal(off.api.requests[0].tools.length, 0);
});
