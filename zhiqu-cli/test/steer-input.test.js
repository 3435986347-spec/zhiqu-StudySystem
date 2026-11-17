// 干活中途补充 · 终端这一半（第一百五十一轮，docs/steer-plan.md 第 2 步）：
// 一轮在跑时回车 = 补充给这一轮（跑完当前这一步就读到），Tab = 排到下一轮；读到时输出里留一行「↳ 补充：…」；
// 这一轮结束还没读到的放到排队最前面（成为下一句）；Ctrl+C 时和排队的一起放回输入框、不发。
// 用迷你终端模拟器（test/vt.js）逐字节执行输出，判屏幕；最后两条走 cli.js 的 turn() 真跑一轮（假模型）。
import './xterm-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { interruptHandler, turn } from '../src/cli.js';
import { SLASH_COMMANDS } from '../src/commands.js';
import { SessionStore } from '../src/session.js';
import { STEER_LEAD } from '../src/steer.js';
import { LocalTools } from '../src/tools/local.js';
import { Ui } from '../src/ui.js';
import { fakeApi, tmpdir, write } from './helpers.js';
import { Vt } from './vt.js';

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
async function type(input, text) { input.write(text); await tick(); await tick(); await tick(); }
/** 一轮在跑：收件箱是个数组 */
function running(ui, { accept = true } = {}) {
  const got = [];
  ui.steerTo = (t) => { if (!accept) return false; got.push(t); return true; };
  ui.beginLive();
  return got;
}

test('一轮在跑时回车：补充给这一轮（不排队）；输入框上方一行「下一步送到」', async () => {
  const { ui, vt, input } = tty();
  const got = running(ui);
  await type(input, '别改测试文件\r');
  assert.deepEqual(got, ['别改测试文件']);
  assert.deepEqual(ui.queue, []);
  assert.equal(ui.rl.line, '');
  assert.deepEqual(vt.lines(), ['↳ 补充（下一步送到）：别改测试文件', '›']);
  ui.close();
});

test('模型读到了：上方那行收起，输出里留一行「↳ 补充：…」', async () => {
  const { ui, vt, input } = tty();
  running(ui);
  ui.write('正在跑测试\n');
  await type(input, '别改测试文件\r');
  ui.steerDelivered(['别改测试文件']);
  assert.deepEqual(ui.steering, []);
  assert.deepEqual(vt.lines(), ['正在跑测试', '↳ 补充：别改测试文件', '›']);
  ui.close();
});

test('Tab：正在打的这句排到下一轮，不补给这一轮；菜单开着时 Tab 照旧是补全', async () => {
  const { ui, vt, input } = tty();
  const got = running(ui);
  await type(input, '下一件事：写文档');
  await type(input, '\t');
  assert.deepEqual(got, []);
  assert.deepEqual(ui.queue, ['下一件事：写文档']);
  assert.equal(ui.rl.line, '');
  assert.deepEqual(vt.lines(), ['⋯ 排队：下一件事：写文档', '›']);
  await type(input, '\t');
  assert.equal(ui.rl.line, '', '空的 Tab 吞掉，不插制表符');
  await type(input, '/compa');
  assert.ok(ui.menu, '干活时打 / 也弹菜单');
  await type(input, '\t');
  assert.equal(ui.rl.line, '/compact ', '菜单开着时 Tab 是补全');
  assert.deepEqual(ui.queue, ['下一件事：写文档']);
  ui.close();
});

test('打命令（/ 开头）照旧排队；这一轮在收尾（箱子关了）时回车也退回排队', async () => {
  const { ui, input } = tty();
  const got = running(ui);
  await type(input, '/compact\r');
  assert.deepEqual(got, []);
  assert.deepEqual(ui.queue, ['/compact']);
  ui.close();

  const closed = tty();
  running(closed.ui, { accept: false });
  await type(closed.input, '晚到的一句\r');
  assert.deepEqual(closed.ui.queue, ['晚到的一句']);
  assert.deepEqual(closed.ui.steering, []);
  closed.ui.close();
});

test('同一批到的几行（不支持括号粘贴的终端粘进来的）合成一句补充', async () => {
  const { ui, input } = tty();
  const got = running(ui);
  await type(input, '第一行\r第二行\r');
  assert.deepEqual(got, ['第一行\n第二行']);
  ui.close();
});

