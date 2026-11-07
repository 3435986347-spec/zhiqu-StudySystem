// 后台命令（第一百一十二轮，Codex 同级第 5 步）：真进程。真的后台跑、真的看输出、真的杀干净（连子进程）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { runTurn, toolset } from '../src/agent.js';
import { slash } from '../src/cli.js';
import { DraftTools } from '../src/tools/drafts.js';
import { describeJob, ShellJobs } from '../src/tools/jobs.js';
import { DEFAULT_SHELL_SECONDS, LocalTools, MAX_SHELL_SECONDS, shellSeconds } from '../src/tools/local.js';
import { detectSandbox, READ_ONLY } from '../src/tools/sandbox.js';
import { SessionStore } from '../src/session.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

const box = detectSandbox();
const skip = box ? false : '这台机器没有系统沙箱：这些判据没有跑';
const plain = (command, cwd) => ({ binary: '/bin/sh', args: ['-c', command], env: { PATH: process.env.PATH }, cwd, command });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 30)); } return fn(); };

test('起了就回；新输出一段一段给（看过的不再给）；结束了说退出码', async () => {
  const jobs = new ShellJobs();
  const { id } = jobs.start(plain('echo 第一段; sleep 0.3; echo 第二段; exit 3', tmpdir()));
  assert.equal(id, 'job-1');
  const first = await jobs.read(id, { waitMs: 150 });
  assert.equal(first.running, true);
  assert.match(first.output, /第一段/);
  const second = await jobs.read(id, { waitMs: 3000 });
  assert.equal(second.running, false, 'wait 要等到结束');
  assert.equal(second.exitCode, 3);
  assert.match(second.output, /第二段/);
  assert.doesNotMatch(second.output, /第一段/, '看过的不再给');
  assert.equal((await jobs.read(id)).output, '');
  assert.match(describeJob(second), /job-1：已结束，退出码 3/);
});

