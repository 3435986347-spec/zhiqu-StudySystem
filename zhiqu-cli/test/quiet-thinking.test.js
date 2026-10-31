// 思考过程不展示（用户 2026-09-28：「思考内容不要展示出来，用一个动态的小的像素图案来表示在思考，并且说明在思考中，
// 然后只告诉用户结论和更改了什么，不要展现废话」）。
//   - 模型在调工具的那几条回复里写的字 = 思考过程，不打印；只打印最后的结论（不再调工具的那条）；
//   - 读 / 搜 / 列目录只在状态行里一闪；写 / 删 / 跑命令（改了什么）照常打印；
//   - 思考时状态行是一个动态的像素图案 +「思考中 Ns」；
//   - /verbose 切回全显示。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { runTurn } from '../src/agent.js';
import { replayTranscript } from '../src/replay.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { Ui, pixelFrame } from '../src/ui.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';
import { Vt } from './vt.js';

function makeCtx({ replies, root = tmpdir(), verbose = false } = {}) {
  const store = new SessionStore(root);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds: 12, verbose,
    local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 64_000 },
  };
}

const THINKING = '我先看看这个文件……让我重新想一下，也许是坐标系的问题，也可能是相机，我陷入困境了，再读一遍';
function scripted(root) {
  write(root, 'a.js', 'const a = 1\nconst b = 2\n');
  return [
    { text: THINKING, calls: [{ name: 'read_file', args: { path: 'a.js' } }] },
    { text: '找到了：第 1 行少了分号，我来改。', calls: [{ name: 'write_file', args: { path: 'a.js', old_string: 'const a = 1\n', new_string: 'const a = 1;\n' } }] },
    { text: '改好了：a.js 第 1 行补了分号。' },
  ];
}

test('默认：思考过程不打印，读文件不留行；结论和改了什么（写文件那一步 + diff）照常', async () => {
  const root = tmpdir();
  const ctx = makeCtx({ root, replies: scripted(root) });
  const r = await runTurn(ctx, '修一下 a.js');
  const out = ctx.ui.text();
  assert.ok(out.includes('改好了：a.js 第 1 行补了分号。'), out);
  assert.ok(!out.includes('我陷入困境'), `思考过程被打印了：\n${out}`);
  assert.ok(!out.includes('找到了：第 1 行少了分号'), '调工具那条回复里的字也是过程，不打印');
  assert.ok(!/⏺ 读取 a\.js/.test(out), '读文件不该留成一行');
  assert.match(out, /⏺ 修改 a\.js/);
  assert.match(out, /\+const a = 1;/, '改了什么要看得到（diff）');
  assert.equal(r.stats.read, 1);
  assert.equal(r.finalText, '改好了：a.js 第 1 行补了分号。');
});

test('/verbose：全显示（思考过程、读文件的每一步）', async () => {
  const root = tmpdir();
  const ctx = makeCtx({ root, replies: scripted(root), verbose: true });
  await runTurn(ctx, '修一下 a.js');
  const out = ctx.ui.text();
  assert.ok(out.includes('我陷入困境'));
  assert.match(out, /⏺ 读取 a\.js/);
  assert.ok(out.includes('改好了'));
});

test('结论被输出上限截断、接着说：两段都打印（不只打印最后一段）', async () => {
  const ctx = makeCtx({ replies: [{ text: '第一段结论，', finishReason: 'length' }, { text: '第二段结论。' }] });
  await runTurn(ctx, '说');
  const out = ctx.ui.text();
  assert.ok(out.includes('第一段结论') && out.includes('第二段结论'), out);
});

function tty(cols = 60) {
  const vt = new Vt(cols);
  const output = new Writable({ write(chunk, _e, cb) { vt.feed(chunk.toString()); cb(); } });
  output.columns = cols;
  output.isTTY = true;
  const input = new PassThrough();
  input.isTTY = true;
  const ui = new Ui({ input, output, color: false, interactive: true });
  ui.start();
  return { ui, vt };
}

test('像素图案：每一帧 4 格、都是点阵字符，逐帧在变', () => {
  const frames = Array.from({ length: 6 }, (_, i) => pixelFrame(i));
  for (const f of frames) {
    assert.equal([...f].length, 4);
    assert.ok([...f].every((ch) => ch.codePointAt(0) >= 0x2800 && ch.codePointAt(0) <= 0x28ff), f);
  }
  assert.ok(new Set(frames).size >= 3, `帧没怎么变：${frames}`);
});

