import './xterm-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { Ui } from '../src/ui.js';
import { Vt } from './vt.js';

const DOWN = '\u001b[B';
const RIGHT = '\u001b[C';
const tick = () => new Promise((r) => setImmediate(r));
async function type(input, text) { input.write(text); await tick(); await tick(); }
function tty(cols = 70) {
  const vt = new Vt(cols);
  const output = new Writable({ write(chunk, _e, cb) { vt.feed(chunk.toString()); cb(); } });
  output.columns = cols; output.isTTY = true;
  const input = new PassThrough(); input.isTTY = true;
  const ui = new Ui({ input, output, color: false, interactive: true });
  ui.start();
  return { ui, vt, input, output };
}
function open(ui, options) {
  assert.equal(typeof ui.pick, 'function', 'Ui 缺少业务列表选择器');
  ui.beginLive();
  return ui.pick(options);
}

test('业务选择器：↓ 选值、→ 改横档，Enter 一次交回，横移不改条目', async () => {
  const { ui, vt, input } = tty();
  let effort = 0;
  const pending = open(ui, {
    title: '模型与思考强度', selected: 0,
    items: [{ label: '模型甲', value: 'a' }, { label: '模型乙', value: 'b' }],
    detail: () => `思考强度：${['instant', 'medium'][effort]}`,
    horizontal: (delta) => { effort = (effort + delta + 2) % 2; },
  });
  await tick();
  assert.ok(vt.lines().some((l) => l.includes('模型与思考强度')), vt.lines().join('\n'));
  await type(input, DOWN);
  assert.ok(vt.lines().some((l) => l.startsWith('❯ 模型乙')), vt.lines().join('\n'));
  await type(input, RIGHT);
  assert.ok(vt.lines().some((l) => l.includes('思考强度：medium')), vt.lines().join('\n'));
  assert.ok(vt.lines().some((l) => l.startsWith('❯ 模型乙')), '左右键把当前模型也改了');
  await type(input, '\r');
  assert.equal(await pending, 'b');
  assert.equal(ui.picker, null);
  ui.close();
});

test('Esc 取消返回 null、恢复输入草稿，不触发确认回调', async () => {
  const { ui, input } = tty();
  ui.rl.write('没打完的字');
  const pending = open(ui, { title: '档位', items: [{ label: 'plan', value: 'plan' }, { label: 'auto', value: 'auto' }] });
  await tick();
  input.write('\u001b');
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(await pending, null);
  assert.equal(ui.rl.line, '没打完的字');
  assert.equal(ui.picker, null);
  ui.close();
});

test('超过 8 行滚动、当前项不丢；24 列标题和说明不折行', async () => {
  const { ui, vt, input, output } = tty(24);
  const items = Array.from({ length: 12 }, (_, i) => ({ label: `item ${i + 1} 很长的说明文字需要截断`, value: i }));
  const pending = open(ui, { title: '一个很长很长的选择器标题', items });
  await tick();
  const rows = () => vt.lines().filter((l) => /^[❯ ] item /.test(l));
  assert.equal(rows().length, 8, vt.lines().join('\n'));
  for (let i = 0; i < 10; i++) await type(input, DOWN);
  assert.ok(vt.lines().some((l) => l.startsWith('❯ item 11')), vt.lines().join('\n'));
  assert.ok(vt.lines().every((l) => !l.includes('很长的说明文字')), '窄终端说明没有截断：\n' + vt.lines().join('\n'));
  output.columns = 32; vt.resize(32); output.emit('resize'); await tick();
  assert.ok(vt.lines().some((l) => l.startsWith('❯ item 11')), 'resize 后当前项丢失');
  await type(input, '\r');
  assert.equal(await pending, 10);
  ui.close();
});

test('空闲输入行上的选择器：异步输出不丢当前项，Ctrl+C 取消并恢复输入', async () => {
  const first = tty();
  first.ui.rl.setPrompt('› '); first.ui.rl.prompt();
  const pending = first.ui.pick({ title: '任务', items: [{ label: '甲', value: 'a' }, { label: '乙', value: 'b' }] });
  await tick(); await type(first.input, DOWN);
  first.ui.line('异步消息'); await tick();
  assert.equal(first.vt.lines().filter((l) => l === '异步消息').length, 1, first.vt.lines().join('\n'));
  assert.ok(first.vt.lines().some((l) => l.startsWith('❯ 乙')), '输出后当前项丢失');
  await type(first.input, '\r');
  assert.equal(await pending, 'b');
  first.ui.close();

  const second = tty();
  const cancelled = open(second.ui, { title: '档位', items: [{ label: 'plan', value: 'plan' }] });
  await tick(); second.input.write('\u0003');
  assert.equal(await cancelled, null, 'Ctrl+C 没有结束选择器');
  assert.equal(second.ui.picker, null);
  second.ui.close();
});
