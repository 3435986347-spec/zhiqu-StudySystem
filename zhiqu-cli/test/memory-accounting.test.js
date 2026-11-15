// 记忆第 1 步（第一百三十七轮，docs/memory-plan.md）：止血。
// 由来：用户 2026-11-15 给的一段真实会话 —— 23 小时、1M 的窗口，压缩了 105 次，每次压完只剩摘要和一张图；
// 11 次摘要是空的；跑到 8.4 小时内存爆掉；会话文件 555MB、/resume 读不回来。样例照那段会话的节奏造（真实记录不进仓库）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import events from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { runTurn } from '../src/agent.js';
import { compactMessages, estimateMessage, IMAGE_TOKENS, needsCompaction, shedLargest, splitRounds, summaryProblem } from '../src/compact.js';
import { openStream, request, sleep } from '../src/http.js';
import { eachLine, SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { CONTEXT_IMAGE_BYTES, forContext } from '../src/tools/preview.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

const shot = (bytes) => ({ role: 'user', content: [
  { type: 'text', text: '（下面的图就是刚才渲染的页面。）' },
  { type: 'image_url', image_url: { url: `data:image/png;base64,${crypto.randomBytes(bytes).toString('base64')}` } },
] });
const round = (i, out = 3000) => [
  { role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: `{"path":"a${i}.js"}` } }] },
  { role: 'tool', tool_call_id: `c${i}`, content: `第 ${i} 步的输出 ${'x'.repeat(out)}` },
];

function makeCtx({ replies = [{ text: '好' }], window = 64_000, root = tmpdir(), effort } = {}) {
  const store = new SessionStore(root);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds: 12, effort,
    local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: window },
  };
}

// ── 记账 ───────────────────────────────────────────────────────────────

test('图按张算，不按 base64 的字数算；和服务器端同一份样例对拍', () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/token-estimate.json', import.meta.url), 'utf8'));
  assert.ok(fx.cases.length >= 5, '样例被删空了');
  for (const c of fx.cases) {
    const m = JSON.parse(JSON.stringify(c.message));
    if (c.imageB64Chars) for (const p of m.content) if (p.type === 'image_url') p.image_url.url += 'A'.repeat(c.imageB64Chars);
    assert.equal(estimateMessage(m), c.tokens, c.name);
  }
  assert.equal(IMAGE_TOKENS, 1200, '和 HarnessContext.IMAGE_TOKENS 同一个数');
  assert.ok(estimateMessage(shot(1024 * 1024)) < 2000, '1MB 的截图原来被估成 39 万 token');
});

test('照真实会话的节奏回放：600 步、每 12 步一张 1MB 的截图，1M 的窗口一次都不用压（原来 48 次）', async () => {
  let messages = [{ role: 'user', content: '把画面做成白天、立体、细节清楚' }];
  let compactions = 0;
  for (let i = 0; i < 600; i++) {
    messages.push(...round(i));
    if (i % 12 === 11) messages.push(shot(1024 * 1024));
    if (needsCompaction('系统提示'.repeat(2000), messages, 1_000_000)) {
      messages = (await compactMessages(messages, 1_000_000, async () => '## 目标\n摘要')).messages;
      compactions++;
    }
  }
  assert.equal(compactions, 0);
});

// ── 压缩 ───────────────────────────────────────────────────────────────

