// renderMarkdown 的结构判据（第五十五轮）—— 直接跑 assets/zhiqu-api.js 里发布的那份实现。
//
//   用法：node src/test/resources/js/markdown-check.js <zhiqu-api.js 的路径>
//   退出码 0 = 全绿；非 0 = 有判据红了，逐条打印在上面。
//
// 由 WikiLookTest 调用。手动跑也行。
//
// 第五十五轮之前 renderMarkdown 给每个标签带一串内联样式（<p style="margin:8px 0;…">）：
// 知识 Wiki 的编辑器插进去的标题、列表、勾选项没有这些，和渲染出来的长得不一样；想给 Wiki 的正文换一套读长文的排版，
// 也只能去改这个 AI 助手和 Wiki 共用的函数。现在样子全在 zhiqu-ui.css 的 .zq-md（Wiki 另加 .zq-prose）。
// 这里钉三件事：
//   判据 1  每个标签只带白名单里的属性 —— 没有 style（代码块里着色的 span 归 highlight-check.js 管，这里整段跳过 <pre>）
//   判据 2  每种块长成约定的样子、每个类和要紧的标签在样式表里都有规则（没有规则的类就是没穿衣服）
//   判据 3  别的地方不往页面里放 Markdown 的类 —— 第五十二轮任务页的行叫 .zq-task-row，和勾选项重名，
//           Wiki 里的待办被画成了任务表格的一行（带边框、按网格排），三轮里没人发现。
//           只有 Wiki 编辑器插入的那一种（和渲染出来的勾选项一模一样的结构）是同一个东西。

const fs = require('fs');
const path = require('path');
const apiPath = process.argv[2];
const src = fs.readFileSync(apiPath, 'utf8');
const assets = path.dirname(apiPath);
const staticDir = path.dirname(assets);
const css = fs.readFileSync(path.join(assets, 'zhiqu-ui.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function slice(startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error('抠不到起点: ' + startMark);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error('抠不到终点: ' + endMark);
  return src.slice(a, b);
}
const escSrc = slice('function esc(v) {', 'function maintainShellCache');
const mdSrc = slice('  function mathBlockHtml(', '  // KaTeX 懒加载');
for (const fn of ['mdInline', 'highlightCode', 'renderMarkdown', 'inlineMathSpan']) {
  if (!new RegExp('function ' + fn + '\\(').test(mdSrc)) throw new Error('抠出来的片段里没有 ' + fn);
}
const renderMarkdown = new Function(escSrc + '\n' + mdSrc + '\nreturn renderMarkdown;')();

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}

const SAMPLE = [
  '# 一级 **粗**',
  '## 二级',
  '### 三级',
  '#### 四级',
  '##### 五级',
  '###### 六级',
  '正文 `code` 和 [链接](https://example.com/a_(b)) 和 [[某页]] 和 $x^2$ 。',
  '',
  '- 无序',
  '',
  '1. 有序',
  '',
  '> 引用',
  '',
  '- [ ] 没做',
  '- [x] 做完',
  '  - 子项',
  '',
  '3. 从三开始',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```js',
  'const a = "<b>";',
  '```',
  '',
  '$$',
  '\\int_0^1 x',
  '$$',
  '',
  '---',
  '',
  '最后一段。'
].join('\n');
const html = renderMarkdown(SAMPLE);
const outsidePre = html.replace(/<pre>[\s\S]*?<\/pre>/g, '');

