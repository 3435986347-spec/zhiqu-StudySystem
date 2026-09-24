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
//
// ── 输入 / 弹出命令菜单（2026-09-25 用户要的）──────────────────────────────────────────
// 在主提示符上打 / 开头、还没打空格的一段，输入行上方弹出匹配的命令：↑↓ 选、回车执行、Tab 补全接着打参数、
// Esc 关掉；接着打字就接着筛。菜单就是「输入行上方的几行」，和活动区同一套擦 / 画 —— 空闲时临时建一块只放菜单的区域。
// 按键从 keypress 事件上截（把 readline 自己的监听器包一层），不碰 readline 的内部方法；菜单没开时一切照旧（↑↓ 翻历史）。
import readline from 'node:readline';
import { Markdown } from './render/markdown.js';
import { colorEnabled, displayWidth, painter } from './render/term.js';
import { matchCommands } from './commands.js';

const MENU_ROWS = 8;
const plain = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');

/** 截到终端宽度以内（按显示宽度，中文算两格），截了就加 …：菜单一项一行，说明太长折成几行的话菜单就散了。
 *  （擦除不靠它 —— 擦的时候本来就按每行实际折成几行算。） */
function fit(text, width) {
  if (displayWidth(text) <= width) return text;
  let out = '';
  for (const ch of text) {
    if (displayWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

export const PROMPT = '› ';

export class Ui {
  constructor({ input = process.stdin, output = process.stdout, color, interactive, commands = [] } = {}) {
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
    this.commands = commands;
    this.menu = null;        // { items, sel }：输入 / 时弹出的命令菜单
    this.idle = null;        // 空闲（没在干活）时只放菜单的那块区域，形状和 live 一样
    this.dismissed = null;   // Esc 关掉菜单时的那段输入：原样不再弹，接着打字才再弹
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
    if (this.interactive && this.commands.length) this.installMenuKeys();
  }

  // ── 命令菜单 ───────────────────────────────────────────────────────────

  installMenuKeys() {
    const input = this.input;
    const originals = input.listeners('keypress');
    input.removeAllListeners('keypress');
    input.on('keypress', (s, key) => {
      if (this.closed) return;
      if (this.menuKey(key || {})) return;
      for (const listener of originals) listener.call(input, s, key);
      this.afterKey();
    });
  }

  /** 菜单开着时的按键；返回 true = 这个键是菜单的，不交给 readline。 */
  menuKey(key) {
    if (!this.menu) return false;
    const { items } = this.menu;
    switch (key.name) {
      case 'up':
        this.menu.sel = (this.menu.sel - 1 + items.length) % items.length;
        this.repaint();
        return true;
      case 'down':
        this.menu.sel = (this.menu.sel + 1) % items.length;
        this.repaint();
        return true;
      case 'tab':
        this.setLine(`${items[this.menu.sel].name} `);
        this.menu = null;
        this.repaint();
        return true;
      case 'escape':
        this.dismissed = this.rl.line;
        this.menu = null;
        this.repaint();
        return true;
      case 'return':
      case 'enter': {
        // 回车 = 执行选中的那一个：先把输入换成它、收起菜单，再让 readline 照常提交
        const name = items[this.menu.sel].name;
        if (this.rl.line !== name) this.setLine(name);
        this.menu = null;
        this.repaint();
        return false;
      }
      default:
        return false;
    }
  }

  /** 每次按键之后：输入还是「/ 开头、没空格」就按它筛，否则收起菜单。 */
  afterKey() {
    if (!this.rl) return;
    const line = this.rl.line;
    if (this.dismissed !== null && line !== this.dismissed) this.dismissed = null;
    const atMainPrompt = this.live ? !this.live.question : plain(this.rl.getPrompt()) === plain(this.prompt);
    const items = atMainPrompt && line !== this.dismissed ? matchCommands(line, this.commands) : [];
    if (!items.length) {
      if (this.menu) { this.menu = null; this.repaint(); }
      return;
    }
    const current = this.menu && this.menu.items[this.menu.sel];
    const keep = current ? items.findIndex((c) => c.name === current.name) : -1;
    this.menu = { items, sel: keep >= 0 ? keep : 0 };
    this.repaint();
  }

  /** 把输入行换成 text（光标在末尾）。走 rl.write 这个公开接口。 */
  setLine(text) {
    this.rl.write(null, { ctrl: true, name: 'e' });
    this.rl.write(null, { ctrl: true, name: 'u' });
    this.rl.write(text);
  }

  menuLines() {
    if (!this.menu) return [];
    const { items, sel } = this.menu;
    const start = sel >= MENU_ROWS ? sel - MENU_ROWS + 1 : 0;
    const width = Math.max(...items.map((c) => c.name.length)) + 2;
    const room = this.cols() - 1;
    const lines = items.slice(start, start + MENU_ROWS).map((c, i) => {
      const on = start + i === sel;
      const text = fit(`${on ? '❯' : ' '} ${c.name.padEnd(width)}${c.desc}`, room);
      return on ? this.paint.cyan(text) : this.paint.dim(text);
    });
    const more = items.length > MENU_ROWS ? ` · 共 ${items.length} 个` : '';
    lines.push(this.paint.dim(fit(`  ↑↓ 选择 · 回车执行 · Tab 补全 · Esc 关闭${more}`, room)));
    return lines;
  }

  /** 菜单变了：把输入行上方那块区域重画。空闲时按需建一块只放菜单的区域，菜单收起就拆掉。 */
  repaint() {
    if (!this.live && !this.idle) {
      if (!this.menu) return;
      // 此刻屏幕上只有输入行：当它是一块「上方 0 行」的区域，擦掉输入行再连菜单一起画
      this.idle = { partial: '', status: '', question: this.rl.getPrompt(), drawn: true, rowsAbove: 0 };
    }
    this.eraseLive();
    this.drawLive();
    if (!this.live && !this.menu) this.idle = null;
  }

  onLine(line) {
    if (this.live) {
      // readline 在回车时已经写了 \r\n、把输入行留在了原处：先把「活动区 + 那一行」擦掉再重画。
      // 那一行的前缀是<b>当时显示的</b>那个 —— 正在问问题时是问题本身，长问题会折成几行，按「› 」算就擦少了
      const shown = this.live.question || this.prompt;
      this.eraseLive(this.rowsOf(shown + line));
      const w = this.waiters.find((x) => x.fresh) || (this.live.question ? null : this.waiters[0]);
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        const question = this.live.question;
        this.live.question = null;
        if (question) {
          // 问题连同回答留在屏幕上：批准了什么计划、同意写了哪个文件，事后翻得到。
          // 原来整行跟着活动区一起擦掉，一个字不留。流式输出停在半行时先换行，免得回答粘在那半行后面
          this.write(`${this.live.partial ? '\n' : ''}${question}${line}\n`);
        } else {
          this.drawLive();
        }
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
    const l = this.live || this.idle;
    const lines = [];
    if (l.partial) lines.push(l.partial);
    if (this.live) for (const q of this.queue) lines.push(this.paint.dim(`⋯ 排队：${q.length > 60 ? `${q.slice(0, 60)}…` : q}`));
    if (l.status) lines.push(l.status);
    return lines.concat(this.menuLines());
  }

  /** 擦掉活动区。extraRows：readline 回车时已经往下走的那几行。 */
  eraseLive(extraRows = 0) {
    const l = this.live || this.idle;
    if (!l || !l.drawn) return;
    let up = l.rowsAbove + extraRows;
    if (!extraRows && this.rl) up += this.rl.getCursorPos().rows;
    if (up > 0) this.output.write(`\u001b[${up}A`);
    this.output.write('\r\u001b[J');
    l.drawn = false;
  }

  drawLive() {
    const l = this.live || this.idle;
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
    if (!this.live) {
      if (this.idle) {
        // 空闲时菜单开着又要打印（比如 Ctrl+C 的提示）：先收起菜单，打完再把输入行画回来
        this.menu = null;
        this.eraseLive();
        this.idle = null;
        this.output.write(text);
        this.rl.prevRows = 0;
        this.rl.prompt(true);
        return;
      }
      this.output.write(text);
      return;
    }
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
