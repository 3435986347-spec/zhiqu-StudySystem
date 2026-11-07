// 生成的文件（第一百一十六轮）—— 直接 import 发布的 assets/pages/ai-assistant.js。
//
//   用法：node src/test/resources/js/generated-files-check.js <assets 目录>
//   盯的是：文件名是别人写的（模型、命令），不能变成 HTML；没存的说为什么、不给按钮；HTML 关在没有同源权限的 iframe 里；
//   不认识的、写成 .txt 的 HTML 都当纯文本；图片的类型按扩展名给；二进制不当文本；太长的只预览开头。
//   由 AiComposerTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const assert = require('assert/strict');
const path = require('path');

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.attrs = {}; }
  setAttribute(k, v) { this.attrs[k] = v; }
}
globalThis.document = { createElement: (t) => new El(t) };
globalThis.URL.createObjectURL = (b) => { globalThis.lastBlob = b; return 'blob:x'; };

let failed = 0;
const check = (name, fn) => { try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n', e.message); } };

(async () => {
  const mod = await import('file://' + path.resolve(process.argv[2], 'pages', 'ai-assistant.js'));
  mod.bind({ esc, icon: () => '<svg></svg>', renderMarkdown: (t) => '<p>' + esc(t) + '</p>', state: {}, $: () => null, $all: () => [] });
  const html = (files) => mod.generatedFilesHtml({ id: 7, content: { files } });
  const bytes = (s) => new TextEncoder().encode(s);

  check('一行一个：名字、大小、预览、下载；按钮带着产物和文件的 id', () => {
    const h = html([{ id: 3, path: 'dir/a.py', size: 2048 }]);
    assert.ok(h.includes('dir/a.py') && h.includes('2.0 KB'));
    assert.ok(h.includes('data-gen-view="1"') && h.includes('data-gen-down="1"'));
    assert.ok(h.includes('data-gen-artifact="7"') && h.includes('data-gen-file="3"'));
  });

  check('没存的：说为什么，不给按钮（点了也取不到）', () => {
    const h = html([{ id: null, path: 'big.bin', size: 9000000, skipped: '超过单个文件 5MB 的上限' }]);
    assert.ok(h.includes('超过单个文件 5MB 的上限') && h.includes('8.6 MB'));
    assert.ok(!h.includes('data-gen-view') && !h.includes('data-gen-down'));
  });

  check('文件名是别人写的：不能变成标签，也跳不出属性', () => {
    const h = html([{ id: 1, path: '"><img src=x onerror=alert(1)>.txt', size: 1 }]);
    assert.ok(!h.includes('<img'), h);
    assert.ok(!/data-gen-path=""/.test(h), '引号没转义');
    const skip = html([{ id: null, path: 'x', size: 1, skipped: '<script>alert(1)</script>' }]);
    assert.ok(!skip.includes('<script>'));
  });

  check('没有文件、不是数组：什么都不画', () => {
    assert.equal(html([]), '');
    assert.equal(mod.generatedFilesHtml({ id: 7, content: { files: 'x' } }), '');
    assert.equal(mod.generatedFilesHtml({ id: 7, content: {} }), '');
  });

  check('预览的种类按扩展名，认不出的都当文本', () => {
    for (const [p, k] of [['a.html', 'html'], ['A.HTM', 'html'], ['r.md', 'markdown'], ['r.markdown', 'markdown'], ['p.PNG', 'image'], ['p.jpg', 'image'], ['p.svg', 'image'],
      ['x.py', 'text'], ['Makefile', 'text'], ['.html', 'text'], ['a.html.txt', 'text'], ['dir.html/a.txt', 'text']]) {
      assert.equal(mod.genPreviewKind(p), k, p);
    }
  });

  check('HTML：iframe 只给 allow-scripts，没有 allow-same-origin，内容进 srcdoc', () => {
    const n = mod.genPreviewNode('html', 'a.html', null, bytes('<script>top.location="x"</script>'));
    assert.equal(n.tagName, 'IFRAME');
    assert.equal(n.attrs.sandbox, 'allow-scripts', '加上 allow-same-origin 脚本就拿得到登录令牌');
    assert.ok(n.srcdoc.includes('<script>'));
  });

  check('文本：只进 textContent，写成 .txt 的 HTML 不会被当标签', () => {
    const n = mod.genPreviewNode('text', 'a.txt', null, bytes('<img src=x onerror=alert(1)>'));
    assert.equal(n.tagName, 'PRE');
    assert.equal(n.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(n.innerHTML, undefined);
  });

  check('Markdown：走渲染（渲染器自己转义），不是直接塞', () => {
    const n = mod.genPreviewNode('markdown', 'a.md', null, bytes('<b>x</b>'));
    assert.equal(n.innerHTML, '<p>&lt;b&gt;x&lt;/b&gt;</p>');
  });

  check('图片：类型按扩展名给，不信文件自己说的；走 <img>（SVG 里的脚本不跑）', () => {
    const n = mod.genPreviewNode('image', 'p.svg', new Blob(['<svg/>'], { type: 'text/html' }), bytes('<svg/>'));
    assert.equal(n.tagName, 'IMG');
    assert.equal(n.alt, 'p.svg');
    assert.equal(globalThis.lastBlob.type, 'image/svg+xml');
  });

  check('二进制不当文本，HTML、Markdown 也一样', () => {
    for (const kind of ['text', 'html', 'markdown']) {
      const n = mod.genPreviewNode(kind, 'x', null, new Uint8Array([65, 0, 66]));
      assert.ok(n.textContent.includes('不是文本'), kind);
    }
  });

  check('太长的只预览开头，说清楚；UTF-8 切半个字不炸', () => {
    const big = bytes('中'.repeat(100000));
    const n = mod.genPreviewNode('text', 'x.txt', null, big);
    assert.ok(n.textContent.includes('只预览开头'));
    assert.ok(n.textContent.length < 100000);
    const small = mod.genPreviewNode('text', 'x.txt', null, bytes('短'));
    assert.equal(small.textContent, '短');
  });

  check('之前生成的文件：这一轮卡片上有的路径不重复；每个文件带自己的产物 id（下载要对得上）；没有就不画', () => {
    const all = [{ id: 1, artifactId: 10, path: 'old.txt', size: 1 }, { id: 2, artifactId: 11, path: 'same.txt', size: 2 }];
    const now = [{ artifactType: 'GENERATED_FILES', content: { files: [{ id: 2, path: 'same.txt', size: 2 }, { id: null, path: 'big.bin', size: 9, skipped: '太大' }] } },
      { artifactType: 'CODE_DRAFT', content: { files: [{ path: 'old.txt' }] } }];
    const earlier = mod.earlierGeneratedFiles(all, now);
    assert.deepEqual(earlier.map((f) => f.path), ['old.txt'], '别的类型的产物不算');
    const card = mod.earlierFilesCard(earlier);
    assert.ok(card.includes('之前生成的 1 个文件'));
    assert.ok(card.includes('data-gen-artifact="10"') && card.includes('data-gen-file="1"'), card);
    assert.equal(mod.earlierFilesCard([]), '');
    assert.deepEqual(mod.earlierGeneratedFiles(null, null), []);
    assert.deepEqual(mod.earlierGeneratedFiles(all, []).map((f) => f.path), ['old.txt', 'same.txt']);
  });

  check('大小的写法', () => {
    assert.equal(mod.humanSize(0), '0 B');
    assert.equal(mod.humanSize(1023), '1023 B');
    assert.equal(mod.humanSize(1536), '1.5 KB');
    assert.equal(mod.humanSize(20480), '20 KB');
    assert.equal(mod.humanSize(5242880), '5.0 MB');
    assert.equal(mod.humanSize(null), '0 B');
  });

  if (failed) { console.log(failed + ' FAILED'); process.exit(1); }
  console.log('ALL-GREEN');
})().catch((e) => { console.error(e); process.exit(1); });
