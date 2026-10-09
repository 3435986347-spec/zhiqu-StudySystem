// 执行命令前的规则 —— 与服务器端 WorkspaceExecutor.check（Java）是同一套，共用 conformance/workspace-rules.json。
//
// 先说清楚它不是什么：白名单里有 python3 / node，允许它们就等于允许任意代码 —— 这一层关不住一段恶意脚本。
// 它真正守的是「只能跑用户看得见的代码」：
//   - 禁行内代码（-c / -e / --eval= / node -pe / python3 -Bc …）：否则模型可以把任意程序当成一个参数传进来；
//   - 禁 npm exec / x / create / init / dlx：它们会下载并运行别人的包；
//   - 参数不接受绝对路径与 ..：命令的作用范围跟着工作区走；
//   - 只接受命令名 + 参数数组，不接受 shell 字符串（没有管道、重定向、$(…)）。
export const ExecRefusal = Object.freeze({
  OK: 'OK', EMPTY: 'EMPTY', COMMAND_NOT_ALLOWED: 'COMMAND_NOT_ALLOWED', NULL_ARG: 'NULL_ARG',
  INLINE_CODE: 'INLINE_CODE', REMOTE_CODE: 'REMOTE_CODE', ABSOLUTE_PATH: 'ABSOLUTE_PATH', PARENT_ESCAPE: 'PARENT_ESCAPE',
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

export function checkCommand(allowedCommands, command, args) {
  const name = command == null ? '' : String(command).trim();
  if (name === '') return { refusal: ExecRefusal.EMPTY };
  if (!allowedCommands.includes(name)) return { refusal: ExecRefusal.COMMAND_NOT_ALLOWED, arg: name };
  const list = Array.isArray(args) ? args : [];
  if (name === 'npm' && list.length && list[0] != null && NPM_REMOTE_SUBCOMMANDS.has(String(list[0]))) {
    return { refusal: ExecRefusal.REMOTE_CODE, arg: String(list[0]) };
  }
  const letters = INLINE_SHORT_LETTERS[name] || '';
  for (const raw of list) {
    if (raw == null) return { refusal: ExecRefusal.NULL_ARG };
    const arg = String(raw);
    const flag = arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (INLINE_CODE_FLAGS.has(flag)) return { refusal: ExecRefusal.INLINE_CODE, arg };
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
    default: return '';
  }
}
