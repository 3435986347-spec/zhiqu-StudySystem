// 任务表单（2026-10-01）：填的 → 发给服务端的。直接跑 assets/zhiqu-api.js 里发布的 taskFormPayload。
//   用法：node src/test/resources/js/task-form-check.js <zhiqu-api.js 的路径>；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('  var TASK_REMIND = ');
const b = src.indexOf('  function taskFormHtml(', a);
if (a < 0 || b < 0) throw new Error('抠不到 taskFormPayload');
const { taskFormPayload, TASK_REMIND } = new Function(src.slice(a, b) + '\nreturn { taskFormPayload, TASK_REMIND };')();
let fail = 0;
function judge(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + '\n        得到 ' + g + '\n        应为 ' + w); fail++; }
}
const NOW = '2026-10-01T10:30:00';
function form(over) {
  return Object.assign({ title: '高数作业', description: '', quadrant: '2', priority: '1', startTime: '', durationMinutes: '',
    deadline: '', reminderTime: '', remindMode: TASK_REMIND.DEFAULT, remindDays: '', repeatWeeks: '' }, over);
}
function err(r) { return r.error || null; }

// ── 新建：截止时间、提醒时间真的发出去了（原来只有标题）
let r = taskFormPayload(form({ deadline: '2026-10-08T22:00', reminderTime: '2026-10-08T19:00', quadrant: '1', priority: '3',
  startTime: '2026-10-08T18:00', durationMinutes: '90', description: '  第 7 章  ' }), NOW, null);
judge('新建：地址', [r.method, r.url], ['post', '/task']);
judge('新建：字段原样发出（钟面不换时区，补上秒）', r.body, { status: 0, title: '高数作业', description: '第 7 章', quadrant: 1, priority: 3,
  startTime: '2026-10-08T18:00:00', durationMinutes: 90, deadline: '2026-10-08T22:00:00', reminderTime: '2026-10-08T19:00:00', reminderOffsets: null });
judge('只填标题也行：其余为空、截止前提醒按默认（null）', taskFormPayload(form({}), NOW, null).body,
  { status: 0, title: '高数作业', description: '', quadrant: 2, priority: 1, startTime: null, durationMinutes: null, deadline: null,
    reminderTime: null, reminderOffsets: null });
judge('标题只有空白：拒', err(taskFormPayload(form({ title: '   ' }), NOW, null)), '请填写任务标题');

// ── 时间
judge('截止早于开始：拒', err(taskFormPayload(form({ startTime: '2026-10-08T18:00', deadline: '2026-10-08T17:59' }), NOW, null)), '截止时间早于开始时间');
judge('截止等于开始：可以', err(taskFormPayload(form({ startTime: '2026-10-08T18:00', deadline: '2026-10-08T18:00' }), NOW, null)), null);
judge('提醒时间已经过去：拒（服务端会一声不吭地不建提醒）',
  err(taskFormPayload(form({ reminderTime: '2026-10-01T10:29' }), NOW, null)), '提醒时间已经过去了，到时候不会再提醒 —— 换一个以后的时间，或者清空它');
judge('提醒时间正好是此刻：也算过去了', !!err(taskFormPayload(form({ reminderTime: '2026-10-01T10:30' }), NOW + '', null)) , true);
judge('提醒时间晚一分钟：可以', err(taskFormPayload(form({ reminderTime: '2026-10-01T10:31' }), NOW, null)), null);
judge('格式坏了的时间：拒', err(taskFormPayload(form({ deadline: '2026/10/08 22:00' }), NOW, null)), '截止时间的格式不对，请重新选一下');
judge('带秒的值（step 小于 60 时浏览器给的）：原样', taskFormPayload(form({ deadline: '2026-10-08T22:00:15' }), NOW, null).body.deadline, '2026-10-08T22:00:15');

// ── 预计时长、象限、优先级
judge('预计时长 0：拒', err(taskFormPayload(form({ durationMinutes: '0' }), NOW, null)), '预计时长写 1 到 1440 之间的分钟数');
judge('预计时长 1440：可以', taskFormPayload(form({ durationMinutes: '1440' }), NOW, null).body.durationMinutes, 1440);
judge('预计时长 1441：拒', !!err(taskFormPayload(form({ durationMinutes: '1441' }), NOW, null)), true);
judge('预计时长 1.5：拒', !!err(taskFormPayload(form({ durationMinutes: '1.5' }), NOW, null)), true);
judge('象限 5：拒', err(taskFormPayload(form({ quadrant: '5' }), NOW, null)), '请选择象限');
judge('优先级 -1：拒', err(taskFormPayload(form({ priority: '-1' }), NOW, null)), '请选择优先级');

