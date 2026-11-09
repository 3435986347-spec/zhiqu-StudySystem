// 回答里按顺序列出的每一步（第一百二十七轮）—— 直接 import 发布的 assets/pages/ai-assistant.js 里的 traceStepsHtml / mergeTraceStep。
//
//   用法：node src/test/resources/js/trace-steps-check.js <assets 目录>
//   盯的是：命令输出、文件名、diff 是别人写的（模型、命令、仓库里的文件）—— 不能变成 HTML；每一种都有图标（图标真的在 ICONS 里）；
//   running 的转圈、出错的标红、没细节的不给展开；展开状态记得住；上百步折起来；省掉的照实说；SSE 同一步先 running 后 ok 不重复、位置不变。
//   由 TraceStepsRenderingTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// 发布的那一份 ICONS 里有哪些名字：图标名写错了 icon() 回空串，这一步就没有图标（不报错）
const ui = fs.readFileSync(path.resolve(process.argv[2], 'zhiqu-ui.js'), 'utf8');
const ICONS = new Set([...ui.slice(ui.indexOf('var ICONS'), ui.indexOf('};', ui.indexOf('var ICONS'))).matchAll(/^\s*'([a-z0-9-]+)':/gm)].map((m) => m[1]));
const icon = (n) => (ICONS.has(n) ? `<svg data-i="${n}"></svg>` : '');

