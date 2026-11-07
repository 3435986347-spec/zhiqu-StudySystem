// 服务器上的沙箱（第一百一十七轮）：所有注册用户都能叫起的命令，跑在放着数据库和主密钥的机器上。
// 真进程、真 bubblewrap。没有它的机器（macOS）真判据显式跳过：不是通过。部署之后在真服务器上要再跑一遍。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { shellSchemas } from '../src/tools/local.js';
import { runProcess } from '../src/tools/exec.js';
import { describeBoundary, detectSandbox, READ_ONLY, sandboxedLaunch, WORKSPACE_WRITE } from '../src/tools/sandbox.js';
import { tmpdir } from './helpers.js';

const box = detectSandbox({ hosted: true });
const skip = box ? false : '这台机器没有能用的 bubblewrap（macOS、没装、AppArmor 拦着）：这些判据没有跑';
const FAKE = { kind: 'bwrap', binary: '/usr/bin/bwrap' };
const real = (p) => fs.realpathSync(p);
/** bwrap 真正收到的参数（放在文件里，第一百一十九轮）：只给没真跑的看，真跑时文件打开就删了 */
const bwrapArgv = (launch) => fs.readFileSync(launch.argsFile, 'utf8').split('\0').join(' ');

function rig() {
  const root = real(tmpdir('zhiqu-hosted-'));
  const priv = real(tmpdir('zhiqu-hosted-priv-'));
  // 外层故意带一个像密钥的环境变量：后端自己的环境里就有这些，--clearenv 要把它挡在外面
  const run = (command, { policy = WORKSPACE_WRITE, timeoutMs = 30_000, cwd = root } = {}) => {
    const launch = sandboxedLaunch(box, { hosted: true, command, root, cwd, policy, privateDir: priv });
    return runProcess({ binary: launch.binary, args: launch.args, cwd: root, env: { ...launch.env, ZHIQU_MASTER_KEY: 'SECRET-FROM-BACKEND-ENV' }, timeoutMs, outputLimit: 256 * 1024 });
  };
  return { root, priv, run };
}

// ── 哪儿都能跑的：参数的形状 ───────────────────────────────