// ── 判据 1 ──
console.log('── 判据 1：每个标签只带白名单里的属性（没有 style） ──');
const ALLOWED = {
  div: ['class', 'data-tex', 'contenteditable'],
  span: ['class', 'data-tex', 'contenteditable'],
  input: ['type', 'checked', 'contenteditable'],
  ol: ['start'],
  a: ['href', 'target', 'rel', 'data-wikilink']
};
const tags = [...outsidePre.matchAll(/<([a-z][a-z0-9]*)(\s[^>]*)?>/g)];
judge('看到的标签不少于 25 个（扫空了就是假绿）', tags.length >= 25, '只看到 ' + tags.length + ' 个');
const stray = [];
for (const t of tags) {
  const names = [...(t[2] || '').matchAll(/([a-z-]+)(?:="[^"]*")?/g)].map(m => m[1]);
  const ok = ALLOWED[t[1]] || [];
  for (const n of names) if (!ok.includes(n)) stray.push('<' + t[1] + ' ' + n + '>');
}
judge('没有白名单之外的属性', stray.length === 0, [...new Set(stray)].join('、'));

// ── 判据 2 ──
console.log('── 判据 2：每种块的样子；类和标签在样式表里有规则 ──');
judge('外面恰好包一层 .zq-md', html.startsWith('<div class="zq-md">') && html.endsWith('</div>')
  && (html.match(/class="zq-md"/g) || []).length === 1, html.slice(0, 60));
const EXPECT = [
  '<h1>一级 <strong>粗</strong></h1>', '<h2>二级</h2>', '<h3>三级</h3>', '<h4>四级</h4>', '<h5>五级</h5>', '<h6>六级</h6>',
  '<code>code</code>', '<a href="https://example.com/a_(b)" target="_blank" rel="noopener noreferrer">链接</a>',
  '<a data-wikilink="某页">某页</a>', '<span class="zq-math-i" data-tex="x^2" contenteditable="false"><span class="zq-mono">x^2</span></span>',
  '<ul><li>无序</li></ul>', '<ol><li>有序</li></ol>', '<blockquote>引用</blockquote>',
  '<div class="zq-task-row"><input type="checkbox" contenteditable="false"><span>没做</span></div>',
  '<div class="zq-task-row"><input type="checkbox" checked contenteditable="false"><span>做完</span></div>',
  '<div class="zq-task-children"><ul><li>子项</li></ul></div>', '<ol start="3"><li>从三开始</li></ol>',
  '<div class="zq-md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>',
  '<pre><code class="zq-mono">', '<div class="zq-math" data-tex="\\int_0^1 x" contenteditable="false">', '<hr>', '<p>最后一段。</p>'
];
for (const e of EXPECT) judge('有 ' + e.slice(0, 48), html.includes(e), '实际：' + html);

const selectors = [];
for (const m of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
  for (const s of m[1].split(',')) selectors.push(s.trim());
}
const classes = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)));
judge('渲染出来的类不少于 6 个', classes.size >= 6, [...classes].join(' '));
for (const c of classes) {
  const re = new RegExp('\\.' + c + '(?![\\w-])');
  judge('.' + c + ' 在 zhiqu-ui.css 里有规则', selectors.some(s => re.test(s)));
}
// 浏览器默认样式下这些会走样（标题太大、表格没线、引用缩进一大块、链接紫色……）：每个都要在 .zq-md 下有一条
for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'th', 'td', 'hr', 'a']) {
  const has = selectors.some(s => /^\.zq-md\s/.test(s)
    && s.split(/[\s>+~]+/).slice(1).some(tok => tok.replace(/[[:].*$/, '') === tag || tok.endsWith(')' + tag)));
  judge('.zq-md ' + tag + ' 在 zhiqu-ui.css 里有规则', has);
}

// ── 判据 3 ──
console.log('── 判据 3：别的地方不往页面里放 Markdown 的类 ──');
const MD_CLASSES = ['zq-md', 'zq-md-table', 'zq-task-row', 'zq-task-children', 'zq-math', 'zq-math-i'];
// 和渲染出来的勾选项一模一样的结构：Wiki 编辑器的「插入待办」，同一个东西，不算撞名
const SAME_THING = '<div class="zq-task-row"><input type="checkbox"';
function files(dir, out) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (f.name !== 'vendor') files(p, out); }
    else if (/\.(js|html)$/.test(f.name)) out.push(p);
  }
  return out;
}
const scanned = files(staticDir, []);
judge('扫到的文件不少于 25 个', scanned.length >= 25, '只扫到 ' + scanned.length + ' 个');
const collisions = [];
let sameThing = 0;
for (const f of scanned) {
  let text = fs.readFileSync(f, 'utf8');
  // 渲染器自己（renderMarkdown 和两个公式小函数）放这些类是本分
  if (path.resolve(f) === path.resolve(apiPath)) text = text.replace(mdSrc, '');
  // 放类的写法：class="…" / class='…'（含 \"）、className = '…'、classList.add / toggle('…')
  const emits = /class=\\?["']([^"'\\]*)|className\s*=\s*["']([^"']*)|classList\.(?:add|toggle)\(\s*["']([^"']*)/g;
  for (const m of text.matchAll(emits)) {
    const names = (m[1] || m[2] || m[3] || '').split(/\s+/);
    const hit = names.filter(n => MD_CLASSES.includes(n));
    if (!hit.length) continue;
    if (text.startsWith(SAME_THING, m.index - '<div '.length) && names.length === 1 && names[0] === 'zq-task-row') { sameThing++; continue; }
    collisions.push(path.relative(staticDir, f) + '：' + text.slice(m.index, m.index + 60).replace(/\n/g, ' '));
  }
}
judge('Wiki 编辑器的「插入待办」恰好被认出 1 处（认不出来就是这条扫描没在看）', sameThing === 1, '认出 ' + sameThing + ' 处');
judge('没有别处借用 Markdown 的类', collisions.length === 0, '\n      ' + collisions.join('\n      '));

console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
