// 逐行 diff（最长公共子序列），输出带上下文的分块 —— 与 Java 版 LineDiff、网页确认框同一个算法、同一个预算。
// 行数乘积超过预算就不逐行比，退回「整份新内容」并明说：O(n·m) 的表在大文件上会把终端卡住。
export const BUDGET = 2000 * 2000;

function split(text) {
  let s = text == null ? '' : String(text);
  if (s === '') return [];
  if (s.endsWith('\n')) s = s.slice(0, -1);
  return s.split('\n');
}

export function diff(oldText, newText) {
  const a = split(oldText);
  const b = split(newText);
  if (a.length * b.length > BUDGET) return null;
  const m = a.length; const n = b.length;
  const t = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  const out = [];
  let i = 0; let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) out.push(['-', a[i++]]);
    else out.push(['+', b[j++]]);
  }
  while (i < m) out.push(['-', a[i++]]);
  while (j < n) out.push(['+', b[j++]]);
  return out;
}

/** 可打印的分块：`@@ 第 N 行 @@` 起头，前后各带 context 行上下文；隔得近的并成一块。相同则返回 []。 */
export function hunks(oldText, newText, context = 3) {
  const ops = diff(oldText, newText);
  const out = [];
  if (ops == null) {
    out.push('（文件太大，不逐行比较 —— 以下是完整的新内容）');
    for (const line of split(newText)) out.push(`+${line}`);
    return out;
  }
  const oldNo = new Array(ops.length);
  let line = 1;
  for (let x = 0; x < ops.length; x++) {
    oldNo[x] = line;
    if (ops[x][0] !== '+') line++;
  }
  let x = 0;
  while (x < ops.length) {
    if (ops[x][0] === ' ') { x++; continue; }
    const from = Math.max(0, x - context);
    let lastChange = x;
    let y = x;
    while (y < ops.length) {
      if (ops[y][0] !== ' ') lastChange = y;
      else if (y - lastChange > 2 * context) break;
      y++;
    }
    const to = Math.min(ops.length, lastChange + context + 1);
    out.push(`@@ 第 ${oldNo[from]} 行 @@`);
    for (let z = from; z < to; z++) out.push(ops[z][0] + ops[z][1]);
    x = to;
  }
  return out;
}

/** 加了几行、删了几行。 */
export function stat(oldText, newText) {
  const ops = diff(oldText, newText);
  if (ops == null) return { added: split(newText).length, removed: split(oldText).length };
  let added = 0; let removed = 0;
  for (const [k] of ops) { if (k === '+') added++; else if (k === '-') removed++; }
  return { added, removed };
}
