// 思考档位（第一百零八轮，Codex 同级第 1 步）：用户 2026-11-07 定的五个名字，网页同一套。
// 回传是这一步的要害：DeepSeek 开着思考、带工具时，之前每一轮的 reasoning_content 都要传回去，缺了 400（官方文档）；Claude 的思考块改一个字就失效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runTurn } from '../src/agent.js';
import { parseArgs, slash } from '../src/cli.js';
import { estimateMessage, needsCompaction } from '../src/compact.js';
import { EFFORTS, normalizeEffort, resolveSettings } from '../src/config.js';
import { runHosted } from '../src/host/code-host.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

function makeCtx({ replies, root = tmpdir(), effort, window = 1_000_000 } = {}) {
  const store = new SessionStore(root);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds: 60, effort,
    local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: window },
  };
}
const read = { calls: [{ name: 'read_file', args: { path: 'a.js' } }] };

test('名字照用户定的；认不出的不算（不把坏值发出去）', () => {
  assert.deepEqual(EFFORTS, ['instant', 'medium', 'high', 'extra', 'max']);
  for (const e of EFFORTS) assert.equal(normalizeEffort(e), e);
  assert.equal(normalizeEffort(' HIGH '), 'high');
  for (const bad of ['ultra', 'off', '', null, undefined, 5]) assert.equal(normalizeEffort(bad), null, String(bad));
});

test('--effort 能给；设置文件也能给，命令行的优先；坏值当没说', () => {
  assert.equal(parseArgs(['--effort', 'max']).effort, 'max');
  const root = tmpdir();
  write(root, '.zhiqu/settings.json', '{"effort":"medium"}');
  assert.equal(resolveSettings(root, {}).effort, 'medium');
  assert.equal(resolveSettings(root, { effort: 'extra' }).effort, 'extra');
  write(root, '.zhiqu/settings.json', '{"effort":"ultra"}');
  assert.equal(resolveSettings(root, {}).effort, null);
});

test('选了档位每个请求都说；没选一个字都不说（听服务端的默认）', async () => {
  const on = makeCtx({ effort: 'high', replies: [{ text: '好' }] });
  await runTurn(on, '问');
  assert.equal(on.api.requests[0].reasoning, 'high');
  const off = makeCtx({ replies: [{ text: '好' }] });
  await runTurn(off, '问');
  assert.equal('reasoning' in off.api.requests[0], false);
});

test('网关挂上来的思考内容原样记着、下一轮带回去，历史只追加（缓存）；用户再说一句也还在', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'x\n');
  const fields = (t) => ({ reasoning_content: t, reasoning_model: 'deepseek-v4-pro' });
  const ctx = makeCtx({ root, effort: 'high', replies: [
    { ...read, reasoning: '想甲', fields: fields('想甲') },
    { ...read, reasoning: '想乙', fields: fields('想乙') },
    { text: '做完了', reasoning: '想丙', fields: fields('想丙') },
    { text: '第二句也做完了', fields: fields('想丁') }] });
  await runTurn(ctx, '第一句');
  await runTurn(ctx, '第二句');
  const reqs = ctx.api.requests;
  assert.equal(reqs.length, 4);
  for (let k = 1; k < reqs.length; k++) {
    assert.deepEqual(reqs[k].messages.slice(0, reqs[k - 1].messages.length), reqs[k - 1].messages, `第 ${k + 1} 次请求改写了前面的消息`);
  }
  const echoed = reqs[3].messages.filter((m) => m.role === 'assistant');
  assert.deepEqual(echoed.map((m) => m.reasoning_content), ['想甲', '想乙', '想丙'], '少一条 DeepSeek 就 400');
  assert.ok(echoed.every((m) => m.reasoning_model === 'deepseek-v4-pro'));
});

test('Claude 的思考块（带签名）也原样带回去', async () => {
  const blocks = [{ type: 'thinking', thinking: '想', signature: 's1' }];
  const ctx = makeCtx({ replies: [{ text: '好', fields: { reasoning_blocks: blocks, reasoning_model: 'claude-opus-5-5' } }, { text: '再好' }] });
  await runTurn(ctx, '一');
  await runTurn(ctx, '二');
  assert.deepEqual(ctx.api.requests[1].messages.find((m) => m.role === 'assistant').reasoning_blocks, blocks);
});

