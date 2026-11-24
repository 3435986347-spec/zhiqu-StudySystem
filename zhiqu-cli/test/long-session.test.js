// 长活省钱与不空转第 1 步（第一百六十六轮，docs/agent-efficiency-plan.md）。照用户一段真实长会话修的三处：
// 1. 目标核对员明说不思考；没答好再问一次，两次都没答好照实说、不算执行者没做到（原来 6 次核对失败里 4 次是核对员自己没答）。
// 2. 先清也清旧工具调用的参数（write_file 的内容、apply_patch 的补丁、shell 的脚本）—— 原来只清输出，大头在参数里，十六次先清都放弃了。
// 3. 大窗口过了软上限、先清又清不出：直接摘要，不等到八成（原来 1M 窗口背到 78 万才摘）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGoal, runTurn, VERIFY_MAX_TOKENS } from '../src/agent.js';
import { ARGS_CLEAR_MIN, CLEAR_KEEP_RECENT, clearStale, estimateMessages, softCompactable, softKeep, softLimit } from '../src/compact.js';
import { newGoal, parseVerdict } from '../src/goal.js';
import { SUMMARY_PREFIX } from '../src/origins.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

function ctxWith(replies, { window = 64_000, goal = null, effort } = {}) {
  const root = tmpdir();
  const store = new SessionStore(root);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds: 10, local: new LocalTools({ root }), store,
    session: store.create(), messages: [], allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 },
    changedFiles: new Set(), system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: window }, ...(goal ? { goal: newGoal(goal) } : {}), ...(effort ? { effort } : {}),
  };
}
const ACHIEVED = { calls: [{ name: 'goal_update', args: { status: 'achieved', summary: '做完了', evidence: '跑了 node snake.js，输出 ok' } }] };
const VERIFIED = { text: '{"achieved": true, "missing": ""}' };
const verifyRequests = (ctx) => ctx.api.requests.filter((r) => !r.tools.length && /严格的核对员/.test(String(r.messages[0].content)));

// ── 1. 核对员 ──────────────────────────────────────────────────────────

test('核对员照用户的档位思考、输出上限 8192（第一百七十二轮真模型量过：不思考可读但太松，思考 + 2048 会被截断）', async () => {
  const ctx = ctxWith([ACHIEVED, { text: '好了' }, VERIFIED], { goal: '做个贪吃蛇', effort: 'max' });
  assert.equal(await runGoal(ctx), 'achieved');
  const v = verifyRequests(ctx);
  assert.equal(v.length, 1);
  assert.equal(v[0].reasoning, 'max', '核对照用户的档位思考（不思考的核对员 21 次里判达成 18 次，太松）');
  assert.equal(v[0].maxTokens, VERIFY_MAX_TOKENS);
  assert.ok(VERIFY_MAX_TOKENS >= 4096, '上限要够思考用完再写结论（量过最多 3027）');
});

test('核对员第一次没答好：再问一次，答好了就照它的结论；不记失败', async () => {
  const ctx = ctxWith([ACHIEVED, { text: '好了' }, { text: '' }, VERIFIED], { goal: '做个贪吃蛇' });
  assert.equal(await runGoal(ctx), 'achieved');
  assert.equal(verifyRequests(ctx).length, 2, '没答好要再问一次');
  assert.equal(ctx.goal.verifyFailures, 0);
  assert.match(ctx.ui.text(), /核对通过/);
});

test('核对员两次都没答好：照实说没核对成，不记失败、不推执行者回去重做', async () => {
  const ctx = ctxWith([ACHIEVED, { text: '好了' }, { text: '' }, { text: '我觉得差不多' }, { text: '不该走到这里' }], { goal: '做个贪吃蛇' });
  assert.equal(await runGoal(ctx, { maxTurns: 3 }), 'achieved', '限 3 轮：推回去重做的话会转到上限、返回 exhausted');
  assert.equal(verifyRequests(ctx).length, 2);
  assert.equal(ctx.goal.verifyFailures, 0, '核对员没答好不是执行者没做到');
  assert.equal(ctx.goal.turns, 1, '不推执行者再跑一轮');
  assert.ok(!ctx.messages.some((m) => m.role === 'user' && /核对没通过/.test(String(m.content))), '不能把「核对员没给结论」当缺口推给执行者');
  assert.match(ctx.ui.text(), /核对员两次都没给出可读的结论.*没核对成/);
  assert.equal(ctx.store.load(ctx.session.id).goal.status, 'achieved');
});

test('核对员真的不认：照旧记失败、带着缺口推回去（没答好和不认是两回事）', async () => {
  const ctx = ctxWith([ACHIEVED, { text: '好了' }, { text: '{"achieved": false, "missing": "没跑测试"}' }, ACHIEVED, { text: '跑了' }, VERIFIED], { goal: '做个贪吃蛇' });
  assert.equal(await runGoal(ctx), 'achieved');
  assert.equal(ctx.goal.verifyFailures, 1);
  assert.equal(verifyRequests(ctx).length, 2, '答好了的不认不重问');
});

