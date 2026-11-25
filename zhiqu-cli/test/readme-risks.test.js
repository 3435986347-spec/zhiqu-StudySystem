// 收尾时 README 的已知边界要问用户，不能只留在文档里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from '../src/agent.js';
import { newGoal } from '../src/goal.js';
import { boundaryItems, unansweredRisks } from '../src/readme-risks.js';
import { BUILTIN_SYSTEM_PROMPT } from '../src/prompt.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

const README = `# 对话 agent

## 用法
node server.js

## 已知边界
- 会话只存在浏览器本地，没有服务端持久化
- run_shell 不做隔离

## 许可
- MIT
`;

test('只取已知边界那一节；问过标题或某一条的开头才算问过', () => {
  assert.match(BUILTIN_SYSTEM_PROMPT, /已知边界 \/ 已知限制/);
  const items = boundaryItems(README);
  assert.deepEqual(items, ['会话只存在浏览器本地，没有服务端持久化', 'run_shell 不做隔离']);
  assert.deepEqual(boundaryItems('# Readme\n\n- 普通列表'), []);
  assert.deepEqual(unansweredRisks(items, ''), items);
  assert.deepEqual(unansweredRisks(items, '已知边界要不要收紧？'), []);
  assert.deepEqual(unansweredRisks(items, 'run_shell 不做隔离要不要收紧'), ['会话只存在浏览器本地，没有服务端持久化']);
});

test('写了已知边界就宣告达成：先拒，问过之后才收', async () => {
  const root = tmpdir();
  const store = new SessionStore(root);
  const decide = async (qs) => ({ answers: [{ questionId: qs[0].id, optionId: qs[0].options[0].id }] });
  const ctx = {
    ui: fakeUi(), api: fakeApi([
      { calls: [{ name: 'write_file', args: { path: 'README.md', content: README } }] },
      { calls: [{ name: 'goal_update', args: { status: 'achieved', summary: '好了', evidence: 'curl 打了页面，断言能看到时间线' } }] },
      { calls: [{ name: 'ask_user', args: { questions: [{ question: '已知边界要不要收紧？', options: [
        { id: 'a', label: '收紧会话存储和 run_shell', recommended: true }, { id: 'b', label: '先保持现状' }] }] } }] },
      { calls: [{ name: 'goal_update', args: { status: 'achieved', summary: '好了', evidence: 'curl 打了页面，断言能看到时间线' } }] },
      { text: '做完了，风险问过了' },
    ]),
    root, mode: 'auto', maxRounds: 8, local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: 'm', effectiveContextWindow: 64000 }, goal: newGoal('做一个网页版 agent'), decide,
  };
  const result = await runTurn(ctx, '做完这个 agent');
  const tools = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(tools[1], /先用 ask_user/);
  assert.match(tools[1], /run_shell 不做隔离/);
  assert.equal(ctx.goal.status, 'achieved');
  assert.match(result.finalText, /风险问过了/);
});
