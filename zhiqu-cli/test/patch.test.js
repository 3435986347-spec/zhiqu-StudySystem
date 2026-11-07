// apply_patch（第一百一十一轮，Codex 同级第 4 步）：一次改多个文件，要么全成要么全不成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runTurn, toolset } from '../src/agent.js';
import { DraftTools } from '../src/tools/drafts.js';
import { LocalTools } from '../src/tools/local.js';
import { applyHunks, describePatchError, parsePatch, patchFiles } from '../src/tools/patch.js';
import { SessionStore } from '../src/session.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
const hunks = (...lines) => parsePatch(patch('*** Update File: f', ...lines)).ops[0].hunks;
const tools = (Cls = LocalTools, extra = {}) => { const root = tmpdir(); return { root, t: new Cls({ root, ...extra }) }; };
const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');
/** 写好文件并 read_file 过（规矩：读过才能改） */
function seeded(files) {
  const { root, t } = tools();
  for (const [f, content] of Object.entries(files)) { write(root, f, content); t.readFile({ path: f }); }
  return { root, t };
}
const applied = (t, ...lines) => {
  const prep = t.preparePatch({ patch: patch(...lines) });
  if (prep.error) return prep;
  return t.commitPatch(prep);
};

test('解析：三种操作、Move to、@@、End of File；包了代码块也认；写错了说第几行', () => {
  const { ops } = parsePatch(patch('*** Add File: a.py', '+x', '+y', '*** Update File: b.py', '*** Move to: c.py', '@@ def f():', ' ctx', '-old', '+new', '*** End of File', '*** Delete File: d.py'));
  assert.deepEqual(ops.map((o) => o.type), ['add', 'update', 'delete']);
  assert.equal(ops[0].content, 'x\ny\n');
  assert.equal(ops[1].moveTo, 'c.py');
  assert.equal(ops[1].hunks[0].context, 'def f():');
  assert.equal(ops[1].hunks[0].eof, true);
  assert.deepEqual(ops[1].hunks[0].lines.map((l) => l.t), [' ', '-', '+']);
  assert.ok(parsePatch(`\`\`\`\n${patch('*** Delete File: d.py')}\n\`\`\``).ops, '代码块');
  assert.ok(parsePatch(patch('*** Delete File: d.py').replace(/\n/g, '\r\n')).ops, 'CRLF');
  assert.deepEqual(parsePatch(patch('*** Update File: e', '@@ @@', '-a', '+b')).ops[0].hunks[0].context, null, '@@ @@ 没有定位行');
  assert.equal(parsePatch(patch('*** Update File: e', '@@ x @@', '-a')).ops[0].hunks[0].context, 'x');
  for (const [text, why] of [
    ['*** Update File: a\n-x', '第一行'], ['*** Begin Patch\n*** Delete File: a', '最后一行'], [patch(), '空的'], ['', '第一行'],
    [patch('*** Add File: a', 'x'), '第 3 行不是 +'], [patch('*** Update File: a', 'x'), '开头不是'], [patch('什么东西'), '认不出来'],
    [patch('*** Update File: a', '@@', ' only-context'), '没有要改的'], [patch('*** Update File: a', '*** End of File'), '前面没有'],
    // 少了开头：不拒绝的话第一个操作被当成开头吃掉，只删 b
    ['*** Delete File: a\n*** Delete File: b\n*** End Patch', '没有开头'],
    // 写到一半被截断（输出上限）：不拒绝的话打半截
    ['*** Begin Patch\n*** Add File: a\n+x\n*** Add File: b\n+y', '没有结尾'],
    // 夹了一行认不出的：不能丢掉接着打
    [patch('*** Update File: a', '-y', 'garbage', '+z'), '开头不是'],
  ]) {
    const r = parsePatch(text);
    assert.ok(r.error, `该拒绝：${why}`);
    assert.match(describePatchError(r.error), /补丁写错了，一个文件都没改/);
  }
  assert.match(parsePatch(patch('*** Add File: a', 'x')).error.message, /第 3 行/);
  assert.deepEqual(patchFiles(patch('*** Add File: a', '+x', '*** Update File: b', '-y', '*** Delete File: c')), ['a', 'b', 'c']);
  assert.deepEqual(patchFiles(null), []);
});

