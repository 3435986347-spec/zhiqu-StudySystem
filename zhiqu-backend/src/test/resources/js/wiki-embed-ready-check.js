// Run the shipped handlers against synthetic embed roots. No application, account, or network.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8').replace(/^export /gm, '');
function fixture() {
  const events = {}, scans = [], frames = new Map(), restores = [], navigations = [], opens = [];
  const state = { wikiCur: {id:1}, wikiPages: [{id:2,title:'Target'}], wikiReadOnly:false };
  let auth = 'synthetic-auth', serial = 0;
  function link() {
    const attrs = {'data-wikilink':'Target'};
    return { attrs, getAttribute:key=>attrs[key] ?? null, setAttribute(key,value){attrs[key]=value;}, matches:selector=>selector==='[data-wikilink]' };
  }
  const mainLink=link(), embeddedLink=link();
  const mainTask={checked:true,disabled:'unchanged',closest:()=>null};
  const embeddedTask={checked:false,disabled:'unchanged',closest:()=>embed};
  const embed={ links:[embeddedLink],tasks:[embeddedTask],matches:()=>false };
  const doc={dataset:{editing:'0',source:'0'},style:{},links:[mainLink,embeddedLink],tasks:[mainTask,embeddedTask],
    matches:()=>false,closest:()=>null,contains:node=>[embed,mainLink,embeddedLink,mainTask,embeddedTask].includes(node),
    addEventListener(type,fn){(events[type] ||= []).push(fn);},setAttribute(){} };
  const win={requestAnimationFrame(fn){const id=++serial;frames.set(id,fn);return id;},
    open(...args){opens.push(args);},getSelection:()=>({isCollapsed:true})};
  const impl=new Function('window','document',source+`
    restoreWikiView=function(doc,view){__restores.push(view);};
    paintWikiDoc=async function(page,opts){__navigations.push({page,opts});state.wikiCur=page;};
    var __restores=[],__navigations=[];
    return {bind,wireWikiEditor,restores:__restores,navigations:__navigations};`)(win,{});
  impl.bind({state,token:()=>auth,$:selector=>selector==='#zq-doc'?doc:null,
    $all(selector,root){scans.push({selector,root});return selector==='[data-wikilink]'?(root.links||[]):selector==='input[type="checkbox"]'?(root.tasks||[]):[];},
    toast(){},api:{},esc:String});
  impl.wireWikiEditor(); scans.length=0;
  function dispatch(type,target=embed){for(const fn of events[type]||[])fn({type,target});}
  function pending(extra={}) {doc._wikiPendingView={page:state.wikiCur,auth,expires:Date.now()+10000,view:{scrollTop:90},...extra};return doc._wikiPendingView;}
  function flush(){const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn());}
  return {doc,embed,mainLink,embeddedLink,mainTask,embeddedTask,state,scans,frames,events,opens,restores:impl.restores,navigations:impl.navigations,
    dispatch,pending,flush,setAuth(value){auth=value;}};
}
let passed=0,failed=0;
function check(name,fn){try{fn();passed++;console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+': '+error.message);}}
check('embed completion initializes only its new links and task controls',()=>{
  const f=fixture();f.dispatch('zq-wiki-embed-ready');
  assert.equal(f.embeddedLink.attrs.role,'link');assert.equal(f.embeddedLink.tabIndex,0);
  assert.equal(f.embeddedTask.disabled,true);assert.equal(f.mainLink.attrs.role,undefined);assert.equal(f.mainTask.disabled,'unchanged');
  assert.ok(!f.scans.some(scan=>scan.root===f.doc),'embed completion scanned the entire document');
});
check('96 completions keep one document delegate and never rescan the parent note',()=>{
  const f=fixture();for(let i=0;i<96;i++)f.dispatch('zq-wiki-embed-ready');
  for(const type of ['click','auxclick','keydown'])assert.equal(f.events[type].length,type==='keydown'?2:1,type);
  assert.equal(f.scans.filter(scan=>scan.root===f.doc).length,0);assert.equal(f.frames.size,0);
});
check('subtree Wiki links retain current-tab and middle-button routing',()=>{
  const f=fixture();f.dispatch('zq-wiki-embed-ready');
  const e={preventDefault(){},stopPropagation(){},button:0,ctrlKey:false,metaKey:false};
  f.embeddedLink.onclick(e);f.embeddedLink.onauxclick({...e,button:1});
  assert.deepEqual(f.navigations.map(call=>call.opts.newTab),[false,true]);
});
check('many embed completions restore the pending viewport once on the next frame',()=>{
  const f=fixture();const expected=f.pending().view;
  for(let i=0;i<96;i++)f.dispatch('zq-wiki-embed-ready');
  assert.equal(f.restores.length,0);assert.equal(f.frames.size,1);f.flush();assert.deepEqual(f.restores,[expected]);
});
check('a user wheel interrupts a queued viewport restore',()=>{
  const f=fixture();f.pending();f.dispatch('zq-wiki-embed-ready');f.dispatch('wheel');f.flush();assert.equal(f.restores.length,0);
});
for(const change of ['page','auth','expired','replaced'])check('queued restore rereads '+change+' state at execution',()=>{
  const f=fixture();f.pending();f.dispatch('zq-wiki-embed-ready');
  if(change==='page')f.state.wikiCur={id:9};
  else if(change==='auth')f.setAuth('another-auth');
  else if(change==='expired')f.doc._wikiPendingView.expires=Date.now()-1;
  else f.doc._wikiPendingView=null;
  f.flush();assert.equal(f.restores.length,0);
});
check('detached embed events cannot initialize or restore the current note',()=>{
  const f=fixture();f.pending();f.dispatch('zq-wiki-embed-ready',{links:[],tasks:[]});
  assert.equal(f.scans.length,0);assert.equal(f.frames.size,0);assert.equal(f.restores.length,0);
});
assert.equal(passed+failed,10,'Empty or incomplete behavior scan');
if(failed)process.exitCode=1;else console.log('ALL-GREEN');
