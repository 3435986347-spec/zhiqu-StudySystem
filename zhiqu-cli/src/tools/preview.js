// 页面预览截图（第一百三十四轮）：模型写完 HTML，自己看一眼渲染出来是什么样。
//
// 为什么不放进沙箱跑 Chrome：macOS 的 Seatbelt 只放 6 个 mach 服务（没有 WindowServer / CoreText /
// cfprefsd / LaunchServices），家目录整个读不到；Linux 的 bwrap 又带 --disable-userns，Chrome 的
// 渲染进程建不了自己的命名空间。放开这些就等于把沙箱拆了（见 docs/notes/code-workspace.md）。
//
// 所以这一层跑在**宿主进程**里：命令行自己起一个只监听 127.0.0.1 的静态服务，再叫宿主机的无头
// Chrome 截图。页面里的脚本是在一个没有任何登录态的临时 profile 里跑的，跑完就删。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Arc.app/Contents/MacOS/Arc'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

const WEBKIT_NAME = 'zhiqu-webkit-shot';
const webKitSource = () => fileURLToPath(new URL('./webkit-shot.swift', import.meta.url));

/** 系统 WebKit 截图程序的缓存位置。源码变了（戳对不上）就重新编译。 */
export function webKitHelperPath(homedir = os.homedir) {
  return path.join(homedir(), '.zhiqu', 'preview', WEBKIT_NAME);
}

function webKitStamp(dest) { return `${dest}.stamp`; }

/**
 * 没有 Chrome.app 时，macOS 用系统自带的 WebKit（Safari 那个引擎）。要有 swiftc，第一次编译后缓存。
 * 返回缓存路径；还没编译也返回（真正截图时再编）。swiftc 和缓存都没有则返回 null。
 */
export function findWebKitHelper({ platform = process.platform, exists = fs.existsSync, homedir = os.homedir } = {}) {
  if (platform !== 'darwin') return null;
  const dest = webKitHelperPath(homedir);
  if (exists(dest) || exists('/usr/bin/swiftc')) return dest;
  return null;
}

/** 宿主机的浏览器：`ZHIQU_CHROME` 指哪用哪，否则找常见安装位置。都没有时，macOS 退回系统 WebKit。找不到返回 null。 */
export function findChrome({ env = process.env, platform = process.platform, exists = fs.existsSync, homedir = os.homedir } = {}) {
  const custom = env.ZHIQU_CHROME;
  if (custom && exists(custom)) return custom;
  for (const p of CHROME_PATHS[platform] || []) if (exists(p)) return p;
  return findWebKitHelper({ platform, exists, homedir });
}

export function isWebKitHelper(chrome) {
  return path.basename(String(chrome || '')) === WEBKIT_NAME;
}

