const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const packagePath = path.resolve(process.argv[2]);
const work = path.resolve(process.argv[3]);
const profile = path.join(work, 'production-profile');
const project = path.join(work, 'production-project');
fs.mkdirSync(project, { recursive: true });
const suffix = crypto.createHash('sha256').update(path.resolve(profile), 'utf8').digest('hex').toUpperCase().slice(0, 16);
const registry = `HKCU\\Software\\zhiqu\\desktop-check-${suffix}`;
const token = 'zqp_productionShellCheck_0123456789';
const state = { events: [], status: null, result: null, applied: false, read: '', error: '', done: false };
let streams = 0;
const json = (res, value) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); };
const text = (res, value, type = 'text/plain; charset=utf-8') => { res.setHeader('Content-Type', type); res.end(value); };
const draft = { path: 'production-draft.txt', content: 'from-packaged-runtime\n' };
const page = `<!doctype html><meta charset="utf-8"><title>知趣象限 production check</title><script>
const post=async body=>{try{return await webkit.messageHandlers.zqLocal.postMessage(body);}catch(e){throw e;}};
window.addEventListener('zq-local',async e=>{await fetch('/event',{method:'POST',body:JSON.stringify(e.detail)});
 if(e.detail.type==='result'&&e.detail.drafts){const applied=await post({action:'apply',folder:await folder(),files:e.detail.drafts});const read=await post({action:'read',folder:await folder(),path:'production-draft.txt'});await fetch('/applied',{method:'POST',body:JSON.stringify({applied:applied.written===1,read:read.content})});}
 if(e.detail.type==='exit')await fetch('/exit',{method:'POST'});});
async function folder(){return (await post({action:'status'})).folders[0];}
(async()=>{try{const status=await post({action:'status'});await fetch('/status',{method:'POST',body:JSON.stringify(status)});
 const selectedFolder=await folder();const run=await post({action:'run',clientRunId:'production-run',folder:selectedFolder,message:'PRODUCTION',history:[],model:1,effort:'instant',level:'WRITE',token:'${token}',sessionId:'production-check'});
 await fetch('/run',{method:'POST',body:JSON.stringify(run)});}catch(e){await fetch('/failure',{method:'POST',body:String(e&&e.stack||e)});}})();
</script>`;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/dashboard.html') return text(res, page, 'text/html; charset=utf-8');
    if (pathname === '/api/desktop/downloads') return json(res, { code: 200, data: {} });
    if (pathname === '/favicon.ico') { res.statusCode = 204; return res.end(); }
    if (pathname === '/status') { state.status = JSON.parse(raw); return json(res, {}); }
    if (pathname === '/event') { const event = JSON.parse(raw); state.events.push(event); if (event.type === 'result') state.result = event; return json(res, {}); }
    if (pathname === '/applied') { const applied = JSON.parse(raw); state.applied = applied.applied; state.read = applied.read; return json(res, {}); }
    if (pathname === '/failure') { state.error = raw; state.done = true; return json(res, {}); }
    if (pathname === '/exit') { state.done = true; return json(res, {}); }
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; return json(res, { code: 401 }); }
    if (pathname === '/api/harness/models') return json(res, { code: 200, data: { models: [{ id: 1, label: 'fake', modelName: 'fake', toolCalling: true, effectiveContextWindow: 100000 }], defaultModelId: 1 } });
    if (pathname === '/api/harness/tools') return json(res, { code: 200, data: [] });
    if (pathname === '/api/harness/memory/brief') return json(res, { code: 200, data: { enabled: false } });
    if (pathname === '/api/harness/model/stream') {
      streams++;
      res.setHeader('Content-Type', 'text/event-stream');
      const send = (name, data) => res.write(`event:${name}\ndata:${JSON.stringify(data)}\n\n`);
      send('start', { contextWindow: 100000, droppedMessages: 0, elidedToolOutputs: 0 });
      const message = streams === 1 ? { role: 'assistant', content: '先给草稿', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify(draft) } }] }
        : { role: 'assistant', content: 'PRODUCTION-DONE' };
      send('done', { message, finishReason: streams === 1 ? 'tool_calls' : 'stop', maxTokens: 1000, usage: { promptTokens: 1, completionTokens: 1, estimated: false } });
      return res.end();
    }
    json(res, { code: 404 });
  });
});

(async () => {
  let child;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let reg = spawnSync('reg.exe', ['add', registry, '/v', 'localFolders', '/t', 'REG_MULTI_SZ', '/d', project, '/f'], { encoding: 'utf8' });
    if (reg.status !== 0) throw new Error(`registry fixture failed: ${reg.stdout}${reg.stderr}`);
    const env = { ...process.env, ZHIQU_DESKTOP_SERVER: `http://127.0.0.1:${server.address().port}`, ZHIQU_DESKTOP_PROFILE: profile, ZHIQU_DESKTOP_INSTANCE: crypto.randomUUID().replaceAll('-', '') };
    child = spawn(packagePath, [], { env, stdio: 'ignore', windowsHide: true });
    const deadline = Date.now() + 45000;
    while ((!state.done || (!state.applied && !state.error)) && Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`shell exited ${child.exitCode}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!state.done) throw new Error('production shell timeout');
    if (state.error) throw new Error(state.error);
    if (!state.status?.available || !state.result || state.result.conclusion !== 'PRODUCTION-DONE') throw new Error(`bad state ${JSON.stringify(state)}`);
    if (!state.applied || state.read !== draft.content) throw new Error(`draft not confirmed ${JSON.stringify(state)}`);
    if (state.events.some(event => JSON.stringify(event).includes(token))) throw new Error('token reached page events');
    const runtimeRoot = path.join(profile, 'runtime');
    const versions = fs.readdirSync(runtimeRoot);
    if (versions.length !== 1) throw new Error('runtime extraction missing');
    const node = path.join(runtimeRoot, versions[0], 'node', 'node.exe');
    const version = spawnSync(node, ['--version'], { encoding: 'utf8' });
    if (version.status !== 0 || version.stdout.trim() !== 'v22.23.2') throw new Error('wrong packaged Node');
    console.log('production.runtime=' + versions[0]);
    console.log('production.node=' + version.stdout.trim());
    console.log('production.ok=true');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue).CloseMainWindow() | Out-Null`], { stdio: 'ignore' });
      await new Promise(resolve => { const timer = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise(resolve => { const timer = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
      }
    }
    spawnSync('reg.exe', ['delete', registry, '/f'], { stdio: 'ignore' });
    server.closeAllConnections(); server.close();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
