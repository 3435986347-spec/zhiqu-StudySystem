// 本地五个工具：list_files / read_file / search / write_file / run_command。全部在用户电脑上执行。
//
// 写入分两步（prepare → commit）：中间是权限这一关（ask 档要给用户看 diff、问 y/n）。commit 时再比一次磁盘，
// 确认期间文件被改过就不写 —— 用户在编辑器里的改动不能被一个旧草稿覆盖。
//
// 「没读过不许改」：改一个已存在的文件之前，这段会话里必须读过它、且读过之后它没被别人改过（记着内容指纹）。
// 整份重写还要求读的是全文 —— 只读了前 2000 行就整份重写，会把没读到的部分冲掉。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceGuard, Reason, describe, DEFAULT_EXTENSIONS, DEFAULT_MAX_FILE_BYTES } from './guard.js';
import { checkCommand, describeRefusal, DEFAULT_COMMANDS, ExecRefusal } from './execrules.js';
import { planLaunch, resolveOnPath, runProcess } from './exec.js';
import { stat as diffStat } from '../render/diff.js';
import { formatBytes } from '../render/term.js';

export const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'target', 'build', 'dist', 'out', '.idea', '.vscode',
  '__pycache__', '.venv', 'venv', '.gradle', '.next', '.nuxt', 'coverage', '.zhiqu', '.svn', '.hg']);
const MAX_ENTRIES = 500;
const READ_MAX_LINES = 2000;
const READ_MAX_CHARS = 100_000;
const SEARCH_MAX_FILES = 3000;
const SEARCH_MAX_HITS = 80;
const SEARCH_MAX_LINE_CHARS = 400;

export const READ_TOOLS = new Set(['list_files', 'read_file', 'search']);

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export function localSchemas() {
  return [
    fn('list_files', '列出工作区里某个目录的文件和子目录（默认展开两层）。读不了的文件（密钥、证书这类）会标出来。',
      { path: { type: 'string', description: '相对工作区根的目录，默认是根' },
        depth: { type: 'integer', description: '展开几层，1–3，默认 2' } }),
    fn('read_file', '读取一个文件的内容。长文件一次最多给 2000 行，用 offset 接着读。改文件之前必须先读过。',
      { path: { type: 'string', description: '相对工作区根的路径' },
        offset: { type: 'integer', description: '从第几行开始（1 起），默认 1' },
        limit: { type: 'integer', description: '最多读几行，默认 2000' } }, ['path']),
    fn('search', '在工作区的文件里按字面文本搜索（不是正则），返回「路径:行号: 内容」。',
      { query: { type: 'string', description: '要找的文字，原样匹配' },
        path: { type: 'string', description: '只在这个目录里找，默认整个工作区' },
        ignore_case: { type: 'boolean', description: '忽略大小写，默认否' } }, ['query']),
    fn('write_file', [
      '写文件。三种用法选一种：',
      '1）整份写入：给 content —— 新建文件，或者整份重写一个读过全文的文件；',
      '2）追加：给 content 并且 append=true —— 长文件分几次写，就先写开头再一段段追加；',
      '3）替换一段：给 old_string 和 new_string —— old_string 必须和文件里的原文一字不差、且只出现一次。改一小段就用它，不要整份重写。',
      '上级目录不存在会自动建。',
    ].join('\n'), {
      path: { type: 'string', description: '相对工作区根的路径' },
      content: { type: 'string', description: '要写入（或追加）的完整内容' },
      append: { type: 'boolean', description: '为 true 时把 content 追加到文件末尾' },
      old_string: { type: 'string', description: '替换用法：要被替换的原文' },
      new_string: { type: 'string', description: '替换用法：替换成的新文字' },
    }, ['path']),
    fn('run_command', '在工作区里运行一条命令（命令名 + 参数数组，不经过 shell）。用来跑测试、构建、运行刚写好的程序。',
      { command: { type: 'string', description: '命令名，如 node、python3、npm' },
        args: { type: 'array', items: { type: 'string' }, description: '参数，一项一个' },
        cwd: { type: 'string', description: '在哪个子目录里运行，默认工作区根' } }, ['command']),
  ];
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const lineCount = (s) => (s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0));