test('思考中：状态行是像素图案 +「思考中 Ns」+ 在做什么；停下后状态行清掉，不留残影', () => {
  const { ui, vt } = tty();
  ui.beginLive();
  ui.startThinking();
  ui.setActivity('读取 mario.html');
  const lines = vt.lines();
  const status = lines.at(-2);
  assert.match(status, /^[⠀-⣿]{4} 思考中 \d+s · 读取 mario\.html$/, lines.join('\n'));
  const before = status;
  ui.thinkingTick();
  assert.notEqual(vt.lines().at(-2), before, '图案没动');
  ui.stopThinking();
  assert.ok(!vt.lines().some((l) => l.includes('思考中')), vt.lines().join('\n'));
  ui.close();
});

test('/resume 回放按同一个规矩：默认不显示调工具那几条里的思考、不显示读文件；verbose 全显示', async () => {
  const root = tmpdir();
  const ctx = makeCtx({ root, replies: scripted(root), verbose: true });
  await runTurn(ctx, '修一下 a.js');
  const quiet = fakeUi([]);
  replayTranscript(quiet, ctx.store.transcript(ctx.session.id));
  const q = quiet.text();
  assert.ok(!q.includes('我陷入困境') && !/⏺ 读取 a\.js/.test(q), q);
  assert.ok(q.includes('改好了') && /⏺ 修改 a\.js/.test(q), q);
  const loud = fakeUi([]);
  replayTranscript(loud, ctx.store.transcript(ctx.session.id), { verbose: true });
  assert.ok(loud.text().includes('我陷入困境') && /⏺ 读取 a\.js/.test(loud.text()));
});

// ── 不空转（用户：「明明是一个很小的问题却一直在思考循环，然后也很容易达到上下文上限」）──────────────

test('调工具的回复里写了一大段推测（> 3000 字）：工具结果后面附一句「别长篇推测，拿不准就做实验」', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n');
  const ctx = makeCtx({ root, replies: [
    { text: '也许是坐标系的问题……'.repeat(400), calls: [{ name: 'read_file', args: { path: 'a.js' } }] },
    { text: '短的一句', calls: [{ name: 'read_file', args: { path: 'a.js' } }] },
    { text: '好' }] });
  await runTurn(ctx, '看看');
  const tools = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(tools[0], /别在回复里长篇推测/);
  assert.match(tools[0], /最小的复现/);
  assert.ok(!/长篇推测/.test(tools[1]), '短的那条不该附');
});

test('连续 8 次只看不动（读 / 搜 / 列目录）：第 8 次附一句「已知的够就直接改，拿不准就写复现」；中间动过手就重新数', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n');
  const read = { calls: [{ name: 'read_file', args: { path: 'a.js' } }] };
  const ctx = makeCtx({ root, replies: [read, read, read, read, read, read, read, read, { text: '好' }] });
  await runTurn(ctx, '看看');
  const tools = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.equal(tools.length, 8);
  assert.ok(!tools.slice(0, 7).some((t) => /连续查看了/.test(t)));
  assert.match(tools[7], /连续查看了 8 次/);

  const mixed = makeCtx({ root, replies: [read, read, read, read, read,
    { calls: [{ name: 'write_file', args: { path: 'b.js', content: 'y\n' } }] }, read, read, read, { text: '好' }] });
  await runTurn(mixed, '看看');
  assert.ok(!mixed.messages.some((m) => m.role === 'tool' && /连续查看了/.test(m.content)), '中间写过文件，应当重新数');
});

