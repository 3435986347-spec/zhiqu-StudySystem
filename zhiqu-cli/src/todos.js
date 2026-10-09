// 任务清单（第九轮，用户 2026-09-27：「提高处理复杂任务的能力」「不要一直偏离然后一直修正，最好一次就成功」）。
//
// 复杂的活最常见的走样：做着做着忘了还有哪几步、做完一半就收尾、压缩之后连「要做哪些」都只剩摘要里的一句转述。
// 清单由模型自己列（update_todos，整份替换），命令行负责三件事：
//   - 显示给用户（做到哪了一眼看得到）；
//   - 置顶进系统提示 —— 每一轮都在、压缩也压不掉；全做完了就不再占地方；
//   - 没做完就想收尾时推一次（在问用户问题、plan 档、全做完了都不推；一轮只推一次，不死循环）。
// 清单记进会话，/resume 接着用。
export const TODO_TOOL = 'update_todos';
export const MAX_TODOS = 30;
const STATUSES = ['pending', 'in_progress', 'completed'];

export function todoSchema() {
  return {
    type: 'function',
    function: {
      name: TODO_TOOL,
      description: [
        '维护这件事的任务清单（整份替换：每次都传完整的清单）。',
        '三步以上的活先列清单再动手：每一项是一件能验证的事（例如「给 login 加限流，并让 auth 测试通过」），不要写「看看代码」这种空话。',
        '开始做某一项时把它标成 in_progress，做完并验证过才标 completed；发现要多做一步就加进去，不需要的就删掉。',
        '只有一两步的小事不用列。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整的清单，按要做的顺序',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '这一步要做成什么' },
                status: { type: 'string', enum: STATUSES, description: 'pending / in_progress / completed' },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  };
}

/** 校验并规整；不对就返回 { error }（原来的清单不动）。 */
export function parseTodos(args) {
  const list = args && args.todos;
  if (!Array.isArray(list) || !list.length) return { error: 'todos 必须是一个非空数组，每项 { content, status }。' };
  if (list.length > MAX_TODOS) return { error: `清单最多 ${MAX_TODOS} 项（给了 ${list.length} 项）—— 合并细碎的步骤。` };
  const todos = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i] || {};
    const content = String(t.content || '').trim();
    if (!content) return { error: `第 ${i + 1} 项没有 content。` };
    if (!STATUSES.includes(t.status)) return { error: `第 ${i + 1} 项的 status 是「${t.status}」—— 只能是 pending / in_progress / completed。` };
    todos.push({ content: content.length > 300 ? `${content.slice(0, 300)}…` : content, status: t.status });
  }
  return { todos };
}

export const unfinished = (todos) => (todos || []).filter((t) => t.status !== 'completed');

/** 给模型的回话：简短，只说做到哪了、接下来是哪项。 */
export function todoReply(todos) {
  const done = todos.length - unfinished(todos).length;
  const next = todos.find((t) => t.status === 'in_progress') || todos.find((t) => t.status === 'pending');
  return `清单已更新（${done}/${todos.length} 完成）。${next ? `接下来：${next.content}` : '全部完成 —— 对照用户的原话检查一遍再收尾。'}`;
}

/** 终端里的样子。 */
export function todoLines(todos, paint) {
  const done = todos.length - unfinished(todos).length;
  const mark = { completed: '☑', in_progress: '◐', pending: '☐' };
  return [`任务清单 ${done}/${todos.length}`, ...todos.map((t) => {
    const line = `  ${mark[t.status]} ${t.content}`;
    return t.status === 'completed' ? paint.dim(line) : t.status === 'in_progress' ? paint.cyan(line) : line;
  })];
}

/** 置顶进系统提示的那一段；全做完了（或者没有清单）就不放。 */
export function todoBlock(todos) {
  if (!unfinished(todos).length) return '';
  const box = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
  return [
    '## 任务清单（你自己列的；做完一项就用 update_todos 更新）',
    ...todos.map((t) => `- ${box[t.status]} ${t.content}`),
    '按清单做，别偏题；每一项做完都要验证过。清单里的都做完之前不要收尾 —— 除非需要用户回答或决定。',
  ].join('\n');
}

/** 没做完就收尾时推的那一句。 */
export function todoNudge(todos) {
  const left = unfinished(todos);
  return `（任务清单里还有 ${left.length} 项没做完：${left.slice(0, 5).map((t) => `「${t.content}」`).join('、')}${left.length > 5 ? ' …' : ''}。`
    + '接着做完；如果是要等用户回答或决定，就直接这样说并停下；清单里有的已经不需要做了，就用 update_todos 更新它。）';
}
