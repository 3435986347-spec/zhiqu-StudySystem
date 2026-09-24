// 输入 / 弹出命令菜单：输入行上方列出匹配的命令，↑↓ 选、回车执行、Tab 补全、Esc 关掉、接着打字接着筛。
// 用迷你终端模拟器（test/vt.js）逐字节回放，判屏幕长什么样、回车交出去的是哪一行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { Ui } from '../src/ui.js';
import { SLASH_COMMANDS, matchCommands, slashHelp } from '../src/commands.js';
import { Vt } from './vt.js';

const UP = '\u001b[A';
const DOWN = '\u001b[B';

function tty(cols = 60) {
  const vt = new Vt(cols);
  const output = new Writable({ write(chunk, _e, cb) { vt.feed(chunk.toString()); cb(); } });
  output.columns = cols;
  output.isTTY = true;
  const input = new PassThrough();
  input.isTTY = true;
  const ui = new Ui({ input, output, color: false, interactive: true, commands: SLASH_COMMANDS });
  ui.start();
  return { ui, vt, input };
}
const tick = () => new Promise((r) => setImmediate(r));
async function type(input, text) { input.write(text); await tick(); await tick(); }
// 菜单只画在输入行上方：最后一行是输入行本身（续行提示符是两个空格，「  /mode」长得和菜单项一样）
const menuRows = (vt) => vt.lines().slice(0, -1).filter((l) => /^[❯ ] \/\w/.test(l));
const selected = (vt) => (vt.lines().find((l) => l.startsWith('❯ ')) || '').split(/\s+/)[1];

test('打 / 弹出菜单（在输入行上方）；接着打字接着筛', async () => {
  const { ui, vt, input } = tty();
  ui.line('上一轮的输出');
  const got = ui.ask('› ');
  await tick();
  await type(input, '/');
  const lines = vt.lines();
  assert.equal(lines[0], '上一轮的输出', '菜单不能吃掉上面的输出');
  assert.equal(lines.at(-1), '› /', '输入行在最下面');
  assert.ok(menuRows(vt).length >= 5, `菜单没弹出来：\n${lines.join('\n')}`);
  assert.equal(selected(vt), '/goal', '默认选中第一个');
  assert.match(lines.at(-2), /↑↓ 选择 · 回车执行 · Tab 补全 · Esc 关闭/);

  await type(input, 'mo');
  assert.deepEqual(menuRows(vt).map((l) => l.split(/\s+/)[1]), ['/mode', '/model'], '只剩匹配的');
  assert.equal(vt.lines().at(-1), '› /mo');
  ui.close();
  await got;
});

test('↓ 选下一个，回车执行选中的那一个；菜单收起，屏幕上留下「› /model」', async () => {
  const { ui, vt, input } = tty();
  const got = ui.ask('› ');
  await tick();
  await type(input, '/mo');
  await type(input, DOWN);
  assert.equal(selected(vt), '/model');
  await type(input, UP);
  assert.equal(selected(vt), '/mode', '↑ 回到上一个');
  await type(input, UP);
  assert.equal(selected(vt), '/model', '到顶再按 ↑ 转到最后一个');
  await type(input, '\r');
  assert.equal(await got, '/model');
  assert.equal(menuRows(vt).length, 0, `回车之后菜单还在：\n${vt.lines().join('\n')}`);
  assert.ok(vt.lines().includes('› /model'), vt.lines().join('\n'));
  ui.close();
});

test('Tab 把选中的补进输入框、留一个空格接着打参数；回车交出去的是整行', async () => {
  const { ui, vt, input } = tty();
  const got = ui.ask('› ');
  await tick();
  await type(input, '/go\t');
  assert.equal(ui.rl.line, '/goal ');
  assert.equal(menuRows(vt).length, 0, '打了空格就不再弹');
  await type(input, '写一个贪吃蛇\r');
  assert.equal(await got, '/goal 写一个贪吃蛇');
  ui.close();
});

test('Esc 关掉菜单，原样不再弹；接着打字又弹', async () => {
  const { ui, vt, input } = tty();
  const got = ui.ask('› ');
  await tick();
  await type(input, '/m');
  assert.ok(menuRows(vt).length > 0);
  input.write('\u001b');
  await new Promise((r) => setTimeout(r, 700));   // readline 等一会儿才确认单独的 Esc 不是转义序列的开头
  assert.equal(menuRows(vt).length, 0, `Esc 之后菜单还在：\n${vt.lines().join('\n')}`);
  assert.equal(vt.lines().at(-1), '› /m');
  await type(input, '\u001b[D');   // ← 只挪光标，输入没变：关掉的菜单不该自己回来
  assert.equal(menuRows(vt).length, 0, '挪了一下光标菜单又弹回来了');
  await type(input, '\u001b[C');
  await type(input, 'c');
  assert.deepEqual(menuRows(vt).map((l) => l.split(/\s+/)[1]), ['/mcp']);
  ui.close();
  await got;
});

