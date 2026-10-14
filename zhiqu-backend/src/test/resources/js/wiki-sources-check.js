// Exercise the published Wiki module: parsing must expose the saved source,
// drafting is a separate click, and confirmation remains the only page write.
const fs = require('fs');
const assert = require('node:assert/strict');

async function moduleUnderTest() {
  const source = fs.readFileSync(process.argv[2], 'utf8');
  const hooks = `\nexport const __sources = { importWikiSource,
    showWikiSources: typeof showWikiSources === 'function' ? showWikiSources : null,
    showWikiSource: typeof showWikiSource === 'function' ? showWikiSource : null };`;
  return import('data:text/javascript;base64,' + Buffer.from(source + hooks).toString('base64'));
}

function fixture(module, options = {}) {
  const dialogs = [], pending = [], posts = [], gets = [], notifications = [];
  const saved = { id: 77, title: '测试导入资料', sourceType: 'FILE', summary: '摘要', content: '这段解析正文应该立即可见' };
  const badge = { textContent: '', title: '', style: {} };
  let generated = false;
  function element() { return { value: '', style: {}, dataset: {}, files: [], disabled: false }; }
  function $all(selector, body) {
    if (!body) return [];
    if (selector === 'button') return [...body.nodes.values()];
    const match = /^\[([a-z-]+)\]$/.exec(selector);
    if (!match) return [];
    const key = match[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return body.data.filter(node => key in node.dataset);
  }
  function $(selector, body) {
    if (!body) return selector === '#zq-patch-btn' ? badge : null;
    return body.nodes.get(selector.replace(/^#/, '')) || null;
  }
  function openModal(spec) {
    const body = { nodes: new Map(), data: [] };
    for (const match of spec.bodyHtml.matchAll(/id="([^"]+)"/g)) body.nodes.set(match[1], element());
    for (const match of spec.bodyHtml.matchAll(/data-([a-z-]+)="([^"]+)"/g)) {
      const node = element();
      node.dataset[match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = match[2];
      body.data.push(node);
    }
    if (body.nodes.has('zq-imp-mode')) body.nodes.get('zq-imp-mode').value = 'TEXT';
    const dialog = { ...spec, body, closed: false };
    const handle = { close() { if (!dialog.closed) { dialog.closed = true; if (spec.onClose) spec.onClose(); } } };
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
    renderMarkdown: text => String(text), renderMathIn() {}, state: { wikiPages: [] }, empty: text => text
  });
  async function settle() { while (pending.length) await Promise.all(pending.splice(0)); }
  function node(dialog, id) { const result = $(id, dialog.body); assert.ok(result, 'Missing actual markup for ' + id); return result; }
  return { dialogs, posts, gets, saved, notifications, settle, node, badge };
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
  console.log(failures ? 'RED: ' + failures : 'ALL-GREEN');
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
