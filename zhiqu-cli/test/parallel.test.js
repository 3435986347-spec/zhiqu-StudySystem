// 同一批只读一起跑（harness 下一阶段第 6 步）。结果仍按模型给出的顺序落盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPool, runTurn } from '../src/agent.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

test('mapPool：同时最多 4 个，返回值按下标', async () => {
  let current = 0;
  let max = 0;
  const out = await mapPool([1, 2, 3, 4, 5, 6], 4, async (n) => {
    current += 1;
    max = Math.max(max, current);
    await new Promise((r) => setTimeout(r, 40));
    current -= 1;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
  assert.equal(max, 4);
});

test('同一批里的读叠在一起；写在它们后面，要等读完才开始；工具结果按调用顺序', async () => {
  const order = [];
  let open = 0;
  let maxOpen = 0;
  const root = tmpdir();
  const local = new LocalTools({ root });
  local.readFile = async (args) => {
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    order.push(`start ${args.path}`);
    await new Promise((r) => setTimeout(r, 50));
    order.push(`end ${args.path}`);
    open -= 1;
    return { content: `正文 ${args.path}`, summary: args.path };
  };
  local.prepareRun = () => {
    order.push('run');
    return { error: '这只是观察顺序' };
  };
  const ctx = {
    ui: fakeUi([]), root, mode: 'auto', maxRounds: 4, local, messages: [],
    allow: { write: true, run: true, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: 'm', effectiveContextWindow: 64000 },
    api: fakeApi([{ calls: [
      { name: 'read_file', args: { path: 'a.js' } },
      { name: 'read_file', args: { path: 'b.js' } },
      { name: 'run_command', args: { command: 'node', args: ['a.js'] } },
    ] }, { text: '看完了' }]),
  };
  await runTurn(ctx, '读两个再跑');
  const startA = order.indexOf('start a.js');
  const startB = order.indexOf('start b.js');
  const endA = order.indexOf('end a.js');
  const runAt = order.indexOf('run');
  assert.ok(startA >= 0 && startB >= 0 && startB < endA, `两次读要叠上：${order.join(' ')}`);
  assert.equal(maxOpen, 2);
  assert.ok(runAt > order.indexOf('end a.js') && runAt > order.indexOf('end b.js'), `写要等读完：${order.join(' ')}`);
  const tools = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(tools[0], /正文 a\.js/);
  assert.match(tools[1], /正文 b\.js/);
  assert.match(tools[2], /这只是观察顺序/);
});
