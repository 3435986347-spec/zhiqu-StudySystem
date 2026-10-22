// Published Markdown renderer and editor serializer, exercised without a browser or private files.
const fs = require('fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
function slice(from, to) {
  const first = source.indexOf(from);
  const last = source.indexOf(to, first);
  if (first < 0 || last < 0) throw new Error('Cannot find published Markdown function: ' + from);
  return source.slice(first, last);
}
const code = slice('  function esc(v) {', '  function maintainShellCache')
  + slice('  function mathBlockHtml(', '  // KaTeX 懒加载')
  + slice('  function htmlToMarkdown(root) {', '  // ── 几个各页共用的小件');
const { renderMarkdown, htmlToMarkdown } = new Function(code + '\nreturn { renderMarkdown, htmlToMarkdown };')();
let count = 0;
function check(name, okay) {
  count++;
  if (!okay) { console.error('FAIL ' + name); process.exitCode = 1; }
  else console.log('PASS ' + name);
}
const privateImage = renderMarkdown('![[/api/knowledge/images/17|600]]');
check('private image has authenticated URL marker and width', privateImage.includes('data-zq-private-image="/api/knowledge/images/17"')
  && privateImage.includes('max-width:min(100%,600px)') && !privateImage.includes('src="/api/knowledge/images/17"'));
check('standard private image is recognized', renderMarkdown('![chart](/api/knowledge/images/18)').includes('data-zq-private-image="/api/knowledge/images/18"'));
check('external image URL keeps one balanced parenthesis pair', renderMarkdown('![chart](https://example.com/chart_(final).png)')
  .includes('src="https://example.com/chart_(final).png"'));
check('ordinary attachment is an authenticated download', renderMarkdown('[data](/api/knowledge/attachments/3)').includes('data-zq-private-download="/api/knowledge/attachments/3"'));
check('Wiki alias and heading survive as original target', renderMarkdown('[[Risk#Summary|show]]').includes('data-wikilink="Risk#Summary|show">show</a>'));
check('inline and fenced code never create images', !renderMarkdown('`![[/api/knowledge/images/17]]`\n```\n![[/api/knowledge/images/17]]\n```').includes('data-zq-private-image'));
check('active markup is not accepted as an image URL', !renderMarkdown('![x](javascript:alert(1))').includes('<img'));
check('attributes are escaped', renderMarkdown('![[/api/knowledge/images/17|\" onerror=alert(1)]]')
  .includes('alt="&quot; onerror=alert(1)"'));
const markdown = '![[/api/knowledge/images/17|600]]';
const image = { nodeType: 1, tagName: 'SPAN', getAttribute: key => key === 'data-image-markdown' ? markdown : null,
  childNodes: [{ nodeType: 1, tagName: 'IMG', getAttribute: () => null, childNodes: [] }] };
check('saving rendered image restores original Markdown', htmlToMarkdown({ childNodes: [image] }) === markdown + '\n');
check('authored image markup stays in wrapper', privateImage.includes('data-image-markdown="![[/api/knowledge/images/17|600]]"'));
if (count < 9) throw new Error('Empty behavior scan');
if (!process.exitCode) console.log('ALL-GREEN');
