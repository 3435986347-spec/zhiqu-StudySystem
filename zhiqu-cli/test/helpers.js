// 测试用的小工具：临时目录、临时的 ~/.zhiqu、假终端、假服务器接口。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { Ui } from '../src/ui.js';

export function tmpdir(prefix = 'zhiqu-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** 假终端：answers 按顺序当作用户的输入；输出收进 text()。 */
export function fakeUi(answers = []) {
  const input = new PassThrough();
  for (const a of answers) input.write(`${a}\n`);
  input.end();
  let out = '';
  const output = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
  const ui = new Ui({ input, output, color: false });
  ui.text = () => out;
  return ui;
}

/**
 * 假的服务器接口。replies 是模型依次要回的东西：
 *   { text } / { calls: [{ name, args }] } / { calls, finishReason: 'length', rawArgs }
 * 每次模型调用把请求体记进 requests。
 */
export function fakeApi(replies, { remote = {} } = {}) {
  const requests = [];
  const posts = [];
  let n = 0;
  return {
    requests,
    posts,
    async stream(pathname, body, onEvent) {
      requests.push(JSON.parse(JSON.stringify(body)));
      const r = replies[Math.min(n, replies.length - 1)];
      n += 1;
      onEvent('start', { droppedMessages: 0, elidedToolOutputs: 0, contextWindow: 64000 });
      if (r.reasoning) onEvent('reasoning', { text: r.reasoning });
      if (r.text) onEvent('delta', { text: r.text });
      const calls = (r.calls || []).map((c, i) => {
        onEvent('tool_call', { index: i, id: `c${n}_${i}`, name: c.name });
        return { id: `c${n}_${i}`, type: 'function', function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args || {}) } };
      });
      const message = { role: 'assistant', content: r.text || '' };
      if (calls.length) message.tool_calls = calls;
      Object.assign(message, r.fields);   // 网关挂上来的字段（思考内容），命令行要原样记着带回去
      onEvent('done', { message, finishReason: r.finishReason || (calls.length ? 'tool_calls' : 'stop'), maxTokens: 16000,
        usage: r.usage || { promptTokens: 10, completionTokens: 5, estimated: false } });
    },
    async post(pathname, body) {
      posts.push({ pathname, body });
      if (pathname === '/api/harness/tools/call') return remote[body.name] ? remote[body.name](body) : { content: 'ok' };
      return {};
    },
    async get() { return {}; },
  };
}

/** 假服务器：replies 依次是模型的回答 */
export async function fakeServer(t, replies) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const json = (v) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: v })); };
      if (req.url.startsWith('/api/harness/models')) return json({ models: [{ id: 1, label: 'm', modelName: 'm', toolCalling: true, effectiveContextWindow: 100000 }], defaultModelId: 1 });
      if (req.url.startsWith('/api/harness/tools')) return json([]);
      if (req.url.startsWith('/api/harness/model/stream')) {
        const body = JSON.parse(raw);
        seen.push(body);
        const r = replies[Math.min(seen.length - 1, replies.length - 1)];
        res.setHeader('Content-Type', 'text/event-stream');
        const send = (name, data) => res.write(`event:${name}\ndata:${JSON.stringify(data)}\n\n`);
        if (r.hang) return undefined;   // 不回：看中断
        send('start', { contextWindow: 100000, droppedMessages: 0, elidedToolOutputs: 0 });
        const calls = (r.calls || []).map((c, i) => ({ id: `c${seen.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
        const message = { role: 'assistant', content: r.text || '' };
        if (calls.length) message.tool_calls = calls;
        send('done', { message, finishReason: calls.length ? 'tool_calls' : 'stop', maxTokens: 16000, usage: { promptTokens: 100, completionTokens: 7, cachedTokens: 40, estimated: false } });
        return res.end();
      }
      return json({});
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { url: `http://127.0.0.1:${srv.address().port}`, seen };
}

export function runZhiqu(sub, args, { url, root = tmpdir(), home = tmpdir(), stdin = null, onSpawn, path: searchPath = process.env.PATH } = {}) {
  const env = { PATH: searchPath, HOME: home, ZHIQU_HOME: path.join(home, '.zhiqu'), ZHIQU_TOKEN: 'zqp_x', ZHIQU_SERVER: url || 'http://127.0.0.1:1' };
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.resolve('bin/zhiqu.js'), sub, ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ code, stdout, stderr, root, home }));
    if (stdin != null) c.stdin.end(stdin);
    else if (!onSpawn) c.stdin.end();
    if (onSpawn) onSpawn(c);
  });
}
