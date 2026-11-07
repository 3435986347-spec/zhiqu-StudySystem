// 系统沙箱（第一百零九轮，Codex 同级第 2 步，docs/codex-parity-plan.md）：shell 工具跑的每一条命令都关在这里面。
//
// 规则（execrules.js）拦不住一段脚本 —— 白名单里有 python3 就等于允许任意代码。这一层是操作系统在拦：
//   - 写：工作区 + 这个进程自己的临时目录。.git、.zhiqu 不能写：写一个 hook、改一下设置，下次就跑到沙箱外面去了。
//   - 读：家目录默认不让读，只放工具链和工作区。读到的东西会原样进模型上下文，发给模型服务。
//   - 网：默认全断，包括本机：本机的数据库可能没有密码，Docker 的 socket 也在本机。
//   - 系统服务：mach-lookup 只放一小撮。放开的话 open、osascript、launchctl 能让系统替它在沙箱外跑东西，读剪贴板、钥匙串。
// 探测（detectSandbox）是真跑一次：嵌套沙箱、用户命名空间被关时 sandbox-exec / bwrap 起不来，当作没有，退回白名单。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childHome, resolveOnPath } from './exec.js';

export const NETWORK_MODES = ['off', 'local', 'on'];
export const READ_ONLY = 'read-only';
export const WORKSPACE_WRITE = 'workspace-write';

// 不是秘密的工具链变量：mvn 要 JAVA_HOME，虚拟环境要 VIRTUAL_ENV。令牌、云凭据一律不传。
const TOOLCHAIN_ENV = ['JAVA_HOME', 'GOROOT', 'GOPATH', 'GOMODCACHE', 'CARGO_HOME', 'RUSTUP_HOME', 'PYENV_ROOT', 'NVM_DIR', 'VIRTUAL_ENV',
  'CONDA_PREFIX', 'SDKROOT', 'DEVELOPER_DIR', 'LC_ALL', 'LANG'];
// 家目录下放工具链和依赖缓存的地方：只读。子进程的 HOME 不是真家目录，有的工具（Java 的 user.home）还是认真家目录。
const HOME_TOOLCHAINS = ['.m2/repository', '.gradle/caches', '.gradle/wrapper', '.cargo/registry', '.rustup', '.pyenv', '.nvm', '.sdkman', '.rbenv', '.asdf',
  'go/pkg', 'Library/Java', 'Library/Python', '.local/lib', '.local/bin'];
// 放过了工具链，这些还要再挡一遍：.cargo/bin 在 PATH 里就放过了 .cargo，凭据也在那里；工作区就是家目录时也靠这一层。
const HOME_SECRETS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.zhiqu', '.netrc', '.npmrc', '.pypirc', '.git-credentials',
  '.config/gcloud', '.config/gh', '.cargo/credentials', '.cargo/credentials.toml', '.m2/settings.xml', '.m2/settings-security.xml',
  '.gradle/gradle.properties', 'Library/Keychains'];
// 工作区里不让写的：见文件开头。
const PROTECTED = ['.git', '.zhiqu'];

// 只放基本的目录、日志、通知（实测 git、python3、clang、node、npm、java、mvn 都够）。没有 launchservices、appleevents（open、osascript 叫别的程序）、
// pasteboard（剪贴板）、SecurityServer（钥匙串）、cfprefsd（defaults read 能读到家目录下读不到的偏好设置）。
const MACH_SERVICES = ['com.apple.system.opendirectoryd.libinfo', 'com.apple.system.opendirectoryd.membership', 'com.apple.system.notification_center',
  'com.apple.system.logger', 'com.apple.logd', 'com.apple.diagnosticd'];

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const under = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/** 工作区里的 git 目录（工作区是子目录、是 worktree 时都在工作区外面）：要读得到，git status 才跑得起来。 */
export function gitReadRoots(root) {
  const out = [];
  for (let dir = root; ; dir = path.dirname(dir)) {
    const dot = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dot); } catch { /* 再往上 */ }
    if (st) {
      if (st.isDirectory()) { out.push(dot); break; }
      // worktree：.git 是一个文件，写着真正的 git 目录
      try {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'));
        if (m) {
          const gitdir = path.resolve(dir, m[1].trim());
          out.push(gitdir);
          try { out.push(path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim())); } catch { /* 不是 worktree 的 gitdir */ }
        }
      } catch { /* 读不了就算了 */ }
      break;
    }
    if (dir === path.dirname(dir)) break;
  }
  return out.map(real);
}

