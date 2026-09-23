// 终端交互：读一行、问 y/n、画每一步、流式渲染回答。
//
// 输入用自己的行队列而不是 rl.question：从管道喂输入时（测试、脚本），行可能在还没问的时候就到了，
// rl.question 会把它们丢掉。队列里有就直接拿，没有就等下一行；输入结束（EOF）返回 null。
import readline from 'node:readline';
import { Markdown } from './render/markdown.js';
import { colorEnabled, painter, StatusLine } from './render/term.js';

export class Ui {
  constructor({ input = process.stdin, output = process.stdout, color } = {}) {
    this.input = input;
    this.output = output;
    this.color = color ?? colorEnabled(output);
    this.paint = painter(this.color);
    this.status = new StatusLine(output);
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.onInterrupt = null;
    this.interactive = Boolean(input.isTTY);
  }

  start() {
    if (this.rl) return;
    this.rl = readline.createInterface({ input: this.input, output: this.output, terminal: this.interactive, historySize: 200 });
    this.rl.on('line', (line) => {
      const w = this.waiters.shift();
      if (w) w(line); else this.queue.push(line);
    });
    this.rl.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
    this.rl.on('SIGINT', () => {
      if (this.onInterrupt) this.onInterrupt();
    });
  }

  /** 读一行；输入结束返回 null。 */
  ask(prompt = '') {
    this.start();
    this.status.clear();
    if (this.queue.length) {
      const line = this.queue.shift();
      if (prompt && !this.interactive) this.output.write(`${prompt}${line}\n`);
      return Promise.resolve(line);
    }
    if (this.closed) return Promise.resolve(null);
    if (this.interactive) { this.rl.setPrompt(prompt); this.rl.prompt(); } else if (prompt) this.output.write(prompt);
    return new Promise((resolve) => {
      this.waiters.push((line) => {
        if (!this.interactive && line != null) this.output.write(`${line}\n`);
        resolve(line);
      });
    });
  }

  /** 问一个单字母的选择；输入结束、或者回答不在选项里时返回 fallback。 */
  async choose(question, options, fallback) {
    const line = await this.ask(`${question} ${options.map((o) => this.paint.bold(`[${o.key}]`) + ` ${o.label}`).join('  ')} › `);
    if (line == null) return fallback;
    const k = line.trim().toLowerCase();
    const hit = options.find((o) => o.key === k || (o.aliases || []).includes(k));
    return hit ? hit.key : (k === '' ? fallback : fallback);
  }

  write(text) { this.status.clear(); this.output.write(text); }
  line(text = '') { this.write(`${text}\n`); }
  note(text) { this.line(this.paint.dim(text)); }
  warn(text) { this.line(this.paint.yellow(`! ${text}`)); }
  error(text) { this.line(this.paint.red(`✗ ${text}`)); }
  step(text) { this.line(`${this.paint.cyan('⏺')} ${text}`); }
  result(text, ok = true) { this.line(`  ${this.paint.dim('⎿')} ${ok ? text : this.paint.red(text)}`); }

  markdown() {
    return new Markdown((s) => { this.status.clear(); this.output.write(s); }, this.color);
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
    this.status.clear();
    if (this.rl) this.rl.close();
  }
}