export class LocalTools {
  constructor({ root, extensions, maxFileBytes, commands, execTimeoutMs = 120_000 } = {}) {
    this.guard = new WorkspaceGuard(root, {
      extensions: extensions || DEFAULT_EXTENSIONS, maxFileBytes: maxFileBytes || DEFAULT_MAX_FILE_BYTES,
    });
    this.root = this.guard.root;
    this.commands = commands || DEFAULT_COMMANDS;
    this.execTimeoutMs = execTimeoutMs;
    /** rel → { hash, full }：这段会话里读过 / 写过的文件，以及当时的内容指纹。 */
    this.known = new Map();
  }

  // ── 读 ────────────────────────────────────────────────────────────────

  listFiles(args = {}) {
    const dir = this.guard.resolveDirectory(args.path);
    if (dir.reason !== Reason.OK) return { error: describe(dir.reason, args.path || '.') };
    const depth = Math.max(1, Math.min(3, Number(args.depth) || 2));
    const lines = [];
    let count = 0;
    let truncated = false;
    const walk = (abs, level) => {
      let names;
      try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      names.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
      for (const d of names) {
        if (count >= MAX_ENTRIES) { truncated = true; return; }
        const indent = '  '.repeat(level);
        const child = path.join(abs, d.name);
        if (d.isSymbolicLink()) { lines.push(`${indent}${d.name} → （软链，不跟随）`); count++; continue; }
        if (d.isDirectory()) {
          if (SKIPPED_DIRS.has(d.name)) { lines.push(`${indent}${d.name}/ （略过）`); count++; continue; }
          lines.push(`${indent}${d.name}/`);
          count++;
          if (level + 1 < depth) walk(child, level + 1);
          continue;
        }
        let size = 0;
        try { size = fs.statSync(child).size; } catch { /* 读不到大小就算 0 */ }
        const readable = this.guard.extensionAllowed(child);
        lines.push(`${indent}${d.name}  ${readable ? formatBytes(size) : '（这类文件读不了：可能含密钥）'}`);
        count++;
      }
    };
    walk(dir.path, 0);
    // 截断必须说出来：模型会把「500 个」当成「一共 500 个」，然后下「这里没有 X」的结论
    if (truncated) lines.push(`（条目太多，只列出了前 ${MAX_ENTRIES} 个 —— 这不是全部，请进到子目录再看）`);
    const shown = this.guard.display(dir.path);
    return {
      content: lines.length ? `${shown === '.' ? '工作区根' : shown}：\n${lines.join('\n')}` : `${shown}：（空目录）`,
      summary: `${count} 项${truncated ? '（已截断）' : ''}`,
    };
  }

