// 打了一半的字（第十五轮）—— 直接跑 assets/zhiqu-api.js 里发布的 drafts、keepDraft、safeNext。
//   用法：node src/test/resources/js/drafts-check.js <zhiqu-api.js 的路径>；打印 ALL-GREEN 且退出码 0 = 全绿。由 DraftsTest 调用。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
function slice(startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error('抠不到起点: ' + startMark);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error('抠不到终点: ' + endMark);
  return src.slice(a, b);
}
let draftsSrc = slice('  var DRAFT_PREFIX = ', '  async function safe(');
const delayFrom = 'var DRAFT_SAVE_DELAY_MS = 400;';
if (!draftsSrc.includes(delayFrom)) throw new Error('常量对不上，判据没法调短等待：' + delayFrom);
draftsSrc = draftsSrc.replace(delayFrom, 'var DRAFT_SAVE_DELAY_MS = 5;');
const nextSrc = slice('  function safeNext(raw) {', '\n  }\n') + '\n  }\n';

function fakeStorage() {
  const data = {};
  const api = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { if (api.full) throw new Error('QuotaExceededError'); data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    full: false,
    data,
  };
  return api;
}
const store = fakeStorage();
// Object.keys(localStorage) 在浏览器里给的是键名：用 Proxy 让它只列出数据
const localStorage = new Proxy(store, { ownKeys: () => Reflect.ownKeys(store.data), getOwnPropertyDescriptor: (t, k) => ({ enumerable: true, configurable: true, value: store.data[k] }) });
const state = { user: { id: 3 } };
const pagehide = [];
const window = { addEventListener: (t, f) => { if (t === 'pagehide') pagehide.push(f); } };
const mod = new Function('state', 'localStorage', 'window', draftsSrc + nextSrc + '\nreturn { drafts, keepDraft, safeNext, DRAFT_MAX_CHARS, DRAFT_TTL_MS };')(state, localStorage, window);
const { drafts, keepDraft, safeNext } = mod;

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function fakeInput(value = '') {
  const ls = {};
  return { value, addEventListener: (t, f) => { (ls[t] = ls[t] || []).push(f); }, type(text) { this.value = text; (ls.input || []).forEach((f) => f()); } };
}

(async () => {
  judge('存了能读回来，键里带用户 id', drafts.save('chat.1', '帮我排下周') && drafts.load('chat.1').text === '帮我排下周' && store.getItem('zq.draft.3.chat.1') !== null, JSON.stringify(store.data));
  state.user = { id: 4 };
  judge('换个人登录：看不到上一个人的草稿', drafts.load('chat.1') === null);
  state.user = { id: 3 };
  drafts.save('chat.1', '   ');
  judge('空了就删', store.getItem('zq.draft.3.chat.1') === null);
  drafts.save('big', 'x');
  judge('太长的不存（不报错），原来那份不动', drafts.save('big', 'y'.repeat(mod.DRAFT_MAX_CHARS + 1)) === false && drafts.load('big').text === 'x');
  store.full = true;
  let threw = false; let saved;
  try { saved = drafts.save('full', '存不下'); } catch (e) { threw = true; }
  store.full = false;
  judge('存储满了 / 被禁用：不抛，返回 false', !threw && saved === false);
  store.data['zq.draft.3.old'] = JSON.stringify({ text: '很久以前', at: Date.now() - mod.DRAFT_TTL_MS - 1000 });
  judge('过期的当没有，并且删掉', drafts.load('old') === null && store.getItem('zq.draft.3.old') === null);
  store.data['zq.draft.3.bad'] = '{不是 JSON';
  judge('坏数据当没有，不抛', drafts.load('bad') === null);
  const anon = state.user; state.user = null;
  judge('还没拿到是谁（没登录）：不存不读', drafts.save('x', 'y') === false && drafts.load('chat.1') === null);
  state.user = anon;

  drafts.save('chat.2', '第一句');
  drafts.clearIf('chat.2', '另一句');
  judge('clearIf：存着的不是发出去的那句 —— 不删（用户又打了新的）', drafts.load('chat.2').text === '第一句');
  drafts.clearIf('chat.2', ' 第一句 ');
  judge('clearIf：是同一句 —— 删', drafts.load('chat.2') === null);

  drafts.save('a', '三的'); state.user = { id: 4 }; drafts.save('a', '四的'); state.user = { id: 3 };
  drafts.clearUser();
  judge('主动退出：只删自己的', store.getItem('zq.draft.3.a') === null && store.getItem('zq.draft.4.a') !== null);

  // keepDraft
  drafts.save('chat.7', '还没发的一句');
  let restored = 0;
  const box = fakeInput('');
  const h = keepDraft(box, () => 'chat.7', () => restored++);
  judge('框是空的：草稿填回去（并通知去调高度）', box.value === '还没发的一句' && restored === 1, box.value);
  const typed = fakeInput('正在打的');
  keepDraft(typed, 'chat.7');
  judge('框里已经有字：不拿草稿盖掉', typed.value === '正在打的');
  box.type('还没发的一句，再加点');
  await wait(30);
  judge('打字之后过一会儿存下', drafts.load('chat.7').text === '还没发的一句，再加点');
  box.value = '';                      // 发送：程序把框清空，不是用户删的
  pagehide.forEach((f) => f());
  judge('程序清空的框在离开页面时不去抹草稿（服务器还没确认收到那句）', drafts.load('chat.7') && drafts.load('chat.7').text === '还没发的一句，再加点');
  box.type('马上关页');
  pagehide.forEach((f) => f());
  judge('打了字马上关页：离开时当场存', drafts.load('chat.7').text === '马上关页');

  let nb = 8;
  drafts.save('chat.9', 'Notebook 9 的草稿');
  const box2 = fakeInput('');
  const h2 = keepDraft(box2, () => 'chat.' + nb);
  box2.type('Notebook 8 打了一半');
  nb = 9; h2.reload();
  judge('换 Notebook：这边的存到原来的键、框里换成那边的', drafts.load('chat.8').text === 'Notebook 8 打了一半' && box2.value === 'Notebook 9 的草稿', box2.value);
  nb = 10; h2.reload();
  judge('换到没有草稿的 Notebook：框清空', box2.value === '');
  h.clear();
  judge('clear：删当前键', drafts.load('chat.7') === null);

  // safeNext
  const ok = ['knowledge-wiki.html', 'ai-assistant.html?nb=3', 'tasks.html'];
  const bad = ['', null, 'index.html', 'index.html?login=1', '//evil.example', 'https://evil.example/tasks.html', 'javascript:alert(1)',
    '../tasks.html', '/tasks.html', 'tasks.html?x=//evil.example', 'tasks.html#x', 'tasks.html\\evil', 'tasks.html?a=1 b', 'data:text/html,x'];
  judge('登录后回原来那一页：本站的页照去', ok.every((x) => safeNext(x) === x), ok.map((x) => safeNext(x)).join(','));
  const leaked = bad.filter((x) => safeNext(x) !== 'dashboard.html');
  judge('不是本站的一律回看板（不做开放跳转）', leaked.length === 0, JSON.stringify(leaked));

  if (fail) { console.log(fail + ' 条红'); process.exit(1); }
  console.log('ALL-GREEN');
})();
