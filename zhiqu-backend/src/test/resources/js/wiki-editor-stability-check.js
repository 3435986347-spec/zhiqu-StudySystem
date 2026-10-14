const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
function slice(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);if(start<0||end<0)throw Error(a);return source.slice(start,end);}
const editCode = slice('function ensureWikiEditing()', 'function wikiToolbar(cmd)');
const sourceCode = slice('function toggleWikiSource()', 'function showWikiActionBar()');
const cancelStart = source.indexOf('function cancelWikiEdit()');
const cancelCode = cancelStart < 0 ? '' : slice('function cancelWikiEdit()', 'function isSystemWikiPage(');
const saveCode = slice('async function saveWikiEdit()', '// 一个 ZIP 根目录');
function fixture(){
 let pendingResolve, markdown='edited\n';
 const request=new Promise(resolve=>pendingResolve=resolve);
 const page={id:7,title:'Example',version:3}; const state={wikiCur:page,wikiDirty:true};
 const doc={dataset:{editing:'0',source:'0'},style:{},contentEditable:'false',scrollTop:240,focus(opts){this.focusOptions=opts;this.scrollTop=opts&&opts.preventScroll?this.scrollTop:0;}};
 const draftValues=new Map();
 Object.defineProperty(doc,'innerHTML',{get(){return this._html||'';},set(value){this._html=value;this.scrollTop=0;}});
 const drafts={load(key){return draftValues.get(key);},clear(key){draftValues.delete(key);},clearIf(key,text){if(draftValues.get(key)?.text===text)draftValues.delete(key);},save(key,text,extra){draftValues.set(key,{text,...extra});}}; const paints=[]; const tasks=[];
 const script=new Function('state','doc','page','request','drafts','paints','tasks','getMd',`
 var wikiEditSession=0;
 var window={scrollX:0,scrollY:80,scrollTo(){}};
 var document={}; var textarea={value:'',focus(){}};
 function token(){return 'first-token';}
 function $(id){return id==='#zq-doc'?doc:id==='#zq-src-ta'?textarea:null;}
 function wireWikiDrafts(){} function showWikiActionBar(){} function saveWikiDraftNow(){}
 function setSourcePressed(){} function renderMarkdown(){return '<div class="zq-md">text</div>';} function markDuplicateTitle(){} function renderMathIn(){}
 function htmlToMarkdown(){return getMd();} function currentWikiMarkdown(){return getMd();}
 function wikiDraftKey(p){return 'wiki.'+p.id;}
 function safe(name, fn){var result=fn();tasks.push(result);return result;}
 function toast(){} function paintWikiDoc(p,opts){paints.push({p,opts});}
 var api={put(){return request;}};
 ${editCode}\n${sourceCode}\n${cancelCode}\n${saveCode}
 return {enterWikiEdit,saveWikiEdit,toggleWikiSource,captureWikiView,restoreWikiView,cancelWikiEdit:typeof cancelWikiEdit==='function'?cancelWikiEdit:null};`)(state,doc,page,request,drafts,paints,tasks,()=>markdown);
 return {state,doc,page,paints,tasks,script,draftValues,finish:pendingResolve,setMarkdown(value){markdown=value;}};
}
(async()=>{
 let checks=0;
 async function check(name,fn){try{await fn();checks++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+': '+e.message);process.exitCode=1;}}
 await check('entering edit preserves scrolled position with preventScroll focus',async()=>{const f=fixture();f.script.enterWikiEdit();assert.equal(f.doc.scrollTop,240);assert.equal(f.doc.focusOptions.preventScroll,true);});
 await check('saving redraws at the current viewport position',async()=>{const f=fixture();f.script.enterWikiEdit();const saving=f.script.saveWikiEdit();f.doc.scrollTop=400;f.finish({content:'edited\n',version:4});await saving;await Promise.all(f.tasks);assert.equal(f.paints.length,1);assert.ok(f.paints[0].opts.preserveView,'saved renderer must preserve viewport');assert.equal(f.paints[0].opts.preserveView.scrollTop,400);});
 await check('typing while a save is pending keeps the newer unsaved text',async()=>{const f=fixture();f.script.enterWikiEdit();const saving=f.script.saveWikiEdit();f.setMarkdown('edited afterwards\n');f.finish({content:'edited\n',version:4});await saving;await Promise.all(f.tasks);assert.equal(f.paints.length,0);assert.equal(f.state.wikiDirty,true);assert.equal(f.page.version,4);});
 await check('late save cannot redraw a different current page',async()=>{const f=fixture();f.script.enterWikiEdit();const saving=f.script.saveWikiEdit();f.state.wikiCur={id:9};f.finish({content:'edited\n',version:4});await saving;await Promise.all(f.tasks);assert.equal(f.paints.length,0);assert.equal(f.state.wikiDirty,true);});
 await check('late save preserves the newer draft of the page the user left',async()=>{const f=fixture();f.script.enterWikiEdit();const saving=f.script.saveWikiEdit();f.draftValues.set('wiki.7',{text:'newer draft\n',base:3});f.state.wikiCur={id:9};f.finish({content:'edited\n',version:4});await saving;assert.equal(f.draftValues.get('wiki.7')?.text,'newer draft\n');assert.equal(f.draftValues.get('wiki.7')?.base,4);});
 await check('opening source remembers the reading position before its shorter textarea clamps scrolling',async()=>{const f=fixture();f.script.enterWikiEdit();f.script.toggleWikiSource();assert.equal(f.doc.scrollTop,0);assert.ok(f.doc._wikiSourceView,'source mode must retain the reading anchor');assert.equal(f.doc._wikiSourceView.scrollTop,240);});
 await check('cancel from source mode redraws at the earlier reading anchor',async()=>{const f=fixture();f.script.enterWikiEdit();f.script.toggleWikiSource();assert.equal(typeof f.script.cancelWikiEdit,'function');f.script.cancelWikiEdit();assert.equal(f.paints[0].opts.preserveView.scrollTop,240);assert.equal(f.paints[0].opts.history,true);});
 await check('capture and restore keep the same repeated paragraph occurrence',async()=>{
   const f=fixture();f.doc.scrollTop=180;f.doc.getBoundingClientRect=()=>({top:100});
   const children=Array.from({length:8},(_,index)=>({tagName:'P',textContent:'同样的段落',isConnected:true,getBoundingClientRect(){return{top:100+index*80-f.doc.scrollTop,bottom:180+index*80-f.doc.scrollTop,height:80};}}));
   f.doc.querySelector=()=>({children});
   const anchor=f.script.captureWikiView(f.doc);assert.equal(anchor.anchorIndex,2);assert.equal(anchor.anchorOffset,-20);
   f.doc.scrollTop=0;f.script.restoreWikiView(f.doc,anchor);assert.equal(f.doc.scrollTop,180);assert.equal(children[2].getBoundingClientRect().top,80);
 });
 await check('changed anchor text chooses the nearest remaining matching paragraph',async()=>{
   const f=fixture();f.doc.scrollTop=340;f.doc.getBoundingClientRect=()=>({top:100});
   const children=Array.from({length:8},(_,index)=>({tagName:'P',textContent:'重复文字',isConnected:true,getBoundingClientRect(){return{top:100+index*80-f.doc.scrollTop,bottom:180+index*80-f.doc.scrollTop,height:80};}}));
   f.doc.querySelector=()=>({children});const anchor=f.script.captureWikiView(f.doc);assert.equal(anchor.anchorIndex,4);
   children[4].textContent='改过的文字';f.script.restoreWikiView(f.doc,anchor);assert.equal(f.doc.scrollTop,260);
 });
 await check('cancel clears the current saved draft while preserving drafts of other pages',async()=>{
   const f=fixture();f.page._draftBase=3;f.script.enterWikiEdit();f.draftValues.set('wiki.7',{text:'unsaved current',base:3});f.draftValues.set('wiki.9',{text:'other page',base:2});
   f.script.toggleWikiSource();f.script.cancelWikiEdit();assert.equal(f.draftValues.has('wiki.7'),false);assert.equal(f.draftValues.get('wiki.9').text,'other page');assert.equal(f.page._draftBase,null);assert.equal(f.state.wikiDirty,false);
 });
 if(checks<10&&!process.exitCode)throw Error('Empty scan');if(!process.exitCode)console.log('ALL-GREEN');
})().catch(error=>{console.error(error);process.exitCode=1;});
