// 同一个调用、同样的结果连着来（第一百零四轮）：用户贴的记录里 deepseek-flash 把一条每次都打印 ok 的 node -e 连跑了 94 次，又一版 64 次。
// 循环防的是同样的失败和连续只读，成功的重复谁都不管。第 3 次提醒，第 5 次起不执行，第 7 次停下这一轮。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPEAT_REFUSE, REPEAT_STOP, REPEAT_WARN, runTurn } from '../src/agent.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

function makeCtx({ replies, root = tmpdir() } = {}) {
  const store = new SessionStore(root);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds: 40,
    local: new LocalTools({ root, commands: ['node'] }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 64_000 },
  };
}
const toolTexts = (ctx) => ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
const run = (args) => ({ calls: [{ name: 'run_command', args }] });
// 每次都打印 ok；跑了几次记在文件里（看得出有没有真的执行）。第 2 次多等 0.3 秒：结果里的用时不一样，不该算结果变了
const COUNTER = `
const fs = require('fs');
const n = fs.existsSync('count.txt') ? Number(fs.readFileSync('count.txt', 'utf8')) + 1 : 1;
fs.writeFileSync('count.txt', String(n));
if (n === 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
console.log(process.argv[2] === 'count' ? n : 'ok');
`;
const runs = (root) => (fs.existsSync(path.join(root, 'count.txt')) ? Number(fs.readFileSync(path.join(root, 'count.txt'), 'utf8')) : 0);

test('一模一样的成功连着来（用户的记录）：第 3 次提醒，第 5 次起不执行，第 7 次停下、照实说；调用和结果照样成对', async () => {
  assert.deepEqual([REPEAT_WARN, REPEAT_REFUSE, REPEAT_STOP], [3, 5, 7]);
  const root = tmpdir();
  write(root, 'c.js', COUNTER);
  const same = run({ command: 'node', args: ['c.js'] });
  const ctx = makeCtx({ root, replies: [...Array(30).fill(same), { text: '不该调到这里' }] });
  const r = await runTurn(ctx, '看看哪里错了');
  const tools = toolTexts(ctx);
  assert.equal(ctx.api.requests.length, 7, '第 7 次就该停下，不再问模型');
  assert.equal(runs(root), 4, '第 5 次起不该真的执行');
  assert.ok(!/连续发了/.test(tools[0]) && !/连续发了/.test(tools[1]), '前两次不提醒');
  assert.match(tools[2], /连续发了 3 次.*再发一次结果也不会变/s, `用时不同也算一样：${tools[2]}`);
  assert.match(tools[3], /连续发了 4 次/);
  for (const [k, t] of tools.slice(4).entries()) assert.match(t, new RegExp(`^没有执行：这是连续第 ${k + 5} 次`));
  assert.equal(tools.length, 7);
  assert.match(r.finalText, /已经停下：模型连续 7 次发同一个调用（run_command）/);
  assert.match(ctx.ui.text(), /已经停下/);
  const ids = ctx.messages.flatMap((m) => (m.tool_calls || []).map((c) => c.id));
  assert.deepEqual(ctx.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), ids, '每个调用都要有结果（不然下一次请求供应商拒）');
});

test('结果变了不算重复：每次输出不同，跑多少次都不拦', async () => {
  const root = tmpdir();
  write(root, 'c.js', COUNTER);
  const ctx = makeCtx({ root, replies: [...Array(8).fill(run({ command: 'node', args: ['c.js', 'count'] })), { text: '好' }] });
  const r = await runTurn(ctx, '跑');
  assert.equal(runs(root), 8);
  assert.ok(!toolTexts(ctx).some((t) => /连续发了|没有执行/.test(t)));
  assert.equal(r.finalText, '好');
});

test('参数的键换个顺序还是同一个调用；中间换了别的调用就重新数', async () => {
  const root = tmpdir();
  write(root, 'c.js', COUNTER);
  const a = run({ command: 'node', args: ['c.js'] });
  const b = run({ args: ['c.js'], command: 'node' });
  const reorder = makeCtx({ root, replies: [a, b, a, { text: '好' }] });
  await runTurn(reorder, '跑');
  assert.match(toolTexts(reorder)[2], /连续发了 3 次/);

  const other = { calls: [{ name: 'read_file', args: { path: 'c.js' } }] };
  const mixed = makeCtx({ root, replies: [a, a, other, a, a, other, a, a, { text: '好' }] });
  await runTurn(mixed, '跑');
  assert.ok(!toolTexts(mixed).some((t) => /连续发了|没有执行/.test(t)), '中间换过调用');
});

test('用户新说一句就重新数（用户说「再跑一次」是真要再跑）', async () => {
  const root = tmpdir();
  write(root, 'c.js', COUNTER);
  const a = run({ command: 'node', args: ['c.js'] });
  const ctx = makeCtx({ root, replies: [a, a, { text: '跑了两次' }, a, a, { text: '又跑了两次' }] });
  await runTurn(ctx, '跑');
  await runTurn(ctx, '再跑两次');
  assert.equal(runs(root), 4);
  assert.ok(!toolTexts(ctx).some((t) => /连续发了|没有执行/.test(t)));
});

test('同样的失败连着来：只有原来那条提醒（不叠两句），第 5 次起同样不执行', async () => {
  const root = tmpdir();
  write(root, 'bad.js', 'require("fs").appendFileSync("ran.txt", "x"); console.error("boom"); process.exit(1);\n');
  const ctx = makeCtx({ root, replies: [...Array(10).fill(run({ command: 'node', args: ['bad.js'] })), { text: '不该调到这里' }] });
  await runTurn(ctx, '跑');
  const tools = toolTexts(ctx);
  assert.equal(fs.readFileSync(path.join(root, 'ran.txt'), 'utf8').length, 4);
  assert.match(tools[2], /已经连续 3 次失败/);
  assert.doesNotMatch(tools[2], /连续发了/);
  assert.match(tools[4], /^没有执行/);
  assert.equal(ctx.api.requests.length, 7);
});
