// 输入框里的 / 命令（第一百一十八轮）—— 直接 import 发布的 assets/pages/ai-assistant.js。
//
//   用法：node src/test/resources/js/slash-check.js <assets 目录>
//   用户 2026-11-07：「在网页里输入/ 可以向上拉出页面显示/ 什么的作用，并且也能作为正常命令」「/init 这类在网页里输入的时候颜色要和其他文字区分开」。
//   盯的是：只有第一个词正好是命令才算（「/usr/bin 有问题」照常发）；面板边打边筛、上下键、Tab 补全、回车执行、Esc 收起；选拼音的回车不算；
//   命令那一段上色且内容转义；参数不对字留着；/init、/review 差什么说什么、不叫模型；能发的时候请求里带着 codeCommand；服务器上不列要文件夹的。
//   由 AiComposerTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const assert = require('assert/strict');
const path = require('path');

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

class El {
  constructor(sel) {
    this.sel = sel; this.attrs = {}; this.dataset = {}; this.style = {}; this.listeners = {}; this.hidden = false; this.value = ''; this.scrollTop = 0; this.scrollHeight = 44; this.clicks = 0;
    this._classes = new Set();
    this.classList = { add: (...c) => c.forEach((x) => this._classes.add(x)), remove: (...c) => c.forEach((x) => this._classes.delete(x)), contains: (c) => this._classes.has(c),
      toggle: (c, on) => { const v = on === undefined ? !this._classes.has(c) : on; if (v) this._classes.add(c); else this._classes.delete(c); return v; } };
    this._html = '';
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener() {}
  dispatchEvent(e) { (this.listeners[e.type] || []).forEach((f) => f(e)); return true; }
  focus() { globalThis.document.activeElement = this; }
  click() { this.clicks++; if (this.onclick) this.onclick({}); }
  contains(x) { return x === this; }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild(x) { return x; }
  scrollTo() {}
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
}

let els, toasts, puts, sent, state, keyPrefs;
function $(sel) {
  if (!(sel in els)) els[sel] = new El(sel);
  return els[sel];
}
// 面板的每一行从 HTML 里认出来：判据看的是发布的那段 HTML，不是实现里的变量
function menuRows() {
  const menu = $('#zq-slash-menu');
  if (menu.hidden) return [];
  return [...menu.innerHTML.matchAll(/data-slash-i="(\d+)" aria-selected="(true|false)"><span class="zq-slash-name">([^<]*)<\/span>/g)]
    .map((m) => ({ i: Number(m[1]), selected: m[2] === 'true', name: m[3].replace(/&#39;/g, "'") }));
}
const names = () => menuRows().map((r) => r.name);
const selected = () => { const r = menuRows().find((x) => x.selected); return r && r.name; };
function $all(sel, host) {
  if (sel === '[data-slash-i]') {
    return menuRows().map((r) => { const b = new El('row' + r.i); b.setAttribute = (k, v) => { if (k === 'aria-selected') {
      const menu = $('#zq-slash-menu');
      menu._html = menu._html.replace(new RegExp('(data-slash-i="' + r.i + '" aria-selected=")(true|false)'), '$1' + v);
    } }; return b; });
  }
  return [];
}

const draft = () => $('#zq-draft');
function type(text) {
  draft().focus();
  draft().value = text;
  draft().dispatchEvent(new Event('input'));
}
function key(name, extra = {}) {
  let prevented = false;
  const e = { type: 'keydown', key: name, target: draft(), preventDefault() { prevented = true; }, stopImmediatePropagation() {}, ...extra };
  (draft().listeners.keydown || []).forEach((f) => f(e));
  return prevented;
}

let mod;
function status(s) { mod.paintWorkspaceBar(Object.assign({ selectedMode: 'READ', selectedRoot: '/p', enabled: true }, s)); }
function fresh(wsOverride) {
  els = {}; toasts = []; puts = []; sent = []; keyPrefs = {};
  state = { user: { id: 1 }, notebookId: 5, pendingSources: [], messages: [], chatDraft: null, aiSending: false, aiNoModel: false };
  const api = { put: async (p, b) => { puts.push({ path: p, body: b }); return Object.assign({ selectedMode: b.mode, selectedRoot: b.root, enabled: true }); },
    get: async () => null, post: async () => null };
  mod.bind({ API: '/api', REQUEST_TIMEOUT_MS: 1000, api, token: () => 't', role: () => 'USER', requestError: (m) => new Error(m), redirectToLogin() {}, nowMs: () => 0, serverTime: () => 0,
    state, esc, $, $all, empty: () => '', safe: async (n, f) => { try { return await f(); } catch (e) { return undefined; } }, toast: (t, k) => toasts.push({ t, k }), notice: () => {},
    askConfirm: async () => true, askText: async () => '', openModal() {}, popMenu() {}, drafts: { clearIf() {} }, keepDraft: () => ({ flush() {}, key: () => 'k' }), freqLabel: () => '',
    normalizeModelList: (x) => x, renderMarkdown: (t) => esc(t), renderMathIn() {}, icon: () => '<svg></svg>' });
  const sel = $('#zq-model');
  sel.options = [{ value: '', textContent: '默认模型' }, { value: '11', textContent: 'DeepSeek Pro' }, { value: '12', textContent: 'DeepSeek Flash' }, { value: '13', textContent: 'Claude' }];
  $('#zq-web').dataset.on = '0';
  mod.bindSlash(draft());
  status(wsOverride);
}

let failed = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n', e.message); } };
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {}, createElement: (t) => new El(t), getElementById: (id) => $('#' + id) };
  globalThis.localStorage = { getItem: (k) => (k in keyPrefs ? keyPrefs[k] : null), setItem: (k, v) => { keyPrefs[k] = v; }, removeItem: (k) => { delete keyPrefs[k]; } };
  globalThis.window = globalThis;
  globalThis.location = { search: '', pathname: '/ai-assistant.html' };
  globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); throw new Error('不用真发'); };
  mod = await import('file://' + path.resolve(process.argv[2], 'pages', 'ai-assistant.js'));
  fresh();

  await check('只有第一个词正好是命令才算：路径、别的斜杠开头、大写、开头有空格都是普通的话', () => {
    for (const t of ['/usr/bin 有问题', '/review/foo.js 这个文件', '/nothing', '/Mode plan', ' /new', '看看 /review', '/']) assert.equal(mod.parseSlash(t), null, t);
    assert.equal(mod.parseSlash('/review').def.name, '/review');
    assert.equal(mod.parseSlash('/review --base main 看并发').rest, '--base main 看并发');
    assert.equal(mod.parseSlash('/mode plan  ').rest, 'plan');
    assert.equal(mod.parseSlash('/review\n第二行').rest, '第二行');
  });

  await check('不接参数的命令后面跟了字：是一句话（「/init 是什么意思」）', () => {
    for (const t of ['/init 是什么意思', '/new 这个命令干什么', '/help me']) assert.equal(mod.parseSlash(t), null, t);
    assert.equal(mod.parseSlash('/init  ').def.name, '/init');
  });

  await check('打 / 拉出全部命令，每一项有名字和作用；边打边筛；对不上就收起', () => {
    fresh();
    type('/');
    assert.deepEqual(names(), ['/mode', '/effort', '/model', '/project', '/web', '/new', '/init', '/review', '/help']);
    assert.ok($('#zq-slash-menu').innerHTML.includes('只读地审查改动'), '要写作用');
    assert.equal(selected(), '/mode');
    type('/mo');
    assert.deepEqual(names(), ['/mode', '/model']);
    type('/re');
    assert.deepEqual(names(), ['/review']);
    type('/usr');
    assert.equal($('#zq-slash-menu').hidden, true);
    type('普通的话');
    assert.equal($('#zq-slash-menu').hidden, true);
    type('/mode\n');
    assert.equal($('#zq-slash-menu').hidden, true, '两行了不是在打命令');
  });

  await check('上下键选（到头绕回去），不往输入框里跑光标；Esc 收起，同样的字不再拉出，接着打才拉出', () => {
    fresh();
    type('/');
    assert.ok(key('ArrowDown'));
    assert.equal(selected(), '/effort');
    assert.equal(draft().attrs['aria-activedescendant'], 'zq-slash-1');
    assert.ok(key('ArrowUp')); assert.ok(key('ArrowUp'));
    assert.equal(selected(), '/help');
    assert.ok(key('Escape'));
    assert.equal($('#zq-slash-menu').hidden, true);
    assert.equal(draft().value, '/', 'Esc 不动字');
    draft().dispatchEvent(new Event('focus'));
    assert.equal($('#zq-slash-menu').hidden, true, '又聚焦一次也不该拉出');
    assert.equal(key('Escape'), false, '收着的时候 Esc 不归这里管');
    type('/m');
    assert.deepEqual(names(), ['/mode', '/model']);
  });

  await check('失焦收起，回来接着显示', () => {
    fresh();
    type('/');
    draft().dispatchEvent(new Event('blur'));
    assert.equal($('#zq-slash-menu').hidden, true);
    draft().dispatchEvent(new Event('focus'));
    assert.equal($('#zq-slash-menu').hidden, false);
  });

  await check('Tab 补全：要参数的留一个空格接着打，能选的列出来，不接参数的不留空格', () => {
    fresh();
    type('/mo');
    assert.ok(key('Tab'));
    assert.equal(draft().value, '/mode ');
    assert.deepEqual(names(), ['/mode close', '/mode plan', '/mode manual', '/mode auto']);
    type('/mode m');
    assert.deepEqual(names(), ['/mode manual']);
    type('/ini');
    key('Tab');
    assert.equal(draft().value, '/init');
    type('/effort m');
    assert.deepEqual(names(), ['/effort medium', '/effort max']);
    type('/model deep');
    assert.deepEqual(names(), ['/model DeepSeek Pro', '/model DeepSeek Flash']);
    type('/review --base');
    assert.equal($('#zq-slash-menu').hidden, true, '说明是随便写的，没有可选的');
  });

  await check('选拼音的回车不算；Shift + 回车是换行；普通的话回车换行（不抢）', () => {
    fresh();
    type('/mo');
    assert.equal(key('Enter', { isComposing: true }), false);
    assert.equal(key('Enter', { keyCode: 229 }), false);
    assert.equal(draft().value, '/mo');
    assert.equal(key('Enter', { shiftKey: true }), false);
    type('/usr/bin 有问题');
    assert.equal(key('Enter'), false, '不是命令：回车还是换行');
    type('普通的话');
    assert.equal(key('Enter'), false);
    assert.equal(puts.length + sent.length, 0);
  });

  await check('/mode：回车就切（只发一个请求）；不带参数拉出档位面板；参数不对说清楚、字留着、不发请求', async () => {
    fresh();
    type('/mode m');
    assert.ok(key('Enter'));
    await tick();
    assert.deepEqual(puts.map((p) => [p.path, p.body.mode, p.body.root]), [['/workspace/settings', 'WRITE', '/p']]);
    assert.equal(draft().value, '', '做完了清掉');
    fresh();
    $('#zq-tier-menu').hidden = true;
    type('/mode');
    assert.ok(key('Enter'));
    assert.equal($('#zq-tier-menu').hidden, false);
    assert.equal(puts.length, 0);
    fresh();
    type('/mode 随便');
    assert.ok(key('Enter'));
    assert.equal(draft().value, '/mode 随便');
    assert.match(toasts[0].t, /close、plan、manual、auto.*随便/);
    assert.equal(toasts[0].k, 'error');
    assert.equal(puts.length, 0);
  });

  await check('/effort、/web、/new、/help 走现有的功能', () => {
    fresh();
    type('/effort max');
    key('Enter');
    assert.equal($('#zq-effort-name').textContent, 'max');
    assert.match(Object.values(keyPrefs)[0], /"effort":"max"/, '和按钮一样记下来');
    assert.equal(draft().value, '');
    type('/effort 乱写');
    key('Enter');
    assert.equal(draft().value, '/effort 乱写');
    type('/web');
    key('Enter');
    assert.equal($('#zq-web').dataset.on, '1');
    type('/web on');
    key('Enter');
    assert.equal($('#zq-web').dataset.on, '1', '已经开着，on 不该关掉');
    type('/web off');
    key('Enter');
    assert.equal($('#zq-web').dataset.on, '0');
    type('/new');
    key('Enter');
    assert.equal($('#zq-new-notebook').clicks, 1);
    type('/help');
    key('Enter');
    assert.equal(draft().value, '/');
    assert.equal(names().length, 9, '/help 列出全部');
  });

  await check('/model：唯一对得上就切；几个都对得上、一个都没有都说清楚，不乱切', () => {
    fresh();
    type('/model flash');
    key('Enter');
    assert.equal($('#zq-model').value, '12');
    assert.match(Object.values(keyPrefs)[0], /"model":"12"/);
    fresh();
    type('/model claude');
    key('Enter');
    assert.equal($('#zq-model').value, '13', '面板里的选项不分大小写');
    fresh();
    $('#zq-model').value = '13';
    type('/model deep');
    key('Escape');
    key('Enter');
    assert.equal($('#zq-model').value, '13');
    assert.match(toasts[0].t, /DeepSeek Pro、DeepSeek Flash/);
    assert.equal(draft().value, '/model deep');
    fresh();
    type('/model 没有');
    key('Enter');
    assert.match(toasts[0].t, /没有叫 没有 的模型/);
  });

  await check('/project：路径才切；一句话不切、字留着；不带参数拉出项目面板', async () => {
    fresh();
    type('/project /tmp/x');
    key('Enter');
    await tick();
    assert.deepEqual(puts.map((p) => [p.body.mode, p.body.root]), [['READ', '/tmp/x']]);
    fresh();
    type('/project 这个目录怎么样');
    key('Enter');
    assert.equal(puts.length, 0);
    assert.equal(draft().value, '/project 这个目录怎么样');
    assert.match(toasts[0].t, /绝对路径/);
    fresh();
    type('/project "/tmp/有 空格"');
    key('Enter');
    await tick();
    assert.equal(puts[0].body.root, '/tmp/有 空格');
    fresh();
    $('#zq-ws-menu').hidden = true;
    $('#zq-ws-menu').contains = () => false;
    type('/project');
    key('Enter');
    assert.equal($('#zq-ws-menu').hidden, false);
    assert.equal(puts.length, 0);
  });

  await check('/init、/review 差什么说什么，不叫模型，字留着（切好了接着发）', async () => {
    const cases = [
      [{ selectedMode: 'OFF', selectedRoot: '/p', enabled: false }, '/review', /代码模式关着.*\/mode plan/],
      [{ selectedMode: 'OFF', selectedRoot: '/p', enabled: false }, '/init', /代码模式关着.*\/mode manual/],
      [{ selectedRoot: '' }, '/review', /要先选项目.*\/project/],
      [{ selectedRoot: '', selectedMode: 'WRITE' }, '/init', /要先选项目/],
      [{ selectedMode: 'READ' }, '/init', /plan 是只读的/],
      [{ enabled: false, reason: '文件夹不存在了' }, '/review', /没有生效.*文件夹不存在了/],
      [{ artifactOnly: true, selectedRoot: '' }, '/review', /服务器上没有项目文件夹/],
    ];
    for (const [ws, text, expected] of cases) {
      fresh(ws);
      type(text);
      key('Enter');
      await tick();
      assert.equal(sent.length, 0, text + ' 不该发');
      assert.match(toasts[0] ? toasts[0].t : '', expected, text);
      assert.equal(draft().value, text);
    }
  });

  await check('能发的时候：请求里带着 codeCommand，用户看到的还是打的那句', async () => {
    fresh();
    type('/review --base main 看并发');
    key('Enter');
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.message, '/review --base main 看并发');
    assert.equal(sent[0].body.contextOptions.codeCommand, 'review');
    assert.equal(sent[0].body.contextOptions.codeMode, true);
    fresh({ selectedMode: 'WRITE' });
    type('/init');
    key('Enter');
    await tick();
    assert.equal(sent[0].body.contextOptions.codeCommand, 'init');
    fresh({ selectedMode: 'READ' });
    type('/review 第一行\n第二行');
    assert.equal(key('Enter'), false, '两行以上回车还是换行');
    assert.equal(sent.length, 0);
    await mod.sendAiMessage();
    assert.equal(sent[0].body.contextOptions.codeCommand, 'review');
  });

