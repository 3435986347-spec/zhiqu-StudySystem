import './xterm-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { OTHER_OPTION, normalizeDecisionQuestions } from '../src/decisions.js';
import { Ui } from '../src/ui.js';
import { runTurn } from '../src/agent.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, tmpdir } from './helpers.js';
import { Vt } from './vt.js';

function tty(cols = 60) {
  const vt = new Vt(cols);
  const output = new Writable({ write(chunk, _e, cb) { vt.feed(chunk.toString()); cb(); } });
  output.columns = cols;
  output.isTTY = true;
  const input = new PassThrough();
  input.isTTY = true;
  const ui = new Ui({ input, output, color: false, interactive: true });
  ui.start();
  return { ui, vt, input, output };
}

const tick = () => new Promise((r) => setImmediate(r));
async function key(input, value) { input.write(value); await tick(); await tick(); }
function questions() {
  const r = normalizeDecisionQuestions({ questions: [
    { header: '实现', question: '选择实现方式', options: [{ label: '方案甲', recommended: true }, { label: '方案乙' }] },
    { header: '验证', question: '选择验证方式', options: [{ label: '自动验证' }, { label: '手工验证' }] },
  ] });
  assert.equal(r.error, undefined);
  return r.questions;
}

test('CLI：↑↓ 选、Enter 记录并到下一题、←→ 切题；最后才提交，其他输入原样回到答案', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  const pending = ui.decide(questions());
  let settled = false;
  void pending.then(() => { settled = true; });
  await tick(); await tick();
  let screen = vt.lines().join('\n');
  assert.match(screen, /实现.*1\s*\/\s*2/);
  assert.match(screen, /方案甲（推荐）/);
  assert.match(screen, /提交答案（还有 2 题未答）/);

  await key(input, '\r');
  assert.equal(settled, false, '第一题回答后不能提前提交');
  assert.match(vt.lines().join('\n'), /验证.*2\s*\/\s*2/);
  await key(input, '\u001b[C');
  assert.match(vt.lines().join('\n'), /实现.*1\s*\/\s*2/);
  await key(input, '\u001b[B');
  await key(input, '\r');
  assert.match(vt.lines().join('\n'), /验证.*2\s*\/\s*2/);
  await key(input, '\u001b[B');
  await key(input, '\u001b[B');
  await key(input, '\r');
  await key(input, '自己的验证方式\r');
  assert.equal(settled, false, '答完全部问题也要等最后的提交');
  assert.match(vt.lines().join('\n'), /提交答案/);
  await key(input, '\r');
  const result = await pending;
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.answers, [
    { questionId: 'q1', optionId: 'o2' },
    { questionId: 'q2', optionId: OTHER_OPTION, otherText: '自己的验证方式' },
  ]);
  const text = vt.lines().join('\n');
  assert.match(text, /方案乙/);
  assert.match(text, /自己的验证方式/);
  assert.ok(!text.includes('还有 2 题未答'), '提交后选择面板要收起来');
  ui.close();
});

test('CLI：推荐项只是焦点，Esc 取消不默认采用；正在打的草稿恢复，排队消息不被吃掉', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  await key(input, '尚未发送的草稿');
  const pending = ui.decide(questions());
  await tick(); await tick();
  assert.match(vt.lines().join('\n'), /方案甲（推荐）/);
  await key(input, '\u001b');
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.answers, []);
  assert.equal(ui.rl.line, '尚未发送的草稿');
  assert.match(vt.lines().join('\n'), /取消/);
  ui.close();
});

test('CLI：其他输入为空不保存，Esc 只退出编辑，不取消整批问题', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  const pending = ui.decide(questions());
  await tick(); await tick();
  await key(input, '\u001b[B');
  await key(input, '\u001b[B');
  await key(input, '\r');
  await key(input, '\r');
  assert.match(vt.lines().join('\n'), /不能为空/);
  await key(input, 'abc');
  await key(input, '\u001b');
  assert.match(vt.lines().join('\n'), /选择实现方式/);
  await key(input, '\u001b');
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.answers, []);
  ui.close();
});

test('CLI：两个批次一次只显示一个；cancelQuestion 取消当前和排着的，不自动答推荐项', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  const first = ui.decide(questions());
  const second = ui.decide(questions());
  await tick(); await tick();
  assert.equal((vt.lines().join('\n').match(/选择实现方式/g) || []).length, 1);
  ui.cancelQuestion();
  assert.equal((await first).cancelled, true);
  assert.equal((await second).cancelled, true);
  await tick(); await tick();
  assert.doesNotMatch(vt.lines().join('\n'), /提交答案（还有/);
  ui.close();
});

test('整链：真实 runTurn 调假模型，终端最后一次提交后才把答案交给下一次模型调用', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  const root = tmpdir();
  const store = new SessionStore(root);
  const ctx = {
    ui, api: fakeApi([{ calls: [{ name: 'ask_user', args: { questions: questions().map((q) => ({ ...q })) } }] }, { text: '收到答案' }]),
    root, mode: 'auto', maxRounds: 5, local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 64000 },
    decide: (q, opts) => ui.decide(q, opts),
  };
  const running = runTurn(ctx, '开始做');
  for (let i = 0; i < 20 && !ui.decision; i++) await tick();
  assert.ok(ui.decision, '模型没有打开决策面板');
  await key(input, '\r');
  await key(input, '\r');
  assert.ok(ui.decision, '两题答完但还没点提交，agent 不能提前继续');
  await key(input, '\r');
  const result = await running;
  assert.equal(result.finalText, '收到答案');
  assert.equal(ctx.api.requests.length, 2);
  assert.match(ctx.api.requests[1].messages.at(-1).content, /方案甲（推荐）/);
  assert.match(ctx.api.requests[1].messages.at(-1).content, /自动验证/);
  assert.match(vt.lines().join('\n'), /已提交 2 个问题的答案/);
  ui.close();
});

test('中断信号：正等待答案时 abort 立即取消并摘监听，不把推荐项当答案', async () => {
  const { ui, input } = tty();
  ui.beginLive();
  const controller = new AbortController();
  const pending = ui.decide(questions(), { signal: controller.signal });
  await tick(); await tick();
  controller.abort();
  const result = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('挂住了'), 500))]);
  assert.deepEqual(result, { cancelled: true, answers: [] });
  assert.equal(controller.signal.aborted, true);
  await key(input, '\r');
  ui.close();
});

test('CLI：长问题、控制字符与 resize 不污染屏幕；无 live 的单发模式也能显示和收起', async () => {
  const { ui, vt, input, output } = tty(26);
  const q = questions();
  q[0].question = `很长的${'问题'.repeat(20)}\u001b[2J`;
  const pending = ui.decide(q);
  await tick(); await tick();
  assert.match(vt.lines().join('\n'), /方案甲（推荐）/);
  output.columns = 42;
  vt.resize(42);
  output.emit('resize');
  await tick(); await tick();
  await key(input, '\u001b');
  assert.equal((await pending).cancelled, true);
  const text = vt.lines().join('\n');
  assert.ok(!text.includes('\u001b'), '控制字符不能原样进入终端');
  assert.ok((text.match(/选择验证方式/g) || []).length <= 1, text);
  ui.close();
});
