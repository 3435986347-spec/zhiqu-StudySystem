// 草稿模式的工具（第九十四轮）：网页 / 桌面应用的代码模式也跑命令行这一份循环，后端用子进程起它（host/code-host.js）。
// 和 LocalTools 只差三处 —— 规矩、参数、拒绝的说法全是同一份：
//   - write_file / edit_file 不落盘：改动记进草稿层（LocalTools.overlay），之后读、改、搜同一个文件看到的是草稿，
//     同一个文件改几处叠在一份草稿上。收尾时交给后端成一份 CODE_DRAFT，用户看过 diff、确认了才写进磁盘（「AI 写的东西一律先成草稿」）。
//   - 没有 delete_file（网页从来没给过删除）。
//   - 跑命令交回后端的 WorkspaceExecutor：服务器上执行命令只有那一处（行内代码开关、超时、输出上限、不继承环境变量都在它里面）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { LocalTools, READ_TOOLS, shellOutcome, shellSeconds } from './local.js';
import { describeJob, MAX_WAIT_SECONDS, START_WAIT_MS } from './jobs.js';
import { describeBoundary, READ_ONLY, WORKSPACE_WRITE } from './sandbox.js';
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
   * canShell / shellWrite（第一百零九轮，用户：网页也要系统沙箱，和命令行一致）：这台机器有系统沙箱就给 shell、不给 run_command；
   * 命令由后端在同一份沙箱（sandbox.js）里跑，能不能写工作区后端按档位定，这里只用来告诉模型边界。
   */
  constructor({ root, exec, canWrite = false, canExec = false, commands = [], canShell = false, shellWrite = false, sandboxNetwork = 'off' }) {
    super({ root, commands: canExec ? commands : [], sandbox: canShell ? { kind: 'backend' } : null, sandboxNetwork });
    this.shellPolicy = shellWrite ? WORKSPACE_WRITE : READ_ONLY;
    this.allowedTools = new Set([...READ_TOOLS, ...(canWrite ? ['write_file', 'edit_file', 'apply_patch'] : []), ...(canExec ? ['run_command'] : [])]);
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

  /** 补丁也进草稿：先对一遍，都对才记。带 Delete / Move 的走 prepareDelete，在 preparePatch 里就整个拒绝了 */
  commitPatch(prep) {
    for (const w of prep.writes) {
      const current = this.overlay.has(w.abs) ? this.overlay.get(w.abs) : fs.existsSync(w.abs) ? fs.readFileSync(w.abs) : null;
      if ((current ? sha(current) : null) !== w.baseline) return { error: `${w.rel} 在你读过之后被改过了（可能是用户在编辑器里改的），一个草稿都没生成。请重新 read_file 再改。` };
    }
    for (const w of prep.writes) this.commitWrite(w);
    const { lines, syntax, added, removed } = this.patchLines(prep);
    return {
      content: `已生成草稿（${prep.files} 个文件，磁盘上的文件没有改动）：\n${lines.map((l) => `  ${l}`).join('\n')}\n`
        + `用户在页面上看过 diff、点了确认才会写进磁盘 —— 回答里说「改动已生成草稿，确认后生效」，不要说「已经改好了」。${syntax.length ? `\n${syntax.join('\n')}` : ''}`,
      summary: `${prep.files} 个文件 +${added} -${removed}`, changed: prep.writes.map((w) => w.rel), syntax: syntax[0],
    };
  }

  prepareDelete() {
    return { error: '这里不能删除文件（网页 / 桌面应用的代码模式只生成草稿）。要删的话告诉用户删哪个、为什么，让用户自己删。' };
  }

  /** 只查形状；能不能跑、工作目录、沙箱都在后端 */
  prepareShell(args = {}) {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) return { error: '没有给出要运行的命令（command 是一整条 shell 命令，字符串）' };
    const cwd = args.cwd == null ? '' : String(args.cwd);
    return { command, cwd, cwdRel: cwd || '.', timeoutSeconds: args.timeout_seconds == null ? null : shellSeconds(args.timeout_seconds) };
  }

  /** 后台命令也是后端起的（门在后端，一轮结束后端全部收掉） */
  async startJob(prep, { signal } = {}) {
    const r = await this.exec({ shell: true, background: true, command: prep.command, cwd: prep.cwd, waitMs: START_WAIT_MS }, { signal });
    if (r.error) return { error: r.error };
    this.ranCommand = true;
    const snap = { ...r, id: r.jobId };
    return { id: r.jobId, content: describeJob(snap, { boundary: describeBoundary({ policy: this.shellPolicy, network: this.sandboxNetwork }) }), snap };
  }

  async readJob(args = {}, { signal } = {}) {
    const wait = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), MAX_WAIT_SECONDS);
    const r = await this.exec({ job: 'read', jobId: String(args.id || ''), waitMs: wait * 1000 }, { signal });
    if (r.error) return { error: r.error };
    const snap = { ...r, id: r.jobId };
    return { content: describeJob(snap, { boundary: describeBoundary({ policy: this.shellPolicy, network: this.sandboxNetwork }) }), snap };
  }

  async stopJob(args = {}, { signal } = {}) {
    const r = await this.exec({ job: 'stop', jobId: String(args.id || '') }, { signal });
    if (r.error) return { error: r.error };
    const snap = { ...r, id: r.jobId };
    return { content: `已停止 ${describeJob(snap)}`, snap };
  }

  async commitShell(prep, { signal } = {}) {
    const r = await this.exec({ shell: true, command: prep.command, cwd: prep.cwd, ...(prep.timeoutSeconds ? { timeoutMs: prep.timeoutSeconds * 1000 } : {}) }, { signal });
    if (r.error) return { content: `${r.error}${this.pendingNote()}`, summary: '没有运行', exitCode: -1, output: '' };
    this.ranCommand = true;
    const out = shellOutcome(prep, r, { boundary: describeBoundary({ policy: this.shellPolicy, network: this.sandboxNetwork }) });
    return { ...out, content: `${out.content}${this.pendingNote()}` };
  }

  /** 有没落盘的草稿：命令看到的是磁盘上的旧版本 —— 说出来，免得模型拿旧版本的结果判断草稿对不对 */
  pendingNote() {
    const pending = [...this.drafts.keys()];
    return pending.length ? `\n（注意：${pending.slice(0, 5).join('、')}${pending.length > 5 ? ' 等' : ''} 有没确认的草稿，`
      + '这条命令跑的是磁盘上的旧版本。要跑新代码得先让用户确认草稿落盘。）' : '';
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
    if (!r.error) this.ranCommand = true;   // 真的跑过一次（不管过没过）：判过题之后才给记薄弱点的工具
    const line = [prep.command, ...prep.args].join(' ');
    const note = this.pendingNote();
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

/**
 * 生成到 artifact（第一百一十六轮，用户要的）：工作区是后端给这段对话的临时空间，不是用户的文件夹。
 * 写工具直接写进去，不走草稿：没碰用户的东西，不用确认；后面的命令也要看得到刚写的文件。
 * 一轮结束后端比对前后，新增和改过的文件存成产物。
 */
export class ArtifactTools extends DraftTools {
  constructor(options) {
    super(options);
    this.artifact = true;
    this.wrote = new Set();
    // 扩展名白名单防的是把用户的 .env、.pem 读进上下文。临时空间里只有模型自己写的东西，拦着只会让 .svg、.drawio 这些写不了
    this.guard.extensionAllowed = () => true;
  }

  commitWrite(prep) {
    const r = LocalTools.prototype.commitWrite.call(this, prep);
    if (!r.error) this.wrote.add(prep.rel);
    return r;
  }

  commitPatch(prep) {
    const r = LocalTools.prototype.commitPatch.call(this, prep);
    if (!r.error) for (const w of prep.writes) this.wrote.add(w.rel);
    return r;
  }
}

