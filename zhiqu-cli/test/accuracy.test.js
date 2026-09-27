// 「叫它干一个活不要一直偏离然后一直修正，最好一次就成功」（用户 2026-09-27）。
// 这里钉的是让 agent 走弯路的几处：它以为自己看全了其实没有、改一段总是对不上原文、对不上时拿不到线索、
// 同一个失败反复撞而没有人叫停。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runTurn } from '../src/agent.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

function makeCtx({ mode = 'auto', replies = [{ text: '好' }], window = 64_000, root = tmpdir(), commands } = {}) {
  const store = new SessionStore(root);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode, maxRounds: 12,
    local: new LocalTools({ root, commands }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: window },
  };
}
const toolMessages = (ctx) => ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);

// ── 读 ────────────────────────────────────────────────────────────────

test('小窗口模型读长文件：按它一次能看的量分段给，头部说没读完；只看了一段就不许整份重写', async () => {
  const root = tmpdir();
  const body = Array.from({ length: 300 }, (_, i) => `const line${i} = '${'x'.repeat(20)}';`).join('\n') + '\n';
  write(root, 'big.js', body);
  const ctx = makeCtx({ root, window: 8000, replies: [
    { calls: [{ name: 'read_file', args: { path: 'big.js' } }] },
    { calls: [{ name: 'write_file', args: { path: 'big.js', content: 'const only = 1;\n' } }] },
    { text: '好' }] });
  await runTurn(ctx, '把 big.js 精简一下');
  const [read, write1] = toolMessages(ctx);
  assert.match(read, /第 1–\d+ 行（共 300 行）；没读完，用 offset=\d+ 接着读/, read.slice(0, 200));
  assert.ok(!/…（这段输出有 \d+ 字/.test(read), '读文件的结果不该再被通用截断从中间切掉 —— 那样它以为自己看到的是全文');
  assert.match(write1, /只读了一部分/);
  assert.equal(fs.readFileSync(path.join(root, 'big.js'), 'utf8'), body, '只看了开头就整份重写，把没看到的部分冲掉了');
});

test('一行就超过上限（压缩过的 js）：只给前面一段并说明，也不算读全', () => {
  const root = tmpdir();
  write(root, 'min.js', `var a=${'1+'.repeat(5000)}1;`);
  const tools = new LocalTools({ root });
  const r = tools.readFile({ path: 'min.js' }, { maxChars: 2000 });
  assert.ok(r.content.length < 2300, `给了 ${r.content.length} 字`);
  assert.match(r.content, /这一行有 \d+ 字，只显示了前 \d+ 字/);
  assert.match(tools.prepareWrite({ path: 'min.js', content: 'x' }).error, /只读了一部分/);
});

// ── 改一段 ─────────────────────────────────────────────────────────────

function readThenReplace(root, rel, oldStr, newStr, extra = {}) {
  const tools = new LocalTools({ root });
  tools.readFile({ path: rel });
  const prep = tools.prepareWrite({ path: rel, old_string: oldStr, new_string: newStr, ...extra });
  if (prep.error) return { error: prep.error };
  const r = tools.commitWrite(prep);
  return { ...r, text: fs.readFileSync(path.join(root, rel), 'utf8') };
}

test('Windows 换行（CRLF）的文件：多行 old_string 照样对得上，写回去仍是 CRLF（原来永远「没找到」）', () => {
  const root = tmpdir();
  write(root, 'a.txt', 'line1\r\nline2\r\nline3\r\n');
  const r = readThenReplace(root, 'a.txt', 'line1\nline2', 'L1\nL2');
  assert.ok(!r.error, r.error);
  assert.equal(r.text, 'L1\r\nL2\r\nline3\r\n');
});

test('混着两种换行的文件：照原样一字不差地比，也不把别的行的换行改掉', () => {
  const root = tmpdir();
  write(root, 'm.txt', 'a\r\nb\nc\n');
  const r = readThenReplace(root, 'm.txt', 'b', 'B');
  assert.equal(r.text, 'a\r\nB\nc\n');
});

test('old_string 的第一行还在、后面对不上（那段已经被改过了）：说出第一行在哪、现在是什么', () => {
  const root = tmpdir();
  write(root, 'g.js', 'function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price;\n  return sum;\n}\n');
  const r = readThenReplace(root, 'g.js', 'function total(items) {\n  let s = 0;\n  items.forEach((i) => { s += i.price; });', 'x');
  assert.match(r.error, /第一行出现在第 1 行/);
  assert.ok(r.error.includes('  let sum = 0;'), r.error);
});

