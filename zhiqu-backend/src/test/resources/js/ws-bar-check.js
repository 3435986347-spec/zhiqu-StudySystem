// 输入框上方的项目和档位（第一百零三轮）—— 从发布的 assets/pages/ai-assistant.js 里抠出那一段真跑（假的最小 DOM、假的接口）。
//
//   用法：node src/test/resources/js/ws-bar-check.js <ai-assistant.js 的路径>
//   用户 2026-11-02：「在输入框上方选择项目里面选择目录……几个模式档位也用按钮点击切换」「模式的名字改成plan，auto，manual，close」。
//   盯的是：点了就生效、在途时最后点的那一下生效（真鼠标快点 plan → manual 原来停在 plan）、失败了照后端重画、
//   选项目时 close 开成 plan、没选项目先选文件夹、没生效时照后端的原因说、最近的项目去重 / 最多 6 个 / 存不了不炸、Esc 关菜单。
//   由 AiComposerTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const assert = require('assert/strict');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('// ── 输入框上方的项目和档位（第一百零三轮）');
const b = src.indexOf('// 文件夹选择器：走后端 /workspace/browse 一层层点进去。', a);
if (a < 0 || b < 0) throw new Error('抠不到输入框上方那一段');
const body = src.slice(a, b);

function node(attrs = {}) {
  const at = { ...attrs };
  return {
    hidden: false, textContent: '', title: '', onclick: null, focused: 0,
    getAttribute: (k) => (k in at ? at[k] : null), setAttribute: (k, v) => { at[k] = String(v); }, removeAttribute: (k) => { delete at[k]; },
    contains: () => false, focus() { this.focused++; },
  };
}

function setup({ status, storage } = {}) {
  const bar = node(), btn = node({ 'aria-expanded': 'false' }), name = node(), note = node();
  const menu = node(); menu.hidden = true;
  let menuItems = [], browse = null;
  Object.defineProperty(menu, 'innerHTML', { set(html) {
    this._html = html;
    menuItems = [...html.matchAll(/data-ws-root="([^"]*)"( aria-current="true")?/g)].map((m) => Object.assign(node({ 'data-ws-root': m[1] }), { current: !!m[2] }));
    browse = /data-ws-browse/.test(html) ? node() : null;
  }, get() { return this._html; } });
  const modes = ['OFF', 'READ', 'WRITE', 'EXEC'].map((m) => node({ 'data-ws-mode': m, 'aria-pressed': 'false' }));
  const listeners = {};
  const document = { addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); } };
  const puts = [], pending = [], loads = [], picked = [], toasts = [];
  let failNext = false;
  const fakes = {
    document,
    localStorage: storage || (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; })(),
    $: (sel, root) => {
      if (root === menu) return sel === '[data-ws-browse]' ? browse : (menuItems[0] || browse);
      return { '#zq-ws-bar': bar, '#zq-ws-project': btn, '#zq-ws-project-name': name, '#zq-ws-bar-note': note, '#zq-ws-menu': menu }[sel] || null;
    },
    $all: (sel) => (sel === '[data-ws-mode]' ? modes : sel === '[data-ws-root]' ? menuItems : []),
    esc: (v) => String(v).replace(/"/g, '&quot;'), icon: () => '',
    safe: async (_n, fn) => { try { return await fn(); } catch (e) { toasts.push(e.message); } },
    api: { put: (path, body) => { puts.push(body); const fail = failNext; failNext = false; return new Promise((res, rej) => pending.push(() => (fail ? rej(new Error('后端拒了')) : res({})))); } },
    loadWorkspace: async () => { loads.push(puts.length); },
    openWorkspaceFolderPicker: (start, onPick) => picked.push({ start, onPick }),
  };
  const names = Object.keys(fakes);
  const api = new Function(...names, body + '\nreturn { paintWorkspaceBar, applyWorkspace, recentProjects, rememberProject, projectName, WS_MODE_NAME, WS_MODE_DESC, closeProjectMenu };')(...names.map((n) => fakes[n]));
  const flush = () => new Promise((r) => setImmediate(r));
  const settle = async () => { for (let i = 0; i < 20; i++) { while (pending.length) pending.shift()(); await flush(); } };
  const pressed = () => modes.filter((m) => m.getAttribute('aria-pressed') === 'true').map((m) => m.getAttribute('data-ws-mode'));
  const click = (m) => modes.find((x) => x.getAttribute('data-ws-mode') === m).onclick();
  if (status) api.paintWorkspaceBar(status);
  return { api, bar, btn, name, note, menu, modes, puts, pending, loads, picked, toasts, listeners, settle, flush, pressed, click,
    items: () => menuItems, browse: () => browse, fail: () => { failNext = true; } };
}

let failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('名字照用户定的：close / plan / manual / auto 对着 OFF / READ / WRITE / EXEC，悬停说明以名字开头', () => {
  const t = setup();
  assert.deepEqual(t.api.WS_MODE_NAME, { OFF: 'close', READ: 'plan', WRITE: 'manual', EXEC: 'auto' });
  for (const [m, n] of Object.entries(t.api.WS_MODE_NAME)) assert.ok(t.api.WS_MODE_DESC[m].startsWith(n + '：'), m + ' 的说明不是以 ' + n + ' 开头');
});

check('画出来：按下的是选了的档位、项目名是文件夹名（完整路径在悬停说明里）、没选项目写「选择项目」', () => {
  const t = setup({ status: { selectedMode: 'WRITE', selectedRoot: '/Users/me/code/game/', enabled: true } });
  assert.equal(t.bar.hidden, false);
  assert.deepEqual(t.pressed(), ['WRITE']);
  assert.equal(t.name.textContent, 'game');
  assert.ok(t.btn.title.includes('/Users/me/code/game/'));
  t.api.paintWorkspaceBar({ selectedMode: 'OFF', selectedRoot: '', enabled: false });
  assert.equal(t.name.textContent, '选择项目');
  t.api.paintWorkspaceBar(null);
  assert.equal(t.bar.hidden, true, '不是管理员（拿不到设置）还露着');
});

check('点档位就生效；在途时又点了几下：只补发最后那一下（原来直接丢掉），按下的样子先跟着点的走；都回来以后照后端重画一次', async () => {
  const t = setup({ status: { selectedMode: 'READ', selectedRoot: '/w/a', enabled: true } });
  t.click('EXEC');
  assert.deepEqual(t.pressed(), ['EXEC'], '点了不马上显示按下');
  assert.equal(t.bar.getAttribute('aria-busy'), 'true');
  t.click('WRITE'); t.click('OFF'); t.click('WRITE');
  assert.deepEqual(t.pressed(), ['WRITE']);
  assert.equal(t.puts.length, 1, '在途时又发了请求');
  await t.settle();
  assert.deepEqual(t.puts.map((p) => p.mode), ['EXEC', 'WRITE'], '最后点的那一下没生效（或者中间的也发了）');
  assert.ok(t.puts.every((p) => p.root === '/w/a'));
  assert.deepEqual(t.loads, [2], '都回来之后应当照后端重画一次');
  assert.equal(t.bar.getAttribute('aria-busy'), null);
});

check('失败了也照后端重画（按下的样子是先画上的，要退回去）', async () => {
  const t = setup({ status: { selectedMode: 'READ', selectedRoot: '/w/a', enabled: true } });
  t.fail();
  t.click('EXEC');
  await t.settle();
  assert.deepEqual(t.toasts, ['后端拒了']);
  assert.equal(t.loads.length, 1, '失败了没重画，按钮停在没生效的那一档');
});

check('还没选项目就开某一档：先弹选文件夹，选了才发；关掉不选什么都不发', async () => {
  const t = setup({ status: { selectedMode: 'OFF', selectedRoot: '', enabled: false } });
  t.click('WRITE');
  assert.equal(t.puts.length, 0);
  assert.equal(t.picked.length, 1, '没弹选文件夹');
  t.picked[0].onPick('/w/new');
  await t.settle();
  assert.deepEqual(t.puts, [{ mode: 'WRITE', root: '/w/new' }]);
});

