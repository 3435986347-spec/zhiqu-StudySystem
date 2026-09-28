// 窄终端、改终端宽度（第二十轮）：活动区（流式的半行、排队的消息、状态行、输入行）擦的时候按「占几行」往上挪，
// 数错一行就是一行残影（每刷一次多一份）或者擦掉上面已经打印好的输出。用迷你终端模拟器（test/vt.js）逐字节执行输出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { Ui } from '../src/ui.js';
import { rowsIn } from '../src/render/term.js';
import { Vt } from './vt.js';

function tty(cols) {
  const vt = new Vt(cols);
  const output = new Writable({ write(chunk, _e, cb) { vt.feed(chunk.toString()); cb(); } });
  output.columns = cols;
  output.isTTY = true;
  const input = new PassThrough();
  input.isTTY = true;
  const ui = new Ui({ input, output, color: false, interactive: true });
  ui.start();
  const resize = (n) => { vt.resize(n); output.columns = n; output.emit('resize'); };
  return { ui, vt, input, resize };
}
const tick = () => new Promise((r) => setImmediate(r));
async function type(input, text) { input.write(text); await tick(); await tick(); }
const count = (lines, s) => (lines.join('\n').match(new RegExp(s, 'g')) || []).length;

test('rowsIn 和终端自己折行的结果一致（中文放不进最后一格整个挪下去、组合符号不占格、写满最后一格不算多一行）', () => {
  // 伪随机但固定：失败时能复现
  let seed = 20260928;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pool = ['a', 'b', ' ', '中', '文', '，', '🎯', 'é', 'Z̷̢͛', '‍', '…'];
  for (let i = 0; i < 400; i++) {
    const cols = 9 + rnd(37);
    let text = '';
    for (let k = rnd(90); k > 0; k--) text += pool[rnd(pool.length)];
    const vt = new Vt(cols);
    vt.feed(text);
    assert.equal(rowsIn(text, cols), vt.r + 1, `${cols} 列：${JSON.stringify(text)}`);
  }
  assert.equal(rowsIn('a'.repeat(20), 20), 1, '正好写满一行');
  assert.equal(rowsIn('a'.repeat(21), 20), 2);
  assert.equal(rowsIn(`a${'中'.repeat(10)}`, 21), 1);
  assert.equal(rowsIn('中'.repeat(37), 25), 4, '奇数列宽全是中文：每行 12 个、空一格；总宽 ÷ 列宽算出来是 3');
  assert.equal(rowsIn(`\u001b[36m${'中'.repeat(12)}\u001b[39m`, 25), 1, '颜色码不占格');
});

for (const cols of [21, 25, 41]) {
  test(`${cols} 列：排队的一条中文消息，状态行刷几次之后屏幕上只有一份（原来 25 列时留下五份）`, async () => {
    const { ui, vt, input } = tty(cols);
    ui.beginLive();
    ui.write('上面一行\n');
    await type(input, `${'再加一个计分板'.repeat(3)}\r`);
    for (let i = 0; i < 6; i++) ui.setStatus(`… 等待 ${i}s`);
    ui.write('下面一行\n');
    const lines = vt.lines();
    assert.equal(count(lines, '⋯ 排队'), 1, lines.join('\n'));
    assert.equal(lines[0], '上面一行');
    assert.equal(lines[1], '下面一行');
    assert.equal(lines.at(-1), '›');
    ui.close();
  });
}

for (const cols of [25, 41]) {
  test(`${cols} 列：流式的半行里有组合符号（Zalgo），擦的时候不把上面的输出擦掉`, () => {
    const { ui, vt } = tty(cols);
    ui.beginLive();
    ui.write('上面第一行\n上面第二行\n');
    ui.write('Z̷̢̖̗͚͛A̸̧̢L̵̢G̶O̴ '.repeat(3));
    for (let i = 0; i < 3; i++) ui.setStatus(`… ${i}`);
    ui.write('完\n');
    ui.setStatus('');
    const lines = vt.lines();
    assert.deepEqual(lines.slice(0, 2), ['上面第一行', '上面第二行'], lines.join('\n'));
    assert.equal(lines.length, 4, lines.join('\n'));
    ui.close();
  });
}