test('打补丁：上下文、多段、@@ 定位、文件末尾、只加不删', () => {
  const text = 'a\nb\nc\nd\ne\nf\n';
  assert.equal(applyHunks(text, hunks(' a', '-b', '+B', ' c')).text, 'a\nB\nc\nd\ne\nf\n');
  assert.equal(applyHunks(text, hunks('@@', '-b', '+B', '@@', '-e', '+E')).text, 'a\nB\nc\nd\nE\nf\n', '多段');
  assert.equal(applyHunks(text, hunks('@@ c', '+new')).text, 'a\nb\nc\nnew\nd\ne\nf\n', '只有 + ：放在定位行后面');
  assert.equal(applyHunks(text, hunks('+tail')).text, 'a\nb\nc\nd\ne\nf\ntail\n', '只有 + 、没有定位：放在末尾');
  assert.equal(applyHunks(text, hunks('-f', '+F', '*** End of File')).text, 'a\nb\nc\nd\ne\nF\n');
  assert.equal(applyHunks(text, hunks('-a', '-b')).text, 'c\nd\ne\nf\n', '只删');
  assert.equal(applyHunks('', hunks('+first')).text, 'first\n', '空文件');
  assert.equal(applyHunks('a\n\nb\n', hunks(' a', '', '-b', '+B')).text, 'a\n\nB\n', '空行当空的上下文（模型常把行首的空格丢了）');
  assert.equal(applyHunks(text, hunks('@@', '-e', '+E', '@@', '-b', '+B')).error.kind, 'not_found', '段要按文件里的顺序');
});

test('换行：全 CRLF 的文件比的时候当 \\n、写回去还是 CRLF；没有末尾换行的不加', () => {
  assert.equal(applyHunks('a\r\nb\r\nc\r\n', hunks(' a', '-b', '+B')).text, 'a\r\nB\r\nc\r\n');
  assert.equal(applyHunks('a\nb', hunks('-b', '+B')).text, 'a\nB');
  assert.equal(applyHunks('a\nb', hunks('-a', '+A')).text, 'A\nb');
  assert.equal(applyHunks('a\nb\r\nc\n', hunks('-a', '+A')).text, 'A\nb\r\nc\n', '混着的不动');
});

test('原文对不上：行尾空白放过（留文件里的原样），缩进不放过；说得出线索', () => {
  assert.equal(applyHunks('a  \nb\n', hunks(' a', '-b', '+B')).text, 'a  \nB\n', '上下文留原样，不换成补丁里的');
  const r = applyHunks('def f():\n    x = 1\n', hunks('-  x = 1', '+  x = 2'));
  assert.equal(r.error.kind, 'not_found', '缩进是语义，不能放过');
  assert.match(describePatchError(r.error, 'f.py'), /f\.py 的第 1 段.*原文对不上/);
  assert.match(describePatchError(r.error, 'f.py'), /第 2 行看着一样，但空白不一样[\s\S]*    x = 1/, '线索说在第几行、原文是什么');
  assert.doesNotMatch(describePatchError(r.error, 'f.py'), /object Object/);
  const near = applyHunks('import os\ndef f():\n    x = 1\n', hunks(' def f():', '-    y = 2', '+    y = 3'));
  assert.match(describePatchError(near.error, 'f.py'), /要找的第一行在第 2 行，后面对不上[\s\S]*x = 1/);
  assert.doesNotMatch(describePatchError(applyHunks('a\n', hunks('-zzz', '+y')).error, 'f.py'), /undefined|null/, '没有线索时不打别的');
  assert.equal(applyHunks('a\n', hunks('@@ nothing', '-a')).error.kind, 'anchor');
  assert.match(describePatchError({ kind: 'anchor', hunk: 1, anchor: 'nothing' }, 'f'), /找不到 @@ 后面那一行「nothing」/);
  assert.equal(applyHunks('a\nb\n', hunks('-a', '+a')).error.kind, 'no_change', '改完一样');
  assert.equal(applyHunks('a\nb\n', hunks('-a', '+A', '*** End of File')).error.kind, 'not_found', 'End of File：不在末尾不算');
});