/** 家目录下要放读的工具链：PATH 里的、工具链变量指的、约定的那几个。 */
export function toolchainRoots({ home, env = process.env }) {
  const out = new Set();
  const add = (p) => { if (p && path.isAbsolute(p) && under(real(p), home)) out.add(real(p)); };
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir) || !under(real(dir), home)) continue;
    add(dir);
    // ~/.local/node/bin → ~/.local/node（库在 lib 下）；但 ~/bin 不能带上整个家目录，~/.local/bin 不能带上 ~/.local/share
    const parent = path.dirname(real(dir));
    if (path.basename(real(dir)) === 'bin' && parent !== home && parent !== path.join(home, '.local')) add(parent);
  }
  for (const key of ['JAVA_HOME', 'GOROOT', 'GOPATH', 'GOMODCACHE', 'CARGO_HOME', 'RUSTUP_HOME', 'PYENV_ROOT', 'NVM_DIR', 'VIRTUAL_ENV', 'CONDA_PREFIX']) add(env[key]);
  for (const rel of HOME_TOOLCHAINS) {
    const p = path.join(home, rel);
    if (fs.existsSync(p)) out.add(real(p));
  }
  return [...out];
}

function seatbeltProfile({ policy, network, toolchains, gitRoots, secrets }) {
  const params = {};
  const param = (prefix, list) => list.map((value, i) => { params[`${prefix}${i}`] = value; return `(param "${prefix}${i}")`; });
  const subpaths = (prefix, list) => param(prefix, list).map((p) => `(subpath ${p})`).join(' ');
  const rules = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork)',
    // 别的进程的路径、命令行参数看不到：令牌、密钥常在命令行里。两条要一起：process-info 管 proc_pidpath、lsof，sysctl 管 ps 走的 kern.proc*。
    // 光写 (allow process-info* (target same-sandbox)) 不够，deny default 拦不住 process-info（实测）
    '(deny process-info*)',
    '(allow process-info* (target same-sandbox))',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(deny sysctl-read (sysctl-name-prefix "kern.proc"))',
    '(allow ipc-posix-sem ipc-posix-shm)',
    '(allow pseudo-tty)',
    `(allow mach-lookup ${MACH_SERVICES.map((s) => `(global-name "${s}")`).join(' ')})`,
    // 读：先全放，再把别人的东西收回来，再放工具链和工作区。后面的规则盖前面的。metadata 不收：解析路径时要逐级看父目录。
    '(allow file-read-metadata)',
    '(allow file-read* file-map-executable)',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper"))',
    '(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath (param "HOME")))',
  ];
  if (toolchains.length) rules.push(`(allow file-read* file-map-executable ${subpaths('TOOL', toolchains)})`);
  if (gitRoots.length) rules.push(`(allow file-read* ${subpaths('GIT', gitRoots)})`);
  rules.push('(allow file-read* file-map-executable (subpath (param "ROOT")) (subpath (param "PRIVATE")))');
  if (secrets.length) rules.push(`(deny file-read* file-map-executable ${subpaths('SECRET', secrets)})`);
  // 写。系统的工具有两个不听 TMPDIR：xcrun（git、python3、clang 这些都经过它，写不了缓存就每次报一行错）、mktemp。只放这两种名字，别的程序留在那儿的东西照样读不到
  rules.push('(allow file-read* file-write* (regex #"^/private/var/folders/[^/]+/[^/]+/T/(xcrun_db|tmp\\.)"))');
  rules.push('(allow file-write-data (literal "/dev/null") (literal "/dev/zero"))');
  rules.push('(allow file-write* (subpath (param "PRIVATE")))');
  if (policy === WORKSPACE_WRITE) {
    rules.push('(allow file-write* (subpath (param "ROOT")))');
    rules.push(`(deny file-write* ${PROTECTED.map((d) => `(subpath (string-append (param "ROOT") "/${d}"))`).join(' ')})`);
  }
  // 网
  if (network === 'local') {
    rules.push('(allow network-bind (local ip "localhost:*"))');
    rules.push('(allow network-inbound (local ip "localhost:*"))');
    rules.push('(allow network-outbound (remote ip "localhost:*"))');
  } else if (network === 'on') {
    rules.push('(allow network*)');
    rules.push('(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.trustd.agent") (global-name "com.apple.trustd"))');
  }
  return { text: rules.join('\n'), params };
}

