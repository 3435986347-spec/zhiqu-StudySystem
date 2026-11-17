// 干活中途补充（第一百五十轮，docs/steer-plan.md 第 1 步）：一轮一个收件箱，循环在缝上把用户中途说的话倒进上下文。
// 缝 A：一批工具全部回完、下一次问模型之前；缝 B：模型要收尾时箱子里有话 —— 不收尾、带着它接着做。
// 收尾关箱，没取走的交回（被停下、最后一刻才到、最后一轮）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runTurn } from '../src/agent.js';
import { userQuotes } from '../src/compact.js';
import { toAnthropicMessages } from '../src/direct.js';
import { replayTranscript } from '../src/replay.js';
import { SessionStore } from '../src/session.js';
import { Inbox, STEER_CHARS, STEER_LEAD, steerMessage } from '../src/steer.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

/** hooks[n]：第 n 次（从 0 数）模型调用进行中做的事 —— 「模型正在想的时候用户说了一句」 */
function makeCtx({ replies, hooks = {}, root = tmpdir(), maxRounds = 40 } = {}) {
  const store = new SessionStore(root);
  const api = fakeApi(replies);
  const stream = api.stream.bind(api);
  const ctx = {
    ui: fakeUi([]), api, root, mode: 'auto', maxRounds,
    local: new LocalTools({ root, commands: ['node'] }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 64_000 },
  };
  api.stream = async (...args) => {
    const n = api.requests.length;
    if (hooks[n]) hooks[n](ctx);
    return stream(...args);
  };
  return ctx;
}
const read = (p) => ({ calls: [{ name: 'read_file', args: { path: p } }] });
const steersIn = (messages) => messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(STEER_LEAD));

test('工具跑着的时候补一句：下一次问模型时就在上下文里，排在整批工具结果之后（不插在两个结果中间）', async () => {
  const root = tmpdir();
  write(root, 'a.txt', 'A');
  write(root, 'b.txt', 'B');
  const two = { calls: [{ name: 'read_file', args: { path: 'a.txt' } }, { name: 'read_file', args: { path: 'b.txt' } }] };
  const ctx = makeCtx({ root, replies: [two, { text: '好了' }], hooks: { 0: (c) => assert.equal(c.inbox.push('只看 a.txt 就够了'), true) } });
  const r = await runTurn(ctx, '看看这两个文件');
  assert.equal(ctx.api.requests.length, 2);
  const sent = ctx.api.requests[1].messages;
  const roles = sent.slice(-4).map((m) => m.role);
  assert.deepEqual(roles, ['assistant', 'tool', 'tool', 'user'], `补充要在整批结果之后：${roles}`);
  assert.ok(sent.at(-1).content.startsWith(STEER_LEAD) && sent.at(-1).content.includes('只看 a.txt 就够了'));
  assert.equal(steersIn(ctx.api.requests[0].messages).length, 0, '第一次调用时还没说');
  assert.equal(r.finalText, '好了');
  assert.deepEqual(r.leftover, []);
  assert.equal(steersIn(ctx.messages).length, 1, '只倒一次');
});

test('模型正要收尾时补了一句：不收尾，带着补充接着做；最后说的那句才是结论', async () => {
  const ctx = makeCtx({ replies: [{ text: '做完了：用了方案 A' }, { text: '改成方案 B 了' }], hooks: { 0: (c) => c.inbox.push('别用方案 A，用 B') } });
  const r = await runTurn(ctx, '做一下');
  assert.equal(ctx.api.requests.length, 2, '箱子里有话就不该收尾');
  const sent = ctx.api.requests[1].messages;
  assert.equal(sent.at(-2).role, 'assistant');
  assert.equal(sent.at(-2).content, '做完了：用了方案 A', '那句阶段性的回答留在历史里');
  assert.match(sent.at(-1).content, /别用方案 A，用 B/);
  assert.equal(r.finalText, '改成方案 B 了');
});

test('最后一轮补的、被停下时还没倒的：交回 leftover，一个字不丢、也不进上下文', async () => {
  const last = makeCtx({ maxRounds: 1, replies: [{ text: '收尾' }], hooks: { 0: (c) => c.inbox.push('再加个测试') } });
  const r = await runTurn(last, '做');
  assert.equal(last.api.requests.length, 1);
  assert.deepEqual(r.leftover, ['再加个测试']);
  assert.equal(steersIn(last.messages).length, 0);

  const controller = new AbortController();
  const root = tmpdir();
  write(root, 'a.txt', 'A');
  const stopped = makeCtx({ root, replies: [read('a.txt'), { text: '不该问到这里' }], hooks: { 0: (c) => { c.inbox.push('换个文件'); controller.abort(); } } });
  const r2 = await runTurn(stopped, '读', { signal: controller.signal });
  assert.deepEqual(r2.leftover, ['换个文件']);
  assert.equal(steersIn(stopped.messages).length, 0);
});

