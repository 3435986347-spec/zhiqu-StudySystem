// 知识 Wiki 标签页的行为判据 —— 直接跑 assets/zhiqu-api.js 里发布的那份实现。
//
//   用法：node src/test/resources/js/wiki-tabs-check.js <zhiqu-api.js 的路径>
//   退出码 0 = 全绿；非 0 = 有判据红了，逐条打印在上面。
//
// 由 WikiTabsTest 调用。手动跑也行。
//
// 为什么不在 Java 里重写一份状态机：重写就成了「测试一个副本」，副本绿了不代表线上
// 那份对，而且两边迟早分叉 —— 和 CodeHighlightEscapeTest 同一个理由。

const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

function slice(startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error('抠不到起点: ' + startMark);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error('抠不到终点: ' + endMark);
  return src.slice(a, b);
}

// 抠出整个标签页模块。里面 paintWikiTabs / openWikiQuickSwitch 要碰 DOM ——
// 下面的替身让 $ 返回 null，它们会在第一行就 return，不影响被测的状态逻辑。
const tabsSrc = slice('var WIKI_TABS_KEY =', '  function wireWikiTabShortcuts()');
// 扰动落地核对：抠出来的片段必须真的含这几个函数，否则下面全是空过
for (const fn of ['trackWikiNavigation', 'wikiHistoryGo', 'closeWikiTab', 'activateWikiTab', 'loadWikiTabs']) {
  if (!new RegExp('function ' + fn).test(tabsSrc)) throw new Error('抠出来的片段里没有 ' + fn);
}

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}

/** 造一套替身：state、页面列表、localStorage、以及被抠掉的 DOM 函数。 */
function harness(pages) {
  const store = {};
  const env = {
    state: { wikiTabs: [], wikiTabIdx: -1, wikiPages: pages.slice(), wikiCur: null },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    painted: [],
    store
  };
  // paintWikiDoc / paintWikiTabs / paintWikiTree / $ / empty 都被这段代码调用，
  // 但它们是绘制，不是被测的逻辑 —— 用记录型替身顶上。
  const prelude = `
    var state = __env.state, localStorage = __env.localStorage;
    // 这个替身必须和真实的 paintWikiDoc 一样，**第一行就调 trackWikiNavigation** ——
    // 第一版只记账不记历史，于是「切标签时忘了传 history:true」这种改动在替身里
    // 毫无后果，判据扰动后仍然绿。替身漏掉被测函数的调用，等于判据什么都没看。
    function paintWikiDoc(p, opts) {
      opts = opts || {};
      __env.painted.push({ id: p && String(p.id), opts: opts });
      trackWikiNavigation(p, opts);
      if (p) state.wikiCur = p;
    }
    function paintWikiTree() {}
    function $() { return null; }
    function $all() { return []; }
    function esc(x) { return String(x); }
    function empty() { return ''; }
    function openModal() { return { close: function () {} }; }
  `;
  const api = new Function('__env', prelude + tabsSrc +
    '\nreturn { trackWikiNavigation, wikiHistoryGo, closeWikiTab, activateWikiTab, loadWikiTabs, saveWikiTabs, activeWikiTab, wikiPageById };')(env);
  return { env, api };
}

const PAGES = [
  { id: 1, title: 'A' }, { id: 2, title: 'B' }, { id: 3, title: 'C' }, { id: 4, title: 'D' }
];
const page = (id) => PAGES.find((p) => p.id === id);

/** 模拟一次「打开某页」：和 paintWikiDoc 的第一行一样先记账。 */
function open(api, env, id, opts) {
  api.trackWikiNavigation(page(id), opts || {});
  env.state.wikiCur = page(id);
}

// ── 1. 第一次打开会自动建一个标签 ─────────────────────────────────────
{
  const { env, api } = harness(PAGES);
  open(api, env, 1);
  judge('第一次打开自动建标签',
    env.state.wikiTabs.length === 1 && env.state.wikiTabIdx === 0 && env.state.wikiTabs[0].id === '1',
    JSON.stringify(env.state.wikiTabs));
}

