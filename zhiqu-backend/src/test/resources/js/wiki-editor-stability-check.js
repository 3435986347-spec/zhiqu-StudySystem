const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
function slice(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);if(start<0||end<0)throw Error(a);return source.slice(start,end);}
const editCode = slice('function ensureWikiEditing()', 'function wikiToolbar(cmd)');
const sourceCode = slice('function toggleWikiSource()', 'function showWikiActionBar()');
// 第八十三轮：「保存 / 取消」去掉了，改成自动保存（scheduleWikiSave / flushWikiSave / saveWikiContent，在 toggleWikiSource 和 showWikiActionBar 之间）
function fixture(){
 let pendingResolve, markdown='edited\n';
 const request=new Promise(resolve=>pendingResolve=resolve);
 const page={id:7,title:'Example',version:3,content:'old\n'}; const state={wikiCur:page,wikiDirty:true}; const puts=[];
 const doc={dataset:{editing:'0',source:'0'},style:{},contentEditable:'false',scrollTop:240,focus(opts){this.focusOptions=opts;this.scrollTop=opts&&opts.preventScroll?this.scrollTop:0;}};
 const draftValues=new Map();
 Object.defineProperty(doc,'innerHTML',{get(){return this._html||'';},set(value){this._html=value;this.scrollTop=0;}});
 const drafts={load(key){return draftValues.get(key);},clear(key){draftValues.delete(key);},clearIf(key,text){if(draftValues.get(key)?.text===text)draftValues.delete(key);},save(key,text,extra){draftValues.set(key,{text,...extra});}}; const paints=[]; const tasks=[];
 const script=new Function('state','doc','page','request','drafts','paints','tasks','getMd','puts',`
 var wikiEditSession=0;
 var window={scrollX:0,scrollY:80,scrollTo(){}};
 var document={}; var textarea={value:'',focus(){}};
 function token(){return 'first-token';}
 function $(id){return id==='#zq-doc'?doc:id==='#zq-src-ta'?textarea:null;}
 function wireWikiDrafts(){} function showWikiActionBar(){} function saveWikiDraftNow(){}
 function placeWikiTitle(){} function wikiTitleEl(){return null;}   // 第八十四轮：页名在正文顶上，这里只看正文
 function setSourcePressed(){} function renderMarkdown(){return '<div class="zq-md">text</div>';} function markDuplicateTitle(){} function renderMathIn(){}
 function htmlToMarkdown(){return getMd();} function currentWikiMarkdown(){return getMd();}
 function wikiDraftKey(p){return 'wiki.'+p.id;}
 function safe(name, fn){var result=fn();tasks.push(result);return result;}
 function toast(){} function paintWikiDoc(p,opts){paints.push({p,opts});} function paintWikiTree(){} function paintWikiTabs(){} function esc(v){return String(v);} function $all(){return [];}
 var api={put(path,body){puts.push(body);return puts.length===1?request:Promise.resolve({content:body.content,version:body.version+1});}};
 ${editCode}\n${sourceCode}
 wikiCmFailed = true;   // 第八十轮起新编辑器是默认；这里测的是它加载不上时退回的简易编辑（contentEditable）
 return {enterWikiEdit,flushWikiSave,toggleWikiSource,captureWikiView,restoreWikiView};`)(state,doc,page,request,drafts,paints,tasks,()=>markdown,puts);
 return {state,doc,page,paints,tasks,script,draftValues,puts,finish:pendingResolve,setMarkdown(value){markdown=value;}};
}
(async()=>{
 let checks=0;
 async function check(name,fn){try{await fn();checks++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+': '+e.message);process.exitCode=1;}}
 await check('entering edit preserves scrolled position with preventScroll focus',async()=>{const f=fixture();f.script.enterWikiEdit();assert.equal(f.doc.scrollTop,240);assert.equal(f.doc.focusOptions.preventScroll,true);});
 await check('saving does not redraw or move the viewport (第八十三轮：原来存完重画阅读视图，正在改的那段跳 33px)',async()=>{const f=fixture();f.script.enterWikiEdit();const saving=f.script.flushWikiSave();f.doc.scrollTop=400;f.finish({content:'edited\n',version:4});await saving;await Promise.all(f.tasks);assert.equal(f.paints.length,0,'saving repainted the page');assert.equal(f.doc.scrollTop,400);assert.equal(f.doc.dataset.editing,'1');assert.equal(f.state.wikiDirty,false);assert.equal(f.page.version,4);});
 await check('typing while a save is pending keeps the newer unsaved text and sends it next with the returned version',async()=>{const f=fixture();f.script.enterWikiEdit();const saving=f.script.flushWikiSave();f.setMarkdown('edited afterwards\n');f.script.flushWikiSave();assert.equal(f.puts.length,1,'a second save went out while the first was still pending');f.finish({content:'edited\n',version:4});await saving;await new Promise(r=>setTimeout(r,0));await new Promise(r=>setTimeout(r,0));assert.equal(f.paints.length,0);assert.equal(f.puts.length,2);assert.equal(f.puts[1].content,'edited afterwards\n');assert.equal(f.puts[1].version,4,'the queued save must use the version the first save returned');assert.equal(f.page.version,5);});
 await check('late save cannot redraw a different current page',async()=>{const f=fixture();f.script.enterWikiEdit();const saving=f.script.flushWikiSave();f.state.wikiCur={id:9};f.finish({content:'edited\n',version:4});await saving;await Promise.all(f.tasks);assert.equal(f.paints.length,0);assert.equal(f.state.wikiDirty,true,'the dirty flag now belongs to the other page');});
 await check('late save rebases the newer draft of the page the user left',async()=>{const f=fixture();f.script.enterWikiEdit();const saving=f.script.flushWikiSave();f.draftValues.set('wiki.7',{text:'newer draft\n',base:3});f.state.wikiCur={id:9};f.finish({content:'edited\n',version:4});await saving;assert.equal(f.draftValues.get('wiki.7')?.text,'newer draft\n');assert.equal(f.draftValues.get('wiki.7')?.base,4,'the kept draft still points at the old version: coming back would look like a conflict');});
 await check('opening source remembers the reading position before its shorter textarea clamps scrolling',async()=>{const f=fixture();f.script.enterWikiEdit();f.script.toggleWikiSource();assert.equal(f.doc.scrollTop,0);assert.ok(f.doc._wikiSourceView,'source mode must retain the reading anchor');assert.equal(f.doc._wikiSourceView.scrollTop,240);});
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
 await check('nothing changed since the last save: no request at all',async()=>{const f=fixture();f.setMarkdown('old\n');f.script.enterWikiEdit();await f.script.flushWikiSave();assert.equal(f.puts.length,0);});
 await check('an emptied page is not sent (the server refuses empty content); the text stays',async()=>{const f=fixture();f.setMarkdown('  \n');f.script.enterWikiEdit();await f.script.flushWikiSave();assert.equal(f.puts.length,0);assert.equal(f.page._saveEmpty,true);});
 if(checks<10&&!process.exitCode)throw Error('Empty scan');if(!process.exitCode)console.log('ALL-GREEN');
})().catch(error=>{console.error(error);process.exitCode=1;});
