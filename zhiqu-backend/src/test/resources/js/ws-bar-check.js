// 代码工作区的项目和档位（第一百零三、一百零五轮）—— 从发布的 assets/pages/ai-assistant.js 里抠出那一段真跑（假的最小 DOM、假的接口）。
//
//   用法：node src/test/resources/js/ws-bar-check.js <ai-assistant.js 的路径>
//   用户 2026-11-02：「在输入框上方选择项目」「模式的名字改成plan，auto，manual，close」；
//   2026-11-05：「点击选择文件夹应该直接打开系统的文件夹和文件页面」「档位切换有明显卡顿，放在输入框下方，点击向上拉起切换档位的面板」。
//   盯的是：点档位按钮拉起面板；选了面板马上收、名字马上变（不等网络）、只发一个请求（回来的状态直接画，不再读设置、读文件树）；
//   在途时最后选的生效；失败照后端重画；选文件夹弹系统的框（后端），取消什么都不做，弹不了才退回页面里的；close 选项目开成 plan；
//   没生效时照后端的原因说；最近的项目；Esc、点别处、上下键。
//   由 AiComposerTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const assert = require('assert/strict');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('// ───────────────────────── 代码工作区：选项目、切档位');
const b = src.indexOf('// 文件夹选择器：走后端 /workspace/browse 一层层点进去。', a);
if (a < 0 || b < 0) throw new Error('抠不到那一段');
const body = src.slice(a, b);

function node(attrs = {}) {
  const at = { ...attrs };
  return {
    hidden: false, textContent: '', title: '', onclick: null, focused: 0,
    getAttribute: (k) => (k in at ? at[k] : null), setAttribute: (k, v) => { at[k] = String(v); }, removeAttribute: (k) => { delete at[k]; },
    contains(x) { return x === this; }, focus() { this.focused++; doc.activeElement = this; },
  };
}
let doc;

