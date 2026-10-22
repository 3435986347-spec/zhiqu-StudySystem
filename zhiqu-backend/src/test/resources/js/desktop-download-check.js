// 下载桌面版（第八十二轮）—— 直接跑 assets/zhiqu-api.js 里发布的那一段：认这台电脑、画弹窗、连点只开一个。
//   用法：node src/test/resources/js/desktop-download-check.js <zhiqu-api.js 的路径> <真实的列表回包 JSON>；打印 ALL-GREEN 且退出码 0 = 全绿。
//   第二个参数是 Java 侧拿真的 DesktopDownloads 对一个临时目录列出来的 data（不是脚本里写死一份「后端大概会回这样」——
//   第六十九轮 Wiki 健康检查的替身返回后端从来没有的字段，判据和实现一起错、一起绿了许多轮）。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const listing = JSON.parse(process.argv[3] || 'null');
if (!listing || !listing.macos) throw new Error('缺第二个参数：真实的列表回包（要有 macos 那一项）');
const a = src.indexOf('  // ── 下载桌面版（第八十二轮）');
const b = src.indexOf('  // ── 下载桌面版到此', a);
if (a < 0 || b < 0) throw new Error('抠不到下载桌面版那一段');
const section = src.slice(a, b);

function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function icon(name) { return '<svg data-i="' + name + '"></svg>'; }
const modals = [];
let pending = [];
function openModal(opts) {
  let focused = false;
  const body = { innerHTML: opts.bodyHtml || '', querySelector: () => ({ onclick: null }) };
  const h = {
    opts, body, closed: false,
    mask: { querySelector: (sel) => (sel === '.zq-modal-close' ? { focus() { focused = true; } } : null) },
    focused: () => focused,
    close() { if (h.closed) return; h.closed = true; if (opts.onClose) opts.onClose(); }
  };
  modals.push(h);
  return h;
}
const api = { get(path) { return new Promise((resolve, reject) => pending.push({ path, resolve, reject })); } };
let nav = {};
const window = { get navigator() { return nav; } };
const mod = new Function('esc', 'icon', 'openModal', 'api', 'API', 'window', section +
  '\nreturn { desktopOsOf, desktopArchOf, desktopDownloadHtml, openDesktopDownload };')(esc, icon, openModal, api, '/api', window);

