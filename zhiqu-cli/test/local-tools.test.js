// 本地工具：读过才能改、只读一部分不许整份重写、替换要唯一、确认期间被改过不写、新建目录说清楚、截断要说出来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LocalTools } from '../src/tools/local.js';
import { tmpdir, write } from './helpers.js';

function tools() {
  const root = tmpdir();
  return { root, t: new LocalTools({ root }) };
}

test('没读过不许改已存在的文件；新建不用先读，并报出要新建的目录', () => {
  const { root, t } = tools();
  write(root, 'a.js', 'old\n');
  assert.match(t.prepareWrite({ path: 'a.js', content: 'new\n' }).error, /必须先 read_file/);
  const prep = t.prepareWrite({ path: 'game/assets/x.js', content: 'hi\n' });
  assert.equal(prep.kind, 'create');
  assert.deepEqual(prep.newDirectories, ['game', 'game/assets']);
  assert.match(t.commitWrite(prep).content, /已新建 game\/assets\/x\.js，连同新建目录 game、game\/assets/);
  assert.equal(fs.readFileSync(path.join(root, 'game/assets/x.js'), 'utf8'), 'hi\n');
});

test('读过之后被别人改了：拒绝，要求重读', () => {
  const { root, t } = tools();
  write(root, 'a.js', 'v1\n');
  t.readFile({ path: 'a.js' });
  write(root, 'a.js', 'v2（用户在编辑器里改的）\n');
  assert.match(t.prepareWrite({ path: 'a.js', content: 'v3\n' }).error, /读过之后被改过了/);
});

test('只读了一部分：不许整份重写（会冲掉没读到的部分），替换用法可以', () => {
  const { root, t } = tools();
  write(root, 'long.js', Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const r = t.readFile({ path: 'long.js' });
  assert.match(r.content, /没读完，用 offset=2001 接着读/);
  assert.match(t.prepareWrite({ path: 'long.js', content: 'x' }).error, /只读了一部分/);
  const rep = t.prepareWrite({ path: 'long.js', old_string: 'line 42\n', new_string: 'LINE 42\n' });
  assert.equal(rep.kind, 'replace');
  t.commitWrite(rep);
  assert.match(fs.readFileSync(path.join(root, 'long.js'), 'utf8'), /\nLINE 42\nline 43\n/);
});

test('替换：没找到、出现不止一次都拒；追加接在末尾', () => {
  const { root, t } = tools();
  write(root, 'a.js', 'x = 1\nx = 1\ny = 2\n');
  t.readFile({ path: 'a.js' });
  assert.match(t.prepareWrite({ path: 'a.js', old_string: 'z', new_string: 'q' }).error, /没找到/);
  assert.match(t.prepareWrite({ path: 'a.js', old_string: 'x = 1', new_string: 'x = 3' }).error, /不止一次/);
  const ap = t.prepareWrite({ path: 'a.js', content: 'z = 3\n', append: true });
  assert.equal(ap.kind, 'append');
  t.commitWrite(ap);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'x = 1\nx = 1\ny = 2\nz = 3\n');
  // 自己刚写过的文件，接着追加不用再读
  const again = t.prepareWrite({ path: 'a.js', content: 'w = 4\n', append: true });
  assert.ok(!again.error, again.error);
});

test('确认期间文件被改过：commit 不写（用户在编辑器里的改动不能被旧草稿覆盖）', () => {
  const { root, t } = tools();
  write(root, 'a.js', 'v1\n');
  t.readFile({ path: 'a.js' });
  const prep = t.prepareWrite({ path: 'a.js', content: 'mine\n' });
  write(root, 'a.js', 'theirs\n');
  assert.match(t.commitWrite(prep).error, /确认期间被改过了/);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'theirs\n');
});

test('新建的文件在确认期间被别人先建了：同样不写（新建和覆盖是两件事）', () => {
  const { root, t } = tools();
  const prep = t.prepareWrite({ path: 'n.js', content: 'mine\n' });
  write(root, 'n.js', 'theirs\n');
  assert.ok(t.commitWrite(prep).error);
  assert.equal(fs.readFileSync(path.join(root, 'n.js'), 'utf8'), 'theirs\n');
});

test('列目录：略过 node_modules / .git / .zhiqu，密钥类文件标成读不了，软链不跟随，超过 500 条要说出来', () => {
  const { root, t } = tools();
  write(root, 'node_modules/x/index.js', '');
  write(root, '.env', 'SECRET=1');
  write(root, 'src/a.js', '1');
  fs.symlinkSync('/etc', path.join(root, 'etc-link'));
  const r = t.listFiles({});
  assert.match(r.content, /node_modules\/ （略过）/);
  assert.match(r.content, /\.env {2}（这类文件读不了/);
  assert.match(r.content, /etc-link → （软链，不跟随）/);
  assert.ok(!r.content.includes('index.js'));
  for (let i = 0; i < 520; i++) write(root, `many/f${i}.txt`, '');
  assert.match(t.listFiles({ path: 'many', depth: 1 }).content, /只列出了前 500 个 —— 这不是全部/);
});

test('搜索：字面量（不是正则）、跳过读不了的文件、命中太多要说出来', () => {
  const { root, t } = tools();
  write(root, 'a.js', 'const re = /(a+)+b/;\n');
  write(root, '.env', 'TOKEN=(a+)+b');
  const r = t.search({ query: '(a+)+b' });
  assert.match(r.content, /a\.js:1:/);
  assert.ok(!r.content.includes('.env'), '密钥文件不该被搜进来');
  write(root, 'many.txt', 'hit\n'.repeat(200));
  assert.match(t.search({ query: 'hit' }).content, /只列出了前 80 条 —— 这不是全部/);
});

test('运行：规则在起进程之前判（行内代码、不在清单里、找不到命令）', () => {
  const { t } = tools();
  assert.match(t.prepareRun({ command: 'node', args: ['-e', '1'] }).error, /行内代码/);
  assert.match(t.prepareRun({ command: 'bash', args: ['x.sh'] }).error, /不在允许清单里/);
  assert.match(t.prepareRun({ command: 'node', args: 'a.js b.js' }).error, /必须是数组/);
  assert.match(t.prepareRun({ command: 'node', args: ['a.js'], cwd: '../' }).error, /工作目录不可用/);
});
