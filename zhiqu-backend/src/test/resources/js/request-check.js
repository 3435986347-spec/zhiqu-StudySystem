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
  fetch: (url, opts) => { calls.push({ url, method: opts.method || 'GET' }); return fetchImpl(url, opts); },
};
const mod = new Function('API', 'token', 'redirectToLogin', 'isAuthFailure', 'fetch',
  reqSrc + '\n' + sseSrc + '\nreturn { request, parseSseFrame, readWithIdleTimeout };')(
  env.API, env.token, env.redirectToLogin, env.isAuthFailure, env.fetch);

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
  const e3 = await rejects(mod.request('/x', { method: 'POST', body: '{}' }));
  judge('POST 遇到 502 不重试（可能已经生效了），并说人话', e3 && calls.length === 1 && /服务器暂时不可用（HTTP 502）/.test(e3.message), e3 && e3.message + ' calls=' + calls.length);

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
  const e8 = await rejects(mod.request('/x', { method: 'POST', body: '{}' }));
  judge('超时：服务器不回应就按时放弃，并说清楚', e8 && /秒没有回应/.test(e8.message) && Date.now() - t0 < 2000 && calls.length === 1, e8 && e8.message);

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

  if (fail) { console.log(fail + ' 条红'); process.exit(1); }
  console.log('ALL-GREEN');
})();
