// search 认正则、glob、.gitignore（第一百一十轮，Codex 同级第 3 步）。.gitignore 的规矩拿真的 git 当对照。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { compileGlob, parseIgnore } from '../src/tools/globs.js';
import { DraftTools } from '../src/tools/drafts.js';
import { LocalTools } from '../src/tools/local.js';
import { tmpdir, write } from './helpers.js';

const tools = () => { const root = tmpdir(); return { root, t: new LocalTools({ root }) }; };
const files = (content) => [...new Set(String(content).split('\n').filter((l) => /:\d+: /.test(l)).map((l) => l.slice(0, l.search(/:\d+: /))))].sort();

test('默认还是字面：正则符号原样找；没搜到又像正则，提醒一句（搜到了不提醒）', () => {
  const { root, t } = tools();
  write(root, 'a.js', 'foo(bar)\nfoobar\n');
  const literal = t.search({ query: 'foo(bar)' });
  assert.match(literal.content, /a\.js:1: foo\(bar\)/);
  assert.doesNotMatch(literal.content, /a\.js:2/);
  assert.doesNotMatch(literal.content, /regex: true/, '搜到了不用提醒');
  assert.match(t.search({ query: 'fo+bar' }).content, /没有找到[\s\S]*regex: true/);
  assert.doesNotMatch(t.search({ query: 'nothing' }).content, /regex: true/, '不像正则的不提醒');
  assert.match(t.search({ query: 'foobar' }).content, /a\.js:2: foobar/, '字面的行号');
  write(root, 'no-newline.js', 'first\nlast-without-newline');
  assert.match(t.search({ query: 'last-without' }).content, /no-newline\.js:2:/, '文件最后一行没有换行也要搜');
  assert.match(t.search({ query: 'last-with\\w+', regex: true }).content, /no-newline\.js:2:/);
});

test('regex：真的按正则找；ignore_case；行号对；一行一行匹配', () => {
  const { root, t } = tools();
  write(root, 'a.py', 'def foo(x):\n  return x\nDEF BAR():\n  pass\n');
  const r = t.search({ query: '^def \\w+\\(', regex: true });
  assert.match(r.content, /a\.py:1: def foo/);
  assert.doesNotMatch(r.content, /DEF BAR/);
  assert.match(t.search({ query: '^def \\w+\\(', regex: true, ignore_case: true }).content, /a\.py:3: DEF BAR/);
  assert.match(t.search({ query: 'foo.*\\n', regex: true }).content, /没有找到/, '不跨行');
  assert.match(t.search({ query: 'x$', regex: true }).content, /a\.py:2:   return x/);
});

test('regex 写错了照实说，不悄悄退回字面', () => {
  const { root, t } = tools();
  write(root, 'a.py', '(unclosed\n');
  const r = t.search({ query: '(unclosed', regex: true });
  assert.match(r.error, /正则写错了/);
  assert.match(t.search({ query: '(?i)x', regex: true }).error, /ignore_case/);
});

test('灾难性回溯卡不死进程：时限内停下，说清楚，说这不是全部；之后还能接着用', () => {
  const { root, t } = tools();
  write(root, 'a.txt', `${'a'.repeat(60)}\n`);
  write(root, 'b.txt', 'hello\n');
  const t0 = Date.now();
  const r = t.search({ query: '(a+)+b', regex: true });
  assert.ok(Date.now() - t0 < 5000, `卡了 ${Date.now() - t0}ms`);
  assert.match(r.content, /这个正则太慢/);
  assert.match(r.content, /这不是全部/);
  assert.match(t.search({ query: 'hel+o', regex: true }).content, /b\.txt:1/);
});