let failed = 0;
const check = (name, fn) => { try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n', e.message); } };
const tags = (h) => [...h.matchAll(/<\/?([a-z0-9]+)[\s>]/gi)].map((m) => m[1].toLowerCase());

(async () => {
  const mod = await import('file://' + path.resolve(process.argv[2], 'pages', 'ai-assistant.js'));
  const state = { reasoningExpanded: Object.create(null) };
  mod.bind({ esc, icon, state, $: () => null, $all: () => [], renderMarkdown: (t) => esc(t) });
  const html = (steps, extra = {}) => mod.traceStepsHtml({ steps, ...extra }, 'req-1');
  assert.ok(ICONS.size > 40, `从 zhiqu-ui.js 只认出 ${ICONS.size} 个图标：判据没读到 ICONS`);

  check('一步一行，按给的顺序；动作、对象、结果都在', () => {
    const h = html([
      { id: 's1', kind: 'thinking', title: '思考', summary: '3 秒', status: 'ok', ms: 3000 },
      { id: 's2', kind: 'list', title: '列出', target: 'src', summary: '12 项', status: 'ok' },
      { id: 's3', kind: 'run', title: '运行', target: 'npm test', summary: '退出码 1', status: 'error', detail: { command: 'npm test', exitCode: 1, output: 'FAIL' } },
    ]);
    const order = [...h.matchAll(/class="zq-trace-title">([^<]*)</g)].map((m) => m[1]);
    assert.deepEqual(order, ['思考', '列出', '运行']);
    assert.ok(h.includes('npm test') && h.includes('退出码 1') && h.includes('12 项'));
  });

  check('每一种都有图标，而且图标真的在 ICONS 里（写错名字 icon() 回空串，一步就光秃秃的）', () => {
    const kinds = ['thinking', 'list', 'read', 'search', 'run', 'create', 'edit', 'patch', 'delete', 'web', 'retrieve', 'tasks', 'wiki', 'plan', 'memory', 'check', 'agent', 'todo', 'other'];
    for (const kind of kinds) {
      const h = html([{ id: 'x', kind, title: kind, status: 'ok' }]);
      assert.match(h, /<svg data-i="[a-z0-9-]+"><\/svg>/, `${kind} 没有图标`);
    }
    assert.match(html([{ id: 'x', kind: 'rm -rf', title: 'x', status: 'ok' }]), /data-kind="other"/, '认不出的种类要落到 other');
  });

  check('命令输出、文件名、diff、标题都是别人写的：全转义，只有自己的标签', () => {
    const evil = '<img src=x onerror=alert(1)>';
    for (const id of ['a', 'b', 'c', 'd']) state.reasoningExpanded[`req-1:${id}`] = true;   // 点开了才画细节
    const h = html([
      { id: 'a', kind: 'run', title: evil, target: evil, summary: evil, status: 'error', detail: { command: evil, cwd: evil, output: `${evil}\n</pre><script>x</script>`, exitCode: 2 } },
      { id: 'b', kind: 'edit', title: '修改', target: evil, summary: '+1 -1', status: 'ok', detail: { files: [{ path: evil, added: 1, removed: 1, hunks: ['@@ 第 1 行 @@', `-${evil}`, `+${evil}`] }] } },
      { id: 'c', kind: 'list', title: '列出', status: 'ok', detail: { items: [evil] } },
      { id: 'd', kind: 'todo', title: '任务清单', status: 'ok', detail: { todos: [{ content: evil, status: 'completed' }] } },
    ]);
    // 真的标签才算（转义后的 &lt;img … onerror=…&gt; 只是字）：没有 <img、<script，也没有出现在标签里的 onerror 属性
    assert.ok(!/<img|<script|<\/pre><script/i.test(h), h);
    assert.ok(![...h.matchAll(/<[a-z][^>]*>/gi)].some((t) => /onerror/i.test(t[0])), '标签里出现了 onerror 属性');
    const allowed = new Set(['div', 'span', 'svg', 'details', 'summary', 'pre', 'ul', 'li', 'button']);
    const stray = tags(h).filter((t) => !allowed.has(t));
    assert.deepEqual(stray, [], `多出来的标签：${stray}`);
    assert.ok(!/style=/.test(h), '不许内联样式');
    for (const id of ['a', 'b', 'c', 'd']) delete state.reasoningExpanded[`req-1:${id}`];
  });

  check('running 的转圈（data-state=running，没有细节可点）；出错的标 bad；成的标 ok', () => {
    const h = html([
      { id: 'r', kind: 'run', title: '运行', target: 'sleep 9', status: 'running', detail: { output: '半截' } },
      { id: 'e', kind: 'read', title: '读取', target: 'x', summary: '没有这个文件', status: 'error' },
      { id: 'o', kind: 'read', title: '读取', target: 'y', summary: '3 行', status: 'ok' },
    ]);
    assert.match(h, /<div class="zq-trace-step" data-state="running" data-kind="run">/, '跑着的那一步不该能点开（细节还没到）');
    assert.match(h, /data-state="bad" data-kind="read"/);
    assert.match(h, /data-state="ok" data-kind="read"/);
  });

  check('有细节的才是 <details>：命令输出（$ 命令、退出码）、diff（+/- 行）、列表；没细节的是一行', () => {
    state.reasoningExpanded['req-1:run'] = true; state.reasoningExpanded['req-1:ed'] = true;
    const h = html([
      { id: 'run', kind: 'run', title: '运行', target: 'npm test', status: 'ok', detail: { command: 'npm test', exitCode: 0, output: 'ok 1\nok 2' } },
      { id: 'ed', kind: 'edit', title: '修改', target: 'a.js', status: 'ok', detail: { files: [{ path: 'a.js', added: 1, removed: 1, hunks: ['@@ 第 3 行 @@', ' ctx', '-old', '+new'] }] } },
      { id: 'th', kind: 'thinking', title: '思考', summary: '3 秒', status: 'ok' },
    ]);
    assert.equal((h.match(/<details class="zq-trace-step"/g) || []).length, 2);
    assert.ok(h.includes('$ npm test') && h.includes('退出码 0'));
    assert.match(h, /data-op="del"><span class="zq-diff-mark">-<\/span><span class="zq-diff-text">old</);
    assert.match(h, /data-op="add"><span class="zq-diff-mark">\+<\/span><span class="zq-diff-text">new</);
    assert.match(h, /<div class="zq-trace-step" data-state="ok" data-kind="thinking"><div class="zq-trace-line">/);
    delete state.reasoningExpanded['req-1:run']; delete state.reasoningExpanded['req-1:ed'];
  });

  check('合着的不画细节（几百 KB 的输出 / diff 不进 DOM）；点开才画；刷新后列表里只有 hasDetail，点开时显示「正在取」', () => {
    const big = 'x'.repeat(50000);
    const closed = html([{ id: 'r', kind: 'run', title: '运行', status: 'ok', detail: { command: 'x', exitCode: 0, output: big } }]);
    assert.ok(closed.length < 2000, `合着也画了细节：${closed.length} 字`);
    assert.match(closed, /<details class="zq-trace-step"/, '有细节的照样能点开');
    const fromList = html([{ id: 'r', kind: 'run', title: '运行', status: 'ok', hasDetail: true }]);
    assert.match(fromList, /<details class="zq-trace-step"[^>]*data-trace-step="r"/, '列表里来的（只有 hasDetail）也要能点开');
    state.reasoningExpanded['req-1:r'] = true;
    assert.match(html([{ id: 'r', kind: 'run', title: '运行', status: 'ok', hasDetail: true }]), /正在取/);
    assert.ok(html([{ id: 'r', kind: 'run', title: '运行', status: 'ok', detail: { command: 'x', exitCode: 0, output: big } }]).includes(big), '点开了没画细节');
    delete state.reasoningExpanded['req-1:r'];
  });

  check('省掉的照实说：命令输出中间省了几行（在头尾之间）、diff 后面还有、文件还有、整轮没存的', () => {
    state.reasoningExpanded['req-1:r'] = true; state.reasoningExpanded['req-1:p'] = true;
    const out = Array.from({ length: 5 }, (_, i) => `head ${i}`).concat(Array.from({ length: 3 }, (_, i) => `tail ${i}`)).join('\n');
    const h = html([
      { id: 'r', kind: 'run', title: '运行', status: 'ok', detail: { command: 'x', exitCode: 0, output: out, omitted: 400, splitAt: 5 } },
      { id: 'p', kind: 'patch', title: '改动', status: 'ok', detail: { files: [{ path: 'a', added: 1, removed: 0, hunks: ['+a'], omitted: 12 }], omittedFiles: 3 } },
    ], { dropped: 7 });
    // （省掉几行写在细节里：点开了才看得到）
    assert.match(h, /head 4\n… 中间省掉 400 行 …\ntail 0/, '省掉的行要在头尾中间说');
    assert.ok(h.includes('后面还有 12 行改动没列出') && h.includes('还有 3 个文件没列出') && h.includes('后面还有 7 步没存'));
    delete state.reasoningExpanded['req-1:r']; delete state.reasoningExpanded['req-1:p'];
  });

  check('展开状态记得住（和思考摘要同一套 state.reasoningExpanded）：键是 消息键:步骤 id', () => {
    const steps = [{ id: 's9', kind: 'run', title: '运行', status: 'ok', detail: { command: 'x', exitCode: 0, output: 'y' } }];
    assert.ok(!/ open>/.test(html(steps)));
    state.reasoningExpanded['req-1:s9'] = true;
    assert.match(html(steps), /data-reason-key="req-1:s9" data-trace-step="s9" open>/);
    delete state.reasoningExpanded['req-1:s9'];
  });

  check('上百步：默认列前 60 步，剩下的折成一个按钮；点过之后全列', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `s${i}`, kind: 'read', title: '读取', target: `f${i}`, status: 'ok' }));
    const folded = html(many);
    assert.equal((folded.match(/class="zq-trace-step"/g) || []).length, 60);
    assert.match(folded, /data-trace-all="req-1:all">还有 90 步/);
    state.reasoningExpanded['req-1:all'] = true;
    assert.equal((html(many).match(/class="zq-trace-step"/g) || []).length, 150);
    delete state.reasoningExpanded['req-1:all'];
  });

  check('SSE 合并：同一步先 running 后 ok，替换、位置不变；新的接在后面；坏的不收', () => {
    const m = {};
    mod.mergeTraceStep(m, { id: 's1', kind: 'run', status: 'running' });
    mod.mergeTraceStep(m, { id: 's2', kind: 'read', status: 'ok' });
    mod.mergeTraceStep(m, { id: 's1', kind: 'run', status: 'ok', summary: '退出码 0' });
    mod.mergeTraceStep(m, null);
    mod.mergeTraceStep(m, { kind: 'x' });
    assert.deepEqual(m.steps.steps.map((s) => [s.id, s.status]), [['s1', 'ok'], ['s2', 'ok']]);
  });

  if (failed) { console.log(`${failed} 条红`); process.exit(1); }
  console.log('\nALL-GREEN');
})();