test('长活里只有一句用户的话：压缩留下最近的好几步原文，不是只剩最后那张图', async () => {
  const messages = [{ role: 'user', content: '把画面做成白天的' }];
  for (let i = 0; i < 40; i++) {
    messages.push(...round(i, 1500));
    if (i % 5 === 4) messages.push(shot(2000));
    if (i % 8 === 7) messages.push({ role: 'user', content: '（任务清单里还有 3 项没做完，对话压缩过，再说一遍）\n\n## 任务清单\n- [ ] 改天空' });
  }
  assert.ok(needsCompaction('', messages, 20_000));
  assert.ok(splitRounds(messages).length > 40, '命令行补的 user 消息不算一步的开头，模型的每次回复算');
  let seen = '';
  const r = await compactMessages(messages, 20_000, async (t) => { seen += t; return '## 目标\n把画面做成白天的'; });
  assert.ok(r.summarized > 0);
  const kept = r.messages.filter((m) => m.role === 'tool');
  assert.ok(kept.length >= 4, `压完只留下 ${kept.length} 条工具结果`);
  assert.match(kept.at(-1).content, /第 39 步的输出/);
  // 调用和结果成对
  const ids = new Set(r.messages.flatMap((m) => (m.tool_calls || []).map((c) => c.id)));
  for (const m of kept) assert.ok(ids.has(m.tool_call_id), `${m.tool_call_id} 的调用被压掉了、结果还在`);
  // 留下的从助手的回复开头时，摘要后面不垫那句「好的」（两条助手消息连着）
  for (let i = 1; i < r.messages.length; i++) assert.ok(!(r.messages[i].role === 'assistant' && r.messages[i - 1].role === 'assistant' && !r.messages[i - 1].tool_calls), `第 ${i} 条：两条助手的话连着`);
  // 谁说的分清
  assert.ok(!seen.includes('[object Object]'), '带图的消息在给摘要模型的记录里成了 [object Object]');
  assert.match(seen, /【系统提醒】（下面的图就是刚才渲染的页面。）〔截图〕/);
  assert.match(seen, /【系统提醒】（任务清单里还有 3 项没做完/);
  assert.ok(!/【用户】（任务清单/.test(seen), '命令行补的提醒被标成了【用户】');
  assert.match(seen, /【用户】把画面做成白天的/);
});

test('摘要是空的：重来一次；还是空的就不替换历史，照实说', async () => {
  assert.equal(summaryProblem('## 目标\n改天空'), null);
  for (const bad of ['', '  \n', '（摘要为空）']) assert.ok(summaryProblem(bad), JSON.stringify(bad));
  const messages = [{ role: 'user', content: '改天空' }];
  for (let i = 0; i < 12; i++) messages.push(...round(i, 6000));
  let calls = 0;
  const failed = await compactMessages(messages, 20_000, async () => { calls++; return ''; });
  assert.equal(calls, 2, '空的要重来一次');
  assert.ok(failed.failed);
  assert.equal(failed.summarized, 0);
  assert.equal(failed.messages.length, messages.length, '原文一条都不能少');
  assert.ok(!failed.messages.some((m) => typeof m.content === 'string' && m.content.includes('之前对话的摘要')));
  calls = 0;
  const second = await compactMessages(messages, 20_000, async (_t, o) => { calls++; return o.retry ? '## 目标\n改天空' : ''; });
  assert.equal(calls, 2);
  assert.ok(!second.failed && second.summarized > 0, '第二次写成了就照常压');
});

test('一句话里：空摘要进不了历史；摘要那次调用明说不思考（不跟 /effort max），上限不止 4096', async () => {
  const ctx = makeCtx({ window: 1_000_000, effort: 'max', replies: [{ text: '' }, { text: '' }, { text: '做完了' }] });
  ctx.messages = [{ role: 'user', content: '改天空' }];
  for (let i = 0; i < 400; i++) ctx.messages.push(...round(i, 9000));
  await runTurn(ctx, '接着做');
  const summaryCalls = ctx.api.requests.filter((r) => r.tools.length === 0);
  assert.equal(summaryCalls.length, 2);
  for (const r of summaryCalls) {
    assert.equal(r.reasoning, 'instant', '摘要跟着用户的思考档位走，额度会被想完');
    assert.ok(r.maxTokens >= 8000, `摘要的输出上限只有 ${r.maxTokens}`);
  }
  assert.equal(ctx.api.requests.at(-1).reasoning, 'max', '干活的那次照用户的档位');
  assert.ok(!JSON.stringify(ctx.messages).includes('摘要为空'));
  assert.ok(ctx.messages.length > 800, '摘要没写成，原文要留着');
  assert.match(ctx.ui.text(), /这次摘要没写成/);
  assert.ok(!fs.readFileSync(ctx.store.file(ctx.session.id), 'utf8').includes('摘要为空'));
});

