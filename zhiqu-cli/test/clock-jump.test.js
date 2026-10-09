// 系统时钟跳了（第二十一轮）：校时、手动改时间、休眠醒来后同步。量「过了多久」的地方不能跟着跳 ——
// 往回跳一小时，「思考中」原来显示 -3600s；往前跳，5 秒的搜索预算一下子就「用完了」。这里把 Date.now 换成一个会跳的钟来演。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { Ui } from '../src/ui.js';
import { LocalTools } from '../src/tools/local.js';
import { runProcess } from '../src/tools/exec.js';
import { Vt } from './vt.js';
import { tmpdir, write } from './helpers.js';

/** 在 fn 执行期间让 Date.now() 从真实时间偏开 offset 毫秒。 */
async function withClockJump(offset, fn) {
  const real = Date.now;
  Date.now = () => real() + offset;
  try { return await fn(); } finally { Date.now = real; }
}

test('思考中的秒数不跟着系统时钟往回跳（原来往回拨一小时就是「思考中 -3600s」）', async () => {
  const vt = new Vt(60);
  const output = new Writable({ write(chunk, _e, cb) { vt.feed(chunk.toString()); cb(); } });
  output.columns = 60; output.isTTY = true;
  const input = new PassThrough(); input.isTTY = true;
  const ui = new Ui({ input, output, color: false, interactive: true });
  ui.start();
  ui.beginLive();
  ui.startThinking();
  await withClockJump(-3600 * 1000, () => ui.thinkingTick());
  const status = vt.lines().find((l) => l.includes('思考中'));
  assert.ok(status, vt.lines().join('\n'));
  assert.match(status, /思考中 \d+s/, status);
  assert.doesNotMatch(status, /-\d/, status);
  await withClockJump(24 * 3600 * 1000, () => ui.thinkingTick());
  assert.doesNotMatch(vt.lines().find((l) => l.includes('思考中')), /思考中 \d{3,}s/, '往前跳一天也不该变成「思考中 86400s」');
  ui.stopThinking();
  ui.close();
});

test('搜索的时间预算不跟着系统时钟往前跳（原来一跳就「搜了 5 秒还没搜完」，其实一个文件都没搜）', async () => {
  const root = tmpdir();
  for (let i = 0; i < 30; i++) write(root, `src/f${i}.js`, `const v${i} = 'needle';\n`);
  const t = new LocalTools({ root });
  const r = await withClockJump(0, () => {
    // 搜索开始之后才跳：第一次读 Date.now() 是真的，之后每次都快一小时
    const real = Date.now;
    let calls = 0;
    Date.now = () => real() + (calls++ > 0 ? 3600 * 1000 : 0);
    return t.search({ query: 'needle' });
  });
  assert.doesNotMatch(r.content, /还没搜完/, r.content);
  assert.equal((r.content.match(/needle/g) || []).length, 30, r.content);
});

test('跑命令记下的耗时不会是负数（原来时钟往回拨时 millis 是负的）', async () => {
  const root = tmpdir();
  const real = Date.now;
  let calls = 0;
  Date.now = () => real() - (calls++ > 0 ? 3600 * 1000 : 0);
  try {
    const r = await runProcess({ binary: process.execPath, args: ['-e', ''], cwd: root, timeoutMs: 10_000 });
    assert.equal(r.exitCode, 0, r.output);
    assert.ok(r.millis >= 0, `耗时 ${r.millis}ms`);
  } finally {
    Date.now = real;
  }
});
