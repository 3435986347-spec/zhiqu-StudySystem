// 长活省钱第 2 步（docs/agent-efficiency-plan.md）：会话记录里清理只记换掉的那几条，真摘要才记全量。
// 原来每清一次存一份整的：用户那段会话 19 份快照约 2000 万字，记录涨到 28MB。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { clearNow, compactNow, recordRewrite } from '../src/agent.js';
import { CLEAR_KEEP_RECENT } from '../src/compact.js';
import { applyEdits, messageKey, SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

function ctxWith(replies = [{ text: '好' }], window = 40_000) {
  const root = tmpdir();
  const store = new SessionStore(root);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds: 10, local: new LocalTools({ root }), store,
    session: store.create(), messages: [], allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 },
    changedFiles: new Set(), system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: window },
  };
}
let seq = 0;
/** 照真实循环那样记：每条消息都写进会话 */
function push(ctx, ...ms) {
  for (const m of ms) { ctx.messages.push(m); ctx.store.append(ctx.session.id, { type: 'message', message: m }); }
}
function toolPair(ctx, name, args, output) {
  const id = `k${++seq}`;
  push(ctx, { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: id, content: output });
}
const events = (ctx) => fs.readFileSync(ctx.store.file(ctx.session.id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const shot = () => ({ role: 'user', content: [{ type: 'text', text: '（下面的图就是刚才渲染的页面。）' }, { type: 'image_url', image_url: { url: IMG } }] });

test('先清记成 clear：只记换掉的那几条，不再存一份整的；接回来和内存里一模一样', () => {
  const ctx = ctxWith();
  push(ctx, { role: 'user', content: '开始' });
  for (let i = 0; i < 6; i++) toolPair(ctx, 'shell', { command: `step ${i}` }, `out ${'o'.repeat(30_000)}`);
  for (let i = 0; i < CLEAR_KEEP_RECENT; i++) toolPair(ctx, 'search', { query: `k${i}` }, 'k'.repeat(900));
  const r = clearNow(ctx, 40_000);
  assert.ok(r.cleared >= 3, `要清掉几段：${r.cleared}`);
  const ev = events(ctx);
  assert.equal(ev.filter((e) => e.type === 'compact').length, 0, '清理不存整份');
  const clear = ev.filter((e) => e.type === 'clear');
  assert.equal(clear.length, 1);
  assert.equal(clear[0].edits.length, r.cleared, '换了几条记几条');
  assert.equal(clear[0].length, ctx.messages.length);
  assert.ok(JSON.stringify(clear[0]).length < 6_000, `clear 这一行要小：${JSON.stringify(clear[0]).length} 字`);
  assert.deepEqual(ctx.store.load(ctx.session.id).messages, ctx.messages, '接回来还是清过的样子');
  assert.ok(!ctx.store.transcript(ctx.session.id).some((e) => e.kind === 'compact'), '只是清理：回放里不说「这里压缩过」');
});

test('真摘要（条数变了）照旧记全量；摘要之后再清又只记那几条', async () => {
  const ctx = ctxWith([{ text: '## 目标\n做长活\n## 当前进展和下一步\n继续' }], 8_000);
  for (let i = 0; i < 10; i++) push(ctx, { role: 'user', content: `第 ${i} 句 ${'字'.repeat(600)}` }, { role: 'assistant', content: `好 ${'答'.repeat(600)}` });
  const r = await compactNow(ctx, undefined, { manual: true });
  assert.ok(r.summarized > 0);
  const full = events(ctx).filter((e) => e.type === 'compact');
  assert.equal(full.length, 1);
  assert.equal(full[0].messages.length, ctx.messages.length);
  assert.deepEqual(ctx.store.load(ctx.session.id).messages, ctx.messages);
  for (let i = 0; i < 4; i++) toolPair(ctx, 'shell', { command: `x${i}` }, 'z'.repeat(30_000));
  for (let i = 0; i < CLEAR_KEEP_RECENT; i++) toolPair(ctx, 'search', { query: `q${i}` }, 'q'.repeat(900));
  clearNow(ctx, 40_000);
  assert.equal(events(ctx).filter((e) => e.type === 'compact').length, 1);
  assert.equal(events(ctx).filter((e) => e.type === 'clear').length, 1);
  assert.deepEqual(ctx.store.load(ctx.session.id).messages, ctx.messages, '全量 + 之后的增量，接回来一样');
});

test('截图清理也是 clear；图在记录里是引用、读回来换回图', () => {
  const ctx = ctxWith();
  push(ctx, { role: 'user', content: '开始' });
  for (let i = 0; i < 10; i++) { toolPair(ctx, 'preview_page', { path: 'a.html' }, '已截图'); push(ctx, shot()); }
  const r = clearNow(ctx, 1_000_000);
  assert.ok(r.images >= 8);
  const clear = events(ctx).filter((e) => e.type === 'clear');
  assert.equal(clear.length, 1);
  assert.ok(!JSON.stringify(clear[0]).includes('base64'), '记录里不放图的字节');
  assert.deepEqual(ctx.store.load(ctx.session.id).messages, ctx.messages);
});

test('内存和记录对不上一条（被打断时去掉了悬空的调用）：按调用 id 认的照样换到对的那条上；按角色认的不换，不换错', () => {
  const store = new SessionStore(tmpdir());
  const s = store.create();
  const a = { role: 'assistant', content: '', tool_calls: [{ id: 'A', type: 'function', function: { name: 'shell', arguments: '{"command":"a"}' } }] };
  const ta = { role: 'tool', tool_call_id: 'A', content: 'x'.repeat(5000) };
  const dangling = { role: 'assistant', content: '', tool_calls: [{ id: 'D', type: 'function', function: { name: 'shell', arguments: '{}' } }] };
  const u = { role: 'user', content: '接着' };
  const img = shot();
  // 记录里多一条悬空的调用；内存里没有它（序号整体错开一位）
  for (const m of [{ role: 'user', content: '开始' }, dangling, u, a, ta, img]) store.append(s.id, { type: 'message', message: m });
  const memory = [{ role: 'user', content: '开始' }, u, a, ta, img];
  const ctx = { store, session: s, messages: memory.slice() };
  ctx.messages[3] = { ...ta, content: '（旧的命令输出已清理）' };
  ctx.messages[4] = { role: 'user', content: '（旧截图已清理）' };
  recordRewrite(ctx, memory);
  const loaded = store.load(s.id).messages;
  assert.equal(loaded.find((m) => m.tool_call_id === 'A').content, '（旧的命令输出已清理）', '按 id 找到了错开一位的那条');
  assert.ok(Array.isArray(loaded.at(-1).content), '条数对不上：按角色认的那条不换（宁可多背，不换错）');
  assert.equal(loaded.filter((m) => m.role === 'user' && m.content === '（旧截图已清理）').length, 0);
});

test('applyEdits：坏的编辑跳过并计数；钥匙对不上不换', () => {
  const ms = [{ role: 'user', content: 'a' }, { role: 'tool', tool_call_id: 'T', content: 'b' }];
  const missed = applyEdits(ms, { length: 2, edits: [null, { i: 0, key: 'r:assistant', message: { role: 'user', content: 'x' } },
    { i: 9, key: 't:NOPE', message: { role: 'tool', tool_call_id: 'NOPE', content: 'y' } }, { i: 1, key: messageKey(ms[1]), message: { role: 'tool', tool_call_id: 'T', content: 'ok' } }] });
  assert.equal(missed, 3);
  assert.equal(ms[0].content, 'a');
  assert.equal(ms[1].content, 'ok');
});

test('长活里清很多次：记录随消息线性长，不再按清理次数翻倍（原来每清一次存一份整的）', () => {
  const ctx = ctxWith();
  push(ctx, { role: 'user', content: '开始' });
  let messageBytes = 0;
  for (let round = 0; round < 30; round++) {
    for (let i = 0; i < 3; i++) {
      const out = `r${round} ${'o'.repeat(20_000)}`;
      messageBytes += out.length;
      toolPair(ctx, 'shell', { command: `r${round}-${i}` }, out);
    }
    for (let i = 0; i < CLEAR_KEEP_RECENT; i++) toolPair(ctx, 'search', { query: `r${round}k${i}` }, 'k'.repeat(900));
    clearNow(ctx, 40_000);
  }
  const ev = events(ctx);
  assert.ok(ev.filter((e) => e.type === 'clear').length >= 10, '清了很多次');
  const size = fs.statSync(ctx.store.file(ctx.session.id)).size;
  assert.ok(size < messageBytes * 1.5, `记录 ${size} 字节，消息本身 ${messageBytes}：清理记录只占零头`);
  assert.deepEqual(ctx.store.load(ctx.session.id).messages, ctx.messages);
});

test('条数对不上、错开一位的那条角色又正好一样（两张截图挨着）：不换 —— 不能把前一张当成后一张清掉', () => {
  const store = new SessionStore(tmpdir());
  const s = store.create();
  const dangling = { role: 'assistant', content: '', tool_calls: [{ id: 'D', type: 'function', function: { name: 'shell', arguments: '{}' } }] };
  const imgA = { role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'image_url', image_url: { url: IMG } }] };
  const imgB = { role: 'user', content: [{ type: 'text', text: 'B' }, { type: 'image_url', image_url: { url: IMG } }] };
  for (const m of [{ role: 'user', content: '开始' }, dangling, imgA, imgB]) store.append(s.id, { type: 'message', message: m });
  const memory = [{ role: 'user', content: '开始' }, imgA, imgB];
  const ctx = { store, session: s, messages: memory.slice() };
  ctx.messages[2] = { role: 'user', content: '（旧截图已清理）' };   // 清的是 B；记录里序号 2 是 A
  recordRewrite(ctx, memory);
  const loaded = store.load(s.id).messages;
  const shots = loaded.filter((m) => Array.isArray(m.content)).map((m) => m.content[0].text);
  assert.deepEqual(shots, ['A', 'B'], '宁可两张都留着，不能把 A 换掉');
  assert.ok(!loaded.some((m) => m.content === '（旧截图已清理）'));
});

test('换上去的那条里带图：记录里是引用，读回来换回图', () => {
  const store = new SessionStore(tmpdir());
  const s = store.create();
  const old = { role: 'user', content: 'x' };
  store.append(s.id, { type: 'message', message: old });
  const ctx = { store, session: s, messages: [shot()] };
  recordRewrite(ctx, [old]);
  assert.ok(!fs.readFileSync(store.file(s.id), 'utf8').includes('base64,'), '图的字节不进记录');
  assert.equal(store.load(s.id).messages[0].content[1].image_url.url, IMG);
});
