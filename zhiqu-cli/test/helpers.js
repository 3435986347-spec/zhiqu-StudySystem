// 测试用的小工具：临时目录、临时的 ~/.zhiqu、假终端、假服务器接口。
import fs from 'node:fs';
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
      if (r.text) onEvent('delta', { text: r.text });
      const calls = (r.calls || []).map((c, i) => {
        onEvent('tool_call', { index: i, id: `c${n}_${i}`, name: c.name });
        return { id: `c${n}_${i}`, type: 'function', function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args || {}) } };
      });
      const message = { role: 'assistant', content: r.text || '' };
      if (calls.length) message.tool_calls = calls;
      onEvent('done', { message, finishReason: r.finishReason || (calls.length ? 'tool_calls' : 'stop'), maxTokens: 16000,
        usage: { promptTokens: 10, completionTokens: 5, estimated: false } });
    },
    async post(pathname, body) {
      posts.push({ pathname, body });
      if (pathname === '/api/harness/tools/call') return remote[body.name] ? remote[body.name](body) : { content: 'ok' };
      return {};
    },
    async get() { return {}; },
  };
}
