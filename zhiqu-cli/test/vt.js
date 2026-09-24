// 迷你终端模拟器（测试用）：逐字节执行输出，得到屏幕上最后显示的样子。
// 支持 readline 和 zhiqu 会发的那几种序列：可打印字符（中日韩两格）、\r、\n（按 ONLCR 当作 \r\n）、退格、
// CSI n A/B/C/D（光标上下左右）、CSI n G（到第 n 列）、CSI [0|2] J（清屏到底 / 全清）、CSI [0|2] K（清行）、
// CSI …m（颜色，忽略）、CSI ?…h/l（忽略）。自动换行按 xterm 的「延迟换行」：写满最后一列之后，下一个字符才换行。
import { displayWidth } from '../src/render/term.js';

export class Vt {
  constructor(cols = 40) {
    this.cols = cols;
    this.rows = [[]];      // 每行是一个格子数组；宽字符占两格，第二格放 null
    this.r = 0;
    this.c = 0;
    this.pendingWrap = false;
  }

  row(i) { while (this.rows.length <= i) this.rows.push([]); return this.rows[i]; }

  put(ch) {
    const w = displayWidth(ch) || 1;
    if (this.pendingWrap || this.c + w > this.cols) { this.r++; this.c = 0; this.pendingWrap = false; }
    const row = this.row(this.r);
    while (row.length < this.c) row.push(' ');
    row[this.c] = ch;
    if (w === 2) row[this.c + 1] = null;
    this.c += w;
    if (this.c >= this.cols) { this.c = this.cols - 1; this.pendingWrap = true; }
  }

  feed(data) {
    const s = String(data);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\u001b' && s[i + 1] === '[') {
        const m = /^\u001b\[([?0-9;]*)([A-Za-z])/.exec(s.slice(i));
        if (!m) continue;
        i += m[0].length - 1;
        this.csi(m[1], m[2]);
        continue;
      }
      if (ch === '\r') { this.c = 0; this.pendingWrap = false; continue; }
      // 真终端的输出端开着 ONLCR（libuv 的 raw 模式特意保留了它）：\n 会被转成 \r\n
      if (ch === '\n') { this.r++; this.c = 0; this.row(this.r); this.pendingWrap = false; continue; }
      if (ch === '\b') { this.c = Math.max(0, this.c - 1); this.pendingWrap = false; continue; }
      if (ch === '\u0007') continue;
      const cp = s.codePointAt(i);
      const full = String.fromCodePoint(cp);
      if (full.length === 2) i++;
      this.put(full);
    }
  }

  csi(params, cmd) {
    if (params.startsWith('?')) return;
    const n = params === '' ? 1 : Number(params.split(';')[0]) || (params === '0' ? 0 : 1);
    switch (cmd) {
      case 'A': this.r = Math.max(0, this.r - n); this.pendingWrap = false; break;
      case 'B': this.r += n; this.row(this.r); this.pendingWrap = false; break;
      case 'C': this.c = Math.min(this.cols - 1, this.c + n); this.pendingWrap = false; break;
      case 'D': this.c = Math.max(0, this.c - n); this.pendingWrap = false; break;
      case 'G': this.c = Math.max(0, n - 1); this.pendingWrap = false; break;
      case 'J': {
        const mode = params === '' ? 0 : Number(params);
        if (mode === 2) { this.rows = [[]]; this.r = 0; this.c = 0; break; }
        this.row(this.r).length = Math.min(this.row(this.r).length, this.c);
        this.rows.length = this.r + 1;
        break;
      }
      case 'K': {
        const mode = params === '' ? 0 : Number(params);
        if (mode === 2) this.rows[this.r] = [];
        else this.row(this.r).length = Math.min(this.row(this.r).length, this.c);
        break;
      }
      default: break;   // m（颜色）等
    }
  }

  /** 屏幕上的文字，一行一个字符串（去掉行尾空白，末尾的空行去掉）。 */
  lines() {
    const out = this.rows.map((row) => row.filter((x) => x !== null).map((x) => x ?? ' ').join('').replace(/\s+$/, ''));
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }
}
