// 一步一条的执行记录（第一百二十七轮）：真的 runTurn + 真的 LocalTools，看每种工具记下来的那一步对不对。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runTurn } from '../src/agent.js';
import { headTail, OUTPUT_HEAD, OUTPUT_TAIL, StepLog, titleOf, kindOf } from '../src/steps.js';
import { detectSandbox } from '../src/tools/sandbox.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

function ctxWith(replies, { root = tmpdir(), local } = {}) {
  const steps = [];
  const ctx = {
    ui: fakeUi(), api: fakeApi(replies), root, mode: 'auto', maxRounds: 12,
    local: local || new LocalTools({ root, sandbox: detectSandbox() }), store: null, session: { id: 't' }, messages: [],
    allow: { write: false, run: false, delete: false, tasks: false, mcp: new Set() }, usage: { prompt: 0, completion: 0, cached: 0 }, changedFiles: new Set(),
    system: { text: '系统' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: 'm', effectiveContextWindow: 64_000 },
  };
  ctx.stepLog = new StepLog((s) => steps.push(JSON.parse(JSON.stringify(s))));
  return { ctx, steps, root };
}
/** 每一步最后的样子（开始一条、结束一条：按 id 取最后那条） */
const finals = (steps) => { const m = new Map(); for (const s of steps) m.set(s.id, s); return [...m.values()]; };

test('每种工具按顺序记一步：思考、列目录、读、搜、新建、修改、运行（输出、退出码）；开始时是 running，结束时有结果', async () => {
  const root = tmpdir();
  write(root, 'src/app.js', 'export function add(a, b) {\n  return a - b;\n}\n');
  const run = detectSandbox() ? { name: 'shell', args: { command: 'echo hello; echo bad >&2; exit 3' } } : { name: 'run_command', args: { command: 'node', args: ['-e', 'console.log("hello");process.exit(3)'] } };
  const { ctx, steps } = ctxWith([
    { reasoning: '先看看有什么文件', calls: [{ name: 'list_files', args: { path: 'src' } }] },
    { calls: [{ name: 'read_file', args: { path: 'src/app.js' } }, { name: 'search', args: { query: 'return' } }] },
    { calls: [{ name: 'edit_file', args: { path: 'src/app.js', old_string: 'return a - b;', new_string: 'return a + b;' } },
      { name: 'write_file', args: { path: 'src/new.txt', content: '一\n二\n' } }] },
    { calls: [run] },
    { text: '改好了' },
  ], { root });
  await runTurn(ctx, '修 add');
  const f = finals(steps);
  assert.deepEqual(f.map((s) => s.kind), ['thinking', 'list', 'read', 'search', 'edit', 'create', 'run']);
  assert.ok(steps.find((s) => s.kind === 'list' && s.status === 'running'), '开始时没有 running 那一条');
  assert.ok(f.every((s) => s.status !== 'running'), JSON.stringify(f));
  const [, list, read, search, edit, create, ran] = f;
  assert.equal(list.target, 'src');
  assert.match(list.summary, /1 项/);
  assert.ok(list.detail.items.some((l) => l.includes('app.js')), JSON.stringify(list.detail));
  assert.equal(read.target, 'src/app.js');
  assert.match(read.summary, /3 行/);
  assert.match(search.summary, /1 处/);
  assert.equal(edit.title, '修改');
  assert.equal(edit.summary, '+1 -1');
  assert.deepEqual(edit.detail.files[0].hunks.filter((l) => /^[+-]/.test(l)), ['-  return a - b;', '+  return a + b;']);
  assert.equal(create.title, '新建');
  assert.equal(create.detail.files[0].added, 2);
  assert.equal(ran.kind, 'run');
  assert.equal(ran.status, 'error', '退出码 3 要算失败');
  assert.equal(ran.detail.exitCode, 3);
  assert.match(ran.detail.output, /hello/);
  assert.match(ran.summary, /退出码 3/);
  assert.ok(f.every((s) => typeof s.ms === 'number'), '每一步都要有用时');
});

test('失败的也记一步：没有这个工具、参数坏了、改不上（原文没找到）', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n');
  const { ctx, steps } = ctxWith([
    { calls: [{ name: 'no_such_tool', args: {} }, { name: 'read_file', rawArgs: '{"path": ' }, { name: 'edit_file', args: { path: 'a.js', old_string: 'nope', new_string: 'y' } }] },
    { text: '好' },
  ], { root });
  await runTurn(ctx, '试');
  const f = finals(steps);
  assert.equal(f.length, 3);
  assert.ok(f.every((s) => s.status === 'error'), JSON.stringify(f.map((s) => [s.title, s.status, s.summary])));
  assert.match(f[1].summary, /参数不对/);
});

