// 执行命令前的规则 —— 与服务器端 WorkspaceExecutor.check（Java）是同一套，共用 conformance/workspace-rules.json。
//
// 先说清楚它不是什么：白名单里有 python3 / node，允许它们就等于允许任意代码 —— 这一层关不住一段恶意脚本。
// 它真正守的是「只能跑用户看得见的代码」：
//   - 禁行内代码（-c / -e / --eval= / node -pe / python3 -Bc …）：否则模型可以把任意程序当成一个参数传进来；
//   - 禁 npm exec / x / create / init / dlx：它们会下载并运行别人的包；
//   - 参数不接受绝对路径与 ..：命令的作用范围跟着工作区走；
//   - 只接受命令名 + 参数数组，不接受 shell 字符串（没有管道、重定向、$(…)）。
// 命令行在这一套外面多放开两件（行内代码、git 的只读子命令），只在命令行那一层：见文件末尾的 checkLocalCommand。
export const ExecRefusal = Object.freeze({
  OK: 'OK', EMPTY: 'EMPTY', COMMAND_NOT_ALLOWED: 'COMMAND_NOT_ALLOWED', NULL_ARG: 'NULL_ARG',
  INLINE_CODE: 'INLINE_CODE', REMOTE_CODE: 'REMOTE_CODE', ABSOLUTE_PATH: 'ABSOLUTE_PATH', PARENT_ESCAPE: 'PARENT_ESCAPE',
  GIT_SUBCOMMAND: 'GIT_SUBCOMMAND', GIT_OPTION: 'GIT_OPTION',   // 只有命令行那一层（checkLocalCommand）会给
});

export const DEFAULT_COMMANDS = ['java', 'javac', 'python3', 'python', 'node', 'npm', 'go', 'gcc', 'g++', 'cargo', 'mvn'];

const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '--command', '--exec', '-command', '--execute',
  '-E', '--expression', '-i', '--interactive', '--print', '--call']);
// 各解释器自己的行内代码短参数（会被合写）。不能一刀切：go build -p 4、java -cp 都是正经参数。
const INLINE_SHORT_LETTERS = { node: 'epi', python: 'ci', python3: 'ci' };
const NPM_REMOTE_SUBCOMMANDS = new Set(['exec', 'x', 'create', 'init', 'dlx']);

function escapesUp(arg) {
  const parts = arg.replace(/\\/g, '/').split('/');
  const stack = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return true;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return false;
}

/** inlineCode：命令行自己那一层放开行内代码（见 checkLocalCommand）；服务器端和一致性用例走默认的不放 */
export function checkCommand(allowedCommands, command, args, { inlineCode = false } = {}) {
  const name = command == null ? '' : String(command).trim();
  if (name === '') return { refusal: ExecRefusal.EMPTY };
  if (!allowedCommands.includes(name)) return { refusal: ExecRefusal.COMMAND_NOT_ALLOWED, arg: name };
  const list = Array.isArray(args) ? args : [];
  if (name === 'npm' && list.length && list[0] != null && NPM_REMOTE_SUBCOMMANDS.has(String(list[0]))) {
    return { refusal: ExecRefusal.REMOTE_CODE, arg: String(list[0]) };
  }
  const letters = inlineCode ? '' : INLINE_SHORT_LETTERS[name] || '';
  for (const raw of list) {
    if (raw == null) return { refusal: ExecRefusal.NULL_ARG };
    const arg = String(raw);
    const flag = arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!inlineCode && INLINE_CODE_FLAGS.has(flag)) return { refusal: ExecRefusal.INLINE_CODE, arg };
    if (letters && /^-[A-Za-z]+$/.test(arg) && [...arg.slice(1)].some((ch) => letters.includes(ch))) {
      return { refusal: ExecRefusal.INLINE_CODE, arg };
    }
    if (arg.startsWith('/') || arg.startsWith('~') || /^[A-Za-z]:[\\/]/.test(arg) || arg.startsWith('\\\\')) {
      return { refusal: ExecRefusal.ABSOLUTE_PATH, arg };
    }
    if (escapesUp(arg)) return { refusal: ExecRefusal.PARENT_ESCAPE, arg };
  }
  return { refusal: ExecRefusal.OK };
}

