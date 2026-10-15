// Exercise the published Markdown renderer and serializer with synthetic URLs only.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
function slice(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error('Cannot find published implementation: ' + start);
  return source.slice(a, b);
}
const code = slice('  function esc(v) {', '  function maintainShellCache')
  + slice('  function mathBlockHtml(', '  // KaTeX 懒加载')
  + slice('  function htmlToMarkdown(root) {', '  // ── 几个各页共用的小件');
const { renderMarkdown, htmlToMarkdown } = new Function('state', code + '\nreturn {renderMarkdown,htmlToMarkdown};')({wikiPages:[]});
function decode(value) { return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function links(markdown) {
  const html = renderMarkdown(markdown);
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(match => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], decode(a[2])]));
    return { attrs, text: decode(match[2]), html, tagName: 'A', nodeType: 1,
      getAttribute: name => attrs[name] ?? null, childNodes: [{nodeType:3,nodeValue:decode(match[2])}] };
  });
}
let checks = 0, failures = 0;
function check(name, fn) { checks++; try { fn(); console.log('PASS ' + name); } catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); } }
check('bare HTTP(S) URLs become escaped external links with the exact target', () => {
  const urls = ['https://example.test/pages/view?pageId=3288760375&mode=full#heading', 'http://example.test/tickets/SPSK-304428%5BVN%5D%5BBCL%5DCross', 'HTTPS://example.test/path_with_under_scores/a*b'];
  const actual = links(urls.join('\n'));
  assert.equal(actual.length, 3);
  actual.forEach((link, i) => {
    assert.equal(link.attrs.href, urls[i]); assert.equal(link.text, urls[i]);
    assert.equal(link.attrs.target, '_blank'); assert.equal(link.attrs.rel, 'noopener noreferrer');
    assert.equal(link.attrs['data-autolink-markdown'], urls[i]);
  });
  assert.match(actual[0].html, /pageId=3288760375&amp;mode=full/);
});
check('angle URLs render without angle characters and preserve their original syntax', () => {
  const raw = '<https://example.test/a_(b)?first=one&second=two>';
  const [link] = links(raw); assert.ok(link);
  assert.equal(link.attrs.href, raw.slice(1, -1)); assert.equal(link.text, raw.slice(1,-1));
  assert.equal(htmlToMarkdown({childNodes:[link]}), raw + '\n');
});
check('English and Chinese sentence punctuation stays outside links', () => {
  for (const punctuation of ['.', ',', ';', ':', '!', '?', '。', '，', '；', '：', '！', '？', '、', '）', '】', '》', '”', '’']) {
    const [link] = links('See https://example.test/path' + punctuation + ' 后文');
    assert.ok(link, punctuation); assert.equal(link.attrs.href, 'https://example.test/path', punctuation);
    assert.ok(link.html.includes('</a>' + punctuation), punctuation);
  }
});
check('balanced URL parentheses stay inside while enclosing and unmatched brackets stay outside', () => {
  const html = renderMarkdown('(https://example.test/a_(b)). https://example.test/b[c]] https://example.test/a_(b(c)))');
  const actual = links('(https://example.test/a_(b)). https://example.test/b[c]] https://example.test/a_(b(c))) https://example.test/{value}}');
  assert.deepEqual(actual.map(l => l.attrs.href), ['https://example.test/a_(b)', 'https://example.test/b[c]', 'https://example.test/a_(b(c))', 'https://example.test/{value}']);
  assert.match(html, /a_\(b\)<\/a>\)\./);
});
check('formatting surrounds a URL without altering URL stars or underscores', () => {
  const html = renderMarkdown('**https://example.test/a*b_c** and *https://example.test/two*');
  assert.match(html, /<strong><a [^>]+>https:\/\/example\.test\/a\*b_c<\/a><\/strong>/);
  assert.match(html, /<em><a [^>]+>https:\/\/example\.test\/two<\/a><\/em>/);
});
check('inline code, code blocks and math remain literal rather than autolinks', () => {
  const markdown = '`https://example.test/code`\n```text\nhttps://example.test/fenced\n```\n$x_1=https://example.test/math$\n$$\nhttps://example.test/blockmath\n$$';
  assert.equal(links(markdown).length, 0);
  assert.match(renderMarkdown(markdown), /<code>https:\/\/example\.test\/code<\/code>/);
});
check('existing Markdown links and Wiki aliases never acquire nested anchors', () => {
  const html = renderMarkdown('[https://example.test/label](https://example.test/a_(b)?x=1&y=2)\n[[Page|https://example.test/alias]]');
  assert.equal((html.match(/<a\b/g)||[]).length, 2);
  assert.doesNotMatch(html, /<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
  assert.match(html, /href="https:\/\/example\.test\/a_\(b\)\?x=1&amp;y=2"/);
});
check('images, note embeds and private attachment links remain protected', () => {
  const html = renderMarkdown('![https://example.test/label](https://example.test/image_under_score.png)\n![[Page|https://example.test/alias]]\n[https://example.test/file](/api/knowledge/attachments/7)');
  assert.equal((html.match(/<a\b/g)||[]).length, 1);
  assert.match(html, /data-zq-private-download="\/api\/knowledge\/attachments\/7"/);
  assert.match(html, /src="https:\/\/example\.test\/image_under_score\.png"/);
  assert.match(html, /data-zq-note-embed="Page"/);
});
check('HTML delimiters and quotes cannot inject attributes or elements', () => {
  const html = renderMarkdown('https://example.test/path?q=one&two=three" onclick="alert(1) <https://example.test/path?a=1&b=2> <img src=x onerror=alert(1)>');
  assert.equal(links('https://example.test/path?q=one&two=three" onclick="alert(1)').length, 1);
  assert.doesNotMatch(html, /\sonclick="alert|<img\b/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
check('unsafe schemes and URL-like substrings inside identifiers stay plain', () => {
  assert.equal(links('javascript:alert(1) data:text/html,test file:///tmp/test ftp://example.test ahttps://example.test user@https://example.test').length, 0);
});
check('saving bare autolinks preserves the original source rather than adding Markdown brackets', () => {
  for (const raw of ['https://example.test/a_(b)?q=one&other=two', 'http://example.test/path_with_underscores']) {
    const [link] = links(raw); assert.ok(link);
    assert.equal(htmlToMarkdown({childNodes:[link]}), raw + '\n');
  }
});
check('editing URL text or destination is retained instead of restoring an obsolete marker', () => {
  const [textEdited] = links('https://example.test/old'); assert.ok(textEdited);
  textEdited.childNodes[0].nodeValue = 'Updated label';
  assert.equal(htmlToMarkdown({childNodes:[textEdited]}), '[Updated label](https://example.test/old)\n');
  const [targetEdited] = links('<https://example.test/old>');
  targetEdited.attrs.href = 'https://example.test/new';
  assert.equal(htmlToMarkdown({childNodes:[targetEdited]}), '[https://example.test/old](https://example.test/new)\n');
});
check('Markdown link labels retain formulas and images without cross-scope placeholders', () => {
  const formula = renderMarkdown('[formula $x^2$](https://example.test/a)');
  assert.match(formula, /<a [^>]+>formula <span class="zq-math-i" data-tex="x\^2"/);
  assert.doesNotMatch(formula, /undefined|[\u0001\u0003]/);
  const image = renderMarkdown('[![diagram](https://example.test/image.png)](https://example.test/page)');
  assert.match(image, /<a [^>]+><span class="zq-md-image"[^>]+><img alt="diagram" src="https:\/\/example\.test\/image\.png"/);
  assert.doesNotMatch(image, /undefined|[\u0001\u0003]/);
});
check('dollar signs inside URLs are preserved while formulas containing URLs remain formulas', () => {
  const raw = 'https://example.test/?x=$one$&another=$two$';
  const [link] = links(raw); assert.ok(link);
  assert.equal(link.attrs.href, raw); assert.equal(link.text, raw);
  assert.equal(htmlToMarkdown({childNodes:[link]}), raw + '\n');
  assert.equal(links('$x=https://example.test/math$').length, 0);
  assert.match(renderMarkdown('$x=https://example.test/math$'), /data-tex="x=https:\/\/example\.test\/math"/);
});
assert.equal(checks, 14, 'Empty or incomplete behavior scan');
console.log(failures ? 'RED: ' + failures + ' / ' + checks : 'ALL-GREEN: ' + checks);
process.exitCode = failures ? 1 : 0;
