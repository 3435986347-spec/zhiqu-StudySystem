// 网页请求的超时 / 重试 / 响应解析，以及聊天流的 SSE 帧解析与空闲超时 —— 直接跑 assets/zhiqu-api.js 里发布的实现。
//
//   用法：node src/test/resources/js/request-check.js <zhiqu-api.js 的路径>
//   打印 ALL-GREEN 且退出码 0 = 全绿。由 RequestResilienceTest 调用。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

function slice(startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error('抠不到起点: ' + startMark);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error('抠不到终点: ' + endMark);
  return src.slice(a, b);
}
let reqSrc = slice('var REQUEST_TIMEOUT_MS = ', '  var api = {');
let sseSrc = slice('function parseSseFrame(frame) {', '  async function streamAiChat(');
const streamSrc = slice('  async function streamAiChat(', '  function upsertAgentStep(');
const onlineSrc = slice('  function whenOnline(fn) {', '\n  }\n') + '\n  }\n';
// 把等待调短 —— 替换必须真的落地，否则这份判据会在 30 秒超时上等很久，或者测的根本不是改过的常量
for (const [from, to] of [['var REQUEST_TIMEOUT_MS = 30000;', 'var REQUEST_TIMEOUT_MS = 60;'], ['var RETRY_WAITS_MS = [700, 2000];', 'var RETRY_WAITS_MS = [5, 5];']]) {
  if (!reqSrc.includes(from)) throw new Error('常量对不上，判据没法调短等待：' + from);
  reqSrc = reqSrc.replace(from, to);
}

let fetchImpl = null;
const calls = [];
let redirected = 0;
const env = {
  API: '/api',
  token: () => 't',
  redirectToLogin: () => { redirected++; },
  isAuthFailure: (json) => json && (json.code === 401 || json.code === 403),
  fetch: (url, opts) => { calls.push({ url, method: opts.method || 'GET', key: (opts.headers || {})['Idempotency-Key'] }); return fetchImpl(url, opts); },
};
// whenOnline 用的 window（online 事件）和 setTimeout：换成能手动触发的
const listeners = {};
const fakeWindow = {
  addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); },
  removeEventListener: (n, f) => { listeners[n] = (listeners[n] || []).filter((x) => x !== f); },
};
// 「正在保存…」和按钮的忙状态要一个 document：记下点击监听、按 id 找元素
const docListeners = {};
const elements = {};
const fakeDocument = {
  addEventListener: (n, f) => { docListeners[n] = f; },
  getElementById: (id) => elements[id] || null,
  createElement: () => ({ attrs: {}, hidden: false, textContent: '', setAttribute(k, v) { this.attrs[k] = v; } }),
  body: { appendChild: (el) => { elements[el.id] = el; } },
};
const fakeButton = () => { const b = { attrs: {}, setAttribute(k, v) { b.attrs[k] = v; }, removeAttribute(k) { delete b.attrs[k]; } }; b.closest = () => b; return b; };
const mod = new Function('API', 'token', 'redirectToLogin', 'isAuthFailure', 'fetch', 'window', 'document',
  reqSrc + '\n' + sseSrc + '\n' + streamSrc + '\n' + onlineSrc + '\nreturn { request, parseSseFrame, readWithIdleTimeout, streamAiChat, whenOnline };')(
  env.API, env.token, env.redirectToLogin, env.isAuthFailure, env.fetch, fakeWindow, fakeDocument);

const res = (status, body) => Promise.resolve({ status, text: () => Promise.resolve(body) });
const ok = (data) => res(200, JSON.stringify({ code: 200, data }));
function script(...steps) {
  let i = 0;
  fetchImpl = (url, opts) => {
    const s = steps[Math.min(i++, steps.length - 1)];
    return typeof s === 'function' ? s(url, opts) : s;
  };
  calls.length = 0;
}

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}
async function rejects(p) { try { await p; return null; } catch (e) { return e; } }

