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
import zlib from 'node:zlib';
import { connectCdp } from './cdp.js';

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

// ── 页面情况的文字版（第一百六十八轮，docs/agent-efficiency-plan.md 第 3 步）──
// 原来 preview_page 只给一张图：报错、白屏只能靠模型看图猜；目标核对员只读文字，图看不到，
// 用户那段会话里模型为了给核对员凑「文字证据」专门写了回传报告的服务器和自检页。
// 现在静态服务给 html 注入一小段探针：收报错、未处理的 Promise 拒绝、console.error、标题、可见文字，
// 加载完回传到同一个服务。用同步请求是保险：截完图浏览器就退；异步的在本机 Chrome 上量过也送得到（第一百六十八轮扰动），慢页面上没量过。像素情况从截图本身算（WebGL 的画布页面里读不到）。
export const PROBE_PATH = '/__zhiqu_probe';
// 整段是一行（.replace 去掉换行）：插在 <head> 那一行里，页面报错的行号和磁盘上的文件对得上（第一百六十八轮真跑时 bad.html 第 2 行报成了第 12 行）
export const PROBE_SCRIPT = `<script data-zhiqu-probe>(function(){var R={errors:[],rejections:[],consoleErrors:[]};
function push(a,v){if(a.length<10)a.push(String(v).slice(0,300));}
function send(fin){try{R.final=fin;R.title=document.title;var b=document.body;R.text=b?(b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,300):'';
R.elements=document.getElementsByTagName('*').length;R.canvases=document.getElementsByTagName('canvas').length;
var x=new XMLHttpRequest();x.open('POST','${PROBE_PATH}',false);x.setRequestHeader('Content-Type','text/plain');x.send(JSON.stringify(R));}catch(e){}}
window.addEventListener('error',function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){push(R.errors,'资源加载失败：'+String(t.src||t.href).replace(location.origin,''));return;}
push(R.errors,String(e.message||e.error)+(e.filename?' ('+String(e.filename).replace(location.origin,'')+':'+e.lineno+')':''));},true);
window.addEventListener('unhandledrejection',function(e){var r=e.reason;push(R.rejections,r&&r.message?r.message:r);});
var ce=console.error;console.error=function(){try{push(R.consoleErrors,Array.prototype.map.call(arguments,String).join(' '));}catch(e){}return ce.apply(console,arguments);};
try{var gp=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t){var c=gp.apply(this,arguments);if(c&&/webgl/i.test(String(t))&&!c.__zhiqu){c.__zhiqu=1;var cs=c.compileShader.bind(c);c.compileShader=function(sh){cs(sh);try{if(!c.getShaderParameter(sh,c.COMPILE_STATUS))push(R.errors,'着色器编译失败：'+(c.getShaderInfoLog(sh)||''));}catch(e){}};var cl=c.linkProgram.bind(c);c.linkProgram=function(p){cl(p);try{if(!c.getProgramParameter(p,c.LINK_STATUS))push(R.errors,'着色器链接失败：'+(c.getProgramInfoLog(p)||''));}catch(e){}};}return c;};}catch(e){}
window.addEventListener('load',function(){setTimeout(function(){send(true);},1500);});
setTimeout(function(){send(false);},3000);})();</script>`.replace(/\n/g, '');

/** 把探针插进 html：放在 <head> 里最前面；没有 head 放在 doctype 之后（插到 doctype 前面会让页面掉进怪异模式） */
export function injectProbe(html) {
  const s = String(html);
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(s);
    if (m) return s.slice(0, m.index + m[0].length) + PROBE_SCRIPT + s.slice(m.index + m[0].length);
  }
  return PROBE_SCRIPT + s;
}

/**
 * 截图的像素情况：解 PNG（8 位 RGB / RGBA、不隔行；别的认不了返回 null），抽样数颜色。
 * 返回 { share: 最多的那种颜色占多少, color: '#rrggbb'（按 16 级量化）, luma: 平均亮度 0–255 }。
 */
