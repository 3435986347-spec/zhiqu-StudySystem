// 页面预览截图（第一百三十四轮）：模型写完 HTML，自己看一眼渲染出来是什么样。
//
// 为什么不放进沙箱跑 Chrome：macOS 的 Seatbelt 只放 6 个 mach 服务（没有 WindowServer / CoreText /
// cfprefsd / LaunchServices），家目录整个读不到；Linux 的 bwrap 又带 --disable-userns，Chrome 的
// 渲染进程建不了自己的命名空间。放开这些就等于把沙箱拆了（见 docs/notes/code-workspace.md）。
//
// 所以这一层跑在**宿主进程**里：命令行自己起一个只监听 127.0.0.1 的静态服务，再叫宿主机的无头
// Chrome 截图。页面里的脚本是在一个没有任何登录态的临时 profile 里跑的，跑完就删。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

const CHROME_PATHS = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

/** 宿主机的浏览器：`ZHIQU_CHROME` 指哪用哪，否则找常见安装位置。找不到返回 null（这个工具就不下发）。 */
export function findChrome({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const custom = env.ZHIQU_CHROME;
  if (custom && exists(custom)) return custom;
  for (const p of CHROME_PATHS[platform] || []) if (exists(p)) return p;
  return null;
}

const inside = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** 只读的静态服务，只监听 127.0.0.1。用来给浏览器取页面和它引用的 css / js / 图片。 */
export async function serveDir(root) {
  // 惰性加载：node:http 在 ESM 里会顺带把 tls 拉进来（reliability 那条判据盯着「加载 cli 不许加载 tls」）
  const http = (await import('node:http')).default;
  const realRoot = fs.realpathSync(root);
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch { res.writeHead(400); res.end(); return; }
    const target = path.resolve(realRoot, '.' + rel);
    if (!inside(realRoot, target)) { res.writeHead(403); res.end(); return; }
    fs.stat(target, (err, st) => {
      const file = !err && st.isDirectory() ? path.join(target, 'index.html') : target;
      fs.readFile(file, (e, buf) => {
        if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('找不到这个文件'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : buf);
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

/** 跑一次无头 Chrome 截图。返回 { ok } 或 { error }。 */
export function shoot({ chrome, url, out, width, height, timeoutMs = 30_000 }) {
  return new Promise((resolve) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-shot-'));
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update',
      '--run-all-compositor-stages-before-draw', '--virtual-time-budget=3000',
      `--user-data-dir=${profile}`, `--window-size=${width},${height}`, `--screenshot=${out}`, url,
    ];
    let stderr = '';
    const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } }, timeoutMs);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: `起不来 ${chrome}：${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 删不掉留着也没关系 */ }
      if (code !== 0 && !fs.existsSync(out)) { resolve({ error: `浏览器退出码 ${code}${stderr ? `：${stderr.split('\n').filter(Boolean).slice(-2).join(' ')}` : ''}` }); return; }
      resolve(fs.existsSync(out) ? { ok: true } : { error: '浏览器没有生成截图' });
    });
  });
}

/**
 * 截一张页面。rel 相对工作区，可以是 .html 文件，也可以是带 index.html 的目录。
 * 返回 { mediaType, base64, bytes, width, height } 或 { error }。
 */
export async function screenshotPage({ root, rel, width = 1200, height = 900, chrome, timeoutMs }) {
  const realRoot = fs.realpathSync(root);
  const file = path.resolve(realRoot, rel || '.');
  if (!inside(realRoot, file)) return { error: '只能预览工作区里的文件' };
  const page = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file;
  if (!fs.existsSync(page)) return { error: `找不到要预览的文件：${rel}` };
  if (!/\.html?$/i.test(page)) return { error: '只支持预览 .html 文件（目录的话里面要有 index.html）' };
  const w = Math.min(2000, Math.max(320, Number(width) || 1200));
  const h = Math.min(2000, Math.max(240, Number(height) || 900));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-preview-'));
  const out = path.join(work, 'shot.png');
  const site = await serveDir(realRoot);
  try {
    const relUrl = path.relative(realRoot, page).split(path.sep).map(encodeURIComponent).join('/');
    const shot = await shoot({ chrome, url: `http://127.0.0.1:${site.port}/${relUrl}`, out, width: w, height: h, timeoutMs });
    if (shot.error) return { error: shot.error };
    const buf = fs.readFileSync(out);
    if (!buf.length) return { error: '截图是空的' };
    // 太大的图会把上下文吃掉：让模型自己缩小窗口再试，而不是硬塞
    if (buf.length > 1_500_000) return { error: `截图 ${Math.round(buf.length / 1024)}KB，太大（上限 1.5MB）；把 width / height 调小再试` };
    return { mediaType: 'image/png', base64: buf.toString('base64'), bytes: buf.length, width: w, height: h };
  } finally {
    await site.close().catch(() => {});
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
}