test('old_string 只差缩进 / 行尾空白：不只说「没找到」，指出最像的那段在第几行、原文是什么', () => {
  const root = tmpdir();
  write(root, 'f.js', 'function f() {\n    return 1;\n}\n\nfunction g() {\n    return 2;   \n}\n');
  const a = readThenReplace(root, 'f.js', 'function f() {\n  return 1;\n}', 'x');
  assert.match(a.error, /第 1–3 行/);
  assert.ok(a.error.includes('    return 1;'), a.error);
  assert.match(a.error, /缩进|空白/);
  const b = readThenReplace(root, 'f.js', '    return 2;\n}', 'y');
  assert.match(b.error, /第 6–7 行/);
});

test('old_string 出现了好几处：说出是第几行，另外可以 replace_all 一次全换', () => {
  const root = tmpdir();
  write(root, 'c.js', 'let n = 0;\nn++;\nlet m = 0;\nn++;\nn++;\n');
  const many = readThenReplace(root, 'c.js', 'n++;', 'n += 1;');
  assert.match(many.error, /3 处/);
  assert.match(many.error, /第 2、4、5 行/);
  assert.match(many.error, /replace_all/);
  const all = readThenReplace(root, 'c.js', 'n++;', 'n += 1;', { replace_all: true });
  assert.equal(all.text, 'let n = 0;\nn += 1;\nlet m = 0;\nn += 1;\nn += 1;\n');
  assert.match(all.content, /替换了 3 处/);
});

test('搜索结果保留缩进：模型常把搜到的那行直接当 old_string，去掉缩进就对不上了', () => {
  const root = tmpdir();
  write(root, 'f.py', 'def f():\n    return 1\n');
  const r = new LocalTools({ root }).search({ query: 'return 1' });
  assert.ok(r.content.includes('f.py:2:     return 1'), r.content);
});

// ── 打转 ───────────────────────────────────────────────────────────────

test('同一个文件连续改不成：第 3 次失败时插一句「停下来重读原文」；改成一次就重新计数', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'const a = 1;\n');
  const bad = { name: 'write_file', args: { path: 'a.js', old_string: 'const a = 2;', new_string: 'const a = 3;' } };
  const good = { name: 'write_file', args: { path: 'a.js', old_string: 'const a = 1;', new_string: 'const a = 9;' } };
  const ctx = makeCtx({ root, replies: [
    { calls: [{ name: 'read_file', args: { path: 'a.js' } }] },
    { calls: [bad] }, { calls: [bad] }, { calls: [bad] }, { calls: [good] }, { calls: [bad] }, { calls: [bad] }, { text: '好' }] });
  await runTurn(ctx, '改一下');
  const out = toolMessages(ctx);
  assert.ok(!/连续 \d 次/.test(out[1]) && !/连续 \d 次/.test(out[2]), '前两次不该插');
  assert.match(out[3], /连续 3 次没能改成 a\.js/);
  assert.match(out[3], /read_file/);
  assert.match(out[4], /已修改 a\.js/);
  assert.ok(!/连续 \d 次/.test(out[6]), `改成过一次之后应当重新计数：${out[6]}`);
});

test('同一条命令同样失败 3 次：提醒先读完整错误、找根因，想清楚再改；成功一次就重新计数', async () => {
  const root = tmpdir();
  write(root, 'fail.js', 'console.error("boom"); process.exit(1);\n');
  const run = { name: 'run_command', args: { command: 'node', args: ['fail.js'] } };
  const ctx = makeCtx({ root, commands: ['node'], replies: [{ calls: [run] }, { calls: [run] }, { calls: [run] }, { text: '好' }] });
  await runTurn(ctx, '跑一下');
  const out = toolMessages(ctx);
  assert.ok(!/连续 \d 次/.test(out[1]));
  assert.match(out[2], /node fail\.js 已经连续 3 次失败/);
  assert.match(out[2], /根因/);
});

test('用户说了新的一句话就重新计数：上一轮的失败不算到这一轮', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'const a = 1;\n');
  const bad = { name: 'write_file', args: { path: 'a.js', old_string: 'nope', new_string: 'x' } };
  const ctx = makeCtx({ root, replies: [
    { calls: [{ name: 'read_file', args: { path: 'a.js' } }] }, { calls: [bad] }, { calls: [bad] }, { text: '没改成' },
    { calls: [bad] }, { text: '还是没改成' }] });
  await runTurn(ctx, '改一下');
  await runTurn(ctx, '再试试');
  const out = toolMessages(ctx);
  assert.equal(out.length, 4);
  assert.ok(!out.some((m) => /连续 \d 次/.test(m)), out.join('\n---\n'));
});
