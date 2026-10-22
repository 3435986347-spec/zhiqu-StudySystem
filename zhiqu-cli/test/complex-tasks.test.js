// 复杂的活、很长的输入（用户 2026-09-27：「提高处理复杂任务的能力和长上下文输入时的分析和工作能力」
// 「叫它干一个活不要一直偏离然后一直修正」）。
//   - 任务清单：先列步骤再做，清单置顶在系统提示里（压缩之后也在），没做完就收尾会被推一次；
//   - 用户这次的原话：对话压缩掉了原文之后，原话仍然置顶 —— 摘要是转述，约束条件在转述里最容易走样；
//   - 很长的输入：超过窗口一定比例就存成文件、让模型分段读，而不是一整块塞进去被服务器裁掉或被供应商拒绝；
//   - 压缩：记录太长时分块滚动摘要（原来从中间砍掉一段，那段里做的决定就没了），用户说过的原话逐字保留。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runTurn, systemText, toolset } from '../src/agent.js';
import { compactMessages } from '../src/compact.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

function makeCtx({ mode = 'auto', replies = [{ text: '好' }], window = 64_000, root = tmpdir() } = {}) {
  const store = new SessionStore(root);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode, maxRounds: 12,
    local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: window },
  };
}
const TODOS = (...items) => ({ name: 'update_todos', args: { todos: items.map(([content, status]) => ({ content, status })) } });
const systemOf = (req) => req.messages[0].content;

// ── 任务清单 ───────────────────────────────────────────────────────────

test('任务清单工具三档都有（plan 档列计划正用得上）', () => {
  for (const mode of ['plan', 'ask', 'auto']) {
    assert.ok(toolset(makeCtx({ mode })).some((t) => t.schema.function.name === 'update_todos'), mode);
  }
});