test('省上下文：较早几轮调工具那几条回复里的长篇思考，发给模型时只留开头；最近两条原样', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n');
  const long = (i) => `第 ${i} 段思考：${'分析'.repeat(800)}`;
  const replies = [0, 1, 2, 3].map((i) => ({ text: long(i), calls: [{ name: 'read_file', args: { path: 'a.js' } }] }));
  const ctx = makeCtx({ root, replies: [...replies, { text: '好' }] });
  await runTurn(ctx, '看看');
  const last = ctx.api.requests.at(-1).messages.filter((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(last.length, 4);
  assert.match(last[0].content, /^第 0 段思考：.*这段思考已省略，原来 \d+ 字/s);
  assert.ok(last[0].content.length < 400, `还有 ${last[0].content.length} 字`);
  assert.equal(last[3].content, long(3), '最近的原样');
  assert.equal(last[2].content, long(2), '最近两条原样');
  const stored = ctx.store.transcript(ctx.session.id).filter((e) => e.kind === 'message' && e.message.tool_calls);
  assert.equal(stored[0].message.content, long(0), '会话记录里是原话（/resume 看得到），省略的只是发给模型的那一份');
});

// ── 暴力测试：窄终端、中途打断、几百次调用 ────────────────────────────────────────

test('窄终端（20 / 40 列）+ 很长的中文「在做什么」：状态行不折行（折行的话擦的时候会留残影）', async () => {
  const { displayWidth } = await import('../src/render/term.js');
  for (const cols of [20, 40, 80]) {
    const { ui, vt } = tty(cols);
    ui.beginLive();
    ui.startThinking();
    ui.setActivity('读取 src/components/very/deep/path/超级马里奥游戏主循环与碰撞检测模块.js');
    const status = vt.lines().at(-2);
    // 整个状态行在一行里：折行的话倒数第二行只是它的后半截（不含「思考中」）
    assert.ok(status.includes('思考中') && /^[\u2800-\u28ff]{4} /.test(status), `${cols} 列时状态行折行了：\n${vt.lines().slice(-4).join('\n')}`);
    assert.ok(displayWidth(status) <= cols, `${cols} 列时状态行 ${displayWidth(status)} 宽：${status}`);
    ui.stopThinking();
    assert.ok(!vt.lines().some((l) => l.includes('思考中')), `${cols} 列：停下后留了残影`);
    ui.close();
  }
});

test('思考中按 Ctrl+C：动画停掉、状态行清掉、定时器不留（不然进程退不出去）', async () => {
  const { ui } = tty();
  const controller = new AbortController();
  const ctx = makeCtx({ replies: [] });
  ctx.ui = ui;
  ctx.api = { requests: [], async stream(_p, _b, _on, { signal }) {
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  } };
  ui.beginLive();
  const turn = runTurn(ctx, '想一想', { signal: controller.signal }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(ui.thinking, '应当在思考中');
  controller.abort();
  await turn;
  assert.equal(ui.thinking, null);
  assert.equal(ui.thinkingTimer, null, '定时器没清');
  ui.close();
});

test('模型连着调 200 次读文件：屏幕上不刷屏（安静模式下读不留行），最后一句说看了多少', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n');
  const read = { calls: [{ name: 'read_file', args: { path: 'a.js' } }] };
  const ctx = makeCtx({ root, replies: [...Array(200).fill(read), { text: '结论：没问题。' }] });
  ctx.maxRounds = 300;
  const r = await runTurn(ctx, '看看');
  const lines = ctx.ui.text().split('\n').filter((l) => l.trim());
  assert.ok(lines.length < 10, `打了 ${lines.length} 行`);
  assert.equal(r.stats.read, 200);
});

// 第八十八轮：评测重跑里 83 次 read_file 有 55 次只读 ≤ 80 行（一个文件从 170 行起分 6 次往下挪），234 次带工具的回复 209 次只发一个调用；
// sympy-23950 到 60 轮停下时最后的回答是空的
test('接着上一次往下读同一个文件：附一句「直接读大一点」，一个文件只提醒一次；跳着读、换个文件、从头读都不提醒', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n'.repeat(400));
  write(root, 'b.js', 'y\n'.repeat(400));
  const read = (path, offset, limit) => ({ calls: [{ name: 'read_file', args: { path, offset, limit } }] });
  const ctx = makeCtx({ root, replies: [read('a.js', 1, 40), read('a.js', 41, 40), read('a.js', 81, 40), read('b.js', 1, 40), read('b.js', 300, 40),
    read('./b.js', 1, 40), { text: '好' }] });
  await runTurn(ctx, '看看');
  const tools = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.equal(tools.length, 6);
  assert.ok(!/接着上一次往下读/.test(tools[0]));
  assert.match(tools[1], /你在接着上一次往下读 a\.js（第 41 行起）。直接读大一点/);
  assert.ok(!/接着上一次往下读/.test(tools[2]), '同一个文件只提醒一次');
  assert.ok(!tools.slice(3).some((t) => /接着上一次往下读/.test(t)), '换文件、跳着读、从头读都不算接着读');
});