  await check('⌘/Ctrl + 回车：普通的话照常发；面板开着时选命令，只算一次', async () => {
    fresh();
    type('普通的话');
    assert.ok(key('Enter', { metaKey: true }));
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.message, '普通的话');
    fresh();
    type('/usr/bin 有问题');
    assert.ok(key('Enter', { ctrlKey: true }));
    await tick();
    assert.equal(sent[0].body.message, '/usr/bin 有问题');
    fresh({ selectedRoot: '' });
    type('/re');
    assert.ok(key('Enter', { metaKey: true }));
    await tick();
    assert.equal(sent.length, 0, '/re 不能当一句话发出去');
    assert.equal(toasts.length, 1, '只提示一次：两处按键处理的话会各来一遍');
    assert.match(toasts[0].t, /要先选项目/);
  });

  await check('不是命令的话：照常发，不带 codeCommand', async () => {
    fresh();
    type('/usr/bin 有问题');
    await mod.sendAiMessage();
    assert.equal(sent[0].body.message, '/usr/bin 有问题');
    assert.equal(sent[0].body.contextOptions.codeCommand, undefined);
    fresh();
    type('/init 是什么意思');
    await mod.sendAiMessage();
    assert.equal(sent[0].body.message, '/init 是什么意思');
    assert.equal(sent[0].body.contextOptions.codeCommand, undefined);
  });

  await check('发送中也能切档位（当场做完的不用等）；发一轮的不能（只算一次）', async () => {
    fresh();
    state.aiSending = true;
    type('/mode auto');
    key('Enter');
    await tick();
    assert.equal(puts[0].body.mode, 'EXEC');
    type('/review');
    key('Enter');
    await tick();
    assert.equal(sent.length, 0);
    assert.equal(draft().value, '/review');
  });

  await check('命令那一段上色：只有认得的命令；别的字原样；内容转义；不是命令时后面那层清空', () => {
    fresh();
    const box = $('#zq-composer'), mirror = $('#zq-draft-mirror');
    type('/init');
    assert.ok(box.classList.contains('has-command'));
    assert.equal(mirror.innerHTML, '<span class="zq-draft-cmd">/init</span>​');
    type('/review <img src=x onerror=alert(1)>\n"第二行"');
    assert.ok(mirror.innerHTML.startsWith('<span class="zq-draft-cmd">/review</span> &lt;img src=x'), mirror.innerHTML);
    assert.ok(!mirror.innerHTML.includes('<img'));
    assert.ok(mirror.innerHTML.endsWith('\n&quot;第二行&quot;​'), '换行要留着，末尾垫一个零宽字符');
    type('/re');
    assert.ok(!box.classList.contains('has-command'), '没打完不上色');
    assert.equal(mirror.innerHTML, '');
    type('/usr/bin 有问题');
    assert.ok(!box.classList.contains('has-command'));
    type('/init 是什么意思');
    assert.ok(!box.classList.contains('has-command'), '这是一句话，不是命令');
  });

  await check('滚动跟着输入框；发送清空后颜色层也清', async () => {
    fresh();
    type('/review 很长');
    draft().scrollTop = 40;
    draft().dispatchEvent(new Event('scroll'));
    assert.equal($('#zq-draft-mirror').scrollTop, 40);
    fresh();
    type('/review 很长');
    const box = $('#zq-composer');
    assert.ok(box.classList.contains('has-command'));
    state.aiSending = false;
    const p = mod.sendAiMessage();
    assert.equal($('#zq-draft').value, '', '发出去的那一刻字就清了');
    assert.ok(!box.classList.contains('has-command'), '清了字还上着色：输入框的字是透明的，下一句就看不见了');
    await p;
  });

  await check('点一行就是回车（按下时不让输入框失焦，不然这一下点不到）', async () => {
    fresh();
    type('/');
    let prevented = false;
    $('#zq-slash-menu').dispatchEvent({ type: 'mousedown', preventDefault() { prevented = true; } });
    assert.ok(prevented);
    const row = new El('row');
    row.setAttribute('data-slash-i', '4');
    $('#zq-slash-menu').dispatchEvent({ type: 'click', target: { closest: () => row } });
    assert.equal($('#zq-web').dataset.on, '1', '第 5 行是 /web');
    assert.equal(draft().value, '');
  });

  await check('服务器上（只有产物）：要文件夹的不列', () => {
    fresh({ artifactOnly: true, selectedRoot: '' });
    type('/');
    assert.deepEqual(names(), ['/mode', '/effort', '/model', '/web', '/new', '/help']);
    type('/project /tmp');
    key('Enter');
    assert.equal(puts.length, 0);
    assert.match(toasts[0].t, /服务器上没有项目文件夹/);
  });

  if (failed) { console.log(failed + ' FAILED'); process.exit(1); }
  console.log('ALL-GREEN');
})().catch((e) => { console.error(e); process.exit(1); });
