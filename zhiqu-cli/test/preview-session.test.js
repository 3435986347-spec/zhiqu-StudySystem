// 常驻预览（第一百八十八轮）：不真开 Chrome 也能对上动作、帧差和地址。调试端口用本机套接字对一次。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { runTurn } from '../src/agent.js';
import { connectCdp, decodeFrames, encodeServerText } from '../src/tools/cdp.js';
import { LocalTools } from '../src/tools/local.js';
import { SessionStore } from '../src/session.js';
import {
  meanGridDelta, portsFromJobs, previewAddress, PreviewSession,
} from '../src/tools/preview.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

test('亮度格的帧差：一张没有，两张一样是 0，全黑到全白是 9', () => {
  const black = Array(8).fill('00000000');
  const white = Array(8).fill('99999999');
  assert.equal(meanGridDelta([black]), null);
  assert.equal(meanGridDelta([black, black]), 0);
  assert.equal(meanGridDelta([black, white]), 9);
});

test('预览地址只认这一轮拉起的 127.0.0.1 / localhost', () => {
  assert.equal(previewAddress('page.html', new Set()), null);
  assert.match(previewAddress('https://example.com/', new Set([443])).error, /不打开别的网址/);
  assert.match(previewAddress('http://127.0.0.1:9/x', new Set()).error, /不是这一轮/);
  assert.equal(previewAddress('http://127.0.0.1:8765/x', new Set([8765])).url, 'http://127.0.0.1:8765/x');
  assert.match(previewAddress('http://localhost:8765/', new Set([8765])).url, /^http:\/\/localhost:8765\/$/);
  const ports = portsFromJobs([
    { command: 'curl http://127.0.0.1:8080', child: { pid: 1 } },
    { command: 'python3 -m http.server 8765', child: { pid: 2 } },
  ], (pid) => (pid === 2 ? 'node 2 TCP 127.0.0.1:9000 (LISTEN)\n' : ''));
  assert.deepEqual([...ports].sort((a, b) => a - b), [8765, 9000]);
});

test('调试端口：文本帧来回，服务端的应答能对上发出去的方法', async () => {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let open = false;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!open) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('latin1');
        const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(head)[1];
        const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buf = buf.subarray(end + 4);
        open = true;
      }
      const decoded = decodeFrames(buf);
      buf = Buffer.from(decoded.rest);
      for (const frame of decoded.frames) {
        const msg = JSON.parse(frame.data.toString('utf8'));
        sock.write(encodeServerText(JSON.stringify({ id: msg.id, result: { method: msg.method } })));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const cdp = await connectCdp(`ws://127.0.0.1:${port}/devtools/page/1`);
    const result = await cdp.call('Page.enable');
    assert.equal(result.method, 'Page.enable');
    cdp.close();
  } finally {
    server.close();
  }
});

test('常驻会话：GPU 不行就退回 SwiftShader，点、拖、按键按顺序发，连拍只报帧差', async () => {
  const log = [];
  const killed = [];
  let glNow = '';
  const session = new PreviewSession({
    chrome: '/Applications/Google Chrome',
    glOrder: ['metal', 'swiftshader'],
    sleep: async (ms) => { log.push(['sleep', ms]); },
    async startBrowser(gl) {
      glNow = gl;
      log.push(['launch', gl]);
      return { ws: 'ws://127.0.0.1/devtools/page/1', kill() { killed.push(gl); } };
    },
    async connect() {
      return {
        async call(method, params) {
          log.push([method, params && params.type]);
          if (method === 'Runtime.evaluate') return { result: { value: glNow === 'swiftshader' } };
          if (method === 'Page.captureScreenshot') return { data: PNG.toString('base64') };
          return {};
        },
        once() { return Promise.resolve(null); },
        close() { log.push(['close']); },
      };
    },
  });
  const shot = await session.show({
    url: 'http://127.0.0.1:8765/',
    actions: [
      { type: 'click', x: 10, y: 20 },
      { type: 'key', text: 'Enter' },
      { type: 'drag', x: 1, y: 2, x2: 8, y2: 9 },
    ],
    frames: 2,
  });
  assert.equal(shot.delta, 0, JSON.stringify(shot));
  assert.match(shot.page, /帧差 0/);
  assert.match(shot.renderer, /SwiftShader/);
  assert.deepEqual(log.filter((x) => x[0] === 'launch').map((x) => x[1]), ['metal', 'swiftshader']);
  assert.equal(killed[0], 'metal');
  const types = log.filter((x) => x[0] === 'Input.dispatchMouseEvent').map((x) => x[1]);
  assert.deepEqual(types, ['mousePressed', 'mouseReleased', 'mousePressed', 'mouseMoved', 'mouseReleased']);
  assert.ok(log.some((x) => x[0] === 'Input.dispatchKeyEvent' && x[1] === 'keyDown'));
  assert.deepEqual(log.filter((x) => x[0] === 'sleep'), [['sleep', 200]]);
  await session.close();
});

test('系统 WebKit 不能点、不能连拍；回合结束才关浏览器，子 agent 不关', async () => {
  const root = tmpdir();
  write(root, 'p.html', '<h1>x</h1>');
  const tools = new LocalTools({ root });
  tools.chrome = path.join(root, 'zhiqu-webkit-shot');
  const limited = await tools.previewPage({ path: 'p.html', frames: 2 });
  assert.match(limited.error, /只能截工作区里的一张图/);
  const foreign = await tools.previewPage({ path: 'http://evil.test/' });
  assert.match(foreign.error, /不打开别的网址/);
  tools.jobs.running = () => [{ command: 'python3 -m http.server 8765', child: { pid: 4 } }];
  assert.equal(previewAddress('http://127.0.0.1:8765/', tools.localPorts()).url, 'http://127.0.0.1:8765/');

  const store = new SessionStore(root);
  let closed = 0;
  const ctx = {
    ui: fakeUi([]), api: fakeApi([{ text: '好' }]), root, mode: 'auto', maxRounds: 4,
    local: tools, store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 64_000 },
  };
  ctx.local.closePreview = async () => { closed += 1; };
  await runTurn(ctx, '你好');
  assert.equal(closed, 1);
  ctx.subagent = true;
  ctx.api = fakeApi([{ text: '也好' }]);
  await runTurn(ctx, '再');
  assert.equal(closed, 1);
});