test('原文出现几处就拒绝、说行号，不取第一处（取错了是一声不响改错地方）；@@ 或多带上下文就能定位', () => {
  const text = 'def a():\n    return 1\n\ndef b():\n    return 1\n';
  const r = applyHunks(text, hunks('-    return 1', '+    return 2'));
  assert.equal(r.error.kind, 'ambiguous');
  assert.deepEqual(r.error.lines, [2, 5]);
  assert.match(describePatchError(r.error, 'f.py'), /出现了 2 处（第 2、5 行）/);
  assert.equal(applyHunks(text, hunks('@@ def b():', '-    return 1', '+    return 2')).text, 'def a():\n    return 1\n\ndef b():\n    return 2\n');
  assert.equal(applyHunks(text, hunks(' def b():', '-    return 1', '+    return 2')).text, 'def a():\n    return 1\n\ndef b():\n    return 2\n');
  assert.match(applyHunks('x\nx\n', hunks('@@ x', '-x', '+y')).text, /^x\ny\n$/, '前面的段往后找');
});

test('一次改多个文件：新建、修改、删除、改名；都成了；之后不用重读就能接着改', () => {
  const { root, t } = seeded({ 'a.py': 'one\ntwo\n', 'b.py': 'keep\n', 'c.py': 'gone\n', 'd.py': 'old-name\n' });
  const r = applied(t, '*** Add File: new/dir/n.py', '+hello', '*** Update File: a.py', '-two', '+TWO', '*** Delete File: c.py', '*** Update File: d.py', '*** Move to: e.py', '-old-name', '+new-name');
  assert.equal(r.error, undefined, r.error);
  assert.equal(read(root, 'new/dir/n.py'), 'hello\n');
  assert.equal(read(root, 'a.py'), 'one\nTWO\n');
  assert.equal(read(root, 'b.py'), 'keep\n');
  assert.equal(read(root, 'e.py'), 'new-name\n');
  assert.equal(fs.existsSync(path.join(root, 'c.py')), false);
  assert.equal(fs.existsSync(path.join(root, 'd.py')), false, '改名：老的没了');
  assert.match(r.content, /4 个文件/);
  assert.match(r.content, /d\.py → e\.py/);
  assert.match(r.content, /c\.py（已删除，挪进了 \.zhiqu\/trash/);
  assert.equal(fs.readdirSync(path.join(root, '.zhiqu', 'trash')).length > 0, true, '删除和 delete_file 一样挪进回收站');
  assert.deepEqual(r.changed.sort(), ['a.py', 'c.py（已删除）', 'd.py（已删除）', 'e.py', 'new/dir/n.py'].sort());
  // 写过的不用重读
  assert.equal(applied(t, '*** Update File: a.py', '-TWO', '+2').error, undefined);
  assert.equal(applied(t, '*** Update File: new/dir/n.py', '-hello', '+hi').error, undefined);
  assert.equal(read(root, 'new/dir/n.py'), 'hi\n');
});

