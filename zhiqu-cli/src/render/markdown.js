// 在终端里流式渲染模型的 Markdown 回答（与 Java 版 CliMarkdown 同一套规则）。
//
// 两种输出：color=true（交互终端）标题加粗、列表圆点、代码块加框、表格按列对齐、行内加粗 / 代码上色；
// color=false（被管道接走、NO_COLOR）输出纯文本 —— 标记去掉，结构保留。
//
// 流式怎么不卡：普通段落边收边出，行内的 ** / ` 用小状态机处理（标记被拆在两次增量之间也不会错）；
// 只有要看全才能排版的才攒 —— 表格攒到表结束再按列对齐，其余块攒到一行结束。
import { displayWidth, termSafe } from './term.js';

const BLOCK_START = /^(#{1,6}|\||`{1,3}|[-*+](\s|$)|>|\d+[.)]|-{2,}|\*{2,}|_{3,})/;

export class Markdown {
  constructor(write, color) {
    this.write = write;          // (text) => void
    this.color = color;
    this.line = '';
    this.streamingParagraph = false;
    this.inCode = false;
    this.table = [];
    this.bold = false;
    this.inlineCode = false;
    this.pendingStar = false;
    this.wroteAnything = false;
  }

  feed(delta) {
    if (!delta) return;
    // 模型的回答里也可能带控制字符（它读过的文件里就有）：原样打到终端会被执行（第十六轮）
    for (const c of termSafe(delta)) {
      if (c === '\r') continue;
      if (c === '\n') { this.endLine(); continue; }
      if (this.streamingParagraph) this.inline(c);
      else { this.line += c; this.decideParagraph(); }
    }
  }

  finish() {
    if (this.streamingParagraph || this.line.length > 0) this.endLine();
    this.flushTable();
    if (this.inCode) { this.println(this.dim('└─')); this.inCode = false; }
  }

  out(s) { this.wroteAnything = true; this.write(s); }
  println(s = '') { this.out(`${s}\n`); }
  dim(s) { return this.color ? `\u001b[2m${s}\u001b[0m` : s; }

  decideParagraph() {
    if (this.inCode || this.table.length) return;
    const s = this.line;
    const t = s.trimStart();
    if (t === '') return;
    if (BLOCK_START.test(t) || couldStillBeBlock(t)) return;
    this.streamingParagraph = true;
    this.line = '';
    for (const c of s) this.inline(c);
  }

  endLine() {
    if (this.streamingParagraph) {
      this.closeInline();
      this.println();
      this.streamingParagraph = false;
      return;
    }
    const s = this.line;
    this.line = '';
    this.block(s);
  }

  block(s) {
    const t = s.trim();
    if (this.inCode) {
      if (t.startsWith('```')) { this.println(this.dim('└─')); this.inCode = false; }
      else this.println(this.dim('│ ') + s);
      return;
    }
    if (t.startsWith('|')) { this.table.push(t); return; }
    this.flushTable();
    if (t.startsWith('```')) {
      const lang = t.slice(3).trim();
      this.println(this.dim(`┌─${lang ? ` ${lang}` : ''}`));
      this.inCode = true;
      return;
    }
    if (t === '') { this.println(); return; }
    let m = /^(#{1,6})\s+(.*)$/.exec(t);
    if (m) { const text = this.inlineAll(m[2]); this.println(this.color ? `\u001b[1m${text}\u001b[0m` : text); return; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { this.println(this.dim('────────────')); return; }
    m = /^(\s*)[-*+]\s+(.*)$/.exec(s);
    if (m) { this.println(`${m[1]}  • ${this.inlineAll(m[2])}`); return; }
    m = /^(\s*)(\d+[.)])\s+(.*)$/.exec(s);
    if (m) { this.println(`${m[1]}  ${m[2]} ${this.inlineAll(m[3])}`); return; }
    if (t.startsWith('>')) { this.println(this.dim('│ ') + this.inlineAll(t.slice(1).trimStart())); return; }
    this.println(this.inlineAll(s));
  }

  flushTable() {
    if (!this.table.length) return;
    const rows = this.table.map((r) => {
      let body = r.trim();
      if (body.startsWith('|')) body = body.slice(1);
      if (body.endsWith('|')) body = body.slice(0, -1);
      return body.split('|').map((c) => this.inlineAll(c.trim()));
    });
    this.table = [];
    const isSep = (r) => r.length > 0 && r.every((c) => /^:?-{2,}:?$/.test(c));
    const cols = Math.max(...rows.map((r) => r.length));
    const width = new Array(cols).fill(0);
    for (const r of rows) {
      if (isSep(r)) continue;
      r.forEach((c, i) => { width[i] = Math.max(width[i], displayWidth(c)); });
    }
    const header = rows.length > 1 && isSep(rows[1]);
    rows.forEach((r, ri) => {
      if (isSep(r)) {
        this.println(this.dim(width.map((w) => '─'.repeat(w)).join('─┼─')));
        return;
      }
      let row = '';
      for (let i = 0; i < cols; i++) {
        const cell = r[i] || '';
        if (i > 0) row += this.dim(' │ ');
        const padded = cell + ' '.repeat(Math.max(0, width[i] - displayWidth(cell)));
        row += header && ri === 0 && this.color ? `\u001b[1m${padded}\u001b[0m` : padded;
      }
      this.println(row.trimEnd());
    });
  }

  inlineAll(s) {
    let r = s;
    r = r.replace(/\[([^\]]+)]\(([^)]+)\)/g, this.color ? '$1 \u001b[2m($2)\u001b[0m' : '$1 ($2)');
    r = r.replace(/\*\*([^*]+)\*\*/g, this.color ? '\u001b[1m$1\u001b[0m' : '$1');
    r = r.replace(/`([^`]+)`/g, this.color ? '\u001b[36m$1\u001b[0m' : '$1');
    return r;
  }

  inline(c) {
    if (this.pendingStar) {
      this.pendingStar = false;
      if (c === '*') {
        this.bold = !this.bold;
        if (this.color) this.out(this.bold ? '\u001b[1m' : '\u001b[22m');
        return;
      }
      this.out('*');
    }
    if (c === '*' && !this.inlineCode) { this.pendingStar = true; return; }
    if (c === '`') {
      this.inlineCode = !this.inlineCode;
      if (this.color) this.out(this.inlineCode ? '\u001b[36m' : '\u001b[39m');
      return;
    }
    this.out(c);
  }

  closeInline() {
    if (this.pendingStar) { this.out('*'); this.pendingStar = false; }
    if (this.color && (this.bold || this.inlineCode)) this.out('\u001b[0m');
    this.bold = false;
    this.inlineCode = false;
  }
}

function couldStillBeBlock(t) {
  return t.length < 4 && /^[#\-*`|>+_\d.)]+$/.test(t);
}
