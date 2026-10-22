// 知识 Wiki 的编辑内核验证版（第七十轮，docs/rounds/round-70.md）：CodeMirror 6 的「实时预览」。
// Markdown 原文是唯一的真相：编辑器只决定怎么显示，不改写 —— 不改内容就保存，回来是一模一样的字节
//（现在的 contentEditable 编辑器保存时要把 HTML 转回 Markdown，嵌套列表、代码块语言、表格对齐、硬换行都会丢）。
// 光标不在的地方藏语法、显示成品（标题、加粗、斜体、删除线、行内代码、链接、[[双链]]、公式、任务勾选），光标进去才露出原文。
// 第七十三轮补齐：下划线 <u>、图片（粘贴 / 拖进走同一个上传，显示成图）、表格（光标不在时画成表格）、代码块着色（和阅读模式同一套）、
// 段落格式下拉和 ⌘B / ⌘I / ⌘U、阅读模式里点哪个字进编辑光标就落在原文那个字上（anchorFromCaret → sourcePosition）。
// 第八十轮起是默认的编辑器（试用开关去掉；加载不上时退回原来的 contentEditable）。阅读模式照旧用 renderMarkdown。
import {
  EditorState, EditorSelection, StateField, Compartment, EditorView, Decoration, ViewPlugin, WidgetType, keymap, drawSelection,
  defaultKeymap, history, historyKeymap, indentWithTab, syntaxTree, syntaxHighlighting, HighlightStyle, LanguageSupport,
  markdownLanguage, insertNewlineContinueMarkup, deleteMarkupBackward, autocompletion, completionKeymap, tags
} from './vendor/codemirror/codemirror.js';

// ── 纯文本扫描（node 里能跑的部分） ─────────────────────────────────────

/** [[目标]]、[[目标|显示]]、![[嵌入]]；反斜杠转义的不算 */
export function wikiLinkRanges(text, offset = 0) {
  const out = [];
  const re = /(!?)\[\[([^\]\n]+?)\]\]/g;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > 0 && text[m.index - 1] === '\\') continue;
    const raw = m[2]; const bar = raw.indexOf('|');
    const target = (bar >= 0 ? raw.slice(0, bar) : raw).trim();
    out.push({ from: offset + m.index, to: offset + m.index + m[0].length, target, label: (bar >= 0 ? raw.slice(bar + 1) : raw).trim(), embed: m[1] === '!' });
  }
  return out;
}

/** 行内公式 $…$：两边不贴空格、不是 $$、没被转义（和 renderMarkdown 认的写法一致） */
export function inlineMathRanges(text, offset = 0) {
  const out = [];
  const re = /(^|[^\\\x24])\x24(?!\s)([^\x24\n]+?)(?<!\s)\x24(?!\x24)/g;   // \x24 就是 $
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
    out.push({ from: offset + start, to: offset + m.index + m[0].length, tex: m[2] });
  }
  return out;
}

/** 块公式：单独一行的 $$ 到下一个单独一行的 $$ */
export function blockMathRanges(text) {
  const out = [];
  const lines = text.split('\n');
  let pos = 0; let open = null;
  for (const line of lines) {
    if (line.trim() === '$$') {
      if (open == null) open = pos;
      else { out.push({ from: open, to: pos + line.length, tex: text.slice(text.indexOf('\n', open) + 1, pos - 1) }); open = null; }
    }
    pos += line.length + 1;
  }
  return out;
}

/** 选区两边加 / 去标记（加粗 **、斜体 *、行内代码 `、下划线 <u> </u>）：已经包着就去掉，没有就加上；返回 CodeMirror 的 changes 和新选区 */
export function toggleWrap(text, from, to, open, close = open) {
  const before = text.slice(Math.max(0, from - open.length), from); const after = text.slice(to, to + close.length);
  if (before === open && after === close) {
    return { changes: [{ from: from - open.length, to: from, insert: '' }, { from: to, to: to + close.length, insert: '' }],
      anchor: from - open.length, head: to - open.length };
  }
  return { changes: [{ from, insert: open }, { from: to, insert: close }], anchor: from + open.length, head: to + open.length };
}