// ── 2. 同标签内跳转会压返回栈；新路径清空前进栈（浏览器行为）───────────
{
  const { env, api } = harness(PAGES);
  open(api, env, 1); open(api, env, 2); open(api, env, 3);
  const t = env.state.wikiTabs[0];
  judge('同标签跳转压返回栈', t.back.join(',') === '1,2' && t.id === '3', JSON.stringify(t));

  api.wikiHistoryGo(-1);                      // 回到 2
  judge('返回一步', env.state.wikiTabs[0].id === '2' && env.state.wikiTabs[0].fwd.join(',') === '3',
    JSON.stringify(env.state.wikiTabs[0]));

  open(api, env, 4);                          // 走了新路
  judge('走新路后前进栈清空', env.state.wikiTabs[0].fwd.length === 0,
    JSON.stringify(env.state.wikiTabs[0]));
}

// ── 3. history:true 不进历史（保存 / 取消编辑 / 切标签都走这条）─────────
{
  const { env, api } = harness(PAGES);
  open(api, env, 1); open(api, env, 2);
  const before = env.state.wikiTabs[0].back.slice();
  open(api, env, 2, { history: true });
  open(api, env, 3, { history: true });
  judge('history:true 不压栈',
    env.state.wikiTabs[0].back.join(',') === before.join(','),
    '前 ' + before + ' 后 ' + env.state.wikiTabs[0].back);
}

// ── 3b. 重复打开同一页不压历史 —— 这才是真正承重的那道护栏 ──────────────
//
// 扰动结果推翻了原先的想法：原本以为「保存后重绘、切标签」这些地方不压栈，
// 靠的是调用方传 history:true。实测把那个参数去掉，历史栈纹丝不动 ——
// 因为 trackWikiNavigation 里还有一个 `tab.id !== id`，同一页再打开一次本来就不记。
// 所以承重的是这个判断，history:true 只是把意图写明白。
{
  const { env, api } = harness(PAGES);
  open(api, env, 1); open(api, env, 2);
  const before = env.state.wikiTabs[0].back.slice();
  open(api, env, 2);          // 不带任何 opts，重复打开当前这一页
  open(api, env, 2);
  judge('重复打开同一页不压历史',
    env.state.wikiTabs[0].back.join(',') === before.join(','),
    '前 ' + before + ' 后 ' + env.state.wikiTabs[0].back);
}

// ── 4. newTab 开新标签，且新标签的历史是空的 ──────────────────────────
{
  const { env, api } = harness(PAGES);
  open(api, env, 1); open(api, env, 2);
  open(api, env, 3, { newTab: true });
  judge('newTab 建新标签',
    env.state.wikiTabs.length === 2 && env.state.wikiTabIdx === 1 && env.state.wikiTabs[1].id === '3',
    JSON.stringify(env.state.wikiTabs.map((t) => t.id)));
  judge('新标签历史独立为空',
    env.state.wikiTabs[1].back.length === 0 && env.state.wikiTabs[0].back.join(',') === '1',
    JSON.stringify(env.state.wikiTabs));
}

// ── 5. 关标签的索引换算（经典 off-by-one）─────────────────────────────
{
  // 关掉「当前标签左边」的那个，当前索引要往左收一格，否则会指到别人身上。
  //
  // 场景要挑得让「索引越界收尾」那个分支替补不了：当前标签必须**不是最后一个**。
  // 第一版用了 [1,2,3] 且 idx=2（最后一个），关掉 0 之后 idx 越界，
  // 越界分支顺手把它收回了正确位置 —— 扰动掉左收那一行，判据照样绿。
  const { env, api } = harness(PAGES);
  open(api, env, 1);
  open(api, env, 2, { newTab: true });
  open(api, env, 3, { newTab: true });
  open(api, env, 4, { newTab: true });       // [1,2,3,4]
  api.activateWikiTab(1);                    // 当前是 2，中间位置
  api.closeWikiTab(0);                       // 关掉它左边的 1
  judge('关掉左边的标签后仍停在原来那一页',
    env.state.wikiTabs.map((t) => t.id).join(',') === '2,3,4' &&
    env.state.wikiTabs[env.state.wikiTabIdx].id === '2',
    'idx=' + env.state.wikiTabIdx + ' tabs=' + JSON.stringify(env.state.wikiTabs.map((t) => t.id)));
}
{
  // 关掉最后一个（也是当前那个），索引要收到新的末尾而不是越界
  const { env, api } = harness(PAGES);
  open(api, env, 1);
  open(api, env, 2, { newTab: true });
  api.closeWikiTab(1);
  judge('关掉末尾的当前标签不越界',
    env.state.wikiTabIdx === 0 && env.state.wikiTabs.length === 1,
    'idx=' + env.state.wikiTabIdx);
}
{
  // 关掉右边的标签，当前索引不该动
  const { env, api } = harness(PAGES);
  open(api, env, 1);
  open(api, env, 2, { newTab: true });
  open(api, env, 3, { newTab: true });
  api.activateWikiTab(0);
  api.closeWikiTab(2);
  judge('关掉右边的标签当前索引不动', env.state.wikiTabIdx === 0 && env.state.wikiTabs.length === 2,
    'idx=' + env.state.wikiTabIdx);
}

