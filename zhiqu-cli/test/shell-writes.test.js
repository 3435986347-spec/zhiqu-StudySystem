// 长活省钱第 4 步（第一百六十九轮，docs/agent-efficiency-plan.md）：shell 改了哪些文件看得见，用脚本改源码时提醒改用编辑工具。
// 用户那段会话里 shell 201 次有 158 次在写文件、127 次是 Python 的 s.replace：找不到原文不报错，改动也不进「改过的文件」。
// 用户 2026-11-24 定的：提醒，不拒绝（批量生成、格式化这类确实要脚本）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runTurn, shellWriteNotes } from '../src/agent.js';
import { CLEAR_KEEP_RECENT, clearStale, estimateMessages } from '../src/compact.js';
import { LocalTools } from '../src/tools/local.js';
import { detectSandbox } from '../src/tools/sandbox.js';
import { changeLine, diffSnapshots, dropUnchanged, hashFiles, inlineEdit, mentionedFiles, NUDGE_EVERY, snapshot, usesReplace, writtenByShell } from '../src/tools/shell-writes.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

const later = (file) => { const t = new Date(Date.now() + 5_000); fs.utimesSync(file, t, t); };

test('快照：比得出改了、新建、删掉的；依赖和版本库目录不看；太多 / 太慢返回 null（不猜）', () => {
  const root = tmpdir();
  write(root, 'a.js', 'a'); write(root, 'b.js', 'b'); write(root, 'src/c.js', 'c');
  write(root, 'node_modules/x/index.js', 'x'); write(root, '.git/HEAD', 'ref'); write(root, '.zhiqu/sessions/s.jsonl', '{}');
  const before = snapshot(root);
  assert.deepEqual([...before.keys()].sort(), ['a.js', 'b.js', 'src/c.js']);
  fs.writeFileSync(path.join(root, 'src/c.js'), 'cc'); later(path.join(root, 'src/c.js'));
  write(root, 'new.js', 'n'); fs.rmSync(path.join(root, 'b.js'));
  write(root, 'node_modules/x/index.js', 'changed');
  assert.deepEqual(diffSnapshots(before, snapshot(root)), { modified: ['src/c.js'], created: ['new.js'], deleted: ['b.js'] });
  assert.equal(snapshot(root, { maxFiles: 2 }), null, '超过数量上限');
  let t = 0;
  assert.equal(snapshot(root, { now: () => (t += 1_000) }), null, '超过时间上限');
  assert.equal(diffSnapshots(null, before), null);
});

test('工具结果里那一行：写得出、认得回（多于 20 个说「等 N 个」）；什么都没改就不写', () => {
  const line = changeLine({ modified: ['src/a.js'], created: ['b.js', 'c.css'], deleted: ['old.txt'] });
  assert.equal(line, '（这条命令改动了文件：修改 src/a.js；新建 b.js、c.css；删除 old.txt）');
  assert.deepEqual(writtenByShell(`$ python3 - <<'PY'\n退出码 0\n${line}`), ['src/a.js', 'b.js', 'c.css', 'old.txt']);
  const many = Array.from({ length: 25 }, (_, i) => `f${i}.js`);
  const long = changeLine({ modified: many, created: [], deleted: [] });
  assert.match(long, /f19\.js 等 25 个）$/);
  assert.equal(writtenByShell(long).length, 20);
  assert.equal(changeLine({ modified: [], created: [], deleted: [] }), '');
  assert.equal(changeLine(null), '');
  assert.deepEqual(writtenByShell('普通输出'), []);
});

