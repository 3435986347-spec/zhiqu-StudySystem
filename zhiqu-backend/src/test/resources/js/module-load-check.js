// 壳加载模块（loadModule，第三十一轮）—— 直接跑 assets/zhiqu-api.js 里发布的那份实现，用真的 import()。
//
//   用法：node src/test/resources/js/module-load-check.js <zhiqu-api.js 的路径>
//   打印 ALL-GREEN 且退出码 0 = 全绿。由 PageModulesTest 调用。
//
// 判的是三件真浏览器里不好演的事：模块地址带上壳自己的 ?v=、加载不上时抛的是写给用户看的话（不是「Failed to fetch dynamically
// imported module: http://…」）、失败的不缓存（网恢复了下一次能加载上）。
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const shellPath = path.resolve(process.argv[2]);
const src = fs.readFileSync(shellPath, 'utf8');
function slice(startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error('抠不到起点: ' + startMark);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error('抠不到终点: ' + endMark);
  return src.slice(a, b);
}
const code = slice('  function requestError(message, extra) {', '  function waitMs(') + slice('  var loadedModules = {};', '  function loadSettingsModule()');

(async () => {
  let fail = 0;
  function judge(name, cond, detail) {
    if (cond) console.log('  PASS  ' + name);
    else { console.log('  FAIL  ' + name + (detail !== undefined ? '  →  ' + detail : '')); fail++; }
  }
  const make = (staticDir, query) => new Function('SELF_SRC', 'location', 'console', code + '\nreturn { loadModule: loadModule, loadedModules: loadedModules };')(
    pathToFileURL(path.join(staticDir, 'assets', 'zhiqu-api.js')).href + query,
    { href: pathToFileURL(path.join(staticDir, 'index.html')).href },
    { error: () => {} });

  // 真的模块：加载得上，同一个只加载一次
  const realStatic = path.dirname(path.dirname(shellPath));
  const real = make(realStatic, '?v=check');
  const m1 = await real.loadModule('settings.js');
  judge('加载得上真的模块（settings.js）', typeof m1.parseZqHash === 'function', Object.keys(m1).join(','));
  judge('同一个只加载一次', real.loadModule('settings.js') === real.loadModule('settings.js'));

  // 地址带上壳自己的 ?v=：换一个查询串，node 会当成另一个模块实例 —— 用这一点看出查询串真的带上了
  const other = make(realStatic, '?v=other');
  const m2 = await other.loadModule('settings.js');
  judge('模块地址带上了壳的 ?v=（换了令牌就是另一份模块）', m1 !== m2);

  // 加载不上：说人话、带 userFacing、不缓存
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zq-modload-'));
  fs.mkdirSync(path.join(tmp, 'assets', 'pages'), { recursive: true });
  const broken = make(tmp, '?v=t');
  let err = null;
  try { await broken.loadModule('pages/admin.js'); } catch (e) { err = e; }
  judge('加载不上时抛错', !!err);
  judge('抛的是写给用户看的话', err && err.userFacing === true && /没加载上/.test(err.message) && !/Failed to fetch|Cannot find module|ERR_/.test(err.message), err && err.message);
  judge('失败的不缓存', !('pages/admin.js' in broken.loadedModules), Object.keys(broken.loadedModules).join(','));
  // 「网恢复了」：文件出现之后同一个 loadModule 能加载上
  fs.writeFileSync(path.join(tmp, 'assets', 'pages', 'admin.js'), 'export const boots = { ok: true };\n');
  let again = null;
  try { again = await broken.loadModule('pages/admin.js'); } catch (e) { again = e; }
  judge('之后再试能加载上', again && again.boots && again.boots.ok === true, again && again.message);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('加载失败：' + e.stack); process.exit(1); });
