#!/usr/bin/env node
// 脚本化的假模型：OpenAI /chat/completions 流式格式。端到端测试用，不是产品代码。
//
//   node mock-model.js <port> <script.json> [requests.log]
//
// script.json 是一个数组，第 n 次请求回第 n 项（用完了回最后一项）：
//   { "text": "正文" }                              → 只回正文
//   { "tool": "write_file", "args": {...}, "text": "可选的前导正文" }  → 回一个工具调用
//   { "tools": [{ "tool": ..., "args": ... }, ...] }  → 一次回多个工具调用
//   { "status": 400, "error": "..." }                → 回错误
// 每次请求的请求体追加写进 requests.log（一行一个 JSON），测试据此断言「模型收到了什么」。
'use strict';
const http = require('http');
const fs = require('fs');

const port = Number(process.argv[2] || 0);
const script = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const logFile = process.argv[4];
let n = 0;

function chunk(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (logFile) fs.appendFileSync(logFile, body.replace(/\n/g, ' ') + '\n');
    const step = script[Math.min(n, script.length - 1)];
    n += 1;
    if (step.status) {
      res.writeHead(step.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: step.error || 'mock error' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let out = '';
    if (step.text) {
      for (const piece of step.text.match(/[\s\S]{1,6}/g) || []) {
        out += chunk({ choices: [{ delta: { content: piece } }] });
      }
    }
    const calls = step.tools || (step.tool ? [{ tool: step.tool, args: step.args }] : []);
    calls.forEach((c, i) => {
      const args = JSON.stringify(c.args || {});
      out += chunk({ choices: [{ delta: { tool_calls: [{ index: i, id: 'call_' + n + '_' + i, type: 'function',
        function: { name: c.tool, arguments: '' } }] } }] });
      for (const piece of args.match(/[\s\S]{1,40}/g) || []) {
        out += chunk({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: piece } }] } }] });
      }
    });
    out += chunk({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100 + n, completion_tokens: 20 + n } });
    out += 'data: [DONE]\n\n';
    res.end(out);
  });
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write('MOCK_PORT=' + server.address().port + '\n');
});