check('选项目：档位是 close 时开成 plan（不然选了像没选），别的档位照旧；最近的项目当前的在最前、标出来，去重、最多 6 个', async () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const t = setup({ status: { selectedMode: 'OFF', selectedRoot: '/w/a', enabled: false }, storage });
  for (const r of ['/w/0', '/w/1', '/w/2', '/w/3', '/w/4', '/w/5', '/w/6']) t.api.rememberProject(r);   // 7 个不同的：最早的 /w/0 挤掉
  assert.equal(JSON.parse(store.get('zq.ws.recent')).length, 6, '存下来的不止 6 个（越存越多）');
  t.api.rememberProject('/w/2');   // 选过的再选一遍：挪到最前、不重复
  assert.deepEqual(t.api.recentProjects(), ['/w/2', '/w/6', '/w/5', '/w/4', '/w/3', '/w/1']);
  // 读的那一道：以前存多了的（或者别处写坏的）也只拿前 6 个、只认非空的字符串
  const old = new Map([['zq.ws.recent', JSON.stringify(['/o/1', 7, '', '/o/2', '/o/3', '/o/4', '/o/5', '/o/6', '/o/7', '/o/8'])]]);
  const u0 = setup({ storage: { getItem: (k) => old.get(k) || null, setItem() {} } });
  assert.deepEqual(u0.api.recentProjects(), ['/o/1', '/o/2', '/o/3', '/o/4', '/o/5', '/o/6']);
  t.btn.onclick();
  assert.equal(t.menu.hidden, false);
  assert.equal(t.btn.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(t.items().map((i) => [i.getAttribute('data-ws-root'), i.current]), [['/w/a', true], ['/w/2', false], ['/w/6', false], ['/w/5', false], ['/w/4', false], ['/w/3', false], ['/w/1', false]]);
  t.items()[2].onclick();
  assert.equal(t.menu.hidden, true, '选完菜单没关');
  await t.settle();
  assert.deepEqual(t.puts, [{ mode: 'READ', root: '/w/6' }], 'close 时选项目应当开成 plan');
  assert.equal(t.api.recentProjects()[0], '/w/6', '选过的没记到最前');
  const u = setup({ status: { selectedMode: 'EXEC', selectedRoot: '/w/a', enabled: true } });
  u.btn.onclick(); u.browse().onclick();
  assert.equal(u.picked[0].start, '/w/a', '选文件夹应当从当前项目开始');
  u.picked[0].onPick('/w/b');
  await u.settle();
  assert.deepEqual(u.puts, [{ mode: 'EXEC', root: '/w/b' }], '换项目把档位改了');
});

check('没生效（文件夹不在了、不是本机）：照后端的原因写在这一条下面，按钮不偷偷改；close 时不说', () => {
  const t = setup({ status: { selectedMode: 'WRITE', selectedRoot: '/w/gone', enabled: false, reason: '目录不存在' } });
  assert.equal(t.note.textContent, '没有生效：目录不存在');
  assert.deepEqual(t.pressed(), ['WRITE']);
  t.api.paintWorkspaceBar({ selectedMode: 'OFF', selectedRoot: '/w/gone', enabled: false, reason: '工作区未启用' });
  assert.equal(t.note.textContent, '');
  t.api.paintWorkspaceBar({ selectedMode: 'READ', selectedRoot: '/w/a', enabled: true, reason: null });
  assert.equal(t.note.textContent, '');
});

check('菜单：Esc 关上、焦点回到项目按钮，监听拿掉；存不了最近的项目也不炸', () => {
  const t = setup({ status: { selectedMode: 'READ', selectedRoot: '/w/a', enabled: true } });
  t.btn.onclick();
  assert.equal((t.listeners.keydown || []).length, 1);
  t.listeners.keydown[0]({ key: 'Escape' });
  assert.equal(t.menu.hidden, true);
  assert.equal(t.btn.focused, 1);
  assert.equal((t.listeners.keydown || []).length + (t.listeners.mousedown || []).length, 0, '关了菜单监听还挂着');
  const broken = setup({ storage: { getItem() { throw new Error('禁用了'); }, setItem() { throw new Error('禁用了'); } } });
  assert.deepEqual(broken.api.recentProjects(), []);
  broken.api.rememberProject('/w/x');
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
  }
  console.log(failed ? 'RED: ' + failed : 'ALL-GREEN');
  if (failed) process.exitCode = 1;
})();