function setup({ status, storage } = {}) {
  const listeners = {};
  doc = { activeElement: null, addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); } };
  const bar = node(), tierPick = node(), project = node({ 'aria-expanded': 'false' }), projectName = node(), note = node(), tier = node({ 'aria-expanded': 'false' }), tierName = node();
  let tierItems = [], projectItems = [], browse = null;
  const tierMenu = node(); tierMenu.hidden = true;
  Object.defineProperty(tierMenu, 'innerHTML', { set(html) {
    this._html = html;
    tierItems = [...html.matchAll(/data-ws-mode="(\w+)" aria-checked="(true|false)">.*?zq-tier-item-name">([^<]*)<.*?zq-tier-item-desc">([^<]*)</g)]
      .map((m) => Object.assign(node({ 'data-ws-mode': m[1], 'aria-checked': m[2] }), { name: m[3], desc: m[4] }));
  }, get() { return this._html; } });
  const projectMenu = node(); projectMenu.hidden = true;
  Object.defineProperty(projectMenu, 'innerHTML', { set(html) {
    this._html = html;
    projectItems = [...html.matchAll(/data-ws-root="([^"]*)"( aria-current="true")?/g)].map((m) => Object.assign(node({ 'data-ws-root': m[1] }), { current: !!m[2] }));
    browse = /data-ws-browse/.test(html) ? node() : null;
  }, get() { return this._html; } });
  const itemsOf = (menu) => (menu === tierMenu ? tierItems : [...projectItems, ...(browse ? [browse] : [])]);
  const elements = { '#zq-ws-bar': bar, '#zq-tier-pick': tierPick, '#zq-ws-project': project, '#zq-ws-project-name': projectName, '#zq-ws-bar-note': note, '#zq-tier': tier, '#zq-tier-name': tierName, '#zq-tier-menu': tierMenu, '#zq-ws-menu': projectMenu };
  const puts = [], posts = [], pending = [], loads = [], pagePicker = [], toasts = [];
  const replies = { failNext: false, pick: null, server: (body) => ({ selectedMode: body.mode, selectedRoot: body.root, enabled: body.mode !== 'OFF', reason: null }) };
  const fakes = {
    document: doc,
    localStorage: storage || (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; })(),
    $: (sel, root) => {
      if (root) {
        if (sel === '[data-ws-browse]') return browse;
        if (sel === '[aria-checked="true"]') return tierItems.find((i) => i.getAttribute('aria-checked') === 'true') || null;
        if (sel === '[aria-current="true"]') return projectItems.find((i) => i.current) || null;
        return itemsOf(root)[0] || null;
      }
      return elements[sel] || null;
    },
    $all: (sel, root) => (sel === '[data-ws-mode]' ? tierItems : sel === '[data-ws-root]' ? projectItems : sel === 'button' ? itemsOf(root) : []),
    esc: (v) => String(v).replace(/"/g, '&quot;'), icon: () => '', toast: (m) => toasts.push(m),
    safe: async (_n, fn) => { try { return await fn(); } catch (e) { toasts.push(e.message); } },
    api: {
      put: (path, body) => { puts.push(body); const fail = replies.failNext; replies.failNext = false; return new Promise((res, rej) => pending.push(() => (fail ? rej(new Error('后端拒了')) : res(replies.server(body))))); },
      post: (path, body, headers, options) => { posts.push({ path, body, options }); return new Promise((res) => pending.push(() => res(replies.pick))); },
    },
    loadWorkspace: async () => { loads.push(puts.length); },
    openWorkspaceFolderPicker: (start, onPick) => pagePicker.push({ start, onPick }),
  };
  const names = Object.keys(fakes);
  const api = new Function(...names, body + '\nreturn { paintWorkspaceBar, codeModeOn, recentProjects, rememberProject, projectName, WS_MODE_NAME, WS_MODE_DESC, WS_PICK_TIMEOUT_MS };')(...names.map((n) => fakes[n]));
  const settle = async () => { for (let i = 0; i < 20; i++) { while (pending.length) pending.shift()(); await new Promise((r) => setImmediate(r)); } };
  const openTier = () => { tier.onclick(); return tierItems; };
  const choose = (m) => { if (tierMenu.hidden) tier.onclick(); tierItems.find((x) => x.getAttribute('data-ws-mode') === m).onclick(); };
  if (status) api.paintWorkspaceBar(status);
  return { api, bar, tierPick, project, projectName, note, tier, tierName, tierMenu, projectMenu, puts, posts, pending, loads, pagePicker, toasts, listeners, replies, settle, openTier, choose,
    projectItems: () => projectItems, browse: () => browse, tierItems: () => tierItems };
}

let failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const on = { selectedMode: 'READ', selectedRoot: '/w/a', enabled: true };

check('名字照用户定的：close / plan / manual / auto 对着 OFF / READ / WRITE / EXEC，面板里按能力从小到大，每档一句说明', () => {
  const t = setup({ status: on });
  assert.deepEqual(t.api.WS_MODE_NAME, { OFF: 'close', READ: 'plan', WRITE: 'manual', EXEC: 'auto' });
  assert.deepEqual(t.openTier().map((i) => [i.getAttribute('data-ws-mode'), i.name]), [['OFF', 'close'], ['READ', 'plan'], ['WRITE', 'manual'], ['EXEC', 'auto']]);
  assert.ok(t.tierItems().every((i) => i.desc.length > 8), '每档要有一句说明');
});

check('画出来：按钮写当前这一档、项目名是文件夹名（完整路径在悬停说明里）、没选项目写「选择项目」；不是管理员两处都不露', () => {
  const t = setup({ status: { selectedMode: 'WRITE', selectedRoot: '/Users/me/code/game/', enabled: true } });
  assert.equal(t.bar.hidden, false);
  assert.equal(t.tierPick.hidden, false);
  assert.equal(t.tierName.textContent, 'manual');
  assert.ok(t.tier.title.includes(t.api.WS_MODE_DESC.WRITE), '悬停说明要写这一档能做什么');
  assert.equal(t.projectName.textContent, 'game');
  assert.ok(t.project.title.includes('/Users/me/code/game/'));
  t.api.paintWorkspaceBar({ selectedMode: 'OFF', selectedRoot: '', enabled: false });
  assert.equal(t.projectName.textContent, '选择项目');
  assert.equal(t.tierName.textContent, 'close');
  t.api.paintWorkspaceBar(null);
  assert.equal(t.bar.hidden, true, '不是管理员还露着项目');
  assert.equal(t.tierPick.hidden, true, '不是管理员还露着档位');
});