// ── 截止前提醒：默认 / 不提醒 / 自定义
const dl = { deadline: '2026-10-20T22:00' };
judge('不提醒：发空数组（服务端就不排）', taskFormPayload(form(Object.assign({ remindMode: TASK_REMIND.NONE }, dl)), NOW, null).body.reminderOffsets, []);
judge('自定义：中英文逗号、顿号、空格都认，去重，从早到晚', taskFormPayload(form(Object.assign({ remindMode: TASK_REMIND.CUSTOM, remindDays: '1，7、3 7, 0' }, dl)), NOW, null).body.reminderOffsets, [7, 3, 1, 0]);
judge('自定义但没写：拒', err(taskFormPayload(form(Object.assign({ remindMode: TASK_REMIND.CUSTOM, remindDays: ' ' }, dl)), NOW, null)), '自定义的截止前提醒至少写一个天数，例如 7,3,1');
judge('自定义写了字：拒', !!err(taskFormPayload(form(Object.assign({ remindMode: TASK_REMIND.CUSTOM, remindDays: '7,三' }, dl)), NOW, null)), true);
judge('自定义 366 天：拒', !!err(taskFormPayload(form(Object.assign({ remindMode: TASK_REMIND.CUSTOM, remindDays: '366' }, dl)), NOW, null)), true);
judge('自定义 11 个：拒（服务端最多 10 个）', err(taskFormPayload(form(Object.assign({ remindMode: TASK_REMIND.CUSTOM, remindDays: '0,1,2,3,4,5,6,7,8,9,10' }, dl)), NOW, null)), '截止前提醒最多 10 个（这次是 11 个）');
judge('自定义 10 个：可以', taskFormPayload(form(Object.assign({ remindMode: TASK_REMIND.CUSTOM, remindDays: '0,1,2,3,4,5,6,7,8,9' }, dl)), NOW, null).body.reminderOffsets.length, 10);
judge('自定义但没有截止时间：拒', err(taskFormPayload(form({ remindMode: TASK_REMIND.CUSTOM, remindDays: '3' }), NOW, null)), '「截止前提醒」按截止时间算，请先填截止时间');

// ── 每周重复（只在新建时）
judge('每周重复 4 周：走展开创建', (function () { const x = taskFormPayload(form({ repeatWeeks: '4', startTime: '2026-10-05T19:00' }), NOW, null); return [x.url, x.body.repeatWeeks]; })(),
  ['/task/create-with-repeat', 4]);
judge('每周重复 1：就是一条', taskFormPayload(form({ repeatWeeks: '1' }), NOW, null).url, '/task');
judge('每周重复但没有开始时间：拒（服务端也要）', err(taskFormPayload(form({ repeatWeeks: '3' }), NOW, null)), '每周重复要先填开始时间：每一周在同一时间各建一条');
judge('每周重复 53：拒（服务端最多 52）', err(taskFormPayload(form({ repeatWeeks: '53', startTime: '2026-10-05T19:00' }), NOW, null)), '每周重复写 1 到 52 之间的周数');

// ── 编辑：其余字段照旧带上；没动的旧提醒时间不拦
const before = { id: 42, version: 3, status: 1, taskType: 'exam', difficulty: 4, aiReminderReason: 'AI 说的', title: '旧标题',
  description: '旧', quadrant: 1, priority: 2, startTime: null, durationMinutes: null, deadline: '2026-09-20T22:00:00',
  reminderTime: '2026-09-19T20:00:00', userId: 7 };
r = taskFormPayload(form({ title: '新标题', deadline: '2026-10-20T22:00', reminderTime: '2026-09-19T20:00' }), NOW, before);
judge('编辑：地址', [r.method, r.url], ['put', '/task/42']);
judge('编辑：版本号、状态、任务类型、难度照旧带上（服务端整份更新，没带的会被清空）',
  [r.body.version, r.body.status, r.body.taskType, r.body.difficulty, r.body.aiReminderReason], [3, 1, 'exam', 4, 'AI 说的']);
judge('编辑：改了的字段用新的', [r.body.title, r.body.deadline], ['新标题', '2026-10-20T22:00:00']);
judge('编辑：没动的旧提醒时间（早就提醒过了）不拦', err(r), null);
judge('编辑：改成另一个过去的时间：拦', !!err(taskFormPayload(form({ reminderTime: '2026-09-19T21:00' }), NOW, before)), true);
judge('编辑：不出现每周重复', taskFormPayload(form({ repeatWeeks: '4', startTime: '2026-10-05T19:00' }), NOW, before).body.repeatWeeks, undefined);

if (fail) { console.log(fail + ' 条红'); process.exit(1); }
console.log('ALL-GREEN');