/** 百分号编码一个字符（插入链接用） */
const percent = (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase();

/**
 * 插入链接（第七十四轮 review：原来选中的字被网址整个换掉）：选中了字就拿它做链接文字，没选就用网址；方括号、换行换成空格，链接不断。
 * 网址照浏览器的规范写法（new URL：路径里的反斜杠就是 /、中文转码；IPv6 的 [::1] 和查询里的 a[]=1 原样，方括号在网址里不断链接），
 * 再把圆括号写成 %28 / %29（不成对的 ) 会提前把链接收尾）、查询和锚点里剩下的反斜杠写成 %5C（结尾的 \ 会把 ) 转义掉）。
 * 没选字时网址做链接文字，里面的方括号写成 %5B / %5D（链接文字里的 ] 会把文字提前收尾）；链接文字以反斜杠结尾时补一个空格。
 */
export function linkMarkdown(selected, href) {
  let url;
  try { url = new URL(String(href)).href; } catch (e) { url = String(href); }
  const target = url.replace(/[()\\]/g, percent);
  let label = String(selected || '').replace(/[[\]\r\n]/g, ' ');
  if (!label.trim()) label = String(href).replace(/[[\]]/g, percent);
  if (label.endsWith('\\')) label += ' ';
  return '[' + label + '](' + target + ')';
}

/** 加粗 / 斜体 / 下划线的快捷键（第七十三轮：contentEditable 里是浏览器自己做的，CodeMirror 里要自己接；和工具栏同一个 toggleWrap） */
export const FORMAT_KEYS = [{ key: 'Mod-b', open: '**' }, { key: 'Mod-i', open: '*' }, { key: 'Mod-u', open: '<u>', close: '</u>' }];

/** 段落格式（工具栏的下拉，第七十三轮）：选中的几行换成标题 / 引用 / 无序 / 有序 / 任务 / 正文 —— 换掉行首原来的符号、留着列表的缩进；
 *  代码块在上下加 ``` 围栏，分隔线在这一行后面另起一行。返回 CodeMirror 的 changes（按位置排好） */
export function setBlock(text, from, to, kind) {
  const lineStart = (pos) => text.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = (pos) => { const i = text.indexOf('\n', pos); return i < 0 ? text.length : i; };
  const first = lineStart(from), last = lineEnd(to > from && text[to - 1] === '\n' ? to - 1 : to);
  if (kind === 'CODE') return [{ from: first, insert: '```\n' }, { from: last, insert: '\n```' }];
  if (kind === 'HR') return [{ from: last, insert: '\n\n---' }];
  const heading = /^H([1-6])$/.exec(kind);
  const out = []; let n = 0;
  for (let pos = first; pos <= last;) {
    const end = lineEnd(pos), line = text.slice(pos, end);
    const m = /^(\s*)(#{1,6}\s+|>\s?|[-*]\s+\[[ xX]\]\s+|[-*]\s+|\d+[.)]\s+)?/.exec(line);
    const next = heading ? '#'.repeat(+heading[1]) + ' ' : kind === 'QUOTE' ? '> ' : kind === 'UL' ? '- ' : kind === 'OL' ? (++n) + '. ' : kind === 'TASK' ? '- [ ] ' : '';
    // 标题、引用只能顶格；空行不加符号（只有一行时照加，光标在空行上选「标题」就是要开一个标题）
    if (line.trim() || first === last) out.push({ from: pos, to: pos + m[1].length + (m[2] || '').length, insert: (heading || kind === 'QUOTE' ? '' : m[1]) + next });
    pos = end + 1;
  }
  return out;
}

/** 行内代码 `…` 占的范围（里面的 <u>、$ 都是字面量） */
function codeSpans(text) {
  const out = []; const re = /`[^`\n]+`/g; let m;
  while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** <u>…</u>（第七十三轮：工具栏的下划线）：from / to 是整段，openTo / closeFrom 是里面的字；行内代码里的不算 */
export function underlineRanges(text, offset = 0) {
  const out = []; const code = codeSpans(text); const re = /<u>([^<\n]*?)<\/u>/g; let m;
  while ((m = re.exec(text))) {
    if (code.some(([a, b]) => m.index < b && m.index + m[0].length > a)) continue;
    out.push({ from: offset + m.index, openTo: offset + m.index + 3, closeFrom: offset + m.index + 3 + m[1].length, to: offset + m.index + m[0].length });
  }
  return out;
}

/** 按行走一遍，跳过 ``` 代码块和 $$ 公式块（和 renderMarkdown 认的一样）；visit(line, pos, kind)，kind 是 'text' / 'code' */
function eachLine(text, visit) {
  let pos = 0, fence = false, math = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^```/.test(t)) fence = !fence;
    else if (fence) visit(line, pos, 'code');
    else if (math) { if (/\$\$\s*$/.test(t)) math = false; }
    else if (/^\x24\x24(.+)\x24\x24$/.test(t)) { /* 单行的块公式（\x24 就是 $） */ }
    else if (/^\$\$/.test(t)) math = true;
    else visit(line, pos, 'text');
    pos += line.length + 1;
  }
}

/** 表格：连续的 | … | 行（和 renderMarkdown 一样认，一行也算），代码块、公式块里的不算 */
export function tableRanges(text) {
  const out = []; let open = null, prevEnd = -1;
  eachLine(text, (line, pos, kind) => {
    const row = kind === 'text' && /^\|.*\|\s*$/.test(line.trim());
    if (row && open && pos === prevEnd + 1) open.to = pos + line.length;
    else if (row) { open = { from: pos, to: pos + line.length }; out.push(open); }
    else open = null;
    prevEnd = pos + line.length;
  });
  return out;
}

/** 原文里每个任务的 [ ] / [x] 在哪（按顺序；和阅读模式里的勾选框一一对应），代码块里的不算 */
export function taskMarkerPositions(text) {
  const out = [];
  eachLine(text, (line, pos, kind) => {
    const m = kind === 'text' && /^(\s*[-*]\s+)\[[ xX]\]\s+\S/.exec(line);
    if (m) out.push(pos + m[1].length);
  });
  return out;
}

// ── 阅读视图里点的字 → 原文位置（第七十三轮：点哪儿光标落哪儿） ─────────────────
// 阅读视图那头记下点的那一段可见文字、前面同样的一段出现过几次、点在第几个字（anchorFromCaret）；
// 原文这头把每一行（表格是每一格）换成看得见的字，并记住每个字在原文的哪一列（visibleText），找到同一段的第几次出现，再按第几个字换回列。
// 公式、图片、嵌入在阅读视图里不是字，两头都算成一个占位字。

const OBJ = '￼';

/** 一段行内原文里看得见的字（照 mdInline 的显示）：cols[i] / ends[i] 是第 i 个字在原文里的起止 */
function scanInline(s, base) {
  const chars = [], cols = [], ends = [];
  const push = (ch, col, end) => { chars.push(ch); cols.push(col); ends.push(end == null ? col + 1 : end); };
  const pushAll = (str, col) => { for (let k = 0; k < str.length; k++) push(str[k], col + k); };
  const math = new Map(inlineMathRanges(s).map((r) => [r.from, r.to]));
  let j = 0, m;
  while (j < s.length) {
    const rest = s.slice(j);
    if ((m = /^`([^`\n]+)`/.exec(rest))) { pushAll(m[1], base + j + 1); j += m[0].length; continue; }
    if (math.has(j)) { push(OBJ, base + j, base + math.get(j)); j = math.get(j); continue; }
    if ((m = /^!\[\[[^\]\n]+\]\]/.exec(rest)) || (m = /^!\[[^\]\n]*\]\([^)\n]*\)/.exec(rest))) { push(OBJ, base + j, base + j + m[0].length); j += m[0].length; continue; }
    if ((m = /^\[\[([^\]\n]+)\]\]/.exec(rest))) {
      const parts = m[1].split('|'); const label = parts[1] || parts[0];
      pushAll(label, base + j + 2 + (parts[1] ? parts[0].length + 1 : 0)); j += m[0].length; continue;
    }
    if ((m = /^\[([^\]]+)\]\((?:https?:\/\/(?:[^()\s]|\([^()]*\))+|\/api\/knowledge\/attachments\/[1-9]\d*)\)/i.exec(rest))) {
      const inner = scanInline(m[1], base + j + 1);
      inner.text.split('').forEach((ch, k) => push(ch, inner.cols[k], inner.ends[k])); j += m[0].length; continue;
    }
    if ((m = /^<(https?:\/\/[^>\s]+)>/i.exec(rest))) { pushAll(m[1], base + j + 1); j += m[0].length; continue; }
    if ((m = /^<\/?u>/.exec(rest))) { j += m[0].length; continue; }
    if (rest.startsWith('**') && rest.indexOf('**', 3) > 0) {                                  // **加粗**：成对才藏
      const close = rest.indexOf('**', 3);
      const inner = scanInline(rest.slice(2, close), base + j + 2);
      inner.text.split('').forEach((ch, k) => push(ch, inner.cols[k], inner.ends[k])); j += close + 2; continue;
    }
    if (rest.startsWith('*') && (j === 0 || s[j - 1] !== '*') && /^\*[^*\n]+\*/.test(rest)) {   // *斜体*：成对才藏
      const close = rest.indexOf('*', 1);
      const inner = scanInline(rest.slice(1, close), base + j + 1);
      inner.text.split('').forEach((ch, k) => push(ch, inner.cols[k], inner.ends[k])); j += close + 1; continue;
    }
    if (rest.startsWith('**')) { pushAll('**', base + j); j += 2; continue; }
    push(s[j], base + j); j++;
  }
  return { text: chars.join(''), cols, ends };
}

