// 长活省钱第 6 步（第一百七十一轮，docs/agent-efficiency-plan.md）：进程没正常结束时记下原因，下次启动说出来、直接回车接着做。
// 用户那段会话里进程两次中途没了、什么都没记；用户把 4087 字的终端输出整段贴进来，只为了说「继续这个」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runTurn } from '../src/agent.js';
import { noteUnfinished } from '../src/cli.js';
import { exitReason, installExitRecorder, lastExit, recordExit } from '../src/exitlog.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeServer, fakeUi, tmpdir } from './helpers.js';

function ctxWith(root = tmpdir(), replies = [{ text: '好' }]) {
  const store = new SessionStore(root);
  return {
    ui: fakeUi([]), api: fakeApi(replies), root, mode: 'auto', maxRounds: 10, local: new LocalTools({ root }), store, session: store.create(),
    messages: [], allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [], model: { id: 1, label: 'm', effectiveContextWindow: 64000 },
  };
}

test('原因的说法：终端被关、被结束、内部出错、没来得及记（带最后的内存）', () => {
  assert.equal(exitReason({ exit: { reason: 'signal', signal: 'SIGHUP', working: true, lastTool: 'shell' }, rss: 300 }), '终端被关掉了（SIGHUP），当时正在干活（最后一个工具 shell）');
  assert.equal(exitReason({ exit: { reason: 'signal', signal: 'SIGTERM', working: false }, rss: null }), '进程被结束了（SIGTERM）');
  assert.equal(exitReason({ exit: { reason: 'error', error: 'Cannot read properties of undefined', lastTool: 'preview_page' }, rss: 1 }), '命令行内部出错：Cannot read properties of undefined（最后一个工具 preview_page）');
  assert.equal(exitReason({ exit: null, rss: 1843 }), '没来得及记下原因（可能是被强行杀掉，或者内存不够被系统结束；最后记下的内存占用 1.8GB）');
  assert.equal(exitReason({ exit: null, rss: 512 }), '没来得及记下原因（可能是被强行杀掉，或者内存不够被系统结束；最后记下的内存占用 512MB）');
  assert.equal(exitReason({ exit: null, rss: null }), '没来得及记下原因（可能是被强行杀掉，或者内存不够被系统结束）');
});