test('wait：结束了立刻回，不等满；没结束等到点；打断也立刻回', async () => {
  const jobs = new ShellJobs();
  const quick = jobs.start(plain('exit 0', tmpdir())).id;
  let t0 = Date.now();
  await jobs.read(quick, { waitMs: 5000 });
  assert.ok(Date.now() - t0 < 2000, `结束了还在等：${Date.now() - t0}ms`);
  const long = jobs.start(plain('sleep 30', tmpdir())).id;
  t0 = Date.now();
  await jobs.read(long, { waitMs: 300 });
  assert.ok(Date.now() - t0 >= 250, '没等到点');
  const controller = new AbortController();
  t0 = Date.now();
  const pending = jobs.read(long, { waitMs: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await pending;
  assert.ok(Date.now() - t0 < 2000, 'Ctrl+C 要立刻回');
  await jobs.stop(long);
});

test('停：连子进程一起；等它真的没了再回；停完还能看到最后的输出；再停不炸', async () => {
  const root = tmpdir();
  const jobs = new ShellJobs();
  const { id } = jobs.start(plain('echo started; sleep 60 & echo $! > child.pid; wait', root));
  await until(() => fs.existsSync(path.join(root, 'child.pid')) && fs.readFileSync(path.join(root, 'child.pid'), 'utf8').trim());
  const childPid = Number(fs.readFileSync(path.join(root, 'child.pid'), 'utf8'));
  assert.ok(alive(childPid), '对照：子进程先是活的');
  const r = await jobs.stop(id);
  assert.equal(r.running, false);
  assert.equal(r.stopped, true);
  assert.match(r.output, /started/);
  assert.ok(await until(() => !alive(childPid)), '子进程还活着');
  assert.equal((await jobs.stop(id)).running, false);
  assert.match((await jobs.stop('job-9')).error, /没有 job-9/);
});

test('输出只留最后一段，丢了多少说出来；一次给一段，后面还有多少说出来', async () => {
  const fresh = new ShellJobs({ keepBytes: 1000, readBytes: 100 });
  const j = fresh.start(plain('head -c 5000 /dev/zero | tr "\\0" x; sleep 0.2', tmpdir())).id;
  const s1 = await fresh.read(j, { waitMs: 3000 });
  assert.equal(s1.skipped, 4000, '前面丢了多少');
  assert.equal(s1.output.length, 100);
  assert.equal(s1.more, 900, '后面还有多少');
  assert.match(describeJob(s1), /前面有 4000 字节输出太早/);
  assert.match(describeJob(s1), /后面还有 900 字节/);
  const s2 = await fresh.read(j);
  assert.equal(s2.skipped, 0, '接着看不算丢');
  assert.equal(s2.output.length, 100);
  assert.equal(fresh.jobs.get(j).buf.length, 1000, '内存里只留这么多');
});

test('同时有上限；结束的不占名额；没有这个 id 说清楚', async () => {
  const jobs = new ShellJobs({ maxJobs: 2 });
  const a = jobs.start(plain('sleep 30', tmpdir())).id;
  jobs.start(plain('sleep 30', tmpdir()));
  assert.match(jobs.start(plain('sleep 30', tmpdir())).error, /已经有 2 个命令在跑了/);
  await jobs.stop(a);
  assert.ok(jobs.start(plain('sleep 30', tmpdir())).id, '停掉一个之后能再起');
  assert.match((await jobs.read('job-99')).error, /没有 job-99.*现在有/);
  jobs.stopAll();
  assert.ok(await until(() => jobs.running().length === 0));
});

test('被沙箱挡了要告诉模型；还在跑的、自己停的不说', () => {
  const denied = { id: 'job-1', running: false, exitCode: 1, output: 'bash: x: Operation not permitted', millis: 1000 };
  assert.match(describeJob(denied, { boundary: '边界' }), /可能被系统沙箱挡住了（边界）/);
  assert.doesNotMatch(describeJob({ ...denied, running: true }), /沙箱/);
  assert.doesNotMatch(describeJob({ ...denied, stopped: true }), /沙箱/);
  assert.doesNotMatch(describeJob({ ...denied, exitCode: 0 }), /沙箱/);
  assert.doesNotMatch(describeJob({ ...denied, output: 'AssertionError' }), /沙箱/);
});

test('时限：默认 120，最多 600，乱写的用默认', () => {
  assert.equal(shellSeconds(undefined), DEFAULT_SHELL_SECONDS);
  assert.equal(shellSeconds(30), 30);
  assert.equal(shellSeconds(99999), MAX_SHELL_SECONDS);
  assert.equal(shellSeconds('abc'), DEFAULT_SHELL_SECONDS);
  assert.equal(shellSeconds(-5), DEFAULT_SHELL_SECONDS);
});

// ── 循环里（真沙箱） ──
function agentCtx({ mode = 'auto', replies, answers = [], sandbox = box } = {}) {
  const root = tmpdir();
  const local = new LocalTools({ root, sandbox });
  const ui = fakeUi(answers);
  const store = new SessionStore(root);
  const ctx = { api: fakeApi(replies), ui, root, mode, maxRounds: 10, local, store, session: store.create({ model: 'm' }), messages: [],
    allow: { write: false, run: false, delete: false, tasks: false, mcp: new Set() }, usage: { prompt: 0, completion: 0, cached: 0 }, changedFiles: new Set(), todos: [],
    system: { text: 'x' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], archiveDisabled: true, model: { id: 1, label: 'm', modelName: 'm', effectiveContextWindow: 100000 } };
  return { ctx, ui, root, local };
}
const results = (ctx) => ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content);
const call = (name, args) => ({ calls: [{ name, args }] });

test('工具清单：有沙箱才有后台那两个；没有沙箱都没有；plan 档也有（只读）', () => {
  const names = (ctx) => toolset(ctx).map((t) => t.schema.function.name);
  const on = agentCtx({ sandbox: { kind: 'seatbelt', binary: '/x' }, replies: [] }).ctx;
  for (const n of ['shell', 'shell_output', 'shell_stop']) assert.ok(names(on).includes(n), n);
  assert.ok(names({ ...on, mode: 'plan' }).includes('shell_output'));
  const off = agentCtx({ sandbox: null, replies: [] }).ctx;
  assert.ok(!names(off).includes('shell_output'));
  assert.ok(!names(off).includes('shell_stop'));
});

test('后台跑：起完带回开头的输出和 id；shell_output 看；shell_stop 停；进程真的没了；还关在沙箱里', { skip }, async () => {
  const { ctx, root, local } = agentCtx({ replies: [
    call('shell', { command: 'echo y > /usr/zq-job-escape; echo y > inside.txt; echo 起来了; echo $$ > main.pid; sleep 60', background: true }),
    call('shell_output', { id: 'job-1' }),
    call('shell_stop', { id: 'job-1' }),
    call('shell_output', { id: 'job-77' }),
    { text: '好' }] });
  await runTurn(ctx, '干活');
  const [started, output, stopped, missing] = results(ctx);
  assert.match(started, /job-1：还在跑/);
  assert.match(started, /起来了/);
  assert.match(started, /Operation not permitted|Read-only file system/, '后台命令也关在沙箱里');
  assert.match(output, /job-1：还在跑/);
  assert.match(output, /没有新输出/);
  assert.match(stopped, /已停止 job-1：已结束/);
  assert.match(missing, /没有 job-77/);
  assert.equal(fs.existsSync('/usr/zq-job-escape'), false);
  assert.equal(fs.readFileSync(path.join(root, 'inside.txt'), 'utf8'), 'y\n');
  const pid = Number(fs.readFileSync(path.join(root, 'main.pid'), 'utf8'));
  assert.ok(await until(() => !alive(pid)), '停了还活着');
  assert.equal(local.jobs.running().length, 0);
});

test('plan 档的后台命令也写不了工作区；ask 档要问，说不就不起', { skip }, async () => {
  const plan = agentCtx({ mode: 'plan', replies: [call('shell', { command: 'echo x > a.txt; echo done', background: true }), { text: '好' }] });
  await runTurn(plan.ctx, '看');
  assert.equal(fs.existsSync(path.join(plan.root, 'a.txt')), false, 'plan 档写进工作区了');
  assert.match(results(plan.ctx)[0], /done/);
  const ask = agentCtx({ mode: 'ask', answers: ['n'], replies: [call('shell', { command: 'echo x > a.txt', background: true }), { text: '好' }] });
  await runTurn(ask.ctx, '干');
  assert.equal(ask.local.jobs.list().length, 0, '说不还是起了');
  assert.match(results(ask.ctx)[0], /用户没有同意运行/);
});

test('前台时限：模型给的算数，到点连子进程一起杀', { skip }, async () => {
  const { ctx, root } = agentCtx({ replies: [call('shell', { command: 'sleep 60 & echo $! > p.pid; wait', timeout_seconds: 1 }), { text: '好' }] });
  const t0 = Date.now();
  await runTurn(ctx, '跑');
  assert.ok(Date.now() - t0 < 8000, `没按模型给的时限：${Date.now() - t0}ms`);
  assert.match(results(ctx)[0], /超时/);
  const pid = Number(fs.readFileSync(path.join(root, 'p.pid'), 'utf8'));
  assert.ok(await until(() => !alive(pid)), '子进程还活着');
});

test('/ps、/stop：列得出来、停得掉；没有就说没有', { skip }, async () => {
  const { ctx, ui, local } = agentCtx({ replies: [] });
  await slash(ctx, '/ps');
  assert.match(ui.text(), /后台没有命令/);
  await slash(ctx, '/stop all');
  assert.match(ui.text(), /后台没有在跑的命令/);
  await slash(ctx, '/stop');
  assert.match(ui.text(), /要停哪个/);
  const prep = local.prepareShell({ command: 'sleep 60' });
  const started = await local.startJob(prep, { policy: READ_ONLY });
  await slash(ctx, '/ps');
  assert.match(ui.text(), new RegExp(`${started.id}  在跑（\\d+ 秒）  sleep 60`));
  await slash(ctx, `/stop ${started.id}`);
  assert.match(ui.text(), new RegExp(`已停止 ${started.id}`));
  assert.equal(local.jobs.running().length, 0);
  await slash(ctx, '/ps');
  assert.match(ui.text(), /已停止  sleep 60/);
  await slash(ctx, '/stop job-99');
  assert.match(ui.text(), /没有 job-99/);
  const second = await local.startJob(local.prepareShell({ command: 'sleep 60' }), { policy: READ_ONLY });
  await slash(ctx, '/stop all');
  assert.equal(local.jobs.running().length, 0, `/stop all 没停掉 ${second.id}`);
});

test('真的 zhiqu -p：答完就退（后台命令不拖着）；退出时收掉，不留在用户电脑上', { skip }, async (t) => {
  const root = tmpdir();
  const home = tmpdir();
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const json = (v) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: v })); };
      if (req.url.startsWith('/api/harness/models')) return json({ models: [{ id: 1, label: 'm', modelName: 'm', toolCalling: true, effectiveContextWindow: 100000 }], defaultModelId: 1 });
      if (req.url.startsWith('/api/harness/tools')) return json([]);
      if (req.url.startsWith('/api/harness/model/stream')) {
        n += 1;
        res.setHeader('Content-Type', 'text/event-stream');
        const send = (name, data) => res.write(`event:${name}\ndata:${JSON.stringify(data)}\n\n`);
        send('start', { contextWindow: 100000, droppedMessages: 0, elidedToolOutputs: 0 });
        const message = n === 1
          ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'echo $$ > main.pid; sleep 120', background: true }) } }] }
          : { role: 'assistant', content: '好了' };
        send('done', { message, finishReason: n === 1 ? 'tool_calls' : 'stop', maxTokens: 16000, usage: { promptTokens: 1, completionTokens: 1, estimated: false } });
        return res.end();
      }
      return json({});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { PATH: process.env.PATH, HOME: home, ZHIQU_HOME: path.join(home, '.zhiqu'), ZHIQU_TOKEN: 'zqp_x', ZHIQU_SERVER: `http://127.0.0.1:${server.address().port}` };
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.resolve('bin/zhiqu.js'), '-p', '起一个', '--mode', 'auto'], { cwd: root, env, stdio: 'ignore' });
    c.on('close', resolve);
  });
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 20000, `被后台命令拖住了：${Date.now() - t0}ms`);
  const pid = Number(fs.readFileSync(path.join(root, 'main.pid'), 'utf8'));
  assert.ok(await until(() => !alive(pid)), '命令行退了，后台命令还活着');
});

