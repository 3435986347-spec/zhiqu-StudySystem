// 终端的几样基础：上色（不是终端或设了 NO_COLOR 就不上色）、显示宽度（中文两格）、在同一行刷新的进度。
export function colorEnabled(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream && stream.isTTY);
}

export function painter(enabled) {
  const wrap = (open, close) => (s) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));
  return {
    enabled,
    bold: wrap(1, 22), dim: wrap(2, 22), italic: wrap(3, 23),
    red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), blue: wrap(34, 39),
    magenta: wrap(35, 39), cyan: wrap(36, 39), gray: wrap(90, 39),
  };
}

// 不占格的：组合附加符号（带声调的字母、Zalgo）、零宽空格 / 连接符、变体选择符。
// macOS 的文件名是 NFD —— café.md 里的 é 是 e + U+0301，这不是罕见情况（第二十轮）
const ZERO_WIDTH = /[\p{Mn}\p{Me}​-‍⁠︀-️]/u;

/** 一个字符（码点）占几格：中日韩全角、emoji 两格，组合符号零格。 */
export function charWidth(ch) {
  if (ZERO_WIDTH.test(ch)) return 0;
  const cp = ch.codePointAt(0);
  const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd);
  return wide ? 2 : 1;
}

/** 终端里占几格：中日韩全角两格，组合符号、ANSI 转义不占格。 */
export function displayWidth(s) {
  const plain = String(s).replace(/\u001b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of plain) w += charWidth(ch);
  return w;
}

/**
 * 一段不含换行的文字在 cols 列宽的终端里折成几行 —— 照终端自己折的方式数，不是「总宽 ÷ 列宽」。
 * 两格的字放不进这一行最后一格时，终端把它整个挪到下一行、这一行空一格；列宽是奇数、又全是中文时每一行都空一格，
 * 除法就一行比一行少算。活动区擦的时候按这个数往上挪，少算一行就留一行残影，每刷一次多一行（第二十轮 25 列实测：
 * 排队的一条中文消息刷了几次状态行，屏幕上留下五份）。多算则相反，把上面已经打印好的输出擦掉。
 * 写满最后一格时终端是「延迟换行」：不算多一行，下一个字到了才换。
 */
export function rowsIn(text, cols) {
  const plain = String(text).replace(/\u001b\[[0-9;]*m/g, '');
  let rows = 1;
  let col = 0;
  for (const ch of plain) {
    const w = charWidth(ch);
    if (!w) continue;
    if (col + w > cols) { rows++; col = 0; }
    col += w;
  }
  return rows;
}

export function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 同一行刷新的状态（「正在写 … 12.3KB」）。不是终端就只在开始和结束各打一行 ——
 * 管道里塞满 \r 的输出没法读。
 */
export class StatusLine {
  constructor(out = process.stdout) {
    this.out = out;
    this.tty = Boolean(out.isTTY);
    this.active = false;
    this.last = '';
  }
  set(text) {
    // 不是终端就不打：管道 / 日志里一行行「正在生成 … 12.3KB」只是噪音，结果行（⏺ / ⎿）已经说明了发生什么
    if (!this.tty) return;
    this.out.write(`\r\u001b[2K${text}`);
    this.active = true;
    this.last = text;
  }
  clear() {
    if (this.active && this.tty) this.out.write('\r\u001b[2K');
    this.active = false;
  }
}

/**
 * 送去终端之前，把控制字符换成看得见的写法（第十六轮）。文件名、文件内容、命令输出、模型的回答里都可能有 ESC ——
 * 原样打到终端上，它会被当成命令执行：变色、挪光标、清屏、改标题。一个叫「\x1b[2J.js」的文件，读它的时候屏幕就清空了。
 * 自己加的颜色（paint）在这之后才加，不受影响。
 * singleLine：换行也换成 ⏎（步骤标题、状态行只占一行，换行会把活动区撑乱）。
 * keepSgr：保留只改颜色的那种（ESC [ 数字 m）—— 给调用方已经上过色的文字用。
 */
export function termSafe(text, { singleLine = false, keepSgr = false } = {}) {
  let s = String(text == null ? '' : text).replace(/\r(?=\n|$)/g, '');
  const sgr = [];
  // 颜色码先换成私用区字符占位（不是控制字符，下一步不会被转义），转义完再换回来
  if (keepSgr) s = s.replace(/\u001b\[[0-9;]*m/g, (m) => { sgr.push(m); return `\ue000${sgr.length - 1}\ue001`; });
  s = s.replace(singleLine ? /[\u0000-\u001f\u007f-\u009f]/g : /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => {
    if (c === '\n') return '⏎';
    if (c === '\t') return ' ';
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
  if (keepSgr) s = s.replace(/\ue000(\d+)\ue001/g, (m, i) => (sgr[Number(i)] === undefined ? m : sgr[Number(i)]));
  return s;
}
