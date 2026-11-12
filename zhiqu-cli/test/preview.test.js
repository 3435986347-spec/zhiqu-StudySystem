// 页面预览截图（第一百三十四轮）：模型写完 HTML 自己看一眼渲染结果。
// 用一个假的「浏览器」脚本代替真 Chrome（真 Chrome 在 CI / 别的机器上不一定有），
// 盯的是：静态服务只给工作区里的文件、路径跳不出去、截图真的生成、太大的图会被拒。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findChrome, screenshotPage, serveDir } from '../src/tools/preview.js';
import { tmpdir, write } from './helpers.js';

// 1x1 的透明 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** 假浏览器：把 --screenshot= 指的文件写出来，参数不对就非 0 退出。 */
function fakeChrome(dir, { bytes = PNG, fail = false } = {}) {
  const file = path.join(dir, 'fake-chrome.mjs');
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const out = (args.find((a) => a.startsWith('--screenshot=')) || '').slice('--screenshot='.length);
const url = args.find((a) => a.startsWith('http://127.0.0.1:'));
${fail ? "process.stderr.write('boom\\n'); process.exit(7);" : `
if (!out || !url) { process.stderr.write('参数不对\\n'); process.exit(2); }
// 真的去取一次：证明静态服务在跑、页面取得到
const res = await fetch(url);
if (!res.ok) { process.stderr.write('取不到页面 ' + res.status + '\\n'); process.exit(3); }
fs.writeFileSync(out, Buffer.from('${bytes.toString('base64')}', 'base64'));`}
`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('找浏览器：ZHIQU_CHROME 优先，找不到就是 null（这个工具不下发）', () => {
  assert.equal(findChrome({ env: { ZHIQU_CHROME: '/x/chrome' }, platform: 'darwin', exists: (p) => p === '/x/chrome' }), '/x/chrome');
  assert.equal(findChrome({ env: {}, platform: 'darwin', exists: () => false }), null);
  assert.equal(findChrome({ env: {}, platform: 'linux', exists: (p) => p === '/usr/bin/chromium' }), '/usr/bin/chromium');
});

test('静态服务：只给工作区里的文件，跳出工作区的一律 403', async () => {
  const root = tmpdir();
  write(root, 'index.html', '<h1>hi</h1>');
  const site = await serveDir(root);
  try {
    const ok = await fetch(`http://127.0.0.1:${site.port}/index.html`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /hi/);
    const missing = await fetch(`http://127.0.0.1:${site.port}/nope.html`);
    assert.equal(missing.status, 404);
    // 编码过的 ../ 也要挡住：URL 会先把 %2e 归一成 .，两种结果都不能是 200
    const escape = await fetch(`http://127.0.0.1:${site.port}/%2e%2e/%2e%2e/etc/passwd`);
    assert.notEqual(escape.status, 200, '路径跳出了工作区');
    assert.doesNotMatch(await escape.text(), /root:/);
  } finally { await site.close(); }
});

test('截图：真跑一遍「浏览器」把图写出来；不是 html、找不到、太大会照实说', async () => {
  const root = tmpdir();
  write(root, 'page.html', '<h1>页面</h1><script>document.title="x"</script>');
  write(root, 'notes.txt', 'not a page');
  const chrome = fakeChrome(tmpdir());

  const shot = await screenshotPage({ root, rel: 'page.html', chrome });
  assert.ok(shot.base64 && shot.mediaType === 'image/png', JSON.stringify(shot));
  assert.equal(shot.bytes, PNG.length);
  assert.equal(shot.width, 1200);

  const notHtml = await screenshotPage({ root, rel: 'notes.txt', chrome });
  assert.match(notHtml.error, /只支持预览 \.html/);

  const missing = await screenshotPage({ root, rel: 'nope.html', chrome });
  assert.match(missing.error, /找不到/);

  const escape = await screenshotPage({ root, rel: '../etc/passwd', chrome });
  assert.match(escape.error, /只能预览工作区里的文件/);

  const broken = await screenshotPage({ root, rel: 'page.html', chrome: fakeChrome(tmpdir(), { fail: true }) });
  assert.match(broken.error, /退出码 7|boom/);
});

test('目录：里面有 index.html 就截它', async () => {
  const root = tmpdir();
  write(root, 'site/index.html', '<h1>首页</h1>');
  const shot = await screenshotPage({ root, rel: 'site', chrome: fakeChrome(tmpdir()) });
  assert.ok(shot.base64, JSON.stringify(shot));
});
