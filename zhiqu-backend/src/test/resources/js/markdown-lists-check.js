// 嵌套列表（第七十一轮）：直接跑 assets/zhiqu-api.js 里发布的 renderMarkdown 和 htmlToMarkdown。
//
//   用法：node src/test/resources/js/markdown-lists-check.js <zhiqu-api.js 的路径>
//
// 第七十轮量出来：阅读模式不认缩进的嵌套列表 —— `  - 嵌套一` 显示成文字「- 嵌套一」，CodeMirror 编辑器保住的结构一读就压平；
// 旧编辑器（第 3 步之前还是默认）保存时 htmlToMarkdown 把嵌套压成一层。这里钉：
//   阅读  2 / 4 空格和 Tab 的缩进、有序无序混着、任务项（在列表项下面、或者下面有子项）、列表项里的续行和空行后的段落、编号从几开始
//   不变  顶层列表之间隔空行照旧是两段、换种类照旧另起、不缩进的下一行照旧收掉列表（旧编辑器的保存靠这几样往回写）
//   保存  旧编辑器把渲染出来的嵌套写回缩进、编号照原样（htmlToMarkdown 要的 DOM 用下面这个只认这些标签的小解析器搭）
const fs = require('fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
function slice(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error('抠不到发布的实现：' + start);
  return source.slice(a, b);
}
const code = slice('  function esc(v) {', '  function maintainShellCache')
  + slice('  function mathBlockHtml(', '  // KaTeX 懒加载')
  + slice('  function htmlToMarkdown(root) {', '  // ── 几个各页共用的小件');
const { renderMarkdown, htmlToMarkdown } = new Function('state', code + '\nreturn {renderMarkdown,htmlToMarkdown};')({ wikiPages: [] });
const body = (md) => renderMarkdown(md).replace(/^<div class="zq-md">|<\/div>$/g, '');
const row = (text, done) => '<div class="zq-task-row"><input type="checkbox" ' + (done ? 'checked ' : '') + 'contenteditable="false"><span>' + text + '</span></div>';

function decode(v) { return v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function parse(html) {
  const root = { nodeType: 1, tagName: 'DIV', childNodes: [], getAttribute: () => null };
  const stack = [root];
  const add = (parent, node) => { node.parentNode = parent; node.previousSibling = parent.childNodes[parent.childNodes.length - 1] || null; parent.childNodes.push(node); };
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*>|([^<]+)/g)) {
    const parent = stack[stack.length - 1];
    if (m[4] != null) { add(parent, { nodeType: 3, nodeValue: decode(m[4]) }); continue; }
    const tag = m[2].toUpperCase();
    if (m[1]) { while (stack.length > 1 && stack.pop().tagName !== tag) { /* 收到同名的开标签为止 */ } continue; }
    const attrs = Object.fromEntries([...m[3].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] == null ? '' : decode(a[2])]));
    const el = { nodeType: 1, tagName: tag, childNodes: [], checked: 'checked' in attrs, getAttribute: (k) => (k in attrs ? attrs[k] : null) };
    add(parent, el);
    if (!/^(BR|HR|INPUT|IMG)$/.test(tag)) stack.push(el);
  }
  return root;
}
const save = (md) => htmlToMarkdown(parse(body(md)));

