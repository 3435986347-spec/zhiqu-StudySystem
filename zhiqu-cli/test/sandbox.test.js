// 系统沙箱（第一百零九轮）：真进程、真沙箱。断言落在「系统真的挡住了」：文件没出现、内容没读到、连接没通。
// 没有系统沙箱的机器（Windows、没装 bubblewrap 的 Linux）这个文件显式跳过：不是通过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runTurn, toolset } from '../src/agent.js';
import { runProcess } from '../src/tools/exec.js';
import { LocalTools, shellOutcome } from '../src/tools/local.js';
import { DraftTools } from '../src/tools/drafts.js';
import { detectSandbox, gitReadRoots, looksBlocked, plainLaunch, READ_ONLY, sandboxedLaunch, toolchainRoots, WORKSPACE_WRITE } from '../src/tools/sandbox.js';
import { environmentBlock } from '../src/prompt.js';
import { resolveSettings } from '../src/config.js';
import { SessionStore } from '../src/session.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

const box = detectSandbox();
// 跳过要写明：探测一坏就全部跳过、看着和通过一样（扰动「探测总说没有」时这个文件整个是绿的）。
// macOS 一定有 sandbox-exec，探测说没有就是探测坏了；真的跑在另一层沙箱里（嵌套起不来）写 ZHIQU_SKIP_SANDBOX_TESTS=1
const allowedToSkip = process.env.ZHIQU_SKIP_SANDBOX_TESTS === '1' || process.platform !== 'darwin';
const skip = box ? false : '这台机器没有系统沙箱：这些判据没有跑';

test('macOS 上探测得到沙箱（不然下面的真判据全部跳过）', { skip: allowedToSkip ? '不是 macOS，或者写明了跳过' : false }, () => {
  assert.ok(box, '探测说没有：检查 detectSandbox');
  assert.equal(box.kind, 'seatbelt');
});
const realTmp = () => fs.realpathSync(tmpdir());

