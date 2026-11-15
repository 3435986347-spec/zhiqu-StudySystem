// 工作状态卡（第一百三十八轮，docs/memory-plan.md 第 2 步）：压缩压不掉、进程崩了也在的那一份。
// 由来（用户 2026-11-15 给的一段 23 小时的真实会话）：压缩 105 次，清单整份重列 6 次、做完的项丢了 3 次，
// 同一段着色器改到第 10 版，建了 42 个临时文件，每次压缩后先重新看 12 步才动手；进程崩掉时连进度笔记都没留下。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { restoreAfterCompaction, runTurn, toolset, workOf } from '../src/agent.js';
import { generatedOrigin } from '../src/origins.js';
import { SessionStore } from '../src/session.js';
import { CHURN_WARN, firstChangedLine, sameItem, statePath, WorkState } from '../src/state.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

function makeCtx({ replies = [{ text: '好' }], window = 64_000, root = tmpdir(), store = true, maxRounds = 30 } = {}) {
  const s = store ? new SessionStore(root) : null;
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds,
    local: new LocalTools({ root }), store: s, session: s ? s.create() : { id: 'web-code-agent' }, messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: window },
  };
}
const call = (name, args) => ({ calls: [{ name, args }] });
const todos = (...items) => call('update_todos', { todos: items.map(([content, status, evidence]) => ({ content, status, ...(evidence ? { evidence } : {}) })) });
const toolResults = (ctx) => ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
/** 摘要那次调用（不带工具）单独答，不占 replies 的位置：压缩在第几轮触发不用样例去猜 */
function answerSummaries(ctx, text = '## 目标\n摘要') {
  const real = ctx.api.stream.bind(ctx.api);
  ctx.summaries = 0;
  ctx.api.stream = async (p, body, on) => {
    if (body.tools.length) return real(p, body, on);
    ctx.summaries++;
    ctx.api.requests.push(JSON.parse(JSON.stringify(body)));
    on('start', {});
    on('delta', { text });
    on('done', { message: { role: 'assistant', content: text }, finishReason: 'stop', maxTokens: 8000, usage: { promptTokens: 1, completionTokens: 1 } });
    return undefined;
  };
  return ctx;
}
const onDisk = (ctx) => JSON.parse(fs.readFileSync(statePath(ctx), 'utf8'));

