// 知识 Wiki 的编辑内核验证版（第七十轮，docs/rounds/round-70.md）：CodeMirror 6 的「实时预览」。
// Markdown 原文是唯一的真相：编辑器只决定怎么显示，不改写 —— 不改内容就保存，回来是一模一样的字节
//（现在的 contentEditable 编辑器保存时要把 HTML 转回 Markdown，嵌套列表、代码块语言、表格对齐、硬换行都会丢）。
// 光标不在的地方藏语法、显示成品（标题、加粗、斜体、删除线、行内代码、链接、[[双链]]、公式、任务勾选），光标进去才露出原文。
// 开关：localStorage「zq.wikiEditor」= 「cm」（默认关，现在的编辑器不动）。阅读模式照旧用 renderMarkdown。
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

/** 选区两边加 / 去标记（加粗 **、斜体 *、行内代码 `）：已经包着就去掉，没有就加上；返回 CodeMirror 的 changes 和新选区 */
export function toggleWrap(text, from, to, mark) {
  const before = text.slice(Math.max(0, from - mark.length), from); const after = text.slice(to, to + mark.length);
  if (before === mark && after === mark) {
    return { changes: [{ from: from - mark.length, to: from, insert: '' }, { from: to, to: to + mark.length, insert: '' }],
      anchor: from - mark.length, head: to - mark.length };
  }
  return { changes: [{ from, insert: mark }, { from: to, insert: mark }], anchor: from + mark.length, head: to + mark.length };
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

const hide = Decoration.replace({});
const line = (cls) => Decoration.line({ class: cls });
const mark = (cls) => Decoration.mark({ class: cls });

function inlineDecorations(view, options) {
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
        for (let pos = node.from; pos <= node.to;) { const l = state.doc.lineAt(pos); out.push(line('cm-zq-codeblock').range(l.from)); pos = l.to + 1; }
        codeRanges.push([node.from, node.to]);
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
        if (marks.length >= 2) {
          out.push(hide.range(marks[0].from, marks[0].to));
          out.push(mark('cm-zq-link').range(marks[0].to, marks[1].from));
          out.push(hide.range(marks[1].from, node.to));
        }
        return false;
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
      out.push(Decoration.replace({ widget: new TextWidget(link.label || link.target, link.embed ? 'cm-zq-wikilink cm-zq-embed' : 'cm-zq-wikilink',
        () => options.onNavigate && options.onNavigate(link.target)) }).range(link.from, link.to));
    }
    for (const math of inlineMathRanges(text, from)) {
      if (inCode(math.from, math.to) || touched(state, math.from, math.to)) continue;
      out.push(Decoration.replace({ widget: new MathWidget(math.tex, false) }).range(math.from, math.to));
    }
  }
  return Decoration.set(out, true);
}

// 块公式横跨多行：多行的替换只能放在 StateField 里（ViewPlugin 不许出跨行的块装饰）
const blockMath = StateField.define({
  create(state) { return blockMathDecorations(state); },
  update(value, tr) { return tr.docChanged || tr.selection ? blockMathDecorations(tr.state) : value; },
  provide: (field) => EditorView.decorations.from(field),
});
function blockMathDecorations(state) {
  const out = [];
  for (const block of blockMathRanges(state.doc.toString())) {
    if (touched(state, block.from, block.to)) continue;
    out.push(Decoration.replace({ widget: new MathWidget(block.tex, true), block: true }).range(block.from, block.to));
  }
  return Decoration.set(out, true);
}

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
  '.cm-zq-h1': { fontSize: '24px', lineHeight: '1.35', paddingTop: '20px' },
  '.cm-zq-h2': { fontSize: '19px', lineHeight: '1.4', paddingTop: '18px' },
  '.cm-zq-h3': { fontSize: '16px', lineHeight: '1.45', paddingTop: '14px' },
  '.cm-zq-h4, .cm-zq-h6': { color: 'var(--zq-text2)' },
  '.cm-zq-strong': { fontWeight: 'var(--zq-fw-semibold)' },
  '.cm-zq-em': { fontStyle: 'italic' },
  '.cm-zq-del': { textDecoration: 'line-through', color: 'var(--zq-text3)' },
  '.cm-zq-code': { fontFamily: 'var(--zq-fontM)', fontSize: '0.92em', background: 'var(--zq-card-soft)', borderRadius: '4px' },
  '.cm-zq-codeblock': { fontFamily: 'var(--zq-fontM)', fontSize: '13px', background: 'var(--zq-card-soft)' },
  '.cm-zq-link, .cm-zq-wikilink': { color: 'var(--zq-primary)', textDecoration: 'underline', textUnderlineOffset: '3px', cursor: 'pointer' },
  '.cm-zq-embed': { display: 'inline-block', padding: '0 8px', borderLeft: '2px solid var(--zq-border)' },
  '.cm-zq-wikilink-src, .cm-zq-quote-mark, .cm-zq-list-mark': { color: 'var(--zq-text3)' },
  '.cm-zq-task': { margin: '0 6px 0 0', verticalAlign: 'middle' },
  '.cm-zq-math-block': { textAlign: 'center', padding: '6px 0' },
});

/** 把编辑器挂到 host 里。options：markdown、titles()（[[ 补全用的页名）、onNavigate(title)、onChange()、readOnly */
export function mountWikiEditor(host, options) {
  const readOnly = new Compartment();
  const completeTitles = (context) => {
    const before = context.matchBefore(/\[\[[^\]\n|]*/);
    if (!before) return null;
    return { from: before.from + 2, options: (options.titles ? options.titles() : []).map((title) => ({ label: title, apply: `${title}]]` })), validFor: /^[^\]\n|]*$/ };
  };
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: options.markdown || '',
      extensions: [
        history(), drawSelection(), EditorView.lineWrapping,
        new LanguageSupport(markdownLanguage), syntaxHighlighting(highlight),
        keymap.of([{ key: 'Enter', run: insertNewlineContinueMarkup }, { key: 'Backspace', run: deleteMarkupBackward },
          ...completionKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
        autocompletion({ override: [completeTitles], icons: false }),
        livePreview(options), blockMath, theme,
        readOnly.of([EditorState.readOnly.of(Boolean(options.readOnly)), EditorView.editable.of(!options.readOnly)]),
        EditorView.updateListener.of((update) => { if (update.docChanged && options.onChange) options.onChange(); }),
      ],
    }),
  });
  return {
    view,
    getMarkdown: () => view.state.doc.toString(),
    setReadOnly(locked) {
      view.dispatch({ effects: readOnly.reconfigure([EditorState.readOnly.of(locked), EditorView.editable.of(!locked)]) });
    },
    /** 工具栏：加粗 / 斜体 / 行内代码 */
    wrap(markText) {
      const { from, to } = view.state.selection.main;
      const result = toggleWrap(view.state.doc.toString(), from, to, markText);
      view.dispatch({ changes: result.changes, selection: EditorSelection.single(result.anchor, result.head) });
      view.focus();
    },
    insert(text) { view.dispatch(view.state.replaceSelection(text)); view.focus(); },
    focusAt(x, y) {
      const pos = x != null && y != null ? view.posAtCoords({ x, y }) : null;
      view.focus();
      if (pos != null) view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: false });
    },
    destroy() { view.destroy(); },
  };
}