/** 一个工作区 + 一个假的家目录（不碰用户真的 ~/.ssh） */
function rig({ policy = WORKSPACE_WRITE, network = 'off', env = {} } = {}) {
  const root = realTmp();
  const home = realTmp();
  const priv = realTmp();
  const tool = path.join(home, '.mytool', 'bin');
  fs.mkdirSync(tool, { recursive: true });
  fs.writeFileSync(path.join(home, '.mytool', 'lib.txt'), '工具链的库');
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'SECRET-KEY');
  fs.mkdirSync(path.join(home, '.zhiqu'));
  fs.writeFileSync(path.join(home, '.zhiqu', 'config.json'), '{"token":"SECRET-TOKEN"}');
  fs.mkdirSync(path.join(home, '.cargo', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cargo', 'credentials.toml'), 'SECRET-CARGO');
  fs.writeFileSync(path.join(home, 'notes.txt'), 'SECRET-NOTES');
  const fullEnv = { PATH: `${tool}:${path.join(home, '.cargo', 'bin')}:${process.env.PATH}`, ZHIQU_TOKEN: 'SECRET-ENV', ...env };
  const run = async (command, opts = {}) => {
    const launch = sandboxedLaunch(box, { command, root, cwd: root, policy: opts.policy || policy, network: opts.network || network, home, env: fullEnv, privateDir: priv });
    return runProcess({ binary: launch.binary, args: launch.args, cwd: root, env: launch.env, timeoutMs: 30_000 });
  };
  return { root, home, priv, run };
}

test('沙箱探测是真跑一次，不只看文件在不在：起不来就当没有', { skip }, () => {
  assert.equal(detectSandbox({ platform: 'win32' }), null, 'Windows 没有沙箱');
  assert.equal(detectSandbox({ platform: 'linux', env: { PATH: '/nonexistent' } }), null, 'Linux 没有 bwrap');
  assert.ok(['seatbelt', 'bwrap'].includes(box.kind));
  // 嵌套沙箱、用户命名空间被关时文件都在，只是跑不起来：照样要算没有。拿一个总是失败的 bwrap 试
  const dir = realTmp();
  fs.writeFileSync(path.join(dir, 'bwrap'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal(detectSandbox({ platform: 'linux', env: { PATH: dir } }), null, '起不来的沙箱不能算有');
  fs.writeFileSync(path.join(dir, 'bwrap'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(detectSandbox({ platform: 'linux', env: { PATH: dir } }).kind, 'bwrap', '对照：跑得起来的要算有');
});

test('shell 该能做的：管道、重定向、&&、写工作区、写临时目录', { skip }, async () => {
  const { root, run } = rig();
  const r = await run('printf "a\\nb\\n" | grep b && echo 写了 > out.txt && cat out.txt && echo x > "$TMPDIR/t" && cat "$TMPDIR/t"');
  assert.equal(r.exitCode, 0, r.output);
  assert.match(r.output, /b\n写了\nx/);
  assert.equal(fs.readFileSync(path.join(root, 'out.txt'), 'utf8'), '写了\n');
});

test('后台进程随命令结束；输出一个字不丢；退出码不变（命令行原来要等后台进程结束才回话）', { skip }, async () => {
  const { root, run } = rig();
  const t0 = Date.now();
  const r = await run('sleep 30 & echo $! > pid; echo started; exit 7');
  assert.equal(r.exitCode, 7, r.output);
  assert.match(r.output, /started/);
  assert.doesNotMatch(r.output, /Terminated/, 'bash 收后台进程时那一行不该进输出：模型会以为出了事');
  assert.ok(Date.now() - t0 < 5000, `等了后台进程：${Date.now() - t0}ms`);
  const pid = Number(fs.readFileSync(path.join(root, 'pid'), 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, '后台进程还活着');
});

test('写不出工作区：别处、/tmp、顺着软链都不行', { skip }, async () => {
  const { root, home, run } = rig();
  const outside = path.join(home, 'escaped');
  const inTmp = path.join('/tmp', `zq-sandbox-${process.pid}`);
  const r = await run(`echo x > ${outside}; echo x > ${inTmp}; ln -s ${home} link; echo x > link/escaped2; echo done`);
  assert.match(r.output, /done/, '命令要跑到最后，证明是每一句被挡，不是根本没跑');
  assert.equal(fs.existsSync(outside), false, '写到工作区外了');
  assert.equal(fs.existsSync(inTmp), false, '写到 /tmp 了');
  assert.equal(fs.existsSync(path.join(home, 'escaped2')), false, '顺着软链写出去了');
  assert.ok(fs.lstatSync(path.join(root, 'link')).isSymbolicLink(), '工作区里建软链本身是可以的');
});

test('.git 和 .zhiqu 不能写：写一个 hook、改一下设置，下次就跑到沙箱外面去了', { skip }, async () => {
  const { root, run } = rig();
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  const r = await run('echo x > .git/hooks/pre-commit; mkdir -p .zhiqu; echo x > .zhiqu/settings.json; mkdir .git-test && echo 旁边的可以 > .git-test/a; echo done');
  assert.match(r.output, /done/);
  assert.equal(fs.existsSync(path.join(root, '.git', 'hooks', 'pre-commit')), false, '写进 hook 了');
  assert.equal(fs.existsSync(path.join(root, '.zhiqu')), false, '建出 .zhiqu 了');
  assert.equal(fs.readFileSync(path.join(root, '.git-test', 'a'), 'utf8'), '旁边的可以\n', '名字像 .git 的目录不该被连带挡住');
});

test('读不到家目录：密钥、令牌、别的文件；工具链读得到，工具链旁边的凭据读不到', { skip }, async () => {
  const { home, run } = rig();
  const r = await run(`for f in .ssh/id_rsa .zhiqu/config.json notes.txt .cargo/credentials.toml; do cat ${home}/$f; done; ls ${home}; cat ${home}/.mytool/lib.txt; echo done`);
  assert.match(r.output, /done/);
  assert.doesNotMatch(r.output, /SECRET/, '读到了不该读的');
  assert.doesNotMatch(r.output, /notes\.txt\n/, '列出了家目录');
  assert.match(r.output, /工具链的库/, 'PATH 里的工具链（连同它的 lib）要读得到，不然命令跑不起来');
});

test('读得到工作区里的 git：工作区是子目录、是 worktree 都行', { skip }, () => {
  const top = realTmp();
  fs.mkdirSync(path.join(top, '.git'));
  fs.mkdirSync(path.join(top, 'sub'));
  assert.deepEqual(gitReadRoots(path.join(top, 'sub')), [path.join(top, '.git')]);
  const wt = realTmp();
  const gitdir = path.join(top, '.git', 'worktrees', 'w');
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
  assert.deepEqual(gitReadRoots(wt), [gitdir, path.join(top, '.git')]);
  assert.deepEqual(toolchainRoots({ home: realTmp(), env: { PATH: '/usr/bin' } }), [], '家目录外的 PATH 不算');
});

test('断网：外网、本机、Unix socket 都连不上；用户放开 local / on 才通', { skip }, async (t) => {
  const server = http.createServer((req, res) => res.end('通了'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const socketPath = path.join(fs.realpathSync(os.tmpdir()), `zq-sock-${process.pid}`);
  const unix = http.createServer((req, res) => res.end('通了'));
  await new Promise((resolve) => unix.listen(socketPath, resolve));
  t.after(() => unix.close());
  const script = (target) => `node -e "require('http').get(${target},(r)=>{r.on('data',(d)=>console.log(String(d)))}).on('error',(e)=>{console.log('连不上',e.code);})"`;
  const loopback = `{host:'127.0.0.1',port:${port}}`;
  const off = rig();
  assert.match((await off.run(script(loopback))).output, /连不上/, '默认连本机也不行：本机的数据库可能没有密码');
  assert.doesNotMatch((await off.run(script(`{socketPath:'${socketPath}'}`))).output, /通了/, 'Docker 的 socket 就是这种');
  if (box.kind === 'seatbelt') {
    assert.match((await off.run(script(loopback), { network: 'local' })).output, /通了/, '用户放开 local');
  }
  assert.match((await off.run(script(loopback), { network: 'on' })).output, /通了/, '用户放开 on');
});

test('只读（plan 档）：工作区一个字都写不了，读得到；临时目录能写', { skip }, async () => {
  const { root, run } = rig({ policy: READ_ONLY });
  fs.writeFileSync(path.join(root, 'a.txt'), '原文');
  const r = await run('cat a.txt; echo 改了 > a.txt; echo x > new.txt; rm a.txt; echo y > "$TMPDIR/t" && cat "$TMPDIR/t"; echo done');
  assert.match(r.output, /原文/);
  assert.match(r.output, /y\ndone/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), '原文');
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
});

test('命令看不到令牌，HOME 不是真家目录', { skip }, async () => {
  const { home, run } = rig();
  const r = await run('env');
  assert.doesNotMatch(r.output, /SECRET-ENV|ZHIQU_TOKEN/);
  assert.doesNotMatch(r.output, new RegExp(`^HOME=${home}$`, 'm'));
  const plain = plainLaunch({ command: 'env', home, env: { PATH: process.env.PATH, ZHIQU_TOKEN: 'SECRET-ENV' }, privateDir: realTmp() });
  assert.equal(plain.env.ZHIQU_TOKEN, undefined, '不带沙箱再跑一次，令牌照样不给');
  if (process.platform === 'darwin') assert.match(plain.env.JAVA_TOOL_OPTIONS, /java\.io\.tmpdir=.*\/tmp$/, 'Java 的临时目录不听 TMPDIR');
});

test('路径里有空格和引号：参数不拼进沙箱规则', { skip }, async () => {
  const parent = realTmp();
  const root = path.join(parent, 'a b"c\'d');
  fs.mkdirSync(root);
  const priv = realTmp();
  const launch = sandboxedLaunch(box, { command: 'echo ok > f.txt; echo x > ../outside.txt; cat f.txt', root, cwd: root, home: realTmp(), env: { PATH: process.env.PATH }, privateDir: priv });
  const r = await runProcess({ binary: launch.binary, args: launch.args, cwd: root, env: launch.env, timeoutMs: 30_000 });
  assert.match(r.output, /ok/, r.output);
  assert.equal(fs.existsSync(path.join(parent, 'outside.txt')), false);
});

test('macOS：系统服务这条路也堵上（open、osascript、launchctl、剪贴板、defaults、lsof、杀别的进程）', { skip: box && box.kind === 'seatbelt' ? false : '只有 macOS 有这些' }, async () => {
  const { root, home, run } = rig();
  const escaped = path.join(home, 'launchd-escaped');
  const plist = `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>zq.sandbox.test.${process.pid}</string><key>ProgramArguments</key><array><string>/usr/bin/touch</string><string>${escaped}</string></array><key>RunAtLoad</key><true/></dict></plist>`;
  // 活的靶子（第一版用 sleep 30 带个多余参数，一启动就退出了，读不到别的进程被算成「挡住了」）：sh -c 后面还有命令，sh 就一直在，命令行里有秘密
  const victim = spawn('/bin/sh', ['-c', 'sleep 30; echo ZQARGSECRET'], { stdio: 'ignore' });
  try {
    const peek = `
import ctypes
b=ctypes.create_string_buffer(4096)
print('pidpath='+str(ctypes.CDLL('/usr/lib/libproc.dylib').proc_pidpath(${victim.pid},b,4096)))
m=(ctypes.c_int*3)(1,49,${victim.pid}); n=ctypes.c_size_t(262144); a=ctypes.create_string_buffer(262144)
r=ctypes.CDLL(None).sysctl(m,3,a,ctypes.byref(n),None,0)
print('procargs='+str(r)+' secret='+str(r==0 and b'ZQARGSECRET' in a.raw[:n.value]))
`;
    fs.writeFileSync(path.join(root, 'peek.py'), peek);
    const control = spawnSync('python3', ['peek.py'], { cwd: root, encoding: 'utf8' });
    assert.match(control.stdout, /secret=True/, `对照：沙箱外要读得到，不然下面的「读不到」什么都没证明：${control.stdout}${control.stderr}`);
    const r = await run(`
      lsappinfo list 2>&1 | wc -l | tr -d ' ' | sed 's/^/lsappinfo=/'
      osascript -e 'tell application "System Events" to get name of current user' >/dev/null 2>&1; echo osa=$?
      pbcopy < /dev/null 2>/dev/null; echo pbcopy=$?
      defaults read com.apple.dock 2>/dev/null | wc -l | tr -d ' ' | sed 's/^/defaults=/'
      launchctl print gui/$(id -u) >/dev/null 2>&1; echo launchctl=$?
      kill -9 ${victim.pid} 2>/dev/null; echo kill=$?
      lsof -nP 2>/dev/null | awk 'NR>1{print $2}' | sort -u | grep -c "^${victim.pid}$" | sed 's/^/lsofvictim=/'
      python3 peek.py
      git --version 2>&1 | grep -c "cache file" | sed 's/^/xcrun=/'
      mktemp >/dev/null 2>&1; echo mktemp=$?
      echo '${plist}' > p.plist; /bin/launchctl bootstrap gui/$(id -u) p.plist >/dev/null 2>&1; echo boot=$?
      echo done`);
    assert.match(r.output, /done/, r.output);
    assert.match(r.output, /lsappinfo=0/, r.output);
    for (const name of ['osa', 'pbcopy', 'launchctl', 'kill', 'boot']) {
      assert.doesNotMatch(r.output, new RegExp(`^${name}=0$`, 'm'), `${name} 没被挡：\n${r.output}`);
    }
    assert.match(r.output, /defaults=[0-9]$/m, `defaults 读到了偏好设置：\n${r.output}`);
    assert.doesNotMatch(r.output, /^pidpath=[1-9]/m, `看得到别的进程：\n${r.output}`);
    assert.match(r.output, /^procargs=-1 secret=False$/m, `读得到别的进程的命令行（令牌常在那里）：\n${r.output}`);
    assert.match(r.output, /^lsofvictim=0$/m, `lsof 看得到别的进程：\n${r.output}`);
    assert.match(r.output, /^xcrun=0$/m, `git、python3、clang 每次多报一行错：\n${r.output}`);
    assert.match(r.output, /^mktemp=0$/m, `mktemp 不听 TMPDIR，要放它：\n${r.output}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(victim.exitCode === null && victim.signalCode === null, true, '杀掉了沙箱外的进程');
    assert.equal(fs.existsSync(escaped), false, '借 launchd 跑到沙箱外了');
  } finally {
    victim.kill();
  }
});

test('成功的命令不说被挡（输出里碰巧有 Permission denied）；不在沙箱里跑的也不说', () => {
  const prep = { command: 'x', cwdRel: '.' };
  const denied = 'cat: a: Permission denied';
  assert.equal(shellOutcome(prep, { exitCode: 0, output: denied, millis: 1 }).blocked, false);
  assert.equal(shellOutcome(prep, { exitCode: 1, output: denied, millis: 1 }).blocked, true);
  assert.equal(shellOutcome(prep, { exitCode: 1, output: denied, millis: 1 }, { sandboxed: false }).blocked, false);
  assert.doesNotMatch(shellOutcome(prep, { exitCode: 0, output: denied, millis: 1 }).content, /沙箱/);
});

test('被挡住的样子认得出；猜错了也只是多问一句', () => {
  for (const text of ['bash: /x: Operation not permitted', 'PermissionError: [Errno 1] Operation not permitted', 'curl: (6) Could not resolve host: a.com', 'Error: connect EPERM 1.1.1.1:53', 'getaddrinfo ENOTFOUND a.com', 'Read-only file system']) {
    assert.equal(looksBlocked(text), true, text);
  }
  // Linux 上家目录、/tmp 在沙箱里是空的；JVM 附加到自己被挡（不放：连得上自己的 socket 就连得上别的 JVM 的）
  for (const text of ['bash: /tmp/x/out.txt: No such file or directory', "FileNotFoundError: [Errno 2] No such file or directory: '/home/a/b'", 'Could not initialize inline Byte Buddy mock maker.']) {
    assert.equal(looksBlocked(text), true, text);
  }
  for (const text of ['AssertionError: 1 != 2', 'SyntaxError: invalid syntax', 'cat: a.txt: No such file or directory', '']) assert.equal(looksBlocked(text), false, text);
});

test('Linux 的 bubblewrap：断网、挡住还没有的 .git / .zhiqu、跑完收掉占位（这台机器不是 Linux 也看得到参数；真跑在容器里验过）', () => {
  const root = realTmp();
  const priv = realTmp();
  const secretHome = realTmp();
  fs.mkdirSync(path.join(root, '.zhiqu'));
  fs.mkdirSync(path.join(secretHome, '.ssh'));
  const launch = sandboxedLaunch({ kind: 'bwrap', binary: '/x/bwrap' }, { command: 'true', root, cwd: root, home: secretHome, env: { PATH: '/usr/bin' }, privateDir: priv });
  assert.equal(launch.binary, '/bin/sh', '有要占位的路径：外面包一层收尾');
  const line = launch.args.join(' ');
  assert.match(line, /--unshare-all/);
  assert.doesNotMatch(line, /--share-net/, '默认断网');
  assert.ok(line.includes(`--ro-bind ${path.join(priv, 'empty')} ${path.join(root, '.git')}`), `没有的 .git 要占住：${line}`);
  assert.ok(line.includes(`--ro-bind ${path.join(root, '.zhiqu')} ${path.join(root, '.zhiqu')}`), `已有的 .zhiqu 只读：${line}`);
  assert.ok(launch.args[1].includes(`rmdir '${path.join(root, '.git')}'`), '跑完要收掉占位');
  assert.ok(launch.args[1].indexOf('.zhiqu') === -1, '已有的不能收');
  assert.ok(line.includes(`--ro-bind /dev/null ${path.join(secretHome, '.ssh')}`), '密钥再挡一遍');
  fs.mkdirSync(path.join(root, '.git'));
  const plain = sandboxedLaunch({ kind: 'bwrap', binary: '/x/bwrap' }, { command: 'true', root, cwd: root, home: secretHome, env: { PATH: '/usr/bin' }, privateDir: priv });
  assert.equal(plain.binary, '/x/bwrap', '都有就不用包');
  const ro = sandboxedLaunch({ kind: 'bwrap', binary: '/x/bwrap' }, { command: 'true', root: realTmp(), cwd: realTmp(), policy: READ_ONLY, network: 'on', home: secretHome, env: { PATH: '/usr/bin' }, privateDir: priv });
  assert.equal(ro.binary, '/x/bwrap', '只读的不用占位');
  assert.match(ro.args.join(' '), /--share-net/, '用户放开才共享网络');
  const typo = sandboxedLaunch({ kind: 'bwrap', binary: '/x/bwrap' }, { command: 'true', root, cwd: root, network: '乱写的', home: secretHome, env: { PATH: '/usr/bin' }, privateDir: priv });
  assert.doesNotMatch(typo.args.join(' '), /--share-net/, '写错一个字不能把网打开');
});

// ── 工具和档位 ──
function agentCtx({ mode = 'auto', replies, answers = [], sandbox = box, cwd } = {}) {
  const root = cwd || realTmp();
  const local = new LocalTools({ root, sandbox });
  const api = fakeApi(replies);
  const ui = fakeUi(answers);
  const store = new SessionStore(root);
  const ctx = { api, ui, root, mode, maxRounds: 10, local, store, session: store.create({ model: 'm' }), messages: [],
    allow: { write: false, run: false, delete: false, tasks: false, mcp: new Set() }, usage: { prompt: 0, completion: 0, cached: 0 }, changedFiles: new Set(), todos: [],
    system: { text: 'x' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], archiveDisabled: true, model: { id: 1, label: 'm', modelName: 'm', effectiveContextWindow: 100000 } };
  return { ctx, ui, root };
}
const names = (ctx) => toolset(ctx).map((t) => t.schema.function.name);
const toolResult = (ctx) => ctx.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');

test('工具清单：有沙箱给 shell、不给 run_command；没有沙箱退回 run_command；plan 档也有 shell（只读）', () => {
  const on = agentCtx({ sandbox: { kind: 'seatbelt', binary: '/x' } }).ctx;
  assert.ok(names(on).includes('shell'));
  assert.ok(!names(on).includes('run_command'));
  assert.ok(names({ ...on, mode: 'plan' }).includes('shell'));
  assert.ok(!names({ ...on, mode: 'plan' }).includes('write_file'));
  const off = agentCtx({ sandbox: null }).ctx;
  assert.ok(!names(off).includes('shell'));
  assert.ok(names(off).includes('run_command'));
  assert.ok(!names({ ...off, mode: 'plan' }).includes('run_command'), '没有沙箱时 plan 档还是不能跑命令');
});

test('网页的工具清单由后端的门决定：canShell 才有 shell，同一份清单', () => {
  const draft = (opts) => ({ ...agentCtx({ sandbox: null }).ctx, local: new DraftTools({ root: realTmp(), exec: async () => ({}), ...opts }) });
  assert.deepEqual(names(draft({ canShell: true })).filter((n) => ['shell', 'run_command'].includes(n)), ['shell']);
  assert.deepEqual(names(draft({ canExec: true, commands: ['node'] })).filter((n) => ['shell', 'run_command'].includes(n)), ['run_command']);
  assert.deepEqual(names(draft({})).filter((n) => ['shell', 'run_command'].includes(n)), []);
  assert.deepEqual(names(draft({ canShell: true, canExec: true })).filter((n) => ['shell', 'run_command'].includes(n)), ['shell'], '有 shell 就不再给白名单');
});

test('auto 档：不问就跑，写得了工作区；被挡住只告诉模型', { skip }, async () => {
  const { ctx, ui, root } = agentCtx({ mode: 'auto', replies: [
    { calls: [{ name: 'shell', args: { command: 'echo hi > a.txt && cat a.txt' } }] },
    { calls: [{ name: 'shell', args: { command: 'echo x > /usr/zq-blocked-auto' } }] },
    { text: '好了' }] });
  await runTurn(ctx, '干活');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hi\n');
  assert.doesNotMatch(ui.text(), /在系统沙箱里）？?|不带沙箱再跑/, 'auto 不问');
  assert.match(ui.text(), /运行 echo hi/, '不问，但照样打出来');
  assert.match(toolResult(ctx), /可能被系统沙箱挡住了/);
  assert.equal(fs.existsSync('/usr/zq-blocked-auto'), false);
});

test('plan 档：跑只读沙箱，写不了；不问', { skip }, async () => {
  const { ctx, root } = agentCtx({ mode: 'plan', replies: [
    { calls: [{ name: 'shell', args: { command: 'echo x > a.txt; ls | wc -l' } }] },
    { text: '计划' }] });
  await runTurn(ctx, '看看');
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false, 'plan 档写进工作区了');
  assert.match(toolResult(ctx), /退出码 0/);
});

test('ask 档：逐个问，说不就不跑；被挡住再问一次，点了才不带沙箱跑（默认不）', { skip }, async () => {
  const no = agentCtx({ mode: 'ask', answers: ['n'], replies: [{ calls: [{ name: 'shell', args: { command: 'echo x > a.txt' } }] }, { text: '好' }] });
  await runTurn(no.ctx, '干活');
  assert.equal(fs.existsSync(path.join(no.root, 'a.txt')), false, '用户说不，还是跑了');
  assert.match(no.ui.text(), /在系统沙箱里/, '要问');
  assert.match(toolResult(no.ctx), /用户没有同意运行/);

  const outsideDir = realTmp();
  const target = path.join(outsideDir, 'out.txt');
  const refuse = agentCtx({ mode: 'ask', answers: ['y', 'n'], replies: [{ calls: [{ name: 'shell', args: { command: `echo x > ${target}` } }] }, { text: '好' }] });
  await runTurn(refuse.ctx, '干活');
  assert.equal(fs.existsSync(target), false, '没点头就出了沙箱');

  const allow = agentCtx({ mode: 'ask', answers: ['y', 'y'], replies: [{ calls: [{ name: 'shell', args: { command: `echo x > ${target}` } }] }, { text: '好' }] });
  await runTurn(allow.ctx, '干活');
  assert.equal(fs.readFileSync(target, 'utf8'), 'x\n', '点了头要真的跑');

  // 「本会话都允许运行命令」只算沙箱里的：出沙箱还要问
  const target2 = path.join(outsideDir, 'out2.txt');
  const session = agentCtx({ mode: 'ask', answers: ['n'], replies: [{ calls: [{ name: 'shell', args: { command: `echo x > ${target2}` } }] }, { text: '好' }] });
  session.ctx.allow.run = true;
  await runTurn(session.ctx, '干活');
  assert.equal(fs.existsSync(target2), false, '「本会话都允许」不能带着命令出沙箱');
  assert.match(toolResult(session.ctx), /可能被系统沙箱挡住了/, '「本会话都允许」要真的不再问：第一个 n 该给出沙箱那一问');
});

test('没有沙箱时硬调 shell：拒绝，不跑（下发的和能执行的同一份清单）', async () => {
  const { ctx, root } = agentCtx({ mode: 'auto', sandbox: null, replies: [{ calls: [{ name: 'shell', args: { command: 'echo x > a.txt' } }] }, { text: '好' }] });
  await runTurn(ctx, '干活');
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
  assert.match(toolResult(ctx), /run_command/, '要告诉它该用什么');
});

test('模型叫 bash、sh 这些名字：有沙箱指到 shell，没有指到 run_command；都不执行', async () => {
  const on = agentCtx({ mode: 'auto', sandbox: { kind: 'seatbelt', binary: '/x' }, replies: [{ calls: [{ name: 'bash', args: { command: 'true' } }] }, { text: '好' }] });
  await runTurn(on.ctx, '干活');
  assert.match(toolResult(on.ctx), /shell/);
  assert.doesNotMatch(toolResult(on.ctx), /run_command/);
});

test('系统提示说边界：命令行和网页同一种说法；网页 auto 档说清 shell 写的不经过草稿', () => {
  const base = { root: '/r', workspaceName: 'r', mode: 'auto', commands: ['node'], today: '2026-11-07' };
  const cli = environmentBlock({ ...base, shell: '边界在这' });
  assert.match(cli, /边界在这/);
  assert.doesNotMatch(cli, /run_command/);
  assert.match(environmentBlock(base), /run_command/, '没有沙箱还是白名单那一句');
  const webWrite = environmentBlock({ ...base, draft: true, shell: '边界在这', shellWrites: true });
  assert.match(webWrite, /边界在这/);
  assert.match(webWrite, /不经过草稿/);
  assert.doesNotMatch(environmentBlock({ ...base, draft: true, shell: '边界在这', shellWrites: false }), /不经过草稿/, '只读的档不说这句');
  assert.doesNotMatch(webWrite, /run_command 能跑/);
});

test('网页的 shell 交回后端跑：带 shell: true；跑过才算跑过（判过题才给记薄弱点的工具）；被拒照实说；有草稿要说跑的是旧版本', async () => {
  const sent = [];
  let reply = { exitCode: 0, output: 'ok', millis: 5 };
  const root = realTmp();
  const local = new DraftTools({ root, canShell: true, shellWrite: true, canWrite: true, exec: async (req) => { sent.push(req); return reply; } });
  assert.equal(local.prepareShell({}).error.includes('没有给出'), true);
  const r = await local.commitShell(local.prepareShell({ command: 'npm test', cwd: 'sub' }));
  assert.deepEqual(sent[0], { shell: true, command: 'npm test', cwd: 'sub' });
  assert.equal(local.ranCommand, true);
  assert.match(r.content, /退出码 0/);

  reply = { exitCode: 1, output: 'bash: x: Operation not permitted', millis: 5 };
  assert.match((await local.commitShell(local.prepareShell({ command: 'x' }))).content, /只能|能写工作区/, '被挡住要把边界告诉模型');

  const refused = new DraftTools({ root, canShell: true, exec: async () => ({ error: '没有运行：系统沙箱起不来' }) });
  const no = await refused.commitShell(refused.prepareShell({ command: 'x' }));
  assert.equal(refused.ranCommand, undefined, '被拒不算跑过');
  assert.match(no.content, /没有运行/);
  assert.equal(no.exitCode, -1);

  local.drafts.set('a.py', { path: 'a.py' });
  reply = { exitCode: 0, output: 'ok', millis: 5 };
  assert.match((await local.commitShell(local.prepareShell({ command: 'y' }))).content, /a\.py.*旧版本/);
});

test('网络只认命令行参数和用户级配置：项目里的 .zhiqu/settings.json 不能给自己开网', () => {
  const root = realTmp();
  const zhiquHome = realTmp();
  const old = process.env.ZHIQU_HOME;
  process.env.ZHIQU_HOME = zhiquHome;
  try {
    fs.mkdirSync(path.join(root, '.zhiqu'));
    fs.writeFileSync(path.join(root, '.zhiqu', 'settings.json'), JSON.stringify({ sandboxNetwork: 'on' }));
    assert.equal(resolveSettings(root, {}).sandboxNetwork, 'off', '克隆下来的仓库给自己开了网');
    assert.equal(resolveSettings(root, { sandboxNetwork: 'local' }).sandboxNetwork, 'local');
    fs.writeFileSync(path.join(zhiquHome, 'config.json'), JSON.stringify({ sandboxNetwork: 'on' }));
    assert.equal(resolveSettings(root, {}).sandboxNetwork, 'on');
    assert.equal(resolveSettings(root, { sandboxNetwork: 'bad' }).sandboxNetwork, 'off', '坏值当没说');
  } finally {
    if (old === undefined) delete process.env.ZHIQU_HOME; else process.env.ZHIQU_HOME = old;
  }
});

test('真的 zhiqu -p：命令行把系统沙箱接上了（模型拿到 shell，命令真的关在沙箱里），--sandbox-network 坏值不收', { skip }, async (t) => {
  const seen = [];
  const home = realTmp();
  const root = realTmp();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const json = (v) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: v })); };
      if (req.url.startsWith('/api/harness/models')) return json({ models: [{ id: 1, label: 'm', modelName: 'm', toolCalling: true, effectiveContextWindow: 100000 }], defaultModelId: 1 });
      if (req.url.startsWith('/api/harness/me')) return json({ id: 1, username: 'u' });
      if (req.url.startsWith('/api/harness/tools')) return json([]);
      if (req.url.startsWith('/api/harness/model/stream')) {
        const body = JSON.parse(raw);
        seen.push(body);
        res.setHeader('Content-Type', 'text/event-stream');
        const send = (name, data) => res.write(`event:${name}\ndata:${JSON.stringify(data)}\n\n`);
        send('start', { contextWindow: 100000, droppedMessages: 0, elidedToolOutputs: 0 });
        const message = seen.length === 1
          ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: `echo 写了 > a.txt; echo x > ${home}/escaped; echo $ZHIQU_TOKEN | wc -c` }) } }] }
          : { role: 'assistant', content: '好了' };
        send('done', { message, finishReason: seen.length === 1 ? 'tool_calls' : 'stop', maxTokens: 16000, usage: { promptTokens: 1, completionTokens: 1, estimated: false } });
        return res.end();
      }
      return json({});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { PATH: process.env.PATH, HOME: home, ZHIQU_HOME: path.join(home, '.zhiqu'), ZHIQU_TOKEN: 'zqp_secret', ZHIQU_SERVER: `http://127.0.0.1:${server.address().port}` };
  const run = (args) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.resolve('bin/zhiqu.js'), ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  const r = await run(['-p', '干活', '--mode', 'auto']);
  assert.equal(r.code, 0, r.out);
  const tools = seen[0].tools.map((x) => x.function.name);
  assert.ok(tools.includes('shell'), `cli.js 没接上沙箱：${tools}`);
  assert.ok(!tools.includes('run_command'), `${tools}`);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), '写了\n');
  assert.equal(fs.existsSync(path.join(home, 'escaped')), false, '命令没关在沙箱里');
  const toolMessage = seen[1].messages.find((m) => m.role === 'tool').content;
  assert.match(toolMessage, /\n\s*1\n/, `令牌传进了命令的环境：${toolMessage}`);
  assert.match(seen[0].messages[0].content, /系统沙箱/, '系统提示要说边界');
  const bad = await run(['-p', '干活', '--sandbox-network', 'ultra']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /--sandbox-network 只接受/);
});