test('命令输出只留头尾，省掉多少照实说；超长的一行截断', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
  const r = headTail(lines.join('\n'));
  const kept = r.output.split('\n');
  assert.equal(kept.length, OUTPUT_HEAD + OUTPUT_TAIL);
  assert.equal(kept[0], 'line 1');
  assert.equal(kept[kept.length - 1], 'line 500');
  assert.equal(r.omitted, 500 - OUTPUT_HEAD - OUTPUT_TAIL);
  assert.equal(r.splitAt, OUTPUT_HEAD);
  assert.ok(headTail('x'.repeat(5000)).output.length < 500);
  assert.equal(headTail('a\nb\n\n\n').output, 'a\nb', '结尾的空行不算');
});

test('没有 stepLog（命令行的终端）：不记，工具照常跑', async () => {
  const root = tmpdir();
  write(root, 'a.txt', 'hi\n');
  const { ctx } = ctxWith([{ calls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: '好' }], { root });
  ctx.stepLog = null;
  const r = await runTurn(ctx, '读');
  assert.equal(r.finalText, '好');
});

test('标题、种类：每个下发的工具都有说法（没有的落到 other，不是空的）', () => {
  assert.equal(kindOf('apply_patch'), 'patch');
  assert.equal(kindOf('shell'), 'run');
  assert.equal(kindOf('whatever'), 'other');
  assert.deepEqual(titleOf('shell', { command: 'npm test', background: true }), { title: '后台运行', target: 'npm test' });
  assert.equal(titleOf('mcp__github__list', {}).target, 'github/list');
});

test('生成到产物（写的是真的）不说「草稿」；选了文件夹（草稿）说；补丁的加减行数按整份算，不按截过的分块数', async () => {
  const { ArtifactTools, DraftTools } = await import('../src/tools/drafts.js');
  const { patchDetail, HUNK_LINES } = await import('../src/steps.js');
  const exec = async () => ({ exitCode: 0, output: '', timedOut: false, millis: 1 });
  for (const [Tools, draft] of [[ArtifactTools, false], [DraftTools, true]]) {
    const root = tmpdir();
    const local = new Tools({ root, exec, canWrite: true });
    const { ctx, steps } = ctxWith([{ calls: [{ name: 'write_file', args: { path: 'n.txt', content: 'a\n' } }] }, { text: '好' }], { root, local });
    await runTurn(ctx, '写');
    const s = finals(steps).find((x) => x.kind === 'create');
    assert.ok(s, JSON.stringify(steps));
    assert.equal(/草稿/.test(s.summary), draft, `${Tools.name}：${s.summary}`);
  }
  const big = Array.from({ length: HUNK_LINES + 200 }, (_, i) => `line ${i}`).join('\n');
  const d = patchDetail({ writes: [{ rel: 'big.txt', oldText: '', newText: big, creating: true }], deletes: [] });
  assert.equal(d.files[0].added, HUNK_LINES + 200, '加了几行要按整份算');
  assert.ok(d.files[0].omitted > 0, '截了要说');
});

test('存进步骤之前遮住像密钥的东西（只改步骤里的那份，给模型的工具结果不动）；普通输出不误伤', async () => {
  const { redact, runDetail } = await import('../src/steps.js');
  const sample = [
    'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx',
    'DB_PASSWORD="hunter2hunter2"',
    'token: ghp_abcdefghijklmnopqrstuvwxyz0123',
    'aws AKIAABCDEFGHIJKLMNOP',
    'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrst',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    'zqp_abcdefghijklmnopqrstuvwx',
  ].join('\n');
  const out = redact(sample);
  for (const secret of ['sk-proj-abcdefghijklmnopqrstuvwx', 'hunter2hunter2', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'AKIAABCDEFGHIJKLMNOP', 'eyJhbGciOiJIUzI1NiJ9', 'MIIEow', 'zqp_abcdefghijklmnopqrstuvwx']) {
    assert.ok(!out.includes(secret), `没遮住：${secret}\n${out}`);
  }
  assert.match(out, /OPENAI_API_KEY=［已遮住］/);
  const normal = 'ok 12 - passes\nnpm test\nexpected 3, got 2\nsrc/token.js:12: export const tokenize = (s) => s.split(" ");';
  assert.equal(redact(normal), normal, '普通输出被误伤了');
  assert.ok(!runDetail({ command: 'cat .env' }, { output: sample, exitCode: 0 }).output.includes('hunter2hunter2'));
});

test('搜索那一步点开是全部命中（第一条不丢）；只有一条也有', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'const needle = 1;\n');
  write(root, 'b.js', 'needle();\n');
  const { ctx, steps } = ctxWith([{ calls: [{ name: 'search', args: { query: 'needle' } }] }, { calls: [{ name: 'search', args: { query: 'const needle' } }] }, { text: '好' }], { root });
  await runTurn(ctx, '搜');
  const [two, one] = finals(steps);
  assert.equal(two.detail.items.length, 2, JSON.stringify(two.detail));
  assert.ok(two.detail.items.some((l) => l.startsWith('a.js')) && two.detail.items.some((l) => l.startsWith('b.js')));
  assert.equal(one.detail.items.length, 1, JSON.stringify(one.detail));
});
