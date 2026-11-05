// AI 助手输入框下面的选择刷新后还在（第一百零七轮）—— 从发布的 assets/pages/ai-assistant.js 里抠出那一段真跑（假的最小 DOM、假的 localStorage）；
// 模型列表过发布的那份 normalizeModelList，回包照后端的形状写（{userModels, systemModels}）。
//
//   用法：node src/test/resources/js/composer-prefs-check.js <ai-assistant.js 的路径>
//   用户 2026-11-06：「每次刷新后ai助手下面的模型就会回到默认模型，深度思考等状态也没有保留，很影响体验」。
//   盯的是：模型、深度思考、联网各自记住；记的模型没了回到默认（下拉不能是空白）；列表没取回来不擦记的；按用户分开；存不了、存的是坏数据都不炸。
//   由 AiComposerTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('// ───────────────────────── 输入框下面的选择（模型、深度思考、联网）');
const b = src.indexOf('// ───────────────────────── 输入框下面的选择到此为止', a);
if (a < 0 || b < 0) throw new Error('抠不到那一段');
const shell = fs.readFileSync(path.join(path.dirname(process.argv[2]), '..', 'zhiqu-api.js'), 'utf8');
const n0 = shell.indexOf('function normalizeModelList(data) {');
const n1 = shell.indexOf('// 参考计划的分类', n0);
if (n0 < 0 || n1 < 0) throw new Error('抠不到 normalizeModelList');
const normalizeModelList = new Function(shell.slice(n0, n1) + '\nreturn normalizeModelList;')();

function memoryStore(init = {}) {
  const m = { ...init };
  return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
}
const MODELS = { userModels: [{ id: 7, displayName: 'DeepSeek', modelName: 'deepseek-chat' }, { id: 9, displayName: 'Opus', modelName: 'claude-opus-5-5' }], systemModels: [{ id: 3, displayName: '系统模型', modelName: 'sys' }] };

function toggle() {
  const at = {};
  return { dataset: {}, setAttribute: (k, v) => { at[k] = String(v); }, getAttribute: (k) => at[k] ?? null };
}
function select() {
  let options = [''], index = 0;
  return {
    onchange: null,
    get options() { return options; },
    get selectedIndex() { return index; },
    // 浏览器的行为：设成没有的值，选中项变成 -1，下拉是空白的
    get value() { return index < 0 ? '' : options[index]; },
    set value(v) { index = options.indexOf(String(v)); },
    set innerHTML(html) { options = [...html.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]); index = 0; this.html = html; },
    get innerHTML() { return this.html; },
  };
}
/** 打开一次页面。storage 是同一个对象就等于同一台浏览器；可以再 storageThrows，让 localStorage 这个名字一碰就抛（站点数据被禁用）。 */
function open({ storage, userId = 1, models = MODELS, modelsFail = false, storageThrows = false } = {}) {
  const web = toggle(), think = toggle(), sel = select();
  const state = { user: userId == null ? null : { id: userId }, messages: [{}] };
  const ids = { 'zq-web': web, 'zq-think': think };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { if (storageThrows) throw new Error('站点数据被禁用'); return storage; } });
  const names = ['state', '$', 'document', 'api', 'esc', 'normalizeModelList', 'renderAiMessages'];
  const fakes = [state, (s) => (s === '#zq-model' ? sel : null), { getElementById: (id) => ids[id] || null },
    { get: async () => { if (modelsFail) throw new Error('网络断了'); return models; } }, (v) => String(v), normalizeModelList, () => {}];
  const code = new Function(...names, src.slice(a, b) + '\nreturn { restoreAiToggles, aiToggle, loadAiModelSelect };')(...fakes);
  const page = { web, think, sel, state, code, on: (b) => b.dataset.on === '1' && b.getAttribute('aria-pressed') === 'true', off: (b) => b.dataset.on === '0' && b.getAttribute('aria-pressed') === 'false',
    pick(v) { sel.value = v; sel.onchange(); } };
  return page;
}
async function boot(opts) { const p = open(opts); p.code.restoreAiToggles(); await p.code.loadAiModelSelect(); return p; }

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('第一次进来：两个开关都关着，模型是默认', async () => {
  const p = await boot({ storage: memoryStore() });
  assert.ok(p.off(p.web) && p.off(p.think));
  assert.equal(p.sel.value, '');
  assert.equal(p.sel.selectedIndex, 0);
});

check('深度思考按下、刷新还按着；联网不跟着变；再按一下关掉、刷新还关着', async () => {
  const storage = memoryStore();
  let p = await boot({ storage });
  p.code.aiToggle('think');
  assert.ok(p.on(p.think), '按下去当场就要变');
  p = await boot({ storage });
  assert.ok(p.on(p.think), '刷新以后深度思考没了（用户说的）');
  assert.ok(p.off(p.web), '联网不该跟着开');
  p.code.aiToggle('think');
  p = await boot({ storage });
  assert.ok(p.off(p.think), '关掉以后刷新又开了');
});

check('联网按下、刷新还按着；深度思考不跟着变', async () => {
  const storage = memoryStore();
  let p = await boot({ storage });
  p.code.aiToggle('web');
  p = await boot({ storage });
  assert.ok(p.on(p.web), '刷新以后联网没了');
  assert.ok(p.off(p.think));
});

