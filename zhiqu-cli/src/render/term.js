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

/** 终端里占几格：中日韩全角两格，ANSI 转义不占格。 */
export function displayWidth(s) {
  const plain = String(s).replace(/\u001b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
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