test('参数：不绑根目录；断网、PID、用户命名空间都是必开（不用 --unshare-all 的「能开就开」）；不继承环境', () => {
  const root = real(tmpdir());
  const priv = real(tmpdir());
  const a = sandboxedLaunch(FAKE, { hosted: true, command: 'true', root, cwd: root, policy: WORKSPACE_WRITE, privateDir: priv });
  const args = bwrapArgv(a);
  assert.ok(!/--ro-bind \/ \//.test(args), '根目录不能绑进去');
  // 命令行上不能有真路径（1 号进程是 bwrap，里面读得到它的 /proc/1/cmdline），文件只有自己读得了
  assert.ok(!a.args.includes(root) && !a.args.some((x) => x.includes('--bind')), a.args.join(' '));
  assert.ok(a.args[1].includes('--args 3'), a.args[1]);
  assert.equal(fs.statSync(a.argsFile).mode & 0o077, 0, '参数文件别人读得到');
  assert.ok(!args.includes('--as-pid-1'), '不能让命令当 1 号进程：AppArmor 切配置时 pdeathsig 被清掉，外层一死里面就成了孤儿（只有真服务器上看得到）');
  for (const flag of ['--unshare-net', '--unshare-pid', '--unshare-user', '--disable-userns', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup', '--clearenv', '--new-session', '--die-with-parent', '--cap-drop ALL', '--remount-ro /', '--remount-ro /proc']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.ok(!args.includes('--unshare-all') && !args.includes('--share-net'));
  assert.ok(!/--(ro-)?bind(-try)? \/(home|root|var|run|etc|mnt|media|opt|srv|tmp)\b( |$)/.test(args), `绑了不该绑的：${args}`);
  assert.ok(args.includes(`--bind ${root} /work`));
  assert.deepEqual(Object.keys(a.env), ['PATH'], '外层也不带后端的环境');
});

test('参数：网络不听配置：写了 on 也是断的；只读档是 --ro-bind；工作目录换成 /work 下面；跳出工作区的回到 /work', () => {
  const root = real(tmpdir());
  fs.mkdirSync(path.join(root, 'sub'));
  const priv = real(tmpdir());
  const make = (o) => bwrapArgv(sandboxedLaunch(FAKE, { hosted: true, command: 'true', root, cwd: root, policy: WORKSPACE_WRITE, privateDir: priv, ...o }));
  assert.ok(make({ network: 'on' }).includes('--unshare-net') && !make({ network: 'on' }).includes('--share-net'));
  assert.ok(make({ policy: READ_ONLY }).includes(`--ro-bind ${root} /work`));
  assert.ok(make({ cwd: path.join(root, 'sub') }).includes('--chdir /work/sub'));
  assert.ok(make({ cwd: path.dirname(root) }).includes('--chdir /work '));
});

test('没有 bubblewrap 就不跑：不退回别的沙箱；macOS、Windows 探测不到', () => {
  const root = real(tmpdir());
  assert.throws(() => sandboxedLaunch({ kind: 'seatbelt', binary: '/usr/bin/sandbox-exec' }, { hosted: true, command: 'true', root, cwd: root, privateDir: real(tmpdir()) }), /bubblewrap/);
  assert.equal(detectSandbox({ hosted: true, platform: 'darwin' }), null);
  assert.equal(detectSandbox({ hosted: true, platform: 'win32' }), null);
  assert.equal(detectSandbox({ hosted: true, platform: 'linux', env: { PATH: '/nonexistent' } }), null);
});

test('探测是真跑一次，而且要看边界真的在：起不来算没有；起得来但没隔离也算没有（那种就不给 shell，只生成文件）', () => {
  const bin = real(tmpdir('zhiqu-fake-bwrap-'));
  const fake = path.join(bin, 'bwrap');
  const detect = () => detectSandbox({ hosted: true, platform: 'linux', env: { PATH: bin } });
  fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal(detect(), null, '起不来');
  // 假的 bwrap：什么隔离都不做，直接在外面跑后面那条命令。真的这样的话 /work 写不了、/home 还在
  fs.writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n', { mode: 0o755 });
  assert.equal(detect(), null, '没隔离也不算');
  assert.equal(detectSandbox({ hosted: true, platform: 'linux', env: { PATH: bin }, probe: false }).kind, 'bwrap', '不探测时只看在不在（真跑那条路用）');
});

test('给模型的说明：说清断网、60 秒、不能后台；工具里没有后台那两个，参数也不提', () => {
  const text = describeBoundary({ hosted: true });
  for (const word of ['不能联网', '60 秒', '不能起后台进程', '/work']) assert.ok(text.includes(word), word);
  assert.match(describeBoundary({ hosted: true, policy: READ_ONLY }), /工作区只读/);
  const tools = shellSchemas({ background: false });
  assert.deepEqual(tools.map((t) => t.function.name), ['shell']);
  assert.ok(!('background' in tools[0].function.parameters.properties));
  assert.deepEqual(shellSchemas().map((t) => t.function.name), ['shell', 'shell_output', 'shell_stop'], '本机的不变');
  assert.ok('background' in shellSchemas()[0].function.parameters.properties);
});

// ── 真跑：边界 ─────────────────────────────────────────────

test('该能做的：管道、写工作区、写 /tmp、用系统工具；工作目录是 /work；身份是假的', { skip }, async () => {
  const { root, run } = rig();
  const r = await run('echo hello | tr a-z A-Z > out.txt && cat out.txt && pwd && whoami && echo x > /tmp/t && cat /tmp/t && ls /usr/bin | head -n 1 > /dev/null && echo done');
  assert.equal(r.exitCode, 0, r.output);
  assert.match(r.output, /HELLO\n\/work\nsandbox\nx\ndone/);
  assert.equal(fs.readFileSync(path.join(root, 'out.txt'), 'utf8'), 'HELLO\n');
});

test('读不到：家目录、/root、/var、/run、真的 passwd、shadow、配置目录。这些路径在里面根本不存在', { skip }, async () => {
  const secretDir = real(tmpdir('zhiqu-hosted-secret-'));
  fs.writeFileSync(path.join(secretDir, 'application-prod.yml'), 'master-key: SECRET-MASTER-KEY');
  const { run } = rig();
  const home = os.homedir();
  const paths = ['/home', '/root', '/var', '/run', '/etc/shadow', '/etc/sudoers', '/etc/zhiqu', '/mnt', '/media', '/opt', '/srv', home, path.join(secretDir, 'application-prod.yml')];
  for (const p of paths) {
    const r = await run(`ls -la ${p}; cat ${p}`);
    assert.ok(!r.output.includes('SECRET'), `${p}：${r.output}`);
    assert.match(r.output, /No such file or directory/, `${p} 不该存在：${r.output}`);
  }
  const passwd = await run('cat /etc/passwd');
  assert.equal(passwd.output.trim(), 'sandbox:x:1000:1000::/tmp:/bin/bash', '真的 passwd 列着服务器上的账号');
  const etc = await run('ls /etc');
  assert.ok(!/shadow|sudoers|ssh|mysql|caddy/.test(etc.output), etc.output);
});

test('写不了：/usr、/etc、/bin、别的目录；临时目录之外什么都留不下', { skip }, async () => {
  const { run } = rig();
  for (const p of ['/usr/x', '/etc/x', '/etc/ld.so.preload', '/bin/x', '/x', '/lib/x', '/dev/x/y', '/proc/x', '/proc/self/oom_score_adj']) {
    const r = await run(`echo pwned > ${p}; echo code=$?`);
    assert.match(r.output, /code=[^0]/, `${p}：${r.output}`);
  }
});

test('断网：连本机的端口（MySQL、Redis 那种）、外网、元数据服务都不通；只有自己的回环', { skip }, async (t) => {
  const srv = http.createServer((_q, res) => res.end('reached'));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => srv.close());
  const { run } = rig();
  const port = srv.address().port;
  // 对照：外面确实连得上
  const control = spawnSync('bash', ['-c', `exec 3<>/dev/tcp/127.0.0.1/${port} && echo connected`], { encoding: 'utf8' });
  assert.match(control.stdout, /connected/, '对照没有连上');
  for (const target of [`127.0.0.1/${port}`, '169.254.0.23/80', '169.254.169.254/80', '1.1.1.1/53']) {
    const r = await run(`(exec 3<>/dev/tcp/${target}) 2>/dev/null && echo CONNECTED || echo refused`, { timeoutMs: 10_000 });
    assert.ok(!r.output.includes('CONNECTED'), `${target}：${r.output}`);
  }
  const routes = await run('cat /proc/net/route | wc -l; ls /sys 2>&1 | head -n 1');
  assert.match(routes.output, /^1\n/, `不该有路由：${routes.output}`);
});

test('1 号进程是 bwrap（不是命令：不然外层一死里面的进程就成了孤儿）：它的命令行没有真路径，环境是空的，读参数的描述符关了，文件也删了', { skip }, async () => {
  const { root, priv, run } = rig();
  const r = await run('tr "\\0" " " < /proc/1/cmdline; echo; echo "env=[$(tr "\\0" " " < /proc/1/environ)]"; [ -e /proc/1/fd/3 ] && echo fd3-open-in-1; [ -e /proc/$$/fd/3 ] && echo fd3-open; echo pid=$$');
  assert.match(r.output, /bwrap --args 3 -- /, r.output);
  assert.ok(!r.output.includes(root) && !r.output.includes(priv), `真路径露出来了：${r.output}`);
  assert.ok(!r.output.includes('SECRET'), `调用方的环境进了 1 号进程：${r.output}`);
  assert.match(r.output, /env=\[(PATH=\/usr\/bin:\/bin )?\]/, r.output);
  assert.ok(!/^fd3-open/m.test(r.output), r.output);   // 按行首认：1 号进程的命令行里本来就带着这条命令的原文
  assert.ok(!/pid=1\b/.test(r.output), `命令成了 1 号进程：${r.output}`);
  assert.deepEqual(fs.readdirSync(priv).filter((f) => f.startsWith('hosted-args-')), [], '参数文件留下了');
});

test('外层被单独杀掉（内存不够时 OOM 可能只杀它）：里面的进程一个不留', { skip, timeout: 30_000 }, async () => {
  const { root, priv } = rig();
  const mark = `sleep 3${Date.now() % 100000}`;
  const launch = sandboxedLaunch(box, { hosted: true, command: `(${mark} &) ; ${mark}`, root, cwd: root, policy: WORKSPACE_WRITE, privateDir: priv });
  const child = spawn(launch.binary, launch.args, { cwd: root, env: launch.env, stdio: 'ignore', detached: true });
  const alive = () => spawnSync('pgrep', ['-f', mark], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
    .filter((pid) => { try { return !fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('pgrep'); } catch { return false; } });
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.ok(alive().length >= 2, '命令没跑起来：这条判据没看到东西');
  child.kill('SIGKILL');   // 只杀外层这一个进程，不是整组
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.deepEqual(alive(), [], '外层死了里面还活着');
});

test('看不到别的进程：PID 命名空间；读不到后端的环境变量和命令行', { skip }, async () => {
  const { run } = rig();
  const r = await run('ls /proc | grep -E "^[0-9]+$" | wc -l; cat /proc/1/cmdline | tr "\\0" " "; env | sort');
  const count = Number(r.output.split('\n')[0]);
  assert.ok(count < 10, `看得到 ${count} 个进程：${r.output}`);
  assert.ok(!r.output.includes('node') && !r.output.includes('test/sandbox-hosted'), r.output);
  assert.ok(!r.output.includes('--bind') && !r.output.includes('--unshare'), `1 号进程露出了 bwrap 的参数（服务器上的真路径）：${r.output}`);
  assert.ok(!/ZHIQU|TOKEN|SECRET|PASSWORD|JWT|MASTER/i.test(r.output), `环境变量漏进去了：${r.output}`);
  assert.match(r.output, /HOME=\/tmp/);
});

test('看不到外面的进程间通信：外面建的 System V 消息队列，里面看不见', { skip }, async () => {
  const made = spawnSync('ipcmk', ['-Q'], { encoding: 'utf8' });
  assert.equal(made.status, 0, `对照没建起来：${made.stderr}`);
  const id = /(\d+)/.exec(made.stdout)[1];
  try {
    assert.match(spawnSync('ipcs', ['-q'], { encoding: 'utf8' }).stdout, new RegExp(`\\b${id}\\b`), '对照：外面看得见');
    const { run } = rig();
    const inside = await run('ipcs -q');
    assert.ok(!new RegExp(`\\b${id}\\b`).test(inside.output), inside.output);
  } finally {
    spawnSync('ipcrm', ['-q', id]);
  }
});

test('cgroup 也是自己的：看不到外面的路径（服务叫什么、在哪个分组）', { skip }, async () => {
  const { run } = rig();
  const r = await run('cat /proc/self/cgroup');
  assert.match(r.output.trim(), /^0::\/$/, `看到了外面的 cgroup 路径：${r.output}`);
});

test('出不去：不能提权（no_new_privs，suid 无效）、不能再建命名空间、不能挂载、没有能力', { skip }, async () => {
  const { run } = rig();
  const r = await run([
    'grep -E "NoNewPrivs|CapEff" /proc/self/status',
    'unshare -U true 2>&1 | head -n 1; echo unshare=${PIPESTATUS[0]}',
    'mount -t tmpfs x /tmp 2>&1 | head -n 1; echo mount=${PIPESTATUS[0]}',
    'sudo -n true 2>&1 | head -n 1; echo sudo=${PIPESTATUS[0]}',
    'su -c true 2>&1 </dev/null | head -n 1; echo su=${PIPESTATUS[0]}',
  ].join('; '));
  assert.match(r.output, /NoNewPrivs:\s+1/, r.output);
  assert.match(r.output, /CapEff:\s+0+\n/, r.output);
  for (const name of ['unshare', 'mount', 'sudo', 'su']) assert.match(r.output, new RegExp(`${name}=[1-9]`), `${name}：${r.output}`);
});

test('工作区里的软链也走不出去：链到外面只是一个断的链', { skip }, async () => {
  const outside = real(tmpdir('zhiqu-hosted-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET-OUTSIDE');
  const { root, run } = rig();
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  const r = await run('cat link.txt; ls -la /work/link.txt');
  assert.ok(!r.output.includes('SECRET'), r.output);
});

test('常用的东西还要能用：python、管道里的多进程、后台进程随命令结束、输出不丢', { skip }, async () => {
  const { root, run } = rig();
  const py = await run(`python3 -c "import json,os,sys; print(json.dumps({'cwd': os.getcwd(), 'uid': os.getuid()}))"`);
  assert.equal(py.exitCode, 0, py.output);
  assert.match(py.output, /"cwd": "\/work", "uid": 1000/);
  const many = await run('seq 1 20000 | sort -n | tail -n 1; (sleep 100 &) ; sleep 200 & echo background-started');
  assert.match(many.output, /20000\nbackground-started/);
  assert.equal(many.timedOut, false, '后台进程不该让命令一直不回');
  fs.mkdirSync(path.join(root, 'sub'));
  const sub = await run('pwd', { cwd: path.join(root, 'sub') });
  assert.equal(sub.output.trim(), '/work/sub');
  const code = await run('exit 7');
  assert.equal(code.exitCode, 7, '退出码要带回来');
  const big = await run('head -c 3000000 /dev/zero | tr "\\0" a; echo; echo end');
  assert.ok(big.truncated, '输出太多要如实标截断');
});

test('只读档：工作区写不了，读得到；/tmp 能写', { skip }, async () => {
  const { root, run } = rig();
  fs.writeFileSync(path.join(root, 'a.txt'), '原来的');
  const r = await run('cat a.txt; echo pwned > a.txt; echo code=$?; echo x > new.txt; echo code2=$?; echo y > /tmp/y && echo tmp-ok', { policy: READ_ONLY });
  assert.match(r.output, /原来的/);
  assert.match(r.output, /code=[^0]/);
  assert.match(r.output, /code2=[^0]/);
  assert.match(r.output, /tmp-ok/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), '原来的');
  assert.ok(!fs.existsSync(path.join(root, 'new.txt')));
});

// ── 真跑：资源 ─────────────────────────────────────────────

test('限额真的设上了：优先级最低、内存不够先杀它、进程数、文件大小、CPU、打开文件数，里面调不回去', { skip }, async () => {
  const { run } = rig();
  const r = await run('nice; cat /proc/self/oom_score_adj; ulimit -u; ulimit -f; ulimit -t; ulimit -n; ulimit -c; echo 0 > /proc/self/oom_score_adj; echo lower=$?; ulimit -u 99999; echo raise=$?');
  const lines = r.output.trim().split('\n');
  assert.deepEqual(lines.slice(0, 7), ['19', '1000', '128', '65536', '90', '256', '0'], r.output);
  assert.match(r.output, /lower=[^0]/, 'oom_score_adj 调得回去');
  assert.match(r.output, /raise=[^0]/, '进程数上限调得上去');
  // core 要看硬上限：Ubuntu 的 core_pattern 是管道（apport 以 root 在外面跑），里面能把软上限调高就能叫起它
  const core = await run('ulimit -Hc; ulimit -c unlimited; echo core=$?');
  assert.match(core.output, /^0\n/, `core 的硬上限不是 0：${core.output}`);
  assert.match(core.output, /core=[^0]/, 'core 上限调得上去');
});

test('fork 炸弹：撞到上限，后面的命令照样能跑（挡的是它自己，不是整台机器）', { skip, timeout: 60_000 }, async () => {
  const { run } = rig();
  // 先确认上限真的设上了才引爆。第一百一十七轮扰动掉上限跑过一次，把整个 Docker 虚拟机拖死了：这条判据不能再有那种可能
  const limit = await run('ulimit -u');
  assert.equal(limit.output.trim(), '128', `进程数上限没设上，不引爆：${limit.output}`);
  const r = await run(':(){ :|:& };: ; sleep 2; echo survived', { timeoutMs: 15_000 });
  assert.ok(r.exitCode !== undefined);
  const after = spawnSync('bash', ['-c', 'echo host-ok'], { encoding: 'utf8' });
  assert.equal(after.stdout.trim(), 'host-ok', '外面起不了进程了');
  const next = await rig().run('echo next-ok');
  assert.match(next.output, /next-ok/);
});

test('写爆文件：单个文件停在上限；写满也只在工作区', { skip, timeout: 60_000 }, async () => {
  const { root, run } = rig();
  await run('dd if=/dev/zero of=big.bin bs=1048576 count=200 2>&1 | tail -n 1', { timeoutMs: 30_000 });
  assert.ok(fs.statSync(path.join(root, 'big.bin')).size <= 64 * 1024 * 1024, '单个文件超过了上限');
});

test('到点连里面的进程一起杀：一个不留', { skip, timeout: 30_000 }, async () => {
  const { run } = rig();
  const mark = `sleep 2${Date.now() % 100000}`;
  const r = await run(`(${mark} &) ; ${mark}`, { timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const left = spawnSync('pgrep', ['-f', mark], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
    .filter((pid) => { try { return !fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('pgrep'); } catch { return false; } });
  assert.deepEqual(left, [], '还有进程活着');
});

test('探测：bubblewrap 真的起得来才算；真的探测得到（这台机器上）', { skip }, () => {
  assert.deepEqual(detectSandbox({ hosted: true }).kind, 'bwrap');
  assert.equal(detectSandbox({ hosted: true, probe: false }).kind, 'bwrap');
});