/** 一行原文在阅读模式里看得见的那几段：通常一段；表格一格一段（分隔行没有）；行首的标题 / 引用 / 列表 / 任务符号不算 */
export function visibleText(line) {
  const t = line.trim(); let m;
  if (/^\|.*\|\s*$/.test(t)) {
    const first = line.indexOf('|'), last = line.lastIndexOf('|');
    const cells = []; let start = first + 1;
    for (let i = first + 1; i <= last; i++) if (line[i] === '|') { cells.push([start, i]); start = i + 1; }
    if (cells.every(([a, b]) => /^(:?-{2,}:?)?$/.test(line.slice(a, b).trim())) && cells.some(([a, b]) => /-{2,}/.test(line.slice(a, b)))) return [];
    return cells.map(([a, b]) => scanInline(line.slice(a, b), a));
  }
  let start = 0;
  if ((m = /^#{1,6}\s+(?=\S)/.exec(line))) start = m[0].length;
  else if ((m = /^\s*[-*]\s+\[[ xX]\]\s+(?=\S)/.exec(line))) start = m[0].length;
  else if ((m = /^\s*(?:[-*]|\d+[.)])\s+(?=\S)/.exec(line))) start = m[0].length;
  else if ((m = /^>\s?/.exec(line))) start = m[0].length;
  return [scanInline(line.slice(start), start)];
}

/** 阅读视图里的块（一段文字的归属）：段落、列表项、标题、表格的格、引用、代码块、勾选项 */
const attr = (el, name) => (el && el.nodeType === 1 && el.getAttribute ? el.getAttribute(name) : null);
const isTaskRow = (el) => /(^|\s)zq-task-row(\s|$)/.test(attr(el, 'class') || '');
const isBlock = (el) => !!el && el.nodeType === 1 && (/^(P|LI|H[1-6]|TD|TH|BLOCKQUOTE|PRE)$/.test(el.tagName) || isTaskRow(el));
const isOpaque = (el) => !!el && el.nodeType === 1 && (attr(el, 'data-tex') !== null || attr(el, 'data-embed-markdown') !== null || attr(el, 'data-image-markdown') !== null);
const breaksSegment = (el) => /^(UL|OL|P|DIV|TABLE|PRE|BLOCKQUOTE|LI|H[1-6]|HR)$/.test(el.tagName) || isTaskRow(el);

/** 一个块里的几段：<br> 和里面的子块把它分开；代码块按行分 */
function segmentsOf(block) {
  const pre = block.tagName === 'PRE'; const segs = [[]];
  (function walk(el) {
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        if (!pre) { segs[segs.length - 1].push({ node: child, start: 0, text: child.nodeValue }); continue; }
        let start = 0;
        child.nodeValue.split('\n').forEach((part, i) => { if (i) segs.push([]); segs[segs.length - 1].push({ node: child, start, text: part }); start += part.length + 1; });
      } else if (child.nodeType === 1) {
        if (isOpaque(child)) segs[segs.length - 1].push({ node: child, start: 0, text: OBJ, opaque: true });
        else if (child.tagName === 'BR' || breaksSegment(child)) segs.push([]);
        else if (child.tagName !== 'INPUT') walk(child);
      }
    }
  })(block);
  return segs.map((pieces) => ({ pieces, text: pieces.map((p) => p.text).join('') }));
}

/** 阅读视图里光标（node, offset）落在哪一段的第几个字，这一段前面出现过几次（node 和 offset 是 caretRangeFromPoint 给的） */
export function anchorFromCaret(root, node, offset) {
  if (!root || !node) return null;
  if (node.nodeType === 1 && !isOpaque(node) && node.childNodes.length) {
    if (offset < node.childNodes.length) { node = node.childNodes[offset]; offset = 0; }
    else { node = node.childNodes[node.childNodes.length - 1]; offset = node.nodeType === 3 ? node.nodeValue.length : 0; }
  }
  for (let n = node; n && n !== root; n = n.parentNode) if (isOpaque(n)) { node = n; offset = 0; }   // 点在公式 / 图片 / 嵌入上：算在它前面
  let block = null;
  for (let n = node.nodeType === 1 ? node : node.parentNode; n && n !== root; n = n.parentNode) if (isBlock(n)) { block = n; break; }
  if (!block) return null;
  const segs = segmentsOf(block); let hit = null, at = 0;
  for (const seg of segs) {
    let len = 0;
    for (const p of seg.pieces) {
      if (p.node === node && (p.opaque || (offset >= p.start && offset <= p.start + p.text.length))) { hit = seg; at = len + (p.opaque ? 0 : offset - p.start); break; }
      len += p.text.length;
    }
    if (hit) break;
  }
  if (!hit) return null;
  const text = hit.text.trim(); if (!text) return null;
  const lead = hit.text.length - hit.text.trimStart().length;
  const blocks = [];
  (function walk(el) { for (const c of el.childNodes) if (c.nodeType === 1 && !isOpaque(c)) { if (isBlock(c)) blocks.push(c); walk(c); } })(root);
  let ordinal = 0;
  outer: for (const b of blocks) {
    for (const seg of (b === block ? segs : segmentsOf(b))) { if (seg === hit) break outer; if (seg.text.trim() === text) ordinal++; }
  }
  return { text, ordinal, offset: Math.max(0, Math.min(at - lead, text.length)) };
}

function caretAtPoint(x, y) {
  let node = null, offset = 0;
  try {
    if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; offset = r.startOffset; } }
    else if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; offset = p.offset; } }
  } catch (e) { return null; }
  return node ? { node, offset } : null;
}

/** 屏幕坐标 → 阅读视图里的那一段（浏览器里用；node 里测的是 anchorFromCaret） */
export function readingAnchor(root, x, y) {
  if (typeof document === 'undefined' || !root) return null;
  const caret = caretAtPoint(x, y);
  return caret && root.contains(caret.node) ? anchorFromCaret(root, caret.node, caret.offset) : null;
}

/** 阅读视图里 (x, y) 点到的那个字的顶边（屏幕坐标）；没点在字上回 null。进编辑后让原文里同一个字停在这个高度（第八十轮） */
export function readingCharTop(root, x, y) {
  if (typeof document === 'undefined' || !root) return null;
  const caret = caretAtPoint(x, y);
  if (!caret || caret.node.nodeType !== 3 || !caret.node.nodeValue || !root.contains(caret.node)) return null;
  const at = Math.min(caret.offset, caret.node.nodeValue.length - 1);
  const range = document.createRange(); range.setStart(caret.node, at); range.setEnd(caret.node, at + 1);
  const rect = range.getClientRects()[0];
  return rect && rect.height ? rect.top : null;
}

/** 原文位置所在的那一行（空行、分隔行往下找）第一段看得见的字，和它前面同样的一段出现过几次 —— 回到阅读模式时找同一段用 */
export function sourceAnchorAt(markdown, pos) {
  const seen = new Map(); let found = null;
  eachLine(markdown, (line, linePos, kind) => {
    const units = kind === 'code' ? [{ text: line }] : visibleText(line);
    for (const unit of units) {
      const text = unit.text.trim(); if (!text) continue;
      const ordinal = seen.get(text) || 0; seen.set(text, ordinal + 1);
      if (!found && linePos + line.length >= pos) found = { text, ordinal };
    }
  });
  return found;
}

/** 阅读视图里第 ordinal 次出现、可见文字是 text 的那一段和它所在的块（没有那么多次就取最后一次） */
function readingSegmentFor(root, anchor) {
  if (!root || !anchor || !anchor.text) return null;
  let last = null, count = 0;
  const blocks = [];
  (function walk(el) { for (const c of el.childNodes) if (c.nodeType === 1 && !isOpaque(c)) { if (isBlock(c)) blocks.push(c); walk(c); } })(root);
  for (const block of blocks) {
    for (const seg of segmentsOf(block)) {
      if (seg.text.trim() !== anchor.text) continue;
      last = { block, seg };
      if (count++ === anchor.ordinal) return last;
    }
  }
  return last;
}
export function readingBlockFor(root, anchor) { const hit = readingSegmentFor(root, anchor); return hit ? hit.block : null; }

/** 那一段第一个字的顶边（屏幕坐标）；找不到回 null。保存 / 取消回到阅读时对位用（第八十轮）：
 *  对的是字不是块 —— 代码块的第三行、引用的第二行都对得准（原来对块的顶边） */
