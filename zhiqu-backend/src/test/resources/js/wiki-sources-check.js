// Exercise the published Wiki module: parsing must expose the saved source,
// drafting is a separate click, and confirmation remains the only page write.
const fs = require('fs');
const assert = require('node:assert/strict');

async function moduleUnderTest() {
  const source = fs.readFileSync(process.argv[2], 'utf8');
  const hooks = `\nexport const __sources = { importWikiSource,
    showWikiSources: typeof showWikiSources === 'function' ? showWikiSources : null,
    showWikiSource: typeof showWikiSource === 'function' ? showWikiSource : null,
    showWikiAttachments, runWikiLint, showWikiGraph, showWikiPatchSets };`;
  return import('data:text/javascript;base64,' + Buffer.from(source + hooks).toString('base64'));
}

// 每个场景是一次新打开的页面：上一个场景留着没关的弹窗先关掉（模块记着哪个查看还开着，开着的不会再开一个）
const everyDialog = [];
function fixture(module, options = {}) {
  everyDialog.splice(0).forEach(dialog => dialog.handle.close());
  const dialogs = [], pending = [], posts = [], gets = [], notifications = [];
  const saved = { id: 77, title: '测试导入资料', sourceType: 'FILE', summary: '摘要', content: '这段解析正文应该立即可见' };
  const badge = { textContent: '', title: '', style: {} };
  let generated = false;
  function element() { return { value: '', style: {}, dataset: {}, files: [], disabled: false }; }
  function $all(selector, body) {
    if (!body || !body.data) return [];
    if (selector === 'button') return [...body.nodes.values()];
    const match = /^\[([a-z-]+)\]$/.exec(selector);
    if (!match) return [];
    const key = match[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return body.data.filter(node => key in node.dataset);
  }
  function $(selector, body) {
    if (!body) return selector === '#zq-patch-btn' ? badge : null;
    const data = /^\[data-([a-z-]+)="([^"]+)"\]$/.exec(selector);
    if (data) {
      const key = data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return body.data.find(node => node.dataset[key] === data[2]) || null;
    }
    return body.nodes.get(selector.replace(/^#/, '')) || null;
  }
  // 和真的 openModal 一样：handle.body 开着之后还能整块换内容（第六十九轮：先开弹窗写「正在加载…」，数据到了再填）
  function openModal(spec) {
    const dialog = { ...spec, closed: false };
    const body = { nodes: new Map(), data: [], querySelector: selector => selector.startsWith('#') ? body.nodes.get(selector.slice(1)) || null : null };
    function parse(html) {
      body.nodes = new Map(); body.data = [];
      for (const match of html.matchAll(/id="([^"]+)"/g)) body.nodes.set(match[1], element());
      for (const match of html.matchAll(/data-([a-z-]+)="([^"]+)"/g)) {
        const node = element();
        node.dataset[match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = match[2];
        body.data.push(node);
      }
      dialog.bodyHtml = html;
    }
    Object.defineProperty(body, 'innerHTML', { get: () => dialog.bodyHtml, set: parse });
    parse(spec.bodyHtml);
    if (body.nodes.has('zq-imp-mode')) body.nodes.get('zq-imp-mode').value = 'TEXT';
    dialog.body = body;
    const handle = { body, close() { if (!dialog.closed) { dialog.closed = true; if (spec.onClose) spec.onClose(); } } };
    dialog.handle = handle;
    everyDialog.push(dialog);
    dialogs.push(dialog);
    if (spec.onMount) spec.onMount(body, handle);
    return handle;
  }
  module.bind({ api: {
    async upload(path) { assert.equal(path, '/knowledge/sources/upload'); return saved; },
    async post(path, body) {
      posts.push({ path, body });
      if (path === '/knowledge/sources') return options.postSource ? options.postSource(saved) : saved;
      if (path === '/knowledge/sources/77/patch-set') { generated = true; return options.postDraft ? options.postDraft() : { id: 9 }; }
      throw new Error('Unexpected page mutation: ' + path);
    },
    async get(path) {
      gets.push(path);
      if (options.gate) await options.gate(path);
      if (path === '/knowledge/attachments') return [{ id: 5, name: '合同.pdf', byteSize: 2048 }];
      // 后端 buildLintReport 的真实形状（第六十九轮之前前端读的是 issues / findings / items —— 一个都没有，永远「未发现问题」）
      if (path === '/knowledge/lint/report') return options.lint || { missingTargets: [{ id: 1, sourcePageId: 3, targetTitle: '不存在的页' }],
        orphanPages: [{ id: 4, title: '没人链的页' }], duplicateTitles: [{ title: '周报', pages: [{ id: 5 }, { id: 6 }] }], stalePlans: [],
        unsourcedPages: [{ id: 3, title: '官网改版' }], pageCount: 6, linkCount: 1, sourceCount: 0 };
      if (path === '/knowledge/graph') return { nodes: [{ id: 1, title: '官网改版', degree: 1, type: 'TOPIC' }], links: [] };
      if (/^\/knowledge\/sources\/\d+$/.test(path) && options.getSource) return options.getSource(Number(path.split('/').at(-1)), saved);
      if (path === '/knowledge/sources/77') return saved;
      if (path.startsWith('/knowledge/sources?')) {
        const result = { records: [saved], total: options.total || 1, page: Number(new URLSearchParams(path.split('?')[1]).get('page')), size: 20 };
        return options.getSources ? options.getSources(result) : result;
      }
      if (path === '/knowledge/patch-sets?status=PENDING') return generated
        ? [{ id: 9, title: '整理来源：测试导入资料', items: [{ title: saved.title, content: saved.content }] }] : [];
      throw new Error('Unexpected GET: ' + path);
    }
  }, $, $all, openModal,
    esc: value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    safe: (_label, fn) => { const task = Promise.resolve().then(fn); pending.push(task); return task; },
    notice: text => ({ update(value) { notifications.push(value); } }), toast() {},
    keepDraft: () => ({ clear() {} }), fmtDate: () => '2026-10-14',
    renderMarkdown: text => String(text), renderMathIn() {}, state: { wikiPages: [{ id: 3, title: '官网改版' }] }, empty: text => text,
    token: () => 'T', icon: () => ''
  });
  async function settle() { while (pending.length) await Promise.all(pending.splice(0)); }
  // 用户把开着的弹窗都关掉（模块里记着哪个查看还开着，换下一个场景之前要关）
  function closeAll() { dialogs.forEach(dialog => dialog.handle.close()); }
  function node(dialog, id) { const result = $(id, dialog.body); assert.ok(result, 'Missing actual markup for ' + id); return result; }
  return { dialogs, posts, gets, saved, notifications, settle, node, badge, closeAll };
}

async function main() {
  const module = await moduleUnderTest();
  let failures = 0;
  async function test(name, fn) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
  }
  await test('上传解析完成后可见完整来源，尚未创建草稿或页面', async () => {
    const f = fixture(module);
    module.__sources.importWikiSource();
    const form = f.dialogs[0];
    f.node(form, '#zq-imp-mode').value = 'UPLOAD';
    f.node(form, '#zq-imp-file').files = [{ name: 'notes.txt' }];
    f.node(form, '#zq-imp-ok').onclick();
    await f.settle();
    assert.ok(f.dialogs.some(dialog => dialog.bodyHtml.includes(f.saved.content)), '成功消息之后没有来源正文视图');
    assert.ok(f.gets.includes('/knowledge/sources/77'), '没有读取刚上传来源的完整正文');
    assert.equal(f.posts.length, 0, '上传不应自动生成或合入草稿');
  });
  await test('粘贴导入同样打开来源正文', async () => {
    const f = fixture(module);
    module.__sources.importWikiSource();
    const form = f.dialogs[0];
    f.node(form, '#zq-imp-title').value = '粘贴资料';
    f.node(form, '#zq-imp-content').value = '粘贴正文';
    f.node(form, '#zq-imp-type').value = 'NOTE';
    f.node(form, '#zq-imp-ok').onclick();
    await f.settle();
    assert.ok(f.dialogs.some(dialog => dialog.bodyHtml.includes(f.saved.content)), '粘贴后没有来源正文视图');
    assert.deepEqual(f.posts.map(call => call.path), ['/knowledge/sources']);
  });
  await test('已有来源可重新查看，列表不是仅显示最新一次的临时提示', async () => {
    const f = fixture(module);
    assert.equal(typeof module.__sources.showWikiSources, 'function', '缺少持久的来源记录入口');
    await module.__sources.showWikiSources();
    await f.settle();
    assert.ok(f.gets.some(path => path.startsWith('/knowledge/sources?')));
    assert.ok(f.dialogs.at(-1).bodyHtml.includes(f.saved.title));
    assert.equal(f.posts.length, 0);
  });
  await test('只有点击生成变更才创建PENDING草稿，仍需确认合入', async () => {
    const f = fixture(module);
    assert.equal(typeof module.__sources.showWikiSource, 'function', '缺少来源详情和草稿动作');
    await module.__sources.showWikiSource(77);
    await f.settle();
    const detail = f.dialogs.at(-1);
    f.node(detail, '#zq-source-draft').onclick();
    assert.ok(f.node(detail, '#zq-source-draft').disabled, '提交生成期间必须禁用按钮');
    f.node(detail, '#zq-source-draft').onclick();
    await f.settle();
    assert.deepEqual(f.posts.map(call => call.path), ['/knowledge/sources/77/patch-set']);
    assert.ok(f.dialogs.at(-1).bodyHtml.includes('确认合入'));
    assert.ok(f.dialogs.at(-1).bodyHtml.includes(f.saved.content));
    assert.ok(f.badge.textContent.includes('1'));
  });
  await test('来源正文按只读文本展示，不执行导入的HTML', async () => {
    const f = fixture(module);
    f.saved.content = '</pre><script>window.stolen=1</script>';
    assert.equal(typeof module.__sources.showWikiSource, 'function', '缺少来源详情视图');
    await module.__sources.showWikiSource(77);
    await f.settle();
    const html = f.dialogs.at(-1).bodyHtml;
    assert.ok(html.includes('&lt;/pre&gt;&lt;script&gt;window.stolen=1&lt;/script&gt;'));
    assert.ok(!html.includes('<script>window.stolen=1</script>'));
    assert.equal(f.posts.length, 0);
  });
  await test('来源记录可以翻页，不把20条当成全部', async () => {
    const f = fixture(module, { total: 41 });
    assert.equal(typeof module.__sources.showWikiSources, 'function', '缺少来源分页入口');
    await module.__sources.showWikiSources();
    await f.settle();
    const first = f.dialogs.at(-1);
    assert.ok(first.bodyHtml.includes('第 1 / 3 页'));
    f.node(first, '#zq-sources-next').onclick();
    await f.settle();
    assert.ok(f.gets.includes('/knowledge/sources?page=2&size=20'));
    assert.ok(f.dialogs.at(-1).bodyHtml.includes('第 2 / 3 页'));
  });
  await test('粘贴导入双击只提交一次并且只有一个预览', async () => {
    const f = fixture(module);
    module.__sources.importWikiSource();
    const form = f.dialogs.at(-1);
    f.node(form, '#zq-imp-title').value = '双击资料';
    f.node(form, '#zq-imp-content').value = '正文';
    f.node(form, '#zq-imp-type').value = 'NOTE';
    const button = f.node(form, '#zq-imp-ok');
    button.onclick();
    assert.ok(button.disabled, '提交中的导入按钮必须禁用');
    button.onclick();
    await f.settle();
    assert.equal(f.posts.filter(item => item.path === '/knowledge/sources').length, 1);
    assert.equal(f.dialogs.filter(dialog => !dialog.closed && dialog.bodyHtml.includes('zq-source-draft')).length, 1);
  });
  await test('较慢的旧来源详情不会覆盖后来打开的详情', async () => {
    let resolveOld;
    const old = new Promise(resolve => { resolveOld = resolve; });
    const f = fixture(module, { getSource: (id, saved) => id === 77 ? old : { ...saved, id, title: '最新来源', content: '最新来源正文' } });
    const oldView = module.__sources.showWikiSource(77);
    await Promise.resolve();
    await module.__sources.showWikiSource(78);
    resolveOld(f.saved);
    await oldView; await f.settle();
    const active = f.dialogs.filter(dialog => !dialog.closed);
    assert.equal(active.length, 1, '旧请求不应叠出第二个来源弹窗');
    assert.ok(active[0].bodyHtml.includes('最新来源正文'));
  });
  await test('连开来源列表后仅保留最后一次意图，不叠弹窗', async () => {
    let resolveOld;
    const old = new Promise(resolve => { resolveOld = resolve; });
    const f = fixture(module, { total: 41, getSources: result => result.page === 1 ? old : result });
    const first = module.__sources.showWikiSources(1);
    await Promise.resolve();
    await module.__sources.showWikiSources(2);
    resolveOld({ records: [f.saved], total: 41, page: 1, size: 20 });
    await first; await f.settle();
    const active = f.dialogs.filter(dialog => !dialog.closed);
    assert.equal(active.length, 1, '连开不应留下两个来源列表');
    assert.ok(active[0].bodyHtml.includes('第 2 / 3 页'));
  });
  await test('来源生成期间重新打开同一来源不会创建第二份草稿', async () => {
    let finishDraft;
    const wait = new Promise(resolve => { finishDraft = resolve; });
    const f = fixture(module, { postDraft: () => wait });
    await module.__sources.showWikiSource(77);
    const first = f.dialogs.at(-1);
    const generation = f.node(first, '#zq-source-draft').onclick();
    await module.__sources.showWikiSource(77);
    const second = f.dialogs.at(-1), button = f.node(second, '#zq-source-draft');
    assert.ok(button.disabled, '同一来源的生成请求尚未结束，新预览也应保持忙碌');
    button.onclick();
    finishDraft({ id: 9 });
    await generation;
    await f.settle();
    assert.equal(f.posts.filter(item => item.path === '/knowledge/sources/77/patch-set').length, 1);
    assert.equal(f.dialogs.filter(dialog => !dialog.closed).length, 1);
    assert.ok(!button.disabled);
  });
  const VIEWS = { showWikiAttachments: ['/knowledge/attachments', '合同.pdf'], showWikiSources: ['/knowledge/sources?page=1&size=20', '测试导入资料'],
    runWikiLint: ['/knowledge/lint/report', '不存在的页'], showWikiGraph: ['/knowledge/graph', '官网改版'], showWikiPatchSets: ['/knowledge/patch-sets?status=PENDING', '没有待合入的变更'] };
  function gated() {
    const waiting = [];
    return { waiting, gate: () => new Promise((resolve, reject) => waiting.push({ resolve, reject })),
      release() { waiting.splice(0).forEach(item => item.resolve()); }, fail() { waiting.splice(0).forEach(item => item.reject(new Error('网络断了'))); } };
  }
  await test('查看类按钮点下去当场开弹窗写「正在加载…」，数据到了填进同一个弹窗（不再先等服务器）', async () => {
    for (const [name, [path, shown]] of Object.entries(VIEWS)) {
      const g = gated(); const f = fixture(module, { gate: g.gate });
      const done = module.__sources[name]();
      assert.equal(f.dialogs.length, 1, name + '：点下去之后、服务器回来之前没有弹窗');
      assert.ok(f.dialogs[0].bodyHtml.includes('正在加载'), name + '：弹窗里没说正在加载');
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(f.gets.includes(path), name + '：没发请求');
      g.release(); await done; await f.settle();
      assert.equal(f.dialogs.length, 1, name + '：数据到了又开了一个弹窗');
      // 附件列表画在列表那一格里（搜索时只重画那一格）
      const filled = name === 'showWikiAttachments' ? f.node(f.dialogs[0], '#zq-attachment-list').innerHTML : f.dialogs[0].bodyHtml;
      assert.ok(!f.dialogs[0].bodyHtml.includes('正在加载') && filled.includes(shown), name + '：数据没填进开着的那个弹窗');
      f.closeAll();
    }
  });
  await test('加载失败关掉那个弹窗；数据回来之前关掉的不再填；加载中再点不开第二个', async () => {
    for (const name of Object.keys(VIEWS)) {
      const g = gated(); const f = fixture(module, { gate: g.gate });
      const failed = module.__sources[name]();
      await new Promise(resolve => setImmediate(resolve));
      g.fail(); await failed.catch(() => {}); await f.settle().catch(() => {});
      assert.ok(f.dialogs[0].closed, name + '：加载失败，「正在加载…」的弹窗还开着');
      const g2 = gated(); const f2 = fixture(module, { gate: g2.gate });
      const late = module.__sources[name]();
      await new Promise(resolve => setImmediate(resolve));
      f2.dialogs.at(-1).handle.close();
      g2.release(); await late; await f2.settle();
      assert.ok(f2.dialogs.at(-1).bodyHtml.includes('正在加载'), name + '：关掉之后数据回来又填进去了');
      assert.equal(f2.dialogs.filter(dialog => !dialog.closed).length, 0, name + '：关掉之后又开了弹窗');
      if (name === 'showWikiSources') continue;   // 来源记录：再点就是「最后一次意图」（上面那条），换成新的一页
      const g3 = gated(); const f3 = fixture(module, { gate: g3.gate });
      const first = module.__sources[name](); const second = module.__sources[name]();
      await new Promise(resolve => setImmediate(resolve));
      g3.release(); await first; await second; await f3.settle();
      assert.equal(f3.dialogs.length, 1, name + '：加载中再点开了第二个弹窗');
      f3.closeAll();
    }
  });
  await test('健康检查照后端的报告说：悬空链接（哪一页里的哪个链接）、孤立页、重复标题各自列出来；没有来源不算问题；全空才说没问题', async () => {
    const f = fixture(module);
    await module.__sources.runWikiLint(); await f.settle();
    const html = f.dialogs[0].bodyHtml;
    assert.match(html, /发现 3 个问题/);
    assert.ok(html.includes('官网改版') && html.includes('不存在的页'), '悬空链接没说是哪一页里的哪个链接：' + html);
    assert.ok(html.includes('没人链的页') && html.includes('周报'), html);
    assert.ok(!html.includes('未发现问题'), html);
    f.closeAll();
    const clean = fixture(module, { lint: { missingTargets: [], orphanPages: [], duplicateTitles: [], stalePlans: [], unsourcedPages: [{ id: 3, title: '官网改版' }] } });
    await module.__sources.runWikiLint(); await clean.settle();
    assert.ok(clean.dialogs[0].bodyHtml.includes('未发现问题'), clean.dialogs[0].bodyHtml);
    clean.closeAll();
  });
  await test('待合入变更：列表和角标用同一次请求', async () => {
    const f = fixture(module);
    await module.__sources.showWikiPatchSets(); await f.settle();
    assert.equal(f.dialogs.length, 1);
    assert.equal(f.gets.filter(path => path === '/knowledge/patch-sets?status=PENDING').length, 1, '为了角标又发了一次同样的请求');
    f.closeAll();
  });
  console.log(failures ? 'RED: ' + failures : 'ALL-GREEN');
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