test('有一个文件不行，整个补丁都不打：前面的也不动', () => {
  const { root, t } = seeded({ 'a.py': 'one\n', 'b.py': 'two\n' });
  write(root, 'unread.py', 'x\n');
  const before = () => [read(root, 'a.py'), read(root, 'b.py'), read(root, 'unread.py')].join('|');
  const start = before();
  const noNew = () => assert.equal(fs.existsSync(path.join(root, 'n.py')), false, '前面的新文件也不能留下');
  const firstOk = ['*** Add File: n.py', '+x', '*** Update File: a.py', '-one', '+ONE'];
  for (const [tail, why] of [
    [['*** Update File: b.py', '-nope', '+x'], /原文对不上/],
    [['*** Update File: unread.py', '-x', '+y'], /必须先 read_file/],
    [['*** Update File: missing.py', '-x', '+y'], /不存在，不能 Update/],
    [['*** Add File: b.py', '+x'], /已经存在，不能 Add/],
    [['*** Delete File: unread.py'], /必须先 read_file/],
    [['*** Delete File: missing.py'], /不存在/],
    [['*** Update File: a.py', '-one', '+x'], /出现了不止一次/],
    [['*** Update File: b.py', '-two', '+x', '*** Move to: a.py'], /认不出来|开头不是/],
    [['*** Add File: ../escape.py', '+x'], /超出|工作区|不允许|outside/i],
    [['*** Add File: .git/hooks/pre-commit.py', '+x'], /\.git/],
    [['*** Add File: .zhiqu/settings.json', '+{}'], /\.zhiqu/],
  ]) {
    const r = applied(t, ...firstOk, ...tail);
    assert.ok(r.error, `该拒绝：${tail.join(' ')}`);
    assert.match(r.error, why);
    assert.equal(before(), start, tail.join(' '));
    noNew();
  }
  assert.equal(fs.existsSync(path.join(root, '..', 'escape.py')), false);
  // 别人改过：读过之后变了
  write(root, 'b.py', 'changed by user\n');
  assert.match(applied(t, ...firstOk, '*** Update File: b.py', '-changed by user', '+x').error, /被改过了/);
  noNew();
  // 大小上限、不是 UTF-8
  const small = new LocalTools({ root: tmpdir(), maxFileBytes: 10 });
  assert.match(small.preparePatch({ patch: patch('*** Add File: big.py', `+${'x'.repeat(20)}`) }).error, /超过 10 字节的上限/);
  const gbk = tools();
  fs.writeFileSync(path.join(gbk.root, 'g.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));
  gbk.t.readFile({ path: 'g.txt' });
  assert.match(gbk.t.preparePatch({ patch: patch('*** Update File: g.txt', '-x', '+y') }).error, /不是 UTF-8/);
  // 改名：目标已经有了
  const mv = seeded({ 'a.py': 'x\n', 'b.py': 'y\n' });
  assert.match(mv.t.preparePatch({ patch: patch('*** Update File: a.py', '*** Move to: b.py', '-x', '+z') }).error, /已经存在，不能改名过去/);
  assert.match(mv.t.preparePatch({ patch: patch('*** Update File: a.py', '*** Move to: .git/x.py', '-x', '+z') }).error, /\.git/);
});

test('确认期间被改过：一个都不动', () => {
  const { root, t } = seeded({ 'a.py': 'one\n', 'b.py': 'two\n' });
  const prep = t.preparePatch({ patch: patch('*** Update File: a.py', '-one', '+ONE', '*** Update File: b.py', '-two', '+TWO') });
  write(root, 'b.py', 'user\n');
  assert.match(t.commitPatch(prep).error, /确认期间被改过了，一个文件都没改/);
  assert.equal(read(root, 'a.py'), 'one\n');
  assert.equal(read(root, 'b.py'), 'user\n');
});

test('写到一半出错：全部退回（原文、新文件、新目录、回收站、临时文件），照实说', (t) => {
  for (const failAt of [1, 2, 3, 4, 5]) {   // 第几次改名出错：前四次是写文件，第五次是挪进回收站
    const { root, t: tool } = seeded({ 'a.py': 'one\n', 'b.py': 'two\n', 'c.py': 'gone\n' });
    const prep = tool.preparePatch({ patch: patch('*** Update File: a.py', '-one', '+ONE', '*** Add File: new/n.py', '+x', '*** Add File: same-dir.py', '+y', '*** Update File: b.py', '-two', '+TWO', '*** Delete File: c.py') });
    let calls = 0;
    const real = fs.renameSync;
    const mock = t.mock.method(fs, 'renameSync', (from, to) => {
      calls += 1;
      if (calls === failAt) throw new Error('磁盘满了');
      return real(from, to);
    });
    const r = tool.commitPatch(prep);
    mock.mock.restore();
    assert.match(r.error, /磁盘满了.*全部退回，一个文件都没改/, `第 ${failAt} 次`);
    assert.equal(read(root, 'a.py'), 'one\n', `第 ${failAt} 次：a.py 没退回`);
    assert.equal(read(root, 'b.py'), 'two\n', `第 ${failAt} 次：b.py 没退回`);
    assert.equal(read(root, 'c.py'), 'gone\n', `第 ${failAt} 次：c.py 没退回`);
    assert.equal(fs.existsSync(path.join(root, 'new')), false, `第 ${failAt} 次：新目录没收掉`);
    assert.equal(fs.existsSync(path.join(root, 'same-dir.py')), false, `第 ${failAt} 次：新文件没收掉`);
    assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes('zhiqu-tmp')), [], `第 ${failAt} 次：临时文件没收掉`);
    assert.equal(tool.commitPatch(tool.preparePatch({ patch: patch('*** Update File: a.py', '-one', '+ONE') })).error, undefined, '退回之后还能接着改（读过的记录还在）');
  }
  // 删除之后才出错：回收站里的挪回来
  const { root, t: tool } = seeded({ 'a.py': 'x\n', 'b.py': 'y\n' });
  const prep = tool.preparePatch({ patch: patch('*** Delete File: a.py', '*** Delete File: b.py') });
  const real = tool.commitDelete.bind(tool);
  let n = 0;
  tool.commitDelete = (d) => { n += 1; if (n === 2) throw new Error('挪不动'); return real(d); };
  assert.match(tool.commitPatch(prep).error, /挪不动/);
  assert.equal(read(root, 'a.py'), 'x\n', '第一个删掉的要挪回来');
  tool.commitDelete = real;
  assert.equal(tool.commitPatch(tool.preparePatch({ patch: patch('*** Delete File: a.py') })).error, undefined, '挪回来之后读过的记录还在');
});