export function readingAnchorTop(root, anchor) {
  if (typeof document === 'undefined') return null;
  const hit = readingSegmentFor(root, anchor); if (!hit) return null;
  for (const piece of hit.seg.pieces) {
    if (piece.opaque) return piece.node.getBoundingClientRect().top;
    const i = piece.text.search(/\S/); if (i < 0) continue;
    const range = document.createRange(); range.setStart(piece.node, piece.start + i); range.setEnd(piece.node, piece.start + i + 1);
    const rect = range.getClientRects()[0];
    if (rect && rect.height) return rect.top;
  }
  return hit.block.getBoundingClientRect().top;
}

/** 阅读视图里的那一段 → 原文位置；对不上回 null（交给按坐标找） */
export function sourcePosition(markdown, anchor) {
  if (!anchor || !anchor.text) return null;
  const exact = [], partial = [];
  const add = (unit, pos) => {
    const lead = unit.text.length - unit.text.trimStart().length;
    if (unit.text.trim() === anchor.text) exact.push({ unit, pos, at: lead });
    else { const at = unit.text.indexOf(anchor.text); if (at >= 0) partial.push({ unit, pos, at }); }
  };
  eachLine(markdown, (line, pos, kind) => {
    if (kind === 'code') add({ text: line, cols: [...line].map((_, i) => i), ends: [...line].map((_, i) => i + 1) }, pos);
    else visibleText(line).forEach((unit) => add(unit, pos));
  });
  const list = exact.length ? exact : partial;
  if (!list.length) return null;
  const hit = list[Math.min(anchor.ordinal || 0, list.length - 1)];
  const i = hit.at + (anchor.offset || 0), { cols, ends } = hit.unit;
  if (i < cols.length) return hit.pos + cols[i];
  return hit.pos + (ends.length ? ends[ends.length - 1] : 0);
}

// ── 排版和阅读一致（第八十轮） ─────────────────────────────────────────
// 用户在桌面应用里点进编辑，正文整个跳一下：阅读时段落之间 12px，编辑器里段落之间的空行占一整行（53 对 39px），
// 标题自带上内边距，阅读时藏起来的重复页名在编辑器里露出来。这里照阅读模式（.zq-prose .zq-md）的上下外边距，
// 算出编辑器里每一行该有多高：空行只占两块之间该空的那么高，紧挨着上一块的行带上该有的上内边距。

/** 阅读模式各块的上 / 下外边距（zhiqu-ui.css 的 .zq-prose .zq-md 那几条）。相邻两块之间空多高 = 两边取大（外边距折叠） */
export const BLOCK_MARGINS = { p: [0, 12], h1: [28, 14], h2: [30, 10], h3: [24, 8], h4: [20, 6], h5: [18, 6], h6: [16, 6],
  li: [0, 12], task: [6, 6], quote: [16, 16], pre: [16, 16], hr: [28, 28], table: [12, 12], math: [12, 12] };
/** 同一个列表里两项之间（.zq-prose .zq-md li{margin:5px 0}，折叠后 5px） */
export const LIST_ITEM_GAP = 5;
/** 编辑器里会用到的所有空行高度 / 上内边距（样式只能事先写好） */
export const LAYOUT_SIZES = [0, 5, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 30];
/** 块里面的尺寸照阅读模式（第八十轮）：阅读时代码框里一行是正文的行高（pre 是 15px × 1.85 的行，里面 13px 的 code 是行内的，撑不矮它）；
 *  代码框上下各是 12px 内边距 + 1px 边框；引用上下各 2px 内边距。判据从样式表读出来对照 */
export const READING_BOX = { codeLineHeight: 'calc(var(--zq-fs-md) * 1.85)', fence: 13, quotePad: 2 };

/** 挂上编辑器时光标先放在哪：藏起来的重复标题后面（第八十轮）。放在 0 的话它一挂上就算「碰到了」，露出来又藏回去 */
export function startCursor(text, title) {
  text = String(text || '');
  if (duplicateTitleLine(text, title) < 0) return 0;
  const nl = text.indexOf('\n');
  return nl < 0 ? text.length : nl + 1;
}
/** 正文第一行是一级标题、而且和页名一字不差：返回它的行号（0），否则 -1。和阅读模式的 markDuplicateTitle 同一个规矩 */
export function duplicateTitleLine(text, title) {
  const first = /^# +(.*?)\s*$/.exec(String(text || '').split('\n', 1)[0]);
  const name = String(title == null ? '' : title).trim();
  return first && name && first[1].trim() === name ? 0 : -1;
}

function lineKind(s) {
  const heading = /^ {0,3}(#{1,6})(?:\s|$)/.exec(s);
  if (heading) return 'h' + heading[1].length;
  if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(s)) return 'hr';
  if (/^\s*[-*]\s+\[[ xX]\]\s+\S/.test(s)) return 'task';   // 阅读模式把任务项画成列表外单独的一行（.zq-task-row），不是列表里的一项
  if (/^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(s)) return 'li';
  if (/^ {0,3}>/.test(s)) return 'quote';
  if (/^\s*\|/.test(s)) return 'table';
  return 'p';
}
// nested：下一行比上一行缩进得深（套在上一项里）。套在列表项里的任务行跟在父项的字后面，只隔它自己的上边距；
// 顶格的任务行前面是一整个列表（下外边距 12）—— 原来当成同一个列表的下一项只隔 5，点进编辑差 7px（第八十轮）
const gapBetween = (prev, next, nested = false) => {
  if (prev === 'li' && next === 'li') return LIST_ITEM_GAP;
  if (prev === 'li' && next === 'task' && nested) return BLOCK_MARGINS.task[0];
  return Math.max(BLOCK_MARGINS[prev][1], BLOCK_MARGINS[next][0]);
};
const indentOf = (s) => /^\s*/.exec(s)[0].replace(/\t/g, '    ').length;

/**
 * 每一行该怎么排：[{ blank, kind, gap, pad }]。空行的 gap 是它该占的高度（一串空行只有第一行占，开头和结尾的空行不占）；
 * 一块紧挨着上一块（中间没有空行）时，它的第一行 pad 是该有的上内边距。代码块、块公式里的空行是内容，照常排。
 * titleLine 是藏起来的重复页名那一行（-1 表示没有）：它后面那一块和阅读时一样带着自己的上边距。
 */
