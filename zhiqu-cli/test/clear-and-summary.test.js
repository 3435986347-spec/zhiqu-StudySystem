// 先清再摘（第一百三十九轮，docs/memory-plan.md 第 3 步）。
// 先清：旧的工具输出、旧截图成批换成占位，占位里写着怎么取回来；不调模型。
// 再摘：固定几节，以前写好的各段原样带着走、只追加新的一段（原来是「摘要的摘要的摘要」，压到后来「目标」写的是「无」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clearNow, runTurn } from '../src/agent.js';
import { CLEAR_KEEP_RECENT, clearStale, compactMessages, estimateMessages, foldSegments, IMAGE_BATCH, KEEP_IMAGES, minClear, softLimit, summarySegments, withoutNext } from '../src/compact.js';
import { generatedOrigin } from '../src/origins.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

let seq = 0;
const tool = (name, args, output) => { const id = `c${++seq}`; return [
  { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
  { role: 'tool', tool_call_id: id, content: output },
]; };
const read = (p, offset, limit, body = 'x') => tool('read_file', { path: p, ...(offset ? { offset } : {}), ...(limit ? { limit } : {}) }, `【${p}】\n${body.repeat(4000)}`);
const shot = () => ({ role: 'user', content: [{ type: 'text', text: '（下面的图就是刚才渲染的页面。）' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] });
const toolTexts = (ms) => ms.filter((m) => m.role === 'tool').map((m) => m.content);

test('先清：没过上限不动；过了就先清没用了的读取，再从最早的清起，最近 8 条不动；占位里写着怎么取回', () => {
  assert.equal(softLimit(1_000_000), 300_000, '软上限不等于窗口：1M 的窗口也只背 30 万');
  assert.equal(softLimit(64_000), 38_400);
  assert.equal(minClear(1_000_000), 30_000);
  const ms = [{ role: 'user', content: '改 a.js' },
    ...read('a.js', 1, 400, 'a'),          // 0：后来又读过盖住它的一段
    ...read('b.js', null, null, 'b'),      // 1：之后 b.js 被改过
    ...tool('shell', { command: 'npm test -- --verbose' }, `PASS ${'t'.repeat(5000)}`),   // 2
    ...tool('edit_file', { path: './b.js', old_string: 'x', new_string: 'y' }, '已修改 b.js'),
    ...read('a.js', 1, 800, 'A'),          // 4
    ...tool('search', { query: 'FS_SKY' }, `命中 ${'s'.repeat(5000)}`),                    // 5
  ];
  for (let i = 0; i < CLEAR_KEEP_RECENT; i++) ms.push(...read(`keep${i}.js`, null, null, 'k'));
  const total = estimateMessages(ms);
  const same = clearStale(ms, { limit: total + 1, minFree: 100 });
  assert.equal(same.messages, ms, '没过上限：原样');
  assert.equal(same.cleared, 0);

  const spilled = [];
  const r = clearStale(ms, { limit: total - 1, minFree: 1000, spill: (text) => { spilled.push(text); return '.zhiqu/sessions/s1/out/1.txt'; } });
  const t = toolTexts(r.messages);
  assert.match(t[0], /^（旧的读取已清理：read_file a\.js（offset 1，limit 400），原来 \d+ 字。要看就再读一次）$/);
  assert.match(t[1], /^（旧的读取已清理：read_file b\.js，原来 \d+ 字。这个文件之后改过，那份本来就是旧内容；要看就再读一次）$/);
  assert.match(t[2], /^（旧的命令输出已清理：npm test -- --verbose，原来 \d+ 字。原文存在 \.zhiqu\/sessions\/s1\/out\/1\.txt（要看就读它，不用重新跑）/);
  assert.equal(spilled[0], `PASS ${'t'.repeat(5000)}`, '命令的输出另存了一份（命令不一定能重跑），读取的不存（再读就是）');
  assert.equal(t[3], '已修改 b.js', '短的不动');
  assert.match(t[5], /^（旧的 search 结果已清理：「FS_SKY」/);
  for (const kept of t.slice(-CLEAR_KEEP_RECENT)) assert.ok(kept.startsWith('【keep'), '最近 8 条不清');
  assert.ok(estimateMessages(r.messages) <= total / 2 + 2000, '清到上限的一半左右');
  assert.equal(r.messages.length, ms.length);
  r.messages.forEach((m, i) => { if (m.role === 'tool') assert.equal(m.tool_call_id, ms[i].tool_call_id, '调用和结果还是一对'); });
  assert.ok(ms[2].content.startsWith('【a.js】'), '不改传进来的那一份');
  // 再清一遍：已经是占位的不重复清
  assert.equal(clearStale(r.messages, { limit: 10, minFree: 1 }).cleared <= 2, true);
});

test('先清：清不出一大块就不清（为一点地方打断缓存不值）；没用了的读取排在前面', () => {
  const ms = [{ role: 'user', content: 'x' }, ...read('old.js', null, null, 'o'), ...read('stale.js', null, null, 's'), ...tool('write_file', { path: 'stale.js', content: 'y' }, '已写入')];
  for (let i = 0; i < CLEAR_KEEP_RECENT; i++) ms.push(...read(`keep${i}.js`, null, null, 'k'));
  const total = estimateMessages(ms);
  const none = clearStale(ms, { limit: total - 1, minFree: 5000 });
  assert.equal(none.cleared, 0, '能清的只有两千多 token，够不着五千：不清');
  assert.equal(none.messages, ms);
  // 先后顺序：清掉那条没用了的读取就够了的时候，更早的那条（还可能有用）不动
  for (const [name, later] of [
    ['之后改过', (p) => tool('edit_file', { path: p, old_string: 'a', new_string: 'b' }, '已修改')],
    ['之后又读过盖住它的一段', (p) => tool('read_file', { path: p, offset: 1, limit: 900 }, '【再读】短的')],
  ]) {
    const order = [{ role: 'user', content: 'x' }, ...tool('search', { query: 'still-useful' }, `命中 ${'u'.repeat(3000)}`),
      ...tool('read_file', { path: 'huge.js', offset: 1, limit: 800 }, 'h'.repeat(120_000)), ...later('huge.js')];
    for (let i = 0; i < CLEAR_KEEP_RECENT; i++) order.push(...tool('search', { query: `k${i}` }, 'k'.repeat(900)));
    const r = clearStale(order, { limit: estimateMessages(order) - 1, minFree: 500 });
    const texts = toolTexts(r.messages);
    assert.ok(texts[1].startsWith('（旧的读取已清理：read_file huge.js'), `${name}：没用了的那条没清`);
    assert.ok(texts[0].startsWith('命中 '), `${name}：没用了的读取要排在前面清 —— 清它就够了，更早的搜索结果不该动`);
  }
});

test('先清：背得越多，一批要清出的也越多（至少现在占用的四分之一）', () => {
  // 清不掉的（助手自己的长话）占大头，能清的只有 4 万多：过了 3 万的底线，但不到占用的四分之一 —— 不清
  const ms = [{ role: 'user', content: 'x' }];
  for (let i = 0; i < 40; i++) ms.push({ role: 'assistant', content: `说明 ${'字'.repeat(10_000)}` }, { role: 'user', content: '接着' });
  for (let i = 0; i < 4; i++) ms.push(...tool('search', { query: `old${i}` }, 'o'.repeat(40_000)));
  for (let i = 0; i < CLEAR_KEEP_RECENT; i++) ms.push(...tool('search', { query: `k${i}` }, 'k'.repeat(900)));
  const total = estimateMessages(ms);
  assert.ok(total > 400_000);
  assert.equal(clearStale(ms, { limit: 300_000, minFree: 30_000 }).cleared, 0, '背着 40 多万只清得出 4 万多：打断缓存不值');
  // 同样这 4 段输出，背得少的时候就值得清
  const light = ms.slice(-(4 + CLEAR_KEEP_RECENT) * 2);
  assert.ok(clearStale([{ role: 'user', content: 'x' }, ...light], { limit: 30_000, minFree: 10_000 }).cleared >= 3);
});

test('只留最近 2 张图：旧图攒够一批才清（不到上限也清）；占位算命令行补的话', () => {
  assert.equal(KEEP_IMAGES, 2, '用户 2026-11-15 定的：只留最近 2 张');
  assert.equal(IMAGE_BATCH, 8, '一批 8 张：一张图才一千多 token，为三四张打断一次缓存不值');
  const ms = [{ role: 'user', content: '看页面' }];
  for (let i = 0; i < KEEP_IMAGES + IMAGE_BATCH - 1; i++) ms.push(...tool('preview_page', { path: 'index.html' }, '已截图'), shot());
  assert.equal(clearStale(ms, { limit: 1e9, minFree: 1 }).images, 0, '旧图还不到一批：不动');
  ms.push(...tool('preview_page', { path: 'index.html' }, '已截图'), shot());
  const r = clearStale(ms, { limit: 1e9, minFree: 1 });
  assert.equal(r.images, IMAGE_BATCH);
  const left = r.messages.filter((m) => Array.isArray(m.content));
  assert.equal(left.length, KEEP_IMAGES);
  assert.equal(r.messages.indexOf(left[0]), ms.length - 4, '留下的是最近两张');
  const placeholder = r.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('（旧截图已清理'));
  assert.equal(generatedOrigin(placeholder.content), 'system');
  assert.equal(placeholder.role, 'user');
});

test('循环里：过了软上限先清、不调模型；清掉的命令输出真的存下来了，照占位里写的读取参数真的读得回原文', async () => {
  const root = tmpdir();
  write(root, 'big.js', Array.from({ length: 600 }, (_, i) => `// 第 ${i + 1} 行 ${'x'.repeat(50)}`).join('\n'));
  write(root, 'print.js', "console.log('OUTPUT-START'); for (let i = 0; i < 200; i++) console.log('line ' + i + ' ' + 'y'.repeat(30)); console.log('OUTPUT-END');\n");
  const store = new SessionStore(root);
  const call = (name, args) => ({ calls: [{ name, args }] });
  const replies = [call('run_command', { command: 'node', args: ['print.js'] }), call('read_file', { path: 'big.js', offset: 100, limit: 300 })];
  for (let i = 0; i < 12; i++) replies.push(call('read_file', { path: 'big.js', offset: 1 + i, limit: 150 }));
  replies.push({ text: '看完了，要先问你？' });
  const ctx = {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds: 30,
    local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 40_000 },
  };
  await runTurn(ctx, '看一下 big.js');
  assert.equal(ctx.api.requests.filter((r) => !r.tools.length).length, 0, `先清就够了，不该调模型写摘要：${ctx.ui.text()}`);
  assert.match(ctx.ui.text(), /清理了 \d+ 段旧的工具输出/);
  const t = toolTexts(ctx.messages);
  // 命令的输出：占位里的路径上真有原文
  const cmd = /^（旧的命令输出已清理：node print\.js，原来 \d+ 字。原文存在 (\S+)（要看就读它/.exec(t[0]);
  assert.ok(cmd, t[0].slice(0, 200));
  const saved = fs.readFileSync(path.join(root, cmd[1]), 'utf8');
  assert.ok(saved.includes('OUTPUT-START') && saved.includes('line 199') && saved.includes('OUTPUT-END'));
  assert.ok(!ctx.local.readFile({ path: cmd[1] }).error, `占位里说「读它」，read_file 得真读得了：${ctx.local.readFile({ path: cmd[1] }).error}`);
  // 读取：照占位里的 offset / limit 再读，拿得回那一段
  const rd = /^（旧的读取已清理：read_file big\.js（offset (\d+)，limit (\d+)）/.exec(t[1]);
  assert.ok(rd, t[1].slice(0, 200));
  const again = ctx.local.readFile({ path: 'big.js', offset: Number(rd[1]), limit: Number(rd[2]) });
  assert.ok(again.content.includes('第 100 行') && again.content.includes('第 399 行'));
  // 清理记进了会话：接回来还是清过的样子
  assert.ok(toolTexts(store.load(ctx.session.id).messages)[0].startsWith('（旧的命令输出已清理'));
  // 没有会话记录时（桌面 / 网页那一份）不另存，照实说「再做一次」
  const bare = { ...ctx, store: null, session: { id: 'web' }, messages: [{ role: 'user', content: 'x' }, ...tool('shell', { command: 'make' }, 'o'.repeat(90_000)), ...Array.from({ length: 9 }, (_, i) => read(`k${i}.js`, null, null, 'k')).flat()] };
  clearNow(bare, 40_000);
  assert.match(toolTexts(bare.messages)[0], /^（旧的命令输出已清理：make，原来 90000 字。要看就再做一次）$/);
});

