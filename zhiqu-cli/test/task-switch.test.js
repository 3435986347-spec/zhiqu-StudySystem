// 长活省钱第 5 步（第一百七十轮，docs/agent-efficiency-plan.md）：
// 1. 换了一件不相干的事就先把前面的活压成摘要（用户定的：自动压）；是不是新事让模型判断，只在上下文不小的时候问。
// 2. 目标含糊不含糊让模型自己判断（用户定的）：没有验收标准时能问就用 ask_user 问一次，问不了就自己定；标准记进目标、置顶、核对员照它核对。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGoal, runTurn, systemText, SUMMARY_EFFORT, switchTask, taskSwitchFloor } from '../src/agent.js';
import { estimateMessages, minClear, softLimit } from '../src/compact.js';
import { applyGoalUpdate, goalBlock, newGoal, verificationMaterial } from '../src/goal.js';
import { SUMMARY_PREFIX } from '../src/origins.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

function ctxWith(replies, { window = 64_000, decide, goal } = {}) {
  const root = tmpdir();
  const store = new SessionStore(root);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds: 10, local: new LocalTools({ root }), store,
    session: store.create(), messages: [], allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 },
    changedFiles: new Set(), system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: window }, ...(decide ? { decide } : {}), ...(goal ? { goal: newGoal(goal) } : {}),
  };
}
const SUMMARY = '## 目标\n做鹈鹕骑车页面\n## 当前进展和下一步\n已完成';
/** 前一件事：用户说一句，助手做了很多步（每步一万字） */
function earlierTask(ctx, ask = '做一个 3D 鹈鹕骑车网页', rounds = 12) {
  // 12 步、每步 2500 字：换了事只留最后一步原文（留三成的话要留七步，压不到一半 —— 这条样本照得出来）
  ctx.messages.push({ role: 'user', content: ask });
  for (let i = 0; i < rounds; i++) ctx.messages.push({ role: 'assistant', content: `第 ${i + 1} 步 ${'字'.repeat(2_500)}` });
}
const isSwitch = (r) => /判断刚说的这句/.test(String(r.messages[0].content));
const isSummary = (r) => !r.tools.length && !isSwitch(r);

// ── 1. 换了一件事 ──

test('判断的门槛：上下文过了软上限的一半才问（1M 窗口 15 万、64K 窗口 19200）', () => {
  assert.equal(taskSwitchFloor(1_000_000), 150_000);
  assert.equal(taskSwitchFloor(64_000), Math.max(minClear(64_000), softLimit(64_000) / 2));
});

test('上下文还小：不问、不压，一次多余的调用都没有', async () => {
  const ctx = ctxWith([{ text: '好的' }]);
  ctx.messages.push({ role: 'user', content: '做个贪吃蛇' }, { role: 'assistant', content: '做好了' });
  await runTurn(ctx, '再做一个加油站模型');
  assert.equal(ctx.api.requests.length, 1);
});

test('上下文不小、模型判断是新事：先把前面的活压成摘要，再开工；判断那一次只看几句请求、不思考', async () => {
  const ctx = ctxWith([{ text: '{"new_task": true}' }, { text: SUMMARY }, { text: '开始做加油站' }]);
  ctx.effort = 'max';
  earlierTask(ctx);
  const before = estimateMessages(ctx.messages);
  assert.ok(before > taskSwitchFloor(64_000));
  await runTurn(ctx, '制作一个桌面立体模型：荒野公路旁的加油站，深夜暴雨');
  const [ask, summary, work] = ctx.api.requests;
  assert.ok(isSwitch(ask));
  assert.equal(ask.reasoning, SUMMARY_EFFORT, '判断那一次不思考');
  assert.ok(ask.messages[1].content.includes('做一个 3D 鹈鹕骑车网页') && ask.messages[1].content.includes('荒野公路旁的加油站'));
  assert.ok(estimateMessages(ask.messages) < 1_000, '只给几句请求，不带整段历史');
  assert.ok(isSummary(summary), '判断是新事：调一次模型写摘要');
  assert.ok(String(work.messages[1].content).startsWith(SUMMARY_PREFIX), `开工时前面是摘要：${String(work.messages[1].content).slice(0, 40)}`);
  assert.ok(estimateMessages(work.messages) < before / 3, `压下来了，只留最后一步原文：${estimateMessages(work.messages)} / ${before}`);
  assert.equal(ctx.messages.filter((m) => m.role === 'user' && m.content === '制作一个桌面立体模型：荒野公路旁的加油站，深夜暴雨').length, 1, '新的一句在摘要后面，只有一条');
  assert.match(ctx.ui.text(), /换了一件新的事（模型判断的），先把前面的活压成一段摘要再开工/);
});