test('解析：没有 JSON、JSON 坏了算没答好（unreadable）；答了 false 不算', () => {
  assert.equal(parseVerdict('').unreadable, true);
  assert.equal(parseVerdict('{"achieved": tru').unreadable, true);
  assert.equal(parseVerdict('{achieved: true}').unreadable, true);
  assert.equal(parseVerdict('{"achieved": false, "missing": "x"}').unreadable, undefined);
  assert.equal(parseVerdict('{"achieved": true}').achieved, true);
});

// ── 2. 旧调用的参数 ────────────────────────────────────────────────────

let seq = 0;
const tool = (name, args, output) => { const id = `c${++seq}`; return [
  { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
  { role: 'tool', tool_call_id: id, content: output },
]; };
const big = (ch) => ch.repeat(20_000);
const patch = (file, body) => `*** Begin Patch\n*** Update File: ${file}\n@@\n-${body}\n+${body}x\n*** End Patch`;
const argsOf = (ms) => ms.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((c) => ({ name: c.function.name, raw: c.function.arguments })));

/** 照用户那段会话的形状：调用的参数很大（整份内容、heredoc 脚本），结果很短（「已写入」） */
function writeHeavy() {
  const ms = [{ role: 'user', content: '做个 3D 页面' }];
  for (let i = 0; i < 6; i++) ms.push(...tool('write_file', { path: `./a${i}.js`, content: big('w') }, `已新建 a${i}.js（+300 -0）`));
  ms.push(...tool('apply_patch', { patch: patch('p.js', big('p')) }, '已修改 p.js'));
  ms.push(...tool('shell', { command: `cd src && python3 - <<'PY'\ns=open('a.js').read()\ns=s.replace("${big('s')}", "x")\nPY` }, '退出码 0（0.2s）'));
  ms.push(...tool('edit_file', { path: 'e.js', old_string: big('o'), new_string: big('n') }, '已修改 e.js'));
  ms.push(...tool('write_file', { path: 'small.js', content: 'tiny' }, '已新建 small.js'));
  for (let i = 0; i < CLEAR_KEEP_RECENT; i++) ms.push(...tool('write_file', { path: `keep${i}.js`, content: big('k') }, `已新建 keep${i}.js`));
  return ms;
}

test('先清也清旧调用的参数：输出都很短、只清输出一点都清不出时，参数照样清得下来；换成合法 JSON 的占位，调用和结果还是一对', () => {
  const ms = writeHeavy();
  const total = estimateMessages(ms);
  const spilled = [];
  const r = clearStale(ms, { limit: total - 1, minFree: 1_000, spill: (text) => { spilled.push(text); return '.zhiqu/sessions/s1/out/1.txt'; } });
  assert.equal(r.cleared, 0, '输出都短于 800 字：一条输出都不清');
  assert.ok(r.args >= 8, `旧的大参数要清：清了 ${r.args} 个`);
  assert.ok(estimateMessages(r.messages) < total * 0.6, `清完 ${estimateMessages(r.messages)} / ${total}`);

  const after = argsOf(r.messages);
  for (const a of after) assert.doesNotThrow(() => JSON.parse(a.raw), `参数得是合法 JSON：${a.raw.slice(0, 80)}`);
  const parsed = after.map((a) => ({ ...a, args: JSON.parse(a.raw) }));
  const w0 = parsed.find((a) => a.args.path === 'a0.js');
  assert.ok(w0 && !('content' in w0.args), '写入的内容不在了');
  assert.match(w0.args._cleared, /^（旧的 write_file 参数已清理，原来 \d+ 字；a0\.js 在磁盘上，要看现在的内容就 read_file）$/);
  const ap = parsed.find((a) => a.name === 'apply_patch');
  assert.deepEqual(ap.args.files, ['p.js'], '补丁清了也留着动过哪些文件');
  assert.ok(!('patch' in ap.args));
  const sh = parsed.find((a) => a.name === 'shell');
  assert.ok(!('command' in sh.args), '不留半截 command：模型照着占位再调一次会跑出半截命令');
  assert.match(sh.args.command_head, /^cd src && python3 - <<'PY'/);
  assert.match(sh.args._cleared, /原文存在 \.zhiqu\/sessions\/s1\/out\/1\.txt/);
  assert.equal(spilled.length, 1, '脚本另存一份（参数是 shell 才存；写文件的内容在磁盘上）');
  assert.ok(spilled[0].includes("python3 - <<'PY'"));
  const ed = parsed.find((a) => a.name === 'edit_file');
  assert.equal(ed.args.path, 'e.js');
  assert.ok(!('old_string' in ed.args) && !('new_string' in ed.args));

  assert.equal(parsed.find((a) => a.args.path === 'small.js').raw, JSON.stringify({ path: 'small.js', content: 'tiny' }), `短于 ${ARGS_CLEAR_MIN} 字的不动`);
  for (let i = 0; i < CLEAR_KEEP_RECENT; i++) {
    assert.equal(parsed.find((a) => a.args.path === `keep${i}.js`).args.content, big('k'), '最近 8 条结果对应的调用不动（刚写的，可能还要照着改）');
  }
  assert.equal(r.messages.length, ms.length);
  r.messages.forEach((m, i) => {
    if (m.role === 'tool') assert.equal(m.tool_call_id, ms[i].tool_call_id);
    if (m.role === 'assistant' && m.tool_calls) assert.equal(m.tool_calls[0].id, ms[i].tool_calls[0].id, '调用的 id 不变');
  });
  assert.equal(JSON.parse(ms[1].tool_calls[0].function.arguments).content, big('w'), '不改传进来的那一份');
  assert.equal(clearStale(r.messages, { limit: 10, minFree: 1 }).args, 0, '已经是占位的不再清');
});

