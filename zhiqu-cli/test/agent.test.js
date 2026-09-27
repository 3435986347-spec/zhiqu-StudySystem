// 循环：三档权限、「下发了什么就只能执行什么」、截断、计划批准、工具输出按窗口截断、存档。
// 用假的服务器接口（模型按脚本回）和假终端（用户按脚本答），不连后端。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { archiveTurn, runTurn, toolset } from '../src/agent.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

const REMOTE = ['search_wiki', 'read_wiki_page', 'create_wiki_patch', 'create_study_plan', 'read_memory', 'propose_memory']
  .map((name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }));

function makeCtx({ mode = 'auto', replies = [{ text: '好' }], answers = [], window = 64_000, root = tmpdir() } = {}) {
  const store = new SessionStore(root);
  const ctx = {
    ui: fakeUi(answers), api: fakeApi(replies), root, mode, maxRounds: 10,
    local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: REMOTE,
    model: { id: 1, label: '假模型', effectiveContextWindow: window },
  };
  return ctx;
}
const names = (ctx) => toolset(ctx).map((t) => t.schema.function.name);
const toolMessages = (ctx) => ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);

test('plan 档只下发读 / 搜 / 查（含远程只读）和 exit_plan_mode；ask / auto 下发全部，没有 exit_plan_mode', () => {
  const plan = names(makeCtx({ mode: 'plan' }));
  // update_todos 三档都有（第九轮）：只动命令行自己记的清单，不碰文件
  assert.deepEqual(plan, ['list_files', 'read_file', 'search', 'search_wiki', 'read_wiki_page', 'read_memory', 'update_todos', 'exit_plan_mode']);
  for (const mode of ['ask', 'auto']) {
    const all = names(makeCtx({ mode }));
    for (const n of ['write_file', 'run_command', 'create_study_plan', 'propose_memory']) assert.ok(all.includes(n), `${mode} 缺 ${n}`);
    assert.ok(!all.includes('exit_plan_mode'));
  }
});

test('auto：写文件不问，写完再汇报', async () => {
  const ctx = makeCtx({ replies: [{ calls: [{ name: 'write_file', args: { path: 'a.js', content: 'x\n' } }] }, { text: '写好了 a.js' }] });
  const r = await runTurn(ctx, '写个 a.js');
  assert.equal(fs.readFileSync(path.join(ctx.root, 'a.js'), 'utf8'), 'x\n');
  assert.equal(r.finalText, '写好了 a.js');
  assert.ok(!ctx.ui.text().includes('写入 a.js？'), '不该问');
  assert.deepEqual(r.changedFiles, ['a.js']);
});

test('ask：用户说 n 就不写，并告诉模型别原样重试；说 a 之后本会话不再问', async () => {
  const deny = makeCtx({ mode: 'ask', answers: ['n'], replies: [{ calls: [{ name: 'write_file', args: { path: 'a.js', content: 'x' } }] }, { text: '好' }] });
  await runTurn(deny, '写');
  assert.ok(!fs.existsSync(path.join(deny.root, 'a.js')));
  assert.match(toolMessages(deny)[0], /用户没有同意写入 a\.js.*不要原样重试/);

  const always = makeCtx({ mode: 'ask', answers: ['a'], replies: [
    { calls: [{ name: 'write_file', args: { path: 'a.js', content: '1' } }] },
    { calls: [{ name: 'write_file', args: { path: 'b.js', content: '2' } }] },
    { text: '好' }] });
  await runTurn(always, '写两个');
  assert.ok(fs.existsSync(path.join(always.root, 'a.js')) && fs.existsSync(path.join(always.root, 'b.js')));
  assert.equal((always.ui.text().match(/写入 [ab]\.js？/g) || []).length, 1, '选了「本会话都允许」之后不该再问');
});

test('没下发的工具调不到：plan 档里模型硬调 write_file / run_command，不执行，说明原因', async () => {
  const ctx = makeCtx({ mode: 'plan', replies: [
    { calls: [{ name: 'write_file', args: { path: 'x.js', content: 'x' } }, { name: 'run_command', args: { command: 'node', args: ['x.js'] } }] },
    { text: '好' }] });
  await runTurn(ctx, '做');
  assert.ok(!fs.existsSync(path.join(ctx.root, 'x.js')));
  const msgs = toolMessages(ctx);
  assert.equal(msgs.length, 2, '每个调用都要有结果（成对），否则下一次请求会被拒');
  for (const m of msgs) assert.match(m, /在当前的 plan 档没有下发.*exit_plan_mode 提交计划/);
  assert.ok(!msgs.some((m) => m.includes('不是暂时不可用')), '存在、只是这一档不给的工具，不能说成「没有这个工具」');
});