test('列了清单：终端里显示出来，下一次调模型时置顶在系统提示里，记进会话（/resume 能恢复）', async () => {
  const ctx = makeCtx({ replies: [
    { calls: [TODOS(['读懂登录流程', 'completed'], ['给登录加限流', 'in_progress'], ['跑 auth 测试', 'pending'])] },
    { text: '都做完了？' }] });
  await runTurn(ctx, '给登录加限流');
  assert.match(ctx.ui.text(), /任务清单 1\/3/);
  assert.match(ctx.ui.text(), /☑ 读懂登录流程/);
  assert.match(ctx.ui.text(), /◐ 给登录加限流/);
  const sys = systemOf(ctx.api.requests[1]);
  assert.match(sys, /## 任务清单/);
  assert.match(sys, /\[ \] 跑 auth 测试/);
  assert.match(sys, /\[~\] 给登录加限流/);
  const loaded = ctx.store.load(ctx.session.id);
  assert.deepEqual(loaded.todos.map((t) => t.status), ['completed', 'in_progress', 'pending']);
});

test('清单没做完就收尾：推一次（说清还剩哪几项）；推过一次还收尾就停，不死循环', async () => {
  const ctx = makeCtx({ replies: [
    { calls: [TODOS(['改接口', 'completed'], ['改前端', 'pending'], ['跑测试', 'pending'])] },
    { text: '接口改好了。' },
    { text: '前端还没动，因为缺设计稿。' },
    { text: '不该调到这里' }] });
  const r = await runTurn(ctx, '把改名做完');
  assert.equal(ctx.api.requests.length, 3, '应当推一次、且只推一次');
  const nudge = ctx.messages.filter((m) => m.role === 'user').at(-1).content;
  assert.match(nudge, /还有 2 项没做完/);
  assert.match(nudge, /改前端/);
  assert.equal(r.finalText, '前端还没动，因为缺设计稿。');
});

test('不推：在问用户问题（问号结尾）、plan 档、清单全做完了', async () => {
  const ask = makeCtx({ replies: [{ calls: [TODOS(['a', 'pending'])] }, { text: '用哪个数据库？' }] });
  await runTurn(ask, '做');
  assert.equal(ask.api.requests.length, 2);
  const plan = makeCtx({ mode: 'plan', replies: [{ calls: [TODOS(['a', 'pending'])] }, { text: '计划如上' }] });
  await runTurn(plan, '想想');
  assert.equal(plan.api.requests.length, 2);
  const done = makeCtx({ replies: [{ calls: [TODOS(['a', 'completed'])] }, { text: '做完了' }] });
  await runTurn(done, '做');
  assert.equal(done.api.requests.length, 2);
  assert.ok(!/## 任务清单/.test(systemOf(done.api.requests[1])), '全做完了就不用再占系统提示');
});

test('清单参数不对：说清哪里不对，不改原来的清单', async () => {
  const ctx = makeCtx({ replies: [
    { calls: [TODOS(['a', 'pending'])] },
    { calls: [{ name: 'update_todos', args: { todos: [{ content: 'b', status: 'doing' }] } }] },
    { text: '好？' }] });
  await runTurn(ctx, '做');
  const reply = ctx.messages.filter((m) => m.role === 'tool').at(-1).content;
  assert.match(reply, /status.*pending \/ in_progress \/ completed/);
  assert.deepEqual(ctx.todos.map((t) => t.content), ['a']);
});

// ── 用户的原话 ─────────────────────────────────────────────────────────

test('对话压缩掉了用户这次的原话：原话置顶进系统提示；原话还在对话里时不重复放', () => {
  const ctx = makeCtx();
  ctx.request = { text: '把 README 里所有的 http 链接改成 https，但 localhost 的不要动' };
  ctx.messages = [{ role: 'user', content: ctx.request.text }];
  assert.ok(!/用户这次的原话/.test(systemText(ctx)));
  ctx.messages = [{ role: 'user', content: '【之前对话的摘要】把链接改成 https' }, { role: 'assistant', content: '好的' }];
  const sys = systemText(ctx);
  assert.match(sys, /## 用户这次的原话/);
  assert.ok(sys.includes('但 localhost 的不要动'), '转述里丢掉的约束条件，原话里还在');
});

// ── 很长的输入 ─────────────────────────────────────────────────────────

test('很长的输入（超过窗口的 30%）：原文存成文件，消息里给开头、结尾和路径，模型用 read_file 分段读', async () => {
  const root = tmpdir();
  const lines = Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 行日志：服务启动失败的详细信息`);
  const text = `帮我分析这段日志：\n${lines.join('\n')}\n重点看最后几行`;
  const ctx = makeCtx({ root, window: 8000, replies: [{ text: '好' }] });
  await runTurn(ctx, text);
  const sent = ctx.messages[0].content;
  const m = /\.zhiqu\/inputs\/[\w.-]+\.txt/.exec(sent);
  assert.ok(m, sent.slice(0, 300));
  assert.equal(fs.readFileSync(path.join(root, m[0]), 'utf8'), text);
  assert.ok(sent.includes('帮我分析这段日志'), '开头要在');
  assert.ok(sent.includes('重点看最后几行'), '结尾要在（要求常写在最后）');
  assert.ok(sent.length < 8000 * 0.3, `塞进去的还有 ${sent.length} 字`);
  assert.match(sent, /read_file/);
  const read = ctx.local.readFile({ path: m[0], offset: 200, limit: 5 });
  assert.ok(!read.error, read.error);
  assert.match(read.content, /第 199 行日志/);
  assert.match(ctx.ui.text(), /这条消息很长/);
});

test('不长的输入原样发；超长输入超过单个文件上限时分成几份', async () => {
  const short = makeCtx({ window: 8000 });
  await runTurn(short, '一句普通的话');
  assert.equal(short.messages[0].content, '一句普通的话');

  const root = tmpdir();
  const huge = Array.from({ length: 12000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');   // 约 60 万字节
  const ctx = makeCtx({ root, window: 64_000 });
  await runTurn(ctx, huge);
  const files = [...ctx.messages[0].content.matchAll(/\.zhiqu\/inputs\/[\w.-]+\.txt/g)].map((x) => x[0]);
  assert.ok(files.length >= 3, `分成了 ${files.length} 份`);
  assert.equal(files.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join(''), huge);
  for (const f of files) assert.ok(!ctx.local.readFile({ path: f }).error, `${f} 读不了`);
});

// ── 压缩 ──────────────────────────────────────────────────────────────

function longHistory(turns, perTurn) {
  const msgs = [];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'user', content: `要求 ${i}：第 ${i} 件事要注意的约束` });
    msgs.push({ role: 'assistant', content: `第 ${i} 轮的回答：${'说明'.repeat(perTurn)}` });
  }
  msgs.push({ role: 'user', content: '最后一句' });
  return msgs;
}

test('压缩：记录太长时分块滚动摘要，中间一段都不丢（原来从中间砍掉一段再摘要）', async () => {
  const msgs = longHistory(40, 400);
  const inputs = [];
  const r = await compactMessages(msgs, 8000, async (t) => { inputs.push(t); return `摘要到第 ${inputs.length} 块`; });
  assert.ok(inputs.length >= 2, `只摘要了 ${inputs.length} 次`);
  for (const t of inputs) assert.ok(!/中间 \d+ 字略去/.test(t));
  const kept = r.messages.slice(2).map((m) => m.content).join('\n');
  assert.ok(r.summarized > 60, `只压了 ${r.summarized} 条`);
  // 每一条要求要么进了摘要的输入，要么在原样保留的最近几轮里
  for (let i = 0; i < 40; i++) assert.ok(inputs.some((t) => t.includes(`要求 ${i}：`)) || kept.includes(`要求 ${i}：`), `要求 ${i} 两边都没有`);
  assert.match(inputs[1], /【到目前为止的摘要】\n摘要到第 1 块/);
  assert.match(r.messages[0].content, new RegExp(`摘要到第 ${inputs.length} 块`));
});

test('压缩：用户说过的原话逐字留在摘要消息里；再压一次也还在', async () => {
  const msgs = longHistory(6, 300);
  const r = await compactMessages(msgs, 8000, async () => '摘要');
  const head = r.messages[0].content;
  assert.match(head, /【用户说过的原话/);
  const keptTexts = r.messages.slice(2).map((m) => m.content);
  assert.ok(r.summarized >= 4, `只压了 ${r.summarized} 条`);
  for (let i = 0; i < 6; i++) {
    const said = `要求 ${i}：第 ${i} 件事要注意的约束`;
    assert.ok(head.includes(said) || keptTexts.includes(said), `要求 ${i} 没留下`);
  }
  assert.ok(head.includes('要求 0：第 0 件事要注意的约束'), '被压掉的那几轮，原话要逐字留在摘要消息里');
  const more = [...r.messages];
  for (let i = 6; i < 12; i++) more.push({ role: 'user', content: `要求 ${i}：新的约束` }, { role: 'assistant', content: '说明'.repeat(600) });
  more.push({ role: 'user', content: '再来' });
  const again = await compactMessages(more, 8000, async () => '第二次摘要');
  const head2 = again.messages[0].content;
  assert.ok(head2.includes('要求 0：第 0 件事要注意的约束'), '第一次压缩留下的原话，第二次压缩时丢了');
  assert.ok(head2.includes('要求 6：新的约束'), '第二次压缩掉的那几轮，原话也要留下');
  assert.ok(again.messages.slice(2).some((m) => m.content === '要求 11：新的约束'), '最近几轮原样保留');
});

test('小窗口模型压缩时，摘要的输出上限跟着窗口缩（窗口 8000 写 4096 token 的摘要，压完比压之前还挤）', async () => {
  const ctx = makeCtx({ window: 8000, replies: [{ text: '摘要' }, { text: '好' }] });
  ctx.messages = longHistory(8, 800).slice(0, -1);
  await runTurn(ctx, '接着做');
  const summaryCall = ctx.api.requests.find((r) => r.tools.length === 0);
  assert.ok(summaryCall, '应当先压缩');
  assert.ok(summaryCall.maxTokens <= 8000 * 0.12, `摘要上限 ${summaryCall.maxTokens}`);
});

test('原话有预算：每条太长只留头尾，太多就丢最早的并说出来（不悄悄少几条）', async () => {
  const { userQuotes } = await import('../src/compact.js');
  const msgs = [];
  for (let i = 0; i < 30; i++) msgs.push({ role: 'user', content: `第 ${i} 条：${'要'.repeat(3000)}结尾${i}` }, { role: 'assistant', content: '好' });
  msgs.push({ role: 'user', content: '（任务清单里还有 2 项没做完：…）' });
  const q = userQuotes(msgs, 64_000);
  assert.match(q, /（更早的 \d+ 条原话略去）/);
  assert.ok(q.includes('结尾29'), '最近的一条要在，而且结尾不能被截掉');
  assert.ok(!q.includes('第 0 条'), '超预算时先丢最早的');
  assert.ok(!q.includes('任务清单里还有'), '命令行自己补的话不算用户的原话');
  for (const block of q.split(/^—— \d+ ——$/m).slice(1)) assert.ok(block.length < 1600, `一条留了 ${block.length} 字`);
});