let failed = 0, checks = 0;
function check(name, fn) { checks++; try { fn(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } }

check('阅读：两格缩进的子项嵌进上一项里', () => {
  assert.equal(body('- 一\n  - 二\n  - 三\n- 四'), '<ul><li>一<ul><li>二</li><li>三</li></ul></li><li>四</li></ul>');
});
check('阅读：有序里嵌无序（四格缩进）', () => {
  assert.equal(body('1. 一\n    - 二\n2. 三'), '<ol><li>一<ul><li>二</li></ul></li><li>三</li></ol>');
});
check('阅读：三层、Tab 缩进', () => {
  assert.equal(body('- a\n\t- b\n\t\t- c\n- d'), '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
});
check('阅读：列表项下面的任务项', () => {
  assert.equal(body('- 项目\n  - [ ] 子任务\n  - [x] 做完\n- 下一项'), '<ul><li>项目' + row('子任务') + row('做完', true) + '</li><li>下一项</li></ul>');
});
check('阅读：任务项下面的子项放进 .zq-task-children', () => {
  assert.equal(body('- [ ] 任务\n  - 细节\n  - [ ] 子任务\n- [x] 另一个'),
    row('任务') + '<div class="zq-task-children"><ul><li>细节</li></ul>' + row('子任务') + '</div>' + row('另一个', true));
});
check('阅读：列表项里缩进的续行接在这一项里', () => {
  assert.equal(body('- 第一项\n  接着写\n- 第二项'), '<ul><li>第一项<br>接着写</li><li>第二项</li></ul>');
});
check('阅读：空行后缩进的段落还在这一项里；编号接着往下（不是每段都从 1 开始）', () => {
  assert.equal(body('1. **甲**\n\n   说明甲\n\n2. 乙'), '<ol><li><strong>甲</strong><p>说明甲</p></li></ol><ol start="2"><li>乙</li></ol>');
  assert.equal(body('3. 三\n4. 四'), '<ol start="3"><li>三</li><li>四</li></ol>');
});
check('阅读：空行后缩进的子项照样嵌进去', () => {
  assert.equal(body('- a\n\n  - b'), '<ul><li>a<ul><li>b</li></ul></li></ul>');
});
check('阅读：缩进退回到上一层和下一层之间，算上一层的兄弟', () => {
  assert.equal(body('- a\n  - b\n - c'), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
});
check('阅读：同一个父项下面缩进不齐（先 4 格再 2 格）还是同一层；顶层的项缩进不齐也是同一段', () => {
  assert.equal(body('- a\n    - b\n  - c'), '<ul><li>a<ul><li>b</li><li>c</li></ul></li></ul>');
  assert.equal(body('  - a\n- b'), '<ul><li>a</li><li>b</li></ul>');
});
check('阅读：没有列表开着时缩进的项照样是列表（原来显示成文字「- 子」）', () => {
  assert.equal(body('  - 子'), '<ul><li>子</li></ul>');
});
check('不变：顶层隔空行是两段、换种类另起、不缩进的下一行收掉列表、代码块收掉列表、两条任务', () => {
  assert.equal(body('- a\n\n- b'), '<ul><li>a</li></ul><ul><li>b</li></ul>');
  assert.equal(body('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>');
  assert.equal(body('- a\n正文'), '<ul><li>a</li></ul><p>正文</p>');
  assert.ok(body('- a\n```\nx\n```').startsWith('<ul><li>a</li></ul><pre>'), body('- a\n```\nx\n```'));
  assert.equal(body('- [ ] 没做\n- [x] 做完'), row('没做') + row('做完', true));
});
check('旧编辑器保存：嵌套写回缩进（原来压成一层）', () => {
  for (const md of ['- 一\n  - 二\n  - 三\n- 四', '- a\n  - b\n    - c\n- d', '1. 一\n   - 二\n2. 三', '- 第一项\n  接着写\n- 第二项']) {
    assert.equal(save(md), md + '\n', JSON.stringify(md));
  }
});
check('旧编辑器保存：勾选项一行一个、和普通列表项挨着也不插空行（原来每条后面都插一个空行）；任务项的子项、列表项下的任务项都写回缩进', () => {
  for (const md of ['- [ ] 没做\n- [x] 做完', '- [x] 做完\n- 普通项', '- 普通项\n- [ ] 待办\n1. 有序', '- [ ] 任务\n  - 细节\n- [x] 另一个', '- 项目\n  - [ ] 子任务\n- 下一项']) {
    assert.equal(save(md), md + '\n', JSON.stringify(md));
  }
});
check('旧编辑器保存：编号照原样（原来一律写成 1.）；顶层隔空行的两段照旧', () => {
  assert.equal(save('3. 三\n4. 四'), '3. 三\n4. 四\n');
  assert.equal(save('- a\n\n- b'), '- a\n\n- b\n');
});

console.log(checks < 15 ? 'RED: 判据少了（' + checks + '）' : failed ? 'RED: ' + failed : 'ALL-GREEN');
if (failed || checks < 15) process.exitCode = 1;
