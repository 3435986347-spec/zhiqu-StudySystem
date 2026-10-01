// 斜杠命令的清单 —— 唯一定义。/help 的文字和输入 / 时弹出的菜单都从这里来，
// 两处各写一份的话，迟早一个加了命令另一个没加。
//
// args 只是给人看的用法提示；菜单里回车直接执行选中的命令（不带参数），Tab 把它补进输入框、留一个空格接着打参数。

export const SLASH_COMMANDS = [
  { name: '/goal', args: '<目标>', desc: 'goal 模式：把它当圣目标，一直做到达成并核对通过（Ctrl+C 随时停）' },
  { name: '/mode', args: '[plan|ask|auto]', desc: '切换档位（只读出计划 / 逐个确认 / 全自动）' },
  { name: '/model', args: '[id|default]', desc: '查看 / 切换模型' },
  { name: '/window', args: '[数，如 1m / 128k]', desc: '看 / 设当前模型的上下文窗口（没填就按默认 64K 算）' },
  { name: '/resume', desc: '列出这个工作区的会话，挑一段接着做' },
  { name: '/new', desc: '开一段新会话' },
  { name: '/compact', desc: '现在就把较早的对话压成摘要' },
  { name: '/init', desc: '读项目，写一份 ZHIQU.md 初稿' },
  { name: '/skills', desc: '列出可用的 skills' },
  { name: '/mcp', desc: 'MCP 服务器与工具' },
  { name: '/system', args: '[path|diff|reset]', desc: '系统内容（~/.zhiqu/system.md）' },
  { name: '/verbose', desc: '显示 / 隐藏思考过程（默认隐藏：只显示结论和改了什么）' },
  { name: '/usage', desc: '这次会话与今天的用量' },
  { name: '/help', desc: '列出这些命令' },
  { name: '/exit', desc: '退出（也可以 Ctrl+D）' },
];

/** 输入的是 / 开头、还没打空格的一段：列出以它开头的命令。 */
export function matchCommands(text, commands = SLASH_COMMANDS) {
  if (!/^\/\S*$/.test(text)) return [];
  const prefix = text.toLowerCase();
  return commands.filter((c) => c.name.startsWith(prefix));
}

export function slashHelp(commands = SLASH_COMMANDS) {
  const usage = (c) => (c.args ? `${c.name} ${c.args}` : c.name);
  const width = Math.max(...commands.map((c) => usage(c).length)) + 2;
  const lines = [];
  for (const c of commands) {
    lines.push(`${usage(c).padEnd(width)}${c.desc}`);
    if (c.name === '/goal') lines.push(`${'/goal'.padEnd(width)}看当前目标；/goal continue 接着追；/goal clear 放下`);
  }
  lines.push('输入 / 会弹出命令菜单：↑↓ 选、回车执行、Tab 补全后接着打参数、Esc 关掉。');
  lines.push('行尾加 \\ 可以换行接着输入。Ctrl+C 打断正在做的事。');
  return lines.join('\n');
}
