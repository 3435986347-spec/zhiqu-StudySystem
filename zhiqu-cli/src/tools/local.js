// 本地六个工具：list_files / read_file / search / write_file / delete_file / run_command。全部在用户电脑上执行。
//
// 写入分两步（prepare → commit）：中间是权限这一关（ask 档要给用户看 diff、问 y/n）。commit 时再比一次磁盘，
// 确认期间文件被改过就不写 —— 用户在编辑器里的改动不能被一个旧草稿覆盖。
//
// 「没读过不许改」：改一个已存在的文件之前，这段会话里必须读过它、且读过之后它没被别人改过（记着内容指纹）。
// 整份重写还要求读的是全文 —— 只读了前 2000 行就整份重写，会把没读到的部分冲掉。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { WorkspaceGuard, Reason, describe, DEFAULT_EXTENSIONS, DEFAULT_MAX_FILE_BYTES } from './guard.js';
import { checkCommand, describeRefusal, DEFAULT_COMMANDS, ExecRefusal } from './execrules.js';
import { planLaunch, resolveOnPath, runProcess } from './exec.js';
import { applyEdit, describeEditError } from './edit.js';
import { syntaxProblem } from './syntax.js';
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
/** 搜索时单个文件最多流式扫这么大；再大的跳过并说出来（同步扫，太大会让命令行卡住） */
const SEARCH_STREAM_MAX_BYTES = 512 * 1024 * 1024;
const CHUNK_BYTES = 1 << 20;

/**
 * 一段字节是什么（第十六轮）：
 *   binary —— 有 NUL，或一成以上是控制字符（图片改了个 .txt 的名字、数据库转储：原来读进来就是几千个乱码塞进模型的上下文）；
 *   utf8；
 *   gb18030 —— 不是 UTF-8、但按 GB18030 解得通（老的 Windows 项目、老师发的 C 代码常是 GBK；第一版把它们判成了二进制）；
 *   unknown —— 都解不通。
 * partial：只拿到文件的开头一段（末尾可能切在一个字的中间），解码时容许最后几个字节不完整。
 */
export function classifyText(buf, { partial = false } = {}) {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return 'binary';
  let ctrl = 0;
  for (const b of head) if (b < 32 && b !== 9 && b !== 10 && b !== 12 && b !== 13) ctrl += 1;
  if (head.length && ctrl / head.length > 0.1) return 'binary';
  const decodes = (enc) => {
    for (let k = 0; k <= (partial ? 3 : 0) && k < buf.length; k++) {
      try { new TextDecoder(enc, { fatal: true }).decode(buf.subarray(0, buf.length - k)); return true; } catch { /* 下一个 */ }
    }
    return buf.length === 0;
  };
  if (decodes('utf-8')) return 'utf8';
  if (decodes('gb18030')) return 'gb18030';
  return 'unknown';
}
export function looksBinary(buf) { return classifyText(buf, { partial: true }) === 'binary'; }
const ENCODING_NAME = { gb18030: 'GBK / GB18030', unknown: '认不出的编码' };

function unreadable(e) { return e && (e.code === 'EACCES' || e.code === 'EPERM'); }

/**
 * 超过一次读的上限的文件，按行流式读其中一段，不把整份读进内存（第十六轮：原来一律「超过上限」，
 * 几百 MB 的日志连最后几行都看不了）。offset < 0 = 最后 |offset| 行。返回 { lines, first, eof }；first 为 null 表示不知道行号（从尾巴读的）。
 */
