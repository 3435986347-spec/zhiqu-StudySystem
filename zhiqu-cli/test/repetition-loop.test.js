// 原地重复（第一百轮）：第九十八轮付费重跑 pytest-5840 第三遍，模型在不调工具的回复里一遍遍写同一段，三次写满输出上限；
// 循环当它「话没说完」—— 整段留进历史、叫它接着说，它照那段交了 6 次新旧一模一样的 edit_file，最后 6.8 万字的重复成了回答、补丁是空的。
// 样本是那一遍的真实回复（test/fixtures/loop-replies.json，zlib + base64）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { LOOP_MIN_CHARS, repeating, runTurn } from '../src/agent.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'loop-replies.json'), 'utf8'));
const unpack = (r) => {
  const s = zlib.inflateSync(Buffer.from(r.zlib_base64, 'base64')).toString('utf8');
  assert.equal(crypto.createHash('sha256').update(s).digest('hex'), r.sha256, '样本解出来和原文对不上');
  return s;
};
const LOOPS = fixture.loops.map(unpack);
const NORMAL = fixture.normal.map(unpack);

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
const userTexts = (ctx) => ctx.messages.filter((m) => m.role === 'user').map((m) => m.content);
const assistantTexts = (ctx) => ctx.messages.filter((m) => m.role === 'assistant').map((m) => m.content || '');

test('认得出：那一遍的三条回复都算原地重复；最长的那条正常回复、长表格、带重复句的测试文件、夹着哈希的日志都不算', () => {
  assert.equal(LOOPS.length, 3);
  assert.ok(LOOPS.every((s) => s.length > 60_000));
  for (const s of LOOPS) assert.equal(repeating(s), true, `${s.slice(0, 80)}…`);
  assert.equal(NORMAL.length, 1);
  assert.equal(repeating(NORMAL[0]), false, '调工具前的一段长分析（压缩比 5、重复句 34%）不是原地重复');
  // 只看压缩比会误伤：1200 行的表格压缩比 15，一句重复都没有
  let table = '| 日期 | 任务 | 状态 | 用时 |\n|---|---|---|---|\n';
  for (let i = 0; i < 1200; i++) table += `| 2026-10-${String(1 + (i % 30)).padStart(2, '0')} | 任务 ${i} | ${['完成', '进行中', '没开始'][i % 3]} | ${(i * 7) % 60} 分钟 |\n`;
  assert.equal(repeating(table), false, '表格');
  // 只看重复句会误伤：同一句日志夹着各不相同的哈希（重复句过半，压缩比低）
  let log = '';
  for (let i = 0; i < 300; i++) log += `WARNING: deprecated call to pkg_resources.declare_namespace in the module loader, please migrate to native namespace packages\n${crypto.createHash('sha256').update(String(i)).digest('hex')}\n`;
  assert.equal(repeating(log), false, '日志');
  let tests = '';
  for (let i = 0; i < 400; i++) tests += `def test_case_${i}():\n    result = add(${i}, ${i + 1})\n    assert result == expected, "mismatch in add"\n\n`;
  assert.equal(repeating(tests), false, '测试文件');
  assert.equal(repeating(LOOPS[0].slice(0, LOOP_MIN_CHARS - 1)), false, '太短的不看');
});

test('被截断的原地重复：历史里只留开头一段，推的是「别复述、直接动手」而不是「接着说」，下一步真的动了手', async () => {
  const root = tmpdir();
  write(root, 'p.py', 'def f(path):\n    return normcase(path)\n');
  const ctx = makeCtx({ root, replies: [
    { calls: [{ name: 'read_file', args: { path: 'p.py' } }] },
    { text: LOOPS[2], finishReason: 'length' },
    { calls: [{ name: 'edit_file', args: { path: 'p.py', old_string: '    return normcase(path)\n', new_string: '    return path\n' } }] },
    { text: '改好了。' }] });
  const r = await runTurn(ctx, '修一下');
  const kept = assistantTexts(ctx).find((t) => t.includes('同一段话的重复'));
  assert.ok(kept, '历史里应当是删过的那段');
  assert.ok(kept.length < 2_000, `历史里留了 ${kept.length} 字`);
  assert.ok(!assistantTexts(ctx).some((t) => t.length > 10_000), '整段重复不该留进历史');
  const pushed = userTexts(ctx).at(-1);
  assert.match(pushed, /一直在重复同一段话/);
  assert.match(pushed, /直接调用工具/);
  assert.doesNotMatch(pushed, /接着说/);
  // 下一次请求带的是删过的那段（不是 6.8 万字）
  assert.ok(JSON.stringify(ctx.api.requests[2].messages).length < 20_000, '重发的对话里还有整段重复');
  assert.match(ctx.ui.text(), /原地重复同一段话.*让它直接动手/);
  assert.doesNotMatch(ctx.ui.text(), /同一段话的重复，已删掉/, '还在推的时候，删过的那段也不当结论打出来');
  assert.equal(fs.readFileSync(path.join(root, 'p.py'), 'utf8'), 'def f(path):\n    return path\n');
  assert.equal(r.finalText, '改好了。');
});

test('一直重复到接着说的次数用完：交的回答是删过的那段，安静模式下也不把重复打到终端', async () => {
  const ctx = makeCtx({ replies: [{ text: LOOPS[1], finishReason: 'length' }] });
  const r = await runTurn(ctx, '修一下');
  assert.equal(ctx.api.requests.length, 3, '照旧最多推两次');
  assert.ok(r.finalText.length < 2_000, `交了 ${r.finalText.length} 字`);
  assert.match(r.finalText, /同一段话的重复，已删掉/);
  const out = ctx.ui.text();
  assert.ok(out.length < 6_000, `终端里打了 ${out.length} 字`);
  assert.match(out, /先停在这里/);
  assert.equal(out.split('同一段话的重复，已删掉').length - 1, 1, '安静模式下删过的那段只在最后当结论打一次');
});

test('正常的长回答被截断：照旧叫它接着说，原文不删', async () => {
  const ctx = makeCtx({ replies: [{ text: NORMAL[0], finishReason: 'length' }, { text: '（完）' }] });
  const r = await runTurn(ctx, '讲讲');
  assert.match(userTexts(ctx).at(-1), /接着说/);
  assert.ok(assistantTexts(ctx).includes(NORMAL[0]), '正常的回答应当原样留着');
  assert.equal(r.finalText, '（完）');
});

test('新旧一模一样连着被拒：第 3 次起提醒「原文没拼错，是还没定下要改成什么」，不叫它重拼 old_string', async () => {
  const root = tmpdir();
  write(root, 'a.py', 'x = normcase(p)\n');
  const same = { name: 'edit_file', args: { path: 'a.py', old_string: 'x = normcase(p)', new_string: 'x = normcase(p)' } };
  const ctx = makeCtx({ root, replies: [
    { calls: [{ name: 'read_file', args: { path: 'a.py' } }] },
    { calls: [same] }, { calls: [same] }, { calls: [same] }, { text: '好' }] });
  await runTurn(ctx, '改');
  const tools = ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(tools[3], /连续 3 次没能改成 a\.py/);
  assert.match(tools[3], /原文没拼错，是还没定下要改成什么/);
  assert.doesNotMatch(tools[3], /一字不差地拼/);
});