export function layoutLines(text, titleLine = -1) {
  const lines = String(text || '').split('\n');
  const out = lines.map(() => ({ blank: false, kind: 'p', gap: null, pad: 0 }));
  let fence = null, math = false, prev = null, prevLine = -1, run = null;
  const closeRun = (next) => {
    if (!run) return;
    out[run.first].gap = !next || !run.prev ? 0 : run.prev === 'title' ? BLOCK_MARGINS[next][0] : gapBetween(run.prev, next);
    for (let k = run.first + 1; k <= run.last; k++) out[k].gap = 0;
    run = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    if (fence) { out[i].kind = 'pre'; if (new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$').test(s)) fence = null; prevLine = i; continue; }
    if (math) { out[i].kind = 'math'; if (/^\s*\$\$\s*$/.test(s)) math = false; prevLine = i; continue; }
    if (i === titleLine) { closeRun(null); prev = 'title'; prevLine = i; continue; }
    if (/^\s*$/.test(s)) {
      out[i].blank = true;
      if (run) run.last = i; else run = { first: i, last: i, prev };
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(s);
    const kind = open ? 'pre' : /^\s*\$\$/.test(s) ? 'math' : lineKind(s);
    out[i].kind = kind;
    if (run) closeRun(kind);
    else if (prevLine === i - 1 && prev && prev !== 'title') {
      // 紧挨着上一行：同一块的续行不加；新的一块（标题、分隔线、列表的下一项、换了种类）照阅读模式空出来
      const continues = kind === prev && !/^h\d$|^hr$|^li$|^task$/.test(kind) || kind === 'p' && /^(li|task|quote)$/.test(prev);
      if (!continues) out[i].pad = gapBetween(prev, kind, indentOf(s) > indentOf(lines[prevLine]));
    }
    if (open) fence = open[1];
    else if (kind === 'math' && s.trim() === '$$') math = true;
    prev = kind === 'p' && /^(li|task|quote)$/.test(prev) && prevLine === i - 1 ? prev : kind;
    prevLine = i;
  }
  closeRun(null);
  return out;
}

// ── 实时预览 ───────────────────────────────────────────────────────────

const touched = (state, from, to) => state.selection.ranges.some((r) => r.from <= to && r.to >= from);

const TextWidget = class extends WidgetType {
  constructor(text, className, onClick) { super(); this.text = text; this.className = className; this.onClick = onClick; }
  eq(other) { return other.text === this.text && other.className === this.className; }
  toDOM() {
    const el = document.createElement('span'); el.className = this.className; el.textContent = this.text;
    if (this.onClick) el.addEventListener('mousedown', (e) => { e.preventDefault(); this.onClick(); });
    return el;
  }
  ignoreEvent() { return !this.onClick; }
};

const MathWidget = class extends WidgetType {
  constructor(tex, display) { super(); this.tex = tex; this.display = display; }
  eq(other) { return other.tex === this.tex && other.display === this.display; }
  toDOM() {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = this.display ? 'cm-zq-math-block' : 'cm-zq-math';
    const katex = typeof window !== 'undefined' && window.katex;
    if (katex) { try { katex.render(this.tex, el, { displayMode: this.display, throwOnError: false }); return el; } catch (e) { /* 照原文显示 */ } }
    el.textContent = this.display ? `$$\n${this.tex}\n$$` : `$${this.tex}$`;
    return el;
  }
};

const CheckboxWidget = class extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos; }
  eq(other) { return other.checked === this.checked && other.pos === this.pos; }
  toDOM(view) {
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = this.checked; box.className = 'cm-zq-task';
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (view.state.readOnly) return;
      // 只改方括号里那一个字符：[ ] ↔ [x]
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } });
    });
    return box;
  }
  ignoreEvent() { return false; }
};

/** 图片 / 表格：光标不在时用阅读模式同一个渲染画出来（私有图片照旧带登录去取）；按下去把光标放进原文 */
const RenderedWidget = class extends WidgetType {
  constructor(source, kind, options) { super(); this.source = source; this.kind = kind; this.options = options; }
  eq(other) { return other.source === this.source && other.kind === this.kind; }   // 不比位置：前面打字不该让图片重新下载
  toDOM(view) {
    const el = document.createElement(this.kind === 'table' ? 'div' : 'span');
    el.className = this.kind === 'table' ? 'cm-zq-table zq-md' : 'cm-zq-image';
    const html = this.options.renderBlock ? this.options.renderBlock(this.source) : '';
    if (this.kind === 'table') el.innerHTML = html;
    else {
      const holder = document.createElement('div'); holder.innerHTML = html;
      const image = holder.querySelector('.zq-md-image');
      if (image) el.appendChild(image); else el.textContent = this.source;
    }
    if (!html) el.textContent = this.source;
    if (this.options.hydrate) this.options.hydrate(el);
    el.addEventListener('load', () => view.requestMeasure(), true);   // 图片到了，高度变了
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(el);
      view.dispatch({ selection: EditorSelection.cursor(this.kind === 'table' ? pos : pos + this.source.length) }); view.focus();
    });
    return el;
  }
  ignoreEvent() { return false; }
};

const hide = Decoration.replace({});
const line = (cls) => Decoration.line({ class: cls });
const mark = (cls) => Decoration.mark({ class: cls });
/** 渲染出来的链接带着地址：单击按阅读模式同一个规矩打开（第八十轮：原来编辑器里点链接只放光标，一点正文就进编辑，于是链接全都点不动） */
const linkMark = (href) => Decoration.mark({ class: 'cm-zq-link', attributes: { 'data-href': href } });
/** 每份文档、每个页名只排一次（光标动一下不重算全文） */
const layoutCache = new WeakMap();
function layoutFor(state, options) {
  const title = options.title ? options.title() : '';
  const hit = layoutCache.get(state.doc);
  if (hit && hit.title === title) return hit;
  const text = docText(state.doc), titleLine = duplicateTitleLine(text, title);
  const value = { title, titleLine, lines: layoutLines(text, titleLine) };
  layoutCache.set(state.doc, value);
  return value;
}
// 代码着色：和阅读模式同一套类（.zq-tok-*，颜色在样式表；第八十一轮之前是一段一个 style="color:…"）
const tokenMarks = new Map();
const tokenMark = (cls) => { if (!tokenMarks.has(cls)) tokenMarks.set(cls, Decoration.mark({ class: cls })); return tokenMarks.get(cls); };