test('认得出「在 shell 里用脚本改文件」；跑测试、跑脚本文件、只读的命令、普通重定向不算', () => {
  for (const c of [
    "cd src && python3 - <<'PY'\ns=open('a.js').read()\ns=s.replace('x','y')\nopen('a.js','w').write(s)\nPY",
    "python3 -c \"import pathlib; p=pathlib.Path('a.js'); p.write_text(p.read_text().replace('a','b'))\"",
    "sed -i '' 's/foo/bar/' src/a.js",
    "sed --in-place 's/foo/bar/' a.js",
    "perl -pi -e 's/foo/bar/' a.js",
    "cat > src/a.js <<'EOF'\nconsole.log(1)\nEOF",
    "cd app && cat >> src/a.js <<'EOF'\nexport const x = 1\nEOF",   // 那段会话里漏认的一条：追加写
    "node -e \"const fs=require('fs');fs.writeFileSync('a.js', fs.readFileSync('a.js','utf8').replace('a','b'))\"",
  ]) assert.ok(inlineEdit(c), `该认出：${c.slice(0, 60)}`);
  for (const c of ['npm test', 'python3 build.py', 'python3 -c "print(1)"', "sed -n '1,20p' a.js", 'cat a.js', 'grep -n foo src', 'echo hi > out.txt', 'node scripts/gen.js > out.json', "git commit -m 'open(x, \"w\")'"]) {
    assert.ok(!inlineEdit(c), `不该认出：${c}`);
  }
  assert.ok(usesReplace("s=s.replace('a','b')"));
  assert.ok(usesReplace("sed -i 's/a/b/' x"));
  assert.ok(!usesReplace("open('a','w').write('x')"));
});

test('提醒：内联脚本改了已有的文件才提醒，第 1 次说、之后每 5 次说一次；新建文件不提醒；改动都记进改过的文件', () => {
  const ctx = {};
  const edit = "python3 - <<'PY'\ns=open('a.js').read().replace('x','y')\nopen('a.js','w').write(s)\nPY";
  const said = [];
  for (let i = 0; i < 12; i++) said.push(/【提醒】你在用 shell 里的脚本改已有的源码（a\.js）/.test(shellWriteNotes(ctx, edit, { modified: ['a.js'], created: [], deleted: [] }, 0)));
  assert.deepEqual(said.map((x, i) => (x ? i + 1 : 0)).filter(Boolean), [1, 1 + NUDGE_EVERY, 1 + 2 * NUDGE_EVERY], '第 1、6、11 次');
  assert.ok(ctx.changedFiles.has('a.js'));
  const gen = shellWriteNotes(ctx, "cat > new.js <<'EOF'\nx\nEOF", { modified: [], created: ['new.js'], deleted: ['gone.js'] }, 0);
  assert.ok(!gen.includes('【提醒】'), '新建的不提醒（生成文件确实可以用脚本）');
  assert.ok(ctx.changedFiles.has('new.js') && ctx.changedFiles.has('gone.js（已删除）'));
  assert.equal(shellWriteNotes(ctx, 'npm run build', { modified: ['dist/a.js'], created: [], deleted: [] }, 0), '\n（这条命令改动了文件：修改 dist/a.js）', '构建改了文件：记下来，不提醒');
  assert.equal(shellWriteNotes({}, edit, null, 0), '', '快照比不了：什么都不说');
});

test('用字符串替换却一个文件都没改动：每次都说「原文多半没对上」（str.replace 不报错）', () => {
  const ctx = {};
  const noop = "python3 - <<'PY'\ns=open('a.js').read()\ns=s.replace('NOT THERE','y')\nopen('a.js','w').write(s)\nPY";
  for (let i = 0; i < 3; i++) assert.match(shellWriteNotes(ctx, noop, { modified: [], created: [], deleted: [] }, 0), /【提醒】这条命令用字符串替换改文件，跑完了却一个文件都没改动/);
  assert.ok(!shellWriteNotes(ctx, noop, { modified: [], created: [], deleted: [] }, 1).includes('【提醒】'), '命令失败了另说（失败自己会报）');
});

test('shell 改过的文件：之前读过的那份认得出「之后改过」，清掉之后占位里也带着那一行', () => {
  let n = 0;
  const pair = (name, args, output) => { const id = `s${++n}`; return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: id, content: output }]; };
  const ms = [{ role: 'user', content: 'x' },
    ...pair('read_file', { path: './src/a.js' }, `【src/a.js】\n${'r'.repeat(60_000)}`),
    ...pair('shell', { command: 'python3 - <<PY ...' }, `$ python3\n退出码 0（0.2s）\n${'o'.repeat(3000)}\n（这条命令改动了文件：修改 src/a.js）`)];
  for (let i = 0; i < CLEAR_KEEP_RECENT; i++) ms.push(...pair('search', { query: `k${i}` }, 'k'.repeat(900)));
  const r = clearStale(ms, { limit: estimateMessages(ms) - 1, minFree: 100 });
  assert.match(r.messages[2].content, /^（旧的读取已清理：read_file src\/a\.js，原来 \d+ 字。这个文件之后改过/);
  const all = clearStale(ms, { limit: 2_000, minFree: 100 });
  assert.match(all.messages[4].content, /^（旧的命令输出已清理：[\s\S]*）（这条命令改动了文件：修改 src\/a\.js）$/, '占位里带着改了哪些');
  assert.deepEqual(writtenByShell(all.messages[4].content), ['src/a.js']);
});