check('点档位按钮拉起面板，当前这一档标出来、焦点在它上面；再点一下收起', () => {
  const t = setup({ status: on });
  assert.equal(t.tierMenu.hidden, true);
  t.tier.onclick();
  assert.equal(t.tierMenu.hidden, false);
  assert.equal(t.tier.getAttribute('aria-expanded'), 'true');
  const checked = t.tierItems().filter((i) => i.getAttribute('aria-checked') === 'true');
  assert.deepEqual(checked.map((i) => i.getAttribute('data-ws-mode')), ['READ']);
  assert.equal(checked[0].focused, 1);
  t.tier.onclick();
  assert.equal(t.tierMenu.hidden, true);
  assert.equal(t.tier.getAttribute('aria-expanded'), 'false');
});

check('选了不等网络：面板马上收、名字马上变；只发一个请求，回来的状态直接画（原来还要再读设置、再读文件树）', async () => {
  const t = setup({ status: { selectedMode: 'OFF', selectedRoot: '/w/a', enabled: false } });
  t.replies.server = (body) => ({ selectedMode: body.mode, selectedRoot: body.root, enabled: true, reason: null });
  t.choose('EXEC');
  assert.equal(t.tierMenu.hidden, true, '面板要马上收');
  assert.equal(t.tierName.textContent, 'auto', '名字要马上变');
  assert.equal(t.api.codeModeOn(), false, '请求回来之前还不知道生效没有');
  assert.deepEqual(t.puts, [{ mode: 'EXEC', root: '/w/a' }]);
  await t.settle();
  assert.equal(t.puts.length, 1);
  assert.equal(t.loads.length, 0, '切档位不该再读一遍设置');
  assert.equal(t.api.codeModeOn(), true, '回来的状态要画上');
});

check('走不走代码模式看档位（用户：「代码按钮删掉，感觉多余了」）：生效了就走；close、没生效、不是管理员都不走；切到 close 紧接着发的那句就不走了', async () => {
  const t = setup({ status: on });
  assert.equal(t.api.codeModeOn(), true);
  t.api.paintWorkspaceBar({ selectedMode: 'OFF', selectedRoot: '/w/a', enabled: false });
  assert.equal(t.api.codeModeOn(), false, 'close 还走');
  t.api.paintWorkspaceBar({ selectedMode: 'WRITE', selectedRoot: '/w/gone', enabled: false, reason: '目录不存在' });
  assert.equal(t.api.codeModeOn(), false, '没生效还走（后端不造 CODE_AGENT，用户以为开着）');
  t.api.paintWorkspaceBar(null);
  assert.equal(t.api.codeModeOn(), false, '不是管理员还走');
  const u = setup({ status: on });
  u.choose('OFF');
  assert.equal(u.api.codeModeOn(), false, '切到 close 要马上算关了');
  await u.settle();
  assert.equal(u.api.codeModeOn(), false);
});

check('选的就是当前这一档：什么都不发', async () => {
  const t = setup({ status: on });
  t.choose('READ');
  await t.settle();
  assert.equal(t.puts.length, 0);
  assert.equal(t.tierMenu.hidden, true);
});

check('在途时又选了几下：只补发最后那一下，名字跟着最后选的走', async () => {
  const t = setup({ status: on });
  t.choose('EXEC'); t.choose('WRITE'); t.choose('OFF'); t.choose('WRITE');
  assert.equal(t.tierName.textContent, 'manual');
  assert.equal(t.puts.length, 1, '在途时又发了请求');
  await t.settle();
  assert.deepEqual(t.puts.map((p) => p.mode), ['EXEC', 'WRITE'], '最后选的那一下没生效（或者中间的也发了）');
  assert.ok(t.puts.every((p) => p.root === '/w/a'));
  assert.equal(t.tierName.textContent, 'manual');
});

check('失败了照后端重画（名字是先改的，要退回去）', async () => {
  const t = setup({ status: on });
  t.replies.failNext = true;
  t.choose('EXEC');
  await t.settle();
  assert.deepEqual(t.toasts, ['后端拒了']);
  assert.equal(t.loads.length, 1, '失败了没重新读状态，按钮停在没生效的那一档');
});

