// 缓存（第一百零四轮，用户：DeepSeek 命中率 55%、Opus 5.5 9%）：缓存是前缀匹配，前面改一个字，后面全部失效。
// 主判据：一段会话里连续两次请求，前一次的消息必须原样是后一次的开头 —— 历史只追加、不改写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn, TODO_REMIND_ROUNDS } from '../src/agent.js';
import { generatedOrigin } from '../src/origins.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

function makeCtx({ replies, root = tmpdir(), window = 1_000_000 } = {}) {
  const store = new SessionStore(root);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds: 60,
    local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: window },
  };
}
const todos = (...items) => ({ calls: [{ name: 'update_todos', args: { todos: items.map(([content, status]) => ({ content, status })) } }] });
const read = (i) => ({ calls: [{ name: 'read_file', args: { path: 'a.js', offset: i, limit: 1 } }] });
const thought = (i) => ({ text: `第 ${i} 段思考：${'分析'.repeat(800)}`, calls: [{ name: 'read_file', args: { path: 'a.js', offset: 100 + i, limit: 1 } }] });

function assertAppendOnly(requests) {
  assert.ok(requests.length >= 8, `只有 ${requests.length} 次请求`);
  for (let k = 1; k < requests.length; k++) {
    const prev = requests[k - 1], next = requests[k];
    assert.deepEqual(next.tools, prev.tools, `第 ${k + 1} 次请求的工具定义变了`);
    assert.deepEqual(next.messages.slice(0, prev.messages.length), prev.messages,
      `第 ${k + 1} 次请求改写了前面的消息（缓存从那里起全部失效）`);
  }
}

test('一段有清单、有长思考、有两句用户的话的会话：每次请求都只在后面追加', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n'.repeat(300));
  const ctx = makeCtx({ root, replies: [
    todos(['读代码', 'in_progress'], ['改代码', 'pending']), read(1), thought(1), thought(2), thought(3), read(2),
    todos(['读代码', 'completed'], ['改代码', 'in_progress']), read(3), thought(4), read(4),
    todos(['读代码', 'completed'], ['改代码', 'completed']), { text: '第一句做完了' },
    read(5), thought(5), { text: '第二句做完了' }] });
  await runTurn(ctx, '做第一件事');
  await runTurn(ctx, '做第二件事');
  assertAppendOnly(ctx.api.requests);
  assert.ok(ctx.api.requests.at(-1).messages.some((m) => m.role === 'assistant' && String(m.content).length > 1000), '长思考应当还在（窗口远没吃紧）');
});

test('清单隔几轮再说一遍：附在工具结果后面（记进历史）；改过清单重新数；做完了不说', async () => {
  assert.equal(TODO_REMIND_ROUNDS, 8);
  const root = tmpdir();
  write(root, 'a.js', 'x\n'.repeat(300));
  const reads = (from, n) => Array.from({ length: n }, (_, i) => read(from + i));
  const ctx = makeCtx({ root, replies: [todos(['改接口', 'in_progress'], ['跑测试', 'pending']), ...reads(1, 7), ...reads(50, 8), { calls: [] , text: '清单还没做完？' }] });
  await runTurn(ctx, '做');
  const tools = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  const shown = tools.map((t, i) => (/【提醒】## 任务清单/.test(t) ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(shown, [7, 15], `第 8、16 个工具结果后面说（update_todos 算第 1 轮）：${shown}`);
  assert.match(tools[7], /\[~\] 改接口/);
  assert.match(tools[7], /\[ \] 跑测试/);

  const done = makeCtx({ root, replies: [todos(['改接口', 'completed']), ...reads(100, 12), { text: '好' }] });
  await runTurn(done, '做');
  assert.ok(!done.messages.some((m) => /## 任务清单/.test(String(m.content))), '做完了不用再说');
  assert.ok(!done.messages.some((m) => /【提醒】\s*$/.test(String(m.content))), '做完了连空的提醒也不该有');

  // 中途改过清单：从改的那一轮重新数（第 6 轮改的，第 13 轮才说，不是第 8 轮）
  const again = makeCtx({ root, replies: [todos(['a', 'in_progress']), ...reads(200, 4), todos(['a', 'in_progress'], ['b', 'pending']), ...reads(210, 7), { text: '清单还没做完？' }] });
  await runTurn(again, '做');
  const times = again.messages.filter((m) => m.role === 'tool').map((m, i) => (/【提醒】## 任务清单/.test(m.content) ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(times, [12], `改过清单应当重新数：${times}`);
});

test('清单不在历史里了（对话压缩过 / 接回压缩过的会话）：补一条，只补一次；压缩时不算用户的原话', async () => {
  const ctx = makeCtx({ replies: [{ text: '好' }, { text: '又好' }] });
  ctx.todos = [{ content: '改接口', status: 'completed' }, { content: '改前端', status: 'pending' }];
  ctx.messages = [{ role: 'user', content: '【之前对话的摘要】改名' }];
  await runTurn(ctx, '接着做');
  const pinned = ctx.messages.filter((m) => m.role === 'user' && /## 任务清单/.test(m.content));
  assert.equal(pinned.length, 1);
  assert.match(pinned[0].content, /\[ \] 改前端/);
  assert.equal(generatedOrigin(pinned[0].content), 'system', '压缩时会被当成用户说过的原话');
  assert.match(JSON.stringify(ctx.api.requests[0].messages), /改前端/);
  await runTurn(ctx, '再做');
  assert.equal(ctx.messages.filter((m) => m.role === 'user' && /## 任务清单/.test(m.content)).length, 1, '已经在历史里了，不该再补');

  const already = makeCtx({ replies: [todos(['a', 'pending']), { text: '问：用哪个？' }, { text: '好' }] });
  await runTurn(already, '做');
  await runTurn(already, '接着');
  assert.ok(!already.messages.some((m) => m.role === 'user' && /## 任务清单/.test(m.content)), 'update_todos 还在历史里，不用补');
});

test('第一百轮那句「别复述」压缩时也不算用户的原话', () => {
  assert.equal(generatedOrigin('（你上一次的回答一直在重复同一段话，写满了单次输出上限，重复的部分已经删掉。'), 'system');
});
