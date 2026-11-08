// 子 agent（第一百二十三轮，Codex 同级第 8 步）：真的并行、只读的真只读、权限不超过主 agent、上限、一句话收尾、Ctrl+C、各自一份「读过什么」、确认一次只问一个。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { runTurn, toolset } from '../src/agent.js';
import { agentLimits, agentUi, childLocal, DEFAULT_AGENT_LIMITS, SubAgents } from '../src/subagents.js';
import { resolveSettings } from '../src/config.js';
import { slash } from '../src/cli.js';
import { SessionStore } from '../src/session.js';
import { detectSandbox } from '../src/tools/sandbox.js';
import { LocalTools } from '../src/tools/local.js';
import { Ui } from '../src/ui.js';
import { fakeServer, fakeUi, runZhiqu, tmpdir, write } from './helpers.js';
import { Vt } from './vt.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 按内容回的假模型：几个子 agent 同时调模型，请求到达的顺序不固定，不能按「第几次」回。
 * script(who, round, body) 返回 { text } / { calls } / { delay, usage }；who 是 'lead' 或子 agent 的编号，round 是这一位第几次来问。
 */
function routedApi(script) {
  const rounds = new Map();
  const seen = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    seen,
    get maxInFlight() { return maxInFlight; },
    async stream(pathname, body, onEvent, { signal } = {}) {
      const first = (body.messages.find((m) => m.role === 'user') || {}).content || '';
      const m = /^你是主 agent 派出来的子 agent (\S+?)（/.exec(String(first));
      const who = m ? m[1] : 'lead';
      const round = (rounds.get(who) || 0) + 1;
      rounds.set(who, round);
      seen.push({ who, round, body: JSON.parse(JSON.stringify(body)) });
      const r = script(who, round, body) || { text: '好' };
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (r.delay) await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, r.delay);
          if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
        });
      } finally {
        inFlight -= 1;
      }
      onEvent('start', { droppedMessages: 0, elidedToolOutputs: 0, contextWindow: 64000 });
      if (r.text) onEvent('delta', { text: r.text });
      const calls = (r.calls || []).map((c, i) => ({ id: `${who}_${round}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
      const message = { role: 'assistant', content: r.text || '' };
      if (calls.length) message.tool_calls = calls;
      onEvent('done', { message, finishReason: calls.length ? 'tool_calls' : 'stop', maxTokens: 16000,
        usage: r.usage || { promptTokens: 100, completionTokens: 10, cachedTokens: 50 } });
    },
    async post() { return { content: 'ok' }; },
    async get() { return {}; },
  };
}

function makeCtx({ mode = 'auto', script, root = tmpdir(), limits = {}, ui = fakeUi(), execReadOnly = false } = {}) {
  const api = routedApi(script);
  const ctx = {
    ui, api, root, mode, maxRounds: 12, execReadOnly,
    local: new LocalTools({ root }), store: null, session: { id: 'test' }, messages: [],
    allow: { write: false, run: false, delete: false, tasks: false, mcp: new Set() }, usage: { prompt: 0, completion: 0, cached: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 64_000 },
  };
  ctx.agents = new SubAgents({ runTurn, limits: { ...DEFAULT_AGENT_LIMITS, ...limits } });
  return ctx;
}
const toolNames = (body) => (body.tools || []).map((t) => t.function.name);
const toolOutputs = (ctx) => ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');

test('两个 explorer 真的并行；结论交回主 agent；它们只拿到只读的工具、拿不到派子 agent 的、看不到主 agent 和用户的对话', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'export const a = 1;\n');
  write(root, 'b.js', 'export const b = 2;\n');
  const ctx = makeCtx({ root, script: (who, round) => {
    if (who === 'lead') {
      if (round === 1) return { calls: [{ name: 'spawn_agent', args: { role: 'explorer', task: '读 a.js，说 a 是多少' } }, { name: 'spawn_agent', args: { role: 'explorer', task: '读 b.js，说 b 是多少' } }] };
      if (round === 2) return { calls: [{ name: 'wait_agent', args: {} }] };
      return { text: 'a 是 1，b 是 2。' };
    }
    if (round === 1) return { delay: 200, calls: [{ name: 'read_file', args: { path: who === 'explorer-1' ? 'a.js' : 'b.js' } }] };
    return { delay: 200, text: who === 'explorer-1' ? 'a.js 第 1 行：a 是 1。' : 'b.js 第 1 行：b 是 2。' };
  } });
  const r = await runTurn(ctx, '帮我同时看看 a.js 和 b.js（秘密：项目代号青鸟）');
  assert.equal(r.finalText, 'a 是 1，b 是 2。');
  assert.ok(ctx.api.maxInFlight >= 2, `没有并行：同时在途最多 ${ctx.api.maxInFlight} 个`);
  const out = toolOutputs(ctx);
  assert.match(out, /explorer-1（只读探索）：做完了[\s\S]*a 是 1/);
  assert.match(out, /explorer-2（只读探索）：做完了[\s\S]*b 是 2/);
  const child = ctx.api.seen.find((s) => s.who === 'explorer-1');
  const names = toolNames(child.body);
  for (const n of ['write_file', 'edit_file', 'apply_patch', 'delete_file', 'run_command', 'spawn_agent', 'wait_agent', 'exit_plan_mode']) {
    assert.ok(!names.includes(n), `explorer 拿到了 ${n}`);
  }
  assert.ok(names.includes('read_file') && names.includes('search'));
  assert.doesNotMatch(JSON.stringify(child.body.messages), /青鸟/, '子 agent 看得到主 agent 和用户的对话');
  const lead = ctx.api.seen.find((s) => s.who === 'lead');
  assert.ok(toolNames(lead.body).includes('spawn_agent'), '主 agent 要有派子 agent 的工具');
  assert.ok(ctx.usage.prompt >= 500, `子 agent 的用量要算进来：${ctx.usage.prompt}`);
});

test('worker 和主 agent 同一档：auto 档真写进磁盘，改过的文件交回主 agent；explorer 硬调写文件被拒、说它是只读的', async () => {
  const root = tmpdir();
  const ctx = makeCtx({ root, script: (who, round) => {
    if (who === 'lead') {
      if (round === 1) return { calls: [{ name: 'spawn_agent', args: { role: 'worker', task: '新建 notes.md，写一行「你好」' } }, { name: 'spawn_agent', args: { role: 'explorer', task: '把 x.md 改成空的' } }] };
      if (round === 2) return { calls: [{ name: 'wait_agent', args: {} }] };
      return { text: '好了' };
    }
    if (who === 'worker-1') return round === 1 ? { calls: [{ name: 'write_file', args: { path: 'notes.md', content: '你好\n' } }] } : { text: '写好了 notes.md。' };
    return round === 1 ? { calls: [{ name: 'write_file', args: { path: 'x.md', content: '' } }] } : { text: '我是只读的，改不了。' };
  } });
  await runTurn(ctx, '分头做');
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), '你好\n');
  assert.ok(!fs.existsSync(path.join(root, 'x.md')), 'explorer 写进去了');
  assert.ok(ctx.changedFiles.has('notes.md'), '主 agent 要知道改过什么');
  assert.match(toolOutputs(ctx), /改过的文件：notes\.md/);
  const refused = ctx.api.seen.find((s) => s.who === 'explorer-1' && s.round === 2);
  assert.match(JSON.stringify(refused.body.messages), /你是只读探索的子 agent/);
});

test('权限不超过主 agent：plan 档、exec 只读时派不了 worker（explorer 照派）；子 agent 不能再派子 agent', async () => {
  for (const opts of [{ mode: 'plan' }, { mode: 'auto', execReadOnly: true }]) {
    const ctx = makeCtx({ ...opts, script: (who, round) => {
      if (who === 'lead') return round === 1 ? { calls: [{ name: 'spawn_agent', args: { role: 'worker', task: '改代码' } }] } : { text: '好' };
      return { text: '看完了' };
    } });
    await runTurn(ctx, '改');
    assert.match(toolOutputs(ctx), /只能派 explorer/, JSON.stringify(opts));
    assert.equal(ctx.agents.list().length, 0);
  }
  const ctx = makeCtx({ script: (who, round) => {
    if (who === 'lead') {
      if (round === 1) return { calls: [{ name: 'spawn_agent', args: { role: 'worker', task: '干活' } }] };
      if (round === 2) return { calls: [{ name: 'wait_agent', args: {} }] };
      return { text: '好' };
    }
    return round === 1 ? { calls: [{ name: 'spawn_agent', args: { role: 'explorer', task: '再派一个' } }] } : { text: '自己做完了' };
  } });
  await runTurn(ctx, '干');
  const child = ctx.api.seen.find((s) => s.who === 'worker-1');
  assert.ok(!toolNames(child.body).includes('spawn_agent'), '子 agent 拿到了派子 agent 的工具');
  assert.ok(!toolNames(child.body).includes('shell_output'), '子 agent 不给后台命令');
  assert.match(JSON.stringify(ctx.api.seen.find((s) => s.who === 'worker-1' && s.round === 2).body.messages), /不能再派子 agent/);
  assert.equal(ctx.agents.list().length, 1);
});

test('上限：同时在跑的、一句话里派的个数', async () => {
  const ctx = makeCtx({ limits: { maxConcurrent: 2, maxPerTurn: 3 }, script: (who, round) => {
    if (who === 'lead') {
      if (round === 1) return { calls: [1, 2, 3].map((n) => ({ name: 'spawn_agent', args: { role: 'explorer', task: `看第 ${n} 个` } })) };
      if (round === 2) return { calls: [{ name: 'wait_agent', args: {} }] };
      if (round === 3) return { calls: [3, 4].map((n) => ({ name: 'spawn_agent', args: { role: 'explorer', task: `再看第 ${n} 个` } })) };
      if (round === 4) return { calls: [{ name: 'wait_agent', args: {} }] };
      return { text: '好' };
    }
    return { delay: 100, text: `${who} 看完了` };
  } });
  await runTurn(ctx, '看');
  const out = toolOutputs(ctx);
  assert.match(out, /已经有 2 个子 agent 在跑（explorer-1、explorer-2，同时最多 2 个）/);
  assert.match(out, /这一句已经派了 3 个子 agent（一句话最多 3 个）/);
  assert.equal(ctx.agents.list().length, 3, '第三个在等前两个做完之后才派得出去，第四个超过一句话的个数');
});

test('预算：这一句子 agent 花的 token 到了上限就停下所有在跑的、不再派；主 agent 收到为什么', async () => {
  const ctx = makeCtx({ limits: { turnTokens: 10_000 }, script: (who, round) => {
    if (who === 'lead') {
      if (round === 1) return { calls: [{ name: 'spawn_agent', args: { role: 'explorer', task: '慢慢看' } }, { name: 'spawn_agent', args: { role: 'explorer', task: '也慢慢看' } }] };
      if (round === 2) return { calls: [{ name: 'wait_agent', args: {} }] };
      if (round === 3) return { calls: [{ name: 'spawn_agent', args: { role: 'explorer', task: '再看' } }] };
      return { text: '好' };
    }
    // 第一次就很贵、第二次还在想：到了上限要停
    return round === 1 ? { calls: [{ name: 'list_files', args: {} }], usage: { promptTokens: 6000, completionTokens: 10 } } : { delay: 2000, text: '这句不该出现' };
  } });
  await runTurn(ctx, '看');
  const out = toolOutputs(ctx);
  assert.match(out, /预算用完，停了/);
  assert.doesNotMatch(out, /这句不该出现/);
  assert.match(out, /到了上限（10K）：不再派新的/);
  assert.ok(ctx.agents.list().every((a) => a.status === 'budget'), ctx.agents.list().map((a) => a.status).join());
  assert.ok(ctx.usage.prompt >= 12_000, '子 agent 的用量算进主 agent 的');
});

test('一句话收尾时还有在跑的：推一次 wait_agent；还不等就停掉，不留到下一句', async () => {
  const ui = fakeUi();
  const ctx = makeCtx({ ui, script: (who, round, body) => {
    if (who === 'lead') {
      if (round === 1) return { calls: [{ name: 'spawn_agent', args: { role: 'explorer', task: '慢慢看' } }] };
      return { text: '派出去了，等它就行。' };    // 两次都不等
    }
    return { delay: 3000, text: '看完了' };
  } });
  const t0 = Date.now();
  const r = await runTurn(ctx, '看');
  assert.equal(r.finalText, '派出去了，等它就行。');
  const leadAsks = ctx.api.seen.filter((s) => s.who === 'lead');
  assert.equal(leadAsks.length, 3, '收尾前推了一次，推完不再推');
  assert.match(JSON.stringify(leadAsks[2].body.messages), /还在跑，结论还没拿回来/);
  assert.ok(Date.now() - t0 < 2500, '没有傻等那个慢的');
  assert.equal(ctx.agents.get('explorer-1').status, 'turn-end');
  assert.equal(ctx.agents.running().length, 0, '不留到下一句');
  assert.match(ui.text(), /explorer-1 还没做完，已经停下/);
});

test('Ctrl+C：主 agent 的一句被打断，子 agent 一起停', async () => {
  const controller = new AbortController();
  const ctx = makeCtx({ script: (who, round) => {
    if (who === 'lead') return round === 1 ? { calls: [{ name: 'spawn_agent', args: { role: 'worker', task: '慢慢干' } }, { name: 'wait_agent', args: {} }] } : { text: '好' };
    return { delay: 5000, text: '干完了' };
  } });
  setTimeout(() => controller.abort(), 200);
  const t0 = Date.now();
  await runTurn(ctx, '干', { signal: controller.signal });
  assert.ok(Date.now() - t0 < 2000, `Ctrl+C 之后还等了 ${Date.now() - t0}ms`);
  assert.equal(ctx.agents.get('worker-1').status, 'interrupted');
});

test('send_input：做完的接着做（记得之前读过的）；在跑的不能插话；close_agent 停掉在跑的', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'export const a = 1;\n');
  const ctx = makeCtx({ root, script: (who, round) => {
    if (who === 'lead') {
      const steps = [
        { calls: [{ name: 'spawn_agent', args: { role: 'explorer', task: '读 a.js' } }] },
        { calls: [{ name: 'wait_agent', args: {} }] },
        { calls: [{ name: 'send_input', args: { id: 'explorer-1', message: '刚才那个文件里 a 是多少？' } }, { name: 'send_input', args: { id: 'explorer-1', message: '插一句' } }] },
        { calls: [{ name: 'wait_agent', args: { ids: ['explorer-1'] } }] },
        { calls: [{ name: 'spawn_agent', args: { role: 'explorer', task: '慢慢看' } }] },
        { calls: [{ name: 'close_agent', args: { id: 'explorer-2' } }] },
        { text: '好' },
      ];
      return steps[Math.min(round, steps.length) - 1];
    }
    if (who === 'explorer-2') return { delay: 5000, text: '不该做完' };
    if (round === 1) return { calls: [{ name: 'read_file', args: { path: 'a.js' } }] };
    return { delay: 100, text: round === 2 ? '读完了。' : 'a 是 1（之前读过）。' };
  } });
  await runTurn(ctx, '看');
  const out = toolOutputs(ctx);
  assert.match(out, /explorer-1 还在跑，不能插话/);
  assert.match(out, /a 是 1（之前读过）/);
  const again = ctx.api.seen.filter((s) => s.who === 'explorer-1').at(-1);
  assert.match(JSON.stringify(again.body.messages), /export const a = 1/, '接着做时它记得之前读过的');
  assert.equal(ctx.agents.get('explorer-2').status, 'closed');
  assert.match(out, /explorer-2（只读探索）：被停掉了/);
});

test('每个 agent 自己一份「读过什么」：A 写过的文件，没读过的 B 不能整份盖掉', () => {
  const root = tmpdir();
  const shared = new LocalTools({ root });
  const a = childLocal(shared);
  const b = childLocal(shared);
  const w = a.prepareWrite({ path: 'x.txt', content: 'A 写的\n' });
  assert.ok(!w.error, w.error);
  assert.ok(!a.commitWrite(w).error);
  const over = b.prepareWrite({ path: 'x.txt', content: 'B 凭空写的\n' });
  assert.match(String(over.error), /必须先 read_file/, '共用一份「读过什么」时 B 能盖掉 A 的');
  assert.equal(shared.known.size, 0, '主 agent 那份也不被子 agent 动');
  assert.equal(a.root, shared.root, '工作区还是同一个');
});

test('用户级配置才认（agents: false 关掉、数字在范围里才认）', () => {
  assert.equal(agentLimits(false).enabled, false);
  assert.equal(agentLimits({ maxConcurrent: 5, turnTokens: 999_999_999, maxPerTurn: 'x' }).maxConcurrent, 5);
  assert.equal(agentLimits({ turnTokens: 999_999_999 }).turnTokens, DEFAULT_AGENT_LIMITS.turnTokens, '超出范围的不认');
  assert.equal(agentLimits(undefined).enabled, true);
});

function tty(cols = 80) {
  const vt = new Vt(cols);
  const output = new Writable({ write(chunk, _e, cb) { vt.feed(chunk.toString()); cb(); } });
  output.columns = cols;
  output.isTTY = true;
  const input = new PassThrough();
  input.isTTY = true;
  const ui = new Ui({ input, output, color: false, interactive: true });
  ui.start();
  return { ui, vt, input };
}
const tick = () => new Promise((r) => setImmediate(r));

test('确认一次只问一个：两个同时要确认时，屏幕上问的就是回答给的那个；Ctrl+C 之后还排着的不再问、按不同意', async () => {
  const { ui, vt, input } = tty();
  ui.beginLive();
  const opts = [{ key: 'y', label: '写入' }, { key: 'n', label: '不写' }];
  const a = ui.choose('[worker-1] 写入 a.js？', opts, 'n');
  const b = ui.choose('[worker-2] 写入 b.js？', opts, 'n');
  await tick(); await tick();
  assert.match(vt.lines().join('\n'), /写入 a\.js？/);
  assert.doesNotMatch(vt.lines().join('\n'), /写入 b\.js？/, '后一个问题不该同时挂出来');
  input.write('y\r'); await tick(); await tick();
  assert.equal(await a, 'y', '看着 a.js 回答 y，批准的要是 a.js');
  await tick();
  assert.match(vt.lines().join('\n'), /写入 b\.js？/, '前一个答完才问后一个');
  input.write('n\r'); await tick(); await tick();
  assert.equal(await b, 'n');

  const c = ui.choose('写入 c.js？', opts, 'n');
  const d = ui.choose('写入 d.js？', opts, 'n');
  await tick(); await tick();
  ui.cancelQuestion();
  assert.equal(await c, 'n');
  assert.equal(await d, 'n', '排着的那个按不同意，不再问出来');
  await tick();
  assert.doesNotMatch(vt.lines().join('\n'), /写入 d\.js？/);
  ui.close();
});

test('有系统沙箱时：主 agent 有后台命令，子 agent 没有（它停了之后后台命令谁来管说不清）', { skip: detectSandbox() ? false : '这台机器没有系统沙箱' }, async () => {
  const root = tmpdir();
  const ctx = makeCtx({ root, script: (who, round) => {
    if (who === 'lead') return round === 1 ? { calls: [{ name: 'spawn_agent', args: { role: 'worker', task: '干活' } }] } : round === 2 ? { calls: [{ name: 'wait_agent', args: {} }] } : { text: '好' };
    return { text: '做完了' };
  } });
  ctx.local = new LocalTools({ root, sandbox: detectSandbox() });
  await runTurn(ctx, '干');
  const lead = toolNames(ctx.api.seen.find((s) => s.who === 'lead').body);
  const child = toolNames(ctx.api.seen.find((s) => s.who === 'worker-1').body);
  assert.ok(lead.includes('shell_output') && lead.includes('shell'), lead.join());
  assert.ok(child.includes('shell') && !child.includes('shell_output') && !child.includes('shell_stop'), child.join());
});

test('子 agent 停下了就不再问确认；问出去、回答回来时已经停了，也按不同意', async () => {
  const ui = fakeUi(['y', 'y']);
  const opts = [{ key: 'y', label: '写入' }, { key: 'n', label: '不写' }];
  let stopped = true;
  const u = agentUi(ui, 'worker-1', () => stopped);
  assert.equal(await u.choose('写入 a.js？', opts, 'n'), 'n');
  assert.doesNotMatch(ui.text(), /写入 a\.js/, '停了还问出来了');
  stopped = false;
  const pending = u.choose('写入 b.js？', opts, 'n');
  stopped = true;                       // 问出去之后被停掉
  assert.equal(await pending, 'n', '回答回来时已经停了：按不同意（不然停掉的子 agent 还会写文件）');
  assert.match(ui.text(), /\[worker-1\] 写入 b\.js？/, '问题要标上是谁');
});

test('上限只认用户级的 ~/.zhiqu/config.json：项目里的 .zhiqu/settings.json 调不高（克隆下来的仓库不能替用户多花钱）', () => {
  const home = tmpdir();
  const root = tmpdir();
  write(home, 'config.json', JSON.stringify({ agents: { maxConcurrent: 2 } }));
  write(root, '.zhiqu/settings.json', JSON.stringify({ agents: { maxConcurrent: 6, turnTokens: 20_000_000 } }));
  const before = process.env.ZHIQU_HOME;
  process.env.ZHIQU_HOME = home;
  try {
    const agents = resolveSettings(root).agents;
    assert.equal(agents.maxConcurrent, 2);
    assert.equal(agents.turnTokens, DEFAULT_AGENT_LIMITS.turnTokens);
  } finally {
    if (before === undefined) delete process.env.ZHIQU_HOME; else process.env.ZHIQU_HOME = before;
  }
});

test('/agents 列出这段会话派过的、/agents <编号> 看结论；/new 换会话就清空', async () => {
  const root = tmpdir();
  const ui = fakeUi();
  const ctx = makeCtx({ root, ui, script: (who, round) => {
    if (who === 'lead') return round === 1 ? { calls: [{ name: 'spawn_agent', args: { role: 'explorer', task: '看一眼目录' } }] } : round === 2 ? { calls: [{ name: 'wait_agent', args: {} }] } : { text: '好' };
    return { text: '目录是空的。' };
  } });
  ctx.store = new SessionStore(root);
  ctx.session = ctx.store.create({ model: '假模型' });
  await runTurn(ctx, '看');
  await slash(ctx, '/agents');
  assert.match(ui.text(), /explorer-1 {2}做完了（\d+ 秒，1 次模型/);
  await slash(ctx, '/agents explorer-1');
  assert.match(ui.text(), /## explorer-1（只读探索）：做完了[\s\S]*目录是空的。/);
  await slash(ctx, '/new');
  assert.equal(ctx.agents.list().length, 0, '换一段会话：上一段的子 agent 不跟过来');
});

test('真的命令行入口（zhiqu exec）：建好了子 agent，默认只读时 explorer 照派、结论回到主 agent；用户级配置 agents: false 就没有这几个工具', async (t) => {
  // 主 agent 一次回里派了就等：请求是一个接一个来的（主 1 → 子 1 → 主 2），按顺序回的假服务器就够了
  const on = await fakeServer(t, [
    { calls: [{ name: 'spawn_agent', args: { role: 'explorer', task: '看一眼目录' } }, { name: 'wait_agent', args: {} }] },
    { text: '目录是空的。' },
    { text: '子 agent 说目录是空的。' },
  ]);
  const r = await runZhiqu('exec', ['看看'], { url: on.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '子 agent 说目录是空的。\n');
  assert.ok(on.seen[0].tools.some((x) => x.function.name === 'spawn_agent'), '主 agent 要有派子 agent 的工具');
  assert.match(String(on.seen[1].messages[1].content), /^你是主 agent 派出来的子 agent explorer-1/);
  assert.match(JSON.stringify(on.seen[2].messages), /explorer-1（只读探索）：做完了[\s\S]*目录是空的/);

  const home = tmpdir();
  write(home, '.zhiqu/config.json', JSON.stringify({ agents: false }));
  const off = await fakeServer(t, [{ text: '好' }]);
  const r2 = await runZhiqu('exec', ['看看'], { url: off.url, home });
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(!off.seen[0].tools.some((x) => x.function.name === 'spawn_agent'), '关掉了还下发');
});
