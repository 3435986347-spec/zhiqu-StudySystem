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
  const [thinking, list, read, search, edit, create, ran] = f;
  // 第一百二十八轮（用户：「思考内容没有显示出来」）：点开「思考」看得到想了什么
  assert.equal(thinking.detail.text, '先看看有什么文件', '思考的原文没进那一步');
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

test('想完直接调工具（一个字正文都没写）：思考那一步排在工具前面，用时照实，不是「1 秒」', async () => {
  const root = tmpdir();
  write(root, 'a.txt', 'hi\n');
  const { ctx, steps } = ctxWith([{ reasoning: '先读一下这个文件', calls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: '好' }], { root });
  await runTurn(ctx, '读');
  const f = finals(steps);
  assert.deepEqual(f.map((s) => s.kind), ['thinking', 'read'], '思考排到了工具后面（或者根本没记）');
  assert.equal(f[0].detail.text, '先读一下这个文件');
  assert.ok(f[0].ms >= 0, '思考那一步没有用时');
  assert.equal(f[0].summary, `${Math.max(1, Math.round(f[0].ms / 1000))} 秒`);
});

test('调工具前的那一句是 note，排在工具前面；太长的截断；没有字就没有这条', async () => {
  const root = tmpdir();
  write(root, 'a.txt', 'hi\n');
  const { judgmentText, NOTE_CHARS } = await import('../src/steps.js');
  const long = `先看边界。${'测'.repeat(80)}`;
  const { ctx, steps } = ctxWith([
    { text: '先看 a.txt 的结构', calls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    { text: long, calls: [{ name: 'read_file', args: { path: 'a.txt', offset: 1, limit: 1 } }] },
    { calls: [{ name: 'read_file', args: { path: 'a.txt', offset: 1, limit: 1 } }] },
    { text: '好' },
  ], { root });
  await runTurn(ctx, '看');
  const f = finals(steps);
  assert.equal(f[0].kind, 'note');
  assert.equal(f[0].title, '先看 a.txt 的结构');
  assert.equal(f[0].status, 'ok');
  assert.equal(f[0].detail, undefined, '判断点不开');
  assert.equal(f[1].kind, 'read');
  const notes = f.filter((s) => s.kind === 'note');
  assert.equal(notes.length, 2, `没有字的那一轮不该有判断：${notes.map((s) => s.title)}`);
  assert.equal(notes[1].title, judgmentText(long));
  assert.equal(notes[1].title.length, NOTE_CHARS);
  assert.ok(notes[1].title.endsWith('…'));
  assert.notEqual(notes[1].title, long);
  assert.ok(!notes[1].title.includes('测'.repeat(40)));
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

test('存到网站的那一份：每一步单独给（不再拼「过程：…」进正文）；没有步骤时不带 steps 字段', async () => {
  const { archiveTurn } = await import('../src/agent.js');
  const posts = [];
  const api = { post: async (p, body) => { posts.push(body); return {}; } };
  const ctx = { api, ui: fakeUi(), local: { root: tmpdir() }, session: { id: 's', title: 't' }, archiveSteps: [{ id: 's1', kind: 'run', title: '运行', target: 'npm test', summary: '退出码 0', status: 'ok' }] };
  await archiveTurn(ctx, '跑一下', { finalText: '过了', steps: ['运行 npm test'] });
  const assistant = posts[0].messages[1];
  assert.equal(assistant.content, '过了', '正文后面又拼了一行过程');
  assert.ok(!/过程：/.test(assistant.content));
  assert.equal(assistant.steps.length, 1);
  assert.deepEqual(ctx.archiveSteps, [], '存过的步骤没清掉：下一句会带上这一句的');
  ctx.archiveSteps = [];
  await archiveTurn(ctx, '你好', { finalText: '你好', steps: [] });
  assert.ok(!('steps' in posts[1].messages[1]));
});

test('真命令行的那份 ctx：终端照常，存档的步骤按 id 留最后那条；子 agent 的步骤不混进来', async () => {
  const root = tmpdir();
  write(root, 'a.txt', 'hi\n');
  const { ctx } = ctxWith([{ calls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: '好' }], { root });
  ctx.archiveSteps = [];
  ctx.stepLog = new StepLog((step) => {
    const at = ctx.archiveSteps.findIndex((x) => x.id === step.id);
    if (at >= 0) ctx.archiveSteps[at] = step; else ctx.archiveSteps.push(step);
  });
  await runTurn(ctx, '读');
  assert.equal(ctx.archiveSteps.length, 1);
  assert.equal(ctx.archiveSteps[0].status, 'ok');
  const { SubAgents } = await import('../src/subagents.js');
  const child = new SubAgents({ runTurn }).childContext(ctx, { id: 'explorer-1', role: 'explorer', jobs: new Set(), changedFiles: new Set() });
  assert.equal(child.stepLog, null, '子 agent 拿到了主 agent 的 stepLog：它的每一步会混进主 agent 的存档');
});

test('思考很长：步骤里留前 THINKING_KEEP 字，说省了多少；像密钥的遮掉', async () => {
  const { THINKING_KEEP } = await import('../src/agent.js');
  const long = 'a'.repeat(THINKING_KEEP + 500) + ' sk-proj-abcdefghijklmnopqrstuvwx';
  const { ctx, steps } = ctxWith([{ reasoning: 'password=hunter2hunter2 想一下', calls: [{ name: 'list_files', args: {} }] }, { reasoning: long, text: '好' }]);
  await runTurn(ctx, '想');
  const [first, , second] = finals(steps);
  assert.equal(first.kind, 'thinking');
  assert.ok(!first.detail.text.includes('hunter2hunter2'), first.detail.text);
  assert.equal(first.detail.omitted, undefined, '没截也说「后面还有 N 字没存」：遮掉密钥变短不是没存');
  assert.equal(second.detail.text.length, THINKING_KEEP);
  assert.ok(second.detail.omitted > 0, '截了没说');
});

test('exec --output-schema 推回去重写（origin system 的那一轮）不清掉干活那一段的存档步骤；人说的下一句才清', async () => {
  const { rewriteUntilValid } = await import('../src/execmode.js');
  const root = tmpdir();
  write(root, 'a.txt', 'hi\n');
  const { ctx } = ctxWith([{ calls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: '不是 JSON' }, { text: '{"n":1}' }], { root });
  ctx.archiveSteps = [];
  ctx.stepLog = new StepLog((step) => {
    const at = ctx.archiveSteps.findIndex((x) => x.id === step.id);
    if (at >= 0) ctx.archiveSteps[at] = step; else ctx.archiveSteps.push(step);
  });
  const first = await runTurn(ctx, '数');
  const checked = await rewriteUntilValid(ctx, { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }, first, {});
  assert.deepEqual(checked.value, { n: 1 }, '前提：重写过一次');
  assert.ok(ctx.archiveSteps.some((s) => s.kind === 'read'), `重写那一轮把干活那一段的步骤清掉了：${JSON.stringify(ctx.archiveSteps)}`);
  await runTurn(ctx, '下一句');
  assert.ok(!ctx.archiveSteps.some((s) => s.kind === 'read'), '人说的下一句开头没清');
});

test('一轮超过 200 步：存前 200 步，没存的步数一起交上去（截断要说出来）；同一步先 running 后收尾只算一次；发完从头记', async () => {
  const { archiveStep, archiveTurn, ARCHIVE_STEPS } = await import('../src/agent.js');
  const posts = [];
  const ctx = { api: { post: async (p, body) => { posts.push(body); return {}; } }, ui: fakeUi(), local: { root: tmpdir() }, session: { id: 's', title: 't' }, archiveSteps: [] };
  for (let i = 0; i < ARCHIVE_STEPS + 5; i++) {
    archiveStep(ctx, { id: `s${i}`, kind: 'read', title: '读取', status: 'running' });
    archiveStep(ctx, { id: `s${i}`, kind: 'read', title: '读取', status: 'ok' });
  }
  await archiveTurn(ctx, '读很多', { finalText: '读完了' });
  const assistant = posts[0].messages[1];
  assert.equal(assistant.steps.length, ARCHIVE_STEPS);
  assert.equal(assistant.stepsDropped, 5, '没存的步数没交上去（或者 running / 收尾各算了一次）');
  archiveStep(ctx, { id: 'n1', kind: 'read', title: '读取', status: 'ok' });
  await archiveTurn(ctx, '再读一个', { finalText: '好' });
  assert.ok(!('stepsDropped' in posts[1].messages[1]), '上一轮的没存步数串到了下一轮');
  assert.equal(posts[1].messages[1].steps.length, 1);
});

test('模型没写判断时，读 / 搜各补一行（否则一整轮屏幕空白，看着像卡死）', async () => {
  const root = tmpdir();
  write(root, 'a.txt', 'hi\n');
  const { ctx } = ctxWith([
    { calls: [{ name: 'read_file', args: { path: 'a.txt' } }, { name: 'search', args: { query: 'hi' } }] },
    { text: '好了' },
  ], { root });
  const lines = [];
  ctx.ui.note = (t) => lines.push(t);
  ctx.ui.interactive = true;   // 只在真终端里补（管道 / -p / exec 的输出不动）
  await runTurn(ctx, '读一下');
  assert.deepEqual(lines, ['· 读取 a.txt', '· 搜索「hi」']);
});

test('模型写了判断：只打那一句，不重复补工具那行', async () => {
  const root = tmpdir();
  write(root, 'a.txt', 'hi\n');
  const { ctx } = ctxWith([
    { text: '先看一眼 a.txt', calls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    { text: '好了' },
  ], { root });
  const lines = [];
  ctx.ui.note = (t) => lines.push(t);
  ctx.ui.interactive = true;
  await runTurn(ctx, '读一下');
  assert.deepEqual(lines, ['· 先看一眼 a.txt']);
});

test('管道 / -p 里不补：非交互终端保持原来的安静', async () => {
  const root = tmpdir();
  write(root, 'a.txt', 'hi\n');
  const { ctx } = ctxWith([{ calls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: '好了' }], { root });
  const lines = [];
  ctx.ui.note = (t) => lines.push(t);
  ctx.ui.interactive = false;
  await runTurn(ctx, '读一下');
  assert.deepEqual(lines, []);
});

test('截图消息排在整批工具结果之后：assistant(tool_calls) 后面必须紧跟每一条 tool，否则供应商 400', async () => {
  const root = tmpdir();
  write(root, 'a.html', '<h1>x</h1>');
  const local = new LocalTools({ root });
  local.chrome = '/fake/chrome';   // 这台机器上不一定有 Chrome：只要工具被下发就行
  local.previewPage = async () => {
    local.pendingImage = { mediaType: 'image/png', base64: 'QUJD' };
    return { content: '截好了', summary: '已截图 1200×900' };
  };
  const { ctx } = ctxWith([
    { calls: [{ name: 'preview_page', args: { path: 'a.html' } }, { name: 'read_file', args: { path: 'a.html' } }] },
    { text: '看过了，排版没问题' },
  ], { root, local });
  await runTurn(ctx, '看看这个页面');

  const msgs = ctx.messages;
  const at = msgs.findIndex((m) => (m.tool_calls || []).length === 2);
  assert.ok(at >= 0, '没找到那条有两个调用的 assistant 消息：' + JSON.stringify(msgs.map((m) => m.role)));
  const ids = msgs[at].tool_calls.map((c) => c.id);
  const between = msgs.slice(at + 1, at + 1 + ids.length);
  assert.deepEqual(between.map((m) => m.role), ['tool', 'tool'], '工具结果之间插了别的消息 —— 供应商会报 insufficient tool messages');
  assert.deepEqual(between.map((m) => m.tool_call_id), ids, '工具结果的顺序和 id 对不上');
  const after = msgs[at + 1 + ids.length];
  assert.equal(after.role, 'user', '截图消息没排在工具结果之后');
  assert.ok(Array.isArray(after.content) && after.content.some((p) => p.type === 'image_url'), '截图没跟上来');
});
