import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runTurn, toolset } from '../src/agent.js';
import { OTHER_OPTION, askUserSchema, formatDecisionResult, normalizeDecisionAnswers, normalizeDecisionQuestions } from '../src/decisions.js';
import { kindOf, titleOf } from '../src/steps.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

const RAW = {
  questions: [
    { header: '实现方式', question: '采用哪种实现？', allowOther: false, options: [
      { label: '统一模块', description: '三端共用', recommended: true },
      { label: '分别实现', description: '重复较多' },
    ] },
    { header: '验证', question: '怎样验证？', options: [{ label: '自动测试' }, { label: '手工测试' }], allowOther: true },
  ],
};

function makeCtx(replies, decide) {
  const root = tmpdir();
  const store = new SessionStore(root);
  return {
    ui: fakeUi(), api: fakeApi(replies), root, mode: 'auto', maxRounds: 10,
    local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 64000 }, decide,
  };
}

const names = (ctx) => toolset(ctx).map((t) => t.schema.function.name);
const toolMessages = (ctx) => ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);

test('协议：规范化工整的问题，生成稳定编号，保留推荐项和其他输入', () => {
  const r = normalizeDecisionQuestions(RAW);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.questions.map((q) => q.id), ['q1', 'q2']);
  assert.deepEqual(r.questions[0].options.map((o) => o.id), ['o1', 'o2']);
  assert.equal(r.questions[0].options[0].recommended, true);
  assert.equal(r.questions[0].options[1].recommended, false);
  assert.equal(r.questions[0].allowOther, false);
  assert.equal(r.questions[1].allowOther, true);
  assert.equal(askUserSchema().function.name, 'ask_user');
});

test('协议：坏问题整批拒绝，不静默修成另一件事', () => {
  const invalid = [
    {},
    { questions: [] },
    { questions: Array.from({ length: 5 }, () => RAW.questions[0]) },
    { questions: [{ question: 'x', options: [{ label: '只有一个' }] }] },
    { questions: [{ question: 'x', options: Array.from({ length: 7 }, (_, i) => ({ label: String(i) })) }] },
    { questions: [{ question: '', options: [{ label: 'a' }, { label: 'b' }] }] },
    { questions: [{ question: 'x', options: [{ label: 'a', recommended: true }, { label: 'b', recommended: true }] }] },
    { questions: [{ question: 'x', options: [{ label: '' }, { label: 'b' }] }] },
    { questions: [{ question: 'x', options: [{ label: 'a' }, { label: 'b' }], allowOther: 'yes' }] },
  ];
  for (const value of invalid) assert.match(normalizeDecisionQuestions(value).error || '', /./, JSON.stringify(value));
});

test('协议：答案必须覆盖每题且只能选存在的方案；其他输入不能为空', () => {
  const normalized = normalizeDecisionQuestions(RAW);
  assert.equal(normalized.error, undefined);
  const q = normalized.questions;
  const valid = normalizeDecisionAnswers(q, [
    { questionId: 'q1', optionId: 'o2' },
    { questionId: 'q2', optionId: OTHER_OPTION, otherText: '  跑真终端  ' },
  ]);
  assert.equal(valid.error, undefined);
  assert.deepEqual(valid.answers[1], { questionId: 'q2', optionId: OTHER_OPTION, otherText: '跑真终端' });
  const bad = [
    [],
    [{ questionId: 'q1', optionId: 'o1' }],
    [{ questionId: 'q1', optionId: 'missing' }, { questionId: 'q2', optionId: 'o1' }],
    [{ questionId: 'q1', optionId: 'o1' }, { questionId: 'q1', optionId: 'o2' }, { questionId: 'q2', optionId: 'o1' }],
    [{ questionId: 'q1', optionId: OTHER_OPTION, otherText: 'x' }, { questionId: 'q2', optionId: 'o1' }],
    [{ questionId: 'q1', optionId: 'o1' }, { questionId: 'q2', optionId: OTHER_OPTION, otherText: '   ' }],
  ];
  for (const value of bad) assert.match(normalizeDecisionAnswers(q, value).error || '', /./, JSON.stringify(value));
});