/** 编译系统 WebKit 截图程序。成功返回路径。 */
export function compileWebKitHelper(dest = webKitHelperPath(), { exists = fs.existsSync, spawnCompiler = spawnSync } = {}) {
  if (!exists('/usr/bin/swiftc')) return null;
  const src = webKitSource();
  if (!exists(src)) return null;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
  const stamp = webKitStamp(dest);
  if (exists(dest) && exists(stamp)) {
    try { if (fs.readFileSync(stamp, 'utf8') === hash) return dest; } catch { /* 重新编译 */ }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = spawnCompiler('/usr/bin/swiftc', ['-O', '-framework', 'AppKit', '-framework', 'WebKit', '-o', dest, src], { stdio: 'ignore', timeout: 120_000 });
  if (!r || r.status !== 0 || !exists(dest)) return null;
  fs.writeFileSync(stamp, hash);
  return dest;
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

/**
 * 默认给多少时间渲染。软件渲染的 3D 页面本来就慢（SwiftShader 是 CPU 在画），
 * 45 秒在复杂场景上不够 —— 用户 2026-11-12：「45s 可以继续放宽一点」。
 * 模型也能用 preview_page 的 timeout_seconds 单独申请更长（上限 300 秒）。
 */
export const DEFAULT_TIMEOUT_MS = 90_000;
/** 截图字节上限。图按固定 token 估，不按 base64 字数；1.5MB 会把正常的一屏拒掉（用户 2026-11-13）。 */
export const MAX_PREVIEW_BYTES = 8_000_000;

/**
 * 跑一次无头 Chrome 截图。返回 { ok } 或 { error }。
 *
 * <p>两个坑（用户 2026-11-12 报「浏览器退出码 null」）：
 * <ul>
 *   <li>Chrome 会拉起更新器 / 崩溃上报这类子进程，它们<b>继承着我们的 stderr 管道</b>。只看 <code>close</code>
 *       的话，主进程早退出了、管道还开着，事件永远不来 —— 只能等我们的超时把它杀掉，于是 code 是 null。
 *       所以认 <code>exit</code>（主进程一退就到），并立刻把管道拆掉。</li>
 *   <li>超时被杀要照实说「渲染超时」，不要报一个「退出码 null」让人猜。</li>
 * </ul>
 */
export function shoot({ chrome, url, out, width, height, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    if (isWebKitHelper(chrome) && path.resolve(chrome) === path.resolve(webKitHelperPath())) {
      const built = compileWebKitHelper(chrome);
      if (!built) {
        resolve({ error: '这台机器没有 Chrome，系统 WebKit 也编译不了（需要 Xcode 命令行工具里的 swiftc，或者设置 ZHIQU_CHROME）' });
        return;
      }
      chrome = built;
    }
    const webkit = isWebKitHelper(chrome);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-shot-'));
    // 崩溃上报不听 --disable-crash-reporter：目录不可写时 Chrome / Chromium 直接起不来
    // （用户 2026-11-13）。指到这次自己的临时目录，HOME 也换过去，免得去写真实家目录。
    const crashes = path.join(profile, 'crashes');
    fs.mkdirSync(crashes, { recursive: true });
    const args = webkit
      ? [url, out, String(width), String(height), String(Math.ceil(timeoutMs / 1000))]
      : [
      '--headless=new',
      // 不要 --disable-gpu：它会把 GPU 进程整个关掉，headless 里就等于没有 WebGL，3D 页面截出来是空白。
      // 没有显卡 / 不允许用真 GPU 时让 ANGLE 走 SwiftShader 软件渲染；Chrome 129 起软件 WebGL 默认被禁，
      // 必须显式 --enable-unsafe-swiftshader 才拿得到上下文（用户 2026-11-12：3D 画面看不到）。
      '--enable-unsafe-swiftshader', '--use-gl=angle', `--use-angle=${process.env.ZHIQU_PREVIEW_GL || 'swiftshader'}`,
      '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
      // HOME 在下面被换成了临时目录，Chrome 在 macOS 上会去 ~/Library/Keychains 找「Chrome Safe Storage」，
      // 找不到就提示「找不到用于存储 chrome 的钥匙串」（用户 2026-11-13）。用内存里的假钥匙串 + basic
      // 密码存储：完全不碰系统钥匙串，也不弹系统对话框。CI / 容器里跑无头 Chrome 也是这两条。
      '--use-mock-keychain', '--password-store=basic',
      '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update',
      '--disable-breakpad', '--disable-crash-reporter', `--crash-dumps-dir=${crashes}`, '--disable-background-mode', '--no-pings',
      // 别把更新器 / 组件的日志倒进我们的管道（那些 VERBOSE1 就是它）
      '--disable-logging', '--log-level=3',
      '--run-all-compositor-stages-before-draw', '--virtual-time-budget=5000',
      `--user-data-dir=${profile}`, `--window-size=${width},${height}`, `--screenshot=${out}`, url,
    ];
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'], env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: profile, TMPDIR: profile, XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: profile,
    } });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { child.stderr.destroy(); } catch { /* 已经关了 */ }
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 删不掉留着也没关系 */ }
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
      // 杀完再给一小会儿：文件可能已经写好了，只是进程没退干净
      setTimeout(() => finish(judge(null, null)), 300);
    }, timeoutMs);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); finish({ error: `起不来 ${chrome}：${e.message}` }); });

    function judge(code, signal) {
      if (fs.existsSync(out)) return { ok: true };
      if (timedOut) {
        return { error: `渲染超时（${Math.round(timeoutMs / 1000)} 秒）已经停下。页面可能一直有动画或没完的请求；`
          + '把 width / height 调小、或者先让页面在加载完后停下来，再试。' };
      }
      const tail = stderr.split('\n').filter(Boolean).slice(-2).join(' ');
      const how = signal ? `被信号 ${signal} 结束` : `退出码 ${code}`;
      return { error: `浏览器${how}${tail ? `：${tail}` : ''}` };
    }

    // exit 而不是 close：更新器子进程可能还攥着管道
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      // 给它 150ms 把截图文件落盘，再判
      setTimeout(() => finish(judge(code, signal)), 150);
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
    // 图按固定 token 估，不按 base64 字数。上限只挡异常的大图，正常一屏要过得去
    if (buf.length > MAX_PREVIEW_BYTES) return { error: `截图 ${Math.round(buf.length / 1024)}KB，太大（上限 ${Math.round(MAX_PREVIEW_BYTES / 1_000_000)}MB）；把 width / height 调小再试` };
    return { mediaType: 'image/png', base64: buf.toString('base64'), bytes: buf.length, width: w, height: h };
  } finally {
    await site.close().catch(() => {});
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
}