check('还没选项目就开某一档：弹系统的选文件夹框（不是页面里的），选了才发、才变名字；取消什么都不做', async () => {
  const t = setup({ status: { selectedMode: 'OFF', selectedRoot: '', enabled: false } });
  t.replies.pick = { path: '/w/new', cancelled: false, unavailable: null };
  t.choose('WRITE');
  assert.equal(t.tierName.textContent, 'close', '还没选文件夹，名字不该变');
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].path, '/workspace/pick-folder');
  assert.equal(t.pagePicker.length, 0, '应当弹系统的框，不是页面里的');
  await t.settle();
  assert.deepEqual(t.puts, [{ mode: 'WRITE', root: '/w/new' }]);
  assert.equal(t.tierName.textContent, 'manual');

  const u = setup({ status: { selectedMode: 'OFF', selectedRoot: '', enabled: false } });
  u.replies.pick = { path: null, cancelled: true, unavailable: null };
  u.choose('WRITE');
  await u.settle();
  assert.equal(u.puts.length, 0, '取消了不该发');
  assert.equal(u.pagePicker.length, 0, '取消了不该再弹页面里的');
  assert.equal(u.tierName.textContent, 'close');
});

check('等用户选的请求超时要够长（比后端 10 分钟的上限长，默认 30 秒会把开着的框算成失败）；连点只发一个', async () => {
  const t = setup({ status: { selectedMode: 'READ', selectedRoot: '', enabled: false } });
  t.replies.pick = { path: null, cancelled: true, unavailable: null };
  t.project.onclick();
  t.project.onclick();
  assert.equal(t.posts.length, 1, '连点弹了两个');
  assert.ok(t.posts[0].options.timeoutMs > 600000, `超时只有 ${t.posts[0].options.timeoutMs}`);
  await t.settle();
  t.project.onclick();
  assert.equal(t.posts.length, 2, '上一个结束了应当还能再弹');
  await t.settle();
});

check('这台机器弹不了系统的框：说一声，退回页面里的选择器；从那边选了照样生效', async () => {
  const t = setup({ status: { selectedMode: 'OFF', selectedRoot: '', enabled: false } });
  t.replies.pick = { path: null, cancelled: false, unavailable: '这台机器弹不了系统的文件夹选择框' };
  t.project.onclick();
  await t.settle();
  assert.equal(t.pagePicker.length, 1);
  assert.match(t.toasts[0], /弹不了/);
  t.pagePicker[0].onPick('/w/from-page');
  await t.settle();
  assert.deepEqual(t.puts, [{ mode: 'READ', root: '/w/from-page' }]);
});

check('选项目：档位是 close 时开成 plan，别的档位照旧；最近的项目当前的在最前、标出来，去重、最多 6 个', async () => {
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
  const t2 = setup({ status: { selectedMode: 'OFF', selectedRoot: '/w/a', enabled: false }, storage });
  t2.project.onclick();
  assert.equal(t2.projectMenu.hidden, false);
  assert.deepEqual(t2.projectItems().map((i) => [i.getAttribute('data-ws-root'), i.current]), [['/w/a', true], ['/w/2', false], ['/w/6', false], ['/w/5', false], ['/w/4', false], ['/w/3', false], ['/w/1', false]]);
  t2.projectItems()[2].onclick();
  assert.equal(t2.projectMenu.hidden, true, '选完菜单没关');
  assert.equal(t2.projectName.textContent, '6', '项目名要马上变');
  assert.equal(t2.tierName.textContent, 'plan');
  await t2.settle();
  assert.deepEqual(t2.puts, [{ mode: 'READ', root: '/w/6' }], 'close 时选项目应当开成 plan');
  assert.equal(t2.api.recentProjects()[0], '/w/6', '选过的没记到最前');
  const u = setup({ status: { selectedMode: 'EXEC', selectedRoot: '/w/a', enabled: true } });
  u.replies.pick = { path: '/w/b', cancelled: false, unavailable: null };
  u.project.onclick(); u.browse().onclick();
  assert.equal(u.projectMenu.hidden, true);
  assert.equal(u.posts[0].body.start, '/w/a', '选文件夹应当从当前项目开始');
  await u.settle();
  assert.deepEqual(u.puts, [{ mode: 'EXEC', root: '/w/b' }], '换项目把档位改了');
});