export function readLarge(file, { offset, limit, cap }) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(CHUNK_BYTES);
    if (offset < 0) {
      const want = Math.min(-offset, limit);
      let pos = size;
      let tail = Buffer.alloc(0);
      while (pos > 0) {
        const n = Math.min(CHUNK_BYTES, pos);
        pos -= n;
        fs.readSync(fd, buf, 0, n, pos);
        tail = Buffer.concat([Buffer.from(buf.subarray(0, n)), tail]);
        let nl = 0;
        for (const b of tail) if (b === 10) nl += 1;
        if (nl > want + 1 || tail.length > cap * 4) break;
      }
      let text = tail.toString('utf8');
      if (text.endsWith('\n')) text = text.slice(0, -1);
      const all = text.split('\n');
      if (pos > 0) all.shift();                         // 第一行多半只读到后半截
      let lines = all.slice(-want);
      let chars = 0;
      const keep = [];
      for (let i = lines.length - 1; i >= 0; i--) {     // 从最后一行往前收，收到字数上限为止
        chars += lines[i].length + 1;
        if (chars > cap && keep.length) break;
        keep.unshift(lines[i].length > cap ? lines[i].slice(0, cap) : lines[i]);
      }
      lines = keep;
      return { lines, first: null, eof: true };
    }
    const decoder = new StringDecoder('utf8');
    let lineNo = 1;
    let rest = '';
    let pos = 0;
    let chars = 0;
    const out = [];
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, pos);
      if (n === 0) break;
      pos += n;
      const parts = (rest + decoder.write(buf.subarray(0, n))).split('\n');
      rest = parts.pop();
      for (const line of parts) {
        if (lineNo >= offset) {
          if (out.length >= limit || (chars + line.length + 1 > cap && out.length)) return { lines: out, first: offset, eof: false };
          out.push(line.length > cap ? line.slice(0, cap) : line);
          chars += line.length + 1;
        }
        lineNo += 1;
      }
    }
    if (rest && lineNo >= offset && out.length < limit) out.push(rest.length > cap ? rest.slice(0, cap) : rest);
    return { lines: out, first: offset, eof: true };
  } finally {
    fs.closeSync(fd);
  }
}

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
    fn('read_file', '读取一个文件的内容。长文件一次最多给 2000 行，用 offset 接着读；很大的文件（日志）用负的 offset 看最后几行。改文件之前必须先读过。',
      { path: { type: 'string', description: '相对工作区根的路径' },
        offset: { type: 'integer', description: '从第几行开始（1 起），默认 1；负数 = 最后几行（-100 就是最后 100 行）' },
        limit: { type: 'integer', description: '最多读几行，默认 2000' } }, ['path']),
    fn('search', '在工作区的文件里按字面文本搜索（不是正则），返回「路径:行号: 内容」。',
      { query: { type: 'string', description: '要找的文字，原样匹配' },
        path: { type: 'string', description: '只在这个目录里找，默认整个工作区' },
        ignore_case: { type: 'boolean', description: '忽略大小写，默认否' } }, ['query']),
    fn('write_file', [
      '写文件（新建、追加、替换一段都用它 —— 没有单独的 replace / edit 工具）。三种用法选一种：',
      '1）整份写入：给 content —— 新建文件，或者整份重写一个读过全文的文件；',
      '2）追加：给 content 并且 append=true —— 长文件分几次写，就先写开头再一段段追加；',
      '3）替换一段：给 old_string 和 new_string —— old_string 必须和文件里的原文一字不差（缩进也算）、且只出现一次；同样的一段要全部替换就加 replace_all=true。改一小段就用它，不要整份重写。',
      '上级目录不存在会自动建。',
    ].join('\n'), {
      path: { type: 'string', description: '相对工作区根的路径' },
      content: { type: 'string', description: '要写入（或追加）的完整内容' },
      append: { type: 'boolean', description: '为 true 时把 content 追加到文件末尾' },
      old_string: { type: 'string', description: '替换用法：要被替换的原文' },
      new_string: { type: 'string', description: '替换用法：替换成的新文字' },
      replace_all: { type: 'boolean', description: '替换用法：old_string 出现几处就换几处（改名这类）' },
    }, ['path']),
    fn('delete_file', [
      '删除工作区里的一个文件（只能是文件，不能是目录）。',
      '和改文件一样：这段会话里读过或写过、之后没被改过的文件才能删。',
      '不是直接抹掉：挪进 .zhiqu/trash/ 里，要恢复挪回来就行。自己建的临时文件（校验脚本之类）用完就删掉它。',
    ].join('\n'), { path: { type: 'string', description: '相对工作区根的路径' } }, ['path']),
    fn('run_command', '在工作区里运行一条命令（命令名 + 参数数组，不经过 shell）。用来跑测试、构建、运行刚写好的程序。',
      { command: { type: 'string', description: '命令名，如 node、python3、npm' },
        args: { type: 'array', items: { type: 'string' }, description: '参数，一项一个' },
        cwd: { type: 'string', description: '在哪个子目录里运行，默认工作区根' } }, ['command']),
  ];
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/*
 * 模型不许改、不许删的目录。.zhiqu 是命令行自己的配置：settings.json 里有允许跑的命令、mcp.json 里的服务器
 * 下次启动就会被拉起来、system.md 和 skills 是模型自己的指令 —— 让模型写它们，等于让它给自己加权限、
 * 改自己的规矩（auto 档连问都不问）。.git 是版本库本身。读不拦：那里没有令牌（令牌只在 ~/.zhiqu/config.json）。
 * 这是命令行自己的规矩，所以放在这里，不放进与服务器共用一致性用例的 WorkspaceGuard。
 */
