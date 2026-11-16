// 尺子第三版的量法（第一百四十四轮，docs/memory-plan.md 第 8 步）：喂造出来的会话事件，看几个数算得对不对。不调模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionMetrics, summarize } from './ruler/memory-metrics.mjs';

const tc = (name, args) => ({ type: 'function', function: { name, arguments: JSON.stringify(args) } });
const step = (...calls) => ({ type: 'message', message: { role: 'assistant', content: '', tool_calls: calls } });
const compact = () => ({ type: 'compact', messages: [{ role: 'user', content: '【之前对话的摘要】\n## 目标\n…' }] });
const clearOnly = () => ({ type: 'compact', messages: [{ role: 'user', content: '（旧的工具输出已省略）' }] });
const todos = (...pairs) => ({ type: 'todos', todos: pairs.map(([content, status]) => ({ content, status })) });

test('压缩后几步才动手：读读读写 = 4；只清理不摘要的不算压缩；压完再也没动手记 null', () => {
  const m = sessionMetrics([
    step(tc('read_file', { path: 'a.js' })),
    compact(),
    step(tc('read_file', { path: 'a.js' })), step(tc('search', { pattern: 'x' })), step(tc('read_file', { path: 'b.js' })),
    step(tc('edit_file', { path: 'a.js', old_string: 'x', new_string: 'y' })),
    clearOnly(),
    step(tc('shell', { command: 'npm test' })),
    compact(),
    step(tc('read_file', { path: 'c.js' })),
  ]);
  assert.equal(m.compactions, 2);
  assert.deepEqual(m.stepsToAct, [4, null]);
});

test('连着压两次、中间没动手：第一次记 null（不是被第二次吞掉、也不是从第二次起算）', () => {
  const m = sessionMetrics([
    compact(), step(tc('read_file', { path: 'a.js' })),
    compact(), step(tc('read_file', { path: 'b.js' })), step(tc('edit_file', { path: 'b.js', old_string: 'x', new_string: 'y' })),
  ]);
  assert.deepEqual(m.stepsToAct, [null, 2]);
});

test('重复读取：同一段在没改过它之前又读一遍才算；改过之后再读不算；不同区段不算', () => {
  const m = sessionMetrics([
    step(tc('read_file', { path: 'a.js' })),
    step(tc('read_file', { path: './a.js' })),                      // 重复（路径写法不同也是同一个）
    step(tc('read_file', { path: 'a.js', offset: 200, limit: 100 })), // 不同区段
    step(tc('edit_file', { path: 'a.js', old_string: 'x', new_string: 'y' })),
    step(tc('read_file', { path: 'a.js' })),                        // 改过之后：不算
    step(tc('apply_patch', { patch: '*** Begin Patch\n*** Update File: b.js\n@@\n-x\n+y\n*** End Patch' })),
    step(tc('read_file', { path: 'b.js' }), tc('read_file', { path: 'b.js' })), // 一步里两遍：第二遍算
  ]);
  assert.equal(m.reads, 6);
  assert.equal(m.repeatedReads, 2);
  assert.ok(Math.abs(m.repeatedShare - 2 / 6) < 1e-9);
});

test('清单倒退：标过完成的又不是完成（或不见了）算一次；一直完成的不算', () => {
  const m = sessionMetrics([
    todos(['读代码', 'completed'], ['改', 'in_progress']),
    todos(['读代码', 'completed'], ['改', 'completed'], ['测', 'pending']),
    todos(['改', 'pending'], ['测', 'in_progress']),     // 「读代码」不见了、「改」退回 pending
    todos(['改', 'completed'], ['测', 'completed']),
  ]);
  assert.equal(m.todoRegressions, 2);
  assert.deepEqual(m.regressed.sort(), ['改', '读代码'].sort());
});