test('模型编了一个不存在的工具名（replace）：说清「不是暂时的」、该用哪个、怎么用 —— 模型换对了就能改成', async () => {
  const root = tmpdir();
  write(root, 'a.js', 'const x = 1;\n');
  const ctx = makeCtx({ root, replies: [
    { calls: [{ name: 'read_file', args: { path: 'a.js' } }] },
    { calls: [{ name: 'replace', args: { path: 'a.js', old_string: '1', new_string: '2' } }] },
    { calls: [{ name: 'write_file', args: { path: 'a.js', old_string: 'x = 1', new_string: 'x = 2' } }] },
    { text: '改好了' }] });
  await runTurn(ctx, '把 1 改成 2');
  const refusal = toolMessages(ctx)[1];
  assert.match(refusal, /没有叫 replace 的工具 —— 不是暂时不可用/);
  assert.match(refusal, /write_file 的替换用法.*old_string.*new_string/);
  assert.match(refusal, /能用的工具：.*write_file/);
  assert.ok(!/这一轮/.test(refusal), '「这一轮」听起来像暂时的，模型会一遍遍重试');
  assert.match(ctx.ui.text(), /replace（没有这个工具，应当用 write_file）/, '用户看到的那一行也要说清');
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'const x = 2;\n');
});

test('别家的工具名各自指到这里的对应工具（rm → delete_file）', async () => {
  const ctx = makeCtx({ replies: [
    { calls: [{ name: 'str_replace', args: {} }, { name: 'bash', args: {} }, { name: 'rm', args: {} }, { name: 'frobnicate', args: {} }] },
    { text: '好' }] });
  await runTurn(ctx, '做');
  const [strReplace, bash, del, unknown] = toolMessages(ctx);
  assert.match(strReplace, /write_file 的替换用法/);
  assert.match(bash, /run_command/);
  assert.match(del, /没有叫 rm 的工具.*删除文件用 delete_file/);
  assert.match(unknown, /没有叫 frobnicate 的工具.*能用的工具：/);
});

test('截断：参数不完整的调用不执行，历史里换成小而合法的 JSON，告诉模型分几次写，循环继续', async () => {
  const ctx = makeCtx({ replies: [
    { calls: [{ name: 'write_file', rawArgs: '{"path":"big.js","content":"很长很长' }], finishReason: 'length' },
    { calls: [{ name: 'write_file', args: { path: 'big.js', content: '第一段\n' } }] },
    { text: '分两次写完了' }] });
  const r = await runTurn(ctx, '写个大文件');
  const asst = ctx.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(asst.tool_calls[0].function.arguments, '{"_truncated":true,"path":"big.js"}');
  assert.match(toolMessages(ctx)[0], /参数被截断了.*没有执行.*append=true/s);
  assert.equal(ctx.api.requests.length, 3, '截断之后要接着问模型，而不是结束');
  assert.equal(fs.readFileSync(path.join(ctx.root, 'big.js'), 'utf8'), '第一段\n');
  assert.equal(r.finalText, '分两次写完了');
  assert.match(ctx.ui.text(), /被截断了/);
});

test('纯文字被截断：让模型接着说，最多两次，不无限循环', async () => {
  const ctx = makeCtx({ replies: [{ text: '说到一半', finishReason: 'length' }] });
  await runTurn(ctx, '长篇');
  assert.equal(ctx.api.requests.length, 3);
});

test('plan：交计划 → 用户选 a → 切到 auto，下一次请求就有写工具了', async () => {
  const ctx = makeCtx({ mode: 'plan', answers: ['a'], replies: [
    { calls: [{ name: 'exit_plan_mode', args: { plan: '1. 写 a.js' } }] },
    { calls: [{ name: 'write_file', args: { path: 'a.js', content: 'x' } }] },
    { text: '按计划做完了' }] });
  await runTurn(ctx, '规划一下');
  assert.equal(ctx.mode, 'auto');
  assert.ok(ctx.api.requests[1].tools.some((t) => t.function.name === 'write_file'));
  assert.ok(fs.existsSync(path.join(ctx.root, 'a.js')));
  assert.match(toolMessages(ctx)[0], /用户批准了计划，现在是 auto 档/);
  const denied = makeCtx({ mode: 'plan', answers: ['n'], replies: [{ calls: [{ name: 'exit_plan_mode', args: { plan: 'p' } }] }, { text: '好' }] });
  await runTurn(denied, '规划');
  assert.equal(denied.mode, 'plan');
});

test('工具输出按模型的窗口截断：窗口 8000 的模型读一个 3 万字的文件，只放进窗口 × 0.35 以内并说明', async () => {
  const root = tmpdir();
  write(root, 'big.txt', '长'.repeat(30_000));
  const ctx = makeCtx({ root, window: 8000, replies: [{ calls: [{ name: 'read_file', args: { path: 'big.txt' } }] }, { text: '好' }] });
  await runTurn(ctx, '读');
  const out = toolMessages(ctx)[0];
  assert.ok(out.length < 3100, `放进上下文的有 ${out.length} 字`);
  // 读文件自己按这个量给（第九轮起）：一行 3 万字只显示前 2500 字（2800 减去头部余量），并说明不算读全
  assert.match(out, /这一行有 30000 字，只显示了前 2500 字/);
});

test('其它工具的大段输出（命令、MCP…）仍按窗口截断并说明', async () => {
  const { capToolOutput } = await import('../src/agent.js');
  const out = capToolOutput('长'.repeat(30_000), 8000);
  assert.ok(out.length < 3100);
  assert.match(out, /只给了前 2800 字/);
});