test('再摘：以前写好的各段原样带着走，只追加新的一段；连压 10 次，第 1 次记下的事实一字不差还在', async () => {
  const fact = '天空用体积云，不用贴图：贴图在 4K 下糊（zero-platform/index.html:921）';
  let ms = [{ role: 'user', content: '把画面做成白天的' }];
  const inputs = [];
  for (let n = 1; n <= 10; n++) {
    for (let i = 0; i < 8; i++) ms.push(...tool('search', { query: `q${n}-${i}` }, 'r'.repeat(6000)));
    const r = await compactMessages(ms, 20_000, async (input) => {
      inputs.push(input);
      return `## 目标\n把画面做成白天的\n## 关键决定和原因\n${n === 1 ? fact : `第 ${n} 次的决定`}\n## 试过不行的\n无\n## 当前进展和下一步\n第 ${n} 次压缩时正在做第 ${n} 件事\n## 其它要点\n无`;
    });
    assert.ok(r.summarized > 0, `第 ${n} 次没压`);
    ms = r.messages;
  }
  const head = ms[0].content;
  assert.ok(head.includes(fact), '第 1 次记下的事实到第 10 次没了（或者被改写了）');
  assert.equal(summarySegments(head.split('【用户说过的原话')[0]).length, 10, '每次压缩各成一段');
  assert.match(head, /#### 第 10 段\n## 目标/);
  // 「下一步」只留最新的那一段的：更早的那几句在后面有新的一段时就过时了
  assert.equal((head.match(/## 当前进展和下一步/g) || []).length, 1);
  assert.ok(head.includes('第 10 次压缩时正在做第 10 件事') && !head.includes('第 9 次压缩时正在做'));
  // 给模型的：以前的各段只作参考，交上去的记录里没有上一次的摘要消息，也没有那句「好的」
  assert.match(inputs[9], /^【到目前为止的摘要】\n## 目标/);
  assert.ok(inputs[9].includes(fact));
  const record = inputs[9].split('【接下来的记录】')[1];
  assert.ok(!record.includes('之前对话的摘要') && !record.includes('好的，我已经了解之前的进展'), '上一次的摘要又被当成记录交去重写了');
  assert.equal(inputs.length, 10);
});

test('再摘：旧格式的摘要（没有分段）整份当第一段带走；没按小标题写的归到「其它要点」；太长从最早的一段折起', async () => {
  assert.equal(withoutNext('## 目标\na\n## 当前进展和下一步\nb\n## 其它要点\nc'), '## 目标\na\n## 其它要点\nc');
  assert.equal(withoutNext('## 目标\na\n## 当前进展和下一步\nb'), '## 目标\na');
  const legacy = [{ role: 'user', content: '【之前对话的摘要（已压缩，原文 40 条）】\n## 目标\n旧格式写的摘要：改 login\n\n【用户说过的原话（逐字，按时间先后）】\n—— 1 ——\n改 login，localhost 的不要动' },
    { role: 'assistant', content: '好的，我已经了解之前的进展，接着做。' }];
  for (let i = 0; i < 8; i++) legacy.push(...tool('search', { query: `q${i}` }, 'r'.repeat(6000)));
  const r = await compactMessages(legacy, 20_000, async () => '就这一句，没有小标题');
  const head = r.messages[0].content;
  assert.match(head, /#### 第 1 段\n## 目标\n旧格式写的摘要：改 login\n\n#### 第 2 段\n## 其它要点\n就这一句，没有小标题/);
  assert.ok(head.includes('改 login，localhost 的不要动'), '原话照样带着');
  // 折：只折前面的，最新一段不动；折过的说出来
  const long = ['甲'.repeat(3000), '乙'.repeat(3000), '丙'.repeat(3000)];
  const folded = foldSegments(long, 50_000);
  assert.ok(folded[0].length < 600 && folded[0].endsWith('…（更早的一段，已折短）'));
  assert.equal(folded[2], long[2], '最新的一段不折');
  assert.deepEqual(foldSegments(long, 1_000_000), long, '放得下就不折');
  // 压过上百次：折了还超，就留第一段和最近的几段，中间略去并说出来 —— 摘要不能一直长
  const many = Array.from({ length: 300 }, (_, i) => `第 ${i + 1} 段 ${'字'.repeat(900)}`);
  const kept = foldSegments(many, 20_000);
  assert.ok(estimateMessages([{ role: 'user', content: kept.join('\n\n') }]) <= 20_000 * 0.08 + 700, `摘要还有 ${kept.join('').length} 字`);
  assert.ok(kept[0].startsWith('第 1 段'), '第一段留着');
  assert.equal(kept.at(-1), many.at(-1), '最新的一段原样');
  assert.match(kept[1], /^（中间 \d+ 段更早的摘要略去）$/);
  assert.equal(kept.length - 2 + Number(/\d+/.exec(kept[1])[0]), 299, '略去了几段要数对');
});