test('协议：给模型的结果忠实复述每题选择，包括推荐标记和其他输入；取消不等于采用推荐项', () => {
  const normalized = normalizeDecisionQuestions(RAW);
  assert.equal(normalized.error, undefined);
  const answered = normalizeDecisionAnswers(normalized.questions, [
    { questionId: 'q1', optionId: 'o1' }, { questionId: 'q2', optionId: OTHER_OPTION, otherText: '跑真终端' },
  ]);
  assert.equal(answered.error, undefined);
  const text = formatDecisionResult(normalized.questions, answered);
  assert.match(text, /采用哪种实现/);
  assert.match(text, /统一模块（推荐）/);
  assert.match(text, /其他输入：跑真终端/);
  const cancelled = formatDecisionResult(normalized.questions, { cancelled: true, answers: [] });
  assert.match(cancelled, /取消/);
  assert.match(cancelled, /不要.*推荐/);
});

test('工具只在有交互回答者的主 agent 上下发；plan / ask / auto 都可提问，子 agent 和 exec 不下发', () => {
  const decide = async () => ({ cancelled: true, answers: [] });
  for (const mode of ['plan', 'ask', 'auto']) {
    const ctx = makeCtx([{ text: '好' }], decide);
    ctx.mode = mode;
    assert.ok(names(ctx).includes('ask_user'), mode);
  }
  assert.ok(!names(makeCtx([{ text: '好' }], null)).includes('ask_user'));
  const child = makeCtx([{ text: '好' }], decide);
  child.subagent = { id: 'worker-1', role: 'worker' };
  assert.ok(!names(child).includes('ask_user'));
  const exec = makeCtx([{ text: '好' }], decide);
  exec.exec = true;
  exec.execReadOnly = true;
  assert.ok(!names(exec).includes('ask_user'));
});

test('完整闭环：模型提问，用户一次提交两题，下一次模型请求读到同一组答案', async () => {
  let asked = null;
  const ctx = makeCtx([
    { calls: [{ name: 'ask_user', args: RAW }] },
    { text: '按你的选择完成' },
  ], async (questions) => {
    asked = questions;
    return { cancelled: false, answers: [
      { questionId: 'q1', optionId: 'o2' },
      { questionId: 'q2', optionId: OTHER_OPTION, otherText: '跑真终端' },
    ] };
  });
  const result = await runTurn(ctx, '开始做');
  assert.equal(result.finalText, '按你的选择完成');
  assert.equal(asked.length, 2);
  const output = toolMessages(ctx)[0];
  assert.match(output, /分别实现/);
  assert.match(output, /其他输入：跑真终端/);
  assert.match(ctx.api.requests[1].messages.at(-1).content, /其他输入：跑真终端/);
});

test('副作用隔离：ask_user 与写文件混发时整批不执行，也不向用户提问', async () => {
  let calls = 0;
  const ctx = makeCtx([
    { calls: [
      { name: 'ask_user', args: RAW },
      { name: 'write_file', args: { path: 'premature.txt', content: '不该写入' } },
    ] },
    { text: '先决定再做' },
  ], async () => { calls++; return { cancelled: true, answers: [] }; });
  await runTurn(ctx, '开始做');
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(ctx.root, 'premature.txt')), false);
  assert.equal(toolMessages(ctx).length, 2);
  for (const output of toolMessages(ctx)) assert.match(output, /单独调用/);
});

test('多个 ask_user 同批也不执行；非法问题不进入交互', async () => {
  let calls = 0;
  const decide = async () => { calls++; return { cancelled: true, answers: [] }; };
  const multiple = makeCtx([{ calls: [{ name: 'ask_user', args: RAW }, { name: 'ask_user', args: RAW }] }, { text: '好' }], decide);
  await runTurn(multiple, '开始做');
  assert.equal(calls, 0);
  for (const output of toolMessages(multiple)) assert.match(output, /一次只能提出一批/);

  const invalid = makeCtx([{ calls: [{ name: 'ask_user', args: { questions: [] } }] }, { text: '好' }], decide);
  await runTurn(invalid, '开始做');
  assert.equal(calls, 0);
  assert.match(toolMessages(invalid)[0], /问题/);
});

test('没有回答者时模型硬调 ask_user：说明这里不能交互，不谎称工具不存在', async () => {
  const ctx = makeCtx([{ calls: [{ name: 'ask_user', args: RAW }] }, { text: '改用文字说明' }], null);
  const result = await runTurn(ctx, '开始做');
  assert.equal(result.finalText, '改用文字说明');
  assert.match(toolMessages(ctx)[0], /没有人|无法回答|不能交互/);
  assert.doesNotMatch(toolMessages(ctx)[0], /没有叫 ask_user/);
});

test('步骤：提问是用户可辨认的决策步骤，不是无名 other 工具', () => {
  assert.equal(kindOf('ask_user'), 'decision');
  assert.deepEqual(titleOf('ask_user', RAW), { title: '等待你决定', target: '2 个问题' });
});