test('清单记账：做完的项不会因为重列清单就丢；重列成没做的会被提醒；验证方法记着', async () => {
  assert.ok(sameItem('修 HUD 排版（左上位置行/左下生命体征不重叠）', '修 HUD 排版：左上位置行、左下生命体征不重叠'));
  assert.ok(!sameItem('修 HUD 排版', '重写天空云层'));
  const ctx = makeCtx({ replies: [
    todos(['修 HUD 排版', 'in_progress'], ['重写天空云层', 'pending']),
    todos(['修 HUD 排版', 'completed', '截图里左上两行不再重叠'], ['重写天空云层', 'in_progress']),
    // 模型「失忆」之后重列一份：做完的那项没了，还把它换了个说法又列成没做的
    todos(['重写天空云层', 'in_progress'], ['修 HUD 的排版', 'pending'], ['改光照', 'pending']),
    todos(['重写天空云层', 'in_progress'], ['改光照', 'pending']),
    { text: '清单还没做完，要等你定？' },
  ] });
  await runTurn(ctx, '把画面做成白天的');
  const replies = toolResults(ctx);
  assert.ok(!/还记着|标过完成/.test(replies[1]), '正常标完成不用多说');
  assert.match(replies[2], /「修 HUD 的排版」这一项之前标过完成（验证：截图里左上两行不再重叠）/);
  assert.match(replies[3], /已经做完的 1 项不在这份清单里，命令行还记着，不用重做：「修 HUD 排版」/);
  const saved = onDisk(ctx);
  assert.equal(saved.done.length, 1);
  assert.equal(saved.done[0].evidence, '截图里左上两行不再重叠');
  assert.deepEqual(saved.todos.map((t) => t.status), ['in_progress', 'pending']);
  assert.match(workOf(ctx).card(), /### 已经做完的[^\n]*\n- \d\d:\d\d 修 HUD 排版 —— 验证：截图里左上两行不再重叠/);
  assert.ok(!('evidence' in ctx.todos[0]), '给模型复述的清单还是原来的样子');
});

test('note：定过的事、走不通的路、位置、临时文件记进状态卡；kind 不对、没有 text 说清楚；子 agent 没有这个工具', async () => {
  const ctx = makeCtx({ replies: [
    call('note', { kind: 'decision', text: '天空用体积云，不用贴图：贴图在 4K 下糊' }),
    call('note', { kind: 'dead_end', text: '把曝光调到 1.6 整屏发白' }),
    call('note', { kind: 'anchor', text: 'FS_SKY 着色器从这里开始', path: './index.html', line: 921 }),
    call('note', { kind: 'temp', text: '截图用的外壳', path: '_shot.html' }),
    call('note', { kind: 'rule', text: 'x' }),
    call('note', { kind: 'decision', text: '  ' }),
    { text: '记好了' },
  ] });
  await runTurn(ctx, '接着做');
  const r = toolResults(ctx);
  assert.match(r[0], /记下了（定过的事/);
  assert.match(r[4], /kind 只能是/);
  assert.match(r[5], /没有 text/);
  const card = workOf(ctx).card();
  assert.match(card, /### 定过的事\n- 天空用体积云/);
  assert.match(card, /### 走不通的路（试过不行，别再试）\n- 把曝光调到 1\.6 整屏发白/);
  assert.match(card, /- `index\.html:921` FS_SKY 着色器从这里开始/);
  assert.match(card, /`_shot\.html`（临时）/);
  assert.ok(toolset(ctx).some((t) => t.schema.function.name === 'note'));
  assert.ok(toolset({ ...ctx, mode: 'plan' }).some((t) => t.schema.function.name === 'note'), 'plan 档也给：只写状态卡');
  assert.ok(!toolset({ ...ctx, subagent: { id: 'a1', role: 'worker' } }).some((t) => t.schema.function.name === 'note'));
  // 同一句再记一次是更新，不是多一条；一类最多 20 条
  const w = new WorkState(null);
  const distinct = (i) => `${(i * 7919 + 13).toString(36).repeat(6)} 决定 ${i}`;
  for (let i = 0; i < 30; i++) w.note({ kind: 'decision', text: distinct(i) });
  w.note({ kind: 'decision', text: distinct(29) });
  assert.equal(w.data.notes.decision.length, 20);
});

test('同一处改到第 6 回提醒一次（跨压缩也数着）；新建的文件有名单，shell 建的也在', async () => {
  assert.equal(firstChangedLine('a\nb\nc', 'a\nB\nc'), 2);
  assert.equal(firstChangedLine('a\nb', 'a\nb\nc'), 3);
  assert.equal(firstChangedLine('a', 'a'), null);
  const root = tmpdir();
  write(root, 'sky.js', `${'line\n'.repeat(300)}color = 0;\n${'tail\n'.repeat(300)}`);
  const edits = Array.from({ length: 7 }, (_, i) => call('edit_file', { path: 'sky.js', old_string: `color = ${i};`, new_string: `color = ${i + 1};` }));
  const ctx = makeCtx({ root, replies: [call('read_file', { path: 'sky.js' }), ...edits, call('write_file', { path: '_sky_v2.txt', content: 'x\n' }), { text: '改完了' }] });
  // shell 建的文件工具那边看不到：这一句进行中在盘上多出一个
  const realStream = ctx.api.stream.bind(ctx.api);
  let n = 0;
  ctx.api.stream = async (...a) => { if (++n === 3) write(root, 'made-by-shell.py', 'print(1)\n'); return realStream(...a); };
  await runTurn(ctx, '调天空');
  const r = toolResults(ctx);
  assert.equal(CHURN_WARN[0], 6);
  const warned = r.map((t, i) => (/这段会话里已经改了 \d+ 回/.test(t) ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(warned, [6], `只在第 6 回改完时提醒：${warned}`);
  assert.match(r[6], /`sky\.js` 第 201–400 行这一段，这段会话里已经改了 6 回/);
  const saved = onDisk(ctx);
  assert.equal(saved.files['sky.js'].edits, 7);
  assert.deepEqual(saved.created.sort(), ['_sky_v2.txt', 'made-by-shell.py']);
  const card = workOf(ctx).card();
  assert.match(card, /`sky\.js`：改了 7 回（\+7 -7）/);
  assert.match(card, /`sky\.js` 第 201 行起的 200 行：7 回/);
  assert.match(card, /`_sky_v2\.txt`（临时）/);
  assert.match(card, /made-by-shell\.py/);
});

test('压完还回去：状态卡 + 压缩前在看的那几段代码的当前内容；清单不再另补一条', async () => {
  const root = tmpdir();
  write(root, 'big.js', Array.from({ length: 900 }, (_, i) => `// 第 ${i + 1} 行 ${'x'.repeat(60)}`).join('\n'));
  write(root, 'other.js', '// other\n'.repeat(50));
  const reads = [call('read_file', { path: 'other.js' }), ...Array.from({ length: 9 }, (_, i) => call('read_file', { path: 'big.js', offset: 1 + i, limit: 400 })),
    call('read_file', { path: 'big.js', offset: 600, limit: 60 })];
  const ctx = makeCtx({ root, window: 30_000, replies: [
    todos(['读懂 big.js', 'completed', '读过 600 行'], ['改第 620 行', 'in_progress']),
    call('note', { kind: 'decision', text: '只改第 620 行，别动别处' }),
    ...reads,
    { text: '接着改，但要先问你一句？' },
  ] });
  answerSummaries(ctx, '## 目标\n改 big.js');
  await runTurn(ctx, '把 big.js 第 620 行改掉，别的不要动');
  const restored = ctx.messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('（对话刚压缩过'));
  assert.ok(ctx.summaries >= 1 && restored.length === ctx.summaries, `压了 ${ctx.summaries} 次，还回去 ${restored.length} 次：${ctx.ui.text()}`);
  const text = restored.at(-1).content;
  assert.equal(generatedOrigin(text), 'system', '这一条是命令行补的，不能算用户的原话');
  assert.match(text, /### 用户说过的话（逐字，按先后）\n1\. 把 big\.js 第 620 行改掉，别的不要动/);
  assert.match(text, /- \[~\] 改第 620 行/);
  assert.match(text, /读懂 big\.js —— 验证：读过 600 行/);
  assert.match(text, /只改第 620 行，别动别处/);
  assert.match(text, /### 压缩之前正在看的代码（现在的内容）/);
  // 压缩在第几轮触发跟样例的大小走，代码那一段单独验：最后看的是第 600–659 行，盘上那一行后来变了，还回来的要是现在的
  fs.writeFileSync(path.join(root, 'big.js'), fs.readFileSync(path.join(root, 'big.js'), 'utf8').replace('// 第 620 行 x', '// 第 620 行 改过了 x'));
  restoreAfterCompaction(ctx, 30_000);
  const again = ctx.messages.at(-1).content;
  assert.match(again, /第 620 行 改过了 x/, '压缩前最后在看的那一段要还回来，而且是现在的内容');
  assert.ok(!again.includes('第 200 行'), '太大的那一段（1–408 行）超了预算，不给');
  assert.ok(!ctx.messages.some((m) => /对话压缩过，再说一遍/.test(String(m.content))), '清单在状态卡里了，不再另补一条');
  // 压缩之后发给模型的最后一次请求里就有它
  assert.ok(JSON.stringify(ctx.api.requests.at(-1).messages).includes('对话刚压缩过'));
  // 预算：还回去的代码不超过窗口的 15%（一段太大就不给）
  const tight = makeCtx({ root, window: 4000 });
  const w = workOf(tight);
  w.beginTurn('x'); w.focus('big.js', 1, 900);
  restoreAfterCompaction(tight, 4000);
  assert.ok(!tight.messages.at(-1).content.includes('第 450 行'), '超预算的那一段不该塞进来');
});

test('挑时机：过了六成、又正好有一项刚标完成，就在这里压；没有刚做完的不压', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n'.repeat(2500));
  const read = (i) => call('read_file', { path: 'a.js', offset: 1, limit: 2000 + i });
  const base = [todos(['读', 'in_progress'], ['改', 'pending']), ...Array.from({ length: 6 }, (_, i) => read(i))];
  const plain = makeCtx({ root, window: 12_000, replies: [...base, read(9), { text: '读完了，还要问你？' }] });
  await runTurn(plain, '读');
  assert.equal(plain.api.requests.filter((r) => !r.tools.length).length, 0, '没到八成、也没有刚做完的项：不压');
  const root2 = tmpdir();
  write(root2, 'a.js', 'x\n'.repeat(2500));
  const timed = makeCtx({ root: root2, window: 12_000, replies: [...base, todos(['读', 'completed'], ['改', 'in_progress']), { text: '接着改，要问你？' }] });
  answerSummaries(timed);
  await runTurn(timed, '读');
  assert.equal(timed.summaries, 1, `一项刚做完、占用过六成：${timed.ui.text()}`);
});

test('进程半路没了：状态卡还在；这个项目里新开的会话开工时被告知，清单和做完的一条不少', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'const a = 1;\n');
  const first = makeCtx({ root, replies: [
    todos(['把 a 改成 2', 'completed', 'node -e 打印出 2'], ['把 b 也改了', 'in_progress']),
    call('read_file', { path: 'a.js' }),
    call('edit_file', { path: 'a.js', old_string: 'const a = 1;', new_string: 'const a = 2;' }),
    { text: '不该走到这' },
  ] });
  // 第三次调模型时「进程没了」：runTurn 直接抛出去，收尾那一段没机会跑
  const realStream = first.api.stream.bind(first.api);
  let n = 0;
  first.api.stream = async (...a) => { if (++n === 4) throw new Error('kill -9'); return realStream(...a); };
  await assert.rejects(runTurn(first, '把 a 和 b 都改成 2'));
  const left = JSON.parse(fs.readFileSync(statePath(first), 'utf8'));
  assert.equal(left.turn.status, 'running', '崩之前每变一次就落盘了');
  assert.equal(left.files['a.js'].edits, 1);

  const second = makeCtx({ root, replies: [{ text: '知道了' }] });
  await runTurn(second, '继续');
  // 还没来得及调任何工具就没了：这一句说了什么、正在做，也已经在盘上
  const early = makeCtx({ root: tmpdir() });
  early.api.stream = async () => { throw new Error('kill -9'); };
  await assert.rejects(runTurn(early, '刚说完就崩了'));
  const earlyLeft = JSON.parse(fs.readFileSync(statePath(early), 'utf8'));
  assert.equal(earlyLeft.turn.status, 'running');
  assert.equal(earlyLeft.said[0].text, '刚说完就崩了');
  const told = second.messages[0].content;
  assert.match(told, /^（上一段会话「把 a 和 b 都改成 2」没做完：进程没正常退出。/);
  assert.equal(generatedOrigin(told), 'system');
  assert.match(told, /- \[~\] 把 b 也改了/);
  assert.match(told, /把 a 改成 2 —— 验证：node -e 打印出 2/);
  assert.match(told, /`a\.js`：改了 1 回/);
  assert.equal(second.messages.filter((m) => /上一段会话/.test(String(m.content))).length, 1, '只说一次');
  // 上一段正常做完了的：不提
  const third = makeCtx({ root, replies: [{ text: '好' }] });
  await runTurn(third, '新的事');
  assert.ok(!third.messages.some((m) => /上一段会话/.test(String(m.content))), '最近的那一段做完了，不该再提更早的');
});

test('桌面 / 网页（每一轮是新进程，没有会话记录）：没做完 → 下一轮接上、清单带回来；做完 → 项目里不留文件；过一天不接', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'const a = 1;\n');
  const mk = (replies, maxRounds = 3) => makeCtx({ root, store: false, replies, maxRounds });
  const first = mk([todos(['改 a', 'in_progress'], ['改 b', 'pending']), call('read_file', { path: 'a.js' }), call('edit_file', { path: 'a.js', old_string: 'const a = 1;', new_string: 'const a = 2;' })]);
  const r = await runTurn(first, '把 a 改成 2');
  assert.ok(r.exhausted);
  const file = path.join(root, '.zhiqu', 'state.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).turn.status, 'unfinished');
  assert.ok(!fs.existsSync(path.join(root, '.zhiqu', 'progress.md')));

  // 新进程的清单是空的：从状态卡带回来（模型没再调 update_todos 也在）
  const peek = mk([{ text: '做到哪了，要先问你？' }]);
  await runTurn(peek, '到哪了');
  assert.deepEqual(peek.todos.map((t) => t.status), ['in_progress', 'pending']);
  const second = mk([todos(['改 a', 'completed'], ['改 b', 'completed']), { text: '都改完了' }], 5);
  await runTurn(second, '接着做');
  assert.match(second.messages[0].content, /^（上一轮在这个项目里没做完。/);
  assert.match(second.messages[0].content, /`a\.js`：改了 1 回/);
  assert.equal(second.api.requests[0].messages.filter((m) => /## 任务清单/.test(String(m.content))).length, 1, '清单带回来了，而且只说一遍');
  assert.ok(!fs.existsSync(path.join(root, '.zhiqu')), '做完了：状态文件删掉，空目录也收掉');

  // 过了一天的不接
  const old = new WorkState(file, { now: () => new Date(Date.now() - 25 * 3600 * 1000) });
  old.beginTurn('昨天的事'); old.setTodos([{ content: '昨天没做完的', status: 'pending' }]); old.endTurn(false);
  const third = mk([{ text: '好' }]);
  await runTurn(third, '今天的事');
  assert.ok(!third.messages.some((m) => /昨天/.test(String(m.content))));
});

test('状态文件坏了、版本不认识：当没有，不把这一轮弄挂', async () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, '.zhiqu'));
  fs.writeFileSync(path.join(root, '.zhiqu', 'state.json'), '{"v":1,"todos":[{"con');
  const ctx = makeCtx({ root, store: false, replies: [{ text: '好' }] });
  const r = await runTurn(ctx, '做');
  assert.equal(r.finalText, '好');
  fs.mkdirSync(path.join(root, '.zhiqu'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zhiqu', 'state.json'), '{"v":99,"said":"x"}');
  assert.ok(WorkState.open(path.join(root, '.zhiqu', 'state.json')).isEmpty());
});