test('写完查语法：写坏了当场说（和 write_file 一样）', () => {
  const { t } = seeded({ 'a.json': '{"a":1}\n' });
  const r = applied(t, '*** Update File: a.json', '-{"a":1}', '+{"a":', '*** Add File: ok.py', '+x = 1');
  assert.match(r.content, /a\.json 写进去的内容有语法错误/);
  assert.ok(r.syntax);
});

// ── 和真的 git 对照：git diff 的输出转成补丁，打上去要和目标一字不差 ──
function rng(seed) { let x = seed; return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; }
function toPatch(diff) {
  const out = ['*** Begin Patch'];
  for (const section of diff.split(/^diff --git /m).slice(1)) {
    const lines = section.split('\n');
    const file = lines[0].split(' b/')[1];
    if (section.includes('\nnew file mode')) {
      out.push(`*** Add File: ${file}`);
      for (const l of lines.slice(lines.findIndex((x) => x.startsWith('@@')) + 1)) if (l.startsWith('+')) out.push(l);
    } else if (section.includes('\ndeleted file mode')) {
      out.push(`*** Delete File: ${file}`);
    } else {
      out.push(`*** Update File: ${file}`);
      for (const l of lines.slice(lines.findIndex((x) => x.startsWith('@@')))) {
        if (l.startsWith('@@')) out.push('@@');
        else if (l && !l.startsWith('\\')) out.push(l);
      }
    }
  }
  out.push('*** End Patch');
  return out.join('\n');
}

test('一致性：真 git diff 转成补丁打上去，和目标一字不差（多个文件、新建、删除、100 轮随机改动）', { skip: spawnSync('git', ['--version']).status === 0 ? false : '没有 git' }, () => {
  const random = rng(42);
  const pick = (n) => Math.floor(random() * n);
  let applied_ = 0;
  for (let round = 0; round < 100; round++) {
    const { root, t } = tools();
    const git = (...args) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' } });
    git('init', '-q');
    const names = ['a.py', 'src/b.js', 'src/deep/c.txt', 'd.md'];
    const start = {};
    for (const f of names) {
      const n = 5 + pick(60);
      start[f] = Array.from({ length: n }, (_, i) => (i % 7 === 3 ? '' : i % 11 === 5 ? '}' : `${f} 第 ${i} 行 ${pick(1000)}`));
      write(root, f, `${start[f].join('\n')}\n`);
    }
    git('add', '-A');
    git('commit', '-qm', 'base');
    for (const f of names) t.readFile({ path: f });
    // 随机改：改一行、删几行、加几行
    const want = {};
    for (const f of names) {
      if (random() < 0.15) continue;
      const ls = [...start[f]];
      for (let k = 1 + pick(5); k > 0; k--) {
        const at = pick(ls.length);
        const kind = pick(3);
        if (kind === 0) ls[at] = `${ls[at]} 改过 ${pick(1000)}`;
        else if (kind === 1) ls.splice(at, 1 + pick(3));
        else ls.splice(at, 0, `新的一行 ${pick(1000)}`, `又一行 ${pick(1000)}`);
      }
      if (!ls.length) ls.push('只剩这一行');
      want[f] = `${ls.join('\n')}\n`;
      write(root, f, want[f]);
    }
    if (random() < 0.5) { want['added/new.py'] = `x = ${pick(1000)}\ny = 2\n`; write(root, 'added/new.py', want['added/new.py']); }
    const removed = random() < 0.3 ? names.find((f) => !want[f]) : null;
    if (removed) fs.rmSync(path.join(root, removed));
    git('add', '-A');
    const d = git('diff', '--cached', '--no-renames', '--no-color');
    assert.equal(d.status, 0, d.stderr);
    if (!d.stdout.trim()) continue;
    // 回到改之前
    git('reset', '-q', '--hard', 'HEAD');
    git('clean', '-qfd');
    for (const f of names) t.readFile({ path: f });
    const r = t.commitPatch(t.preparePatch({ patch: toPatch(d.stdout) }));
    assert.equal(r.error, undefined, `第 ${round} 轮：${r.error}\n${toPatch(d.stdout).slice(0, 800)}`);
    for (const [f, text] of Object.entries(want)) assert.equal(read(root, f), text, `第 ${round} 轮 ${f}`);
    if (removed) assert.equal(fs.existsSync(path.join(root, removed)), false, `第 ${round} 轮 ${removed} 该删了`);
    applied_ += 1;
  }
  assert.ok(applied_ > 80, `真的打过的轮数太少：${applied_}`);
});

