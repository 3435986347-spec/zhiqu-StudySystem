// 同一个浏览器会话里的标签页共享登录（第二十五轮）—— 直接跑 assets/zhiqu-api.js 里发布的那一段，几个「标签页」各有各的 sessionStorage，
// 用 node 自带的 BroadcastChannel 真的互相问。
//   用法：node src/test/resources/js/auth-share-check.js <zhiqu-api.js 的路径>；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('  // ── 同一个浏览器会话里的标签页共享登录');
const b = src.indexOf('  // ── 共享登录到此', a);
if (a < 0 || b < 0) throw new Error('抠不到共享登录那一段');
const section = src.slice(a, b);

const tabs = [];
function tab(initialToken, page) {
  const store = new Map();
  if (initialToken) { store.set('token', initialToken); store.set('role', 'USER'); }
  const sessionStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  };
  const location = { replaced: null, replace(u) { this.replaced = u; } };
  const token = () => sessionStorage.getItem('token') || '';
  const api = new Function('sessionStorage', 'location', 'page', 'token',
    section + '\nreturn { borrowToken, announceLogout, announceNewToken, close: function () { if (authChannel) authChannel.close(); } };')(
    sessionStorage, location, page || 'dashboard.html', token);
  const t = { store, location, api };
  tabs.push(t);
  return t;
}
const tick = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
function judge(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + '  →  ' + g + '（应为 ' + w + '）'); fail++; }
}

(async () => {
  // 只有自己一个标签页：问不到，照旧去登录 —— 而且不能一直等
  const lonely = tab(null);
  const t0 = Date.now();
  judge('没有别的标签页：借不到', await lonely.api.borrowToken(), false);
  judge('借不到时不久等（400 毫秒上下）', Date.now() - t0 < 1500, true);
  lonely.api.close();

  const A = tab('T1');                 // 已登录（没勾记住）
  const C = tab('T2');                 // 同一个浏览器里另一个人
  const E = tab(null);                 // 一个也没登录的标签页：不该替别人回答
  const B = tab(null);                 // 新开的
  judge('新开的标签页借到了别的标签页的令牌', await B.api.borrowToken(), true);
  judge('借到的是某个已登录标签页的令牌', ['T1', 'T2'].includes(B.store.get('token')), true);
  judge('角色一起带过来', B.store.get('role'), 'USER');
  judge('手里已有令牌时不去借', await A.api.borrowToken(), false);

  // 让 B 明确拿着 T1，再看退出 / 换令牌只动同一张令牌的那些页
  B.store.set('token', 'T1');
  A.api.announceNewToken('T1', 'T3');
  await tick(60);
  judge('改密码换了令牌：拿着旧令牌的标签页换成新的', B.store.get('token'), 'T3');
  judge('别人的标签页不受影响', C.store.get('token'), 'T2');
  A.store.set('token', 'T3');
  A.api.announceLogout('T3');
  await tick(60);
  judge('退出：同一张令牌的标签页也退出', B.store.has('token'), false);
  judge('退出：跳回首页', B.location.replaced, 'index.html');
  judge('退出：别人的标签页不受影响', C.store.get('token'), 'T2');
  judge('没登录的标签页没被打扰', E.location.replaced, null);

  tabs.forEach(t => t.api.close());
  if (fail) { console.log(fail + ' 条红'); process.exit(1); }
  console.log('ALL-GREEN');
})();