let fail = 0, pass = 0;
function judge(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + '  →  ' + g + '（应为 ' + w + '）'); fail++; }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  // ── 认这台电脑 ──
  const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
  judge('Mac 上的 Chrome（userAgentData 说 macOS）', mod.desktopOsOf({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel', userAgent: MAC_SAFARI, maxTouchPoints: 0 }), 'macos');
  judge('Mac 上的 Safari（没有 userAgentData，MacIntel —— Apple 芯片的 Mac 也这么说）', mod.desktopOsOf({ platform: 'MacIntel', userAgent: MAC_SAFARI, maxTouchPoints: 0 }), 'macos');
  judge('iPad 的 Safari 自称 MacIntel，靠触点数分出来：不是 Mac', mod.desktopOsOf({ platform: 'MacIntel', userAgent: MAC_SAFARI, maxTouchPoints: 5 }), 'other');
  judge('Windows 上的 Chrome', mod.desktopOsOf({ userAgentData: { platform: 'Windows' }, platform: 'Win32', userAgent: WIN_CHROME }), 'windows');
  judge('Windows 上的 Firefox（没有 userAgentData）', mod.desktopOsOf({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0' }), 'windows');
  judge('iPhone（UA 里有 Mac OS X，但不是 Macintosh）', mod.desktopOsOf({ platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', maxTouchPoints: 5 }), 'other');
  judge('安卓', mod.desktopOsOf({ userAgentData: { platform: 'Android' }, platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/129.0 Mobile' }), 'other');
  judge('Linux 桌面', mod.desktopOsOf({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0' }), 'other');
  judge('什么都没有', mod.desktopOsOf(undefined), 'other');
  judge('平台字段说 Windows、UA 却是 Mac 的（改过 UA）：信平台字段', mod.desktopOsOf({ userAgentData: { platform: 'Windows' }, platform: 'Win32', userAgent: MAC_SAFARI }), 'windows');
  judge('平台字段都没有：退回看 UA', [mod.desktopOsOf({ userAgent: MAC_SAFARI }), mod.desktopOsOf({ userAgent: WIN_CHROME })], ['macos', 'windows']);

  const uad = (arch) => ({ platform: 'macOS', getHighEntropyValues: async (hints) => (hints.includes('architecture') ? { architecture: arch } : {}) });
  judge('Chromium 说 arm', await mod.desktopArchOf({ userAgentData: uad('arm') }), 'arm');
  judge('Chromium 说 x86', await mod.desktopArchOf({ userAgentData: uad('x86') }), 'x86');
  judge('说了别的（空串）算不知道', await mod.desktopArchOf({ userAgentData: uad('') }), null);
  judge('getHighEntropyValues 抛错算不知道', await mod.desktopArchOf({ userAgentData: { getHighEntropyValues: async () => { throw new Error('denied'); } } }), null);
  judge('Safari / Firefox 没有 userAgentData：不知道', await mod.desktopArchOf({ platform: 'MacIntel' }), null);

  // ── 画弹窗（拿真实的列表回包） ──
  const sections = (html) => [...html.matchAll(/<section class="zq-dl-item" data-platform="(\w+)"( data-mine="true")?>([\s\S]*?)<\/section>/g)]
    .map((m) => ({ key: m[1], mine: !!m[2], html: m[3] }));
  const mac = listing.macos;
  let html = mod.desktopDownloadHtml(listing, 'macos', 'arm');
  let s = sections(html);
  judge('Mac 上：两项，macOS 在前、标成你的电脑', s.map((x) => x.key + (x.mine ? '*' : '')), ['macos*', 'windows']);
  judge('Mac 那项是一个普通的下载链接（交给浏览器下，不经 fetch）', s[0].html.includes('<a class="zq-btn" href="/api/desktop/downloads/macos" download>'), true);
  judge('按钮说下载什么', s[0].html.includes('下载 .' + mac.fileName.split('.').pop().toLowerCase() + '</a>'), true);
  judge('写出版本和大小', s[0].html.includes('版本 <span class="zq-num">' + mac.version + '</span>') && /<span class="zq-num">[\d.]+ MB<\/span>/.test(s[0].html), true);
  judge('写出要什么芯片、什么系统', s[0].html.includes('Apple 芯片') && s[0].html.includes('macOS 13'), true);
  judge('写出第一次打开会被拦、怎么放行', s[0].html.includes('仍要打开') && s[0].html.includes('xattr -dr com.apple.quarantine'), true);
  judge('校验值照实给', s[0].html.includes('<code>' + mac.sha256 + '</code>'), true);
  judge('Apple 芯片的 Mac 不提醒', html.includes('zq-dl-warn'), false);
  judge('Windows 没有安装包：照实说、不给按钮', s[1].html.includes('还在准备') && !s[1].html.includes('href='), listing.windows == null);
  judge('写清要连数据库', html.includes('MySQL') && html.includes('.zhiqu/application.yml'), true);

  html = mod.desktopDownloadHtml(listing, 'macos', 'x86');
  judge('认出是 Intel 的 Mac：直说装不上（按钮照给）', html.includes('zq-dl-warn') && html.includes('Intel') && html.includes('href="/api/desktop/downloads/macos"'), true);
  html = mod.desktopDownloadHtml(listing, 'windows', 'x86');
  s = sections(html);
  judge('Windows 上：Windows 在前、标成你的电脑', s.map((x) => x.key + (x.mine ? '*' : '')), ['windows*', 'macos']);
  judge('Windows 上 Mac 那项是次要按钮、不提醒 Intel', s[1].html.includes('<a class="zq-btn-ghost" href="/api/desktop/downloads/macos" download>') && !html.includes('zq-dl-warn'), true);
  html = mod.desktopDownloadHtml(listing, 'other', null);
  s = sections(html);
  judge('手机 / Linux：说桌面版只有这两种、谁也不标', html.includes('只有这两种') && s.every((x) => !x.mine), true);

  const win = { platform: 'windows', fileName: '知趣象限-1.0.0.exe', size: 98765432, version: '1.0.0', sha256: 'ab'.repeat(32), url: '/api/desktop/downloads/windows' };
  s = sections(mod.desktopDownloadHtml(Object.assign({}, listing, { windows: win }), 'windows', 'x86'));
  judge('Windows 放上来以后：给按钮和 SmartScreen 的放行', s[0].html.includes('href="/api/desktop/downloads/windows" download>') && s[0].html.includes('下载 .exe') && s[0].html.includes('仍要运行'), true);
  s = sections(mod.desktopDownloadHtml(Object.assign({}, listing, { windows: Object.assign({}, win, { fileName: '知趣象限-1.0.0.zip' }) }), 'windows', null));
  judge('免安装的 zip：说解压后双击', s[0].html.includes('解压') && s[0].html.includes('下载 .zip'), true);
  const evil = Object.assign({}, mac, { fileName: 'x.<img src=x onerror=alert(1)>', version: '<b>1.0.0</b>', sha256: '"><i>' });
  html = mod.desktopDownloadHtml({ macos: evil, windows: null }, 'macos', 'arm');
  judge('文件名、版本、校验值都转义', !html.includes('<img') && !html.includes('<b>') && !html.includes('"><i>'), true);

  // ── 连点只开一个；关掉之后迟到的回包不往已经关掉的弹窗里写 ──
  nav = { platform: 'MacIntel', userAgent: MAC_SAFARI, maxTouchPoints: 0 };
  const h1 = mod.openDesktopDownload();
  const h2 = mod.openDesktopDownload();
  judge('连点两下只开一个弹窗', modals.length === 1 && h1 === h2, true);
  judge('只问了一次列表', pending.length, 1);
  judge('问的是 /desktop/downloads', pending[0].path, '/desktop/downloads');
  judge('焦点放在关闭按钮上（不留在弹窗后面）', h1.focused(), true);
  pending[0].resolve(listing); pending = [];
  await tick(); await tick();
  judge('回来以后画出两项', sections(h1.body.innerHTML).map((x) => x.key), ['macos', 'windows']);
  h1.close();
  const h3 = mod.openDesktopDownload();
  judge('关掉之后再点：开一个新的', modals.length === 2 && h3 !== h1, true);
  h3.close();
  pending[0].resolve(listing); pending = [];
  await tick(); await tick();
  judge('关掉之后才回来的列表不往里写', h3.body.innerHTML.includes('zq-dl-item'), false);
  const h4 = mod.openDesktopDownload();
  pending[0].reject(Object.assign(new Error('网络连接失败，请检查网络后重试'), { userFacing: true })); pending = [];
  await tick(); await tick();
  judge('没取到：照实说、给「再试一次」', h4.body.innerHTML.includes('网络连接失败') && h4.body.innerHTML.includes('data-zq-dl-retry'), true);
  h4.close();

  console.log(fail === 0 && pass >= 30 ? '\nALL-GREEN（' + pass + ' 条）' : '\nRED: ' + fail + ' 条（过了 ' + pass + ' 条）');
  process.exit(fail === 0 && pass >= 30 ? 0 : 1);
})().catch((e) => { console.log('加载失败：' + e.stack); process.exit(1); });