// ── 循环里 ──
function agentCtx({ mode = 'auto', replies, answers = [], local, files = {} } = {}) {
  const root = local ? local.root : tmpdir();
  const tool = local || new LocalTools({ root });
  for (const [f, content] of Object.entries(files)) { write(root, f, content); tool.readFile({ path: f }); }
  const ui = fakeUi(answers);
  const store = new SessionStore(root);
  const ctx = { api: fakeApi(replies), ui, root, mode, maxRounds: 10, local: tool, store, session: store.create({ model: 'm' }), messages: [],
    allow: { write: false, run: false, delete: false, tasks: false, mcp: new Set() }, usage: { prompt: 0, completion: 0, cached: 0 }, changedFiles: new Set(), todos: [],
    system: { text: 'x' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], archiveDisabled: true, model: { id: 1, label: 'm', modelName: 'm', effectiveContextWindow: 100000 } };
  return { ctx, ui, root };
}
const callPatch = (...lines) => ({ calls: [{ name: 'apply_patch', args: { patch: patch(...lines) } }] });
const toolResult = (ctx) => ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
const twoFiles = ['*** Update File: a.py', '-one', '+ONE', '*** Add File: n.py', '+x'];

test('工具清单：plan 档不给；auto、ask 给', () => {
  const names = (mode) => toolset({ ...agentCtx({ mode, replies: [] }).ctx, mode }).map((x) => x.schema.function.name);
  assert.ok(names('auto').includes('apply_patch'));
  assert.ok(names('ask').includes('apply_patch'));
  assert.ok(!names('plan').includes('apply_patch'));
});

test('auto：不问，打上；记进改过的文件', async () => {
  const { ctx, ui, root } = agentCtx({ files: { 'a.py': 'one\n' }, replies: [callPatch(...twoFiles), { text: '好' }] });
  await runTurn(ctx, '改');
  assert.equal(read(root, 'a.py'), 'ONE\n');
  assert.equal(read(root, 'n.py'), 'x\n');
  assert.deepEqual([...ctx.changedFiles].sort(), ['a.py', 'n.py']);
  assert.doesNotMatch(ui.text(), /打这个补丁/);
  assert.match(ui.text(), /打补丁 a\.py、n\.py/);
});

