import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { createBridge, runHosted } from '../src/host/code-host.js';
import { OTHER_OPTION } from '../src/decisions.js';
import { tmpdir } from './helpers.js';

const MODEL = { id: 6, label: '测试模型', modelName: 'fake', effectiveContextWindow: 1_000_000 };
const QUESTIONS = { questions: [
  { header: '实现', question: '采用哪种实现？', options: [{ label: '方案甲', recommended: true }, { label: '方案乙' }] },
  { header: '验证', question: '怎样验证？', options: [{ label: '自动验证' }, { label: '手工验证' }] },
] };

function backend(replies, answer) {
  const toHost = new PassThrough(), fromHost = new PassThrough(), seen = [];
  let n = 0;
  readline.createInterface({ input: fromHost }).on('line', (line) => {
    const msg = JSON.parse(line);
    seen.push(msg);
    const reply = (value) => toHost.write(`${JSON.stringify(value)}\n`);
    if (msg.type === 'model') {
      const r = replies[Math.min(n++, replies.length - 1)];
      reply({ type: 'event', id: msg.id, name: 'start', data: { contextWindow: 1_000_000 } });
      const calls = (r.calls || []).map((call, index) => ({ id: `c${n}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }));
      reply({ type: 'event', id: msg.id, name: 'done', data: { message: { role: 'assistant', content: r.text || '', ...(calls.length ? { tool_calls: calls } : {}) },
        finishReason: calls.length ? 'tool_calls' : 'stop', maxTokens: 16384, usage: { promptTokens: 100, completionTokens: 10, estimated: false } } });
    }
    if (msg.type === 'question' && answer) {
      const outcome = answer(msg);
      if (outcome) reply({ type: 'question_result', id: msg.id, ...outcome });
    }
  });
  return { bridge: createBridge({ input: toHost, output: fromHost }), seen };
}

const run = (root, extra = {}) => ({ type: 'run', root, message: '开始做', model: MODEL, maxRounds: 5, ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('能力协商：客户端没声明 user_decision_v1 时不下发 ask_user', async () => {
  const root = tmpdir();
  const { bridge, seen } = backend([{ text: '好' }]);
  const result = await runHosted(bridge, run(root));
  assert.equal(result.error, null);
  const tools = seen.find((msg) => msg.type === 'model').body.tools.map((tool) => tool.function.name);
  assert.ok(!tools.includes('ask_user'), '能力未开启时不能给模型结构化提问工具');
});

test('完整宿主问答：question 出去，question_result 回来，模型下一次读到用户选择', async () => {
  const root = tmpdir();
  const { bridge, seen } = backend([
    { calls: [{ name: 'ask_user', args: QUESTIONS }] },
    { text: '收到决定' },
  ], (msg) => ({ cancelled: false, answers: [
    { questionId: 'q1', optionId: 'o2' },
    { questionId: 'q2', optionId: OTHER_OPTION, otherText: '在真浏览器里验证' },
  ], questions: msg.questions }));
  const result = await runHosted(bridge, run(root, { userDecision: true }));
  assert.equal(result.error, null);
  assert.equal(result.conclusion, '收到决定');
  const question = seen.find((msg) => msg.type === 'question');
  assert.ok(question, '宿主没有发出 question');
  assert.equal(question.questions.length, 2);
  const models = seen.filter((msg) => msg.type === 'model');
  assert.ok(models[0].body.tools.some((tool) => tool.function.name === 'ask_user'));
  assert.match(models[1].body.messages.at(-1).content, /方案乙/);
  assert.match(models[1].body.messages.at(-1).content, /其他输入：在真浏览器里验证/);
  const trace = seen.filter((msg) => msg.type === 'trace').map((msg) => msg.step);
  assert.ok(trace.some((step) => step.kind === 'decision' && step.status === 'ok'));
});

test('用户取消：答案明确是 cancelled，模型不得把推荐项当作用户选择', async () => {
  const root = tmpdir();
  const { bridge, seen } = backend([{ calls: [{ name: 'ask_user', args: QUESTIONS }] }, { text: '先停下' }], () => ({ cancelled: true, answers: [] }));
  const result = await runHosted(bridge, run(root, { userDecision: true }));
  assert.equal(result.conclusion, '先停下');
  const models = seen.filter((msg) => msg.type === 'model');
  assert.match(models[1].body.messages.at(-1).content, /取消/);
  assert.match(models[1].body.messages.at(-1).content, /不要.*推荐/);
});

test('等待答案时停止运行：宿主立即收尾，不永久等待 question_result', async () => {
  const root = tmpdir();
  const { bridge, seen } = backend([{ calls: [{ name: 'ask_user', args: QUESTIONS }] }], () => null);
  const pending = runHosted(bridge, run(root, { userDecision: true }));
  let question = null;
  for (let i = 0; i < 50 && !question; i++) {
    await tick();
    question = seen.find((msg) => msg.type === 'question');
  }
  assert.ok(question, '没有等到待取消的问题');
  bridge.requestStop();
  const result = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 1000))]);
  assert.equal(result.timeout, undefined, '停止后宿主还卡在等待答案');
  assert.equal(result.aborted, true, JSON.stringify(result));
});
