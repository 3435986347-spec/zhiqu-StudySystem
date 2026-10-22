// Render the actual published implementation; samples are synthetic, never a private vault.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
function slice(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a); if (a < 0 || b < 0) throw Error(start); return source.slice(a, b); }
const code = slice('  function esc(v) {', '  function maintainShellCache')
  + slice('  function mathBlockHtml(', '  // KaTeX 懒加载')
  + slice('  function htmlToMarkdown(root) {', '  // ── 几个各页共用的小件');
const { renderMarkdown, htmlToMarkdown, wikiEmbedSection } = new Function('state', code + '\nreturn {renderMarkdown,htmlToMarkdown,wikiEmbedSection:typeof wikiEmbedSection === "function" ? wikiEmbedSection : null};')({wikiPages:[{id:2,title:'architecture.v2'}]});
let checks = 0;
function check(name, fn) { try { fn(); checks++; console.log('PASS ' + name); } catch (e) { console.error('FAIL ' + name + ': ' + e.message); process.exitCode = 1; } }
check('all six Markdown headings render', () => { assert.match(renderMarkdown('##### Five\n###### Six'), /<h5>Five<\/h5><h6>Six<\/h6>/); });
check('H5 and H6 survive saving', () => { const h = tag => ({nodeType:1,tagName:tag, getAttribute:()=>null,childNodes:[{nodeType:3,nodeValue:tag}]}); assert.equal(htmlToMarkdown({childNodes:[h('H5'),h('H6')]}), '##### H5\n\n###### H6\n'); });
check('note embeds are typed and preserve heading/block references', () => { const html=renderMarkdown('![[Cases#Checks]]\n![[Cases#^block-1]]'); assert.match(html,/data-zq-note-embed="Cases#Checks"/); assert.match(html,/data-zq-note-embed="Cases#\^block-1"/); assert.doesNotMatch(html,/图片未找到/); });
check('private attachments are previewable without unauthenticated src', () => { const html=renderMarkdown('![[/api/knowledge/attachments/12#page=2&height=400]]'); assert.match(html,/data-zq-attachment="\/api\/knowledge\/attachments\/12"/); assert.doesNotMatch(html,/src="\/api/); assert.doesNotMatch(html,/图片未找到/); });
check('ordinary private Wiki files use previews rather than page navigation', () => { const html=renderMarkdown('[[/api/knowledge/attachments/8|settings.json]]\n[[/api/knowledge/images/9|chart.png]]');assert.match(html,/data-zq-private-preview="1"/);assert.doesNotMatch(html,/data-wikilink="\/api/);assert.match(html,/data-embed-markdown="\[\[\/api\/knowledge\/attachments/); });
check('image dimensions preserve width and height', () => { assert.match(renderMarkdown('![[/api/knowledge/images/3|640x320]]'), /width="640" height="320"/); });
check('unsupported local files have a file-specific missing message', () => { assert.doesNotMatch(renderMarkdown('![[absent.json]]'),/图片未找到/); assert.match(renderMarkdown('![[absent.json]]'), /文件未找到/); });
check('embedded previews serialize original Markdown only', () => { const node={nodeType:1,tagName:'SPAN',getAttribute:k=>k==='data-embed-markdown'?'![[Cases#Checks]]':null,childNodes:[{nodeType:3,nodeValue:'private preview must not be copied into parent note'}]}; assert.equal(htmlToMarkdown({childNodes:[node]}),'![[Cases#Checks]]\n'); });
check('heading sections exclude the next same-level heading and include child headings', () => { assert.equal(wikiEmbedSection('# Cases\n## Checks\nhello\n### Detail\nchild\n## Other\nnot included','Checks'),'## Checks\nhello\n### Detail\nchild'); });
check('block embeds preserve the full multiline paragraph and exclude adjacent content', () => { assert.equal(wikiEmbedSection('before\n\nline 1\nline 2 ^block-1\n\nafter','^block-1'),'line 1\nline 2'); });
check('fenced literal headings do not become section anchors', () => { assert.equal(wikiEmbedSection('```\n## Checks\n```\n## Checks\nreal','Checks'),'## Checks\nreal'); });
check('formatted private file aliases preserve exact raw Markdown on save', () => {
  for (const markdown of ['[my *report*](/api/knowledge/attachments/12)', '[[/api/knowledge/attachments/12|my *report*]]']) {
    const html=renderMarkdown(markdown), marker=html.match(/data-embed-markdown="([^"]*)"/);
    assert.ok(marker);
    const raw=marker[1].replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
    assert.equal(raw,markdown);
    const node={nodeType:1,tagName:'SPAN',getAttribute:k=>k==='data-embed-markdown'?raw:null,childNodes:[]};
    assert.equal(htmlToMarkdown({childNodes:[node]}),markdown+'\n');
  }
});
check('known note titles with dotted names remain note embeds', () => {assert.match(renderMarkdown('![[architecture.v2]]'),/data-zq-note-embed="architecture.v2"/);});
check('saving a parent table does not copy table rows from an embedded note', () => {
  function element(tag,children=[],attrs={}) {
    const node={nodeType:1,tagName:tag,childNodes:children,getAttribute:k=>attrs[k]??null};
    children.forEach(child=>child.parentNode=node);
    node.querySelectorAll=selector=>{const tags=selector.toUpperCase().split(',');const found=[];function walk(n){for(const child of n.childNodes||[]){if(tags.includes(child.tagName))found.push(child);walk(child);}}walk(node);return found;};
    node.querySelector=selector=>node.querySelectorAll(selector)[0]||null;
    return node;
  }
  const inner=element('TABLE',[element('TR',[element('TD',[{nodeType:3,nodeValue:'private nested table content'}])])]);
  const embed=element('SPAN',[inner],{'data-embed-markdown':'![[Cases]]'});
  const parent=element('TABLE',[element('TR',[element('TD',[embed])])]);
  assert.equal(htmlToMarkdown({childNodes:[parent]}),'| ![[Cases]] |\n');
});
check('backticks inside embed and private file aliases never become saved control placeholders', () => {
  for (const markdown of ['![[Cases|a `literal`]]', '[my `report`](/api/knowledge/attachments/12)', '[[/api/knowledge/attachments/12|my `report`]]']) {
    const html=renderMarkdown(markdown), marker=html.match(/data-embed-markdown="([^"]*)"/);
    assert.ok(marker);
    const raw=marker[1].replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
    assert.equal(raw,markdown);
    assert.doesNotMatch(raw,/[\u0001\u0003]/);
  }
});
check('ordinary note aliases preserve backticks and stars in their original Wiki link target', () => {
  const html=renderMarkdown('[[Cases|a `literal` *title*]]');
  assert.match(html,/data-wikilink="Cases\|a `literal` \*title\*"/);
  assert.doesNotMatch(html,/data-wikilink="[^"]*<code>/);
});
if(checks<16 && !process.exitCode) throw Error('Empty scan'); if(!process.exitCode) console.log('ALL-GREEN');