/** 光标不在的地方怎么显示（链接、标题、强调…）和每一行的高度。只用 view.state 和 view.visibleRanges —— node 里的判据拿一个假视图跑同一份 */
export function inlineDecorations(view, options) {
  const { state } = view; const out = [];
  const codeRanges = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({ from, to, enter(node) {
      const name = node.name;
      const heading = /^ATXHeading(\d)$/.exec(name);
      if (heading) {
        out.push(line(`cm-zq-h cm-zq-h${heading[1]}`).range(state.doc.lineAt(node.from).from));
        if (!touched(state, node.from, node.to)) {
          const markNode = node.node.getChild('HeaderMark');
          if (markNode) out.push(hide.range(markNode.from, Math.min(node.to, markNode.to + 1)));
        }
        return;
      }
      if (name === 'FencedCode' || name === 'CodeBlock') {
        // 光标不在时，围栏那两行（```js、```）只占阅读时代码框的上 / 下内边距那么高、字藏起来 —— 和阅读模式一样高（第八十轮）
        const folded = name === 'FencedCode' && !touched(state, node.from, node.to);
        const firstLine = state.doc.lineAt(node.from), lastLine = state.doc.lineAt(node.to);
        for (let pos = node.from; pos <= node.to;) {
          const l = state.doc.lineAt(pos);
          const fenceLine = folded && (l.number === firstLine.number || l.number === lastLine.number && lastLine.number !== firstLine.number);
          out.push(line(fenceLine ? 'cm-zq-codeblock cm-zq-fence' : 'cm-zq-codeblock').range(l.from));
          if (fenceLine && l.to > l.from) out.push(hide.range(l.from, l.to));
          pos = l.to + 1;
        }
        codeRanges.push([node.from, node.to]);
        // 代码着色：和阅读模式同一套（壳里的 tokenizeCode）
        const info = node.node.getChild('CodeInfo'), code = node.node.getChild('CodeText');
        if (code && options.codeTokens) {
          let at = code.from;
          for (const token of options.codeTokens(state.sliceDoc(code.from, code.to), info ? state.sliceDoc(info.from, info.to) : '')) {
            if (token.cls && token.text) out.push(tokenMark(token.cls).range(at, at + token.text.length));
            at += token.text.length;
          }
        }
        return false;
      }
      if (name === 'Image' && !touched(state, node.from, node.to)) {
        out.push(Decoration.replace({ widget: new RenderedWidget(state.sliceDoc(node.from, node.to), 'image', options) }).range(node.from, node.to));
        return false;
      }
      if (name === 'InlineCode') codeRanges.push([node.from, node.to]);
      const styled = { Emphasis: 'cm-zq-em', StrongEmphasis: 'cm-zq-strong', Strikethrough: 'cm-zq-del', InlineCode: 'cm-zq-code' }[name];
      if (styled) {
        out.push(mark(styled).range(node.from, node.to));
        if (!touched(state, node.from, node.to)) {
          for (let child = node.node.firstChild; child; child = child.nextSibling) {
            if (/^(EmphasisMark|CodeMark|StrikethroughMark)$/.test(child.name)) out.push(hide.range(child.from, child.to));
          }
        }
        return;
      }
      if (name === 'Link' && !touched(state, node.from, node.to)) {
        const marks = []; for (let child = node.node.firstChild; child; child = child.nextSibling) if (child.name === 'LinkMark') marks.push(child);
        const url = node.node.getChild('URL');
        if (marks.length >= 2) {
          out.push(hide.range(marks[0].from, marks[0].to));
          out.push((url ? linkMark(state.sliceDoc(url.from, url.to)) : mark('cm-zq-link')).range(marks[0].to, marks[1].from));
          out.push(hide.range(marks[1].from, node.to));
        }
        return false;
      }
      // 裸网址（和 <网址>）：光标不在上面时画成链接、单击打开（原来是灰色的普通字）；链接 / 图片里面的那个网址不算
      if (name === 'URL' && !touched(state, node.from, node.to) && !(node.node.parent && /^(Link|Image)$/.test(node.node.parent.name))) {
        const href = state.sliceDoc(node.from, node.to);
        if (/^https?:\/\//i.test(href)) out.push(linkMark(href).range(node.from, node.to));
        return;
      }
      if (name === 'TaskMarker' && !touched(state, node.from, node.to)) {
        out.push(Decoration.replace({ widget: new CheckboxWidget(/x/i.test(state.sliceDoc(node.from, node.to)), node.from) }).range(node.from, node.to));
      }
      if (name === 'QuoteMark') out.push(mark('cm-zq-quote-mark').range(node.from, node.to));
      if (name === 'ListMark') out.push(mark('cm-zq-list-mark').range(node.from, node.to));
    } });
    // [[双链]] 和行内公式不在 Markdown 语法树里：按行扫，代码里的不算
    const inCode = (a, b) => codeRanges.some(([x, y]) => a < y && b > x);
    const text = state.sliceDoc(from, to);
    for (const link of wikiLinkRanges(text, from)) {
      if (inCode(link.from, link.to)) continue;
      if (touched(state, link.from, link.to)) { out.push(mark('cm-zq-wikilink-src').range(link.from, link.to)); continue; }
      if (link.embed && /^\/api\/knowledge\/images\/[1-9]\d*$/.test(link.target)) {   // 贴进来的图片：显示成图
        out.push(Decoration.replace({ widget: new RenderedWidget(state.sliceDoc(link.from, link.to), 'image', options) }).range(link.from, link.to));
        continue;
      }
      out.push(Decoration.replace({ widget: new TextWidget(link.label || link.target, link.embed ? 'cm-zq-wikilink cm-zq-embed' : 'cm-zq-wikilink',
        () => options.onNavigate && options.onNavigate(link.target)) }).range(link.from, link.to));
    }
    for (const math of inlineMathRanges(text, from)) {
      if (inCode(math.from, math.to) || touched(state, math.from, math.to)) continue;
      out.push(Decoration.replace({ widget: new MathWidget(math.tex, false) }).range(math.from, math.to));
    }
    for (const u of underlineRanges(text, from)) {
      if (inCode(u.from, u.to)) continue;
      if (u.closeFrom > u.openTo) out.push(mark('cm-zq-u').range(u.openTo, u.closeFrom));
      if (!touched(state, u.from, u.to)) { out.push(hide.range(u.from, u.openTo)); out.push(hide.range(u.closeFrom, u.to)); }
    }
  }
  // 每一行的高度照阅读模式：空行只占两块之间该空的那么高，紧挨着上一块的行带上上内边距（第八十轮）
  const layout = layoutFor(state, options);
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const l = state.doc.lineAt(pos), info = layout.lines[l.number - 1];
      if (info) {
        if (info.blank && info.gap != null) out.push(line('cm-zq-gap-' + info.gap).range(l.from));
        else if (info.pad) out.push(line('cm-zq-pad-' + info.pad).range(l.from));
        if (info.kind === 'quote') {   // 一段引用的第一行、最后一行带上阅读时的上 / 下内边距
          const quote = (k) => layout.lines[k] && !layout.lines[k].blank && layout.lines[k].kind === 'quote';
          if (!quote(l.number - 2) && !info.pad) out.push(line('cm-zq-quote-top').range(l.from));
          if (!quote(l.number)) out.push(line('cm-zq-quote-bottom').range(l.from));
        }
      }
      pos = l.to + 1;
    }
  }
  return Decoration.set(out, true);
}

// 块公式、表格两个 StateField 都要全文：同一份文档只取一次（第二遍 review：原来每打一个字两边各复制一遍全文）
const docTexts = new WeakMap();
function docText(doc) {
  let text = docTexts.get(doc);
  if (text === undefined) { text = doc.toString(); docTexts.set(doc, text); }
  return text;
}

// 块公式横跨多行：多行的替换只能放在 StateField 里（ViewPlugin 不许出跨行的块装饰）
const blockMath = StateField.define({
  create(state) { const ranges = blockMathRanges(docText(state.doc)); return { ranges, deco: blockMathDecorations(state, ranges) }; },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    const ranges = tr.docChanged ? blockMathRanges(docText(tr.state.doc)) : value.ranges;
    return { ranges, deco: blockMathDecorations(tr.state, ranges) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
});
function blockMathDecorations(state, ranges) {
  const out = [];
  for (const block of ranges) {
    if (touched(state, block.from, block.to)) continue;
    out.push(Decoration.replace({ widget: new MathWidget(block.tex, true), block: true }).range(block.from, block.to));
  }
  return Decoration.set(out, true);
}

// 表格横跨多行，和块公式一样放在 StateField 里：光标不在时画成表格，在里面时原文用等宽字（列对得齐）
// 只动光标时不重扫全文（第七十四轮 review：原来每按一下方向键都把整篇复制一遍、从头扫），只重算哪张表被光标碰到
const tablePreview = (options) => StateField.define({
  create(state) { const ranges = tableRanges(docText(state.doc)); return { ranges, deco: tableDecorations(state, ranges, options) }; },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    const ranges = tr.docChanged ? tableRanges(docText(tr.state.doc)) : value.ranges;
    return { ranges, deco: tableDecorations(tr.state, ranges, options) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
});
function tableDecorations(state, ranges, options) {
  const out = [];
  for (const table of ranges) {
    if (!touched(state, table.from, table.to)) {
      out.push(Decoration.replace({ widget: new RenderedWidget(state.sliceDoc(table.from, table.to), 'table', options), block: true }).range(table.from, table.to));
      continue;
    }
    for (let pos = table.from; pos <= table.to;) { const l = state.doc.lineAt(pos); out.push(line('cm-zq-table-src').range(l.from)); pos = l.to + 1; }
  }
  return Decoration.set(out, true);
}

// 和页名重复的第一行标题：阅读时藏着（.zq-dup-title），编辑器里也藏 —— 原来一点进编辑它就露出来，把下面整个往下推（第八十轮）。
// 只是不显示，原文里还在、保存原样写回；光标走到它上面（⌘↑）时露出来。整行的替换只能放在 StateField 里
const titleHidden = (options) => StateField.define({
  create(state) { return titleDecorations(state, options); },
  update(value, tr) { return tr.docChanged || tr.selection ? titleDecorations(tr.state, options) : value; },
  provide: (field) => EditorView.decorations.from(field),
});
function titleDecorations(state, options) {
  const layout = layoutFor(state, options);
  if (layout.titleLine < 0) return Decoration.none;
  const l = state.doc.line(layout.titleLine + 1);
  if (touched(state, l.from, l.to)) return Decoration.none;
  return Decoration.set([Decoration.replace({ block: true }).range(l.from, l.to)]);
}

/** 跨行的两种预览（块公式、表格）：StateField 不要 DOM，node 里的判据直接拿 EditorState 跑同一份 */
export function blockPreviews(options) { return [blockMath, tablePreview(options), titleHidden(options)]; }

const livePreview = (options) => ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = inlineDecorations(view, options); }
  update(update) {
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) this.decorations = inlineDecorations(update.view, options);
  }
}, { decorations: (plugin) => plugin.decorations });

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'var(--zq-fw-medium)' },
  { tag: tags.url, color: 'var(--zq-text3)' },
  { tag: tags.processingInstruction, color: 'var(--zq-text3)' },
]);

