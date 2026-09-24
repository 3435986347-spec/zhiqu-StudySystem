// goal 模式：模型没宣告就不许停；宣告达成要附证据、还要过独立核对；卡住就停；轮数有上限；状态记进会话。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGoal, systemText, toolset } from '../src/agent.js';
import { applyGoalUpdate, newGoal, parseVerdict } from '../src/goal.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

function ctxWith(replies, goalText = '做一个能跑的贪吃蛇并验证') {
  const root = tmpdir();
  const store = new SessionStore(root);
  const ctx = {
    ui: fakeUi(), api: fakeApi(replies), root, mode: 'auto', maxRounds: 10, local: new LocalTools({ root }), store,
    session: store.create(), messages: [], allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 },
    changedFiles: new Set(), system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: 'm', effectiveContextWindow: 64000 }, goal: newGoal(goalText),
  };
  return ctx;
}
const userTexts = (ctx) => ctx.messages.filter((m) => m.role === 'user').map((m) => m.content);
const ACHIEVED = { calls: [{ name: 'goal_update', args: { status: 'achieved', summary: '做完了', evidence: '跑了 node snake.js，输出 ok' } }] };
const VERIFIED = { text: '{"achieved": true, "missing": ""}' };

test('目标置顶进系统提示；goal_update 只在有进行中的目标时下发', () => {
  const ctx = ctxWith([]);
  const sys = systemText(ctx);
  assert.ok(sys.indexOf('## 当前目标（最高优先级）') > 0 && sys.indexOf('## 当前目标') < sys.indexOf('## 环境'), '目标要排在环境说明之前');
  assert.ok(toolset(ctx).some((t) => t.schema.function.name === 'goal_update'));
  ctx.goal.status = 'achieved';
  assert.ok(!toolset(ctx).some((t) => t.schema.function.name === 'goal_update'));
  assert.ok(!systemText(ctx).includes('## 当前目标'));
});

test('模型想收尾但没宣告：自动让它接着做；宣告达成 + 核对通过才停', async () => {
  const ctx = ctxWith([{ text: '接下来你可以自己运行一下。' }, ACHIEVED, { text: '做完了，snake.js 可以玩了。' }, VERIFIED]);
  const outcome = await runGoal(ctx);
  assert.equal(outcome, 'achieved');
  assert.match(userTexts(ctx)[1], /目标还没有宣告完成/);
  const verify = ctx.api.requests.at(-1);
  assert.equal(verify.tools.length, 0, '核对不带工具');
  assert.match(verify.messages[1].content, /跑了 node snake\.js，输出 ok/);
  assert.equal(ctx.store.load(ctx.session.id).goal.status, 'achieved', '状态要记进会话');
});

test('宣告达成不附证据：拒绝，状态不变，继续做', () => {
  const g = newGoal('x');
  assert.match(applyGoalUpdate(g, { status: 'achieved', summary: '好了' }), /必须附上证据/);
  assert.equal(g.status, 'active');
  assert.match(applyGoalUpdate(g, { status: 'blocked', summary: '卡了' }), /必须写清楚 blocker/);
  assert.equal(g.status, 'active');
});

test('核对员不认：带着缺口继续，下一次宣告并核对通过才算', async () => {
  const ctx = ctxWith([ACHIEVED, { text: '好了' }, { text: '{"achieved": false, "missing": "没有真的跑过测试"}' },
    ACHIEVED, { text: '这次真好了' }, VERIFIED]);
  assert.equal(await runGoal(ctx), 'achieved');
  assert.ok(userTexts(ctx).some((t) => /核对没通过：没有真的跑过测试/.test(t)));
  assert.equal(ctx.goal.verifyFailures, 1);
});

test('卡住：宣告 blocked 就停，说出卡在哪', async () => {
  const ctx = ctxWith([{ calls: [{ name: 'goal_update', args: { status: 'blocked', summary: '缺信息', blocker: '需要你给出 API Key' } }] }, { text: '需要你给 Key' }]);
  assert.equal(await runGoal(ctx), 'blocked');
  assert.match(ctx.ui.text(), /卡住了：需要你给出 API Key/);
});

test('一直不宣告：到轮数上限就停，并说怎么接着追', { timeout: 10_000 }, async () => {
  const ctx = ctxWith([{ text: '还在做' }]);
  assert.equal(await runGoal(ctx, { maxTurns: 3 }), 'exhausted');
  assert.equal(ctx.goal.turns, 3);
  assert.match(ctx.ui.text(), /\/goal continue/);
});

test('被打断：马上停，返回 aborted', async () => {
  const ctx = ctxWith([{ text: '还在做' }]);
  const c = new AbortController();
  c.abort();
  assert.equal(await runGoal(ctx, { signal: c.signal }), 'aborted');
});

test('核对员的回答解析：夹在文字里的 JSON 也认；解析不了按没核对上算', () => {
  assert.deepEqual(parseVerdict('结论：{"achieved": true, "missing": ""} 完'), { achieved: true, missing: '' });
  assert.equal(parseVerdict('我觉得可以').achieved, false);
  assert.equal(parseVerdict('{"achieved": "yes"}').achieved, false, '只认布尔 true');
});

test('goal 推的每一轮（开头、没宣告就想停、核对没过）在会话记录里都标成 goal —— /resume 回放时不冒充用户说的话', async () => {
  const ctx = ctxWith([{ text: '先这样。' }, ACHIEVED, { text: '好了' }, { text: '{"achieved": false, "missing": "没跑测试"}' },
    ACHIEVED, { text: '跑过了' }, VERIFIED]);
  await runGoal(ctx);
  const fs = await import('node:fs');
  const entries = fs.readFileSync(ctx.store.file(ctx.session.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((e) => e.type === 'message' && e.message.role === 'user');
  assert.ok(entries.length >= 3, `goal 至少推了三轮：${entries.length}`);
  for (const e of entries) assert.equal(e.origin, 'goal', `没标成 goal：${e.message.content.slice(0, 30)}`);
  const { replayTranscript } = await import('../src/replay.js');
  const ui = fakeUi();
  assert.equal(replayTranscript(ui, ctx.store.transcript(ctx.session.id)), 0, ui.text());
});
