// 两件用户在真终端里碰到的事（2026-09-27）：
//   1. 「输入之后、显示模型处理之前，输入框会短暂不见」—— 活动区每次重画原来是分几次写的（先擦、再打输出、再画回输入行），
//      终端在两次写之间刷一帧，那一帧里没有输入框。等模型时状态行每秒刷新一次，流式输出每个增量一次，于是一直在闪。
//   2. 粘贴一段多行文字（报错、需求）被拆成好几条消息：第一行立刻发出去，其余每一行各排成一轮。
// 判据用迷你终端模拟器（test/vt.js），并且<b>按每一次 write 分别回放</b> —— 只看最终屏幕的话，分几次写和一次写完长得一样。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { Ui, briefInput } from '../src/ui.js';
import { Vt } from './vt.js';

function tty(cols = 40, commands = []) {
  const chunks = [];
  const output = new Writable({ write(chunk, _e, cb) { chunks.push(chunk.toString()); cb(); } });
  output.columns = cols;
  output.isTTY = true;
  const input = new PassThrough();
  input.isTTY = true;
  const ui = new Ui({ input, output, color: false, interactive: true, commands });
  ui.start();
  const vt = new Vt(cols);
  let fed = 0;
  const screen = () => { for (; fed < chunks.length; fed++) vt.feed(chunks[fed]); return vt.lines(); };
  return { ui, input, chunks, vt, screen };
}
const tick = () => new Promise((r) => setImmediate(r));
async function type(input, text) { input.write(text); await tick(); await tick(); }
const PASTE = (s) => `\u001b[200~${s}\u001b[201~`;

test('活动区每次重画都一次写完：任何一次写之后，最底下都还是输入行（原来先擦再画，中间那一刻输入框不见）', async () => {
  const { ui, input, chunks } = tty();
  const vt = new Vt(40);
  let fed = 0;
  for (; fed < chunks.length; fed++) vt.feed(chunks[fed]);   // 活动区开始之前写的（开括号粘贴）不算
  ui.beginLive();
  await type(input, '下一句');
  const gaps = [];
  const check = (label) => {
    for (; fed < chunks.length; fed++) {
      vt.feed(chunks[fed]);
      const bottom = vt.lines().at(-1) || '';
      // 输入行：主提示符，或者正在问的确认问题本身（它就是那一刻的输入行）
      if (!bottom.startsWith('›') && !bottom.startsWith('写入 a.js？')) gaps.push(`${label}：第 ${fed + 1} 次写之后最底下是「${bottom}」`);
    }
  };
  check('开始');
  for (let s = 1; s <= 5; s++) { ui.setStatus(`… 等待模型回复 ${s}s`); check('等待模型的状态行'); }
  ui.setStatus(''); check('清掉状态行');
  for (const d of ['第一', '段回答\n第二', '段\n']) { ui.write(d); check('流式输出'); }
  ui.step('读取 a.js'); check('step');
  ui.result('20 行'); check('result');
  await type(input, '\r'); check('排队');
  const answer = ui.ask('写入 a.js？[y/n] › ', { fresh: true });
  await tick(); check('问确认');
  await type(input, 'y\r'); check('答确认');
  assert.equal(await answer, 'y');
  assert.deepEqual(gaps, [], `输入框在这些时刻不见了：\n${gaps.join('\n')}`);
  ui.close();
});

test('重画包在「同步输出」里：支持的终端（iTerm2、Windows Terminal、VS Code…）整块换帧，不支持的忽略这两个序列', async () => {
  const { ui, chunks } = tty();
  ui.beginLive();
  const before = chunks.length;
  ui.setStatus('… 等待模型回复 1s');
  const frame = chunks.slice(before).join('');
  assert.equal(chunks.length - before, 1, '一次状态刷新应当只有一次写');
  assert.ok(frame.startsWith('\u001b[?2026h') && frame.endsWith('\u001b[?2026l'), JSON.stringify(frame));
  ui.close();
});