const box = detectSandbox();
test('真跑：循环里 shell 用 Python 改文件 —— 结果里写着改了哪些、提醒改用编辑工具、记进改过的文件；替换没对上照实说', { skip: box ? false : '这台机器没有系统沙箱' }, async () => {
  const root = tmpdir();
  write(root, 'src/a.js', "const greeting = 'hello';\n");
  const edit = "cd src && python3 - <<'PY'\ns=open('a.js').read()\ns=s.replace(\"'hello'\", \"'hi'\")\nopen('a.js','w').write(s)\nPY";
  const miss = "cd src && python3 - <<'PY'\ns=open('a.js').read()\ns=s.replace(\"'NOT THERE'\", \"'x'\")\nopen('a.js','w').write(s)\nPY";
  const ctx = {
    ui: fakeUi([]), api: fakeApi([{ calls: [{ name: 'shell', args: { command: edit } }] }, { calls: [{ name: 'shell', args: { command: miss } }] }, { text: '改好了' }]),
    root, mode: 'auto', maxRounds: 10, local: new LocalTools({ root, sandbox: box }), messages: [],
    allow: { write: true, run: true, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: 'm', effectiveContextWindow: 64000 },
  };
  const result = await runTurn(ctx, '把 hello 改成 hi');
  assert.equal(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), "const greeting = 'hi';\n", '命令真的改了文件（沙箱里能写工作区）');
  const tools = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(tools[0], /（这条命令改动了文件：修改 src\/a\.js）/, tools[0]);
  assert.match(tools[0], /【提醒】你在用 shell 里的脚本改已有的源码（src\/a\.js）/);
  assert.match(tools[1], /【提醒】这条命令用字符串替换改文件，跑完了却一个文件都没改动/, tools[1]);
  assert.ok(!/这条命令改动了文件/.test(tools[1]), '第二条把一模一样的内容写回去了：修改时间变了，内容没变 —— 不算改了');
  assert.deepEqual(result.changedFiles, ['src/a.js']);
});

test('原样写回去的不算改了：命令里提到的文件（认 cd 前缀）前后比内容；真改了的照样算', async () => {
  const root = tmpdir();
  write(root, 'src/a.js', 'A'); write(root, 'src/b.js', 'B'); write(root, 'top.md', 'T');
  const cmd = "cd src && python3 - <<'PY'\ns=open('a.js').read()\nopen('a.js','w').write(s)\nopen('b.js','w').write('BB')\nPY && cat ../top.md nope.js";
  assert.deepEqual(mentionedFiles(root, '.', cmd).sort(), ['src/a.js', 'src/b.js', 'top.md']);
  assert.deepEqual(mentionedFiles(root, 'src', 'cat a.js'), ['src/a.js'], '在子目录里跑的：相对它');
  const before = snapshot(root);
  const hashes = await hashFiles(root, mentionedFiles(root, '.', cmd));
  fs.writeFileSync(path.join(root, 'src/a.js'), 'A'); later(path.join(root, 'src/a.js'));
  fs.writeFileSync(path.join(root, 'src/b.js'), 'BB'); later(path.join(root, 'src/b.js'));
  const raw = diffSnapshots(before, snapshot(root));
  assert.deepEqual(raw.modified, ['src/a.js', 'src/b.js'], '只看修改时间：两个都像改了');
  assert.deepEqual((await dropUnchanged(root, raw, hashes)).modified, ['src/b.js'], '内容没变的 a.js 拿掉');
  assert.equal(await dropUnchanged(root, null, hashes), null);
});