  readFile(args = {}) {
    const r = this.guard.resolveReadable(args.path);
    if (r.reason !== Reason.OK) return { error: describe(r.reason, args.path, this.guard.maxFileBytes) };
    const buf = fs.readFileSync(r.path);
    const text = buf.toString('utf8');
    const all = text.split('\n');
    if (text.endsWith('\n')) all.pop();
    const total = all.length;
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Math.min(READ_MAX_LINES, Number(args.limit) || READ_MAX_LINES));
    let slice = all.slice(offset - 1, offset - 1 + limit);
    let chars = 0;
    let cut = slice.length;
    for (let i = 0; i < slice.length; i++) { chars += slice[i].length + 1; if (chars > READ_MAX_CHARS) { cut = i; break; } }
    slice = slice.slice(0, Math.max(1, cut));
    const end = offset - 1 + slice.length;
    const full = offset === 1 && end >= total;
    const rel = this.guard.display(r.path);
    const prev = this.known.get(rel);
    const hash = sha(buf);
    this.known.set(rel, { hash, full: full || Boolean(prev && prev.hash === hash && prev.full) });
    const header = full
      ? `【${rel}，共 ${total} 行】`
      : `【${rel} 第 ${offset}–${end} 行（共 ${total} 行）${end < total ? `；没读完，用 offset=${end + 1} 接着读` : ''}】`;
    return { content: `${header}\n${slice.join('\n')}`, summary: full ? `${total} 行` : `第 ${offset}–${end} 行 / 共 ${total} 行` };
  }

  search(args = {}) {
    const query = args.query == null ? '' : String(args.query);
    if (!query) return { error: '没有给出要搜索的文字' };
    const dir = this.guard.resolveDirectory(args.path);
    if (dir.reason !== Reason.OK) return { error: describe(dir.reason, args.path || '.') };
    const ic = Boolean(args.ignore_case);
    const needle = ic ? query.toLowerCase() : query;
    const hits = [];
    let files = 0;
    let truncated = null;
    const walk = (abs) => {
      let names;
      try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const d of names) {
        if (truncated) return;
        const child = path.join(abs, d.name);
        if (d.isSymbolicLink()) continue;
        if (d.isDirectory()) { if (!SKIPPED_DIRS.has(d.name)) walk(child); continue; }
        if (!this.guard.extensionAllowed(child)) continue;
        let st;
        try { st = fs.statSync(child); } catch { continue; }
        if (st.size > this.guard.maxFileBytes) continue;
        if (++files > SEARCH_MAX_FILES) { truncated = `文件太多，只搜了前 ${SEARCH_MAX_FILES} 个`; return; }
        let text;
        try { text = fs.readFileSync(child, 'utf8'); } catch { continue; }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if ((ic ? line.toLowerCase() : line).includes(needle)) {
            if (hits.length >= SEARCH_MAX_HITS) { truncated = `命中太多，只列出了前 ${SEARCH_MAX_HITS} 条`; return; }
            const shown = line.length > SEARCH_MAX_LINE_CHARS ? `${line.slice(0, SEARCH_MAX_LINE_CHARS)}…` : line;
            hits.push(`${this.guard.display(child)}:${i + 1}: ${shown.trim()}`);
          }
        }
      }
    };
    walk(dir.path);
    const body = hits.length ? hits.join('\n') : '（没有找到）';
    // 截断必须说出来：模型把「80 条」当成「一共 80 条」就会给出错误结论
    return { content: truncated ? `${body}\n（${truncated} —— 这不是全部结果，请缩小范围再搜）` : body,
      summary: `${hits.length} 处${truncated ? '（已截断）' : ''}` };
  }

  // ── 写 ────────────────────────────────────────────────────────────────

  prepareWrite(args = {}) {
    const w = this.guard.resolveWritable(args.path);
    if (w.reason !== Reason.OK) return { error: describe(w.reason, args.path, this.guard.maxFileBytes) };
    const rel = this.guard.display(w.path);
    const exists = fs.existsSync(w.path);
    const current = exists ? fs.readFileSync(w.path) : null;
    const currentText = current ? current.toString('utf8') : '';
    const known = this.known.get(rel);
    const replacing = args.old_string != null;
    const appending = !replacing && Boolean(args.append);
    if (exists) {
      if (!known) {
        return { error: `改动一个已存在的文件之前必须先 read_file 读过它：${rel}。没读过就改，是拿想象中的内容覆盖真实内容。` };
      }
      if (known.hash !== sha(current)) {
        return { error: `${rel} 在你读过之后被改过了（可能是用户在编辑器里改的），请重新 read_file 再改。` };
      }
      if (!replacing && !appending && !known.full) {
        return { error: `${rel} 你只读了一部分，整份重写会把没读到的部分冲掉。请用替换用法（old_string / new_string），或者先把全文读完。` };
      }
    }
    let newText;
    let kind;
    if (replacing) {
      if (!exists) return { error: `替换用法只能用在已存在的文件上：${rel} 不存在。新建文件请直接给 content。` };
      const oldStr = String(args.old_string);
      if (!oldStr) return { error: 'old_string 不能为空' };
      const first = currentText.indexOf(oldStr);
      if (first < 0) return { error: `old_string 在 ${rel} 里没找到（空格、缩进、换行都要一字不差）。先 read_file 看一下原文。` };
      const second = currentText.indexOf(oldStr, first + oldStr.length);
      if (second >= 0) return { error: `old_string 在 ${rel} 里出现了不止一次，请多带几行上下文让它唯一。` };
      newText = currentText.slice(0, first) + String(args.new_string ?? '') + currentText.slice(first + oldStr.length);
      kind = 'replace';
    } else {
      if (args.content == null) return { error: '没有给出 content（整份写入 / 追加），也没有给出 old_string（替换）' };
      newText = appending ? currentText + String(args.content) : String(args.content);
      kind = appending && exists ? 'append' : (exists ? 'overwrite' : 'create');
    }
    const bytes = Buffer.byteLength(newText, 'utf8');
    if (bytes > this.guard.maxFileBytes) {
      return { error: `写完之后 ${rel} 会有 ${bytes} 字节，超过 ${this.guard.maxFileBytes} 字节的上限。请拆成几个文件。` };
    }
    return {
      rel, abs: w.path, kind, creating: !exists, oldText: currentText, newText, baseline: current ? sha(current) : null,
      newDirectories: exists ? [] : this.guard.missingParents(args.path),
    };
  }

  commitWrite(prep) {
    const now = fs.existsSync(prep.abs) ? sha(fs.readFileSync(prep.abs)) : null;
    if (now !== prep.baseline) {
      return { error: `${prep.rel} 在确认期间被改过了，没有写入。请重新读一遍再改。` };
    }
    fs.mkdirSync(path.dirname(prep.abs), { recursive: true });
    const tmp = `${prep.abs}.zhiqu-tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, prep.newText);
      fs.renameSync(tmp, prep.abs);      // 临时文件 + 改名：中途失败不会留下半截源码
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 已经改名走了 */ }
    }
    this.known.set(prep.rel, { hash: sha(Buffer.from(prep.newText, 'utf8')), full: true });
    const { added, removed } = diffStat(prep.oldText, prep.newText);
    const lines = lineCount(prep.newText);
    const what = { create: '已新建', overwrite: '已重写', append: '已追加到', replace: '已修改' }[prep.kind];
    const dirs = prep.newDirectories.length ? `，连同新建目录 ${prep.newDirectories.join('、')}` : '';
    return { content: `${what} ${prep.rel}${dirs}（+${added} -${removed}，现在共 ${lines} 行）`, summary: `+${added} -${removed}`, added, removed };
  }

  // ── 运行 ──────────────────────────────────────────────────────────────

  prepareRun(args = {}) {
    const argv = Array.isArray(args.args) ? args.args.map((a) => (a == null ? a : String(a))) : [];
    if (args.args != null && !Array.isArray(args.args)) {
      return { error: 'args 必须是数组，一项一个参数（不接受一整条 shell 命令）' };
    }
    const check = checkCommand(this.commands, args.command, argv);
    if (check.refusal !== ExecRefusal.OK) return { error: describeRefusal(check, this.commands) };
    const dir = this.guard.resolveDirectory(args.cwd);
    if (dir.reason !== Reason.OK) return { error: `工作目录不可用：${describe(dir.reason, args.cwd || '.')}` };
    const command = String(args.command).trim();
    const binary = resolveOnPath(command);
    if (!binary) return { error: `这台机器上找不到命令：${command}` };
    const launch = planLaunch({ command, binary, args: argv });
    if (launch.error) return { error: launch.error };
    return { command, args: argv, binary: launch.binary, launchArgs: launch.args, cwd: dir.path, cwdRel: this.guard.display(dir.path) };
  }

  async commitRun(prep, { signal, onOutput } = {}) {
    const r = await runProcess({ binary: prep.binary, args: prep.launchArgs || prep.args, cwd: prep.cwd, timeoutMs: this.execTimeoutMs, signal, onOutput });
    const line = [prep.command, ...prep.args].join(' ');
    const secs = (r.millis / 1000).toFixed(1);
    return {
      content: `$ ${line}${prep.cwdRel === '.' ? '' : `（在 ${prep.cwdRel}）`}\n退出码 ${r.exitCode}（${secs}s）\n${r.output || '（没有输出）'}`,
      summary: r.timedOut ? `超时（${secs}s）` : r.aborted ? '已中断' : `退出码 ${r.exitCode}（${secs}s）`,
      exitCode: r.exitCode,
      output: r.output,
    };
  }
}