test('命中率与花费：没报 cached 的那次不进分母；花费按命中 / 未命中 / 输出三种价', () => {
  const m = sessionMetrics([
    { type: 'usage', prompt: 1000, completion: 100, cached: 800 },
    { type: 'usage', prompt: 1000, completion: 100, cached: null },
    { type: 'usage', prompt: 2000, completion: 200, cached: 1000 },
  ], { price: { hit: 0.2, miss: 2, output: 3 } });
  assert.equal(m.calls, 3);
  assert.ok(Math.abs(m.hitRate - 1800 / 3000) < 1e-9);
  // 命中 1800 × 0.2 + 未命中 (4000 − 1800) × 2 + 输出 400 × 3，每百万
  assert.ok(Math.abs(m.cost - (1800 * 0.2 + 2200 * 2 + 400 * 3) / 1e6) < 1e-12);
});

test('summarize：通过率、步数中位数、压完没动手的次数、倒退合计', () => {
  const s = summarize([
    { pass: true, metrics: { compactions: 1, stepsToAct: [2], repeatedShare: 0.1, todoRegressions: 0, hitRate: 0.8, cost: 0.01 } },
    { pass: false, metrics: { compactions: 2, stepsToAct: [6, null], repeatedShare: 0.3, todoRegressions: 1, hitRate: 0.6, cost: 0.02 } },
    { pass: true, metrics: { compactions: 0, stepsToAct: [], repeatedShare: 0.2, todoRegressions: 0, hitRate: null, cost: 0 } },
  ]);
  assert.equal(s.runs, 3);
  assert.ok(Math.abs(s.passRate - 2 / 3) < 1e-9);
  assert.equal(s.compactions, 3);
  assert.equal(s.medianStepsToAct, 4);
  assert.equal(s.neverActedAfterCompaction, 1);
  assert.equal(s.repeatedShare, 0.2);
  assert.equal(s.todoRegressions, 1);
  assert.equal(s.hitRate, 0.7);
});

test('接到真的会话记录上：假的 OpenAI 兼容服务器 + 直连 + 3.2 万窗口跑 long-shop，指标从这段会话的记录里算出来（不花钱）', async (t) => {
  const http = await import('node:http');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { listTasks, runEpisode } = await import('./ruler/ruler.mjs');
  const script = [
    { tool: ['read_file', { path: 'shop/pricing.py' }] },
    { tool: ['read_file', { path: 'shop/pricing.py' }] },
    { tool: ['update_todos', { todos: [{ content: '读代码', status: 'completed' }, { content: '改', status: 'pending' }] }] },
    { text: '看完了' },
  ];
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      const turn = script[Math.min(bodies.length - 1, script.length - 1)];
      res.setHeader('Content-Type', 'text/event-stream');
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (turn.tool) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${bodies.length}`, type: 'function', function: { name: turn.tool[0], arguments: JSON.stringify(turn.tool[1]) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ delta: { content: turn.text } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      send({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 600 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../zhiqu-cli');
  const task = listTasks().find((x) => x.name === 'long-shop');
  const r = await runEpisode(task, { cliDir, window: 32_000, maxRounds: 10, timeoutMs: 60_000,
    direct: { url: `http://127.0.0.1:${srv.address().port}/v1/chat/completions`, model: 'fake', protocol: 'openai' },
    price: { hit: 0.2, miss: 2, output: 3 } });
  assert.equal(r.error, null, r.error);
  assert.equal(r.window, 32_000);
  assert.equal(r.pass, false, '什么都没改，隐藏测试不该过');
  assert.ok(bodies.every((b) => b.stream_options && b.stream_options.include_usage === true), '尺子补上了要用量');
  assert.equal(r.metrics.calls, bodies.length, '每次调用记一条用量');
  assert.equal(r.metrics.reads, 2);
  assert.equal(r.metrics.repeatedReads, 1, '同一段读两遍');
  assert.ok(Math.abs(r.metrics.hitRate - 0.6) < 1e-9);
  assert.ok(r.metrics.cost > 0);
});