check('选的模型刷新还在（自己的、系统的都算）；选回「默认模型」刷新还是默认', async () => {
  const storage = memoryStore();
  let p = await boot({ storage });
  p.pick('9');
  p = await boot({ storage });
  assert.equal(p.sel.value, '9', '刷新以后回到默认模型（用户说的）');
  p.pick('3');
  p = await boot({ storage });
  assert.equal(p.sel.value, '3', '系统模型也要记');
  p.pick('');
  p = await boot({ storage });
  assert.equal(p.sel.value, '', '选回默认以后刷新又跳回上一个');
  assert.equal(p.sel.selectedIndex, 0);
});

check('三样互不覆盖：记一样不会把另外两样冲掉', async () => {
  const storage = memoryStore();
  let p = await boot({ storage });
  p.pick('7');
  p.code.aiToggle('think');
  p.code.aiToggle('web');
  p = await boot({ storage });
  assert.equal(p.sel.value, '7');
  assert.ok(p.on(p.think) && p.on(p.web));
});

check('记的模型被删了：回到默认，下拉不能是空白；不乱选一个别的', async () => {
  const storage = memoryStore();
  let p = await boot({ storage });
  p.pick('9');
  p = await boot({ storage, models: { userModels: [{ id: 7, displayName: 'DeepSeek', modelName: 'deepseek-chat' }], systemModels: [] } });
  assert.equal(p.sel.selectedIndex, 0, '选中项是 -1，下拉一片空白');
  assert.equal(p.sel.value, '');
});

check('模型列表没取回来：不擦掉记的，下回取到了还是它', async () => {
  const storage = memoryStore();
  let p = await boot({ storage });
  p.pick('9');
  p = await boot({ storage, modelsFail: true });
  assert.equal(p.sel.value, '');
  p = await boot({ storage });
  assert.equal(p.sel.value, '9', '网络断一下，记的就没了');
});

check('一个能用的模型都没有：写「还没有可用的模型」，不炸', async () => {
  const storage = memoryStore();
  let p = await boot({ storage });
  p.pick('9');
  p = await boot({ storage, models: { userModels: [], systemModels: [] } });
  assert.match(p.sel.innerHTML, /还没有可用的模型/);
  assert.equal(p.sel.selectedIndex, 0);
});

check('按用户分开：同一台浏览器换个人登录不接上一个人的；换回来还是自己的', async () => {
  const storage = memoryStore();
  let p = await boot({ storage, userId: 1 });
  p.pick('9');
  p.code.aiToggle('think');
  p = await boot({ storage, userId: 2 });
  assert.equal(p.sel.value, '', '接上了上一个人选的模型');
  assert.ok(p.off(p.think), '接上了上一个人的深度思考');
  p.code.aiToggle('web');
  p = await boot({ storage, userId: 1 });
  assert.equal(p.sel.value, '9');
  assert.ok(p.on(p.think));
  assert.ok(p.off(p.web), '第二个人的联网串到第一个人');
});

check('还不知道是谁（state.user 没有）：不炸，也不写一条 undefined 的记录', async () => {
  const storage = memoryStore();
  const p = await boot({ storage, userId: null });
  p.code.aiToggle('think');
  p.pick('7');
  assert.ok(p.on(p.think), '当页照样能按');
  assert.deepEqual(Object.keys(storage.m), []);
});

check('存不了：读写都抛（存储满了）时不炸，当页照样能按', async () => {
  const storage = { getItem() { throw new Error('读不了'); }, setItem() { throw new Error('满了'); } };
  const p = await boot({ storage });
  p.code.aiToggle('think');
  assert.ok(p.on(p.think));
  p.pick('9');
  assert.equal(p.sel.value, '9');
});

check('站点数据被禁用（localStorage 这个名字一碰就抛）：不炸，当页照样能按', async () => {
  const p = await boot({ storageThrows: true });
  p.code.aiToggle('web');
  assert.ok(p.on(p.web));
});

check('只有写抛（配额满）：按下去不炸', async () => {
  const storage = { getItem: () => null, setItem() { throw new Error('满了'); } };
  const p = await boot({ storage });
  p.code.aiToggle('web');
  assert.ok(p.on(p.web));
});

for (const bad of ['{坏', '[]', 'null', '7', '"x"', '{"think":"1","web":1,"model":{}}']) {
  check('存的是坏数据 ' + bad + '：都关着、模型默认；按一下之后照常记得住', async () => {
    const storage = memoryStore({ 'zq.ai.composer.1': bad });
    let p = await boot({ storage });
    assert.ok(p.off(p.think) && p.off(p.web), '坏数据被当成开着');
    assert.equal(p.sel.selectedIndex, 0);
    p.code.aiToggle('think');
    p = await boot({ storage });
    assert.ok(p.on(p.think), '坏数据之后记不住了');
  });
}

(async () => {
  let failed = 0;
  for (const [name, fn] of checks) {
    try { await fn(); console.log('  PASS  ' + name); }
    catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + e.message.split('\n')[0]); }
  }
  if (failed) { console.log(failed + ' 条没过'); process.exit(1); }
  console.log('ALL-GREEN');
})();