test('网页：后台命令交回后端起；看、停都带 jobId（id 是请求自己的）；被拒照实说；跑过才算跑过', async () => {
  const sent = [];
  let reply = { jobId: 'job-1', running: true, exitCode: 0, output: '起来了', skipped: 0, more: 0, millis: 1500 };
  const t = new DraftTools({ root: tmpdir(), canShell: true, shellWrite: true, exec: async (req) => { sent.push(req); return reply; } });
  const started = await t.startJob(t.prepareShell({ command: 'npm run dev', cwd: 'web' }));
  assert.deepEqual({ ...sent[0], waitMs: 0 }, { shell: true, background: true, command: 'npm run dev', cwd: 'web', waitMs: 0 });
  assert.ok(sent[0].waitMs > 0, '起完等一小会儿，带回开头的输出');
  assert.equal(started.id, 'job-1');
  assert.match(started.content, /job-1：还在跑[\s\S]*起来了/);
  assert.equal(t.ranCommand, true);
  await t.readJob({ id: 'job-1', wait_seconds: 500 });
  assert.deepEqual(sent[1], { job: 'read', jobId: 'job-1', waitMs: 60000 }, '最多等 60 秒');
  reply = { jobId: 'job-1', running: false, exitCode: -1, stopped: true, output: '', skipped: 0, more: 0, millis: 2000 };
  assert.match((await t.stopJob({ id: 'job-1' })).content, /已停止 job-1：已结束/);
  assert.deepEqual(sent[2], { job: 'stop', jobId: 'job-1' });
  await t.commitShell(t.prepareShell({ command: 'mvn test', timeout_seconds: 300 }));
  assert.equal(sent[3].timeoutMs, 300000, '前台时限交给后端');
  const refused = new DraftTools({ root: tmpdir(), canShell: true, exec: async () => ({ error: '后台已经有 4 个命令在跑了' }) });
  assert.match((await refused.startJob(refused.prepareShell({ command: 'x' }))).error, /4 个/);
  assert.equal(refused.ranCommand, undefined);
  assert.match((await refused.readJob({ id: 'job-1' })).error, /4 个/);
  assert.match((await refused.stopJob({ id: 'job-1' })).error, /4 个/);
});
