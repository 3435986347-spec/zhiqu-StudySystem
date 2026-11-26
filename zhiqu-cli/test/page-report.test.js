// 长活省钱第 3 步（第一百六十八轮，docs/agent-efficiency-plan.md）：preview_page 带上文字版的页面情况，目标核对员也看最后一张截图。
// 原来只有一张图：报错、白屏要靠看图猜；核对员只读文字，用户那段会话里模型为了给它凑证据专门写了回传报告的服务器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { runGoal, verifyGoal } from '../src/agent.js';
import { ApiError } from '../src/api.js';
import { lastScreenshot, newGoal } from '../src/goal.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { analyzePng, describePage, findChrome, FLAT_SHARE, injectProbe, PROBE_PATH, PROBE_SCRIPT, screenshotPage, serveDir } from '../src/tools/preview.js';
import { fakeApi, fakeUi, tmpdir, write } from './helpers.js';

// ── 自己编一张 PNG：每行轮流用 5 种滤波，解码那边 5 种都要认 ──
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h, pixel, { alpha = true } = {}) {
  const bpp = alpha ? 4 : 3;
  const stride = w * bpp;
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) { const p = pixel(x, y); for (let k = 0; k < bpp; k++) cur[x * bpp + k] = k < 3 ? p[k] : 255; }
    const f = y % 5;
    const line = Buffer.alloc(stride + 1); line[0] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = a; else if (f === 2) pred = b; else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i + 1] = (cur[i] - pred) & 255;
    }
    rows.push(line); prev = cur;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const BLACK = makePng(120, 90, () => [0, 0, 0]);
const BUSY = makePng(120, 90, (x, y) => [(x * 7) & 255, (y * 11) & 255, ((x + y) * 5) & 255]);

