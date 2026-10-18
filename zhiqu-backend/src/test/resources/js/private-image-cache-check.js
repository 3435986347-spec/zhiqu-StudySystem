// 私有图片的字节留一份（第七十四轮 review）—— 直接跑 assets/zhiqu-api.js 里发布的 hydratePrivateMedia。
// 新编辑器（CodeMirror）把滚出可视区的图片拆掉，滚回来是一个新的 img；原来每次都重新下载一遍。
//   用法：node private-image-cache-check.js <zhiqu-api.js 的路径>，打印 ALL-GREEN 且退出码 0 = 全绿。由 WikiPrivateMediaTest 调用。
const fs = require('fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
function slice(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('抠不到 ' + from);
  return source.slice(a, b);
}
const code = slice('  var privateMedia = new Map();', '  function preserveEmbedViewport(')
  + slice('  function hydratePrivateMedia(', '  function renderMathIn(');

let auth = 'T1', objectUrls = 0;
const downloads = [];
const env = {
  API: '/api', state: {},
  token: () => auth,
  requestError: (m) => new Error(m),
  hydrateEmbedChildren: () => {}, openAttachmentPreview: () => {}, toast: () => {},
  CustomEvent: class { constructor(type) { this.type = type; } },
  URL: { createObjectURL: () => 'blob:' + (++objectUrls), revokeObjectURL: () => {} },
  api: { download: (path) => { downloads.push(path); const size = sizes[path] || 1000; return Promise.resolve({ blob: { type: 'image/png', size } }); } },
};
const sizes = {};
const mod = new Function(...Object.keys(env), code + '\nreturn { hydratePrivateMedia, revokePrivateMedia };')(...Object.values(env));

function image(id) {
  const el = { isConnected: true, dataset: {}, alt: '', src: '', onload: null,
    getAttribute: (k) => (k === 'data-zq-private-image' ? '/api/knowledge/images/' + id : k === 'src' ? el.src : null),
    removeAttribute: () => {}, dispatchEvent: () => {} };
  return el;
}
function root(...images) {
  return { dataset: { zqPrivateLinksWired: '1' }, querySelectorAll: (q) => (q === 'img[data-zq-private-image]' ? images : []), addEventListener: () => {} };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
async function show(id) { const el = image(id); mod.hydratePrivateMedia(root(el), true); await settle(); return el; }

let fail = 0, count = 0;
function judge(name, ok, detail) {
  count++;
  if (ok) console.log('PASS ' + name);
  else { console.log('FAIL ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}

(async () => {
  const first = await show(17);
  judge('第一次显示：下载一次、画上', downloads.length === 1 && /^blob:/.test(first.src), JSON.stringify({ downloads, src: first.src }));

  first.isConnected = false;             // 滚出可视区：CodeMirror 拆掉了这个 img
  const again = await show(17);
  judge('滚回来是一个新的 img：用留着的字节画，不再下载', downloads.length === 1 && /^blob:/.test(again.src) && again.src !== first.src,
    JSON.stringify({ downloads, src: again.src }));

  auth = 'T2';
  await show(17);
  judge('换了登录：不用上一个登录留下的字节', downloads.length === 2, JSON.stringify(downloads));

  mod.revokePrivateMedia();
  await show(17);
  judge('退出 / 换登录清掉之后重新下载', downloads.length === 3, JSON.stringify(downloads));

  downloads.length = 0;
  for (let i = 100; i < 160; i++) { sizes['/knowledge/images/' + i] = 1024 * 1024; await show(i); }
  downloads.length = 0;
  await show(159);
  judge('最近的还在', downloads.length === 0, JSON.stringify(downloads));
  await show(100);
  judge('留着的有上限（60 张 1 MiB 的之后，最早的那张已经丢了）', downloads.length === 1, JSON.stringify(downloads));

  sizes['/knowledge/images/900'] = 20 * 1024 * 1024;
  downloads.length = 0;
  await show(900); await show(900);
  judge('一张就占掉上限一大块的不留（不为它挤掉别的）', downloads.length === 2, JSON.stringify(downloads));

  if (count < 7) throw new Error('扫空了');
  if (fail) { console.log(fail + ' 条红'); process.exit(1); }
  console.log('ALL-GREEN');
})();