export function analyzePng(buf) {
  try {
    if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    let off = 8; let w = 0; let h = 0; let depth = 0; let type = 0; let interlace = 0; const idat = [];
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off); const kind = buf.toString('latin1', off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
      else if (kind === 'IDAT') idat.push(data);
      else if (kind === 'IEND') break;
      off += 12 + len;
    }
    const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
    if (!w || !h || depth !== 8 || !bpp || interlace) return null;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * bpp;
    if (raw.length < h * (stride + 1)) return null;
    const cur = Buffer.alloc(stride); const prev = Buffer.alloc(stride);
    const counts = new Map(); let lumaSum = 0; let n = 0;
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40_000)));
    const gridN = 8;
    const gridSum = Array.from({ length: gridN }, () => Array(gridN).fill(0));
    const gridCount = Array.from({ length: gridN }, () => Array(gridN).fill(0));
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
        let v = line[i];
        if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        cur[i] = v & 255;
      }
      if (y % step === 0) {
        for (let x = 0; x < w; x += step) {
          const r = cur[x * bpp]; const g = cur[x * bpp + 1]; const bl = cur[x * bpp + 2];
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (bl >> 4);
          counts.set(key, (counts.get(key) || 0) + 1);
          lumaSum += 0.299 * r + 0.587 * g + 0.114 * bl; n++;
          const gy = Math.min(gridN - 1, Math.floor(y * gridN / h));
          const gx = Math.min(gridN - 1, Math.floor(x * gridN / w));
          gridSum[gy][gx] += 0.299 * r + 0.587 * g + 0.114 * bl;
          gridCount[gy][gx] += 1;
        }
      }
      cur.copy(prev);
    }
    let top = 0; let topKey = 0;
    for (const [k, v] of counts) if (v > top) { top = v; topKey = k; }
    const grid = gridSum.map((row, y) => row.map((sum, x) => (gridCount[y][x] ? Math.round(sum / gridCount[y][x] / 28.3) : 0)).join(''));
    const hex = (q) => (q * 17).toString(16).padStart(2, '0');
    return { share: n ? top / n : 0, color: `#${hex(topKey >> 8)}${hex((topKey >> 4) & 15)}${hex(topKey & 15)}`, luma: n ? Math.round(lumaSum / n) : 0, grid };
  } catch { return null; }
}

/** 一种颜色占到这么多算「几乎是单色」：3D 场景没画出来、白屏多半是这样 */
export const FLAT_SHARE = 0.97;

/** 给模型（和目标核对员）看的那几行 */
export function describePage(probe, pixels, { renderer = '' } = {}) {
  const lines = ['页面情况（页面里的探针回传 + 截图像素）：'];
  if (renderer) lines.push(`- 渲染：${renderer}`);
  if (!probe) {
    lines.push('- 没收到页面的回传：页面可能在加载完之前就卡住 / 出错，或者内联脚本被 CSP 挡了。报错情况不知道，只能看图。');
  } else {
    const list = (xs) => xs.map((x) => `「${x}」`).join('；');
    const errs = Array.isArray(probe.errors) ? probe.errors : [];
    const rej = Array.isArray(probe.rejections) ? probe.rejections : [];
    const ce = Array.isArray(probe.consoleErrors) ? probe.consoleErrors : [];
    lines.push(errs.length ? `- 报错 ${errs.length} 条${errs.length >= 10 ? '（只记前 10 条）' : ''}：${list(errs)}` : '- 报错：没有');
    if (rej.length) lines.push(`- 未处理的 Promise 拒绝 ${rej.length} 条：${list(rej)}`);
    if (ce.length) lines.push(`- console.error ${ce.length} 条：${list(ce)}`);
    const text = String(probe.text || '');
    lines.push(`- 标题「${String(probe.title || '').slice(0, 100)}」；可见文字${text ? `（开头）「${text.slice(0, 200)}」` : '：没有'}；元素 ${Number(probe.elements) || 0} 个，canvas ${Number(probe.canvases) || 0} 个`);
    if (!probe.final) lines.push('- 回传的是加载过程中的情况（页面没在时限里加载完）');
  }
  if (!pixels) lines.push('- 画面：截图的格式认不了，没算');
  else if (pixels.share >= FLAT_SHARE) lines.push(`- 画面：${Math.round(pixels.share * 100)}% 是同一种颜色 ${pixels.color}，几乎是单色 —— 可能是白屏 / 黑屏，或者 3D 场景没画出来`);
  else lines.push(`- 画面：有内容（占比最多的颜色 ${pixels.color} 占 ${Math.round(pixels.share * 100)}%，平均亮度 ${pixels.luma}/255）`);
  if (pixels && pixels.grid) lines.push(`- 亮度格（8×8，0 黑到 9 白，从左上到右下）：\n${pixels.grid.join('\n')}`);
  return lines.join('\n');
}