test('regex：跨大块也对（文件比一次读的块大）；GBK 文件；命中上限照样说', () => {
  const { root, t } = tools();
  const big = Array.from({ length: 60_000 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
  write(root, 'big.txt', `${big}\nlast-needle-99\n`);
  assert.match(t.search({ query: 'last-needle-\\d+', regex: true }).content, /big\.txt:60001: last-needle-99/);
  assert.match(t.search({ query: 'line \\d+ ', regex: true }).content, /只列出了前 80 条 —— 这不是全部/);
  fs.writeFileSync(path.join(root, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x31, 0x32, 0x0a]));
  assert.match(t.search({ query: '中文\\d+', regex: true }).content, /gbk\.txt:1: 中文12/);
});

test('glob：不带斜杠哪层都算，带斜杠从根算，多选一；写错了说；没有字面命中的文件不算', () => {
  const { root, t } = tools();
  for (const f of ['a.py', 'src/b.py', 'src/c.js', 'src/deep/d.js', 'lib/e.js', 'lib/f.ts', 'other/src/z.js']) write(root, f, 'NEEDLE\n');
  const of = (glob) => files(t.search({ query: 'NEEDLE', glob }).content);
  assert.deepEqual(of('*.py'), ['a.py', 'src/b.py']);
  assert.deepEqual(of('src/*.js'), ['src/c.js'], '一个星不跨目录；带斜杠从根算，other/src 不算');
  assert.deepEqual(of('src/**'), ['src/b.py', 'src/c.js', 'src/deep/d.js'], 'a/** 是里面的一切');
  assert.deepEqual(of('lib?e.js'), [], '? 不跨目录');
  assert.deepEqual(of('src/**/*.js'), ['src/c.js', 'src/deep/d.js'], '两个星可以是零层');
  assert.deepEqual(of('**/*.ts'), ['lib/f.ts']);
  assert.deepEqual(of('lib/*.{js,ts}'), ['lib/e.js', 'lib/f.ts']);
  assert.deepEqual(of('./src/c.js'), ['src/c.js']);
  assert.deepEqual(of('?.py'), ['a.py', 'src/b.py']);
  assert.match(t.search({ query: 'NEEDLE', glob: '*.{js' }).error, /glob 写错了/);
  assert.match(t.search({ query: 'NEEDLE', glob: '*.rb' }).content, /没有找到/);
  assert.deepEqual(files(t.search({ query: 'NEEDLE', glob: '*.py', path: 'src' }).content), ['src/b.py'], '和 path 一起用');
  assert.equal(compileGlob('[')('['), true, '方括号不配对就当字面');
});

test('.gitignore：默认跳过，说出跳过了多少；include_ignored 才搜；明确指定 path 进去照搜', () => {
  const { root, t } = tools();
  write(root, '.gitignore', '*.tmp.js\ngen/\n');
  write(root, 'keep.js', 'NEEDLE\n');
  write(root, 'x.tmp.js', 'NEEDLE\n');
  write(root, 'gen/out.js', 'NEEDLE\n');
  const r = t.search({ query: 'NEEDLE' });
  assert.deepEqual(files(r.content), ['keep.js']);
  assert.match(r.content, /\.gitignore 忽略了 2 个文件 \/ 目录/);
  assert.deepEqual(files(t.search({ query: 'NEEDLE', include_ignored: true }).content), ['gen/out.js', 'keep.js', 'x.tmp.js']);
  assert.deepEqual(files(t.search({ query: 'NEEDLE', path: 'gen' }).content), ['gen/out.js'], '明确要搜这个目录');
  assert.deepEqual(files(t.search({ query: 'NEEDLE', path: 'x.tmp.js' }).content), ['x.tmp.js'], '明确要搜这个文件');
  assert.doesNotMatch(t.search({ query: 'keep-nothing' }).content, /regex: true/);
});

test('工作区是仓库的子目录：上层的 .gitignore、.git/info/exclude 也算；不在仓库里不往上找', () => {
  const top = tmpdir();
  fs.mkdirSync(path.join(top, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(top, '.git', 'info', 'exclude'), 'excluded.js\n');
  write(top, '.gitignore', 'ignored.js\n');
  for (const f of ['sub/a.js', 'sub/ignored.js', 'sub/excluded.js']) write(top, f, 'NEEDLE\n');
  const t = new LocalTools({ root: path.join(top, 'sub') });
  assert.deepEqual(files(t.search({ query: 'NEEDLE' }).content), ['a.js']);

  const outer = tmpdir();
  write(outer, '.gitignore', '*.js\n');
  write(outer, 'proj/a.js', 'NEEDLE\n');
  const plain = new LocalTools({ root: path.join(outer, 'proj') });
  assert.deepEqual(files(plain.search({ query: 'NEEDLE' }).content), ['a.js'], '工作区不在仓库里，上面目录的 .gitignore 不算');
});

test('.gitignore 的规矩和真的 git 一模一样（走一遍搜到的文件 = git ls-files 列出的）', { skip: spawnSync('git', ['--version']).status === 0 ? false : '没有 git' }, () => {
  const root = tmpdir();
  const git = (...args) => spawnSync('git', ['-c', 'core.excludesFile=/dev/null', '-c', 'core.ignorecase=false', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });
  assert.equal(git('init', '-q').status, 0);
  write(root, '.gitignore', [
    '# 注释不是规则', '', '*.gen.js', '!keep.gen.js', '/anchored.js', 'sub/fixed.js', 'gen2/', 'star/*', '!star/back.js', 'deep/**/x.js', 'tail/**', '**/any.js',
    'x?y.js', 'br{a,b}.js', 'tabby.js\t', '#comment.js', 'asfile.js/', 'crlf.js\r', 'q?.js', 'cls[ab].js', 'notcls[!ab].js', '\\#hash.js', '\\!bang.js', 'space.js   ', 'exclude-dir', '!exclude-dir/back.js', 'a**b.js', 'mid/*/end.js',
  ].join('\n'));
  write(root, 'nested/.gitignore', 'local.js\n/only-here.js\n!re.gen.js\n');
  write(root, '.git/info/exclude', 'from-exclude.js\n');
  const all = ['a.js', 'x.gen.js', 'keep.gen.js', 'sub/x.gen.js', 'anchored.js', 'sub/anchored.js', 'sub/fixed.js', 'other/sub/fixed.js', 'gen2/a.js', 'sub/gen2/a.js', 'star/a.js', 'star/back.js', 'star/in/a.js',
    'deep/x.js', 'deep/a/x.js', 'deep/a/b/x.js', 'deep/y.js', 'tail/a.js', 'tail/b/c.js', 'any.js', 'p/q/any.js', 'qa.js', 'qab.js', 'clsa.js', 'clsc.js', 'notclsa.js', 'notclsc.js', '#hash.js', '!bang.js', 'space.js', 'space2.js',
    'exclude-dir/a.js', 'exclude-dir/back.js', 'ab.js', 'axb.js', 'a/b.js', 'mid/x/end.js', 'mid/x/y/end.js', 'mid/end.js', 'nested/local.js', 'nested/deeper/local.js', 'local.js', 'nested/only-here.js', 'nested/deeper/only-here.js',
    'nested/re.gen.js', 'nested/other.gen.js', 'from-exclude.js', 'p/from-exclude.js', 'plain/keep.js',
    'x/y.js', 'xay.js', 'br{a,b}.js', 'bra.js', 'tabby.js', '#comment.js', 'asfile.js', 'crlf.js', 'crlfx.js'];
  for (const f of all) write(root, f, 'NEEDLE\n');
  const listed = git('ls-files', '-co', '--exclude-standard');
  assert.equal(listed.status, 0, listed.stderr);
  const truth = listed.stdout.split('\n').filter((f) => f.endsWith('.js')).map((f) => f.replace(/^"|"$/g, '')).sort();
  const ours = files(new LocalTools({ root }).search({ query: 'NEEDLE' }).content);
  assert.ok(truth.length > 15 && truth.length < all.length, `对照要有留有去：${truth.length}/${all.length}`);
  assert.deepEqual(ours, truth);
});

test('坏的规则不连累别的；很大的 .gitignore 不读；CRLF 也认', () => {
  const rules = parseIgnore('[z-a].js\nok.js\n', '/w');
  assert.ok(rules.some((r) => r.re.test('ok.js')), '坏的一条（范围反了）不连累后面的');
  const { root, t } = tools();
  write(root, '.gitignore', `${'#'.repeat(300 * 1024)}\nhidden.js\n`);
  write(root, 'hidden.js', 'NEEDLE\n');
  assert.deepEqual(files(t.search({ query: 'NEEDLE' }).content), ['hidden.js'], '太大的 .gitignore 不读（搜多了比卡住好）');
});

test('网页的草稿：regex、glob 都认草稿（改了还没确认的文件），新建的草稿也算', () => {
  const root = tmpdir();
  write(root, 'a.py', 'old_name = 1\n');
  const t = new DraftTools({ root, canWrite: true, exec: async () => ({}) });
  t.readFile({ path: 'a.py' });
  t.overlay.set(path.join(t.root, 'a.py'), Buffer.from('new_name = 2\n'));
  t.overlay.set(path.join(t.root, 'draft.py'), Buffer.from('new_name = 3\n'));
  t.overlay.set(path.join(t.root, 'draft.js'), Buffer.from('new_name = 4\n'));
  assert.deepEqual(files(t.search({ query: 'new_\\w+ = \\d', regex: true, glob: '*.py' }).content), ['a.py', 'draft.py']);
  assert.doesNotMatch(t.search({ query: 'old_\\w+', regex: true }).content, /a\.py/, '草稿盖住了磁盘上的旧内容');
});
