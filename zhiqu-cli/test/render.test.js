// 终端渲染：Markdown（与 Java 版 CliMarkdownTest 同一批输入）、diff、SSE 解析。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Markdown } from '../src/render/markdown.js';
import { diff, hunks, stat } from '../src/render/diff.js';
import { SseParser } from '../src/sse.js';

function plain(...deltas) {
  let out = '';
  const md = new Markdown((s) => { out += s; }, false);
  for (const d of deltas) md.feed(d);
  md.finish();
  return out;
}

/** 判据自己的尺子：中日韩与全角算两格。不用被测的 displayWidth 当裁判。 */
function cells(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    w += (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x3000 && c <= 0x303f) ? 2 : 1;
  }
  return w;
}

test('纯文本模式：标题、加粗、行内代码、表格分隔行的标记全部去掉（段落与列表 / 表格两条路径都要）', () => {
  const out = plain('## 最小可行版本\n\n先用最简单的：**HTML Canvas** 加 `原生 JavaScript`。\n\n'
    + '- **重点**：先让小人能跳\n| 模块 | 内容 |\n| --- | --- |\n| 角色 | **必须** |\n');
  assert.ok(out.includes('  • 重点：先让小人能跳'), out);
  assert.ok(out.includes('先用最简单的：HTML Canvas 加 原生 JavaScript。'), out);
  for (const marker of ['##', '**', '`', '| ---']) assert.ok(!out.includes(marker), `还留着「${marker}」：\n${out}`);
});

test('表格按列对齐：每一行的分隔符落在同一个显示列上（中文算两格）', () => {
  const out = plain('| 功能 | 说明 |\n| --- | --- |\n| 画布 | 一个网页游戏区域 |\n| 重新开始 | 按 R 键 |\n| Esc | 暂停 |\n');
  const rows = out.split('\n').filter((l) => l.includes('│'));
  assert.equal(rows.length, 4, out);
  const col = cells(rows[0].slice(0, rows[0].indexOf('│')));
  for (const r of rows) assert.equal(cells(r.slice(0, r.indexOf('│'))), col, `歪了：「${r}」`);
  assert.ok(out.includes('─┼─'));
});

test('流式：加粗标记被拆在两次增量之间也渲染正确；段落不等换行就出；表格要等收齐', () => {
  assert.equal(plain('这是*', '*加', '粗*', '*的字\n'), '这是加粗的字\n');
  let out = '';
  const md = new Markdown((s) => { out += s; }, false);
  md.feed('这是一段很长的回答，还没有换行');
  assert.ok(out.includes('这是一段很长的回答'), '段落在等换行 —— 用户会以为卡住了');
  let t = '';
  const tm = new Markdown((s) => { t += s; }, false);
  tm.feed('| a | b |\n| --- | --- |\n');
  assert.ok(!t.includes('a'), '表格没收齐就输出了');
  tm.finish();
  assert.ok(t.includes('a'));
});

test('代码块加框并标出语言；终端模式标题加粗、行内代码上色', () => {
  assert.ok(plain('```html\n<canvas></canvas>\n```\n').includes('┌─ html\n│ <canvas></canvas>\n└─\n'));
  let out = '';
  const md = new Markdown((s) => { out += s; }, true);
  md.feed('# 标题\n- 运行 `node a.js`\n');
  md.finish();
  assert.ok(out.includes('\u001b[1m标题\u001b[0m'));
  assert.ok(out.includes('\u001b[36mnode a.js\u001b[0m'));
  assert.ok(!out.includes('# 标题'));
});

test('diff：分块带上下文、行号是旧文件的；相同返回 []；统计加减行', () => {
  const a = 'a\nb\nc\nd\ne\nf\ng\nh\n';
  const b = 'a\nb\nc\nD\ne\nf\ng\nh\n';
  assert.deepEqual(hunks(a, b, 1), ['@@ 第 3 行 @@', ' c', '-d', '+D', ' e']);
  assert.deepEqual(hunks(a, a), []);
  assert.deepEqual(stat('', 'x\ny\n'), { added: 2, removed: 0 });
  assert.equal(diff('x\n'.repeat(3000), 'y\n'.repeat(3000)), null, '超预算不逐行比');
  assert.ok(hunks('x\n'.repeat(3000), 'y\n'.repeat(3000))[0].includes('文件太大'), '退回整份时要明说');
});

test('SSE：事件被切成任意块、冒号后有没有空格、CRLF 都能解析', () => {
  const got = [];
  const p = new SseParser((e, d) => got.push([e, d]));
  const text = 'event:start\ndata:{"a":1}\n\nevent: delta\r\ndata: {"text":"你"}\r\n\r\n: 注释\ndata:{"x":2}\n\n';
  for (let i = 0; i < text.length; i += 3) p.feed(text.slice(i, i + 3));
  p.end();
  assert.deepEqual(got, [['start', '{"a":1}'], ['delta', '{"text":"你"}'], ['message', '{"x":2}']]);
});