test('远程工具带上这段会话的 id；网页存档先开会话再写消息，带着过程', async () => {
  const ctx = makeCtx({ replies: [{ calls: [{ name: 'create_study_plan', args: { tasks: [{ title: 't' }] } }] }, { text: '草稿好了' }] });
  const r = await runTurn(ctx, '排个计划');
  const call = ctx.api.posts.find((p) => p.pathname === '/api/harness/tools/call');
  assert.equal(call.body.sessionId, ctx.session.id);
  await archiveTurn(ctx, '排个计划', r);
  const last = ctx.api.posts.at(-1);
  assert.equal(last.pathname, `/api/harness/sessions/${ctx.session.id}/messages`, '一轮只发一个存档请求');
  assert.equal(last.body.title, '排个计划');
  assert.equal(last.body.workspace, path.basename(ctx.root));
  assert.match(last.body.messages[1].content, /> 过程：生成学习计划草稿/);
});

test('会话记录：一轮下来 user / assistant / tool 都落进 jsonl，续接能原样读回', async () => {
  const ctx = makeCtx({ replies: [{ calls: [{ name: 'list_files', args: {} }] }, { text: '看完了' }] });
  await runTurn(ctx, '看看');
  const loaded = ctx.store.load(ctx.session.id);
  assert.deepEqual(loaded.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(loaded.meta.title, '看看');
});

test('MCP 工具第一次用要问 —— auto 档也问；说 n 就不调', async () => {
  const called = [];
  const mcp = {
    schemas: () => [{ type: 'function', function: { name: 'mcp__demo__echo', parameters: { type: 'object', properties: {} } } }],
    call: async (name) => { called.push(name); return { content: '【MCP 工具 demo/echo 返回的数据】', summary: '完成' }; },
  };
  const ctx = makeCtx({ mode: 'auto', answers: ['n'], replies: [{ calls: [{ name: 'mcp__demo__echo', args: {} }] }, { text: '好' }] });
  ctx.mcp = mcp;
  await runTurn(ctx, '用 MCP');
  assert.deepEqual(called, []);
  assert.match(toolMessages(ctx)[0], /用户没有允许调用 mcp__demo__echo/);
  const ok = makeCtx({ mode: 'auto', answers: ['a'], replies: [
    { calls: [{ name: 'mcp__demo__echo', args: {} }] }, { calls: [{ name: 'mcp__demo__echo', args: {} }] }, { text: '好' }] });
  ok.mcp = mcp;
  await runTurn(ok, '用两次');
  assert.equal(called.length, 2);
  assert.equal((ok.ui.text().match(/第一次调用 MCP 工具/g) || []).length, 1, '选了「本会话都允许」之后不该再问');
});

test('delete_file：plan 档不给；ask 档逐个问、说 n 就不删；auto 删完再汇报，这一轮改动里写着「已删除」', async () => {
  assert.ok(!names(makeCtx({ mode: 'plan' })).includes('delete_file'));

  const askRoot = tmpdir();
  write(askRoot, 'check.js', 'x\n');
  const ask = makeCtx({ mode: 'ask', root: askRoot, answers: ['n'], replies: [
    { calls: [{ name: 'read_file', args: { path: 'check.js' } }] },
    { calls: [{ name: 'delete_file', args: { path: 'check.js' } }] },
    { text: '好' }] });
  await runTurn(ask, '删掉临时文件');
  assert.ok(fs.existsSync(path.join(askRoot, 'check.js')), '说了 n 还是删了');
  assert.match(ask.ui.text(), /删除 check\.js（1 行，挪进 \.zhiqu\/trash\/，能恢复）？/);
  assert.match(toolMessages(ask)[1], /用户没有同意删除 check\.js/);

  const autoRoot = tmpdir();
  const auto = makeCtx({ root: autoRoot, replies: [
    { calls: [{ name: 'write_file', args: { path: 'check.js', content: 'x\n' } }] },
    { calls: [{ name: 'delete_file', args: { path: 'check.js' } }] },
    { text: '做完了' }] });
  const r = await runTurn(auto, '写个校验脚本跑完删掉');
  assert.ok(!fs.existsSync(path.join(autoRoot, 'check.js')));
  assert.ok(!auto.ui.text().includes('删除 check.js（'), 'auto 不该问');
  assert.ok(r.changedFiles.includes('check.js（已删除）'), JSON.stringify(r.changedFiles));
});

test('ask 档里「本会话都允许写」不等于允许删', async () => {
  const root = tmpdir();
  const ctx = makeCtx({ mode: 'ask', root, answers: ['a', 'n'], replies: [
    { calls: [{ name: 'write_file', args: { path: 'a.js', content: 'x\n' } }] },
    { calls: [{ name: 'delete_file', args: { path: 'a.js' } }] },
    { text: '好' }] });
  await runTurn(ctx, '写完再删');
  assert.ok(fs.existsSync(path.join(root, 'a.js')), '允许写之后，删除没问就删了');
  assert.match(ctx.ui.text(), /删除 a\.js（/);
});