test('快到轮数上限：剩 3 轮的那一轮附一句「开始收尾」（只附在这一轮最后一个调用上）；上限太小不附', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n');
  const two = { calls: [{ name: 'list_files', args: {} }, { name: 'read_file', args: { path: 'a.js' } }] };
  const ctx = makeCtx({ root, replies: Array.from({ length: 12 }, () => two) });
  await runTurn(ctx, '看看');
  const tools = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.equal(tools.length, 24, '12 轮、每轮两个调用');
  const wrapped = tools.map((t, i) => (/开始收尾/.test(t) ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(wrapped, [17], '第 9 轮（再过 3 轮到 12）的第二个调用');
  assert.match(tools[17], /再过 3 轮就到这一次的上限（12 轮）。开始收尾：改到一半的先改完、跑一次验证，然后用几句话说做到哪了、还差什么/);

  const small = makeCtx({ root, replies: Array.from({ length: 6 }, () => two) });
  small.maxRounds = 6;
  await runTurn(small, '看看');
  assert.ok(!small.messages.some((m) => m.role === 'tool' && /开始收尾/.test(m.content)), '上限只有 6 轮时不附');
});

test('系统提示里说清：互相不依赖的读 / 搜一次发几个，读文件读成段（第八十八轮）', async () => {
  const { BUILTIN_SYSTEM_PROMPT } = await import('../src/prompt.js');
  assert.match(BUILTIN_SYSTEM_PROMPT, /互相不依赖的读、搜、列目录放在同一次回复里一起发/);
  assert.match(BUILTIN_SYSTEM_PROMPT, /读文件读成段：不知道要哪几行就整份读/);
  assert.match(BUILTIN_SYSTEM_PROMPT, /里面的例子、边界情况（空的、重复的、顺序、出错的）都验证过了吗/, '第八十九轮：收尾检查带上例子和边界（这一句不花钱，第九十一轮去掉核对时留着）');
});

// 第八十九轮（真模型试出来的）：推了一句以后，前面那条结论原来先打一遍、推完又打一遍。核对第九十一轮去掉了，清单没做完那一句还是这样
test('要推「清单没做完」的那条回复先不当结论打出来，只打推完以后那条；落在最后一轮时不推、照常打出来', async () => {
  const root = tmpdir();
  const todo = { calls: [{ name: 'update_todos', args: { todos: [{ content: '改 a.js', status: 'in_progress' }, { content: '跑测试', status: 'pending' }] } }] };
  const ctx = makeCtx({ root, replies: [todo, { text: '先说的结论：改好了' }, { text: '清单做完了的结论' }] });
  const r = await runTurn(ctx, '改一下');
  const out = ctx.ui.text();
  assert.ok(out.includes('清单做完了的结论'), out);
  assert.ok(!out.includes('先说的结论'), `推之前那条被当成结论打出来了：\n${out}`);
  assert.equal(r.finalText, '清单做完了的结论');

  const last = makeCtx({ root, replies: [todo, { text: '最后一轮的结论' }] });
  last.maxRounds = 2;
  await runTurn(last, '改一下');
  assert.equal(last.api.requests.length, 2, '最后一轮不推（推了也没轮数再答）');
  assert.ok(last.ui.text().includes('最后一轮的结论'), '最后一轮的结论要照常打出来');
});

// 第九十轮：命令输出原来只给最后 8 行、也不说前面还有 —— git diff 只看得到最后一段
test('命令输出多了：终端里给开头 3 行 + 结尾 5 行，中间说省掉几行；少的照常全给', async () => {
  const root = tmpdir();
  const ctx = makeCtx({ root, replies: [
    { calls: [{ name: 'run_command', args: { command: 'node', args: ['-e', 'for (let i = 1; i <= 20; i++) console.log("line" + i)'] } }] },
    { calls: [{ name: 'run_command', args: { command: 'node', args: ['-e', 'console.log("a"); console.log("b")'] } }] },
    { text: '好' }] });
  await runTurn(ctx, '跑一下');
  const out = ctx.ui.text();
  for (const n of [1, 2, 3, 16, 17, 18, 19, 20]) assert.match(out, new RegExp(`line${n}\\b`), `第 ${n} 行该显示`);
  for (const n of [4, 10, 15]) assert.ok(!new RegExp(`line${n}\\b`).test(out), `第 ${n} 行该省掉`);
  assert.match(out, /…（中间省掉 12 行）/);
  assert.match(out, /\ba\b[\s\S]*\bb\b/, '只有两行的照常全给');
  const { shownOutput } = await import('../src/agent.js');
  assert.deepEqual(shownOutput(['1', '2', '3', '4', '5', '6', '7', '8', '9']), ['1', '2', '3', '4', '5', '6', '7', '8', '9'], '9 行以内全给（省一行不如不省）');
});
