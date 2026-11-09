// 一步一条的执行记录（第一百二十七轮，用户要的：「像 codex 那样把思考 - run command - create - edit - ls 等等命令和结果按顺序列出来」）。
//
// 网页 AI 助手的回答上方按时间排出每一步：图标 + 动作 + 对象 + 结果小结，点开看命令输出 / diff。
// 命令行这里只负责把一次工具调用（或一段思考）变成一条形状固定的记录；网页的代码模式由宿主（host/code-host.js）交给后端，
// 普通聊天的那几步由后端自己出（同一个形状，见 zhiqu-backend 的 TraceSteps）。
//
// 形状（命令行、后端、前端三处同一份）：
//   { id, kind, title, target, summary, status: 'running'|'ok'|'error', detail?, ms? }
//   kind 只有下面 KINDS 里这几种；detail 按种类：
//     run    { command, cwd?, exitCode, output, omitted }      输出只留头尾（OUTPUT_HEAD + OUTPUT_TAIL 行），省掉多少照实说
//     create / edit / patch   { files: [{ path, added, removed, hunks: [行], omitted }] }   hunks 和确认框同一个算法（render/diff.js）
//     read   { path, from, to, total }
//     list / search  { items: [行], omitted }
//     thinking { chars }
//   这里出的东西会进库、会给人看：每一样都有上限，超了说省掉了多少；命令输出、文件内容是不可信的 —— 只存字，前端一律转义。
import { hunks, stat } from './render/diff.js';

export const KINDS = Object.freeze(['thinking', 'list', 'read', 'search', 'run', 'create', 'edit', 'patch', 'delete',
  'web', 'retrieve', 'tasks', 'wiki', 'plan', 'memory', 'check', 'agent', 'todo', 'other']);

export const OUTPUT_HEAD = 20;
export const OUTPUT_TAIL = 40;
export const LINE_CHARS = 400;
export const HUNK_LINES = 400;
export const FILES_PER_STEP = 20;
export const ITEMS_PER_STEP = 30;
export const TEXT_CHARS = 300;

const clip = (s, n = TEXT_CHARS) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 一段输出只留头尾：中间省掉的行数照实说（测试的汇总在结尾，命令自己的头在开头 —— 第九十轮终端也是这么给的） */
export function headTail(text, head = OUTPUT_HEAD, tail = OUTPUT_TAIL) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const cut = (l) => clip(l, LINE_CHARS);
  if (lines.length <= head + tail) return { output: lines.map(cut).join('\n'), omitted: 0 };
  return { output: [...lines.slice(0, head), ...lines.slice(-tail)].map(cut).join('\n'), omitted: lines.length - head - tail, splitAt: head };
}

/** 一个文件的改动：+a -r 和 diff 的分块（封顶） */
export function fileChange(path, oldText, newText, { added, removed } = {}) {
  const all = hunks(oldText || '', newText || '', 3).map(redact);
  const shown = all.slice(0, HUNK_LINES).map((l) => clip(l, LINE_CHARS));
  return { path: String(path), added: Number(added) || 0, removed: Number(removed) || 0, hunks: shown, omitted: Math.max(0, all.length - shown.length) };
}

const KIND_OF = {
  list_files: 'list', read_file: 'read', search: 'search',
  write_file: 'create', edit_file: 'edit', apply_patch: 'patch', delete_file: 'delete',
  shell: 'run', run_command: 'run', shell_output: 'run', shell_stop: 'run',
  search_wiki: 'wiki', read_wiki_page: 'wiki', create_wiki_patch: 'wiki',
  create_study_plan: 'plan', list_tasks: 'tasks', update_task_status: 'tasks',
  read_memory: 'memory', propose_memory: 'memory',
  spawn_agent: 'agent', wait_agent: 'agent', send_input: 'agent', close_agent: 'agent',
  update_todos: 'todo',
};

/** 这个工具算哪一种（write_file 覆盖已有文件时算 edit，见 noteWrite） */
export function kindOf(name) {
  return KIND_OF[name] || 'other';
}

/** 一次调用的标题和对象（标题是动作，对象是路径 / 命令 / 查的词） */
export function titleOf(name, args = {}) {
  switch (name) {
    case 'list_files': return { title: '列出', target: args.path || '.' };
    case 'read_file': return { title: '读取', target: String(args.path || '') };
    case 'search': return { title: '搜索', target: `「${clip(args.query, 120)}」${args.path ? ` 在 ${args.path}` : ''}` };
    case 'write_file': return { title: args.append ? '追加' : '写入', target: String(args.path || '') };
    case 'edit_file': return { title: '修改', target: String(args.path || '') };
    case 'apply_patch': return { title: '改动', target: '' };
    case 'delete_file': return { title: '删除', target: String(args.path || '') };
    case 'shell': return { title: args.background ? '后台运行' : '运行', target: clip(args.command, 500) };
    case 'run_command': return { title: '运行', target: clip([args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' '), 500) };
    case 'shell_output': return { title: '看输出', target: String(args.id || '') };
    case 'shell_stop': return { title: '停掉', target: String(args.id || '') };
    case 'search_wiki': return { title: '搜知识库', target: clip(args.query || args.keyword || '', 120) };
    case 'read_wiki_page': return { title: '读知识库', target: clip(args.title, 120) };
    case 'create_wiki_patch': return { title: '知识库草稿', target: clip(args.title, 120) };
    case 'create_study_plan': return { title: '计划草稿', target: '' };
    case 'list_tasks': return { title: '读任务', target: '' };
    case 'update_task_status': return { title: '改任务状态', target: `#${String(args.task_id || '').replace('#', '')}` };
    case 'read_memory': return { title: '读长期记忆', target: '' };
    case 'propose_memory': return { title: '记忆草稿', target: '' };
    case 'update_todos': return { title: '任务清单', target: '' };
    case 'spawn_agent': return { title: args.role === 'worker' ? '派子 agent（干活）' : '派子 agent（只读）', target: clip(args.task, 120) };
    case 'wait_agent': return { title: '等子 agent', target: Array.isArray(args.ids) ? args.ids.join('、') : '' };
    case 'send_input': return { title: '交代子 agent', target: String(args.id || '') };
    case 'close_agent': return { title: '停掉子 agent', target: String(args.id || '') };
    default: return { title: name.startsWith('mcp__') ? 'MCP' : name, target: name.startsWith('mcp__') ? name.slice(5).replace('__', '/') : '' };
  }
}

