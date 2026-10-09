// 工作区里奇怪的文件（第十六轮）：二进制、GBK、几百 MB、没有读权限、文件名里带控制字符。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable, PassThrough } from 'node:stream';
import { LocalTools, classifyText } from '../src/tools/local.js';
import { termSafe } from '../src/render/term.js';
import { Markdown } from '../src/render/markdown.js';
import { Ui } from '../src/ui.js';
import { tmpdir, write } from './helpers.js';

const GBK_HELLO = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7]);   // 「你好世界」的 GBK
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function tools() {
  const root = tmpdir();
  return { root, t: new LocalTools({ root }) };
}

test('二进制文件（图片改了个 .txt 的名字、带 NUL 的 js）：不读进上下文，说清是二进制', () => {
  const { root, t } = tools();
  write(root, 'notes.txt', Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n'), Buffer.alloc(200, 0), Buffer.from('tail')]));
  write(root, 'src/nul.js', Buffer.from('const a = 1;\x00\x00 x\n'));
  assert.match(t.readFile({ path: 'notes.txt' }).error, /看起来是二进制文件/);
  assert.match(t.readFile({ path: 'src/nul.js' }).error, /看起来是二进制文件/);
});

test('两道二进制判定各管一种：一大段正常文字里只夹一个 NUL（比例判定看不出来）；没有 NUL、但满是控制字节（NUL 判定看不出来）', () => {
  const { root, t } = tools();
  write(root, 'one-nul.txt', Buffer.concat([Buffer.from('正常的一行文字\n'.repeat(300)), Buffer.from([0]), Buffer.from('尾巴\n')]));
  const ctrl = Buffer.alloc(3000);
  for (let i = 0; i < ctrl.length; i++) ctrl[i] = i % 3 === 0 ? 0x1b : 0x41 + (i % 26);   // 三分之一是 ESC，没有 NUL
  write(root, 'record.txt', ctrl);
  assert.match(t.readFile({ path: 'one-nul.txt' }).error, /看起来是二进制文件/);
  assert.match(t.readFile({ path: 'record.txt' }).error, /看起来是二进制文件/);
});

test('正常的中文、emoji、带 Tab 的文本不许被当成二进制', () => {
  const { root, t } = tools();
  write(root, 'zh.md', '# 重积分\n\t极坐标换元别忘了乘 r 🙂\n'.repeat(200));
  const r = t.readFile({ path: 'zh.md' });
  assert.ok(!r.error, r.error);
  assert.match(r.content, /极坐标换元/);
  assert.equal(classifyText(Buffer.from('')), 'utf8');
});

test('GBK 的中文文件：按 GBK 解码给模型看、说清不是 UTF-8；不许 write_file 改（会把编码换掉）；搜索能搜到里面的中文', () => {
  const { root, t } = tools();
  write(root, 'old/main.c', Buffer.concat([Buffer.from('/* '), GBK_HELLO, Buffer.from(' */\nint main() { return 0; }\n')]));
  assert.equal(classifyText(fs.readFileSync(path.join(root, 'old/main.c'))), 'gb18030');
  const r = t.readFile({ path: 'old/main.c' });
  assert.ok(!r.error, r.error);
  assert.match(r.content, /你好世界/);
  assert.match(r.content, /不是 UTF-8，是 GBK \/ GB18030/);
  assert.match(t.prepareWrite({ path: 'old/main.c', content: 'x\n' }).error, /不是 UTF-8 编码/);
  assert.match(t.prepareWrite({ path: 'old/main.c', old_string: 'return 0', new_string: 'return 1' }).error, /不是 UTF-8 编码/);
  assert.match(t.search({ query: '你好世界' }).content, /old\/main\.c:1:/);
});

test('几百 KB 以上的大文件：不再一律「超过上限」—— 能读开头、读中间一段、读最后几行（日志），不整份读进内存', () => {
  const { root, t } = tools();
  const lines = [];
  for (let i = 1; i <= 50000; i++) lines.push(`line ${i} ${'x'.repeat(20)}`);
  write(root, 'big.txt', `${lines.join('\n')}\n`);
  const head = t.readFile({ path: 'big.txt', limit: 3 });
  assert.match(head.content, /【big\.txt 第 1–3 行（文件 [\d.]+MB，太大，不能整份读；用 offset=4 接着读/);
  assert.match(head.content, /\nline 1 x+\nline 2 x+\nline 3 x+$/);
  const mid = t.readFile({ path: 'big.txt', offset: 25000, limit: 2 });
  assert.match(mid.content, /\nline 25000 x+\nline 25001 x+$/);
  const tail = t.readFile({ path: 'big.txt', offset: -2 });
  assert.match(tail.content, /最后 2 行/);
  assert.match(tail.content, /\nline 49999 x+\nline 50000 x+$/);
  assert.match(t.prepareWrite({ path: 'big.txt', old_string: 'line 1 ', new_string: 'LINE 1 ' }).error, /太大.*只能分段读，不能用 write_file 改/);
});

test('搜索：大文件照样搜到；二进制、没有读权限的跳过并说出来（原来一声不吭，「1 处」其实是「能看的那些里 1 处」）', () => {
  const { root, t } = tools();
  const lines = [];
  for (let i = 0; i < 30000; i++) lines.push(`2026-09-28 INFO ok ${i}`);
  write(root, 'logs.txt', `${lines.join('\n')}\nERROR needle here\n`);
  write(root, 'dump.json', Buffer.concat([Buffer.alloc(100, 0), Buffer.from(' needle ')]));
  write(root, 'ok.js', 'needle\n');
  if (!asRoot) {
    write(root, 'locked/a.js', 'needle\n');
    fs.chmodSync(path.join(root, 'locked'), 0o000);
  }
  try {
    const r = t.search({ query: 'needle' });
    assert.match(r.content, /logs\.txt:30001: ERROR needle here/);
    assert.match(r.content, /ok\.js:1: needle/);
    assert.ok(!/dump\.json:/.test(r.content), '二进制文件不该出现在命中里');
    assert.match(r.content, /跳过了 1 个二进制文件：dump\.json/);
    if (!asRoot) {
      assert.match(r.content, /有 1 个文件 \/ 目录没有读权限，没搜到里面/);
      assert.match(r.summary, /有没搜到的/);
    }
  } finally {
    if (!asRoot) fs.chmodSync(path.join(root, 'locked'), 0o755);
  }
});

test('没有读权限：读文件说清楚（原来抛出带绝对路径的原始错误）；目录不再显示成「空目录」', { skip: asRoot }, () => {
  const { root, t } = tools();
  write(root, 'secret.txt', 'x\n');
  fs.chmodSync(path.join(root, 'secret.txt'), 0o000);
  write(root, 'locked/a.js', 'x\n');
  fs.chmodSync(path.join(root, 'locked'), 0o000);
  try {
    assert.equal(t.readFile({ path: 'secret.txt' }).error, '没有读权限：secret.txt');
    assert.match(t.listFiles({ path: 'locked' }).content, /没有读权限，列不出来/);
    assert.match(t.listFiles({ path: '.' }).content, /locked\/ （没有读权限）/);
  } finally {
    fs.chmodSync(path.join(root, 'secret.txt'), 0o644);
    fs.chmodSync(path.join(root, 'locked'), 0o755);
  }
});

test('termSafe：控制字符变成看得见的写法；自己上的颜色可以留', () => {
  assert.equal(termSafe('src/\u001b[2Jx.js'), 'src/\\x1b[2Jx.js');
  assert.equal(termSafe('a\nb\tc', { singleLine: true }), 'a⏎b c');
  assert.equal(termSafe('crlf\r\nline'), 'crlf\nline');
  assert.equal(termSafe('over\rwrite'), 'over\\x0dwrite');
  assert.equal(termSafe('\u001b[32m✓\u001b[0m \u001b[2J', { keepSgr: true }), '\u001b[32m✓\u001b[0m \\x1b[2J');
  assert.equal(termSafe('nul\u0000', { keepSgr: true }), 'nul\\x00');
});

test('打到终端上的文件名、diff、命令输出、模型的回答：不许带原样的控制字符（一个叫「\\x1b[2J.js」的文件，读它时屏幕就清空了）', () => {
  let out = '';
  const output = new Writable({ write(chunk, _e, cb) { out += chunk.toString(); cb(); } });
  const ui = new Ui({ input: new PassThrough(), output, color: false, interactive: false });
  const evil = 'src/\u001b[2J\u001b]0;pwned\u0007x.js';
  ui.step(`读取 ${evil}`);
  ui.note(`已新建 ${evil}`);
  ui.warn(evil);
  ui.error(evil);
  ui.result(evil);
  ui.diff([`+ ${evil}`, `- \u001b[31mold`]);
  const md = new Markdown((s) => { out += s; }, false);
  md.feed(`回答里夹了 \u001b[2J 清屏\n`);
  md.finish();
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(out), `终端输出里有原样的控制字符：${JSON.stringify(out)}`);
  assert.match(out, /\\x1b\[2J/);
});