test('收尾之后再放：返回 false（入口把它变成下一句）；下一句有自己的新箱子', async () => {
  const ctx = makeCtx({ replies: [{ text: '好' }] });
  await runTurn(ctx, '做');
  const old = ctx.inbox;
  assert.equal(old.push('晚了'), false);
  await runTurn(ctx, '再做');
  assert.notEqual(ctx.inbox, old);
});

test('补了话就重新数重复：同一个调用连着发，补充之后不算原地打转', async () => {
  const root = tmpdir();
  write(root, 'a.txt', 'A');
  // 不补的话第 5 次不执行、第 7 次停下（repeat-call.test.js）；第 4 次调用时补一句，重新数，7 次都执行、最后正常收尾
  const ctx = makeCtx({ root, replies: [...Array(7).fill(read('a.txt')), { text: '读完了' }], hooks: { 3: (c) => c.inbox.push('再读一遍确认一下') } });
  const r = await runTurn(ctx, '读');
  const tools = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.equal(tools.length, 7);
  assert.ok(!tools.some((t) => /^没有执行/.test(t)), tools.join('\n---\n'));
  assert.equal(r.finalText, '读完了');
  assert.equal(r.stalled, false);
});

test('第 7 次重复（本该停下）的那一批里补了话：不停，带着补充再问一次', async () => {
  const root = tmpdir();
  write(root, 'a.txt', 'A');
  const ctx = makeCtx({ root, replies: [...Array(7).fill(read('a.txt')), { text: '照你说的改了做法' }], hooks: { 6: (c) => c.inbox.push('别再读了，直接改') } });
  const r = await runTurn(ctx, '读');
  assert.equal(r.stalled, false, '用户刚说了话，不能停下');
  assert.equal(ctx.api.requests.length, 8);
  assert.match(ctx.api.requests[7].messages.at(-1).content, /别再读了/);
  assert.equal(r.finalText, '照你说的改了做法');
});

test('状态卡和会话记录都记着；回放显示成「↳ 补充」而不是新的一句；压缩时算用户的原话', async () => {
  const root = tmpdir();
  const ctx = makeCtx({ root, replies: [{ text: 'A' }, { text: 'B' }], hooks: { 0: (c) => c.inbox.push('标题别动') } });
  await runTurn(ctx, '改一下文档');
  const card = ctx.work.card();
  assert.match(card, /1\. 改一下文档/);
  assert.match(card, /2\. （干活中途补充）标题别动/);
  const lines = fs.readFileSync(ctx.store.file(ctx.session.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.type === 'steer' && e.text === '标题别动'));
  assert.ok(lines.some((e) => e.type === 'message' && e.origin === 'steer'));
  const loaded = ctx.store.load(ctx.session.id);
  assert.deepEqual(loaded.said, ['改一下文档'], '补充不是新的一句（和应用对账时不拿它配对）');
  const ui = fakeUi([]);
  const users = replayTranscript(ui, ctx.store.transcript(ctx.session.id));
  assert.equal(users, 1);
  assert.match(ui.text(), /↳ 补充：标题别动/);
  assert.doesNotMatch(ui.text(), /› （用户在你干活/);
  const quotes = userQuotes(ctx.messages, 64_000);
  assert.match(quotes, /（干活中途补充）标题别动/);
  assert.doesNotMatch(quotes, /用户在你干活的过程中/, '原话里不带给模型看的那句开头');
});

test('子 agent 不倒父亲的箱子（它的 ctx 是浅拷贝来的，看得见 ctx.inbox）', async () => {
  const parent = new Inbox();
  parent.push('给主 agent 的');
  const ctx = makeCtx({ replies: [{ text: '子 agent 的结论' }] });
  Object.assign(ctx, { subagent: { id: 's1', role: 'explorer' }, inbox: parent, store: null, session: { id: 'sub' } });
  const r = await runTurn(ctx, '查一下');
  assert.equal(parent.size(), 1, '还在父亲的箱子里');
  assert.equal(steersIn(ctx.messages).length, 0);
  assert.equal(r.finalText, '子 agent 的结论');
});

test('几句一起到合成一条；太长截断并说出来', () => {
  const box = new Inbox();
  assert.equal(box.push('   '), false, '空话不收');
  box.push('第一句');
  box.push('x'.repeat(STEER_CHARS + 10));
  const text = steerMessage(box.take());
  assert.ok(text.startsWith(STEER_LEAD));
  assert.match(text, /第一句\n\nx+\n…（后面的截掉了/);
  assert.equal(box.size(), 0);
  assert.deepEqual(box.close(), []);
  assert.equal(box.push('关了'), false);
});

test('Anthropic：工具结果后面那条补充并进同一条 user，排在结果后面（不连着两条 user）', () => {
  const { messages } = toAnthropicMessages([
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '1' },
    { role: 'tool', tool_call_id: 'c2', content: '2' },
    { role: 'user', content: `${STEER_LEAD}\n\n换个做法` },
  ]);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(messages[2].content.map((b) => b.type), ['tool_result', 'tool_result', 'text']);
  assert.match(messages[2].content[2].text, /换个做法/);
});
