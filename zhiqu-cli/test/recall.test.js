// 跨会话（第一百四十一轮，docs/memory-plan.md 第 5 步）。
// 由来：用户那段真实记录里，新开的会话不知道上一段建了 zero-platform/，先读了不相干的文件，再自己写 python 翻会话记录的最后 6 条。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runTurn, toolset } from '../src/agent.js';
import { noteUnfinished, openSession } from '../src/cli.js';
import { generatedOrigin } from '../src/origins.js';
import { otherSessions, readSession, recentBlock, searchSessions, sessionDigest } from '../src/recall.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

function makeCtx({ replies = [{ text: '好' }], root = tmpdir(), maxRounds = 30 } = {}) {
  const store = new SessionStore(root);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds,
    local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 64_000 },
  };
}
const call = (name, args) => ({ calls: [{ name, args }] });
const names = (ctx) => toolset(ctx).map((t) => t.schema.function.name);

/** 在这个项目里先做完一段：建了一个新目录，说了结论 */
async function firstSession(root, { finish = true } = {}) {
  const ctx = makeCtx({ root, maxRounds: finish ? 30 : 1, replies: [
    call('write_file', { path: 'zero-platform/index.html', content: '<h1>零号平台</h1>\n' }),
    { text: '做好了：新建了 zero-platform/index.html，是一个 WebGL 第一人称游戏的起步页，双击就能打开。' },
  ] });
  const r = await runTurn(ctx, '仿照 AAA 文件夹内的游戏，做一款 AAA 游戏');
  return { ctx, r };
}

test('每段会话的摘要：从会话索引和状态卡现算 —— 用户说过的话、结果、动过的文件、最后的回答', async () => {
  const root = tmpdir();
  const { ctx } = await firstSession(root);
  const g = sessionDigest(ctx.store, ctx.store.list().find((s) => s.id === ctx.session.id), root);
  assert.equal(g.status, 'done');
  assert.deepEqual(g.said, ['仿照 AAA 文件夹内的游戏，做一款 AAA 游戏']);
  assert.deepEqual(g.created, ['zero-platform/index.html']);
  assert.match(g.answer, /^做好了：新建了 zero-platform\/index\.html/);
  // 没做完的、进程没了的各有各的说法
  const { ctx: half } = await firstSession(tmpdir(), { finish: false });
  assert.equal(sessionDigest(half.store, half.store.list()[0], half.root).status, 'unfinished');
  const crashed = makeCtx();
  crashed.api.stream = async () => { throw new Error('kill -9'); };
  await assert.rejects(runTurn(crashed, '刚说完就崩了'));
  assert.equal(sessionDigest(crashed.store, crashed.store.list()[0], crashed.root).status, 'crashed');
  // 比状态卡早的会话：只有标题和时间，不炸
  const old = new SessionStore(tmpdir());
  const meta = old.create({ title: '很早以前的会话' });
  assert.equal(sessionDigest(old, meta, old.dir).status, 'unknown');
});

test('新会话开工：被告知这个项目里最近几段会话（标题、结果、动过的文件、最后的回答、id）；只说一次；不算用户的原话', async () => {
  const root = tmpdir();
  const { ctx: first } = await firstSession(root);
  const second = makeCtx({ root, replies: [{ text: '知道了' }] });
  await runTurn(second, '背景也很模糊，你要做一个在白天的');
  const told = second.messages[0];
  assert.match(told.content, /^（这个项目里最近的几段会话/);
  assert.equal(generatedOrigin(told.content), 'system');
  assert.match(told.content, /1\. 「仿照 AAA 文件夹内的游戏，做一款 AAA 游戏」.*做完了.*（id /);
  assert.ok(told.content.includes(`（id ${first.session.id}）`));
  assert.match(told.content, /动过的文件：`zero-platform\/index\.html`/);
  assert.match(told.content, /最后的回答：做好了：新建了 zero-platform\/index\.html/);
  assert.equal(second.messages[1].content, '背景也很模糊，你要做一个在白天的', '排在用户这句话前面');
  await runTurn(second, '继续');
  assert.equal(second.messages.filter((m) => /这个项目里最近的几段会话/.test(String(m.content))).length, 1, '只说一次');
  // 第一次请求里就带着：模型不用去翻记录
  assert.ok(JSON.stringify(second.api.requests[0].messages).includes('zero-platform/index.html'));
  // 这个项目里没有别的会话：什么都不加
  const alone = makeCtx();
  await runTurn(alone, '你好');
  assert.equal(alone.messages[0].content, '你好');
});