test('补丁的参数清过之后：之前读过的那个文件照样认得出「之后改过」', () => {
  const ms = [{ role: 'user', content: 'x' },
    ...tool('read_file', { path: 'p.js' }, `【p.js】\n${'r'.repeat(60_000)}`),
    ...tool('apply_patch', { files: ['p.js'], _cleared: '（旧的补丁已清理）' }, '已修改 p.js')];
  for (let i = 0; i < CLEAR_KEEP_RECENT; i++) ms.push(...tool('search', { query: `k${i}` }, 'k'.repeat(900)));
  const r = clearStale(ms, { limit: estimateMessages(ms) - 1, minFree: 100 });
  assert.match(r.messages[2].content, /^（旧的读取已清理：read_file p\.js，原来 \d+ 字。这个文件之后改过/);
});

// ── 3. 过了软上限清不出就摘 ────────────────────────────────────────────

const SUMMARY = '## 目标\n做一个很长的活\n## 当前进展和下一步\n接着做第 41 步';
/** 清不掉的东西（助手自己的长话）占大头：先清一点都清不出 */
function prose(rounds) {
  const ms = [{ role: 'user', content: '开始做' }];
  for (let i = 0; i < rounds; i++) ms.push({ role: 'assistant', content: `第 ${i + 1} 步的说明 ${'字'.repeat(10_000)}` }, { role: 'user', content: '继续' });
  return ms;
}
// 人说的新一句开头会先问一次「是不是换了一件事」（第一百七十轮）：那一次不算摘要
const NOT_NEW = { text: '{"new_task": false}' };
const summaryRequests = (ctx) => ctx.api.requests.filter((r) => !r.tools.length && !/判断刚说的这句/.test(String(r.messages[0].content)));

test('软上限：只对大窗口有意义；摘要留原文的预算是软上限的三分之一（不然摘完马上又过线）', () => {
  assert.equal(softCompactable(1_000_000), true);
  assert.equal(softKeep(1_000_000), 100_000);
  assert.equal(softCompactable(64_000), false, '小窗口的软上限本来就是六成那条线，照旧');
  assert.equal(softCompactable(400_000), false);
});

test('1M 窗口过了软上限、先清清不出：这一轮就摘，摘完压到软上限以下；不等到八成', async () => {
  const ctx = ctxWith([NOT_NEW, { text: SUMMARY }, { text: '接着做完了' }], { window: 1_000_000 });
  ctx.messages = prose(36);
  const before = estimateMessages(ctx.messages);
  assert.ok(before > softLimit(1_000_000) && before < 600_000, `背着 ${before}：过了软上限、没到六成`);
  await runTurn(ctx, '继续');
  assert.equal(summaryRequests(ctx).length, 1, `要调一次模型写摘要：${ctx.ui.text()}`);
  assert.ok(String(ctx.messages[0].content).startsWith(SUMMARY_PREFIX));
  assert.ok(estimateMessages(ctx.messages) < softLimit(1_000_000) * 0.5, `摘完 ${estimateMessages(ctx.messages)}`);
  assert.match(ctx.ui.text(), /上下文占用过了 300000 token、旧的工具输出清不出多少/);
});

test('软上限那次摘要没写成：不一轮一摘，要再多背一截才再试', async () => {
  const call = { calls: [{ name: 'list_files', args: { path: '.' } }] };
  const ctx = ctxWith([NOT_NEW, { text: '' }, { text: '' }, call, call, { text: '做完了' }], { window: 1_000_000 });
  ctx.messages = prose(36);
  await runTurn(ctx, '继续');
  assert.equal(summaryRequests(ctx).length, 2, `第一轮写了两次（第二次是重来）都是空的；之后两轮不再试：${summaryRequests(ctx).length}`);
  assert.ok(ctx.softCompactStuckAt > softLimit(1_000_000));
});

test('64K 窗口的行为不变：过了软上限、没到六成，不摘', async () => {
  const ctx = ctxWith([NOT_NEW, { text: '好' }], { window: 64_000 });
  ctx.messages = prose(4);   // 约 4 万：过了 38400，没到 51200
  const before = estimateMessages(ctx.messages);
  assert.ok(before > softLimit(64_000) && before < 64_000 * 0.8, `${before}`);
  await runTurn(ctx, '继续');
  assert.equal(summaryRequests(ctx).length, 0);
});