check('点菜单里当前这个项目：档位开着就什么都不发；close 时开成 plan', async () => {
  const t = setup({ status: on });
  t.project.onclick();
  t.projectItems()[0].onclick();
  await t.settle();
  assert.equal(t.puts.length, 0, '没换项目不该发');
  assert.equal(t.projectMenu.hidden, true);
  const u = setup({ status: { selectedMode: 'OFF', selectedRoot: '/w/a', enabled: false } });
  u.project.onclick();
  u.projectItems()[0].onclick();
  await u.settle();
  assert.deepEqual(u.puts, [{ mode: 'READ', root: '/w/a' }]);
});

check('一个项目都没有：点项目按钮直接弹框（菜单里只会有「选择文件夹…」一项）', async () => {
  const t = setup({ status: { selectedMode: 'OFF', selectedRoot: '', enabled: false } });
  t.replies.pick = { path: '/w/x', cancelled: false, unavailable: null };
  t.project.onclick();
  assert.equal(t.projectMenu.hidden, true, '不该先弹菜单');
  assert.equal(t.posts.length, 1);
  await t.settle();
  assert.deepEqual(t.puts, [{ mode: 'READ', root: '/w/x' }]);
});

check('没生效（文件夹不在了、不是本机）：照后端的原因写出来，按钮不偷偷改；close 时不说', () => {
  const t = setup({ status: { selectedMode: 'WRITE', selectedRoot: '/w/gone', enabled: false, reason: '目录不存在' } });
  assert.equal(t.note.textContent, '没有生效：目录不存在');
  assert.equal(t.tierName.textContent, 'manual');
  t.api.paintWorkspaceBar({ selectedMode: 'OFF', selectedRoot: '/w/gone', enabled: false, reason: '工作区未启用' });
  assert.equal(t.note.textContent, '');
  t.api.paintWorkspaceBar({ selectedMode: 'READ', selectedRoot: '/w/a', enabled: true, reason: null });
  assert.equal(t.note.textContent, '');
});

check('面板：Esc 收起、焦点回按钮、监听拿掉；点别处收起，点面板里不收；上下键走；同时只开一个', () => {
  const t = setup({ status: on });
  t.tier.onclick();
  assert.equal((t.listeners.keydown || []).length, 1);
  t.listeners.keydown[0]({ key: 'Escape' });
  assert.equal(t.tierMenu.hidden, true);
  assert.ok(t.tier.focused >= 1, '焦点没回到按钮');
  assert.equal((t.listeners.keydown || []).length + (t.listeners.mousedown || []).length, 0, '收起了监听还挂着');

  t.tier.onclick();
  t.listeners.mousedown[0]({ target: t.tierMenu });
  assert.equal(t.tierMenu.hidden, false, '点面板里不该收');
  t.listeners.mousedown[0]({ target: {} });
  assert.equal(t.tierMenu.hidden, true, '点别处没收');

  t.tier.onclick();
  const items = t.tierItems();
  assert.equal(doc.activeElement, items[1], '焦点应当在当前这一档（plan）');
  let prevented = 0;
  t.listeners.keydown[0]({ key: 'ArrowDown', preventDefault() { prevented++; } });
  assert.equal(doc.activeElement, items[2]);
  t.listeners.keydown[0]({ key: 'ArrowUp', preventDefault() { prevented++; } });
  t.listeners.keydown[0]({ key: 'ArrowUp', preventDefault() { prevented++; } });
  t.listeners.keydown[0]({ key: 'ArrowUp', preventDefault() { prevented++; } });
  assert.equal(doc.activeElement, items[3], '从第一项往上绕到最后一项');
  assert.equal(prevented, 4);

  t.project.onclick();
  assert.equal(t.tierMenu.hidden, true, '开项目菜单时档位面板要收');
  assert.equal(t.projectMenu.hidden, false);
  assert.equal((t.listeners.keydown || []).length, 1, '监听叠了两份');
});

check('存不了最近的项目也不炸', () => {
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