test('粘贴多行（终端的括号粘贴）：输入行里是一个占位，回车之后发出去的是完整原文，一条消息', async () => {
  const { ui, input, screen } = tty(60);
  const got = ui.ask('› ');
  await type(input, PASTE('这段报错帮我看看：\rTypeError: x is undefined\r    at foo (a.js:3)\r    at bar (a.js:9)'));
  assert.match(ui.rl.line, /^\[粘贴 #\d+ · 4 行\]$/, `输入行：${ui.rl.line}`);
  await type(input, ' 谢谢\r');
  assert.equal(await got, '这段报错帮我看看：\nTypeError: x is undefined\n    at foo (a.js:3)\n    at bar (a.js:9) 谢谢');
  assert.deepEqual(ui.queue, [], '粘贴的其余几行被拆成了单独的消息');
  assert.ok(screen().some((l) => /› \[粘贴 #\d+ · 4 行\] 谢谢/.test(l)), screen().join('\n'));
  ui.close();
});

test('粘贴一行短文字：原样进输入行（不用占位）；很长的一行也用占位', async () => {
  const { ui, input } = tty(60);
  const got = ui.ask('› ');
  await type(input, PASTE('npm test'));
  assert.equal(ui.rl.line, 'npm test');
  await type(input, PASTE('x'.repeat(3000)));
  assert.match(ui.rl.line, /^npm test\[粘贴 #\d+ · 3000 字\]$/);
  await type(input, '\r');
  assert.equal(await got, `npm test${'x'.repeat(3000)}`);
  ui.close();
});

test('终端不支持括号粘贴（旧的 Windows 控制台）：同一批到达的几行合成一条；一行一行打的照旧是几条', async () => {
  const { ui, input } = tty(60);
  const first = ui.ask('› ');
  await type(input, '第一行\r第二行\r第三行\r');
  assert.equal(await first, '第一行\n第二行\n第三行');
  assert.deepEqual(ui.queue, []);
  const a = ui.ask('› ');
  await type(input, '一句\r');
  assert.equal(await a, '一句');
  const b = ui.ask('› ');
  await type(input, '另一句\r');
  assert.equal(await b, '另一句');
  ui.close();
});

test('干活时粘贴多行：排成一条（不是每行一轮），排队那一行只显示一行摘要，不把活动区撑乱', async () => {
  const { ui, input, screen } = tty(50);
  ui.beginLive();
  ui.write('正在写 snake.js\n');
  await type(input, PASTE('再改三处：\r1. 颜色\r2. 速度\r3. 计分'));
  await type(input, '\r');
  assert.deepEqual(ui.queue, ['再改三处：\n1. 颜色\n2. 速度\n3. 计分']);
  await type(input, '甲\r乙\r');
  assert.deepEqual(ui.queue, ['再改三处：\n1. 颜色\n2. 速度\n3. 计分', '甲\n乙'], '没有括号粘贴时同一批到达的两行也该是一条');
  ui.write('写好了\n');
  const lines = screen();
  assert.deepEqual(lines.slice(-4), ['写好了', '⋯ 排队：再改三处： …（共 4 行）', '⋯ 排队：甲 …（共 2 行）', '›'], lines.join('\n'));
  ui.close();
});

test('干活时粘贴一大段：擦的是屏幕上那一行（占位），不是展开后的原文 —— 按原文算会把上面已经打印的输出擦掉', async () => {
  const { ui, input, screen } = tty(40);
  ui.beginLive();
  ui.write('第一行输出\n第二行输出\n');
  const long = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 行：${'很长的报错内容'.repeat(3)}`).join('\r');
  await type(input, PASTE(long));
  await type(input, '\r');
  assert.equal(ui.queue.length, 1);
  ui.write('第三行输出\n');
  const lines = screen();
  assert.deepEqual(lines.slice(0, 3), ['第一行输出', '第二行输出', '第三行输出'], lines.join('\n'));
  ui.close();
});

test('确认问题（y/n）不参与合并：答的就是那一行', async () => {
  const { ui, input } = tty(60);
  ui.beginLive();
  const answer = ui.ask('写入 a.js？[y/n] › ', { fresh: true });
  await tick();
  await type(input, 'y\r');
  assert.equal(await answer, 'y');
  ui.close();
});

test('briefInput：多行 / 很长的输入在记录里只留一行摘要', () => {
  assert.equal(briefInput('一句话'), '一句话');
  assert.equal(briefInput('第一行\n第二行'), '第一行 …（共 2 行）');
  assert.equal(briefInput('x'.repeat(300)), `${'x'.repeat(60)}… （共 300 字）`);
});

test('开着括号粘贴，退出时关掉（否则留给 shell 一个它没开的模式）', async () => {
  const { ui, chunks } = tty();
  assert.ok(chunks.join('').includes('\u001b[?2004h'));
  ui.close();
  assert.ok(chunks.join('').endsWith('\u001b[?2004l'), JSON.stringify(chunks.slice(-2)));
});
