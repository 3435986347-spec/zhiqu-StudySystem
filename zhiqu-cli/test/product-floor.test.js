// 网页版 agent / 带工具的服务：验收底线不靠模型记得写。
// 只写展示层（流式、时间线、mock）时，核对材料里仍有持久化、信任边界、密钥、可重跑测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGoal, systemText } from '../src/agent.js';
import { acceptanceText, applyGoalUpdate, CRITERIA_MAX, goalBlock, isToolWebProduct, newGoal, toolWebFloor, verificationMaterial } from '../src/goal.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

const INCIDENT = '做一个对话和工具 agent，网页版，要求对话能看到每一步的工具调用和思考过程';
const DISPLAY = '流式思考；时间线能看到每一步工具调用；mock 可以演示';
const LINES = [
  '不能只放在浏览器本地',
  '不能由网页请求覆盖',
  '不在每次请求里明文传来传去',
  '语法检查不算',
];

function ctxWith(replies, goalText) {
  const root = tmpdir();
  const store = new SessionStore(root);
  return {
    ui: fakeUi(), api: fakeApi(replies), root, mode: 'auto', maxRounds: 10, local: new LocalTools({ root }), store,
    session: store.create(), messages: [], allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 },
    changedFiles: new Set(), system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: 'm', effectiveContextWindow: 64000 }, goal: newGoal(goalText),
  };
}

test('那次网页版工具 agent 的目标认得出；贪吃蛇、工具栏、命令行 agent、只看不改认不出', () => {
  assert.equal(isToolWebProduct(INCIDENT), true);
  assert.equal(isToolWebProduct('做一个带工具的本地服务'), true);
  assert.equal(isToolWebProduct('Build a web agent that calls tools'), true);
  assert.equal(isToolWebProduct('Create a browser agent'), true);
  assert.equal(isToolWebProduct('创建一个网页版 agent'), true);
  assert.equal(isToolWebProduct('开发一个网页版智能体'), true);
  assert.equal(isToolWebProduct('实现一个带工具调用的后端'), true);
  const serviceOnly = toolWebFloor('做一个带工具的本地服务').join('\n');
  assert.match(serviceOnly, /不能只放在内存里/);
  assert.ok(!serviceOnly.includes('浏览器'), serviceOnly);
  for (const text of [
    '',
    '做一个能跑的贪吃蛇并验证',
    '做一个贪吃蛇网页',
    '给网页加一个工具栏',
    '写一个命令行 agent',
    '继续打磨黎曼',
    '做 3D 鹈鹕骑车网页',
    '做一个后端管理页面',
    '做一个后端，菜单里带工具栏',
    '看看这个网页版 agent 怎么滚动',
    '写一篇介绍网页版 agent 的文档',
    '填写网页版 agent 的表',
    '做一个不带工具的本地服务',
    '做一个不带工具服务',
    '做一个不是工具服务',
    '做一个网页，不要工具调用',
  ]) {
    assert.equal(isToolWebProduct(text), false, text);
    assert.equal(toolWebFloor(text).length, 0, text);
  }
});

test('标准还没写：提示里已经有四条底线，并且仍让模型补产品自己的标准', () => {
  const g = newGoal(INCIDENT);
  const ask = goalBlock(g, { canAsk: true });
  assert.match(ask, /先用 ask_user 问一次验收标准/);
  for (const line of LINES) assert.ok(ask.includes(line), line);
  const noAsk = goalBlock(g, { canAsk: false });
  assert.ok(!noAsk.includes('ask_user'));
  assert.match(noAsk, /语法检查不算/);
  assert.equal(acceptanceText(g).includes('还必须满足'), true);
  assert.match(verificationMaterial(g, []), /还必须满足：[\s\S]*语法检查不算/);
  assert.ok(!verificationMaterial(g, []).includes('没有写下来'));
});

test('只写了展示层：底线补在核对材料里，也补在提示里；不写进 criteria 本身', () => {
  const g = newGoal(INCIDENT);
  assert.match(applyGoalUpdate(g, { status: 'progress', summary: '定了标准', criteria: DISPLAY }), /四条底线会一并核对/);
  assert.equal(g.criteria, DISPLAY, '底线不塞进 1000 字的 criteria，避免被截掉');
  const pinned = goalBlock(g, { canAsk: true });
  assert.match(pinned, /验收标准（已经定下，照它做、照它验证，不要再问）：流式思考/);
  assert.ok(!pinned.includes('ask_user'));
  for (const line of LINES) assert.ok(pinned.includes(line), line);
  const material = verificationMaterial(g, []);
  assert.match(material, /【验收标准】\n流式思考/);
  for (const line of LINES) assert.ok(material.includes(line), line);
  const ctx = ctxWith([], INCIDENT);
  ctx.goal = g;
  for (const line of LINES) assert.ok(systemText(ctx).includes(line), line);
});

test('模型写「不做持久化、密钥放浏览器」盖不掉底线；写满 1000 字也盖不掉', () => {
  const g = newGoal('做一个带工具的本地服务，网页里对话');
  applyGoalUpdate(g, {
    status: 'progress',
    summary: '相反',
    criteria: '会话只放浏览器；不做持久化；密钥放在 localStorage；不用写测试',
  });
  const material = verificationMaterial(g, []);
  for (const line of LINES) assert.ok(material.includes(line), line);
  const stuffed = newGoal(INCIDENT);
  applyGoalUpdate(stuffed, { status: 'progress', summary: '写满', criteria: '流式'.repeat(2000) });
  assert.equal(stuffed.criteria.length, CRITERIA_MAX);
  for (const line of LINES) assert.ok(verificationMaterial(stuffed, []).includes(line), line);
  assert.deepEqual(toolWebFloor('   '), []);
});

test('核对那一次请求里，展示层标准后面跟着四条底线', async () => {
  const ctx = ctxWith([
    { calls: [{ name: 'goal_update', args: { status: 'progress', summary: '定了', criteria: DISPLAY } }] },
    { calls: [{ name: 'goal_update', args: { status: 'achieved', summary: '好了', evidence: '时间线看过、mock 演示过' } }] },
    { text: '做完了' },
    { text: '{"achieved": true, "missing": ""}' },
  ], INCIDENT);
  assert.equal(await runGoal(ctx), 'achieved');
  const verify = ctx.api.requests.at(-1);
  assert.equal(verify.tools.length, 0);
  const body = verify.messages[1].content;
  assert.match(body, /流式思考/);
  for (const line of LINES) assert.ok(body.includes(line), line);
  assert.equal(ctx.store.load(ctx.session.id).goal.criteria, DISPLAY);
});