/**
 * 只读的静态服务，只监听 127.0.0.1。用来给浏览器取页面和它引用的 css / js / 图片。
 * probe：html 里注入探针，收它 POST 回来的报告（reports 里，最后一份在最后）；只认 PROBE_PATH、最多 64KB。
 */
export async function serveDir(root, { probe = false } = {}) {
  // 惰性加载：node:http 在 ESM 里会顺带把 tls 拉进来（reliability 那条判据盯着「加载 cli 不许加载 tls」）
  const http = (await import('node:http')).default;
  const realRoot = fs.realpathSync(root);
  const reports = [];
  const server = http.createServer((req, res) => {
    if (probe && req.method === 'POST' && req.url === PROBE_PATH) {
      let body = '';
      let over = false;
      req.on('data', (c) => { body += c; if (body.length > 65_536) { over = true; req.destroy(); } });
      req.on('end', () => {
        if (!over) { try { const r = JSON.parse(body); if (r && typeof r === 'object') reports.push(r); } catch { /* 坏的不收 */ } }
        res.writeHead(204); res.end();
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch { res.writeHead(400); res.end(); return; }
    const target = path.resolve(realRoot, '.' + rel);
    if (!inside(realRoot, target)) { res.writeHead(403); res.end(); return; }
    fs.stat(target, (err, st) => {
      const file = !err && st.isDirectory() ? path.join(target, 'index.html') : target;
      fs.readFile(file, (e, buf) => {
        if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('找不到这个文件'); return; }
        const isHtml = /\.html?$/i.test(file);
        const out = probe && isHtml ? Buffer.from(injectProbe(buf.toString('utf8')), 'utf8') : buf;
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : out);
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      reports,
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

/** 无头 Chrome 的参数。port 给了才开调试端口（常驻会话）。一次截一张的那条不带虚拟时间。 */
export function chromeArgs({ profile, crashes, width, height, gl = 'swiftshader', port = null, screenshot = '', url = '' } = {}) {
  const args = [
    '--headless=new',
    // 不要 --disable-gpu：它会把 GPU 进程整个关掉，headless 里就等于没有 WebGL。
    // 软件渲染必须显式 --enable-unsafe-swiftshader（Chrome 129 起默认不给）。
    '--enable-unsafe-swiftshader', '--use-gl=angle', `--use-angle=${gl}`,
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    // HOME 换成临时目录后，Chrome 会去找钥匙串。用内存里的假钥匙串，不弹系统对话框。
    '--use-mock-keychain', '--password-store=basic',
    '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update',
    '--disable-breakpad', '--disable-crash-reporter', `--crash-dumps-dir=${crashes}`, '--disable-background-mode', '--no-pings',
    '--disable-logging', '--log-level=3',
    '--run-all-compositor-stages-before-draw',
    `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
  ];
  if (port != null) args.push(`--remote-debugging-port=${port}`, '--remote-allow-origins=*');
  if (screenshot) args.push(`--screenshot=${screenshot}`);
  if (url) args.push(url);
  return args;
}

/**
 * 跑一次无头 Chrome 截图。返回 { ok } 或 { error }。
 * WebKit 助手仍是这一次一开一关。Chrome 的常驻会话不走这里。
 *
 * 两个坑（用户 2026-11-12 报「浏览器退出码 null」）：
 * Chrome 会拉起更新器 / 崩溃上报这类子进程，它们继承着我们的 stderr 管道。只看 close
 * 的话，主进程早退出了、管道还开着，事件永远不来 —— 只能等超时把它杀掉，于是 code 是 null。
 * 所以认 exit（主进程一退就到），并立刻把管道拆掉。超时被杀要照实说「渲染超时」。
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
      : chromeArgs({ profile, crashes, width, height, gl: process.env.ZHIQU_PREVIEW_GL || 'swiftshader', screenshot: out, url });
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

/** 进上下文的图多大算「不用压」。 */
export const CONTEXT_IMAGE_BYTES = 400_000;
/** 压不了（没有转换工具）时，原图不超过这么大照样给；再大就让模型把窗口调小。 */
export const UNSHRUNK_MAX_BYTES = 1_500_000;
const SHRINK_STEPS = [[1280, 80], [1280, 60], [1024, 55], [800, 50]];

/** 用系统自带的工具把图缩小、转成 JPEG：macOS 是 sips，别处找 ImageMagick。没有就返回 null。 */
export function shrinkImage(input, output, edge, quality, { platform = process.platform, run = spawnSync } = {}) {
  const tries = platform === 'darwin'
    ? [['/usr/bin/sips', ['-Z', String(edge), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), input, '--out', output]]]
    : [['magick', [input, '-resize', `${edge}x${edge}>`, '-quality', String(quality), output]],
      ['convert', [input, '-resize', `${edge}x${edge}>`, '-quality', String(quality), output]]];
  for (const [bin, args] of tries) {
    try {
      const r = run(bin, args, { stdio: 'ignore', timeout: 30_000 });
      if (r && r.status === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) return output;
    } catch { /* 下一个 */ }
  }
  return null;
}

/**
 * 截出来的图进上下文之前压小（第一百三十七轮，用户 2026-11-15 定的：压成 JPEG）。
 * 截图上限放宽到 8MB 以后，一张 6.8MB 的 PNG 每次请求都要整张再传一遍；模型看排版、看明暗用不着这么大。
 * 小图原样给；大图缩到长边 1280、转 JPEG，还大就再降一档；这台机器压不了的，1.5MB 以内原样给，再大照实说。
 * 返回 { mediaType, base64, bytes, width, height, originalBytes } 或 { error }。
 */
export function forContext(shot, { shrink = shrinkImage, maxBytes = CONTEXT_IMAGE_BYTES } = {}) {
  if (!shot || shot.error || shot.bytes <= maxBytes) return shot;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-shrink-'));
  try {
    const input = path.join(work, 'in.png');
    fs.writeFileSync(input, Buffer.from(shot.base64, 'base64'));
    let best = null;
    for (const [edge, quality] of SHRINK_STEPS) {
      const out = shrink(input, path.join(work, `out-${edge}-${quality}.jpg`), edge, quality);
      if (!out) break;
      best = fs.readFileSync(out);
      if (best.length <= maxBytes) break;
    }
    if (best && best.length < shot.bytes) {
      return { ...shot, mediaType: 'image/jpeg', base64: best.toString('base64'), bytes: best.length, originalBytes: shot.bytes };
    }
    if (shot.bytes <= UNSHRUNK_MAX_BYTES) return shot;
    return { error: `截图 ${Math.round(shot.bytes / 1024)}KB，这台机器上没有能把它压小的工具（macOS 的 sips 或 ImageMagick）；把 width / height 调小再试` };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 留着也没关系 */ }
  }
}

const NAMED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']);

/** 先试这台机器的 GPU，失败再退回 SwiftShader。用户用 ZHIQU_PREVIEW_GL 指定时只试那一个。 */
export function glCandidates({ env = process.env, platform = process.platform } = {}) {
  if (env.ZHIQU_PREVIEW_GL) return [String(env.ZHIQU_PREVIEW_GL)];
  return [platform === 'linux' ? 'gl' : 'metal', 'swiftshader'];
}

export function rendererLabel(gl) {
  return gl === 'swiftshader' ? '软件渲染（SwiftShader），不是这台机器的 GPU' : `硬件渲染（${gl}）`;
}

/** 连续几张亮度格的平均差（0–9）。不到两张就没有帧差。 */
export function meanGridDelta(grids) {
  const rows = (grids || []).filter((g) => Array.isArray(g) && g.length === 8 && g.every((r) => /^[0-9]{8}$/.test(r)));
  if (rows.length < 2) return null;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        sum += Math.abs(Number(rows[i][y][x]) - Number(rows[i - 1][y][x]));
        n += 1;
      }
    }
  }
  return n ? Math.round((sum / n) * 100) / 100 : null;
}

/** lsof 的 LISTEN 行里取出端口。 */
export function parseListenPorts(text) {
  const ports = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('LISTEN')) continue;
    const m = /:(\d+)\s+\(LISTEN\)/.exec(line);
    if (m) ports.push(Number(m[1]));
  }
  return [...new Set(ports)];
}

/** 命令文本里写明要听的端口。不把 curl 的地址算进去。 */
export function commandPorts(command) {
  const ports = [];
  const s = String(command || '');
  for (const m of s.matchAll(/--port(?:=|\s+)(\d{2,5})\b/g)) ports.push(Number(m[1]));
  for (const m of s.matchAll(/\bhttp\.server\s+(\d{2,5})\b/g)) ports.push(Number(m[1]));
  return [...new Set(ports)];
}

/** 这一轮后台任务正在听的端口。lsofTextForPid 拿不到就只认命令里写明的。 */
export function portsFromJobs(jobs, lsofTextForPid = () => '') {
  const ports = new Set();
  for (const job of jobs || []) {
    for (const p of commandPorts(job.command)) ports.add(p);
    const text = job.child && job.child.pid ? lsofTextForPid(job.child.pid) : '';
    for (const p of parseListenPorts(text)) ports.add(p);
  }
  return ports;
}

/**
 * 是网址就只认 127.0.0.1 / localhost，而且端口必须是这一轮后台命令拉起的。
 * 不是网址返回 null，调用方按工作区里的 html 处理。
 */
export function previewAddress(input, ports) {
  const text = String(input || '').trim();
  if (!/^https?:\/\//i.test(text)) return null;
  let url;
  try { url = new URL(text); } catch { return { error: '这个地址不是合法的 URL' }; }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') {
    return { error: '只能预览工作区里的 html，或这一轮后台命令拉起的 127.0.0.1 / localhost。不打开别的网址。' };
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const allowed = ports instanceof Set ? ports : new Set(ports || []);
  if (!allowed.has(port)) return { error: `端口 ${port} 不是这一轮后台命令拉起的，不能打开。` };
  return { url: url.href };
}

export function normalizeActions(actions) {
  if (actions == null) return [];
  if (!Array.isArray(actions)) return { error: 'actions 要是数组' };
  if (actions.length > 8) return { error: '一次最多 8 个动作' };
  const out = [];
  const coord = (n) => Number.isFinite(n) && n >= 0 && n <= 2000;
  for (const a of actions) {
    if (!a || typeof a !== 'object') return { error: '动作要是对象' };
    if (a.type === 'wait') {
      const ms = Number(a.ms);
      if (!Number.isFinite(ms) || ms < 0 || ms > 5000) return { error: '等待要在 0 到 5000 毫秒' };
      out.push({ type: 'wait', ms });
    } else if (a.type === 'click') {
      const x = Number(a.x); const y = Number(a.y);
      if (!coord(x) || !coord(y)) return { error: '点击坐标要在 0 到 2000' };
      out.push({ type: 'click', x, y });
    } else if (a.type === 'drag') {
      const x = Number(a.x); const y = Number(a.y); const x2 = Number(a.x2); const y2 = Number(a.y2);
      if (![x, y, x2, y2].every(coord)) return { error: '拖动坐标要在 0 到 2000' };
      out.push({ type: 'drag', x, y, x2, y2 });
    } else if (a.type === 'key') {
      const key = String(a.text || '');
      if (!key || key.length > 32) return { error: '按键最多 32 个字符' };
      out.push({ type: 'key', text: key });
    } else return { error: `不认识的动作 ${a.type}` };
  }
  return out;
}

async function readDebugPort(profile, timeoutMs) {
  const file = path.join(profile, 'DevToolsActivePort');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const port = Number(String(fs.readFileSync(file, 'utf8')).split('\n')[0]);
      if (port) return port;
    } catch { /* 还没写出来 */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('浏览器没有打开调试端口');
}

async function fetchJson(url) {
  const http = (await import('node:http')).default;
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

/**
 * 这一轮留一个 Chrome。WebKit 不走这里。
 * startBrowser / connect / fetchJson / sleep 可以换掉，测试不必真开浏览器。
 */
export class PreviewSession {
  constructor({ chrome, root, startBrowser, connect = connectCdp, fetchJson: fetchImpl = fetchJson, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), glOrder } = {}) {
    this.chrome = chrome;
    this.root = root;
    this.startBrowser = startBrowser || null;
    this.connect = connect;
    this.fetchJson = fetchImpl;
    this.sleep = sleep;
    this.glOrder = glOrder || glCandidates();
    this.child = null;
    this.cdp = null;
    this.site = null;
    this.profile = null;
    this.renderer = '';
    this.gl = null;
    this.opened = false;
  }

  async ensure(width, height) {
    if (this.cdp) return;
    let last = null;
    for (const gl of this.glOrder) {
      try {
        await this.launch(gl, width, height);
        const ok = await this.webglOk();
        if (ok || gl === 'swiftshader' || this.glOrder.length === 1) {
          this.gl = gl;
          this.renderer = rendererLabel(gl);
          return;
        }
        await this.killBrowser();
      } catch (e) {
        last = e;
        await this.killBrowser();
      }
    }
    throw last || new Error('浏览器起不来');
  }

  async launch(gl, width, height) {
    if (this.startBrowser) {
      const started = await this.startBrowser(gl, { width, height });
      this.child = { kill: () => started.kill && started.kill() };
      this.cdp = await this.connect(started.ws);
      return;
    }
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-preview-browser-'));
    const crashes = path.join(this.profile, 'crashes');
    fs.mkdirSync(crashes, { recursive: true });
    const args = chromeArgs({ profile: this.profile, crashes, width, height, gl, port: 0 });
    const child = spawn(this.chrome, args, {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: this.profile, TMPDIR: this.profile, XDG_CONFIG_HOME: this.profile, XDG_CACHE_HOME: this.profile },
    });
    child.unref();
    if (child.stderr) child.stderr.unref();
    this.child = child;
    const port = await readDebugPort(this.profile, 8000);
    const createdRaw = await this.fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`);
    const created = Array.isArray(createdRaw) ? createdRaw[0] : createdRaw;
    if (!created || !created.webSocketDebuggerUrl) throw new Error('浏览器没有给出调试连接');
    this.cdp = await this.connect(created.webSocketDebuggerUrl);
    await this.cdp.call('Page.enable');
    await this.cdp.call('Runtime.enable');
  }

  async webglOk() {
    const r = await this.cdp.call('Runtime.evaluate', {
      expression: "(() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl') || c.getContext('webgl2')); } catch (e) { return false; } })()",
      returnByValue: true,
    });
    return Boolean(r && r.result && r.result.value);
  }

  async killBrowser() {
    if (this.cdp) { try { this.cdp.close(); } catch { /* 已经断了 */ } this.cdp = null; }
    if (this.child) {
      try {
        if (this.child.pid && process.platform !== 'win32') process.kill(-this.child.pid, 'SIGKILL');
      } catch { /* 进程组不在了 */ }
      try { if (typeof this.child.kill === 'function') this.child.kill('SIGKILL'); } catch { /* 同上 */ }
      this.child = null;
    }
    if (this.profile) { try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch { /* 留着也没关系 */ } this.profile = null; }
    this.opened = false;
  }

  async pageUrl(rel) {
    const realRoot = fs.realpathSync(this.root);
    const file = path.resolve(realRoot, rel || '.');
    if (!inside(realRoot, file)) return { error: '只能预览工作区里的文件' };
    const page = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file;
    if (!fs.existsSync(page)) return { error: `找不到要预览的文件：${rel}` };
    if (!/\.html?$/i.test(page)) return { error: '只支持预览 .html 文件（目录的话里面要有 index.html）' };
    if (!this.site) this.site = await serveDir(realRoot, { probe: true });
    const relUrl = path.relative(realRoot, page).split(path.sep).map(encodeURIComponent).join('/');
    return { url: `http://127.0.0.1:${this.site.port}/${relUrl}`, reports: this.site.reports };
  }

  async act(actions) {
    for (const a of actions) {
      if (a.type === 'wait') await this.sleep(a.ms);
      else if (a.type === 'click') {
        await this.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
        await this.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button: 'left', clickCount: 1 });
      } else if (a.type === 'drag') {
        await this.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
        await this.cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x2, y: a.y2, button: 'left' });
        await this.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x2, y: a.y2, button: 'left', clickCount: 1 });
      } else if (a.type === 'key') {
        const keys = NAMED_KEYS.has(a.text) ? [a.text === 'Space' ? ' ' : a.text] : [...a.text];
        for (const text of keys) {
          const named = NAMED_KEYS.has(a.text) && text !== ' ';
          await this.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', text, key: named ? a.text : text });
          await this.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: named ? a.text : text });
        }
      }
    }
  }

  async show({ path: rel, url, actions = [], frames = 1, width = 1200, height = 900, timeoutMs = 15_000 }) {
    const w = Math.min(2000, Math.max(320, Number(width) || 1200));
    const h = Math.min(2000, Math.max(240, Number(height) || 900));
    await this.ensure(w, h);
    let target = url;
    let reports = null;
    if (!target) {
      const page = await this.pageUrl(rel);
      if (page.error) return page;
      target = page.url;
      reports = page.reports;
    }
    const loaded = this.cdp.once('Page.loadEventFired', Math.min(timeoutMs, 15_000));
    await this.cdp.call('Page.navigate', { url: target });
    await loaded;
    this.opened = true;
    await this.act(actions);
    if (reports) {
      const start = Date.now();
      while (reports.length === 0 && Date.now() - start < 1600) await this.sleep(50);
    }
    const n = Math.min(4, Math.max(1, Number(frames) || 1));
    const pngs = [];
    for (let i = 0; i < n; i++) {
      if (i) await this.sleep(200);
      const shot = await this.cdp.call('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(String(shot.data || ''), 'base64');
      if (!buf.length) return { error: '截图是空的' };
      pngs.push(buf);
    }
    const last = pngs[pngs.length - 1];
    if (last.length > MAX_PREVIEW_BYTES) return { error: `截图 ${Math.round(last.length / 1024)}KB，太大（上限 ${Math.round(MAX_PREVIEW_BYTES / 1_000_000)}MB）；把 width / height 调小再试` };
    const grids = pngs.map((buf) => analyzePng(buf)).map((p) => p && p.grid);
    const delta = meanGridDelta(grids);
    const probeReport = reports ? ([...reports].reverse().find((r) => r.final) || reports[reports.length - 1] || null) : null;
    const pixels = analyzePng(last);
    const page = describePage(probeReport, pixels, { renderer: this.renderer });
    const motion = delta == null ? '' : `\n帧差 ${delta}（${n} 张，间隔 200ms，真实时间）。图只附最后一张。`;
    return {
      mediaType: 'image/png', base64: last.toString('base64'), bytes: last.length, width: w, height: h,
      page: `${page}${motion}`, delta, frames: n, renderer: this.renderer,
    };
  }

  async close() {
    await this.killBrowser();
    if (this.site) { await this.site.close().catch(() => {}); this.site = null; }
  }
}

