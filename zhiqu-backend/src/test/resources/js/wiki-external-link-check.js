const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('function wikiExternalUrl(') >= 0 ? source.indexOf('function wikiExternalUrl(') : source.indexOf('function wireWikiLinks(doc) {');
const end = source.indexOf('function wireWikiEditor() {', start);
assert.ok(start >= 0 && end > start, 'Published Wiki links must be loaded');
const code = source.slice(start, end);
function fixture(options = {}) {
  const attrs = { href: options.href || 'https://example.test/reports?a=1&b=%5Bok%5D#next' };
  if (options.privateFile) attrs['data-zq-private-download'] = '/api/knowledge/attachments/7';
  const link = { closest(selector) { return selector === 'a[href]' ? link : null; }, getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; } };
  const target = { closest(selector) { return selector === 'a[href]' ? link : null; } };
  const selectionNode = {};
  const listeners = {}, opens = [], warnings = [];
  const doc = { dataset: { editing: options.editing ? '1' : '0', source: options.source ? '1' : '0' }, contains(node) { return [link,target,selectionNode].includes(node); }, addEventListener(name, fn) { (listeners[name] ||= []).push(fn); } };
  const win = { open(...args) { opens.push(args); return null; }, getSelection() { return { isCollapsed: !options.selecting, anchorNode: selectionNode, focusNode: selectionNode }; } };
  const wire = new Function('state','$all','toast','paintWikiDoc','window',code + '\nreturn wireWikiLinks;')({wikiPages:[]},()=>[],message=>warnings.push(message),()=>{ throw Error('External link must not change Wiki page'); },win);
  wire(doc);
  function dispatch(type, props = {}) {
    const event = { type, target, button: 0, key: 'Enter', prevented:false,stopped:false, preventDefault(){ this.prevented=true;this.defaultPrevented=true; },stopPropagation(){this.stopped=true;},...props };
    for(const fn of listeners[type] || []) fn(event);
    return event;
  }
  return {doc,link,target,listeners,opens,warnings,dispatch,wire,attrs};
}
let passed = 0, failed = 0;
function check(name, fn) { try { fn();passed++;console.log('PASS '+name); } catch(e) { failed++;console.error('FAIL '+name+': '+e.message); } }
for(const editing of [false,true]) check((editing?'editing':'reading')+' click opens once without changing editing state',()=>{const f=fixture({editing});const e=f.dispatch('click');assert.equal(f.opens.length,1);assert.deepEqual(f.opens[0],[f.attrs.href,'_blank','noopener,noreferrer']);assert.ok(e.prevented&&e.stopped);assert.equal(f.doc.dataset.editing,editing?'1':'0');});
check('rebinding does not duplicate delegates and links inserted later work',()=>{const f=fixture({editing:true});f.wire(f.doc);f.attrs.href='https://example.test/new';f.dispatch('click');assert.equal(f.opens.length,1);assert.equal(f.opens[0][0],f.attrs.href);});
check('keyboard Enter opens a focused link but preserves editable caret Enter',()=>{const f=fixture({editing:true});f.dispatch('keydown',{target:f.link});assert.equal(f.opens.length,1);f.dispatch('keydown');assert.equal(f.opens.length,1);f.dispatch('keydown',{target:f.link,repeat:true});assert.equal(f.opens.length,1);});
check('middle button opens once, right button does not open',()=>{const f=fixture();f.dispatch('click',{button:1});assert.equal(f.opens.length,0);f.dispatch('auxclick',{button:1});assert.equal(f.opens.length,1);f.dispatch('auxclick',{button:2});assert.equal(f.opens.length,1);});
check('text selection preserves the selection instead of navigating',()=>{const f=fixture({editing:true,selecting:true});const e=f.dispatch('click');assert.equal(f.opens.length,0);assert.ok(e.prevented);});
check('source mode and private attachments keep their own handlers',()=>{for(const options of [{source:true},{href:'/api/knowledge/attachments/7',privateFile:true}]){const f=fixture(options);f.dispatch('click');assert.equal(f.opens.length,0);}});
check('unsafe schemes and malformed external URLs never use default navigation',()=>{for(const href of ['javascript:alert(1)','data:text/html,hello','https://',' https://bad host.test/']){const f=fixture({href});const e=f.dispatch('click');assert.equal(f.opens.length,0,href);assert.ok(e.prevented,href);}});
check('existing default-prevented controls do not open twice',()=>{const f=fixture();f.dispatch('click',{defaultPrevented:true});assert.equal(f.opens.length,0);});
assert.ok(passed+failed>=9,'Empty behavior scan');
if(failed)process.exitCode=1;else console.log('ALL-GREEN');