(async () => {
  script(res(503, '<html>'), res(503, '<html>'), ok({ v: 1 }));
  const r1 = await mod.request('/x', { method: 'GET' }).catch((e) => e);
  judge('GET 遇到 503 重试，第三次成功就当没事', r1 && r1.v === 1 && calls.length === 3, JSON.stringify(r1) + ' calls=' + calls.length);

  script(() => Promise.reject(new TypeError('Failed to fetch')), ok({ v: 2 }));
  const r2 = await mod.request('/x', { method: 'GET' }).catch((e) => e);
  judge('GET 断网一次，重试后成功', r2 && r2.v === 2 && calls.length === 2, String(r2 && r2.message));

  script(res(502, '<html>bad gateway</html>'), ok({}));
  const e3 = await rejects(mod.request('/auth/login', { method: 'POST', body: '{}' }));
  judge('登录注册（/auth/，服务器不认幂等键）遇到 502 不重试（可能已经生效了），不带键，并说人话',
    e3 && calls.length === 1 && !calls[0].key && /服务器暂时不可用（HTTP 502）/.test(e3.message), e3 && e3.message + ' calls=' + calls.length);

  script(res(429, '{"code":429,"message":"请求过于频繁"}'), ok({ v: 4 }));
  const r4 = await mod.request('/x', { method: 'POST', body: '{}' }).catch((e) => e);
  judge('POST 遇到 429 重试（被限流 = 服务器没处理）', r4 && r4.v === 4 && calls.length === 2, String(r4 && r4.message));

  script(res(503, ''), res(503, ''), res(503, ''), ok({}));
  const e5 = await rejects(mod.request('/x', { method: 'GET' }));
  judge('重试有上限：一共 3 次，全失败把原因报出来', e5 && calls.length === 3 && /暂时不可用/.test(e5.message), e5 && e5.message + ' calls=' + calls.length);

  script(res(200, '{"code":500,"message":"模型没配"}'));
  const e6 = await rejects(mod.request('/x', { method: 'GET' }));
  judge('业务错误（code != 200）不重试，原样报出', e6 && calls.length === 1 && e6.message === '模型没配', e6 && e6.message);
  judge('业务错误带 userFacing（没接住时兜底原样说出来）', e6 && e6.userFacing === true);

  script(res(200, '<html>login page</html>'));
  const e7 = await rejects(mod.request('/x', { method: 'GET' }));
  judge('响应不是 JSON：说「看不懂的内容」而不是 Unexpected token', e7 && /看不懂的内容/.test(e7.message) && !/Unexpected/.test(e7.message), e7 && e7.message);

  script((url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const t0 = Date.now();
  const e8 = await rejects(mod.request('/x', { method: 'POST', body: '{"t":8}' }));
  judge('超时：服务器不回应就按时放弃（写操作用同一个键重来两次），说清楚「不确定有没有保存上」',
    e8 && /秒没有回应，不确定有没有保存上/.test(e8.message) && Date.now() - t0 < 2000 && calls.length === 3 && e8.uncertain === true,
    e8 && e8.message + ' calls=' + calls.length);

  script(res(401, ''));
  redirected = 0;
  const e9 = await rejects(mod.request('/x', { method: 'GET' }));
  judge('401 跳登录、不重试', e9 && redirected === 1 && calls.length === 1);

  // ── 同一个写请求还没回来又发一次（双击「创建」、连按回车、等不及又点）—— 第十四轮 ──
  const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
  const post = (path, body, headers = {}) => mod.request(path, { method: 'POST', body, headers });
  let gate = deferred();
  script(() => gate.p.then(() => ok({ id: 7 })));
  const a1 = post('/routine', '{"title":"背单词"}');
  const a2 = post('/routine', '{"title":"背单词"}');
  gate.resolve();
  const [b1, b2] = await Promise.all([a1, a2]);
  judge('双击「创建」：同一个写请求只发一次，两边拿到同一个结果', calls.length === 1 && b1.id === 7 && b2.id === 7, 'calls=' + calls.length);

  script(ok({ id: 8 }));
  const b3 = await post('/routine', '{"title":"背单词"}');
  judge('回来之后再点是新的一次：照常发', calls.length === 1 && b3.id === 8, 'calls=' + calls.length);

  gate = deferred();
  script(() => gate.p.then(() => ok({})));
  const many = [post('/routine', '{"title":"A"}'), post('/routine', '{"title":"B"}'), post('/task', '{"title":"A"}'),
    post('/task', '{"title":"A"}', { 'Idempotency-Key': 'k1' }), post('/task', '{"title":"A"}', { 'Idempotency-Key': 'k2' }),
    mod.request('/routine', { method: 'PUT', body: '{"title":"A"}' }), mod.request('/x', { method: 'GET' }), mod.request('/x', { method: 'GET' })];
  gate.resolve();
  await Promise.all(many);
  judge('内容不同、地址不同、幂等键不同、方法不同、GET：各发各的', calls.length === 8, 'calls=' + calls.length);

  gate = deferred();
  script(() => gate.p.then(() => res(200, '{"code":500,"message":"标题重复"}')), ok({ id: 9 }));
  const [f1, f2] = await Promise.all([rejects(post('/routine', '{"t":1}')), rejects(post('/routine', '{"t":1}')), Promise.resolve(gate.resolve())]);
  judge('失败了两次点击都知道原因', f1 && f2 && f1.message === '标题重复' && f2.message === '标题重复' && calls.length === 1, (f1 && f1.message) + ' calls=' + calls.length);
  const b4 = await post('/routine', '{"t":1}').catch((e) => e);
  judge('失败之后再点照常发（不会一直卡在「还没回来」）', b4 && b4.id === 9 && calls.length === 2, 'calls=' + calls.length);

  // ── 回应丢在路上（第二十二轮）：服务器可能已经做完了。写请求带幂等键，丢了就用同一个键重来；还不行就照实说、键留着 ──
  const drop = () => Promise.reject(new TypeError('Failed to fetch'));
  script(ok({ id: 11 }));
  await post('/routine', '{"title":"跑步"}');
  judge('写请求自动带上幂等键', calls.length === 1 && /^ui-/.test(calls[0].key || ''), JSON.stringify(calls));

  script(drop, ok({ id: 12 }));
  const r12 = await post('/routine', '{"title":"读书"}').catch((e) => e);
  judge('回应断了一次：用同一个键自动重来，拿到结果就当没事', r12 && r12.id === 12 && calls.length === 2 && calls[0].key && calls[0].key === calls[1].key,
    JSON.stringify(calls) + ' ' + (r12 && r12.message));

  script(res(502, '<html>'), res(200, '{"code":409,"message":"上一次提交还在处理，请稍后再试"}'), ok({ id: 13 }));
  const r13 = await post('/routine', '{"title":"写字"}').catch((e) => e);
  judge('502、再来撞上「上一次还在处理」（409）：都用同一个键再来，第三次拿到结果',
    r13 && r13.id === 13 && calls.length === 3 && new Set(calls.map((c) => c.key)).size === 1, JSON.stringify(calls) + ' ' + (r13 && r13.message));

  script(drop);
  const u1 = await rejects(post('/routine', '{"title":"冥想"}'));
  const lostKey = calls[0] && calls[0].key;
  judge('重来也没回应：照实说「不确定有没有保存上 —— 再点一次不会重复保存」，而不是「网络连接失败，请重试」',
    u1 && u1.uncertain === true && u1.message === '网络连接断了，不确定有没有保存上 —— 再点一次不会重复保存' && calls.length === 3,
    u1 && u1.message + ' calls=' + calls.length);
  script(ok({ id: 14 }));
  await post('/routine', '{"title":"冥想"}');
  judge('照着提示再点一次：沿用刚才那个键（做过了服务器交回上次的结果，不会建第二份）', calls.length === 1 && calls[0].key === lostKey, JSON.stringify(calls));
  script(ok({ id: 15 }));
  await post('/routine', '{"title":"冥想"}');
  judge('那一次成功之后再点：是新的一次，换新键', calls.length === 1 && calls[0].key && calls[0].key !== lostKey, JSON.stringify(calls));

  script(drop);
  await rejects(post('/routine', '{"title":"拉伸"}'));
  const k2 = calls[0].key;
  script(ok({}));
  await post('/task', '{"title":"别的"}');
  await post('/routine', '{"title":"拉伸","note":"改了"}');
  const kOther = calls[1].key;
  script(ok({}));
  await post('/routine', '{"title":"拉伸"}');
  judge('内容不一样的是另一件事、换键；同一块数据（/routine）有别的写成功了，没弄清的那个键作废（撤销再做一次是新的一次）',
    kOther !== k2 && calls[0].key !== k2, JSON.stringify({ k2, kOther, now: calls[0].key }));

  script(drop);
  await rejects(post('/routine', '{"title":"早起"}'));
  const k3 = calls[0].key;
  script(ok({}));
  await post('/task', '{"title":"不相干"}');
  script(ok({}));
  await post('/routine', '{"title":"早起"}');
  judge('别处（/task）的写成功不影响：/routine 那个没弄清的键还留着', calls[0].key === k3, JSON.stringify({ k3, now: calls[0].key }));

  script(drop);
  await rejects(post('/routine', '{"title":"午睡"}'));
  const k4 = calls[0].key;
  script(res(200, '{"code":500,"message":"标题重复"}'));
  await rejects(post('/routine', '{"title":"午睡"}'));
  script(ok({}));
  await post('/routine', '{"title":"午睡"}');
  judge('服务器明确拒了（业务错误）之后再点：那个键不再沿用', calls[0].key !== k4, JSON.stringify({ k4, now: calls[0].key }));

  script(drop);
  const d1 = await rejects(mod.request('/task/5', { method: 'DELETE' }));
  judge('删除没回应：说「不确定有没有删掉」', d1 && /不确定有没有删掉/.test(d1.message) && calls.length === 3, d1 && d1.message);

  script(res(200, '{"code":409,"message":"上一次提交还在处理，请稍后再试"}'));
  const p1 = await rejects(post('/routine', '{"title":"慢"}'));
  judge('一直「还在处理」：说还在处理、稍等再点（不说失败）', p1 && p1.uncertain && /还在处理，稍等一下再点一次/.test(p1.message), p1 && p1.message);

  script(res(429, '{}'));
  const q1 = await rejects(post('/routine', '{"title":"限流"}'));
  judge('一直被限流（429，进业务之前就拒了）：确定没做，不说「不确定」', q1 && !q1.uncertain && /请求过于频繁/.test(q1.message), q1 && q1.message);

  script(drop, ok({ ok: 1 }));
  const own = await post('/shared-plans/3/apply', '{}', { 'Idempotency-Key': 'plan-k:2026-10-01' }).catch((e) => e);
  judge('调用方自己带的键照它的来，断了也用它重来', own && own.ok === 1 && calls.length === 2 && calls.every((c) => c.key === 'plan-k:2026-10-01'), JSON.stringify(calls));

  judge('SSE：心跳注释帧不是事件', mod.parseSseFrame(':ping') === null);
  const f = mod.parseSseFrame('event:message.delta\ndata:{"text":"你好"}');
  judge('SSE：event + data 正常解析', f && f.event === 'message.delta' && f.data.text === '你好', JSON.stringify(f));
  const g = mod.parseSseFrame('data: 第一行\ndata: 第二行');
  judge('SSE：多行 data 以换行连接，只剥一个前导空格', g && g.event === 'message' && g.data.text === '第一行\n第二行', JSON.stringify(g));

  const hang = { read: () => new Promise(() => {}) };
  const t1 = Date.now();
  const e10 = await rejects(mod.readWithIdleTimeout(hang, 50));
  judge('聊天流：一直没数据就按时断开（标记 idle），交给「断线接回」', e10 && e10.idle === true && Date.now() - t1 < 1000, e10 && e10.message);
  const quick = { read: () => Promise.resolve({ done: false, value: 'x' }) };
  const v = await mod.readWithIdleTimeout(quick, 50);
  judge('聊天流：有数据时照常返回', v && v.value === 'x');

  // ── 慢网下写请求还没回来：刚点的按钮标成忙；0.6 秒还没回来，页面顶上说「正在保存…」（第二十二轮 3 秒延迟实测：原来什么都不变）──
  const saveBtn = fakeButton();
  docListeners.click({ target: saveBtn });
  let release;
  script(() => new Promise((r) => { release = () => r(null); }).then(() => ok({})));
  const slow = post('/routine', '{"title":"慢"}');
  const busyAtOnce = saveBtn.attrs['aria-busy'];
  await new Promise((r) => setTimeout(r, 700));
  const chip = elements['zq-saving'];
  judge('写请求在路上：刚点的按钮马上标成忙（aria-busy）', busyAtOnce === 'true', JSON.stringify(saveBtn.attrs));
  judge('0.6 秒还没回来：页面顶上说「正在保存…」', chip && !chip.hidden && chip.textContent === '正在保存…', JSON.stringify(chip));
  release();
  await slow;
  judge('回来了：「正在保存…」收起、按钮恢复', chip && chip.hidden === true && !('aria-busy' in saveBtn.attrs), JSON.stringify({ chip, attrs: saveBtn.attrs }));
  chip.textContent = '';
  script(ok({}));
  await post('/routine', '{"title":"快"}');
  await new Promise((r) => setTimeout(r, 700));
  judge('很快就回来的：不闪「正在保存…」', chip.hidden === true && chip.textContent === '', JSON.stringify(chip));

  // ── 聊天流连不上 / 断在半路：说中文，并分清「一个字都没回来」和「流到一半断了」（第二十二轮断网实测）──
  script(() => Promise.reject(new TypeError('Failed to fetch')));
  const s1 = await rejects(mod.streamAiChat({}, () => {}));
  judge('聊天流一个字节都没回来就连不上：说「网络连接失败」而不是浏览器的 Failed to fetch，并标明没有回应（这句多半没发出去）',
    s1 && s1.message === '网络连接失败' && s1.beforeResponse === true && s1.userFacing === true, s1 && s1.message);
  const enc = new TextEncoder();
  let reads = 0;
  script(() => Promise.resolve({ status: 200, ok: true, body: { getReader: () => ({
    read: () => (reads++ === 0 ? Promise.resolve({ done: false, value: enc.encode('event:message.delta\ndata:{"text":"半句"}\n\n') })
      : Promise.reject(new TypeError('network error'))),
    cancel: () => {},
  }) } }));
  const got = [];
  const s2 = await rejects(mod.streamAiChat({}, (ev, d) => got.push(d.text)));
  judge('聊天流流到一半断了：说「连接断了」（不是 network error），不标成「没发出去」',
    s2 && s2.message === '连接断了' && !s2.beforeResponse && s2.network === true && got[0] === '半句', s2 && s2.message);

  let calls2 = 0;
  const offlineUntil = 3;
  // 限时：不再试的话 done 永远不来 —— 没有限时，node 在事件循环空了之后照样退出码 0、一行 FAIL 都没有（扰动照出来的）
  await Promise.race([new Promise((done) => {
    mod.whenOnline(() => { calls2++; if (calls2 < offlineUntil) return Promise.reject(new Error('还断着')); done(); return Promise.resolve(); });
    // 网回来了两次（online 事件）：第一次还是不通，第二次通了
    setTimeout(() => (listeners.online || []).slice().forEach((f) => f()), 20);
    setTimeout(() => (listeners.online || []).slice().forEach((f) => f()), 40);
  }), new Promise((r) => setTimeout(r, 1000))]);
  judge('断线接回在网还断着的时候失败了：等网回来再试，直到接上（原来只试一次，网回来之后一直停在那）', calls2 === offlineUntil, 'calls=' + calls2);

  if (fail) { console.log(fail + ' 条红'); process.exit(1); }
  console.log('ALL-GREEN');
})();
