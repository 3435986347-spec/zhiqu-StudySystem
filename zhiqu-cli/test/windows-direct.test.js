import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { plainLaunch, describeBoundary, directWriteRefusal } from '../src/tools/sandbox.js';
import { runProcess } from '../src/tools/exec.js';
import { DesktopTools } from '../src/tools/drafts.js';
import { runHosted } from '../src/host/code-host.js';
import { toolset } from '../src/agent.js';
import { tmpdir } from './helpers.js';

const windows = process.platform === 'win32';
const skip = windows ? false : 'Windows 真命令判据';

test('Windows 本机 shell：引号、中文、退出码、干净环境和临时文件清理', { skip }, async () => {
  const root = tmpdir();
  const priv = tmpdir();
  const launch = plainLaunch({ command: `node -p "process.version" && echo 中文-ok && echo ok > direct.txt`, privateDir: priv,
    env: { ...process.env, ZHIQU_TOKEN: 'must-not-leak' } });
  const temporary = launch.cleanupDir;
  const result = await runProcess({ ...launch, cwd: root, timeoutMs: 15000 });
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, new RegExp(process.version.replaceAll('.', '\\.')));
  assert.match(result.output, /中文-ok/);
  assert.equal(fs.readFileSync(path.join(root, 'direct.txt'), 'utf8').trim(), 'ok');
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(launch.env.ZHIQU_TOKEN, undefined);
  const env = await runProcess({ ...plainLaunch({ command: 'set', privateDir: priv }), cwd: root, timeoutMs: 15000 });
  assert.doesNotMatch(env.output, /must-not-leak|ZHIQU_TOKEN/);
  assert.equal((await runProcess({ ...plainLaunch({ command: 'exit 7', privateDir: priv }), cwd: root, timeoutMs: 15000 })).exitCode, 7);
});

test('Windows 直接 shell 只在显式 auto 通道打开，模型知道它不是系统沙箱', { skip }, async () => {
  const root = tmpdir();
  const tools = new DesktopTools({ root, canWrite: true, shellWrite: true, allowDirectShell: true, home: os.homedir() });
  assert.equal(tools.sandbox.kind, 'direct-windows');
  const names = toolset({ local: tools, remoteTools: [], messages: [], mode: 'auto' }).map(t => t.schema.function.name);
  assert.ok(names.includes('shell'));
  assert.ok(!names.includes('run_command'));
  const result = await tools.commitShell(tools.prepareShell({ command: 'node -p "process.version"' }));
  assert.equal(result.exitCode, 0, result.content);
  assert.match(result.content, /不是系统沙箱/);
  assert.match(result.content, new RegExp(process.version.replaceAll('.', '\\.')));
  assert.match(describeBoundary({ direct: true }), /不是系统沙箱/);
  const off = new DesktopTools({ root, canWrite: true, shellWrite: false, allowDirectShell: true });
  assert.equal(off.sandbox, null);
  assert.equal((await off.commitShell({ command: 'echo bad > no.txt', cwd: root })).exitCode, undefined);
  assert.equal(fs.existsSync(path.join(root, 'no.txt')), false);
});

test('Windows runHosted：假模型网关驱动真本机命令，令牌只走 Authorization', { skip }, async (t) => {
  const token = 'zqp_windowsDirectTest_0123456789abcdef';
  const streams = [];
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: raw });
      const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: value })); };
      if (req.url.startsWith('/api/harness/models')) return json({ models: [{ id: 1, label: 'fake', modelName: 'fake', toolCalling: true, effectiveContextWindow: 100000 }], defaultModelId: 1 });
      if (req.url.startsWith('/api/harness/tools')) return json([]);
      if (req.url.startsWith('/api/harness/memory/brief')) return json({ enabled: false });
      if (req.url.startsWith('/api/harness/model/stream')) {
        streams.push(JSON.parse(raw));
        res.setHeader('Content-Type', 'text/event-stream');
        const send = (name, data) => res.write(`event:${name}\ndata:${JSON.stringify(data)}\n\n`);
        send('start', { contextWindow: 100000, droppedMessages: 0, elidedToolOutputs: 0 });
        const first = streams.length === 1;
        const message = first ? { role: 'assistant', content: '先运行测试', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'node -e "require(\'fs\').writeFileSync(\'hosted.txt\',\'真运行\');console.log(process.env.ZHIQU_TOKEN||\'clean\')"' }) } }] }
          : { role: 'assistant', content: '命令已实际运行' };
        send('done', { message, finishReason: first ? 'tool_calls' : 'stop', maxTokens: 1000, usage: { promptTokens: 1, completionTokens: 1, estimated: false } });
        return res.end();
      }
      return json({});
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = tmpdir();
  const events = [];
  const bridge = { send: value => events.push(value), redact() {}, onStop() {}, onSay() {} };
  const result = await runHosted(bridge, {
    root, home: os.homedir(), message: '运行', history: [], model: { id: 1 }, effort: 'instant', level: 'EXEC',
    canWrite: true, canShell: true, shellWrite: true, shellMode: 'direct', sandboxNetwork: 'on', maxRounds: 4, timeoutMs: 30000,
    local: { server: `http://127.0.0.1:${server.address().port}`, token },
  });
  assert.equal(result.error, null);
  assert.equal(result.conclusion, '命令已实际运行');
  assert.equal(fs.readFileSync(path.join(root, 'hosted.txt'), 'utf8'), '真运行');
  assert.match(result.context, /Windows 本机直接运行，不是系统沙箱/);
  assert.match(result.context, /clean/);
  assert.ok(streams[0].tools.some(tool => tool.function.name === 'shell'));
  assert.match(streams[0].messages[0].content, /Windows 本机直接运行/);
  for (const request of seen.filter(request => request.url.startsWith('/api/harness/'))) {
    assert.equal(request.auth, `Bearer ${token}`);
    assert.ok(!request.body.includes(token));
  }
  assert.ok(events.some(event => event.type === 'trace'));
});

test('直接 shell：命令里写明的工作区外路径和 .git 不执行，工作区里的相对路径照常写', async () => {
  const root = tmpdir();
  const outside = path.join(tmpdir(), 'outside.txt');
  const tools = new DesktopTools({ root, canWrite: true, shellWrite: true, allowDirectShell: true, home: os.homedir() });
  const blocked = await tools.commitShell(tools.prepareShell({ command: `echo no > ${outside}` }));
  assert.equal(blocked.exitCode, 126);
  assert.match(blocked.content, /工作区外/);
  assert.equal(fs.existsSync(outside), false);
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  const gitWrite = await tools.commitShell(tools.prepareShell({ command: 'echo bad > .git/hooks/pre-commit' }));
  assert.equal(gitWrite.exitCode, 126);
  assert.equal(fs.existsSync(hook), false);
  const script = `node -e "require('fs').writeFileSync(${JSON.stringify(outside)}, 'x')"`;
  const coded = await tools.commitShell(tools.prepareShell({ command: script }));
  assert.equal(coded.exitCode, 126);
  assert.equal(fs.existsSync(outside), false);
  assert.equal(directWriteRefusal('node -p "process.version"', root), null);
  const ok = await tools.commitShell(tools.prepareShell({ command: 'echo yes > inside.txt' }));
  assert.equal(ok.exitCode, 0, ok.content);
  assert.equal(fs.readFileSync(path.join(root, 'inside.txt'), 'utf8').trim(), 'yes');
  assert.match(describeBoundary({ direct: true }), /工作区外/);
});