// ── 6. 切标签不污染任何一个标签的历史 ─────────────────────────────────
{
  const { env, api } = harness(PAGES);
  open(api, env, 1); open(api, env, 2);       // 标签0：back=[1]
  open(api, env, 3, { newTab: true });        // 标签1：back=[]
  const snapshot = JSON.stringify(env.state.wikiTabs.map((t) => [t.id, t.back, t.fwd]));
  api.activateWikiTab(0);
  api.activateWikiTab(1);
  api.activateWikiTab(0);
  judge('切标签不改历史',
    JSON.stringify(env.state.wikiTabs.map((t) => [t.id, t.back, t.fwd])) === snapshot,
    '前 ' + snapshot + ' 后 ' + JSON.stringify(env.state.wikiTabs.map((t) => [t.id, t.back, t.fwd])));
}

// ── 7. 历史里那一页被删掉时，跳过它而不是卡住 ─────────────────────────
{
  const { env, api } = harness(PAGES);
  open(api, env, 1); open(api, env, 2); open(api, env, 3);   // back = [1,2]
  env.state.wikiPages = PAGES.filter((p) => p.id !== 2);     // 2 号页被删了
  api.wikiHistoryGo(-1);
  judge('返回时跳过已删除的页', env.state.wikiTabs[0].id === '1',
    '落在 ' + env.state.wikiTabs[0].id);
}

// ── 8. 恢复：坏数据、已删页、越界索引都要被挡住 ────────────────────────
{
  const { env, api } = harness(PAGES);
  open(api, env, 1);
  open(api, env, 2, { newTab: true });
  const saved = env.store['zq.wiki.tabs'];

  const fresh = harness(PAGES);
  fresh.env.store['zq.wiki.tabs'] = saved;
  judge('能恢复上次的标签', fresh.api.loadWikiTabs() &&
    fresh.env.state.wikiTabs.map((t) => t.id).join(',') === '1,2',
    JSON.stringify(fresh.env.state.wikiTabs.map((t) => t.id)));

  const gone = harness(PAGES.filter((p) => p.id !== 2));
  gone.env.store['zq.wiki.tabs'] = saved;
  gone.api.loadWikiTabs();
  judge('已删除的页不会复活成标签',
    gone.env.state.wikiTabs.every((t) => t.id !== '2'),
    JSON.stringify(gone.env.state.wikiTabs.map((t) => t.id)));

  for (const [name, raw] of [['乱码', '{{{'], ['不是数组', '{"tabs":"x"}'], ['空数组', '{"tabs":[]}'],
                             ['元素不是对象', '{"tabs":[1,2]}']]) {
    const bad = harness(PAGES);
    bad.env.store['zq.wiki.tabs'] = raw;
    let threw = null;
    try { bad.api.loadWikiTabs(); } catch (e) { threw = e; }
    judge('坏数据不炸：' + name, threw === null, threw && threw.message);
  }

  const oob = harness(PAGES);
  oob.env.store['zq.wiki.tabs'] = '{"tabs":[{"id":"1","title":"A","back":[],"fwd":[]}],"idx":9}';
  oob.api.loadWikiTabs();
  judge('越界的当前索引被收回范围内',
    oob.env.state.wikiTabIdx === 0, 'idx=' + oob.env.state.wikiTabIdx);
}

// ── 9. localStorage 抛异常时不能把整个页面带崩 ────────────────────────
{
  const { env, api } = harness(PAGES);
  env.localStorage.setItem = () => { throw new Error('QuotaExceeded'); };
  env.localStorage.getItem = () => { throw new Error('SecurityError'); };
  let threw = null;
  try { open(api, env, 1); api.loadWikiTabs(); } catch (e) { threw = e; }
  judge('localStorage 抛异常也不影响使用', threw === null, threw && threw.message);
}

// ALL-GREEN 是 NodeRunner 认的标记：只看退出码不够，脚本在加载阶段挂掉也可能是 0。
console.log(fail === 0 ? '\nALL-GREEN 全部通过' : '\n' + fail + ' 条判据红了');
process.exit(fail === 0 ? 0 : 1);