/** 假浏览器：取一次页面（拿到注入了探针的 html），照 report 回传一份，再写截图 */
function fakeChrome(dir, png, report) {
  const file = path.join(dir, 'fake-chrome.mjs');
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const out = (args.find((a) => a.startsWith('--screenshot=')) || '').slice('--screenshot='.length);
const url = args.find((a) => a.startsWith('http://127.0.0.1:'));
const html = await (await fetch(url)).text();
if (!html.includes('data-zhiqu-probe')) process.exit(5);
${report ? `await fetch(new URL('${PROBE_PATH}', url), { method: 'POST', body: ${JSON.stringify(JSON.stringify(report))} });` : ''}
fs.writeFileSync(out, Buffer.from('${png.toString('base64')}', 'base64'));
`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('像素：5 种滤波都解得对；纯黑一张是 100% 单色，花的不是；RGB 也认；认不了的返回 null', () => {
  const black = analyzePng(BLACK);
  assert.equal(black.share, 1);
  assert.equal(black.color, '#000000');
  assert.equal(black.luma, 0);
  const busy = analyzePng(BUSY);
  assert.ok(busy.share < 0.2, `花的：最多的颜色只占 ${busy.share}`);
  const half = analyzePng(makePng(100, 100, (x) => (x < 50 ? [255, 255, 255] : [0, 0, 0]), { alpha: false }));
  assert.ok(Math.abs(half.share - 0.5) < 0.05 && half.color === '#ffffff' || half.color === '#000000');
  assert.ok(Math.abs(half.luma - 128) < 8, `平均亮度 ${half.luma}`);
  // 滤波解错的话，带渐变的行会算出别的颜色：逐像素都一样的竖条照样得是两种颜色
  const stripes = analyzePng(makePng(60, 60, (x) => (x % 2 ? [200, 30, 30] : [30, 30, 200])));
  assert.ok(stripes.share > 0.45 && stripes.share < 0.55, `竖条两种颜色各一半：${stripes.share}`);
  assert.equal(analyzePng(Buffer.from('not a png')), null);
  assert.equal(analyzePng(Buffer.alloc(0)), null);
});

test('注入：放在 <head> 最前面；没有 head 放在 doctype 后面（放前面页面会掉进怪异模式）；什么都没有就放开头', () => {
  const a = injectProbe('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>t</title></head><body></body></html>');
  assert.ok(a.startsWith('<!doctype html><html lang="zh"><head>' + PROBE_SCRIPT + '<meta charset="utf-8">'));
  const b = injectProbe('<!DOCTYPE html>\n<p>hi</p>');
  assert.ok(b.startsWith('<!DOCTYPE html>' + PROBE_SCRIPT));
  assert.ok(injectProbe('<p>hi</p>').startsWith(PROBE_SCRIPT));
  assert.doesNotThrow(() => new Function(PROBE_SCRIPT.replace(/<\/?script[^>]*>/g, '')), '探针本身是合法的脚本');
  assert.ok(!PROBE_SCRIPT.includes('\n'), '探针是一行：不推后页面的行号');
  const page = '<!doctype html>\n<script>throw new Error("boom")</script>\n';
  assert.equal(injectProbe(page).split('\n')[1], '<script>throw new Error("boom")</script>', '探针不另起一行，页面脚本仍在第 2 行');
  assert.match(PROBE_SCRIPT, /着色器编译失败/);
  assert.match(PROBE_SCRIPT, /着色器链接失败/);
});

test('探针：WebGL 编译或链接失败记进报错，成功的不记，条数仍最多 10', () => {
  const sent = [];
  const gl = {
    COMPILE_STATUS: 1, LINK_STATUS: 2,
    compileShader() {}, linkProgram() {},
    getShaderParameter(sh) { return sh.ok; },
    getProgramParameter(p) { return p.ok; },
    getShaderInfoLog(sh) { return sh.log; },
    getProgramInfoLog(p) { return p.log; },
  };
  const later = [];
  const listeners = {};
  const sandbox = {
    HTMLCanvasElement: { prototype: { getContext(type) { return /webgl/i.test(String(type)) ? gl : null; } } },
    document: { title: 't', body: { innerText: '' }, getElementsByTagName: () => [] },
    console,
    location: { origin: 'http://127.0.0.1' },
    setTimeout(fn) { later.push(fn); return 0; },
    XMLHttpRequest: class { open() {} setRequestHeader() {} send(body) { sent.push(JSON.parse(body)); } },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (name, fn) => { (listeners[name] ||= []).push(fn); };
  vm.runInNewContext(PROBE_SCRIPT.replace(/<\/?script[^>]*>/g, ''), sandbox);
  const c = sandbox.HTMLCanvasElement.prototype.getContext('webgl');
  c.compileShader({ ok: false, log: 'C100' });
  c.compileShader({ ok: true, log: '' });
  c.linkProgram({ ok: false, log: '未链接' });
  for (const fn of later) fn();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].errors, ['着色器编译失败：C100', '着色器链接失败：未链接']);
  for (let i = 0; i < 12; i++) c.compileShader({ ok: false, log: 'x' + i });
  sent.length = 0;
  listeners.load.forEach((fn) => fn());
  for (const fn of later) fn();
  assert.ok(sent.at(-1).errors.length <= 10);
});

test('静态服务：probe 开着才给 html 注入、才收回传（只认那一个路径、64KB 以内）；别的文件原样给', async () => {
  const root = tmpdir();
  write(root, 'a.html', '<html><head></head><body>x</body></html>');
  write(root, 'a.js', 'console.log(1)');
  const plain = await serveDir(root);
  try {
    assert.ok(!(await (await fetch(`http://127.0.0.1:${plain.port}/a.html`)).text()).includes('data-zhiqu-probe'), '不开 probe：原样');
    assert.equal((await fetch(`http://127.0.0.1:${plain.port}${PROBE_PATH}`, { method: 'POST', body: '{}' })).status, 405);
  } finally { await plain.close(); }
  const site = await serveDir(root, { probe: true });
  try {
    const base = `http://127.0.0.1:${site.port}`;
    assert.ok((await (await fetch(`${base}/a.html`)).text()).includes('data-zhiqu-probe'));
    assert.equal(await (await fetch(`${base}/a.js`)).text(), 'console.log(1)', 'js 原样');
    assert.equal((await fetch(`${base}${PROBE_PATH}`, { method: 'POST', body: JSON.stringify({ errors: ['x'], final: true }) })).status, 204);
    await fetch(`${base}${PROBE_PATH}`, { method: 'POST', body: 'not json' });
    await fetch(`${base}${PROBE_PATH}`, { method: 'POST', body: JSON.stringify({ text: 'y'.repeat(70_000) }) }).catch(() => {});
    assert.equal((await fetch(`${base}/other`, { method: 'POST', body: '{}' })).status, 405, '别的路径照旧不收 POST');
    assert.deepEqual(site.reports, [{ errors: ['x'], final: true }], '坏的、太大的都不收');
  } finally { await site.close(); }
});

