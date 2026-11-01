// 草稿模式的工具（第九十四轮）：网页 / 桌面应用的代码模式也跑命令行这一份循环，后端用子进程起它（host/code-host.js）。
// 和 LocalTools 只差三处 —— 规矩、参数、拒绝的说法全是同一份：
//   - write_file / edit_file 不落盘：改动记进草稿层（LocalTools.overlay），之后读、改、搜同一个文件看到的是草稿，
//     同一个文件改几处叠在一份草稿上。收尾时交给后端成一份 CODE_DRAFT，用户看过 diff、确认了才写进磁盘（「AI 写的东西一律先成草稿」）。
//   - 没有 delete_file（网页从来没给过删除）。
//   - 跑命令交回后端的 WorkspaceExecutor：服务器上执行命令只有那一处（行内代码开关、超时、输出上限、不继承环境变量都在它里面）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { LocalTools, READ_TOOLS } from './local.js';
import { syntaxProblem } from './syntax.js';
import { stat as diffStat } from '../render/diff.js';

/** 和后端 WorkspaceService.baselineOf 同一个算法：文件字节的 SHA-256（小写十六进制），没有这个文件是 ABSENT */
export const ABSENT = 'ABSENT';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const lineCount = (s) => (s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0));

export class DraftTools extends LocalTools {
  /**
   * exec(request) → Promise<{ exitCode, output, timedOut, millis } | { error }>：请后端跑一条命令。
   * canWrite / canExec / commands 由后端判好了给（门只在后端一处）：没有写意图不给写、不能执行不给跑，从来不给删。
   */
  constructor({ root, exec, canWrite = false, canExec = false, commands = [] }) {
    super({ root, commands: canExec ? commands : [] });
    this.allowedTools = new Set([...READ_TOOLS, ...(canWrite ? ['write_file', 'edit_file'] : []), ...(canExec ? ['run_command'] : [])]);
    this.overlay = new Map();
    /** rel → { path, content, baseline, creating, newDirectories }：交给后端的草稿，baseline 是第一次改它时磁盘上的指纹 */
    this.drafts = new Map();
    this.exec = exec;
  }

  commitWrite(prep) {
    const current = this.overlay.has(prep.abs) ? this.overlay.get(prep.abs) : fs.existsSync(prep.abs) ? fs.readFileSync(prep.abs) : null;
    if ((current ? sha(current) : null) !== prep.baseline) {
      return { error: `${prep.rel} 在你读过之后被改过了（可能是用户在编辑器里改的），没有生成草稿。请重新 read_file 再改。` };
    }
    const buf = Buffer.from(prep.newText, 'utf8');
    if (!this.drafts.has(prep.rel)) {
      this.drafts.set(prep.rel, { path: prep.rel, baseline: prep.baseline || ABSENT, creating: prep.creating, newDirectories: prep.newDirectories });
    }
    this.drafts.get(prep.rel).content = prep.newText;
    this.overlay.set(prep.abs, buf);
    this.known.set(prep.rel, { hash: sha(buf), full: true });
    const { added, removed } = diffStat(prep.oldText, prep.newText);
    const what = { create: '新建', overwrite: '整份重写', append: '追加', replace: '修改' }[prep.kind];
    const times = prep.replaced > 1 ? `，替换了 ${prep.replaced} 处` : '';
    const syntax = syntaxProblem(prep.abs, prep.rel, prep.newText);
    const warn = syntax ? `\n⚠ 写进去的内容有语法错误 —— 先修好它再做别的：\n${syntax}` : '';
    return {
      content: `已生成草稿（${what}，磁盘上的文件没有改动）：${prep.rel}（+${added} -${removed}${times}，现在共 ${lineCount(prep.newText)} 行）。`
        + `用户在页面上看过 diff、点了确认才会写进磁盘 —— 回答里说「改动已生成草稿，确认后生效」，不要说「已经改好了」。${warn}`,
      summary: `+${added} -${removed}`, added, removed, syntax,
    };
  }

  prepareDelete() {
    return { error: '这里不能删除文件（网页 / 桌面应用的代码模式只生成草稿）。要删的话告诉用户删哪个、为什么，让用户自己删。' };
  }

  /** 只查形状；能不能跑、怎么跑由后端的 WorkspaceExecutor 判 */
  prepareRun(args = {}) {
    if (args.args != null && !Array.isArray(args.args)) return { error: 'args 必须是数组，一项一个参数（不接受一整条 shell 命令）' };
    const command = String(args.command || '').trim();
    if (!command) return { error: '没有给出要运行的命令' };
    const argv = Array.isArray(args.args) ? args.args.map((a) => (a == null ? '' : String(a))) : [];
    const cwd = args.cwd == null ? '' : String(args.cwd);
    return { command, args: argv, cwd, cwdRel: cwd || '.' };
  }

  async commitRun(prep, { signal } = {}) {
    const r = await this.exec({ command: prep.command, args: prep.args, cwd: prep.cwd }, { signal });
    const line = [prep.command, ...prep.args].join(' ');
    // 有没落盘的草稿：命令看到的是磁盘上的旧版本 —— 说出来，免得模型拿旧版本的结果判断草稿对不对
    const pending = [...this.drafts.keys()];
    const note = pending.length ? `\n（注意：${pending.slice(0, 5).join('、')}${pending.length > 5 ? ' 等' : ''} 有没确认的草稿，`
      + '这条命令跑的是磁盘上的旧版本。要跑新代码得先让用户确认草稿落盘。）' : '';
    if (r.error) return { content: `${r.error}${note}`, summary: '没有运行', exitCode: -1, output: '' };
    const secs = ((r.millis || 0) / 1000).toFixed(1);
    return {
      content: `$ ${line}${prep.cwdRel === '.' ? '' : `（在 ${prep.cwdRel}）`}\n退出码 ${r.exitCode}${r.timedOut ? '（超时被强制结束）' : ''}（${secs}s）\n${r.output || '（没有输出）'}${note}`,
      summary: r.timedOut ? `超时（${secs}s）` : `退出码 ${r.exitCode}（${secs}s）`,
      exitCode: r.exitCode,
      output: r.output || '',
    };
  }

  /** 收尾交给后端的草稿 */
  draftList() {
    return [...this.drafts.values()].map((d) => ({ ...d }));
  }
}