test('记一行、读回来：只读记录末尾一截（几 MB 的记录也快），半行跳过；用量那一行带着内存', async () => {
  const ctx = ctxWith();
  await runTurn(ctx, '你好');
  const file = ctx.store.file(ctx.session.id);
  const usage = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'usage');
  assert.ok(Number.isFinite(usage.rss) && usage.rss > 0, '用量那一行要带 rss');
  assert.equal(lastExit(file).exit, null);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'message', message: { role: 'user', content: 'x'.repeat(3_000_000) } })}\n`);
  ctx.working = true; ctx.lastTool = 'shell';
  recordExit(ctx, { reason: 'signal', signal: 'SIGHUP' });
  const got = lastExit(file);
  assert.equal(got.exit.signal, 'SIGHUP');
  assert.equal(got.exit.working, true);
  assert.equal(got.exit.lastTool, 'shell');
  assert.ok(got.exit.rss > 0);
  assert.equal(lastExit(path.join(tmpdir(), 'nope.jsonl')).exit, null, '没有文件：当没有');
  const eph = { ...ctxWith(), session: { id: 'ephemeral-1' } };
  recordExit(eph, { reason: 'error', error: 'x' });   // 不写、不抛
});

test('装上：信号和未捕获的异常都先记再退（退出码照规矩）；卸下后不留监听', () => {
  const ctx = ctxWith();
  const before = { hup: process.listenerCount('SIGHUP'), term: process.listenerCount('SIGTERM'), ex: process.listenerCount('uncaughtException') };
  const exits = [];
  const errors = [];
  const off = installExitRecorder(ctx, { exit: (c) => exits.push(c), onError: (e) => errors.push(e.message) });
  process.emit('SIGHUP', 'SIGHUP');
  process.emit('SIGTERM', 'SIGTERM');
  off.handlers.exception(new Error('boom'));   // 测试运行器自己也听 uncaughtException，不能真 emit
  assert.ok(process.listenerCount('uncaughtException') > before.ex, '装上了异常的监听');
  off();
  assert.deepEqual(exits, [129, 143, 1]);
  assert.deepEqual(errors, ['boom'], '异常照旧打出来');
  const rows = fs.readFileSync(ctx.store.file(ctx.session.id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'exit');
  assert.deepEqual(rows.map((e) => e.signal || e.error), ['SIGHUP', 'SIGTERM', 'boom']);
  assert.deepEqual({ hup: process.listenerCount('SIGHUP'), term: process.listenerCount('SIGTERM'), ex: process.listenerCount('uncaughtException') }, before);
});

test('启动提示：没正常结束的说出原因，并记下「回车接着哪一段」', async () => {
  const root = tmpdir();
  const first = ctxWith(root);
  first.api.stream = async () => { throw new Error('模拟进程半路没了'); };
  await assert.rejects(runTurn(first, '做加油站模型'));
  first.lastTool = 'preview_page'; first.working = true;
  recordExit(first, { reason: 'signal', signal: 'SIGHUP' });
  const next = ctxWith(root);
  noteUnfinished(next);
  assert.match(next.ui.text(), /上一段会话「做加油站模型」没正常结束：终端被关掉了（SIGHUP），当时正在干活（最后一个工具 preview_page）[\s\S]*直接回车接着那一段/);
  assert.equal(next.pendingResume, first.session.id);
});

const py = spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status === 0;
test('真进程：干活时被 SIGTERM 结束 → 记录里有原因；下次交互启动说出原因，直接回车接上那一段', { skip: py ? false : '没有 python3（驱动终端用）', timeout: 60_000 }, async (t) => {
  const srv = await fakeServer(t, [{ hang: true }]);
  const root = tmpdir();
  const home = tmpdir();
  const env = { PATH: process.env.PATH, HOME: home, ZHIQU_HOME: path.join(home, '.zhiqu'), ZHIQU_TOKEN: 'zqp_x', ZHIQU_SERVER: srv.url, TERM: 'xterm-256color' };
  const bin = path.resolve('bin/zhiqu.js');
  // 第一段：模型那边一直不回（hang），等它真在等的时候 SIGTERM
  const child = spawn(process.execPath, [bin, '-p', '做一个加油站模型', '--mode', 'auto'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100 && srv.seen.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(srv.seen.length > 0, '第一段要真的在等模型');
  child.kill('SIGTERM');
  const code = await new Promise((r) => child.on('exit', (c, s) => r(c ?? s)));
  assert.equal(code, 143);
  const sessions = path.join(root, '.zhiqu', 'sessions');
  const file = fs.readdirSync(sessions).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(sessions, f))[0];
  const exit = lastExit(file).exit;
  assert.equal(exit && exit.signal, 'SIGTERM', '记录里要有退出原因');
  assert.equal(exit.working, true);
  // 第二段：交互启动（真终端），看提示、直接回车、再退出。换一个正常回答的服务器（第一段那个一直挂着）
  const srv2 = await fakeServer(t, [{ text: '好' }]);
  env.ZHIQU_SERVER = srv2.url;
  const driver = path.join(tmpdir(), 'drv.py');
  fs.writeFileSync(driver, [
    'import os, pty, sys, time, select',
    'pid, fd = pty.fork()',
    'if pid == 0:',
    '    os.chdir(sys.argv[1]); os.execv(sys.argv[3], [sys.argv[3], sys.argv[2], "--mode", "auto"])',
    'out = b""; end = time.time() + 20; sent = False; done = False',
    'while time.time() < end:',
    '    r, _, _ = select.select([fd], [], [], 0.2)',
    '    if r:',
    '        try: c = os.read(fd, 65536)',
    '        except OSError: break',
    '        if not c: break',
    '        out += c',
    '    if not sent and "直接回车".encode() in out:',
    '        time.sleep(0.5); os.write(fd, b"\\r"); sent = True',
    '    if sent and not done and "这段会话（".encode() in out:',
    '        time.sleep(0.3); os.write(fd, b"/exit\\r"); done = True; end = time.time() + 3',
    'try: os.kill(pid, 9)',
    'except Exception: pass',
    'sys.stdout.write(out.decode("utf8", "replace"))',
  ].join('\n'));
  // 异步起：spawnSync 会把这个进程的事件循环堵住，假服务器就在这个进程里，CLI 连它会一直等
  const drv = spawn('python3', [driver, root, bin, process.execPath], { env: { ...env, COLUMNS: '140', LINES: '40' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  drv.stdout.on('data', (d) => { stdout += d; });
  drv.stderr.on('data', (d) => { stderr += d; });
  await new Promise((r) => drv.on('close', r));
  if (!stdout) assert.fail(`驱动没输出：${stderr.slice(-1500)}`);
  const screen = stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  assert.match(screen, /没正常结束：进程被结束了（SIGTERM），当时正在干活/, screen.slice(-1500));
  assert.match(screen, /接着「做一个加油站模型」这段会话/, `直接回车要接上那一段：${screen.slice(-1500)}`);
});