test('确认问题里有 macOS 的 NFD 文件名（é = e + U+0301）：答完问题连同回答留一份，上面的输出不少', async () => {
  const { ui, vt, input } = tty(25);
  ui.beginLive();
  ui.write('上面第一行\n上面第二行\n');
  // 实际宽 46、把 6 个组合符号各算一格就是 52：25 列下差出一行（名字短了两边都折成 2 行，这条判据看不出区别 —— 扰动照出来的）
  const name = 'résumé-café-naïve-élève-abcd'.normalize('NFD');
  const answer = ui.ask(`写入 ${name}.md？[y/n] › `, { fresh: true });
  await tick();
  await type(input, 'y\r');
  assert.equal(await answer, 'y');
  ui.write('下面一行\n');
  const lines = vt.lines();
  assert.deepEqual(lines.slice(0, 2), ['上面第一行', '上面第二行'], lines.join('\n'));
  assert.equal(count(lines, '写入'), 1, lines.join('\n'));
  ui.close();
});

for (const [from, to] of [[48, 25], [25, 57], [41, 20]]) {
  test(`改终端宽度 ${from} → ${to} 列：活动区按新宽度重画，没有残影、不擦上面的输出，打了一半的字还在`, async () => {
    const { ui, vt, input, resize } = tty(from);
    ui.beginLive();
    ui.write('上面第一行\n上面第二行\n');
    await type(input, `${'顺便把颜色改一下'.repeat(2)}\r`);
    ui.write(`正在写的这一段还没换行${'很长'.repeat(8)}`);
    ui.startThinking();
    await type(input, '下一个问题');
    resize(to);
    for (let i = 0; i < 4; i++) ui.thinkingTick();
    ui.setActivity('读 src/很长的目录名/又一层/文件.js');
    ui.write('，写完了\n');
    ui.stopThinking();
    const lines = vt.lines();
    const all = lines.join('\n');
    assert.deepEqual(lines.slice(0, 2), ['上面第一行', '上面第二行'], all);
    assert.equal(count(lines, '⋯ 排队'), 1, all);
    assert.equal(count(lines, '正在写的这一段'), 1, all);
    assert.equal(count(lines, '思考中'), 0, `思考结束了状态行还在：\n${all}`);
    assert.equal(lines.at(-1), '› 下一个问题', all);
    assert.equal(ui.rl.line, '下一个问题');
    ui.close();
  });
}

test('改终端宽度时没有活动区（空闲、只有输入行）：输入行照样由 readline 重画', async () => {
  const { ui, vt, input, resize } = tty(40);
  ui.write('上面一行\n');
  const got = ui.ask(ui.prompt);
  await type(input, '打了一半的一句很长的话打了一半的一句很长的话');
  resize(21);
  await type(input, '再打几个字');
  const lines = vt.lines();
  assert.equal(lines[0], '上面一行', lines.join('\n'));
  assert.equal(count(lines, '打了一半'), 2, lines.join('\n'));
  assert.equal(ui.rl.line, '打了一半的一句很长的话打了一半的一句很长的话再打几个字');
  ui.close();
  await got;
});

const TABLE = [
  '| 文件 | 改了什么 | 为什么 |',
  '| --- | --- | --- |',
  '| src/render/markdown.js | 表格比终端宽时一行记录一段 | 窄终端里各列的碎片交错在一起没法读 |',
  '| src/ui.js | 按终端折行的方式数行 | 奇数列宽全是中文时每一行都少算一格 |',
  '',
].join('\n');

test('表格按列对齐之后比终端宽：一行记录一段（「• 列名: 值」），不再让各列的碎片交错', async () => {
  const { Markdown } = await import('../src/render/markdown.js');
  let narrow = '';
  const md = new Markdown((s) => { narrow += s; }, false, () => 40);
  md.feed(TABLE); md.finish();
  assert.ok(!narrow.includes('│'), narrow);
  assert.ok(narrow.includes('• 文件: src/render/markdown.js\n  改了什么: 表格比终端宽时一行记录一段\n  为什么: 窄终端里各列的碎片交错在一起没法读'), narrow);
  let wide = '';
  const w = new Markdown((s) => { wide += s; }, false, () => 200);
  w.feed(TABLE); w.finish();
  assert.ok(wide.includes('│'), `终端够宽时照旧按列对齐：\n${wide}`);
  let piped = '';
  const p = new Markdown((s) => { piped += s; }, false);
  p.feed(TABLE); p.finish();
  assert.equal(piped, wide, '不给宽度（管道、日志）时和原来一样按列对齐');
});

test('交互终端 40 列：模型回答里的宽表格按记录显示，每一行都放得下列名', () => {
  const { ui, vt } = tty(40);
  ui.beginLive();
  const md = ui.markdown();
  md.feed(TABLE); md.finish();
  ui.endLive();
  const lines = vt.lines();
  assert.ok(lines.some((l) => l.startsWith('• 文件: src/ui.js')), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('│')), lines.join('\n'));
  ui.close();
});