/**
 * 截一张页面。rel 相对工作区，可以是 .html 文件，也可以是带 index.html 的目录。
 * 返回 { mediaType, base64, bytes, width, height } 或 { error }。
 * 系统 WebKit 走这一次一开一关。Chrome 的预览由 PreviewSession 留到回合结束。
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
  const site = await serveDir(realRoot, { probe: true });
  try {
    const relUrl = path.relative(realRoot, page).split(path.sep).map(encodeURIComponent).join('/');
    const shot = await shoot({ chrome, url: `http://127.0.0.1:${site.port}/${relUrl}`, out, width: w, height: h, timeoutMs });
    if (shot.error) return { error: shot.error };
    const buf = fs.readFileSync(out);
    if (!buf.length) return { error: '截图是空的' };
    // 图按固定 token 估，不按 base64 字数。上限只挡异常的大图，正常一屏要过得去
    if (buf.length > MAX_PREVIEW_BYTES) return { error: `截图 ${Math.round(buf.length / 1024)}KB，太大（上限 ${Math.round(MAX_PREVIEW_BYTES / 1_000_000)}MB）；把 width / height 调小再试` };
    // 最后一份完整的（加载完那份）优先；没有就用加载中的那份
    const reports = site.reports;
    const probeReport = [...reports].reverse().find((r) => r.final) || reports[reports.length - 1] || null;
    const gl = process.env.ZHIQU_PREVIEW_GL || 'swiftshader';
    const renderer = gl === 'swiftshader' ? '软件渲染（SwiftShader），不是这台机器的 GPU' : `硬件渲染（${gl}）`;
    return { mediaType: 'image/png', base64: buf.toString('base64'), bytes: buf.length, width: w, height: h,
      page: describePage(probeReport, analyzePng(buf), { renderer }) };
  } finally {
    await site.close().catch(() => {});
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
}