test('描述：没收到回传、有报错、几乎单色、正常，各说各的', () => {
  assert.match(describePage(null, analyzePng(BLACK)), /没收到页面的回传[\s\S]*100% 是同一种颜色 #000000，几乎是单色/);
  assert.match(describePage(null, analyzePng(BLACK), { renderer: '软件渲染（SwiftShader），不是这台机器的 GPU' }), /软件渲染（SwiftShader）[\s\S]*亮度格[\s\S]*00000000/);
  const errs = describePage({ final: true, errors: ['Uncaught TypeError: x is undefined (/main.js:12)'], rejections: ['加载失败'], consoleErrors: ['THREE.WebGLRenderer: Error creating WebGL context.'],
    title: '鹈鹕', text: '开始骑车', elements: 40, canvases: 1 }, analyzePng(BUSY));
  assert.match(errs, /报错 1 条：「Uncaught TypeError: x is undefined \(\/main\.js:12\)」/);
  assert.match(errs, /未处理的 Promise 拒绝 1 条/);
  assert.match(errs, /console\.error 1 条：「THREE\.WebGLRenderer/);
  assert.match(errs, /标题「鹈鹕」；可见文字（开头）「开始骑车」；元素 40 个，canvas 1 个/);
  assert.match(errs, /画面：有内容/);
  assert.match(describePage({ final: false, errors: [], title: '', text: '' }, null), /报错：没有[\s\S]*可见文字：没有[\s\S]*没在时限里加载完[\s\S]*格式认不了/);
  assert.ok(FLAT_SHARE >= 0.95);
});

test('preview_page 的工具结果里带着这几行（假浏览器照页面回传）', async () => {
  const root = tmpdir();
  write(root, 'p.html', '<!doctype html><html><head><title>t</title></head><body><canvas></canvas></body></html>');
  const chrome = fakeChrome(tmpdir(), BLACK, { final: true, errors: ['Uncaught ReferenceError: THREE is not defined (/p.html:9)'], title: 't', text: '', elements: 6, canvases: 1 });
  const tools = new LocalTools({ root });
  tools.chrome = chrome;   // 构造时找的是本机的浏览器；这里换成假的
  const r = await tools.previewPage({ path: 'p.html' });
  assert.ok(!r.error, r.error);
  assert.match(r.content, /页面情况（页面里的探针回传 \+ 截图像素）：/);
  assert.match(r.content, /报错 1 条：「Uncaught ReferenceError: THREE is not defined/);
  assert.match(r.content, /几乎是单色/);
  tools.chrome = fakeChrome(tmpdir(), BUSY, null);
  const none = await tools.previewPage({ path: 'p.html' });
  assert.match(none.content, /没收到页面的回传[\s\S]*画面：有内容/);
});

test('真 Chrome：页面里抛错、console.error、黑底空画布 —— 文字版都说得出来；正常页面说没有报错', { timeout: 240_000 }, async (t) => {
  const chrome = findChrome();
  if (!chrome || /zhiqu-webkit-shot/.test(chrome)) { t.skip('这台机器没有 Chrome'); return; }
  const root = tmpdir();
  write(root, 'bad.html', `<!doctype html><html><head><title>坏页面</title><style>html,body{margin:0;background:#000}canvas{width:100vw;height:100vh;display:block}</style></head>
<body><canvas></canvas><script>console.error('自己报的错');Promise.reject(new Error('没接住的拒绝'));undefinedFunction();</script></body></html>`);
  write(root, 'ok.html', '<!doctype html><html><head><title>好页面</title></head><body style="font:40px sans-serif"><h1>你好，鹈鹕</h1><p style="color:#c33">一些文字</p><p style="background:#39c;color:#fff">更多</p></body></html>');
  const bad = await screenshotPage({ root, rel: 'bad.html', chrome, width: 640, height: 480 });
  assert.ok(!bad.error, bad.error);
  assert.match(bad.page, /报错 1 条：「Uncaught ReferenceError: undefinedFunction is not defined \(\/bad\.html:2\)」/, `行号要和磁盘上的文件对得上（脚本在第 2 行）：${bad.page}`);
  assert.match(bad.page, /未处理的 Promise 拒绝 1 条：「没接住的拒绝」/, bad.page);
  assert.match(bad.page, /console\.error 1 条：「自己报的错」/, bad.page);
  assert.match(bad.page, /标题「坏页面」/);
  assert.match(bad.page, /几乎是单色/, bad.page);
  const ok = await screenshotPage({ root, rel: 'ok.html', chrome, width: 640, height: 480 });
  assert.ok(!ok.error, ok.error);
  assert.match(ok.page, /报错：没有/, ok.page);
  assert.match(ok.page, /可见文字（开头）「你好，鹈鹕 一些文字 更多」/, ok.page);
});

// ── 核对员看最后一张截图 ──

const IMG = `data:image/png;base64,${BUSY.toString('base64')}`;
function goalCtx(api) {
  const root = tmpdir();
  const store = new SessionStore(root);
  return { ui: fakeUi([]), api, root, mode: 'auto', maxRounds: 10, local: new LocalTools({ root }), store, session: store.create(),
    messages: [{ role: 'user', content: '做个页面' },
      { role: 'user', content: [{ type: 'text', text: '（下面的图就是刚才渲染的页面）' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,OLD' } }] },
      { role: 'user', content: [{ type: 'text', text: '（下面的图就是刚才渲染的页面）' }, { type: 'image_url', image_url: { url: IMG } }] },
      { role: 'assistant', content: '好了' }],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: 'm', effectiveContextWindow: 64000 }, goal: Object.assign(newGoal('做个页面'), { status: 'achieved', evidence: '截图看过' }) };
}

test('核对员拿到最后一张截图（最近那条里的最后一张），说明里告诉它怎么用', async () => {
  assert.equal(lastScreenshot([{ role: 'user', content: 'x' }]), null);
  const ctx = goalCtx(fakeApi([{ text: '{"achieved": true, "missing": ""}' }]));
  const v = await verifyGoal(ctx);
  assert.equal(v.achieved, true);
  const req = ctx.api.requests[0];
  assert.match(req.messages[0].content, /如果最后附了一张页面截图/);
  const content = req.messages[1].content;
  assert.ok(Array.isArray(content), '带图：内容是数组');
  assert.equal(content[1].image_url.url, IMG, '是最后一张，不是更早的那张');
  assert.match(content[0].text, /【执行者最后一次截的页面图】/);
});

test('带图被拒（模型不收图）：去掉图再问一次，照样拿到结论', async () => {
  const inner = fakeApi([{ text: '{"achieved": true, "missing": ""}' }]);
  const api = { ...inner, requests: inner.requests, async stream(p, body, on) {
    if (body.messages.some((m) => Array.isArray(m.content))) { inner.requests.push(body); throw new ApiError('这个模型不支持图片输入', { status: 400 }); }
    return inner.stream(p, body, on);
  } };
  const ctx = goalCtx(api);
  const v = await verifyGoal(ctx);
  assert.equal(v.achieved, true);
  assert.equal(api.requests.length, 2);
  assert.equal(typeof api.requests[1].messages[1].content, 'string', '第二次不带图');
});

test('没有截图的目标：核对员照旧只拿文字', async () => {
  const ctx = goalCtx(fakeApi([{ calls: [{ name: 'goal_update', args: { status: 'achieved', summary: '好', evidence: '跑过' } }] }, { text: '好' }, { text: '{"achieved": true, "missing": ""}' }]));
  ctx.messages = [];
  ctx.goal = newGoal('做个脚本');
  assert.equal(await runGoal(ctx), 'achieved');
  assert.equal(typeof ctx.api.requests.at(-1).messages[1].content, 'string');
});
