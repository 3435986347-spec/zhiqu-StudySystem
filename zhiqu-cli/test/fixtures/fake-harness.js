// 假的 harness 服务器（在测试进程里起）：/api/harness/** 的最小实现，外加可配的延迟与故障。测试用，不是产品代码。
//
//   const s = await startFakeHarness({ latencyMs: 150, model: [...] });   s.url / s.requests / s.close()
//
// model 是模型接口依次要做的事（用完了重复最后一项）：
//   { text }                       正常回一段文字
//   { calls: [{ name, args }] }    回工具调用
//   { status: 429 | 502 | ... }    直接回这个 HTTP 状态
//   { drop: true }                 连接建立后什么都不发就断开（模拟网络闪断）
//   { hang: true }                 连接建立后什么都不发、也不断（模拟卡死）
//   { dropAfterText: '…' }         先发一段文字再断开（已经输出了一半时断线）
//   { thinkMs, heartbeat }         先等 thinkMs 再回；heartbeat 为真时等待期间每 50ms 发一行 SSE 注释
import http from 'node:http';

export async function startFakeHarness({ latencyMs = 0, model = [{ text: '好' }], routeLatency = {} } = {}) {
  const requests = [];
  let n = 0;
  const sockets = new Set();
  const json = (res, data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { code: 200, message: 'success', data } : { code: status, message: `HTTP ${status}` }));
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const route = `${req.method} ${req.url.split('?')[0]}`;
      requests.push({ route, at: Date.now(), body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
      const delay = routeLatency[route] ?? latencyMs;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      switch (route) {
        case 'GET /api/harness/me': return json(res, { userId: 1, username: 'u', nickname: '测试', auth: 'token' });
        case 'GET /api/harness/models': return json(res, { models: [{ id: 1, label: '假模型', modelName: 'm', toolCalling: true, effectiveContextWindow: 64000, isDefault: true }], defaultModelId: 1 });
        case 'GET /api/harness/tools': return json(res, [{ type: 'function', function: { name: 'search_wiki', parameters: { type: 'object', properties: {} } } }]);
        case 'GET /api/harness/meta': return json(res, { cliLatest: '0.1.0', cliMinimum: '0.1.0' });
        case 'POST /api/harness/sessions': return json(res, { sessionId: 's', notebookId: 1 });
        case 'POST /api/harness/tools/call': return json(res, { content: `远程结果：${body}` });
        case 'POST /api/harness/model/stream': return stream(res);
        default:
          if (route.startsWith('POST /api/harness/sessions/')) return json(res, { notebookId: 1, messageIds: [1, 2] });
          return json(res, null, 404);
      }
    });
  });
  function stream(res) {
    const step = model[Math.min(n, model.length - 1)];
    n += 1;
    if (step.status) { res.writeHead(step.status, { 'Content-Type': 'application/json', 'Retry-After': '0' }); res.end('{}'); return; }
    if (step.drop) { res.socket.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();          // 不写一个字节的话 Node 不发响应头 —— 「卡死」要的是头已经到了、之后没数据
    if (step.hang) return;
    if (step.dropAfterText) {        // 先发一段文字再断开：模拟「已经输出了一半」时断线
      res.write(`event:start\ndata:{}\n\nevent:delta\ndata:${JSON.stringify({ text: step.dropAfterText })}\n\n`);
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    const send = (event, data) => res.write(`event:${event}\ndata:${JSON.stringify(data)}\n\n`);
    const finish = () => {
      send('start', { contextWindow: 64000, droppedMessages: 0, elidedToolOutputs: 0 });
      if (step.text) send('delta', { text: step.text });
      const calls = (step.calls || []).map((c, i) => ({ id: `c${n}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
      calls.forEach((c, i) => send('tool_call', { index: i, id: c.id, name: c.function.name }));
      const message = { role: 'assistant', content: step.text || '' };
      if (calls.length) message.tool_calls = calls;
      send('done', { message, finishReason: calls.length ? 'tool_calls' : 'stop', maxTokens: 16000, usage: { promptTokens: 1, completionTokens: 1, estimated: false } });
      res.end();
    };
    if (step.thinkMs) {
      const beat = step.heartbeat ? setInterval(() => res.write(':ping\n\n'), 50) : null;
      setTimeout(() => { if (beat) clearInterval(beat); finish(); }, step.thinkMs);
    } else {
      finish();
    }
  }
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}