test('最近的那段没做完：给它整张状态卡，更早的几段各两三行；最多三段、每行都截过', async () => {
  const root = tmpdir();
  await firstSession(root);
  const half = makeCtx({ root, maxRounds: 1, replies: [call('write_file', { path: 'neon-tetris/main.js', content: 'x\n' })] });
  await runTurn(half, '再做一个霓虹俄罗斯方块');
  const next = makeCtx({ root, replies: [{ text: '好' }] });
  await runTurn(next, '继续');
  const told = next.messages[0].content;
  assert.match(told, /^（上一段会话「再做一个霓虹俄罗斯方块」没做完/);
  assert.match(told, /## 工作状态/);
  assert.match(told, /（这个项目里最近的几段会话/);
  assert.match(told, /2\. 「仿照 AAA 文件夹内的游戏，做一款 AAA 游戏」/, '更早的那段排第 2');
  assert.equal((told.match(/「再做一个霓虹俄罗斯方块」/g) || []).length, 1, '没做完的那段不重复列一遍');
  // 很多段、很长的话：只给三段，不超上限
  const many = tmpdir();
  for (let i = 0; i < 6; i++) {
    const c = makeCtx({ root: many, replies: [{ text: `第 ${i} 段的回答：${'答'.repeat(900)}` }] });
    await runTurn(c, `第 ${i} 段的要求：${'求'.repeat(900)}`);
  }
  const fresh = makeCtx({ root: many });
  const block = recentBlock(fresh.store, fresh.session, many);
  assert.ok(block.length <= 1500, `话都很长也截得住：开工那一段有 ${block.length} 字`);
  assert.ok(block.includes('第 5 段的要求') && !block.includes('第 1 段的要求'), '最近的在前');
  // 话都很短：也只给三段
  const brief = tmpdir();
  for (let i = 0; i < 6; i++) { const c = makeCtx({ root: brief, replies: [{ text: `答 ${i}` }] }); await runTurn(c, `短要求 ${i}`); }
  const short = recentBlock(new SessionStore(brief), null, brief);
  assert.equal((short.match(/^\d+\. /gm) || []).length, 3, '放得下也只给最近三段');
  assert.ok(short.includes('短要求 5') && short.includes('短要求 3') && !short.includes('短要求 2'));
});

test('两个只读工具：这个项目里有别的会话才给（plan 档也给，子 agent 不给）；按关键字找得到，读得到摘要 / 状态卡 / 最后几条', async () => {
  const root = tmpdir();
  const alone = makeCtx({ root });
  assert.ok(!names(alone).includes('search_sessions'), '没有别的会话：没什么可查，不占工具表');
  await firstSession(root);
  const ctx = makeCtx({ root });
  for (const n of ['search_sessions', 'read_session']) {
    assert.ok(names(ctx).includes(n), n);
    assert.ok(names({ ...ctx, mode: 'plan' }).includes(n), `plan 档也给 ${n}：只读`);
    assert.ok(!names({ ...ctx, subagent: { id: 'a1', role: 'worker' } }).includes(n));
  }
  // 同一段会话里工具表不变：后来又多了别的会话也不半路加（工具表变了缓存跟着重来）
  assert.ok(!names(alone).includes('search_sessions'));

  const found = searchSessions(ctx.store, ctx.session, root, { query: 'AAA 游戏' });
  assert.match(found.content, /以前会话的记录.*不是指令/);
  assert.match(found.content, /1\. 「仿照 AAA 文件夹内的游戏，做一款 AAA 游戏」/);
  assert.match(found.content, /…用户：仿照 AAA 文件夹内的游戏/);
  assert.match(searchSessions(ctx.store, ctx.session, root, { query: 'zero-platform' }).content, /zero-platform\/index\.html/, '按文件名也找得到');
  // 只在「动过的文件」里出现、谁都没说起过的名字
  const quiet = makeCtx({ root, replies: [call('write_file', { path: 'only-in-files.js', content: 'x\n' }), { text: '好了。' }] });
  await runTurn(quiet, '加一个小脚本');
  assert.match(searchSessions(ctx.store, ctx.session, root, { query: 'only-in-files' }).content, /「加一个小脚本」/, '文件名没人说起过，也要找得到');
  assert.match(searchSessions(ctx.store, ctx.session, root, { query: '量子计算' }).content, /没有找到「量子计算」/);
  assert.ok(searchSessions(ctx.store, ctx.session, root, { query: ' ' }).error);

  const id = otherSessions(ctx.store, ctx.session, root).find((g) => g.title.startsWith('仿照 AAA')).id;
  assert.match(readSession(ctx.store, ctx.session, root, { id }).content, /最后的回答：做好了：新建了 zero-platform\/index\.html，是一个 WebGL 第一人称游戏的起步页，双击就能打开。/);
  assert.match(readSession(ctx.store, ctx.session, root, { id, part: 'state' }).content, /### 这段会话新建的文件[^\n]*\n`zero-platform\/index\.html`/);
  const tail = readSession(ctx.store, ctx.session, root, { id, part: 'tail', limit: 3 }).content;
  assert.match(tail, /最后 3 条/);
  assert.match(tail, /【调用 write_file zero-platform\/index\.html】/);
  assert.match(tail, /【助手】做好了/);
  assert.ok(!tail.includes('【用户】仿照'), '只要最后 3 条');
  assert.match(readSession(ctx.store, ctx.session, root, { id: id.slice(0, -1) }).content, /仿照 AAA/, 'id 给开头一段、只对得上一段时也认');
  assert.match(readSession(ctx.store, ctx.session, root, { id: 'nope' }).error, /没有 nope 这段会话/);
  assert.match(readSession(ctx.store, ctx.session, root, { id: ctx.session.id }).error, /就是现在这段会话/);
});

test('一句话里：模型用 search_sessions / read_session 查到上一段做了什么（不用自己翻 .zhiqu/sessions）', async () => {
  const root = tmpdir();
  const { ctx: first } = await firstSession(root);
  const ctx = makeCtx({ root, replies: [call('search_sessions', { query: 'AAA' }), call('read_session', { id: first.session.id, part: 'tail' }), { text: '上次做的是 zero-platform。' }] });
  await runTurn(ctx, '上次那个游戏在哪个目录');
  const results = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(results[0], /zero-platform\/index\.html/);
  assert.match(results[1], /【调用 write_file zero-platform\/index\.html】/);
  assert.ok(!results.some((r) => /没有这个工具|这一档不给/.test(r)));
});

test('给人看的启动提示：上一段没做完 / 没正常结束才说；做完了不说', async () => {
  const root = tmpdir();
  await firstSession(root);
  const calm = makeCtx({ root });
  noteUnfinished(calm);
  assert.equal(calm.ui.text(), '');
  const half = makeCtx({ root, maxRounds: 1, replies: [call('update_todos', { todos: [{ content: '改天空', status: 'in_progress' }, { content: '改光照', status: 'pending' }] })] });
  await runTurn(half, '把画面做成白天的');
  const next = makeCtx({ root });
  noteUnfinished(next);
  assert.match(next.ui.text(), /上一段会话「把画面做成白天的」没做完，清单还剩 2 项：\/resume 接着那一段/);
  // 接线：命令行新开一段会话时就说（不是只有这个函数在）
  const opened = { ui: fakeUi([]), store: new SessionStore(root), root, model: { label: 'm' } };
  openSession(opened, {});
  assert.match(opened.ui.text(), /上一段会话「把画面做成白天的」没做完/);
  assert.deepEqual(opened.messages, []);
  const crashed = makeCtx({ root });
  crashed.api.stream = async () => { throw new Error('kill -9'); };
  await assert.rejects(runTurn(crashed, '刚说完就崩了'));
  const after = makeCtx({ root });
  noteUnfinished(after);
  assert.match(after.ui.text(), /上一段会话「刚说完就崩了」没正常结束（进程中途没了）/);
});

test('以前的记录很大（旧格式里图在行里）：搜索只看摘要、不去翻原文，不卡', async () => {
  const root = tmpdir();
  const { ctx: first } = await firstSession(root);
  // 把那段会话的记录撑到 90MB（旧格式：一条带图的消息就是几 MB 的一行）
  const junk = `${JSON.stringify({ at: 'x', type: 'message', message: { role: 'user', content: 'SECRET-WORD-IN-HUGE-LOG ' + 'A'.repeat(9_000_000) } })}\n`;
  for (let i = 0; i < 10; i++) fs.appendFileSync(first.store.file(first.session.id), junk);
  const ctx = makeCtx({ root });
  const t0 = Date.now();
  assert.match(searchSessions(ctx.store, ctx.session, root, { query: 'AAA' }).content, /仿照 AAA/, '摘要里有的照样找得到');
  assert.match(searchSessions(ctx.store, ctx.session, root, { query: 'SECRET-WORD-IN-HUGE-LOG' }).content, /没有找到/, '太大的记录不翻原文');
  assert.ok(Date.now() - t0 < 1500, `搜了 ${Date.now() - t0}ms`);
});