const theme = EditorView.theme({
  // 高度跟内容走、自己不出滚动条：Wiki 正文（#zq-doc）还是唯一的滚动容器，CodeMirror 照样只画看得见的那几屏
  '&': { height: 'auto', fontSize: 'var(--zq-fs-md)', color: 'var(--zq-text)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'visible', fontFamily: 'inherit', lineHeight: '1.85' },
  '.cm-content': { padding: '0', caretColor: 'var(--zq-text)' },
  '.cm-line': { padding: '0' },
  // 标题上下空多少由前后的空行 / 上内边距给（照阅读模式），标题行自己不再带（第八十轮）
  '.cm-zq-h1': { fontSize: '24px', lineHeight: '1.35' },
  '.cm-zq-h2': { fontSize: '19px', lineHeight: '1.4' },
  '.cm-zq-h3': { fontSize: '16px', lineHeight: '1.45' },
  '.cm-zq-h4, .cm-zq-h6': { color: 'var(--zq-text2)' },
  '.cm-zq-strong': { fontWeight: 'var(--zq-fw-semibold)' },
  '.cm-zq-em': { fontStyle: 'italic' },
  '.cm-zq-del': { textDecoration: 'line-through', color: 'var(--zq-text3)' },
  '.cm-zq-code': { fontFamily: 'var(--zq-fontM)', fontSize: '0.92em', background: 'var(--zq-card-soft)', borderRadius: '4px' },
  '.cm-zq-codeblock': { fontFamily: 'var(--zq-fontM)', fontSize: '13px', lineHeight: READING_BOX.codeLineHeight, background: 'var(--zq-card-soft)', paddingLeft: '14px' },
  // 首尾的 ``` 行（光标不在时字藏起来）正好是阅读时代码框的上 / 下内边距 + 边框；定高，藏字留下的占位撑不高它
  '.cm-zq-fence': { lineHeight: READING_BOX.fence + 'px', height: READING_BOX.fence + 'px', overflow: 'hidden' },
  '.cm-zq-quote-top': { paddingTop: READING_BOX.quotePad + 'px' },
  '.cm-zq-quote-bottom': { paddingBottom: READING_BOX.quotePad + 'px' },
  '.cm-zq-link, .cm-zq-wikilink': { color: 'var(--zq-primary)', textDecoration: 'underline', textUnderlineOffset: '3px', cursor: 'pointer' },
  '.cm-zq-embed': { display: 'inline-block', padding: '0 8px', borderLeft: '2px solid var(--zq-border)' },
  '.cm-zq-wikilink-src, .cm-zq-quote-mark, .cm-zq-list-mark': { color: 'var(--zq-text3)' },
  '.cm-zq-task': { margin: '0 6px 0 0', verticalAlign: 'middle' },
  '.cm-zq-math-block': { textAlign: 'center', padding: '6px 0' },
  '.cm-zq-u': { textDecoration: 'underline', textUnderlineOffset: '3px' },
  '.cm-zq-table-src': { fontFamily: 'var(--zq-fontM)', fontSize: '13px' },
  '.cm-zq-table': { cursor: 'text' },
  // 表格预览里画的是阅读模式那一份（.zq-md-table 带着上下 12px）：块之间空多少由前后的空行给，里面这层不再带（第八十轮：原来下面多漏出 12px）
  '.cm-zq-table .zq-md-table': { margin: '0' },
  ...Object.fromEntries(LAYOUT_SIZES.map((n) => ['.cm-zq-gap-' + n, { lineHeight: n + 'px' }])),
  ...Object.fromEntries(LAYOUT_SIZES.filter((n) => n).map((n) => ['.cm-zq-pad-' + n, { paddingTop: n + 'px' }])),
  '.cm-zq-image': { display: 'inline-block', maxWidth: '100%', cursor: 'text', verticalAlign: 'top' },
});

/** 选区两边加 / 去标记（工具栏和快捷键共用） */
function wrapSelection(view, open, close) {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  const result = toggleWrap(view.state.doc.toString(), from, to, open, close);
  view.dispatch({ changes: result.changes, selection: EditorSelection.single(result.anchor, result.head) });
  return true;
}

/** 把编辑器挂到 host 里。options：markdown、titles()（[[ 补全用的页名）、onNavigate(title)、onChange()、readOnly；
 *  第八十轮：title()（这一页的页名，和它重复的第一行标题藏起来）、onOpenUrl(href)（单击渲染出来的链接）、bottomInset()（底上盖着多高）；
 *  第七十三轮：onImage(file, from, to)（粘贴 / 拖进的图片）、renderBlock(markdown)（画图片和表格，就是 renderMarkdown）、hydrate(el)（私有图片带登录去取）、codeTokens(code, lang) */
export function mountWikiEditor(host, options) {
  const readOnly = new Compartment();
  // 上传图片期间记住插到哪儿：之后的编辑会把位置往后推（track / insertAt）
  const markers = new Set();
  const files = (list) => Array.prototype.slice.call(list || []);
  const completeTitles = (context) => {
    const before = context.matchBefore(/\[\[[^\]\n|]*/);
    if (!before) return null;
    return { from: before.from + 2, options: (options.titles ? options.titles() : []).map((title) => ({ label: title, apply: `${title}]]` })), validFor: /^[^\]\n|]*$/ };
  };
  const startText = options.markdown || '';
  const startAt = startCursor(startText, options.title ? options.title() : '');
  // 编辑器只画看得见的几行，上面没画的行高是估的（空行按整行估，实际只占块间距）：按估的高度对位会偏一截（第八十轮，长页中间点进编辑偏了 32px）。
  // 量一次、挪一次外面那层滚动，直到 pos 那个字的顶边对上 clientTop；挪不动（到头了）或者六次还没对上就停
  // text：那一段看得见的字。pos 落在表格 / 公式的预览里时（光标不在，整块画成阅读模式那一份），在预览里找这段字量 ——
  // 量整块的顶会差一个单元格的内边距，锚在表格第二行时差一整行（第八十轮，10px / 47px）
  const charTop = (pos, text) => {
    if (text) {
      const from = view.lineBlockAt(pos).from;
      for (const el of view.contentDOM.querySelectorAll('.cm-zq-table, .cm-zq-math-block')) {
        let at = -1;
        try { at = view.posAtDOM(el); } catch (e) { /* 已经不在文档里 */ }
        if (at !== from) continue;
        const top = readingAnchorTop(el, { text, ordinal: 0 });
        if (top != null) return top;
      }
    }
    const line = view.state.doc.lineAt(pos), rect = view.coordsAtPos(pos, pos < line.to ? 1 : -1);
    return rect ? rect.top : view.documentTop + view.lineBlockAt(pos).top;   // 没画出来的行：按估的行高
  };
  const alignPos = (pos, clientTop, scroller, text, tries = 6) => view.requestMeasure({
    read: () => charTop(pos, text) - clientTop,
    write: (delta) => {
      if (Math.abs(delta) < 1 || tries <= 0) return;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + delta;
      if (scroller.scrollTop !== before) alignPos(pos, clientTop, scroller, text, tries - 1);
    },
  });
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: startText,
      selection: EditorSelection.cursor(startAt),
      extensions: [
        history(), drawSelection(), EditorView.lineWrapping,
        new LanguageSupport(markdownLanguage), syntaxHighlighting(highlight),
        keymap.of([{ key: 'Enter', run: insertNewlineContinueMarkup }, { key: 'Backspace', run: deleteMarkupBackward },
          ...FORMAT_KEYS.map((k) => ({ key: k.key, run: (v) => wrapSelection(v, k.open, k.close || k.open) })),
          ...completionKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
        autocompletion({ override: [completeTitles], icons: false }),
        livePreview(options), ...blockPreviews(options), theme,
        // 页面底上浮着「保存 / 取消」：把光标滚进视野时让开它（第八十轮）
        EditorView.scrollMargins.of(() => ({ bottom: options.bottomInset ? options.bottomInset() : 0 })),
        EditorView.domEventHandlers({
          // 渲染出来的链接（光标不在那儿的）：单击打开，和阅读模式一样；光标在链接上时露出原文，点了只是放光标（照旧能改）
          mousedown(event, view) {
            if (event.button !== 0 || event.shiftKey || event.altKey || !options.onOpenUrl) return false;
            const el = event.target && event.target.closest ? event.target.closest('.cm-zq-link[data-href]') : null;
            if (!el || !view.dom.contains(el)) return false;
            event.preventDefault();
            options.onOpenUrl(el.getAttribute('data-href'));
            return true;
          },
          paste(event, view) {
            const image = files(event.clipboardData && event.clipboardData.files).find((f) => /^image\//i.test(f.type || ''));
            if (!image || !options.onImage || view.state.readOnly) return false;
            event.preventDefault(); const { from, to } = view.state.selection.main; options.onImage(image, from, to); return true;
          },
          drop(event, view) {
            const dropped = files(event.dataTransfer && event.dataTransfer.files);
            if (!dropped.length) return false;
            event.preventDefault();   // 拖进来的文件不能让 CodeMirror 当文本读进来（它默认这么做，图片会变成一屏乱码）
            if (options.onImage && !view.state.readOnly) {
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              const at = pos == null ? view.state.selection.main.head : pos;
              options.onImage(dropped[0], at, at);
            }
            return true;
          },
        }),
        readOnly.of([EditorState.readOnly.of(Boolean(options.readOnly)), EditorView.editable.of(!options.readOnly)]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          for (const m of markers) { m.from = update.changes.mapPos(m.from, -1); m.to = Math.max(m.from, update.changes.mapPos(m.to, m.to > m.from ? 1 : -1)); }
          if (options.onChange) options.onChange();
        }),
      ],
    }),
  });
  return {
    view,
    getMarkdown: () => view.state.doc.toString(),
    setReadOnly(locked) {
      view.dispatch({ effects: readOnly.reconfigure([EditorState.readOnly.of(locked), EditorView.editable.of(!locked)]) });
    },
    /** 工具栏：加粗 / 斜体 / 行内代码 / 下划线 */
    wrap(open, close) { wrapSelection(view, open, close || open); view.focus(); },
    insert(text) { view.dispatch(view.state.replaceSelection(text)); view.focus(); },
    /** 工具栏「插入链接」：选中的字做链接文字 */
    link(href) {
      const { from, to } = view.state.selection.main;
      const text = linkMarkdown(view.state.sliceDoc(from, to), href);
      view.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length) });
      view.focus();
    },
    /** 屏幕上 clientY 那一行的原文开头和它的字的顶边（保存 / 取消前记下看着的位置）。
     *  第八十轮：落在空行、藏起来的页名上时往下找有字的那一行（回到阅读找的就是它）；顶边算上那一行的上内边距（阅读时那一段的顶边） */
    lineAt(clientY) {
      const { doc } = view.state, layout = layoutFor(view.state, options);
      let l = doc.lineAt(view.lineBlockAtHeight(clientY - view.documentTop).from);
      const skip = (n) => n - 1 === layout.titleLine || (layout.lines[n - 1] && layout.lines[n - 1].blank);
      while (l.number < doc.lines && skip(l.number)) l = doc.line(l.number + 1);
      const info = layout.lines[l.number - 1];
      return { pos: l.from, top: view.documentTop + view.lineBlockAt(l.from).top + (info && info.pad || 0) };
    },
    focusAt(x, y) {
      const pos = x != null && y != null ? view.posAtCoords({ x, y }) : null;
      view.focus();
      if (pos != null) view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: false });
    },
    /** 光标放到原文的 pos；给了 clientTop 和外面滚动的那一层 scroller 时，pos 那个字的顶边停在屏幕上 clientTop（阅读时它在的高度） */
    focusPos(pos, clientTop, scroller) {
      pos = Math.max(0, Math.min(pos, view.state.doc.length));
      view.focus();
      const align = clientTop != null && scroller;
      view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: !align });
      if (align) alignPos(pos, clientTop, scroller);
    },
    /** 原文 pos 那个字（那一段看得见的字是 text）的顶边（屏幕坐标）：保存 / 取消前记下，回到阅读时让同一个字停在这儿 */
    charTop(pos, text) { return charTop(Math.max(0, Math.min(pos, view.state.doc.length)), text); },
    /** 不动光标，只让 pos 那个字停在屏幕上 clientTop（从工具栏 / 菜单进编辑时，阅读时顶上那一段不动） */
    alignPos(pos, clientTop, scroller, text) { alignPos(Math.max(0, Math.min(pos, view.state.doc.length)), clientTop, scroller, text); },
    /** 记住一个插入位置（默认是现在的选区），之后的编辑会把它往后推 */
    track(from, to) {
      const sel = view.state.selection.main;
      const m = from == null ? { from: sel.from, to: sel.to } : { from, to: to == null ? from : to };
      markers.add(m); return m;
    },
    insertAt(m, text) {
      markers.delete(m);
      const len = view.state.doc.length, from = Math.min(m.from, len), to = Math.min(Math.max(m.to, from), len);
      view.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length) });
    },
    untrack(m) { markers.delete(m); },
    /** 工具栏的段落格式下拉 */
    setBlock(kind) {
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: setBlock(view.state.doc.toString(), from, to, kind) });
      view.focus();
    },
    /** 阅读模式里点的勾选框：只改原文里那一个方括号里的字 */
    toggleTask(pos) {
      const ch = view.state.sliceDoc(pos + 1, pos + 2);
      if (view.state.readOnly || view.state.sliceDoc(pos, pos + 1) !== '[' || !/^[ xX]$/.test(ch)) return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: ch === ' ' ? 'x' : ' ' } });
    },
    destroy() { view.destroy(); },
  };
}
