// 终端交互：读一行、问 y/n、画每一步、流式渲染回答。
//
// 输入用自己的行队列而不是 rl.question：从管道喂输入时（测试、脚本），行可能在还没问的时候就到了，
// rl.question 会把它们丢掉。队列里有就直接拿，没有就等下一行；输入结束（EOF）返回 null。
//
// ── 输入框一直在（2026-09-24 用户要的）─────────────────────────────────────────────
// 原来 agent 干活的时候 › 提示符就没了，可键盘照样能打字，打的字散落在输出中间，很突兀。
// 现在交互终端里，一轮开始后底部固定一块「活动区」：
//
//     …已经打印完的输出（永久，往上滚）…
//     正在流式输出、还没换行的那一行          ← 活动区
//     ⋯ 排队：你在它干活时发的消息
//     … 等待模型回复 5s                      （状态行）
//     › 你正在打的字                          （readline 的输入行，光标在这里）
//
// 每次有输出：先擦掉活动区（光标上移到它的顶部、清到屏幕底），把成行的输出永久打印上去，再把活动区画回来；
// 输入行交给 readline 自己重画（它知道光标在哪、字打到哪）。工作时按回车 = 排队，这一轮结束后自动发出。
// 管道输入（测试、脚本）不走这一套 —— 那里没有光标可管。
import readline from 'node:readline';
import { Markdown } from './render/markdown.js';
import { colorEnabled, displayWidth, painter } from './render/term.js';

export const PROMPT = '› ';

export class Ui {
  constructor({ input = process.stdin, output = process.stdout, color, interactive } = {}) {
    this.input = input;
    this.output = output;
    this.color = color ?? colorEnabled(output);
    this.paint = painter(this.color);
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.onInterrupt = null;
    this.interactive = interactive ?? Boolean(input.isTTY && output.isTTY);
    this.live = null;        // { partial, status, question, queuedShown }
    this.prompt = PROMPT;
    const self = this;
    this.status = {
      set(text) { self.setStatus(text); },
      clear() { self.setStatus(''); },
    };
  }

