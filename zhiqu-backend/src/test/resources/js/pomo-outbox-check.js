// 番茄钟的待补记（第二十二轮）—— 直接跑 assets/zhiqu-api.js 里发布的实现。
//
//   用法：node src/test/resources/js/pomo-outbox-check.js <zhiqu-api.js 的路径>
//   打印 ALL-GREEN 且退出码 0 = 全绿。由 PomodoroOutboxTest 调用。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

function slice(startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error('抠不到起点: ' + startMark);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error('抠不到终点: ' + endMark);
  return src.slice(a, b);
}
const code = slice('  var POMO_OUTBOX = ', '  function renderWeek(');

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const state = { user: { id: 1 } };
let day = '2026-09-28';
let keyN = 0;
const toasts = [];
const posts = [];
let postImpl = () => Promise.resolve({});
let recorded = 0;
const env = {
  localStorage, state,
  today: () => day,
  writeKey: () => 'ui-k' + (++keyN),
  toast: (m, kind) => toasts.push((kind === 'error' ? '[错] ' : '') + m),
  updatePomoCount: () => {},
  api: { post: (p, b, h) => { posts.push({ path: p, body: b, key: h && h['Idempotency-Key'] }); return postImpl(p, b, h); } },
  window: { zqApi: { afterRecord: () => { recorded++; } } },
};
const mod = new Function(...Object.keys(env), code + '\nreturn { recordPomodoro, flushPomodoros, catchUpPomodoros, pendingPomodoros, readPomoOutbox };')(...Object.values(env));

const offline = () => Promise.reject(Object.assign(new Error('网络连接断了，不确定有没有保存上 —— 再点一次不会重复保存'), { uncertain: true, network: true, retryable: true }));
const rejected = (m) => () => Promise.reject(Object.assign(new Error(m), {}));
function reset() { posts.length = 0; toasts.length = 0; recorded = 0; }

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}

(async () => {
  reset(); postImpl = () => Promise.resolve({ id: 1 });
  await mod.recordPomodoro({ taskId: 7, durationMinutes: 25, note: '番茄钟专注时段' });
  judge('网好的时候：当场记上，设备上不留、不报错，看板刷新',
    posts.length === 1 && posts[0].key && posts[0].body.taskId === 7 && !('studyDate' in posts[0].body) && mod.readPomoOutbox().length === 0 && !toasts.length && recorded === 1,
    JSON.stringify({ posts, toasts, left: mod.readPomoOutbox() }));

  reset(); postImpl = offline;
  await mod.recordPomodoro({ taskId: null, durationMinutes: 25, note: '番茄钟专注时段' });
  const kept = mod.readPomoOutbox();
  judge('专注完的时候网断了：先存在这台设备上，照实说「先存着、连上网自动补记」（不说「没记上」）',
    kept.length === 1 && toasts.length === 1 && /先存在这台设备上，连上网会自动补记/.test(toasts[0]) && !/没记上/.test(toasts[0]),
    JSON.stringify({ kept, toasts }));
  const firstKey = posts[0].key;

  reset(); postImpl = () => Promise.resolve({ id: 2 });
  await mod.catchUpPomodoros();
  judge('网回来了：用存下时那个键补记（回应又丢了也不会记两份），补上了说一声、看板刷新',
    posts.length === 1 && firstKey && posts[0].key === firstKey && mod.readPomoOutbox().length === 0 && /补记了 1 个番茄钟/.test(toasts.join()) && recorded === 1,
    JSON.stringify({ posts, toasts }));

  reset(); postImpl = offline; day = '2026-09-28';
  await mod.recordPomodoro({ taskId: null, durationMinutes: 45, note: '夜里' });
  day = '2026-09-29'; postImpl = () => Promise.resolve({});
  await mod.catchUpPomodoros();
  const late = posts[posts.length - 1];
  judge('过了零点才补上：带上完成那天的日期（不带就记到了补记那天）', late.body.studyDate === '2026-09-28', JSON.stringify(late));

  reset(); postImpl = offline;
  await mod.recordPomodoro({ taskId: null, durationMinutes: 25, note: '当天' });
  postImpl = () => Promise.resolve({});
  await mod.catchUpPomodoros();
  judge('当天补上的：不带日期（服务端定，第二十一轮）', !('studyDate' in posts[posts.length - 1].body), JSON.stringify(posts[posts.length - 1]));

  reset(); postImpl = rejected('关联的任务不存在');
  await mod.recordPomodoro({ taskId: 99, durationMinutes: 25, note: 'x' });
  judge('服务器明确拒了：不留着反复试，说「没记上」和原因',
    mod.readPomoOutbox().length === 0 && toasts.some((t) => /这个番茄钟没记上：关联的任务不存在/.test(t)), JSON.stringify(toasts));

  reset(); postImpl = () => Promise.reject(Object.assign(new Error('未登录或无权限'), { auth: true }));
  await mod.recordPomodoro({ taskId: null, durationMinutes: 25, note: '登录过期' });
  judge('登录过期了：留着，重新登录之后补', mod.readPomoOutbox().length === 1, JSON.stringify(mod.readPomoOutbox()));
  localStorage.removeItem('zq-pomo-outbox');

  reset(); postImpl = offline;
  await mod.recordPomodoro({ taskId: null, durationMinutes: 25, note: '一' });
  await mod.recordPomodoro({ taskId: null, durationMinutes: 25, note: '二' });
  state.user = { id: 2 };
  reset(); postImpl = () => Promise.resolve({});
  await mod.catchUpPomodoros();
  judge('换了账号：不替别的账号补，留着', posts.length === 0 && mod.readPomoOutbox().length === 2, JSON.stringify(posts));
  state.user = { id: 1 };

  reset();
  let release;
  const gate = new Promise((r) => { release = r; });
  postImpl = () => gate.then(() => ({}));
  const both = Promise.all([mod.flushPomodoros(), mod.flushPomodoros()]);
  release();
  await both;
  judge('同时补两趟（打开页面和网回来撞在一起）：每一条只发一次，按原来的先后', posts.length === 2 && posts[0].body.note === '一' && posts[1].body.note === '二',
    JSON.stringify(posts.map((p) => p.body.note)));

  reset(); postImpl = offline;
  await mod.recordPomodoro({ taskId: null, durationMinutes: 25, note: 'A' });
  await mod.recordPomodoro({ taskId: null, durationMinutes: 25, note: 'B' });
  reset();
  let n = 0;
  postImpl = () => (n++ === 0 ? Promise.resolve({}) : offline());
  await mod.catchUpPomodoros();
  judge('补到一半网又断了：补上的去掉，没补上的留着', mod.readPomoOutbox().length === 1 && mod.readPomoOutbox()[0].note === 'B', JSON.stringify(mod.readPomoOutbox()));

  store.set('zq-pomo-outbox', '{坏了');
  judge('设备上存的坏了：当作没有，不抛', mod.pendingPomodoros().length === 0);

  if (fail) { console.log(fail + ' 条红'); process.exit(1); }
  console.log('ALL-GREEN');
})();
