// 页面模块表（第三十一轮，方案第 4 步）—— 直接 import 发布的模块，核对壳的 PAGE_MODULES 里每一项都真的接得上。
//
//   用法：node src/test/resources/js/page-modules-check.js <assets 目录> <页面=模块> [<页面=模块> …]
//   「页面=模块」由 PageModulesTest 从 zhiqu-api.js 的 PAGE_MODULES 里解析出来交给这里 —— 判的是「壳说去哪个文件找」和
//   「那个文件真的给了」这一对。少一个、拼错一个，页面就是一片空白、一个字都不报（壳只会调 undefined）。
//   打印 ALL-GREEN 且退出码 0 = 全绿。
const path = require('path');
const { pathToFileURL } = require('url');
const assets = process.argv[2];
const pairs = process.argv.slice(3);
if (!pairs.length) throw new Error('没给「页面=模块」—— PAGE_MODULES 扫空了？');

(async () => {
  let fail = 0;
  function judge(name, cond, detail) {
    if (cond) console.log('  PASS  ' + name);
    else { console.log('  FAIL  ' + name + (detail !== undefined ? '  →  ' + detail : '')); fail++; }
  }
  for (const pair of pairs) {
    const [page, rel] = pair.split('=');
    let mod = null;
    try {
      mod = await import(pathToFileURL(path.resolve(assets, rel)).href);
    } catch (e) {
      judge(page + ' → ' + rel + ' 加载得了', false, e.message);
      continue;
    }
    judge(page + ' → ' + rel + ' 导出 boots', mod && typeof mod.boots === 'object' && mod.boots !== null, Object.keys(mod || {}).join(','));
    judge(page + ' → boots[\'' + page + '\'] 是个函数', mod && mod.boots && typeof mod.boots[page] === 'function',
      mod && mod.boots ? Object.keys(mod.boots).join(',') : '没有 boots');
  }
  console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('加载失败：' + e.stack); process.exit(1); });