export function describeRefusal(check, allowedCommands) {
  switch (check.refusal) {
    case ExecRefusal.EMPTY: return '没有给出要执行的命令';
    case ExecRefusal.COMMAND_NOT_ALLOWED: return `命令不在允许清单里：${check.arg}（允许的是 ${allowedCommands.join('、')}；只接受命令名，不接受路径或 shell 语句）`;
    case ExecRefusal.NULL_ARG: return '参数里有空值';
    case ExecRefusal.INLINE_CODE: return `不接受行内代码参数 ${check.arg} —— 只能执行工作区里已经存在的文件，那样用户才看得到要跑的是什么。先用 write_file 把代码写成文件再运行`;
    case ExecRefusal.REMOTE_CODE: return `不接受 npm ${check.arg} —— 它会下载并运行别人的包，那段代码用户没看过`;
    case ExecRefusal.ABSOLUTE_PATH: return `参数不接受绝对路径：${check.arg}`;
    case ExecRefusal.PARENT_ESCAPE: return `参数不接受跳出工作区的路径：${check.arg}`;
    case ExecRefusal.GIT_SUBCOMMAND: return `只能跑 git 的 ${GIT_READ_ONLY.join(' / ')}（只读；第一个参数就是子命令，前面不接受 -c、-C 这类全局参数）：${check.arg || '（没有子命令）'}`;
    case ExecRefusal.GIT_OPTION: return `git 不接受这个参数：${check.arg}（会写文件或者叫起别的程序）`;
    default: return '';
  }
}

// ── 命令行自己多放开的两件（第八十七轮，2026-10-31 用户定的）──────────────────────────
// 服务器端的工作区照旧（上面那份 checkCommand，一致性用例只管它）：那边跑在服务器上，「只能跑用户看过的文件」是唯一真正的安全判定。
// 命令行跑在用户自己的电脑上，跑之前整条命令（连同行内的那段代码）都摆在终端里 —— ask 档逐条问，auto 档照样打出来：
//   - 行内代码（python3 -c、node -e …）放开：评测里被拒 12 次，每次多花「写文件 → 跑 → 删」两轮，那段代码用户照样看得见；
//   - git 只放只读的 status / diff / log：子命令前面不许有全局参数（-c、-C、--git-dir…，第一个参数就得是子命令），
//     会写文件、会叫别的程序的几个参数不认；真正跑的时候还要关掉仓库配置能叫起来的程序（见 gitLaunch）。
export const LOCAL_DEFAULT_COMMANDS = [...DEFAULT_COMMANDS, 'git'];
export const GIT_READ_ONLY = ['status', 'diff', 'log'];
const GIT_REFUSED_FLAGS = new Set(['--output', '--ext-diff', '--textconv', '--show-signature']);

export function checkLocalCommand(allowedCommands, command, args) {
  const check = checkCommand(allowedCommands, command, args, { inlineCode: true });
  if (check.refusal !== ExecRefusal.OK || String(command).trim() !== 'git') return check;
  const list = Array.isArray(args) ? args.map(String) : [];
  if (!GIT_READ_ONLY.includes(list[0])) return { refusal: ExecRefusal.GIT_SUBCOMMAND, arg: list[0] || '' };
  for (const arg of list.slice(1)) {
    const flag = arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (GIT_REFUSED_FLAGS.has(flag)) return { refusal: ExecRefusal.GIT_OPTION, arg };
  }
  return check;
}

/**
 * git 真正跑的参数和环境：不读 HOME 下的 .gitconfig（第八十七轮时子进程的 HOME 还是工作区，克隆下来的仓库里可以带一个；
 * 第九十轮起 HOME 是这个进程自己的空目录，这一层留着：HOME 以后再变也不至于又开一个口子）；
 * 不起分页器、不叫 fsmonitor、不验签名、diff / log 不用外部 diff 和 textconv —— 这些都能按配置叫起别的程序。
 * fsmonitor、外部 diff、textconv 写在仓库自己的 .git/config 里也关掉了；剩下的只有那里面的过滤器（filter.*.clean）——
 * 克隆不带 .git/config，能改它的人本来就能让你下一次 git 命令跑任何东西。
 */
export function gitLaunch(args, devNull) {
  const [sub, ...rest] = args;
  return {
    args: ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'color.ui=never',
      sub, ...(sub === 'status' ? [] : ['--no-ext-diff', '--no-textconv']), ...rest],
    env: { GIT_CONFIG_GLOBAL: devNull, GIT_OPTIONAL_LOCKS: '0' },   // 后一项：status 不顺手重写 .git/index（只读，也不和用户自己的 git 抢锁）
  };
}
