// OpenAI 兼容的假模型：每次都用极端内容回答（流式）。端口 18199。
const http = require('http');
const X = require('./extreme');

http.createServer((req, res) => {
  let buf = '';
  req.on('data', c => buf += c);
  req.on('end', () => {
    let stream = true;
    try { stream = JSON.parse(buf).stream !== false; } catch (e) {}
    const reply = X.MARKDOWN;
    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = reply.match(/[\s\S]{1,300}/g);
    for (const c of chunks) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
}).listen(18199, '127.0.0.1', () => console.log('fake model on 18199'));
