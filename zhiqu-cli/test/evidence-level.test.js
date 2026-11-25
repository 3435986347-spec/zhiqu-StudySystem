// 语法检查是 L0，不能把清单项标完成，也不能用来宣告目标达成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from '../src/agent.js';
import { applyGoalUpdate, newGoal } from '../src/goal.js';
import { parseTodos, syntaxOnlyEvidence } from '../src/todos.js';
import { BUILTIN_SYSTEM_PROMPT } from '../src/prompt.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

const item = (content, status, evidence) => ({ content, status, ...(evidence ? { evidence } : {}) });

test('系统提示写明 node --check 只算 L0', () => {
  assert.match(BUILTIN_SYSTEM_PROMPT, /node --check、语法检查只算 L0/);
});

test('只有语法检查不能标完成；同一句里有请求、测试、跑过程序就可以；没写证据、截图、读过不拦', () => {
  for (const evidence of ['node --check 通过', 'node -c server.js', '语法检查通过', 'python3 -m py_compile app.py', 'tsc --noEmit']) {
    assert.equal(syntaxOnlyEvidence(evidence), true, evidence);
    const r = parseTodos({ todos: [item('后端能跑', 'completed', evidence), item('前端', 'pending')] });
    assert.match(r.error, /L0/);
    assert.match(r.error, /第 1 项/);
    assert.equal(r.todos, undefined);
  }
  assert.equal(syntaxOnlyEvidence(''), false);
  assert.equal(syntaxOnlyEvidence('读过 600 行'), false);
  assert.equal(syntaxOnlyEvidence('截图里左上两行不再重叠'), false);
  for (const evidence of [
    'node --check 通过，并且 npm test 过了',
    'curl 打了 /api/chat，状态码 200',
    '跑了 node snake.js，输出 ok',
    'node --test tests/chat.test.js，断言通过',
  ]) {
    assert.equal(syntaxOnlyEvidence(evidence), false, evidence);
    const r = parseTodos({ todos: [item('后端能跑', 'completed', evidence)] });
    assert.equal(r.error, undefined, evidence);
    assert.equal(r.todos[0].status, 'completed');
  }
  const pending = parseTodos({ todos: [item('还在查语法', 'in_progress', 'node --check 通过')] });
  assert.equal(pending.error, undefined);
  assert.equal(pending.todos[0].status, 'in_progress');
});

test('目标宣告达成：只有 node --check 不收，状态还是进行中', () => {
  const g = newGoal('做一个网页版 agent');
  assert.match(applyGoalUpdate(g, { status: 'achieved', summary: '好了', evidence: '五个文件 node --check 通过' }), /L0/);
  assert.equal(g.status, 'active');
  assert.equal(g.evidence, '');
  assert.match(applyGoalUpdate(g, { status: 'achieved', summary: '好了', evidence: 'curl 打了 /api/chat，断言返回了时间线' }), /已记录：目标达成/);
  assert.equal(g.status, 'achieved');
});

test('清单那一次调用把 L0 退回去，会话里的清单不变', async () => {
  const root = tmpdir();
  const store = new SessionStore(root);
  const ctx = {
    ui: fakeUi(), api: fakeApi([
      { calls: [{ name: 'update_todos', args: { todos: [item('接口能用', 'completed', 'node --check 通过'), item('页面', 'pending')] } }] },
      { text: '先这样' },
    ]),
    root, mode: 'auto', maxRounds: 6, local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: 'm', effectiveContextWindow: 64000 }, todos: [],
  };
  await runTurn(ctx, '做接口');
  const tool = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
  assert.match(tool, /L0/);
  assert.deepEqual(ctx.todos, []);
});
