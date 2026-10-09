// Ctrl+C / Ctrl+D 的暴力测试（第十三轮）。真终端里连按、在确认提问时按 —— 先在真 pty 里实测出来，再在这里钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { Ui } from '../src/ui.js';
import { interruptHandler, STOP_GRACE_MS } from '../src/cli.js';
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
  return { ui, vt, input };
}
const tick = () => new Promise((r) => setImmediate(r));
async function type(input, text) { input.write(text); await tick(); await tick(); }

test('确认提问时 Ctrl+C：问题作废（按不同意），屏幕上留一行「（取消）」；接着打的话不再被当成回答吃掉', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  const answer = ui.ask('写入 b.js？[y/n] › ', { fresh: true });
  await tick();
  await type(input, 'y');                      // 打了一半，还没回车
  const controller = new AbortController();
  interruptHandler(ui, () => controller)();
  assert.equal(await answer, null, '问题应当作废（choose 把 null 当成不同意）');
  assert.ok(controller.signal.aborted);
  const text = vt.lines().join('\n');
  assert.match(text, /写入 b\.js？\[y\/n\] › （取消）/, text);
  assert.equal(ui.rl.line, '', '答了一半的「y」不该留到下一个提示符上');
  await type(input, '还在吗\r');
  assert.deepEqual(ui.queue, ['还在吗'], '作废之后打的话是一条新消息，不是对旧问题的回答');
  ui.close();
});

test('没在问的时候 Ctrl+C：不动排队的消息、不作废普通的输入等待', async () => {
  const { ui, input } = tty();
  const main = ui.ask('› ');
  await tick();
  ui.cancelQuestion();
  await type(input, '你好\r');
  assert.equal(await main, '你好', '主提示符上的等待不是确认问题，不该被作废');
  ui.close();
});

test('确认提问时 Ctrl+D：按不同意算；之后这一轮照常收尾，但不再读终端（原来收尾时重画输入行把 stdin 又打开了，进程退不出去）', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  const answer = ui.ask('写入 b.js？[y/n] › ', { fresh: true });
  await tick();
  await type(input, '\u0004');
  assert.equal(await answer, null);
  assert.ok(ui.closed);
  assert.ok(input.isPaused(), 'readline 关的时候应当把输入停下');
  ui.write('好。\n');                          // 这一轮的收尾：模型的最后一句
  ui.setStatus('思考中');
  ui.setStatus('');
  assert.ok(input.isPaused(), '关了之后再画活动区不许把输入流重新打开 —— 打开了进程就永远不退');
  assert.match(vt.lines().join('\n'), /写入 b\.js？\[y\/n\] › （输入结束，按不同意算）/);
  ui.close();
});

test('连按 Ctrl+C 想让它停下：第一下停下这一轮，紧跟着的几下不算退出；已经在停了不重复打「已中断」', () => {
  const lines = [];
  let closed = 0;
  const ui = { line: (t) => lines.push(t.trim()), close: () => { closed += 1; }, cancelQuestion: () => {}, unqueue: () => {}, paint: { yellow: (t) => t, dim: (t) => t } };
  let now = 1000;
  let running = new AbortController();
  const onCtrlC = interruptHandler(ui, () => running, () => now);
  onCtrlC();
  now += 50; onCtrlC();                          // 命令还在收尾，这一轮还没结束
  assert.deepEqual(lines, ['（已中断）'], '已经在停了，再按不该再打一行');
  running = null;                               // 这一轮结束了
  now += 100; onCtrlC();
  now += 100; onCtrlC();
  assert.equal(closed, 0, `停下之后 ${STOP_GRACE_MS}ms 内的 Ctrl+C 是同一次「停下」，不该退出`);
  now += STOP_GRACE_MS; onCtrlC();
  assert.equal(lines.at(-1), '（再按一次 Ctrl+C 退出，或者输入 /exit）');
  now += 500; onCtrlC();
  assert.equal(closed, 1, '空闲时两秒内按两下照样退出');
});

test('空闲时按一下提示、隔很久再按一下还是提示（不是退出）', () => {
  const lines = [];
  let closed = 0;
  const ui = { line: (t) => lines.push(t.trim()), close: () => { closed += 1; }, cancelQuestion: () => {}, unqueue: () => {}, paint: { yellow: (t) => t, dim: (t) => t } };
  let now = 1000;
  const onCtrlC = interruptHandler(ui, () => null, () => now);
  onCtrlC();
  now += 5000; onCtrlC();
  assert.equal(closed, 0);
  assert.equal(lines.length, 2);
});

test('干活时排了消息再按 Ctrl+C：排队的放回输入框、不自动发出；正打着的字接在后面', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  await type(input, '顺便改个颜色\r');
  await type(input, '再加个分数\r');
  await type(input, '还有');
  assert.deepEqual(ui.queue, ['顺便改个颜色', '再加个分数']);
  const controller = new AbortController();
  interruptHandler(ui, () => controller)();
  assert.deepEqual(ui.queue, [], 'Ctrl+C 之后不该还有排队的消息等着自动发出去');
  assert.match(ui.rl.line, /^\[粘贴 #\d+ · 2 行\] 还有$/, ui.rl.line);
  assert.ok(!vt.lines().join('\n').includes('⋯ 排队'), `排队那几行应当跟着收起：\n${vt.lines().join('\n')}`);
  assert.match(vt.lines().at(-1), /^› \[粘贴 #\d+ · 2 行\] 还有$/, `输入框应当还在、里面是放回来的消息：\n${vt.lines().join('\n')}`);
  ui.endLive();
  const next = ui.ask('› ');
  await type(input, '\r');
  assert.equal(await next, '顺便改个颜色\n再加个分数 还有', '回车发出的是原文');
  ui.close();
});

test('只排了一条短的：原样放回输入框', async () => {
  const { ui, input } = tty();
  ui.beginLive();
  await type(input, '顺便改个颜色\r');
  interruptHandler(ui, () => new AbortController())();
  assert.equal(ui.rl.line, '顺便改个颜色');
  ui.close();
});

test('unqueue 自己把活动区画回来（不指望调用方接着打印一行来顺带重画）', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  ui.setStatus('思考中');
  await type(input, '顺便改个颜色\r');
  ui.unqueue();
  assert.deepEqual(vt.lines(), ['思考中', '› 顺便改个颜色']);
  ui.close();
});