test('思考不打进终端，只说它在想：不然想一分钟看着像卡死了', async () => {
  const ctx = makeCtx({ effort: 'high', replies: [{ text: '结论', reasoning: '这是一段不该给用户看的推理' }] });
  const activity = [];
  ctx.ui.setActivity = (s) => activity.push(s);
  const status = [];
  ctx.ui.status = { set: (s) => status.push(s), clear() {} };
  await runTurn(ctx, '问');
  assert.match(ctx.ui.text(), /结论/, '结论要打出来（不然下一句看不到东西也算过）');
  assert.ok(!ctx.ui.text().includes('不该给用户看'), ctx.ui.text());
  assert.ok(activity.concat(status).some((s) => String(s).includes('思考中')), `${activity} | ${status}`);
});

test('/effort：不带参数说当前和可选的；选了立刻生效；坏值不改', async () => {
  const ctx = makeCtx({ replies: [{ text: '好' }] });
  const home = tmpdir();
  const saved = process.env.ZHIQU_HOME;
  process.env.ZHIQU_HOME = home;
  try {
    await slash(ctx, '/effort');
    assert.match(ctx.ui.text(), /instant \/ medium \/ high \/ extra \/ max/);
    await slash(ctx, '/effort extra');
    assert.equal(ctx.effort, 'extra');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).effort, 'extra', '下次开还要是这一档');
    await slash(ctx, '/effort ultra');
    assert.equal(ctx.effort, 'extra', '坏值不该改');
    assert.match(ctx.ui.text(), /思考档位只有/);
  } finally {
    if (saved === undefined) delete process.env.ZHIQU_HOME; else process.env.ZHIQU_HOME = saved;
  }
});

test('网页代码模式：听后端传来的档位；没传是 instant，不听服务端给命令行的默认（第五十四轮：工具轮想起来，一问要等几分钟）', async () => {
  const bridgeFor = () => {
    const bodies = [];
    return { bodies, stream: async (_p, body, onEvent) => {
      bodies.push(body);
      onEvent('done', { message: { role: 'assistant', content: '好' }, finishReason: 'stop', maxTokens: 16000, usage: { promptTokens: 1, completionTokens: 1, estimated: false } });
    }, tool: async () => ({}), step() {}, send() {}, run: async () => ({}) };
  };
  const MODEL = { id: 1, label: '假', modelName: 'deepseek-v4-pro', effectiveContextWindow: 1_000_000 };
  const a = bridgeFor();
  await runHosted(a, { type: 'run', root: tmpdir(), message: '看看', model: MODEL, effort: 'extra' });
  assert.equal(a.bodies[0].reasoning, 'extra');
  const b = bridgeFor();
  await runHosted(b, { type: 'run', root: tmpdir(), message: '看看', model: MODEL });
  assert.equal(b.bodies[0].reasoning, 'instant');
  const c = bridgeFor();
  await runHosted(c, { type: 'run', root: tmpdir(), message: '看看', model: MODEL, effort: 'ultra' });
  assert.equal(c.bodies[0].reasoning, 'instant');
});

test('思考内容算进上下文估算（和服务端同一个算法）：不算的话压缩来得太晚，最后由服务端按轮丢', () => {
  const plain = { role: 'assistant', content: '好' };
  const thought = '想'.repeat(1000);
  assert.equal(estimateMessage({ ...plain, reasoning_content: thought }), estimateMessage(plain) + 1000);
  assert.ok(estimateMessage({ ...plain, reasoning_blocks: [{ type: 'thinking', thinking: thought, signature: 's' }] }) >= estimateMessage(plain) + 1000);
  assert.equal(needsCompaction('', [plain], 1000), false);
  assert.equal(needsCompaction('', [{ ...plain, reasoning_content: thought }], 1000), true);
});