test('正在问确认时回车是回答，不是补充', async () => {
  const { ui, input } = tty();
  const got = running(ui);
  const answer = ui.ask('写入 a.js？[y/n] › ', { fresh: true });
  await tick();
  await type(input, 'y\r');
  assert.equal(await answer, 'y');
  assert.deepEqual(got, []);
  ui.close();
});

test('没给 steerTo（/goal、/review 那几种）：回车照旧排队', async () => {
  const { ui, input } = tty();
  ui.beginLive();
  await type(input, '顺便改个颜色\r');
  assert.deepEqual(ui.queue, ['顺便改个颜色']);
  assert.deepEqual(ui.steering, []);
  ui.close();
});

test('Ctrl+C：没读到的补充和排队的一起放回输入框（补充在前），不自动发；之后回车是排队', async () => {
  const { ui, input } = tty();
  const got = running(ui);
  await type(input, '先补一句\r');
  await type(input, '下一件事\t');
  const controller = new AbortController();
  interruptHandler(ui, () => controller)();
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(ui.queue, []);
  assert.deepEqual(ui.steering, []);
  assert.match(ui.rl.line, /^\[粘贴 #\d+ · 2 行\]$/);
  assert.equal(ui.expandPastes(ui.rl.line), '先补一句\n下一件事');
  ui.setLine('');
  await type(input, '再说一句\r');
  assert.deepEqual(got, ['先补一句'], '停下之后不再补给这一轮');
  assert.deepEqual(ui.queue, ['再说一句']);
  ui.close();
});

test('Ctrl+C 放回输入框之后，光标在末尾：接着打的字接在后面（原来回到行首、打在前面）', async () => {
  const { ui, input } = tty();
  running(ui);
  await type(input, '先补一句\r');
  interruptHandler(ui, () => new AbortController())();
  ui.endLive();
  const next = ui.ask('› ');
  await tick();
  await type(input, '，再加一句\r');
  assert.equal(await next, '先补一句，再加一句');
  ui.close();
});

// ── 真跑一轮：cli.js 的 turn() ────────────────────────────────────────────

function turnCtx({ ui, input, replies, typing }) {
  const root = tmpdir();
  write(root, 'a.txt', 'A');
  const store = new SessionStore(root);
  const api = fakeApi(replies);
  const stream = api.stream.bind(api);
  api.stream = async (...args) => {
    const n = api.requests.length;
    if (typing[n]) await type(input, typing[n]);   // 模型正在想的时候用户打了一句
    return stream(...args);
  };
  return {
    ui, api, root, mode: 'auto', maxRounds: 40,
    local: new LocalTools({ root, commands: ['node'] }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 64_000 }, archiveDisabled: true,
  };
}

test('turn()：读文件的时候回车补一句 —— 下一次问模型就带着它，屏幕上留「↳ 补充」；这一轮结束不剩东西', async () => {
  const { ui, vt, input } = tty(80);
  const ctx = turnCtx({ ui, input, replies: [{ calls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: '按你说的只看了 a' }], typing: { 0: '只看 a.txt\r' } });
  await turn(ctx, '看看文件', () => {});
  assert.equal(ctx.api.requests.length, 2);
  const last = ctx.api.requests[1].messages.at(-1);
  assert.ok(last.content.startsWith(STEER_LEAD) && last.content.includes('只看 a.txt'));
  assert.ok(vt.lines().some((l) => l === '↳ 补充：只看 a.txt'), vt.lines().join('\n'));
  assert.deepEqual(ui.queue, []);
  assert.deepEqual(ui.steering, []);
  assert.equal(ui.steerTo, null, '一轮结束，回车不再补给它');
  assert.equal(ctx.onSteer, null);
  ui.close();
});

test('turn()：最后一步才补、没赶上 —— 放到排队最前面，成为下一句', async () => {
  const { ui, input } = tty(80);
  const ctx = turnCtx({ ui, input, replies: [{ text: '收尾了' }], typing: { 0: '再加个测试\r' } });
  ctx.maxRounds = 1;
  await type(input, '');
  await turn(ctx, '做', () => {});
  assert.deepEqual(ui.queue, ['再加个测试']);
  assert.equal(ctx.api.requests.length, 1);
  ui.close();
});