test('压过了还超：把最大的换成占位；连着几轮都在压就停下说明，不原地转', async () => {
  const big = [{ role: 'user', content: '看日志' }, ...round(0, 50_000), ...round(1, 100)];
  const freed = shedLargest(big);
  assert.ok(freed > 10_000);
  assert.match(big[2].content, /已经从上下文里拿掉/);
  assert.equal(big[2].tool_call_id, 'c0', '结构不动');
  assert.equal(shedLargest([{ role: 'user', content: 'x'.repeat(90_000) }, { role: 'assistant', content: 'y'.repeat(90_000) }]), 0, '用户的话、助手的回复不动');

  // 摘要一直写不成、又没有可拿掉的：三轮之后停下
  const calls = (n) => ({ calls: [{ name: 'list_files', args: { path: '.', n } }] });
  const ctx = makeCtx({ window: 8000, replies: [{ text: '' }, { text: '' }, calls(1), { text: '' }, { text: '' }, calls(2), { text: '' }, { text: '' }, calls(3), { text: '不该走到这' }] });
  ctx.messages = [];
  for (let i = 0; i < 30; i++) ctx.messages.push({ role: 'user', content: `要求 ${i}` }, { role: 'assistant', content: '说明'.repeat(300) });
  const r = await runTurn(ctx, '接着做');
  assert.equal(r.stalled, true);
  assert.match(r.finalText, /连着 3 轮都在压缩/);
  assert.ok(ctx.api.requests.length <= 8, `还在一轮一压：发了 ${ctx.api.requests.length} 次请求`);
});

// ── 内存 ───────────────────────────────────────────────────────────────

