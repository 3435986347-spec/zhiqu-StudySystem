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
