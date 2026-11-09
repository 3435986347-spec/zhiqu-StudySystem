// 用发布的 traceStepsHtml 画一份极端的步骤（第一百二十七轮）：很长的命令、不换行的输出、很长的路径、超长的 diff 行、上百字的标题 ——
// 给 DesktopWebKitLayoutTest 在真的 WebKit 里量「撑不撑出回答那一栏」。用法：node trace-markup.js <assets 目录> <输出文件>
const fs = require('fs');
const path = require('path');
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ui = fs.readFileSync(path.resolve(process.argv[2], 'zhiqu-ui.js'), 'utf8');
const body = ui.slice(ui.indexOf('var ICONS'), ui.indexOf('};', ui.indexOf('var ICONS')) + 2);
const ICONS = new Function(`${body}; return ICONS;`)();
const icon = (n) => (ICONS[n] ? `<svg class="zq-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">${ICONS[n]}</svg>` : '');
(async () => {
  const mod = await import('file://' + path.resolve(process.argv[2], 'pages', 'ai-assistant.js'));
  const open = Object.create(null);
  mod.bind({ esc, icon, state: { reasoningExpanded: open }, $: () => null, $all: () => [] });
  const long = 'x'.repeat(600);
  const steps = [
    { id: 't', kind: 'thinking', title: '思考', summary: '12 秒', status: 'ok', ms: 12000 },
    { id: 'l', kind: 'list', title: '列出', target: `src/${'very-long-directory-name/'.repeat(12)}`, summary: '30 项（已截断）', status: 'ok', detail: { items: [long, '中文很长的文件名'.repeat(30)], omitted: 3 } },
    { id: 'r', kind: 'run', title: '后台运行', target: `npm run build -- --config ${long}`, summary: '退出码 1（12.3s）', status: 'error', ms: 12300,
      detail: { command: `npm run build -- --config ${long}`, cwd: 'packages/app', exitCode: 1, output: `${long}\n${'错误'.repeat(300)}\n\tat x (/a/b/c.js:1:2)`, omitted: 120, splitAt: 1 } },
    { id: 'e', kind: 'edit', title: '修改', target: `src/${'deep/'.repeat(30)}file.ts`, summary: '+3 -1（草稿）', status: 'ok',
      detail: { files: [{ path: `src/${'deep/'.repeat(30)}file.ts`, added: 3, removed: 1, hunks: ['@@ 第 1 行 @@', ` ${long}`, `-${long}`, `+${long}`, '+\tconst 中文变量 = 1;'] }] } },
    { id: 'w', kind: 'web', title: '联网搜索', target: '很长的搜索词'.repeat(40), summary: '5 个结果，2 个打不开', status: 'ok', detail: { items: [`标题  https://example.com/${long}`] } },
    { id: 'g', kind: 'todo', title: '任务清单', summary: '任务清单 1/3', status: 'ok', detail: { todos: [{ content: long, status: 'completed' }, { content: '进行中', status: 'in_progress' }] } },
    { id: 's', kind: 'search', title: '搜索', target: '「foo」', summary: '', status: 'running' },
  ];
  for (const s of steps) open[`k:${s.id}`] = true;   // 都点开：量的是展开之后
  fs.writeFileSync(process.argv[3], mod.traceStepsHtml({ steps }, 'k'));
  console.log('ALL-GREEN');
})();