test('一句话共用一个中断信号：请求完了监听要摘掉（原来每次请求留住整份请求体，8 小时堆满 4GB）', async (t) => {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url === '/hang') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: start\ndata: {}\n\n'); return; }
      res.writeHead(200, { 'content-type': req.url === '/s' ? 'text/event-stream' : 'application/json' });
      res.end(req.url === '/s' ? 'event: done\ndata: {}\n\n' : '{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const listeners = () => events.getEventListeners(controller.signal, 'abort').length;
  for (let i = 0; i < 20; i++) {
    const res = await openStream(`${base}/s`, { body: 'x'.repeat(50_000), signal: controller.signal, headers: {} });
    for await (const _ of res.body) { /* 读完 */ }
    await request(`${base}/j`, { method: 'POST', body: '{}', signal: controller.signal, headers: {} });
    await sleep(1, controller.signal);
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(listeners(), 0, `60 次请求之后信号上还挂着 ${listeners()} 个监听`);
  // 摘监听不能把「中断」摘没了：流还开着时中断，读的那一头要马上出错
  const res = await openStream(`${base}/hang`, { body: '{}', signal: controller.signal, headers: {} });
  const reading = (async () => { for await (const _ of res.body) { /* 等 */ } })();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(listeners(), 1, '流还开着，监听要在');
  controller.abort();
  await assert.rejects(reading);
});

// ── 会话文件 ───────────────────────────────────────────────────────────

test('会话记录：图存成旁边的文件、记录里只留引用，压缩那一行也不带图；读回来图还在', () => {
  const root = tmpdir();
  const store = new SessionStore(root);
  const s = store.create();
  const img = shot(300_000);
  for (let i = 0; i < 10; i++) {
    store.append(s.id, { type: 'message', message: { role: 'user', content: `第 ${i} 句` } });
    store.append(s.id, { type: 'message', message: img, origin: 'system' });
    store.append(s.id, { type: 'compact', messages: [{ role: 'user', content: '【之前对话的摘要】x' }, img] });
  }
  const size = fs.statSync(store.file(s.id)).size;
  assert.ok(size < 50_000, `20 次带图的写入，记录文件 ${size} 字节`);
  assert.ok(!fs.readFileSync(store.file(s.id), 'utf8').includes('base64,'));
  assert.equal(fs.readdirSync(store.blobDir(s.id)).length, 1, '同一张图只存一份');
  const loaded = store.load(s.id);
  assert.deepEqual(loaded.messages.at(-1), img, '读回来和原来一模一样（发给模型的还是 image_url）');
  assert.equal(store.transcript(s.id).filter((e) => e.kind === 'message').length, 20);
  // 图的文件没了：换成一句话，结构不坏
  fs.rmSync(store.blobDir(s.id), { recursive: true });
  const gone = store.load(s.id).messages.at(-1);
  assert.equal(gone.content[1].type, 'text');
  assert.match(gone.content[1].text, /已经不在了/);
});

test('一行一行地读：块的边界切在哪都一样；旧格式（图在行里）照样读得回来', () => {
  const root = tmpdir();
  const file = path.join(root, 'x.jsonl');
  const lines = ['短', 'x'.repeat(5000), '', '中文'.repeat(700), '最后一行没有换行'];
  fs.writeFileSync(file, lines.join('\n'));
  for (const chunk of [1, 7, 64, 4096, 1 << 20]) {
    const got = [];
    eachLine(file, (l) => got.push(l), chunk);
    assert.deepEqual(got, lines, `块大小 ${chunk}`);
  }
  const store = new SessionStore(root);
  const s = store.create();
  const legacy = shot(200_000);
  fs.appendFileSync(store.file(s.id), `${JSON.stringify({ at: 'x', type: 'message', message: { role: 'user', content: '旧的' } })}\n${JSON.stringify({ at: 'x', type: 'message', message: legacy })}\n`);
  assert.deepEqual(store.load(s.id).messages.at(-1), legacy);
  assert.ok(JSON.stringify(store.transcript(s.id)).length < 2000, '给人看的记录不带图的字节');
});

// ── 截图 ───────────────────────────────────────────────────────────────

test('截图进上下文之前压小；压不了的小图原样给，大图照实说', () => {
  const small = { mediaType: 'image/png', base64: Buffer.alloc(1000, 1).toString('base64'), bytes: 1000, width: 10, height: 10 };
  assert.equal(forContext(small, { shrink: () => { throw new Error('小图不该去压'); } }), small);
  const big = { mediaType: 'image/png', base64: Buffer.alloc(3_000_000, 1).toString('base64'), bytes: 3_000_000, width: 1440, height: 810 };
  const tried = [];
  const shrunk = forContext(big, { shrink: (input, output, edge, quality) => { tried.push([edge, quality]); fs.writeFileSync(output, Buffer.alloc(tried.length < 2 ? 900_000 : 200_000, 2)); return output; } });
  assert.equal(shrunk.mediaType, 'image/jpeg');
  assert.equal(shrunk.bytes, 200_000);
  assert.equal(shrunk.originalBytes, 3_000_000);
  assert.ok(shrunk.bytes <= CONTEXT_IMAGE_BYTES);
  assert.equal(tried.length, 2, '第一档还大就再降一档，够小了就停');
  assert.match(forContext(big, { shrink: () => null }).error, /没有能把它压小的工具/);
  const mid = { ...big, bytes: 1_000_000, base64: Buffer.alloc(1_000_000, 1).toString('base64') };
  assert.equal(forContext(mid, { shrink: () => null }), mid, '压不了、但不到 1.5MB：原样给');
});

test('真的压一张（这台机器有 sips / ImageMagick 才跑）：2MB 的噪点 PNG 压到 400KB 以内', (t) => {
  const zlib = require_zlib();
  const w = 900; const h = 700;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  crypto.randomFillSync(raw);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body)); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  assert.ok(png.length > 1_500_000);
  const out = forContext({ mediaType: 'image/png', base64: png.toString('base64'), bytes: png.length, width: w, height: h });
  if (out.error) { t.skip('这台机器没有 sips / ImageMagick'); return; }
  assert.equal(out.mediaType, 'image/jpeg');
  assert.ok(out.bytes <= CONTEXT_IMAGE_BYTES, `压完还有 ${out.bytes} 字节`);
  assert.deepEqual([...Buffer.from(out.base64, 'base64').subarray(0, 2)], [0xff, 0xd8], '不是 JPEG');
});

import { createRequire } from 'node:module';
function require_zlib() { return createRequire(import.meta.url)('node:zlib'); }