test('模型判断是接着做：不压', async () => {
  const ctx = ctxWith([{ text: '{"new_task": false}' }, { text: '改好了' }]);
  earlierTask(ctx);
  const n = ctx.messages.length;
  await runTurn(ctx, '鹈鹕的喙再长一点');
  assert.equal(ctx.api.requests.filter(isSummary).length, 0);
  assert.equal(ctx.messages[0].content, '做一个 3D 鹈鹕骑车网页', '前面原样');
  assert.ok(ctx.messages.length > n);
});

test('判断不了（答非所问、调用出错）：当不是，不压，照常开工', async () => {
  for (const first of [{ text: '我觉得是新任务' }, { text: '{"new_task": "yes"}' }]) {
    const ctx = ctxWith([first, { text: '好' }]);
    earlierTask(ctx);
    await runTurn(ctx, '做个加油站');
    assert.equal(ctx.api.requests.filter(isSummary).length, 0);
    assert.equal(ctx.messages[0].content, '做一个 3D 鹈鹕骑车网页');
  }
  const ctx = ctxWith([{ text: '好' }]);
  earlierTask(ctx);
  const real = ctx.api.stream.bind(ctx.api);
  let n = 0;
  ctx.api.stream = async (p, body, on) => { if (n++ === 0) throw new Error('网关不通'); return real(p, body, on); };
  assert.equal(await switchTask(ctx, '做个加油站'), false);
});

test('新目标的第一轮也问；以前的目标从「目标：…开始做。」里认，不拿正要开工的新目标当「之前的事」', async () => {
  const ctx = ctxWith([{ text: '{"new_task": true}' }, { text: SUMMARY },
    { calls: [{ name: 'goal_update', args: { status: 'achieved', summary: '好', evidence: '跑过' } }] }, { text: '好' }, { text: '{"achieved": true, "missing": ""}' }], { goal: '做黎曼猜想的 3D 讲解网站' });
  ctx.messages.push({ role: 'user', content: '目标：做 3D 鹈鹕骑车网页\n开始做。' });
  for (let i = 0; i < 3; i++) ctx.messages.push({ role: 'assistant', content: `第 ${i + 1} 步 ${'字'.repeat(10_000)}` });
  assert.equal(await runGoal(ctx), 'achieved');
  const ask = ctx.api.requests[0];
  assert.ok(isSwitch(ask));
  const earlier = ask.messages[1].content.split('【刚说的一句】')[0];
  assert.match(earlier, /（目标）做 3D 鹈鹕骑车网页/);
  assert.ok(!earlier.includes('黎曼'), '正要开工的新目标不算「之前的事」');
  assert.ok(ctx.api.requests.filter(isSwitch).length === 1, '目标后面几轮（推回去、核对）不再问');
});

