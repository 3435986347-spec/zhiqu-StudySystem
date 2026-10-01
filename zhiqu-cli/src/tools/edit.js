// 「按原文替换一段」—— 纯函数，不碰文件。write_file 的替换用法走它；网页 code agent 的
// write_workspace_file 替换用法（TextEdit.java）是同一套规矩，两边跑同一份 conformance/text-edit.json。
//
// 规矩（第九轮定的，第十轮提成一处）：
//   - old_string 必须一字不差、只出现一次；出现几处时说出行号，replace_all 才全换；
//   - 全是 \r\n 的文件：在统一成 \n 的文本里比、换，写回去变回 \r\n（模型给的永远是 \n，原来多行的永远「没找到」）；
//     混着两种换行的不动它，照原样一字不差地比；
//   - 没找到时给线索：先按「忽略空白」找同样的几行（缩进、行尾空白、全角空格不一样），找到就说在第几行、原文是什么；
//     找不到再看第一行在哪（那段多半被改过了）。原来只回「没找到」，模型凭记忆再拼、又错，几轮之后放弃替换、整份重写。

// 两边一样的空白集合：写死，不用 \s —— JS 的 \s 与 Java 的 \s 范围不同，一致性用例会分叉
const WS = /[ \t\n\r\f\v\u00a0\u3000]+/g;
const squash = (line) => line.replace(WS, ' ').replace(/^ +| +$/g, '');
const SHOW_CHARS = 2000;

function occurrences(hay, needle) {
  const out = [];
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) out.push(at);
  return out;
}
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

function hintFor(text, needle) {
  const lines = text.split('\n');
  const want = needle.split('\n').map(squash);
  while (want.length && !want[0]) want.shift();
  while (want.length && !want[want.length - 1]) want.pop();
  if (!want.length) return null;
  const show = (from, to) => {
    const block = lines.slice(from, to).join('\n');
    return block.length > SHOW_CHARS ? `${block.slice(0, SHOW_CHARS)}\n…` : block;
  };
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, k) => squash(lines[i + k]) === w)) {
      return { kind: 'whitespace', from: i + 1, to: i + want.length, original: show(i, i + want.length) };
    }
  }
  const first = want[0];
  const near = lines.findIndex((l) => squash(l) === first || (first.length >= 8 && squash(l).includes(first)));
  return near >= 0 ? { kind: 'first_line', at: near + 1, current: show(near, near + want.length + 2) } : null;
}

/**
 * 在 text 里把 oldStr 换成 newStr。
 * 成功：{ text, replaced }；拒绝：{ error: { kind: 'empty_old' | 'not_found' | 'ambiguous', … } }。
 */
export function applyEdit(text, oldStr, newStr, { replaceAll = false } = {}) {
  const old = String(oldStr ?? '');
  if (!old) return { error: { kind: 'empty_old' } };
  const crlf = text.includes('\r\n') && !/(^|[^\r])\n/.test(text);
  const hay = crlf ? text.replace(/\r\n/g, '\n') : text;
  const needle = crlf ? old.replace(/\r\n/g, '\n') : old;
  const replacement = crlf ? String(newStr ?? '').replace(/\r\n/g, '\n') : String(newStr ?? '');
  const at = occurrences(hay, needle);
  if (!at.length) return { error: { kind: 'not_found', hint: hintFor(hay, needle) } };
  if (at.length > 1 && !replaceAll) return { error: { kind: 'ambiguous', count: at.length, lines: at.map((i) => lineAt(hay, i)) } };
  const next = at.length > 1 ? hay.split(needle).join(replacement) : hay.slice(0, at[0]) + replacement + hay.slice(at[0] + needle.length);
  return { text: crlf ? next.replace(/\n/g, '\r\n') : next, replaced: at.length };
}

/** 拒绝的原因说给模型听：说清在哪、原文是什么、该怎么改。 */
export function describeEditError(error, rel) {
  if (error.kind === 'empty_old') return 'old_string 不能为空';
  if (error.kind === 'ambiguous') {
    const where = error.lines.slice(0, 12).join('、');
    return `old_string 在 ${rel} 里出现了 ${error.count} 处（第 ${where}${error.lines.length > 12 ? ' …' : ''} 行）。`
      + '只改其中一处就多带几行上下文让它唯一；要全部替换就加 replace_all: true。';
  }
  const h = error.hint;
  if (h && h.kind === 'whitespace') {
    return `old_string 在 ${rel} 里没有一字不差的原文，但第 ${h.from}–${h.to} 行只差空白（缩进、空格或行尾空白不一样）。`
      + `那几行的原文是（照这个抄，缩进也要一样）：\n${h.original}`;
  }
  if (h && h.kind === 'first_line') {
    return `old_string 在 ${rel} 里没找到。它的第一行出现在第 ${h.at} 行，但后面对不上 —— 那一段可能已经被改过了。`
      + `第 ${h.at} 行起现在是：\n${h.current}\n先按现在的内容重新拼 old_string。`;
  }
  return `old_string 在 ${rel} 里没找到（空格、缩进、换行都要一字不差）。先 read_file 看一下现在的原文，不要凭记忆拼。`;
}
