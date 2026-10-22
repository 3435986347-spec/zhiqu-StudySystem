const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
function slice(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);if(start<0||end<0)throw Error(a);return source.slice(start,end);}
const definitions=slice('  function esc(v) {','  function maintainShellCache')+slice('  function mathBlockHtml(','  // KaTeX 懒加载')+slice('  var privateMedia = new Map();','  function renderMathIn(');
class Element {
 constructor(attributes={}){this.attrs=attributes;this.dataset={};this.isConnected=true;this.innerHTML='initial';this.children=[];this.holder=null;}
 getAttribute(key){return this.attrs[key]??null;}
 setAttribute(key,value){this.attrs[key]=String(value);}
 removeAttribute(key){delete this.attrs[key];if(key==='data-zq-loaded')delete this.dataset.zqLoaded;}
 querySelector(selector){if(selector==='.zq-embed-media'&&this.innerHTML.includes('zq-embed-media'))return this.holder||(this.holder=new Element());return null;}
 querySelectorAll(){return [];}
 appendChild(child){this.children.push(child);return child;}
 dispatchEvent(){}
}
function fixture({meta={previewType:'JSON',text:'{"enabled":true}',name:'settings.json'},detail={title:'Cases',content:'## Checks\nallowed\n## Other\nexcluded'},download={blob:new Blob(['bytes'],{type:'application/octet-stream'})}}={}){
 let auth='first-token';const calls=[],created=[],revoked=[];
 const api={get(path){calls.push(path);return Promise.resolve(typeof meta==='function'?meta(path):path.startsWith('/knowledge/pages/')?detail:meta);},download(path){calls.push('download:'+path);return Promise.resolve(download);}};
 const state={wikiPages:[{id:2,title:'Cases'}],wikiCur:{id:1,title:'Root'}};
 const code=new Function('api','state','getToken','Element','created','revoked',`
 var API='/api';function token(){return getToken();}function toast(){}function requestError(m){return Error(m);}function renderMathIn(){}function openModal(){}
 var document={createElement(){return new Element();}};var CustomEvent=function(){};
 var URL={createObjectURL(blob){created.push(blob);return 'blob:'+created.length;},revokeObjectURL(url){revoked.push(url);}};
 ${definitions}
 return { attachmentPreviewHtml:typeof attachmentPreviewHtml==='function'?attachmentPreviewHtml:null,canvasPreviewHtml:typeof canvasPreviewHtml==='function'?canvasPreviewHtml:null,hydrateAttachment:typeof hydrateAttachment==='function'?hydrateAttachment:null,hydrateNote:typeof hydrateNote==='function'?hydrateNote:null,probeAttachment:typeof probeAttachment==='function'?probeAttachment:null,revokePrivateMedia };
 `)(api,state,()=>auth,Element,created,revoked);
 return{code,calls,created,revoked,setAuth(value){auth=value;},context(){return{auth,pages:Object.create(null),count:0,remaining:200000};}};
}
const view=()=>new Element({'data-zq-attachment':'/api/knowledge/attachments/12','data-embed-fragment':'page=2&height=400'});
(async()=>{
 let checks=0;
 async function check(name,fn){try{await fn();checks++;console.log('PASS '+name);}catch(error){console.error('FAIL '+name+': '+error.message);process.exitCode=1;}}
 await check('JSON is pretty formatted and its source HTML is escaped',()=>{const f=fixture();assert.equal(typeof f.code.attachmentPreviewHtml,'function');const html=f.code.attachmentPreviewHtml({name:'a.json',previewType:'JSON',text:'{"payload":"<script>alert(1)</script>"}'},'/api/knowledge/attachments/12');assert.match(html,/\n  &quot;payload&quot;:/);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);});
 await check('Canvas draws bounded nodes and edges and escapes labels',()=>{const f=fixture();assert.equal(typeof f.code.canvasPreviewHtml,'function');const html=f.code.canvasPreviewHtml({nodes:[{id:'a',x:Infinity,y:-1e100,width:1e99,height:200,text:'<script>x</script>'},{id:'b',x:300,y:0,text:'second'}],edges:[{fromNode:'a',toNode:'b',label:'<img>'}]});assert.match(html,/<svg /);assert.equal((html.match(/<rect /g)||[]).length,2);assert.equal((html.match(/<line /g)||[]).length,1);assert.doesNotMatch(html,/<script>|<img>|NaN|Infinity|href=/);assert.match(html,/&lt;script&gt;/);});
 await check('PDF binary becomes a trusted MIME Blob and uses bounded parameters',async()=>{const f=fixture({meta:{previewType:'PDF',name:'report.pdf',mimeType:'application/pdf',byteSize:500}});assert.equal(typeof f.code.hydrateAttachment,'function');const v=view();await f.code.hydrateAttachment(v,f.context());assert.equal(f.created[0].type,'application/pdf');const media=v.holder.children[0];assert.equal(media.src,'blob:1#page=2');assert.equal(media.height,'400');});
 await check('active SVG MIME cannot become an image Blob',async()=>{const f=fixture({meta:{previewType:'IMAGE',mimeType:'image/svg+xml'}});assert.equal(typeof f.code.hydrateAttachment,'function');await f.code.hydrateAttachment(view(),f.context());assert.equal(f.created.length,0);assert.ok(!f.calls.some(path=>path.startsWith('download:')));});
 await check('late attachment response does not cross an auth change',async()=>{let finish;const promise=new Promise(r=>finish=r);const f=fixture({meta:()=>promise});assert.equal(typeof f.code.hydrateAttachment,'function');const v=view(),task=f.code.hydrateAttachment(v,f.context());f.setAuth('another-token');finish({previewType:'JSON',text:'{"private":true}'});await task;assert.equal(v.innerHTML,'initial');assert.equal(f.created.length,0);});
 await check('logout removes authenticated text and revokes media URLs',async()=>{const f=fixture();assert.equal(typeof f.code.hydrateAttachment,'function');const v=view();await f.code.hydrateAttachment(v,f.context());assert.match(v.innerHTML,/enabled/);f.code.revokePrivateMedia();assert.doesNotMatch(v.innerHTML,/enabled/);assert.match(v.innerHTML,/登录后/);assert.equal(v.dataset.zqLoaded,undefined);const mediaFixture=fixture({meta:{previewType:'PDF',mimeType:'application/pdf'}});await mediaFixture.code.hydrateAttachment(view(),mediaFixture.context());assert.equal(mediaFixture.created.length,1);mediaFixture.code.revokePrivateMedia();assert.deepEqual(mediaFixture.revoked,['blob:1']);});
 await check('note heading previews exclude following sections',async()=>{const f=fixture();assert.equal(typeof f.code.hydrateNote,'function');const v=new Element({'data-zq-note-embed':'Cases#Checks'});await f.code.hydrateNote(v,f.context(),['1#'],0);assert.match(v.innerHTML,/allowed/);assert.doesNotMatch(v.innerHTML,/excluded/);});
 await check('note cycle guard stops before making a request',async()=>{const f=fixture();assert.equal(typeof f.code.hydrateNote,'function');const v=new Element({'data-zq-note-embed':'Cases#Checks'});await f.code.hydrateNote(v,f.context(),['2#Checks'],0);assert.equal(f.calls.length,0);assert.match(v.innerHTML,/循环引用/);});
 await check('late note response does not display private content after logout',async()=>{let finish;const promise=new Promise(r=>finish=r);const f=fixture({meta:path=>path.startsWith('/knowledge/pages/')?promise:{}});assert.equal(typeof f.code.hydrateNote,'function');const v=new Element({'data-zq-note-embed':'Cases'});const task=f.code.hydrateNote(v,f.context(),['1#'],0);f.setAuth(null);finish({title:'Cases',content:'private note'});await task;assert.equal(v.innerHTML,'initial');});
 await check('legacy ordinary JSON links gain an inline preview without a second metadata request',async()=>{const f=fixture();assert.equal(typeof f.code.probeAttachment,'function');const link=new Element({'data-zq-attachment-probe':'/api/knowledge/attachments/12'});await f.code.probeAttachment(link,f.context());await Promise.resolve();await Promise.resolve();assert.equal(link.children.length,1);assert.match(link.children[0].innerHTML,/enabled/);assert.equal(f.calls.filter(path=>path.endsWith('/preview')).length,1);});
 await check('ordinary non-JSON links stay compact and preview on demand',async()=>{const f=fixture({meta:{previewType:'PDF'}});assert.equal(typeof f.code.probeAttachment,'function');const link=new Element({'data-zq-attachment-probe':'/api/knowledge/attachments/12'});await f.code.probeAttachment(link,f.context());assert.equal(link.children.length,0);});
 await check('missing explicit note directories cannot fall back to an unrelated basename',async()=>{const f=fixture();const v=new Element({'data-zq-note-embed':'missing-folder/Cases'});await f.code.hydrateNote(v,f.context(),['1#'],0);assert.equal(f.calls.length,0);assert.match(v.innerHTML,/知识页未找到/);assert.doesNotMatch(v.innerHTML,/allowed/);});
 await check('pretty JSON expansion shows a truncation notice even when compact source fits',()=>{const f=fixture();const source=JSON.stringify(Array(20000).fill(0));assert.ok(source.length<65536);const html=f.code.attachmentPreviewHtml({previewType:'JSON',text:source,truncated:false},'/api/knowledge/attachments/12');assert.ok(html.includes('预览已截断'),'pretty expansion must say that the preview was truncated');assert.ok(html.length<70000);assert.doesNotMatch(html,/未通过语法校验/);});
 if(checks<13&&!process.exitCode)throw Error('Empty behavior scan');if(!process.exitCode)console.log('ALL-GREEN');
})().catch(error=>{console.error(error);process.exitCode=1;});