  start() {
    if (this.rl) return;
    this.rl = readline.createInterface({ input: this.input, output: this.output, terminal: this.interactive, historySize: 200 });
    this.rl.on('line', (line) => this.onLine(line));
    this.rl.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.resolve(null);
    });
    this.rl.on('SIGINT', () => {
      if (this.onInterrupt) this.onInterrupt();
    });
  }

  onLine(line) {
    if (this.live) {
      // readline 在回车时已经写了 \r\n、把输入行留在了原处：先把「活动区 + 那一行」擦掉再重画
      const submittedRows = this.rowsOf(this.prompt + line);
      this.eraseLive(submittedRows);
      const w = this.waiters.find((x) => x.fresh) || (this.live.question ? null : this.waiters[0]);
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        this.live.question = null;
        this.drawLive();
        w.resolve(line);
        return;
      }
      if (line.trim()) this.queue.push(line);
      this.drawLive();
      return;
    }
    const w = this.waiters.shift();
    if (w) w.resolve(line); else this.queue.push(line);
  }

  // ── 读输入 ─────────────────────────────────────────────────────────────

  /**
   * 读一行；输入结束返回 null。
   * fresh：只要问出来之后新打的那一行（权限确认用）—— 工作时排队的消息不是对「写入 a.js？」的回答。
   * 管道输入没有「排队」这回事，一律按顺序拿。
   */
  ask(prompt = '', { fresh = false } = {}) {
    this.start();
    const useQueue = !(fresh && this.interactive);
    if (useQueue && this.queue.length) {
      const line = this.queue.shift();
      if (prompt && !this.interactive) this.output.write(`${prompt}${line}\n`);
      return Promise.resolve(line);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = {
        fresh: fresh && this.interactive,
        resolve: (line) => {
          if (!this.interactive && line != null) this.output.write(`${line}\n`);
          resolve(line);
        },
      };
      this.waiters.push(waiter);
      if (this.live) {
        this.eraseLive();
        this.live.question = prompt;
        this.drawLive();
      } else if (this.interactive) {
        this.rl.setPrompt(prompt || this.prompt);
        this.rl.prompt();
      } else if (prompt) {
        this.output.write(prompt);
      }
    });
  }

  /** 问一个单字母的选择；输入结束、或者回答不在选项里时返回 fallback。 */
  async choose(question, options, fallback) {
    const line = await this.ask(`${question} ${options.map((o) => this.paint.bold(`[${o.key}]`) + ` ${o.label}`).join('  ')} › `, { fresh: true });
    if (line == null) return fallback;
    const k = line.trim().toLowerCase();
    const hit = options.find((o) => o.key === k || (o.aliases || []).includes(k));
    return hit ? hit.key : fallback;
  }

  /** 排队中的消息（工作时按回车发的）；下一轮要用。 */
  takeQueued() {
    return this.queue.shift();
  }

  // ── 活动区 ─────────────────────────────────────────────────────────────

  beginLive() {
    if (!this.interactive) return;
    this.start();
    this.live = { partial: '', status: '', question: null, drawn: false, rowsAbove: 0 };
    this.drawLive();
  }

  endLive() {
    if (!this.live) return;
    this.eraseLive();
    const partial = this.live.partial;
    this.live = null;
    if (partial) this.output.write(`${partial}\n`);
  }

  cols() {
    return Math.max(10, this.output.columns || 80);
  }

  /** 一段不含换行的文字在终端里占几行。 */
  rowsOf(text) {
    const w = displayWidth(String(text));
    return Math.max(1, Math.ceil(w / this.cols()));
  }

  aboveLines() {
    const l = this.live;
    const lines = [];
    if (l.partial) lines.push(l.partial);
    for (const q of this.queue) lines.push(this.paint.dim(`⋯ 排队：${q.length > 60 ? `${q.slice(0, 60)}…` : q}`));
    if (l.status) lines.push(l.status);
    return lines;
  }

  /** 擦掉活动区。extraRows：readline 回车时已经往下走的那几行。 */
  eraseLive(extraRows = 0) {
    const l = this.live;
    if (!l || !l.drawn) return;
    let up = l.rowsAbove + extraRows;
    if (!extraRows && this.rl) up += this.rl.getCursorPos().rows;
    if (up > 0) this.output.write(`\u001b[${up}A`);
    this.output.write('\r\u001b[J');
    l.drawn = false;
  }

  drawLive() {
    const l = this.live;
    if (!l) return;
    const above = this.aboveLines();
    for (const line of above) this.output.write(`${line}\n`);
    l.rowsAbove = above.reduce((n, line) => n + this.rowsOf(line), 0);
    // 输入行交给 readline 画：它的 prevRows 以为光标在输入行的某一行，而我们刚把光标放在了新的一行行首
    this.rl.prevRows = 0;
    this.rl.setPrompt(l.question || this.prompt);
    this.rl.prompt(true);
    l.drawn = true;
  }

  setStatus(text) {
    if (!this.live) return;       // 不是交互终端就不打：管道 / 日志里一行行「正在生成 …」只是噪音
    if (this.live.status === text) return;
    this.eraseLive();
    this.live.status = text;
    this.drawLive();
  }

  // ── 输出 ───────────────────────────────────────────────────────────────

  write(text) {
    if (!this.live) { this.output.write(text); return; }
    this.eraseLive();
    const all = this.live.partial + text;
    const nl = all.lastIndexOf('\n');
    if (nl >= 0) this.output.write(all.slice(0, nl + 1));
    this.live.partial = all.slice(nl + 1);
    this.drawLive();
  }

  line(text = '') { this.write(`${text}\n`); }
  note(text) { this.line(this.paint.dim(text)); }
  warn(text) { this.line(this.paint.yellow(`! ${text}`)); }
  error(text) { this.line(this.paint.red(`✗ ${text}`)); }
  step(text) { this.line(`${this.paint.cyan('⏺')} ${text}`); }
  result(text, ok = true) { this.line(`  ${this.paint.dim('⎿')} ${ok ? text : this.paint.red(text)}`); }

  markdown() {
    return new Markdown((s) => this.write(s), this.color);
  }

  /** diff 分块：+ 绿、- 红、@@ 灰。最多 maxLines 行，多了说还有几行。 */
  diff(lines, maxLines = 200) {
    const shown = lines.slice(0, maxLines);
    for (const l of shown) {
      if (l.startsWith('@@')) this.line(`    ${this.paint.dim(l)}`);
      else if (l.startsWith('+')) this.line(`    ${this.paint.green(l)}`);
      else if (l.startsWith('-')) this.line(`    ${this.paint.red(l)}`);
      else this.line(`    ${this.paint.dim(l)}`);
    }
    if (lines.length > maxLines) this.line(`    ${this.paint.dim(`…还有 ${lines.length - maxLines} 行`)}`);
  }

  close() {
    this.endLive();
    if (this.rl) this.rl.close();
  }
}
