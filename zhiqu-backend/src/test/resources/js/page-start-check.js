const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('  function route() {');
const end = source.indexOf('\n  }\n', start);
assert.ok(start > 0 && end > start, 'Published route must be present');
const route = source.slice(start, end + 5);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
function fixture(options={}) {
  const auth=deferred(), code=deferred(), calls=[], failures=[];
  const page=options.page || 'knowledge-wiki.html';
  const module={boots:{[page]:async()=>calls.push('boot')},dayReload:{[page]:()=>{}}};
  const context={page, PAGE_MODULES:{[page]:'pages/current.js'}, pomoWatched:false,dayWatched:false,zqShared:{},
    $:()=>null, token:()=>options.token===false?'':'synthetic', borrowToken:async()=>{calls.push('borrow');},
    initAuth:()=>{calls.push('auth');return auth.promise;}, currentUserIsAdmin:()=>!!options.admin,
    loadModule:()=>{calls.push('module');return code.promise;}, loadSettingsModule:async()=>({legacyHash:()=>''}),
    maintainShellCache(){},flushDeniedNotice(){},revealContent(){calls.push('reveal');},bootIndex(){calls.push('index');},
    safe(_label,work){context.job=Promise.resolve().then(work).catch(e=>failures.push(e));return context.job;},
    window:{addEventListener(){},ZQUI:{isAdminPage:p=>p==='admin.html'}},
    location:{hash:'',search:'',replace(){calls.push('replace');}}, sessionStorage:{setItem(){}},
    HOME_PAGE:'dashboard.html',DENIED_FLAG:'denied',performance:{mark(){}},
    watchReminders(){},watchPomo(){},watchDialogs(){},watchBusinessDay(){calls.push('day');},
    setInterval(){}, catchUpPomodoros(){}, URLSearchParams,safeNext:()=>''};
  if(options.noUi) delete context.window.ZQUI;
  vm.createContext(context);vm.runInContext(route,context);context.route();
  return {context,calls,failures,auth,code,module,async finish(){auth.resolve();code.resolve(module);await context.job;}};
}
const checks=[];
function check(name,fn){checks.push([name,fn]);}
check('normal page fetches its code while authentication is pending, without starting business work',async()=>{
  const f=fixture();try{await tick();assert.equal(f.calls.filter(x=>x==='module').length,1);assert.ok(f.calls.includes('auth'));assert.ok(!f.calls.includes('boot'));
    f.code.resolve(f.module);await tick();assert.ok(!f.calls.includes('boot'));f.auth.resolve();await f.context.job;assert.equal(f.calls.filter(x=>x==='boot').length,1);assert.ok(f.calls.includes('day'));
  }finally{await f.finish();}
});
check('module code still pending after auth is awaited exactly once',async()=>{
  const f=fixture();try{await tick();f.auth.resolve();await tick();assert.ok(!f.calls.includes('boot'));f.code.resolve(f.module);await f.context.job;assert.equal(f.calls.filter(x=>x==='module').length,1);assert.equal(f.calls.filter(x=>x==='boot').length,1);}finally{await f.finish();}
});
check('non-admin cannot prefetch or boot an admin module',async()=>{
  const f=fixture({page:'admin.html'});try{await tick();assert.ok(!f.calls.includes('module'));f.auth.resolve();await f.context.job;assert.ok(!f.calls.includes('module'));assert.ok(!f.calls.includes('boot'));assert.ok(f.calls.includes('replace'));}finally{await f.finish();}
});
check('admin code is fetched only after server authentication confirms the role',async()=>{
  const f=fixture({page:'admin.html',admin:true});try{await tick();assert.ok(!f.calls.includes('module'));f.auth.resolve();await tick();assert.equal(f.calls.filter(x=>x==='module').length,1);f.code.resolve(f.module);await f.context.job;assert.ok(f.calls.includes('boot'));}finally{await f.finish();}
});
check('a prefetch rejection before auth is handled and later reported once without retrying',async()=>{
  const f=fixture(), unhandled=[];const onUnhandled=e=>unhandled.push(e);process.on('unhandledRejection',onUnhandled);
  try{await tick();assert.ok(f.calls.includes('module'));const failure=new Error('synthetic module failed');f.code.reject(failure);await tick();await tick();assert.equal(unhandled.length,0);f.auth.resolve();await f.context.job;assert.deepEqual(f.failures,[failure]);assert.equal(f.calls.filter(x=>x==='module').length,1);assert.ok(!f.calls.includes('boot'));}
  finally{await f.finish();process.off('unhandledRejection',onUnhandled);}
});
check('failed authentication never starts business code',async()=>{
  const f=fixture();try{await tick();const failure=new Error('synthetic auth failed');f.auth.reject(failure);f.code.resolve(f.module);await f.context.job;assert.deepEqual(f.failures,[failure]);assert.ok(!f.calls.includes('boot'));}finally{await f.finish();}
});
check('landing and legacy redirect pages do not preload unrelated business code',async()=>{
  for(const page of ['index.html','profile.html','achievement.html']){const f=fixture({page});try{await tick();assert.ok(!f.calls.includes('module'));assert.ok(!f.calls.includes('auth'));assert.ok(!f.calls.includes('boot'));await f.context.job;}finally{await f.finish();}}
});
check('missing UI helper keeps the conservative auth-first loading fallback',async()=>{
  const f=fixture({noUi:true});try{await tick();assert.ok(!f.calls.includes('module'));f.auth.resolve();await tick();f.code.resolve(f.module);await f.context.job;assert.ok(f.calls.includes('boot'));assert.equal(f.failures.length,0);}finally{await f.finish();}
});
(async()=>{let failed=0;for(const [name,fn]of checks){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}assert.ok(checks.length>=8);if(failed)process.exitCode=1;else console.log('ALL-GREEN');})();
