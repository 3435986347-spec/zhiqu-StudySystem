// 产物卡片上的「查看并确认 / 确认」「忽略」（第九十二轮）—— 从发布的 assets/pages/ai-assistant.js 里抠出 artifactActionsHtml 和它用到的判断真跑。
//
//   用法：node src/test/resources/js/artifact-actions-check.js <ai-assistant.js 的路径>
//   确认框只自动弹一次。代码草稿原来不在卡片的清单里：确认框一关（点到遮罩、按 Esc），不刷新页面就没处确认 ——
//   第九十二轮在真浏览器里点「展开执行轨迹」时点到了遮罩，草稿就挂在「待确认」上、卡片上一个按钮都没有。
//   由 AiComposerTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

function grab(start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`抠不到 ${start}`);
  return src.slice(a, b + end.length);
}
const body = [
  grab('var PLAN_DRAFT_TYPES = ', ';\n'),
  grab('var CONFIRMABLE_TYPES = ', ';\n'),
  grab('function isPlanDraft(artifact) {', '\n}\n'),
  grab('function isMemoryDraft(artifact) {', '\n}\n'),
  grab('function isCodeDraft(artifact) {', '\n}\n'),
  grab('function artifactActionsHtml(artifact) {', '\n}\n'),
].join('\n');
const actions = new Function(`${body}\nreturn artifactActionsHtml;`)();

let failed = 0;
function check(name, ok, detail) {
  if (!ok) { failed++; console.log(`FAIL ${name}${detail ? `：${detail}` : ''}`); } else console.log(`ok   ${name}`);
}

const code = actions({ id: 24, artifactType: 'CODE_DRAFT', status: 'DRAFT' });
check('代码草稿（待确认）：卡片上有「查看并确认」（打开看 diff 的弹窗）和「忽略」',
  code.includes('data-art-view="24"') && code.includes('查看并确认') && code.includes('data-art-no="24"'), code);
check('代码草稿不能走不看 diff 的「确认」', !code.includes('data-art-ok'), code);
check('代码草稿（PENDING）一样有', actions({ id: 25, artifactType: 'code_draft', status: 'pending' }).includes('data-art-view="25"'));
check('写进磁盘以后（CONFIRMED）不再有按钮', actions({ id: 26, artifactType: 'CODE_DRAFT', status: 'CONFIRMED' }) === '');
const plan = actions({ id: 1, artifactType: 'PLAN_DRAFT', status: 'DRAFT' });
check('计划草稿照旧走弹窗', plan.includes('data-art-view="1"'), plan);
const memory = actions({ id: 2, artifactType: 'MEMORY_DRAFT', status: 'DRAFT' });
check('记忆草稿照旧走弹窗', memory.includes('data-art-view="2"'), memory);
const wiki = actions({ id: 3, artifactType: 'WIKI_DRAFT', status: 'DRAFT' });
check('Wiki 草稿照旧直接「确认」', wiki.includes('data-art-ok="3"') && !wiki.includes('data-art-view'), wiki);
check('引用不是草稿，没有按钮', actions({ id: 4, artifactType: 'CITATION', status: 'DRAFT' }) === '');

if (failed) { console.log(`${failed} 条没过`); process.exit(1); }
console.log('ALL-GREEN');
