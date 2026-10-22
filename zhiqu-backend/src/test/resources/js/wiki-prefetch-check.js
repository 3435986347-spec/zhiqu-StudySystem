// 知识 Wiki 的目录预取（第六十九轮）：跑发布的那份模块里真的 prefetchWikiPage / paintWikiDoc / paintWikiTree，
// 只把画整页用的那几个函数换成空的。钟和定时器是替身（「30 秒内才用」「停 120ms 才取」要能拨）。
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8').replace(/^export /gm, '');

function fixture() {
  let now = 1_000_000, auth = 'token-a';
  const gets = [], timers = [];
  const replies = [];   // 每次 GET 拿走一个：{ resolve, reject, promise }
  const page = { id: 7, title: '长页面', summary: '摘要', version: 1 };
  const other = { id: 8, title: '已读过', content: '全文', _full: true };
  const state = { wikiCur: null, wikiDirty: false, wikiPages: [page, other], wikiFilter: { q: '', type: '' } };
  const doc = { dataset: {}, style: {}, innerHTML: '', contentEditable: 'false' };
  const anchor = { dataset: { wiki: '7' } };
  const tree = { innerHTML: '' };
  const elements = { '#zq-doc': doc, '#zq-doc-title': { textContent: '' }, '#zq-tree': tree };
  const api = { get(path) {
    gets.push(path);
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    replies.push({ resolve, reject, promise });
    return promise;
  } };
  const sh = { state, api, token: () => auth, esc: String, empty: (text) => `<empty>${text}</empty>`, fmtDate: String,
    $: (selector) => elements[selector] || null, $all: (selector, target) => selector === '[data-wiki]' && target === tree ? [anchor] : [],
    safe: (_name, fn) => Promise.resolve().then(fn).catch(() => null), toast() {}, renderMarkdown: (text) => `<md>${text}</md>`, renderMathIn() {} };
  const fakeDate = { now: () => now };
  const setTimeoutFake = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const impl = new Function('document', 'window', 'Date', 'setTimeout', 'clearTimeout', `
    ${source}
    trackWikiNavigation = removeWikiDraftBar = removeWikiActionBar = syncWikiEditMode = setSourcePressed = markDuplicateTitle = markEmptyWikiPage
      = wireWikiLinks = showWikiActionBar = restoreWikiView = paintWikiTabs = offerWikiDraft = function () {};
    return { bind, prefetchWikiPage, paintWikiDoc, paintWikiTree };`)(
    { getElementById: () => null }, { addEventListener() {} }, fakeDate, setTimeoutFake, () => {});
  impl.bind(sh);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return { impl, page, other, doc, anchor, gets, replies, timers, tick, state,
    advance(ms) { now += ms; }, setAuth(value) { auth = value; } };
}

(async () => {
  let failed = 0;
  async function check(name, fn) {
    // 等一个永远不回的请求会让事件循环空掉、node 一声不吭地退出 —— 卡住的要明说
    let timer;
    const stuck = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('卡住了：2 秒没结束（多半是在等一个没人回的请求）')), 2000); });
    try { await Promise.race([fn(), stuck]); console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
    finally { clearTimeout(timer); }
  }
  await check('预取回来之后点下去：不再发第二次请求，画的就是取回来的正文', async () => {
    const f = fixture();
    f.impl.prefetchWikiPage(f.page);
    f.replies[0].resolve({ content: '预取的正文', version: 2 });
    await f.tick();
    await f.impl.paintWikiDoc(f.page);
    assert.deepEqual(f.gets, ['/knowledge/pages/7']);
    assert.equal(f.doc.innerHTML, '<md>预取的正文</md>');
    assert.equal(f.page._full, true);
    assert.equal(f.page.version, 2);
  });
  await check('预取还在路上就点下去：等同一个请求，不另发', async () => {
    const f = fixture();
    f.impl.prefetchWikiPage(f.page);
    const painting = f.impl.paintWikiDoc(f.page);
    await f.tick();
    assert.equal(f.doc.innerHTML, '<empty>正在加载知识页…</empty>', '等的时候要露出「正在加载」');
    f.replies[0].resolve({ content: '路上的正文', version: 2 });
    await painting;
    assert.equal(f.gets.length, 1);
    assert.equal(f.doc.innerHTML, '<md>路上的正文</md>');
  });
  await check('预取失败：点下去照常再取一次（失败不能把页面卡在「正在加载」）', async () => {
    const f = fixture();
    f.impl.prefetchWikiPage(f.page);
    f.replies[0].reject(new Error('断网'));
    await f.tick();
    const painting = f.impl.paintWikiDoc(f.page);
    await f.tick();
    assert.equal(f.gets.length, 2);
    f.replies[1].resolve({ content: '重新取的', version: 3 });
    await painting;
    assert.equal(f.doc.innerHTML, '<md>重新取的</md>');
  });
  await check('回来超过 30 秒才点：不拿旧的冒充新的，重新取', async () => {
    const f = fixture();
    f.impl.prefetchWikiPage(f.page);
    f.replies[0].resolve({ content: '旧的', version: 2 });
    await f.tick();
    f.advance(30_001);
    const painting = f.impl.paintWikiDoc(f.page);
    await f.tick();
    assert.equal(f.gets.length, 2, '过期的预取被拿来用了');
    f.replies[1].resolve({ content: '新的', version: 5 });
    await painting;
    assert.equal(f.doc.innerHTML, '<md>新的</md>');
  });
  await check('换了登录：别人的预取不用', async () => {
    const f = fixture();
    f.impl.prefetchWikiPage(f.page);
    f.replies[0].resolve({ content: '上一个账号的', version: 2 });
    await f.tick();
    f.setAuth('token-b');
    const painting = f.impl.paintWikiDoc(f.page);
    await f.tick();
    assert.equal(f.gets.length, 2);
    f.replies[1].resolve({ content: '这个账号的', version: 2 });
    await painting;
    assert.equal(f.doc.innerHTML, '<md>这个账号的</md>');
  });
  await check('已经有全文的页、同一页连着停几次：不重复取', async () => {
    const f = fixture();
    f.impl.prefetchWikiPage(f.other);
    f.impl.prefetchWikiPage(f.page); f.impl.prefetchWikiPage(f.page);
    assert.deepEqual(f.gets, ['/knowledge/pages/7']);
  });
  await check('目录项：停 120ms 才取（划过去不取）、按下去马上取', async () => {
    const f = fixture();
    f.impl.paintWikiTree();
    assert.equal(typeof f.anchor.onpointerenter, 'function', '目录项没接停留预取');
    f.anchor.onpointerenter();
    assert.equal(f.gets.length, 0, '一划过去就取了');
    assert.equal(f.timers.at(-1).ms, 120);
    f.timers.at(-1).fn();
    assert.deepEqual(f.gets, ['/knowledge/pages/7']);
    const g = fixture();
    g.impl.paintWikiTree();
    g.anchor.onpointerdown();
    assert.deepEqual(g.gets, ['/knowledge/pages/7'], '按下去没有马上取');
  });
  console.log(failed ? 'RED: ' + failed : 'ALL-GREEN');
  if (failed) process.exitCode = 1;
})();