function bwrapArgs({ root, cwd, policy, network, toolchains, gitRoots, secrets, privateDir }) {
  const args = ['--die-with-parent', '--new-session', '--unshare-all'];
  if (network !== 'off') args.push('--share-net');   // bwrap 分不出本机和外网：local 也只能全放（说明里写着）
  args.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc');
  for (const dir of ['/home', '/root', '/tmp', '/var/tmp', '/run/user', '/mnt', '/media']) {
    if (fs.existsSync(dir)) args.push('--tmpfs', dir);
  }
  for (const dir of [...toolchains, ...gitRoots]) args.push('--ro-bind-try', dir, dir);
  args.push('--bind', privateDir, privateDir);
  args.push(policy === WORKSPACE_WRITE ? '--bind' : '--ro-bind', root, root);
  // bwrap 只能挡已有的路径（Seatbelt 按名字挡，没有的也算）：工作区里还没有 .git / .zhiqu 时放一个只读的空目录占住，
  // 不然命令能建出来（第一百零九轮，容器里试出来的）。占位要在工作区上留一个挂载点，跑完收掉（sandboxedLaunch）。
  const placeholders = [];
  if (policy === WORKSPACE_WRITE) {
    const empty = path.join(privateDir, 'empty');
    fs.mkdirSync(empty, { recursive: true, mode: 0o700 });
    for (const d of PROTECTED) {
      const p = path.join(root, d);
      if (fs.existsSync(p)) args.push('--ro-bind', p, p);
      else { args.push('--ro-bind', empty, p); placeholders.push(p); }
    }
  }
  for (const s of secrets) if (fs.existsSync(s)) args.push('--ro-bind', '/dev/null', s);
  args.push('--chdir', cwd);
  return { args, placeholders };
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * 这条命令怎么起：{ binary, args, env }。env 是在 childEnv 上再加的。
 * home、env 能传进来：判据用假的家目录，不碰用户真的 ~/.ssh。
 */
export function sandboxedLaunch(box, { command, root, cwd, policy = WORKSPACE_WRITE, network: wantedNetwork = 'off', home = os.homedir(), env = process.env, privateDir = childHome() }) {
  // 认不出的一律断网：bwrap 那边「不是 off 就开网」，写错一个字不能把网打开
  const network = NETWORK_MODES.includes(wantedNetwork) ? wantedNetwork : 'off';
  const realHome = real(home);
  const realRoot = real(root);
  const priv = real(privateDir);
  const toolchains = toolchainRoots({ home: realHome, env });
  const gitRoots = gitReadRoots(realRoot);
  const secrets = HOME_SECRETS.map((rel) => path.join(realHome, rel));
  const extra = shellEnv({ home: realHome, env, privateDir: priv });
  const shell = shellBinary();
  if (box.kind === 'seatbelt') {
    const { text, params } = seatbeltProfile({ policy, network, toolchains, gitRoots, secrets });
    const defines = Object.entries({ ...params, ROOT: realRoot, PRIVATE: priv, HOME: realHome }).flatMap(([k, v]) => ['-D', `${k}=${v}`]);
    return { binary: box.binary, args: [...defines, '-p', text, shell, '-c', reapJobs(command)], env: extra };
  }
  const { args, placeholders } = bwrapArgs({ root: realRoot, cwd: real(cwd), policy, network, toolchains, gitRoots, secrets, privateDir: priv });
  const full = [...args, '--', shell, '-c', reapJobs(command)];
  if (!placeholders.length) return { binary: box.binary, args: full, env: extra };
  // 外面包一层 sh 只为跑完收掉占位。挡不挡得住不靠它：被杀了来不及收，也只是留一个空目录
  return { binary: '/bin/sh', args: ['-c', `"$0" "$@"; code=$?; rmdir ${placeholders.map(shellQuote).join(' ')} 2>/dev/null; exit $code`, box.binary, ...full], env: extra };
}

const shellBinary = () => (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');

/**
 * 命令一结束，它起的后台进程一起结束（第一百零九轮）：不收的话命令行要等它结束才回话，网页把它留在外面接着跑。
 * 要长跑的进程、看输出、停，是第 5 步的事。exit 码不受影响。
 */
const reapJobs = (command) => `trap 'p=$(jobs -p); disown -a 2>/dev/null; kill $p 2>/dev/null' EXIT; ${command}`;   // 先 disown：不然 bash 多打一行 Terminated

/** 命令看到的环境：不继承令牌和云凭据，HOME 是自己的空目录。 */
function shellEnv({ home, env, privateDir }) {
  const tmp = path.join(privateDir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const childPath = String(env.PATH || '').split(path.delimiter).filter((d) => path.isAbsolute(d));
  const extra = { PATH: childPath.join(path.delimiter) || '/usr/bin:/bin', TMPDIR: tmp, HOME: privateDir, GIT_PAGER: 'cat', PAGER: 'cat', npm_config_cache: path.join(privateDir, 'npm-cache') };
  for (const key of TOOLCHAIN_ENV) if (env[key]) extra[key] = env[key];
  // 真家目录下的 rustup / cargo：HOME 换了就找不到了
  for (const [key, dir] of [['CARGO_HOME', '.cargo'], ['RUSTUP_HOME', '.rustup']]) {
    if (!extra[key] && fs.existsSync(path.join(home, dir))) extra[key] = path.join(home, dir);
  }
  // Java 的临时目录不听 TMPDIR（macOS 上它问系统要，那里写不了）。代价是每次多打一行 Picked up JAVA_TOOL_OPTIONS
  if (process.platform === 'darwin') extra.JAVA_TOOL_OPTIONS = `-Djava.io.tmpdir=${tmp}`;
  return extra;
}

/** ask 档用户点了「不带沙箱再跑一次」：不进沙箱，环境照样是干净的（令牌还是不给）。 */
export function plainLaunch({ command, home = os.homedir(), env = process.env, privateDir = childHome() }) {
  return { binary: shellBinary(), args: ['-c', reapJobs(command)], env: shellEnv({ home: real(home), env, privateDir: real(privateDir) }) };
}

/**
 * 这台机器有没有能用的系统沙箱。不只看文件在不在：真跑一次。
 * 返回 { kind, binary } 或 null（调用方退回白名单）。
 */
export function detectSandbox({ platform = process.platform, env = process.env, probe = true } = {}) {
  let box = null;
  if (platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) box = { kind: 'seatbelt', binary: '/usr/bin/sandbox-exec' };
  else if (platform === 'linux') {
    const binary = resolveOnPath('bwrap', env);
    if (binary) box = { kind: 'bwrap', binary };
  }
  if (!box || !probe) return box;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-probe-'));
  try {
    const launch = sandboxedLaunch(box, { command: 'exit 0', root: dir, cwd: dir, policy: READ_ONLY, env, privateDir: dir });
    const r = spawnSync(launch.binary, launch.args, { stdio: 'ignore', timeout: 5000, cwd: dir, env: { PATH: launch.env.PATH, HOME: dir } });
    return r.status === 0 ? box : null;
  } catch { return null; } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 留着也无妨 */ }
  }
}

/** 这段输出像不像被沙箱挡了。猜错了只是多问一句 / 多提醒一句，所以宁可多猜。 */
export function looksBlocked(output) {
  const text = String(output || '');
  return /Operation not permitted|Permission denied|Read-only file system|EPERM|EACCES|EROFS|Could not resolve host|nodename nor servname|Name or service not known|Temporary failure in name resolution|getaddrinfo|Network is unreachable|ENETUNREACH|ENOTFOUND|EAI_AGAIN|Connection refused|ECONNREFUSED/i.test(text)
    // JVM 附加到自己（Mockito 5 的 inline mock maker）要连系统临时目录里的 .java_pid socket。不放：别的 JVM 的 socket 也在那儿，连上就能往里面加载代码、跳出沙箱
    || /Could not initialize inline Byte Buddy|Could not self-attach|AttachNotSupportedException/.test(text)
    // Linux 上家目录、/tmp 在沙箱里是空的：被挡的样子是「没有这个文件」
    || /(?:\/home\/|\/root\/|\/tmp\/|\/var\/tmp\/|\/mnt\/|\/media\/|\/run\/user\/)[^\n]*No such file or directory|No such file or directory[^\n]*(?:\/home\/|\/root\/|\/tmp\/|\/var\/tmp\/|\/mnt\/|\/media\/|\/run\/user\/)/.test(text);
}

/** 给人和模型看的一句话：现在关在什么里面。 */
export function describeBoundary({ policy = WORKSPACE_WRITE, network = 'off' } = {}) {
  const write = policy === READ_ONLY ? '只读（只能写临时目录 $TMPDIR）' : '能写工作区（.git、.zhiqu 除外）和临时目录 $TMPDIR，别处都不能写';
  const net = network === 'on' ? '能联网' : network === 'local' ? '只能连本机' : '不能联网（连本机也不行）';
  return `${write}；${net}；家目录下除了工具链都读不到；临时文件放 $TMPDIR，不要放 /tmp；每条命令是一个新的 bash，cd、变量留不到下一条，& 起的进程随命令结束（要一直跑用 background: true）`;
}