test('命令行自己补的一轮（origin system）、子 agent：不问', async () => {
  const ctx = ctxWith([{ text: '好' }]);
  earlierTask(ctx);
  await runTurn(ctx, '（日期变了：现在是 2026-11-24）', { origin: 'system' });
  assert.equal(ctx.api.requests.filter(isSwitch).length, 0);
  const sub = ctxWith([{ text: '好' }]);
  earlierTask(sub);
  sub.subagent = { id: 'a1' };
  assert.equal(await switchTask(sub, '做个加油站'), false);
  assert.equal(sub.api.requests.length, 0);
});

// ── 2. 验收标准 ──

test('目标提示：没有验收标准时让模型自己判断；能问就 ask_user 问一次，问不了自己定；定下来就置顶、不再问', () => {
  const g = newGoal('继续打磨黎曼');
  assert.match(goalBlock(g, { canAsk: true }), /先判断：这个目标有没有能判断「做完了」的标准[\s\S]*先用 ask_user 问一次验收标准（给 2–4 个具体可检查的选项，标一个推荐）/);
  assert.match(goalBlock(g, { canAsk: false }), /这里问不了用户：自己定一个合理、可检查的标准/);
  assert.ok(!goalBlock(g, { canAsk: false }).includes('ask_user'));
  assert.match(applyGoalUpdate(g, { status: 'progress', summary: '定了标准', criteria: '六幕都能滚动切换；手机 390px 不横滚；控制台 0 报错' }), /已记下验收标准/);
  const pinned = goalBlock(g, { canAsk: true });
  assert.match(pinned, /验收标准（已经定下，照它做、照它验证，不要再问）：六幕都能滚动切换/);
  assert.ok(!pinned.includes('ask_user'), '定下来就不再叫它去问');
  assert.match(verificationMaterial(g, []), /【验收标准】\n六幕都能滚动切换/);
  assert.match(verificationMaterial(newGoal('x'), []), /【验收标准】\n（没有写下来：按目标本身判断）/);
  applyGoalUpdate(g, { status: 'progress', summary: '只记进展' });
  assert.match(g.criteria, /^六幕/, '不带 criteria 的 progress 不清掉已定的标准');
});

test('系统提示里的说法跟着「这里能不能问」走：交互的终端说 ask_user，exec / 子 agent 说自己定', () => {
  const ctx = ctxWith([], { goal: '继续打磨黎曼', decide: async () => ({ answers: [] }) });
  assert.match(systemText(ctx), /先用 ask_user 问一次验收标准/);
  ctx.exec = true;
  assert.match(systemText(ctx), /这里问不了用户：自己定/);
});

test('整条走一遍：模型问验收标准 → 用户选 → 记进目标 → 核对员照它核对', async () => {
  const question = { id: 'q1', question: '「打磨」做到什么程度算完成？', options: [
    { id: 'a', label: '六幕都能切换、手机不横滚、0 报错', recommended: true }, { id: 'b', label: '只修视觉细节' }] };
  const decide = async (qs) => ({ answers: [{ questionId: qs[0].id, optionId: 'a' }] });
  const ctx = ctxWith([
    { calls: [{ name: 'ask_user', args: { questions: [question] } }] },
    { calls: [{ name: 'goal_update', args: { status: 'progress', summary: '定了标准', criteria: '六幕都能切换、手机不横滚、0 报错' } }] },
    { calls: [{ name: 'goal_update', args: { status: 'achieved', summary: '好了', evidence: '六幕切换过、390px 截图、控制台 0 报错' } }] },
    { text: '做完了' }, { text: '{"achieved": true, "missing": ""}' }], { goal: '继续打磨黎曼', decide });
  assert.equal(await runGoal(ctx), 'achieved');
  assert.equal(ctx.goal.criteria, '六幕都能切换、手机不横滚、0 报错');
  assert.equal(ctx.store.load(ctx.session.id).goal.criteria, '六幕都能切换、手机不横滚、0 报错', '记进会话（/resume 接回来还在）');
  const verify = ctx.api.requests.at(-1);
  assert.match(verify.messages[1].content, /【验收标准】\n六幕都能切换、手机不横滚、0 报错/);
});