/**
 * 一轮里的步骤记录：start → 执行 → finish。emit 每次变化都叫一次（开始一次、结束一次），交给宿主 / 终端以外的地方。
 * 不改工具的行为、不改给模型的结果 —— 只是旁边记一笔。
 */
export class StepLog {
  constructor(emit, { now = () => Date.now() } = {}) {
    this.emit = emit;
    this.now = now;
    this.seq = 0;
    this.current = null;
  }

  /** 一段思考（模型这一次在想、没出字）：字数、用了多久 */
  thinking(chars, ms) {
    if (!(chars > 0)) return;
    this.emit({ id: `s${++this.seq}`, kind: 'thinking', title: '思考', target: '', summary: `${Math.max(1, Math.round(ms / 1000))} 秒`, status: 'ok', ms: Math.round(ms), detail: { chars } });
  }

  start(name, args) {
    const { title, target } = titleOf(name, args);
    const step = { id: `s${++this.seq}`, kind: kindOf(name), title, target, summary: '', status: 'running', _t: this.now() };
    this.current = step;
    this.emit(publicStep(step));
    return step;
  }

  /** 这一步的结果：summary 一行小结，ok 成没成，detail 按种类 */
  finish(step, { summary = '', ok = true, detail = null, kind = null, title = null } = {}) {
    if (!step || step.status !== 'running') return;
    step.status = ok ? 'ok' : 'error';
    step.summary = clip(summary, 200);
    if (detail) step.detail = detail;
    if (kind) step.kind = kind;
    if (title) step.title = title;
    step.ms = Math.max(0, this.now() - step._t);
    if (this.current === step) this.current = null;
    this.emit(publicStep(step));
  }
}

function publicStep(step) {
  const { _t, ...rest } = step;
  return { ...rest };
}

// ── 每种工具的结果怎么写成 detail（executeTool 在各分支里叫） ──────────────────

/**
 * 存进步骤（进库、给人看）之前把像密钥的东西遮掉（review：工作区里 cat .env 原样进了 steps_json，第一百二十七轮计划第 6 条答应过不放密钥）。
 * 只改步骤里的这一份 —— 给模型的工具结果不动。宁可多遮：形状像 key 的串、等号 / 冒号后面跟着的口令和令牌。
 */
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g,            // sk-… sk_live_… sk-ant-…
  /\b(?:ghp|gho|ghu|ghs|github_pat|glpat|xox[abpors]|zqp)_[A-Za-z0-9_]{16,}/g,     // GitHub / GitLab / Slack / 本项目的个人令牌
  /\bAKIA[0-9A-Z]{16}\b/g,                                                       // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,             // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
const SECRET_ASSIGN = /\b([A-Za-z0-9_.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(["']?)([^\s"']{4,})\3/gi;
export function redact(text) {
  let t = String(text == null ? '' : text);
  for (const p of SECRET_PATTERNS) t = t.replace(p, '［已遮住］');
  return t.replace(SECRET_ASSIGN, (_m, key, sep, q) => `${key}${sep}${q}［已遮住］${q}`);
}

export function runDetail(prep, r) {
  const { output, omitted, splitAt } = headTail(redact(r.output));
  return { command: clip(prep.command ? [prep.command, ...(prep.args || [])].join(' ') : '', 1000), cwd: prep.cwdRel && prep.cwdRel !== '.' ? prep.cwdRel : undefined,
    exitCode: r.exitCode, output, omitted, ...(splitAt ? { splitAt } : {}) };
}

export function writeDetail(prep, r) {
  return { files: [fileChange(prep.rel, prep.oldText, prep.newText, r)] };
}

export function patchDetail(prep) {
  const files = prep.writes.slice(0, FILES_PER_STEP).map((w) => {
    // 加减了几行按整份算（stat），不按截过的分块数 —— 截了 400 行以后数出来的是错的
    const c = fileChange(w.rel, w.oldText, w.newText, stat(w.oldText || '', w.newText || ''));
    return { ...c, ...(w.creating ? { creating: true } : {}), ...(w.movedFrom ? { movedFrom: w.movedFrom } : {}) };
  });
  return { files, omittedFiles: Math.max(0, prep.writes.length - files.length), deletes: (prep.deletes || []).map((d) => d.rel) };
}

/** 列目录、搜索：content 里的前几行就是结果（工具给模型的那一份），头一行是说明的不要 */
export function listDetail(content) {
  const lines = redact(content).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const items = lines.slice(0, ITEMS_PER_STEP).map((l) => clip(l, LINE_CHARS));
  return { items, omitted: Math.max(0, lines.length - items.length) };
}
