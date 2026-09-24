// 输入框一直在：agent 干活时底部固定一块活动区（流式的半行、排队的消息、状态行、输入行），
// 输出从它上面滚过去，正在打的字不动。用迷你终端模拟器（test/vt.js）逐字节执行输出，判最终屏幕长什么样。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { Ui } from '../src/ui.js';
import { Vt } from './vt.js';

function tty(cols = 40) {
  const vt = new Vt(cols);
  const output = new Writable({ write(chunk, _e, cb) { vt.feed(chunk.toString()); cb(); } });
  output.columns = cols;
  output.isTTY = true;
  const input = new PassThrough();
  input.isTTY = true;
  const ui = new Ui({ input, output, color: false, interactive: true });
  ui.start();
  return { ui, vt, input };
}
const tick = () => new Promise((r) => setImmediate(r));
async function type(input, text) { input.write(text); await tick(); await tick(); }

test('干活时输入框一直在最底下；输出从它上面过去；打了一半的字不动', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  await type(input, '下一个问题');
  ui.write('第一段输出还没换行');
  ui.write('，接着\n第二行');
  ui.setStatus('… 等待 3s');
  assert.deepEqual(vt.lines(), ['第一段输出还没换行，接着', '第二行', '… 等待 3s', '› 下一个问题']);
  assert.equal(ui.rl.line, '下一个问题');
  ui.write('还在写\n');
  ui.setStatus('');
  assert.deepEqual(vt.lines(), ['第一段输出还没换行，接着', '第二行还在写', '› 下一个问题'], '状态行清掉后不该留残影');
  ui.close();
});

test('干活时按回车：这句话排队（显示在输入框上方），输入框清空，输出照常', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  ui.write('正在写 snake.js\n');
  await type(input, '再加一个计分板\r');
  assert.deepEqual(ui.queue, ['再加一个计分板']);
  ui.write('写好了\n');
  assert.deepEqual(vt.lines(), ['正在写 snake.js', '写好了', '⋯ 排队：再加一个计分板', '›']);
  ui.close();
});

test('权限确认：输入框换成问题；排队的消息不是答案；答完输入框换回来', async () => {
  const { ui, vt, input } = tty(60);
  ui.beginLive();
  await type(input, '顺便改个颜色\r');
  const answer = ui.ask('写入 a.js？[y/n] › ', { fresh: true });
  await tick();
  assert.equal(vt.lines().at(-1), '写入 a.js？[y/n] ›', '输入框应当变成问题本身');
  await type(input, 'y\r');
  assert.equal(await answer, 'y');
  assert.deepEqual(ui.queue, ['顺便改个颜色'], '排队的消息不该被当成 y/n 的回答吃掉');
  assert.equal(vt.lines().at(-1), '›');
  ui.close();
});

test('很长的一行（折行）在活动区里反复重画，不留碎片', async () => {
  const { ui, vt } = tty(20);
  ui.beginLive();
  const long = '这是一段很长很长的流式输出，会在二十列的终端里折成好几行';
  for (const ch of long) ui.write(ch);
  ui.setStatus('… 3s');
  ui.write('\n结束\n');
  ui.setStatus('');
  ui.endLive();
  const text = vt.lines().join('');
  assert.ok(text.startsWith(long + '结束'), `屏幕上有碎片或重复：\n${vt.lines().join('\n')}`);
  assert.ok(!text.includes('… 3s'));
});

test('这一轮结束：还没换行的那半行落定，活动区消失', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  await type(input, '草稿');
  ui.write('最后一句没有换行');
  ui.endLive();
  assert.deepEqual(vt.lines(), ['最后一句没有换行']);
  assert.equal(ui.rl.line, '草稿', '正在打的字要留给下一次提示');
  ui.close();
});

test('不是终端（管道、测试脚本）：不画活动区，按顺序读输入，行为和原来一样', async () => {
  let out = '';
  const input = new PassThrough();
  const output = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  const ui = new Ui({ input, output, color: false });
  input.write('y\nhello\n');
  input.end();
  ui.beginLive();
  ui.write('输出\n');
  ui.setStatus('不该出现');
  assert.equal(await ui.ask('写入？', { fresh: true }), 'y', '管道里没有「排队」这回事，按顺序拿');
  assert.equal(await ui.ask('› '), 'hello');
  assert.ok(!out.includes('不该出现') && !out.includes('\u001b['), out);
});