const PROTECTED_DIRS = new Set(['.zhiqu', '.git']);

/** 按「软链都解开之后」的真实位置算相对路径：cfg -> .zhiqu 这种目录软链不能成为绕过去的路。 */
function realRelative(root, abs) {
  let existing = abs;
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let real = existing;
  try { real = fs.realpathSync.native(existing); } catch { /* 用原样 */ }
  return path.relative(root, path.join(real, ...tail)).split(path.sep).join('/');
}
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
    let rootDenied = false;
    const walk = (abs, level) => {
      let names;
      try {
        names = fs.readdirSync(abs, { withFileTypes: true });
      } catch (e) {
        // 读不了的目录不是空目录（原来列出来是「（空目录）」）
        if (level === 0) rootDenied = true;
        else if (unreadable(e) && lines.length) lines[lines.length - 1] += ' （没有读权限）';
        return;
      }
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
      content: rootDenied ? `${shown}：（没有读权限，列不出来）`
        : lines.length ? `${shown === '.' ? '工作区根' : shown}：\n${lines.join('\n')}` : `${shown}：（空目录）`,
      summary: `${count} 项${truncated ? '（已截断）' : ''}`,
    };
  }

  /**
   * maxChars：这个模型一次能看的量（agent 按窗口算好传进来）。原来这里按 10 万字切、agent 再按窗口从中间截断 ——
   * 头部写着「共 300 行」、`full` 也记成读全了，模型实际只看到前一段，却被允许整份重写，没看到的部分就被冲掉了。
   */
  readFile(args = {}, { maxChars } = {}) {
    const r = this.guard.resolveReadable(args.path);
    if (r.reason === Reason.TOO_LARGE && r.path) return this.readLargeFile(r, args, maxChars);
    if (r.reason !== Reason.OK) return { error: describe(r.reason, args.path, this.guard.maxFileBytes) };
    let buf;
    try {
      buf = fs.readFileSync(r.path);
    } catch (e) {
      return { error: unreadable(e) ? `没有读权限：${this.guard.display(r.path)}` : `读不了 ${this.guard.display(r.path)}：${e.code || e.message}` };
    }
    const kind = classifyText(buf);
    let text = kind === 'gb18030' ? new TextDecoder('gb18030').decode(buf) : buf.toString('utf8');
    const badChars = kind === 'unknown' ? (text.match(/\ufffd/g) || []).length : 0;
    if (kind === 'binary' || (kind === 'unknown' && badChars > text.length / 10)) {
      return { error: `${this.guard.display(r.path)} 看起来是二进制文件（${formatBytes(buf.length)}，不是文本）：不读进上下文。要知道里面是什么，看文件名、来源，或者用能解析它的命令` };
    }
    const all = text.split('\n');
    if (text.endsWith('\n')) all.pop();
    const total = all.length;
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Math.min(READ_MAX_LINES, Number(args.limit) || READ_MAX_LINES));
    let slice = all.slice(offset - 1, offset - 1 + limit);
    const cap = Math.max(200, Math.min(READ_MAX_CHARS, Number(maxChars) || READ_MAX_CHARS));
    let chars = 0;
    let cut = slice.length;
    for (let i = 0; i < slice.length; i++) { chars += slice[i].length + 1; if (chars > cap) { cut = i; break; } }
    slice = slice.slice(0, Math.max(1, cut));
    // 一行就超过上限（压缩过的 js、生成的数据）：只给这一行的前一段，并且不算读全
    const longLine = slice.length === 1 && slice[0].length > cap ? slice[0].length : 0;
    if (longLine) slice[0] = slice[0].slice(0, cap);
    const end = offset - 1 + slice.length;
    const full = !longLine && offset === 1 && end >= total;
    const rel = this.guard.display(r.path);
    const prev = this.known.get(rel);
    const hash = sha(buf);
    // 不是 UTF-8 的不算读全：整份重写会把编码改掉（write_file 那边也会拒绝改它）
    const utf8 = kind === 'utf8';
    this.known.set(rel, { hash, full: utf8 && (full || Boolean(prev && prev.hash === hash && prev.full)) });
    const encodingNote = utf8 ? '' : `【这个文件不是 UTF-8，是 ${ENCODING_NAME[kind]}${kind === 'gb18030' ? '，已按它解码' : '，认不出的字节显示成 �'}；不能用 write_file 改它（会把编码改掉）—— 要改先和用户确认要不要转成 UTF-8】\n`;
    const header = longLine
      ? `【${rel} 第 ${offset} 行（共 ${total} 行）：这一行有 ${longLine} 字，只显示了前 ${cap} 字 —— 压缩过的 / 生成的文件不要整份重写，也别对着它改】`
      : full
        ? `【${rel}，共 ${total} 行】`
        : `【${rel} 第 ${offset}–${end} 行（共 ${total} 行）${end < total ? `；没读完，用 offset=${end + 1} 接着读` : ''}】`;
    return { content: `${encodingNote}${header}\n${slice.join('\n')}`, summary: `${full ? `${total} 行` : `第 ${offset}–${end} 行 / 共 ${total} 行`}${utf8 ? '' : `（${ENCODING_NAME[kind]}）`}` };
  }

  /** 太大的文件：流式读一段（offset < 0 读最后几行）。不算读全 —— 不能整份重写。 */
  readLargeFile(r, args, maxChars) {
    const rel = this.guard.display(r.path);
    const cap = Math.max(200, Math.min(READ_MAX_CHARS, Number(maxChars) || READ_MAX_CHARS));
    const limit = Math.max(1, Math.min(READ_MAX_LINES, Number(args.limit) || READ_MAX_LINES));
    const raw = Number(args.offset);
    const offset = raw < 0 ? Math.max(-READ_MAX_LINES, Math.trunc(raw)) : Math.max(1, Math.trunc(raw) || 1);
    let head;
    try {
      const probe = Buffer.alloc(8192);
      const fd = fs.openSync(r.path, 'r');
      try { fs.readSync(fd, probe, 0, 8192, 0); } finally { fs.closeSync(fd); }
      if (looksBinary(probe)) return { error: `${rel} 看起来是二进制文件（${formatBytes(r.size)}，不是文本）：不读进上下文` };
      head = readLarge(r.path, { offset, limit, cap });
    } catch (e) {
      return { error: unreadable(e) ? `没有读权限：${rel}` : `读不了 ${rel}：${e.code || e.message}` };
    }
    const n = head.lines.length;
    const where = head.first == null ? `最后 ${n} 行` : `第 ${head.first}–${head.first + n - 1} 行`;
    const next = head.first == null ? '' : head.eof ? '；已经到文件末尾' : `；用 offset=${head.first + n} 接着读`;
    return {
      content: `【${rel} ${where}（文件 ${formatBytes(r.size)}，太大，不能整份读${next}；offset=-100 看最后 100 行，search 找关键字）】\n${head.lines.join('\n')}`,
      summary: `${where} / ${formatBytes(r.size)}`,
    };
  }

  search(args = {}) {
    const query = args.query == null ? '' : String(args.query);
    if (!query) return { error: '没有给出要搜索的文字' };
    // path 可以是目录，也可以是一个文件（第十二轮：原来给文件报「不是一个普通文件」，模型以为搜索坏了、改成一段段读）
    const dir = this.guard.resolveDirectory(args.path);
    const single = dir.reason === Reason.OK ? null : this.guard.resolveReadable(args.path);
    if (dir.reason !== Reason.OK && single.reason !== Reason.OK) return { error: describe(dir.reason, args.path || '.') };
    const ic = Boolean(args.ignore_case);
    const needle = ic ? query.toLowerCase() : query;
    const hits = [];
    let files = 0;
    let truncated = null;
    // 跳过了什么要说出来（第十六轮）：原来太大的、读不了的一声不吭地跳过 —— 「1 处」其实是「在能看的那些里 1 处」，
    // 模型据此下「别处没有」的结论
    const skipped = { huge: [], binary: [], denied: 0 };
    const onLine = (file, lineNo, line) => {
      if (!(ic ? line.toLowerCase() : line).includes(needle)) return true;
      if (hits.length >= SEARCH_MAX_HITS) { truncated = `命中太多，只列出了前 ${SEARCH_MAX_HITS} 条`; return false; }
      const shown = line.length > SEARCH_MAX_LINE_CHARS ? `${line.slice(0, SEARCH_MAX_LINE_CHARS)}…` : line;
      // 保留缩进：模型常把搜到的那行直接拿去当 old_string，去掉缩进就对不上了
      hits.push(`${this.guard.display(file)}:${lineNo}: ${shown.trimEnd()}`);
      return true;
    };
    const scan = (file) => {
      let fd;
      try { fd = fs.openSync(file, 'r'); } catch (e) { if (unreadable(e)) skipped.denied += 1; return; }
      try {
        const buf = Buffer.alloc(CHUNK_BYTES);
        let decoder = null;
        let pos = 0;
        let lineNo = 1;
        let rest = '';
        for (;;) {
          const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, pos);
          if (n === 0) break;
          if (pos === 0) {
            const kind = classifyText(buf.subarray(0, n), { partial: n === CHUNK_BYTES });
            if (kind === 'binary') { skipped.binary.push(this.guard.display(file)); return; }
            // GBK 的文件按 GBK 解：原来当 UTF-8 解，里面的中文永远搜不到
            decoder = new TextDecoder(kind === 'gb18030' ? 'gb18030' : 'utf-8');
          }
          pos += n;
          const parts = (rest + decoder.decode(buf.subarray(0, n), { stream: true })).split('\n');
          rest = parts.pop();
          for (const line of parts) { if (!onLine(file, lineNo, line)) return; lineNo += 1; }
        }
        if (rest) onLine(file, lineNo, rest);
      } catch (e) {
        if (unreadable(e)) skipped.denied += 1;
      } finally {
        fs.closeSync(fd);
      }
    };
    const walk = (abs) => {
      let names;
      try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { if (unreadable(e)) skipped.denied += 1; return; }
      for (const d of names) {
        if (truncated) return;
        const child = path.join(abs, d.name);
        if (d.isSymbolicLink()) continue;
        if (d.isDirectory()) { if (!SKIPPED_DIRS.has(d.name)) walk(child); continue; }
        if (!this.guard.extensionAllowed(child)) continue;
        let st;
        try { st = fs.statSync(child); } catch { continue; }
        if (st.size > SEARCH_STREAM_MAX_BYTES) { skipped.huge.push(`${this.guard.display(child)}（${formatBytes(st.size)}）`); continue; }
        if (++files > SEARCH_MAX_FILES) { truncated = `文件太多，只搜了前 ${SEARCH_MAX_FILES} 个`; return; }
        scan(child);
      }
    };
    if (single) scan(single.path); else walk(dir.path);
    const body = hits.length ? hits.join('\n') : '（没有找到）';
    const notes = [];
    // 截断必须说出来：模型把「80 条」当成「一共 80 条」就会给出错误结论
    if (truncated) notes.push(`${truncated} —— 这不是全部结果，请缩小范围再搜`);
    if (skipped.huge.length) notes.push(`跳过了 ${skipped.huge.length} 个太大的文件（超过 ${formatBytes(SEARCH_STREAM_MAX_BYTES)}）：${skipped.huge.slice(0, 5).join('、')} —— 那里面有没有，没搜`);
    if (skipped.binary.length) notes.push(`跳过了 ${skipped.binary.length} 个二进制文件：${skipped.binary.slice(0, 5).join('、')}`);
    if (skipped.denied) notes.push(`有 ${skipped.denied} 个文件 / 目录没有读权限，没搜到里面`);
    const partial = truncated || skipped.huge.length || skipped.denied;
    return { content: notes.length ? `${body}\n${notes.map((n) => `（${n}）`).join('\n')}` : body,
      summary: `${hits.length} 处${truncated ? '（已截断）' : partial ? '（有没搜到的）' : ''}` };
  }

  // ── 写 ────────────────────────────────────────────────────────────────

  /** 落在 .zhiqu / .git 里就返回那个目录名。大小写不敏感：macOS 默认的文件系统上 .ZHIQU 就是 .zhiqu。 */
  protectedDir(abs) {
    const top = realRelative(this.root, abs).split('/')[0].toLowerCase();
    return PROTECTED_DIRS.has(top) ? top : null;
  }

  protectedError(dir, rel, verb) {
    return dir === '.zhiqu'
      ? `${rel} 在 .zhiqu 里 —— 那是命令行自己的配置（允许的命令、MCP 服务器、系统内容），不能由你来${verb}。要改的话，把要改成什么告诉用户，让用户自己改。`
      : `${rel} 在 .git 里 —— 那是版本库本身，不能由你来${verb}。`;
  }

  prepareWrite(args = {}) {
    const w = this.guard.resolveWritable(args.path);
    if (w.reason !== Reason.OK) return { error: describe(w.reason, args.path, this.guard.maxFileBytes) };
    const rel = this.guard.display(w.path);
    const guarded = this.protectedDir(w.path);
    if (guarded) return { error: this.protectedError(guarded, rel, '改') };
    const exists = fs.existsSync(w.path);
    // 太大的文件只能分段读，也就不能改（先读进整个文件再拒绝，几百 MB 就白占了内存）
    if (exists && fs.statSync(w.path).size > this.guard.maxFileBytes) {
      return { error: `${this.guard.display(w.path)} 太大（${formatBytes(fs.statSync(w.path).size)}，超过 ${formatBytes(this.guard.maxFileBytes)}）：只能分段读，不能用 write_file 改` };
    }
    const current = exists ? fs.readFileSync(w.path) : null;
    const currentKind = current ? classifyText(current) : 'utf8';
    if (currentKind !== 'utf8') {
      return { error: `${this.guard.display(w.path)} 不是 UTF-8 编码（${ENCODING_NAME[currentKind] || '二进制'}）：用 write_file 改会把整个文件的编码换掉，原来的中文就成了乱码。先和用户确认要不要转成 UTF-8（比如 iconv -f GB18030 -t UTF-8），转好再改` };
    }
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
    let replaced = 0;
    if (replacing) {
      if (!exists) return { error: `替换用法只能用在已存在的文件上：${rel} 不存在。新建文件请直接给 content。` };
      // 规矩与网页 code agent 同一套（edit.js / TextEdit.java，跑同一份 conformance/text-edit.json）
      const r = applyEdit(currentText, args.old_string, args.new_string, { replaceAll: Boolean(args.replace_all) });
      if (r.error) return { error: describeEditError(r.error, rel) };
      newText = r.text;
      replaced = r.replaced;
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
      rel, abs: w.path, kind, replaced, creating: !exists, oldText: currentText, newText, baseline: current ? sha(current) : null,
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
    const times = prep.replaced > 1 ? `，替换了 ${prep.replaced} 处` : '';
    // 写完立刻查语法（JSON / JS）：写坏了当场说，不等它接着写别的、跑起来才发现（见 syntax.js）
    const syntax = syntaxProblem(prep.abs, prep.rel, prep.newText);
    const warn = syntax ? `\n⚠ 写进去的内容有语法错误 —— 先修好它再做别的：\n${syntax}` : '';
    return { content: `${what} ${prep.rel}${dirs}（+${added} -${removed}${times}，现在共 ${lines} 行）${warn}`, summary: `+${added} -${removed}`, added, removed, syntax };
  }

  // ── 删除 ──────────────────────────────────────────────────────────────

  /**
   * 删除也分两步（中间是权限这一关）。规矩和改文件一样：这段会话里读过或写过、之后没被别人改过才能删 ——
   * 没看过就删，和没读过就改一样，是拿想象中的文件做决定。
   * 路径的判定就是写入那一套（工作区内、不跟软链、只许普通文件、扩展名白名单），外加 .git / .zhiqu 里的不许删。
   */
  prepareDelete(args = {}) {
    const w = this.guard.resolveWritable(args.path);
    if (w.reason !== Reason.OK) return { error: describe(w.reason, args.path, this.guard.maxFileBytes) };
    const rel = this.guard.display(w.path);
    const guarded = this.protectedDir(w.path);
    if (guarded) return { error: this.protectedError(guarded, rel, '删') };
    if (!fs.existsSync(w.path)) return { error: `${rel} 不存在，没什么可删的。` };
    const current = fs.readFileSync(w.path);
    const known = this.known.get(rel);
    if (!known) return { error: `删除一个文件之前必须先 read_file 看过它：${rel}。没看过就删，是拿想象中的文件做决定。` };
    if (known.hash !== sha(current)) return { error: `${rel} 在你读过之后被改过了（可能是用户在编辑器里改的），请重新 read_file 看过再决定删不删。` };
    const text = current.toString('utf8');
    return { rel, abs: w.path, baseline: known.hash, lines: lineCount(text), bytes: current.length };
  }

  commitDelete(prep) {
    const now = fs.existsSync(prep.abs) ? sha(fs.readFileSync(prep.abs)) : null;
    if (now !== prep.baseline) return { error: `${prep.rel} 在确认期间被改过了，没有删除。请重新读一遍再决定。` };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashed = path.join(this.root, '.zhiqu', 'trash', stamp, ...prep.rel.split('/'));
    fs.mkdirSync(path.dirname(trashed), { recursive: true });
    fs.renameSync(prep.abs, trashed);   // 同一个卷里改名：不是抹掉，挪回来就恢复
    this.known.delete(prep.rel);
    const where = this.guard.display(trashed);
    return { content: `已删除 ${prep.rel}（挪进了 ${where}，要恢复就挪回原处）`, trashed: where };
  }

  // ── 运行 ──────────────────────────────────────────────────────────────

  prepareRun(args = {}) {
    const argv = Array.isArray(args.args) ? args.args.map((a) => (a == null ? a : String(a))) : [];
    if (args.args != null && !Array.isArray(args.args)) {
      return { error: 'args 必须是数组，一项一个参数（不接受一整条 shell 命令）' };
    }
    const check = checkCommand(this.commands, args.command, argv);
    if (check.refusal !== ExecRefusal.OK) {
      const deleting = /^(rm|del|erase|rmdir|unlink)$/i.test(String(args.command || '').trim());
      return { error: describeRefusal(check, this.commands) + (deleting ? '删除文件用 delete_file（一次一个，删掉的挪进 .zhiqu/trash/，能恢复）。' : '') };
    }
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