test('ask：所有文件的 diff 摆出来、只问一次；说不就都不动；选「本会话都允许」之后不再问；带删除的还要问', async () => {
  const no = agentCtx({ mode: 'ask', answers: ['n'], files: { 'a.py': 'one\n' }, replies: [callPatch(...twoFiles), { text: '好' }] });
  await runTurn(no.ctx, '改');
  assert.equal(read(no.root, 'a.py'), 'one\n');
  assert.equal(fs.existsSync(path.join(no.root, 'n.py')), false);
  assert.match(toolResult(no.ctx), /用户没有同意这个补丁/);
  assert.match(no.ui.text(), /-one/);
  assert.match(no.ui.text(), /\+ONE/);
  assert.match(no.ui.text(), /打这个补丁（2 个文件）/);
  assert.equal((no.ui.text().match(/打这个补丁/g) || []).length, 1, '只问一次');

  const always = agentCtx({ mode: 'ask', answers: ['a'], files: { 'a.py': 'one\n', 'b.py': 'two\n' }, replies: [callPatch(...twoFiles), callPatch('*** Update File: b.py', '-two', '+TWO'), { text: '好' }] });
  await runTurn(always.ctx, '改');
  assert.equal(read(always.root, 'b.py'), 'TWO\n');
  assert.equal((always.ui.text().match(/打这个补丁/g) || []).length, 1, '「本会话都允许」之后不再问');

  const del = agentCtx({ mode: 'ask', answers: ['n'], files: { 'a.py': 'one\n' }, replies: [callPatch('*** Delete File: a.py'), { text: '好' }] });
  del.ctx.allow.write = true;
  await runTurn(del.ctx, '删');
  assert.equal(read(del.root, 'a.py'), 'one\n', '「本会话都允许写文件」不算允许删');
  assert.match(del.ui.text(), /删除 a\.py/);
});

test('打不上：告诉模型，连着失败有提醒', async () => {
  const bad = callPatch('*** Update File: a.py', '-nope', '+x');
  const { ctx, root } = agentCtx({ files: { 'a.py': 'one\n' }, replies: [bad, bad, bad, { text: '好' }] });
  await runTurn(ctx, '改');
  assert.equal(read(root, 'a.py'), 'one\n');
  assert.match(toolResult(ctx), /原文对不上，一个文件都没改/);
  assert.match(toolResult(ctx), /连续 \d 次没能改成 a\.py/);
});

test('网页：进草稿，磁盘不动；同一个文件接着改叠在草稿上；要么全成要么全不成；不能删、不能改名', () => {
  const root = tmpdir();
  write(root, 'a.py', 'one\ntwo\n');
  write(root, 'b.py', 'x\n');
  const t = new DraftTools({ root, canWrite: true, exec: async () => ({}) });
  assert.ok(t.allowedTools.has('apply_patch'));
  assert.ok(!new DraftTools({ root, exec: async () => ({}) }).allowedTools.has('apply_patch'), '没有写意图不给');
  t.readFile({ path: 'a.py' });
  t.readFile({ path: 'b.py' });
  const r = t.commitPatch(t.preparePatch({ patch: patch('*** Update File: a.py', '-one', '+ONE', '*** Add File: new/n.py', '+hi') }));
  assert.match(r.content, /已生成草稿（2 个文件，磁盘上的文件没有改动）/);
  assert.match(r.content, /确认后生效/, '和 edit_file 一样告诉模型别说「改好了」');
  assert.equal(read(root, 'a.py'), 'one\ntwo\n', '磁盘不动');
  assert.equal(fs.existsSync(path.join(root, 'new')), false);
  const drafts = Object.fromEntries(t.draftList().map((d) => [d.path, d]));
  assert.equal(drafts['a.py'].content, 'ONE\ntwo\n');
  assert.equal(drafts['new/n.py'].content, 'hi\n');
  assert.equal(drafts['new/n.py'].creating, true);
  assert.equal(drafts['new/n.py'].baseline, 'ABSENT');
  t.commitPatch(t.preparePatch({ patch: patch('*** Update File: a.py', '-two', '+TWO') }));
  assert.equal(Object.fromEntries(t.draftList().map((d) => [d.path, d]))['a.py'].content, 'ONE\nTWO\n', '叠在草稿上');
  assert.match(t.search({ query: 'TWO' }).content, /a\.py/, '搜得到草稿');
  // 有一个不行，都不进草稿
  const count = t.draftList().length;
  assert.match(t.preparePatch({ patch: patch('*** Update File: b.py', '-x', '+y', '*** Delete File: a.py') }).error, /不能删除/);
  assert.match(t.preparePatch({ patch: patch('*** Update File: b.py', '*** Move to: c.py', '-x', '+y') }).error, /不能删除/);
  assert.equal(t.draftList().length, count);
  // 读过之后磁盘变了：一个草稿都不生成
  const prep = t.preparePatch({ patch: patch('*** Update File: b.py', '-x', '+y', '*** Add File: m.py', '+z') });
  write(root, 'b.py', 'user\n');
  assert.match(t.commitPatch(prep).error, /一个草稿都没生成/);
  assert.equal(t.draftList().length, count);
});