test('菜单没开时一切照旧：没有匹配的命令不弹、回车照原样交出去；不是 / 开头不弹', async () => {
  const { ui, vt, input } = tty();
  let got = ui.ask('› ');
  await tick();
  await type(input, '/zzz');
  assert.equal(menuRows(vt).length, 0);
  await type(input, '\r');
  assert.equal(await got, '/zzz');
  got = ui.ask('› ');
  await tick();
  await type(input, '帮我看看 /mode 是什么\r');
  assert.equal(await got, '帮我看看 /mode 是什么');
  assert.equal(menuRows(vt).length, 0);
  ui.close();
});

test('续行提示符下（行尾 \\ 换行接着打）不弹：那一行是消息正文，不是命令', async () => {
  const { ui, vt, input } = tty();
  const got = ui.ask('  ');
  await tick();
  await type(input, '/mode');
  assert.equal(menuRows(vt).length, 0);
  await type(input, '\r');
  assert.equal(await got, '/mode');
  ui.close();
});

test('干活时（活动区里）打 / 也弹，在状态行下面、输入行上面；回车 = 排队这条命令', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  ui.write('正在写 snake.js\n');
  ui.setStatus('… 等待 3s');
  await type(input, '/us');
  const lines = vt.lines();
  assert.equal(lines[0], '正在写 snake.js');
  assert.equal(lines[1], '… 等待 3s');
  assert.equal(selected(vt), '/usage');
  await type(input, '\r');
  assert.deepEqual(ui.queue, ['/usage']);
  assert.equal(menuRows(vt).length, 0);
  assert.equal(vt.lines().at(-1), '›');
  ui.close();
});

test('命令多于一屏：只画 8 行，选中的那一个一直看得见', async () => {
  const { ui, vt, input } = tty();
  const got = ui.ask('› ');
  await tick();
  await type(input, '/');
  assert.equal(menuRows(vt).length, 8);
  for (let i = 0; i < 10; i++) await type(input, DOWN);
  assert.equal(selected(vt), SLASH_COMMANDS[10].name);
  assert.equal(menuRows(vt).length, 8);
  assert.match(vt.lines().at(-2), new RegExp(`共 ${SLASH_COMMANDS.length} 个`));
  ui.close();
  await got;
});

test('窄终端：长说明截断成一行（一项一行，菜单不散），不留碎片', async () => {
  const { ui, vt, input } = tty(24);
  ui.line('上面的输出');
  const got = ui.ask('› ');
  await tick();
  await type(input, '/');
  await type(input, 'g');
  await type(input, '\u007f');   // 退格
  await type(input, 'm');
  const lines = vt.lines();
  assert.equal(lines[0], '上面的输出');
  assert.deepEqual(menuRows(vt).map((l) => l.split(/\s+/)[1]), ['/mode', '/model', '/mcp']);
  assert.equal(lines.length, 1 + 3 + 1 + 1, `一项一行（上面的输出 + 3 项 + 提示 + 输入行），说明折行了：\n${lines.join('\n')}`);
  assert.ok(menuRows(vt).every((l) => l.endsWith('…')), '长说明要截断并标出来');
  assert.equal(lines.filter((l) => l.startsWith('› ')).length, 1, `输入行留下了碎片：\n${lines.join('\n')}`);
  ui.close();
  await got;
});

test('/help 与菜单同一份清单；matchCommands 只认「/ 开头、没空格」', () => {
  const help = slashHelp();
  for (const c of SLASH_COMMANDS) assert.ok(help.includes(c.name), `/help 里没有 ${c.name}`);
  assert.deepEqual(matchCommands('/mo').map((c) => c.name), ['/mode', '/model']);
  assert.deepEqual(matchCommands('/mode plan'), []);
  assert.deepEqual(matchCommands('mode'), []);
});

test('接着打字筛选时，选中的那一个还在就一直选着它', async () => {
  const { ui, vt, input } = tty();
  const got = ui.ask('› ');
  await tick();
  await type(input, '/mo');
  await type(input, DOWN);
  assert.equal(selected(vt), '/model');
  await type(input, 'd');
  assert.equal(selected(vt), '/model', '多打一个字，选中的跳回了第一个');
  ui.close();
  await got;
});

test('菜单开着时有东西要打印（比如 Ctrl+C 的提示）：菜单收起、提示打出来、输入行原样画回来', async () => {
  const { ui, vt, input } = tty();
  const got = ui.ask('› ');
  await tick();
  await type(input, '/mo');
  ui.line('（再按一次 Ctrl+C 退出，或者输入 /exit）');
  const lines = vt.lines();
  assert.equal(menuRows(vt).length, 0, `菜单还在：\n${lines.join('\n')}`);
  assert.ok(lines.includes('（再按一次 Ctrl+C 退出，或者输入 /exit）'), lines.join('\n'));
  assert.equal(lines.at(-1), '› /mo', '正在打的字要画回来');
  assert.equal(lines.filter((l) => l.startsWith('› ')).length, 1, `留下了碎片：\n${lines.join('\n')}`);
  ui.close();
  await got;
});
