// 工作状态卡（第一百三十八轮，docs/memory-plan.md 第 2 步）。
//
// 由来：用户一段 23 小时的会话里压缩了 105 次，每次压完，「做完了什么、怎么验证的、定了什么、建了哪些临时文件、
// 刚才看到哪」全在被压掉的历史里 —— 任务清单整份重列了 6 次，做完的项跟着消失了 3 次，同一段着色器改到第 10 版，
// 建了 42 个临时文件，每次压缩之后要先重新看 12 步才动手。进程崩掉那一次，连进度笔记都没留下（它只在一句话正常返回时才写）。
//
// 这里是一份**压缩压不掉、进程崩了也在**的小记录，每变一次就落盘（原子写）：
//   - 事实由命令行自己记：用户说过的话、清单和做完的记录、改过 / 新建的文件、同一处改了几回、最近几步、刚才在看哪；
//   - 判断由模型用 note 工具记：定过的事、走不通的路、位置、临时文件。
// 它什么时候进上下文：压缩之后、续接时、上一轮没做完的下一轮开头（桌面 / 网页每一轮是新进程）。不进系统提示（缓存）。
// 它取代了第一百三十六轮的 progress.md（那份只有 8 条步骤和文件名，崩了、被杀了不写）。
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './config.js';

export const NOTE_TOOL = 'note';
export const NOTE_KINDS = ['decision', 'dead_end', 'anchor', 'temp'];
const KIND_LABEL = { decision: '定过的事', dead_end: '走不通的路', anchor: '位置', temp: '临时文件' };
export const NOTE_CHARS = 300;
const MAX_NOTES = 20;          // 每一类
const MAX_SAID = 20;
const SAID_CHARS = 1500;
const MAX_DONE = 60;
const MAX_STEPS = 15;
const MAX_FOCUS = 5;
const MAX_FILES = 60;
const MAX_CREATED = 80;
/** 同一处改到这么多回各提醒一次。按「文件 + 200 行一段」数：单文件项目里整份文件改几十回是常事，同一段改六回就该停下想想 */
export const CHURN_WARN = [6, 12, 24];
export const CHURN_SPAN = 200;
/** 没做完的状态过这么久就不再接（那是上一次的活，不是接着做） */
export const STALE_MS = 24 * 3600 * 1000;

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** 比两项清单是不是同一件事：去掉标点空白之后一样，或者字的两两组合大半重合（模型重列清单时措辞常常小改） */
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
function bigrams(s) { const out = new Set(); for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2)); return out; }
export function sameItem(a, b) {
  const x = norm(a); const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const A = bigrams(x); const B = bigrams(y);
  if (A.size < 3 || B.size < 3) return false;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / Math.min(A.size, B.size) >= 0.7;
}

const empty = () => ({
  v: 1, said: [], todos: [], done: [], notes: { decision: [], dead_end: [], anchor: [], temp: [] },
  files: {}, created: [], churn: {}, steps: [], focus: [], turn: { status: 'idle', at: null }, answer: '',
});

export function noteSchema() {
  return {
    type: 'function',
    function: {
      name: NOTE_TOOL,
      description: [
        '往「工作状态」里记一条：它不会被对话压缩丢掉，进程重启也在。只记以后还要用、又没法从代码里一眼看出来的：',
        'decision 定过的事和原因（「天空用体积云，不用贴图：贴图在 4K 下糊」）；dead_end 试过不行的路（「把曝光调到 1.6 整屏发白」），免得压缩之后再试一遍；',
        'anchor 一个位置（path + line：「FS_SKY 着色器从这里开始」）；temp 你建的临时文件（path），收尾时好删。',
        '一条一句话，不超过 300 字。改了哪些文件、跑了什么、清单做到哪，命令行自己记着，不用你记。',
        '上面四种只管这段会话。**以后每次在这个项目里开工都该知道的事**（约定、坑、定过的事、常用命令）用 kind: project：给一个 topic（短标题，同一个 topic 再记是更新）和 type，最多 600 字。它直接写进项目的 .zhiqu/memory/，不进 git。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...NOTE_KINDS, 'project'], description: 'decision / dead_end / anchor / temp（这段会话）；project（这个项目，跨会话）' },
          topic: { type: 'string', description: 'project 用：短标题，比如「测试怎么跑」' },
          type: { type: 'string', enum: ['convention', 'pitfall', 'decision', 'command'], description: 'project 用：约定 / 坑 / 定过的事 / 常用命令' },
          text: { type: 'string', description: '要记的那句话' },
          path: { type: 'string', description: 'anchor、temp 用：相对工作区的路径' },
          line: { type: 'integer', description: 'anchor 用：行号' },
        },
        required: ['kind', 'text'],
      },
    },
  };
}

export class WorkState {
  /** file 为 null 就只在内存里（子 agent、没有地方可写时）。 */
  constructor(file = null, { now = () => new Date() } = {}) {
    this.file = file;
    this.now = now;
    this.data = empty();
    /** 读进来的那一份是不是上一次没做完留下的（开工时要不要接上） */
    this.inherited = false;
  }

  /** 从盘上读。坏了、太旧、已经做完而且清单也清了的：当没有。 */
  static open(file, opts = {}) {
    const s = new WorkState(file, opts);
    if (!file) return s;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return s; }
    if (!raw || raw.v !== 1) return s;
    const d = { ...empty(), ...raw, notes: { ...empty().notes, ...(raw.notes || {}) } };
    s.data = d;
    const at = Date.parse(d.turn && d.turn.at);
    const fresh = Number.isFinite(at) && s.now().getTime() - at <= STALE_MS;
    s.inherited = fresh && s.unfinished();
    return s;
  }

  /** 还有没做完的：上一句没正常收尾（被打断、出错、进程没了），或者清单里还有没做完的项。 */
  unfinished() {
    const d = this.data;
    return (d.turn.status !== 'done' && d.turn.status !== 'idle') || d.todos.some((t) => t.status !== 'completed');
  }

  isEmpty() {
    const d = this.data;
    return !d.said.length && !d.todos.length && !d.done.length && !Object.keys(d.files).length && !d.steps.length
      && NOTE_KINDS.every((k) => !d.notes[k].length);
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, `${JSON.stringify(this.data)}\n`);
    } catch { /* 记不上不能把这一轮弄挂 */ }
  }

  stamp() { return this.now().toISOString(); }

  // ── 一句话的开头和结尾 ─────────────────────────────────────────────────

  beginTurn(text) {
    if (text) this.addSaid(text);
    this.data.turn = { status: 'running', at: this.stamp() };
    this.save();
  }

  /** 干活中途用户补的一句（第一百五十轮）：和开头那句一样逐字记着 —— 压缩会把中间的 user 消息摘掉，卡不会 */
  steer(text) {
    if (!text) return;
    this.addSaid(text, { steer: true });
    this.save();
  }

  addSaid(text, { steer = false } = {}) {
    const d = this.data;
    const s = String(text);
    d.said.push({ at: this.stamp(), text: s.length > SAID_CHARS ? `${s.slice(0, SAID_CHARS - 300)}\n…（略）…\n${s.slice(-300)}` : s, ...(steer ? { steer: true } : {}) });
    // 太多时留第一句和最近的（第一句是这件事的出处）
    if (d.said.length > MAX_SAID) d.said = [d.said[0], ...d.said.slice(-(MAX_SAID - 1))];
  }

  /** finished：这一句正常说完了。没说完的留着 'unfinished'；进程直接没了就一直是 'running' —— 下次开工都算没做完 */
  endTurn(finished, { discardWhenDone = false, answer = '' } = {}) {
    this.data.turn = { status: finished ? 'done' : 'unfinished', at: this.stamp() };
    // 这一句最后的回答（开头一段）：以后的会话问「上次做到哪」时，摘要里用它（第一百四十一轮）
    if (answer) this.data.answer = String(answer).trim().slice(0, 800);
    // 没有会话记录的那一份（桌面 / 网页，文件在项目的 .zhiqu/ 里）：这件事做完了就不留，目录空了也收掉 ——
    // 生成到产物的临时空间里不该多出一个 .zhiqu
    if (discardWhenDone && this.file && !this.unfinished()) {
      try {
        fs.rmSync(this.file, { force: true });
        const dir = path.dirname(this.file);
        if (path.basename(dir) === '.zhiqu' && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
      } catch { /* 留着也没关系 */ }
      return;
    }
    this.save();
  }

  // ── 清单：记账，不是整份替换 ─────────────────────────────────────────────

  /**
   * 模型交来一份新清单（对它还是整份替换）。命令行比一比：
   *   - 刚标成 completed 的记进「做完的记录」（只追加，带时间和它说的验证方法）；
   *   - 以前做完的项在新清单里没了：记录里照样留着，回一句「不用重做」；
   *   - 新清单里没做完的项和做完过的某一项是同一件事：提醒它这一项做过。
   * 返回 { todos, justCompleted, forgotten: [做完的记录], redo: [{ item, done }] }。
   */
  setTodos(next) {
    const d = this.data;
    const justCompleted = [];
    for (const t of next) {
      if (t.status !== 'completed') continue;
      if (d.done.some((x) => sameItem(x.content, t.content))) continue;
      const entry = { at: this.stamp(), content: t.content, evidence: t.evidence ? clip(t.evidence, 200) : '' };
      d.done.push(entry);
      justCompleted.push(entry);
    }
    // 后来补的验证方法也记上
    for (const t of next) {
      if (t.status !== 'completed' || !t.evidence) continue;
      const hit = d.done.find((x) => sameItem(x.content, t.content));
      if (hit && !hit.evidence) hit.evidence = clip(t.evidence, 200);
    }
    if (d.done.length > MAX_DONE) d.done = d.done.slice(-MAX_DONE);
    const forgotten = d.done.filter((x) => !next.some((t) => sameItem(t.content, x.content)));
    const redo = [];
    for (const t of next) {
      if (t.status === 'completed') continue;
      const hit = d.done.find((x) => sameItem(x.content, t.content));
      if (hit) redo.push({ item: t.content, done: hit });
    }
    d.todos = next.map((t) => ({ content: t.content, status: t.status }));
    this.save();
    return { todos: d.todos, justCompleted, forgotten, redo };
  }

  // ── 模型记的 ───────────────────────────────────────────────────────────

  note({ kind, text, path: p, line } = {}) {
    if (!NOTE_KINDS.includes(kind)) return { error: `kind 只能是 ${NOTE_KINDS.join(' / ')}。` };
    const said = clip(text, NOTE_CHARS);
    if (!said) return { error: '没有 text：要记的那句话是什么？' };
    const list = this.data.notes[kind];
    const where = typeof p === 'string' && p.trim() ? p.trim().replace(/^\.\//, '') : '';
    const entry = { at: this.stamp(), text: said, ...(where ? { path: where } : {}), ...(Number.isInteger(line) && line > 0 ? { line } : {}) };
    const same = list.findIndex((x) => sameItem(x.text, said) && (x.path || '') === where);
    if (same >= 0) list[same] = entry; else list.push(entry);
    if (list.length > MAX_NOTES) list.splice(0, list.length - MAX_NOTES);
    if (kind === 'temp' && where) this.created(where);
    this.save();
    return { content: `记下了（${KIND_LABEL[kind]}，这一类现在 ${list.length} 条）。`, summary: `${KIND_LABEL[kind]}：${clip(said, 60)}` };
  }

  // ── 命令行记的 ─────────────────────────────────────────────────────────

  step(text) {
    const d = this.data;
    d.steps.push(clip(String(text).split('\n')[0], 160));
    if (d.steps.length > MAX_STEPS) d.steps = d.steps.slice(-MAX_STEPS);
    this.save();
  }

  created(rel) {
    const d = this.data;
    if (!rel || d.created.includes(rel)) return;
    d.created.push(rel);
    if (d.created.length > MAX_CREATED) d.created = d.created.slice(-MAX_CREATED);
  }

  /**
   * 改了一个文件。line：这次改动从第几行起（不知道就不给）。返回要不要提醒「这一处改了 N 回」（到 CHURN_WARN 里的数时各一次）。
   */
  edited(rel, { creating = false, added = 0, removed = 0, line = null } = {}) {
    const d = this.data;
    const f = d.files[rel] || { edits: 0, added: 0, removed: 0 };
    f.edits += 1; f.added += added; f.removed += removed; f.at = this.stamp();
    delete d.files[rel];           // 最近改的排在后面
    d.files[rel] = f;
    const names = Object.keys(d.files);
    if (names.length > MAX_FILES) delete d.files[names[0]];
    if (creating) this.created(rel);
    let warn = null;
    if (Number.isInteger(line) && line > 0 && !creating) {
      const from = Math.floor((line - 1) / CHURN_SPAN) * CHURN_SPAN + 1;
      const key = `${rel}:${from}`;
      d.churn[key] = (d.churn[key] || 0) + 1;
      if (CHURN_WARN.includes(d.churn[key])) warn = { rel, from, to: from + CHURN_SPAN - 1, count: d.churn[key] };
      this.focus(rel, Math.max(1, line - 40), 160);
    } else {
      this.save();
    }
    return warn;
  }

  /** 刚才在看 / 在改哪一段（压缩之后把这几段的当前内容还回去）。同一个文件挨着的段合成一条，只留最近几条。 */
  focus(rel, offset = 1, limit = 200) {
    const d = this.data;
    const from = Math.max(1, Number(offset) || 1);
    const to = from + Math.max(1, Math.min(2000, Number(limit) || 200)) - 1;
    const near = d.focus.findIndex((x) => x.path === rel && from <= x.to + 40 && to >= x.from - 40);
    let entry = { path: rel, from, to };
    if (near >= 0) {
      const old = d.focus.splice(near, 1)[0];
      entry = { path: rel, from: Math.min(old.from, from), to: Math.max(old.to, to) };
      if (entry.to - entry.from > 600) entry = { path: rel, from, to };   // 合出来太大就只留最新这一段
    }
    d.focus.push(entry);
    if (d.focus.length > MAX_FOCUS) d.focus = d.focus.slice(-MAX_FOCUS);
    this.save();
  }

  /** 这一句结束时和开工时的文件清单比出来的新文件（shell 建的，工具那边看不到）。 */
  addCreated(list) {
    for (const rel of list) this.created(rel);
    this.save();
  }

  // ── 给模型看的那一段 ────────────────────────────────────────────────────

  /** 整张卡。reason：为什么这时候给（压缩之后 / 上一轮没做完 / 续接）。 */
  card({ reason = '' } = {}) {
    const d = this.data;
    const out = ['## 工作状态（命令行记的，压缩和重启都不会丢；和你的印象不一样时以这里为准）'];
    if (reason) out.push(reason);
    if (d.said.length) {
      out.push('', '### 用户说过的话（逐字，按先后）');
      d.said.forEach((s, i) => out.push(`${i + 1}. ${s.steer ? '（干活中途补充）' : ''}${s.text}`));
    }
    if (d.todos.length) {
      const box = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
      // 「## 任务清单」这几个字要在：循环靠它认「清单已经在历史里了」，不再另补一条
      out.push('', '### 任务清单（你自己列的；做完一项就用 update_todos 更新）', ...d.todos.map((t) => `- ${box[t.status] || '[ ]'} ${t.content}`));
    }
    const gone = d.done.filter((x) => !d.todos.some((t) => sameItem(t.content, x.content)));
    const listed = d.done.filter((x) => !gone.includes(x) && x.evidence);
    if (gone.length || listed.length) {
      out.push('', '### 已经做完的（不用重做；真要重做先说原因）');
      for (const x of [...gone, ...listed].slice(-20)) out.push(`- ${hhmm(x.at)} ${x.content}${x.evidence ? ` —— 验证：${x.evidence}` : ''}`);
    }
    for (const kind of ['decision', 'dead_end', 'anchor']) {
      const list = d.notes[kind];
      if (!list.length) continue;
      out.push('', `### ${KIND_LABEL[kind]}${kind === 'dead_end' ? '（试过不行，别再试）' : ''}`);
      for (const n of list) out.push(`- ${n.path ? `\`${n.path}${n.line ? `:${n.line}` : ''}\` ` : ''}${n.text}`);
    }
    const files = Object.entries(d.files);
    if (files.length) {
      out.push('', '### 改过的文件');
      for (const [rel, f] of files.slice(-20)) out.push(`- \`${rel}\`：改了 ${f.edits} 回（+${f.added} -${f.removed}）`);
    }
    const hot = Object.entries(d.churn).filter(([, n]) => n >= CHURN_WARN[0]).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (hot.length) {
      out.push('', '### 同一处改得多的（先想清楚验收是什么，或者问用户，再接着改）');
      for (const [key, n] of hot) { const at = key.lastIndexOf(':'); out.push(`- \`${key.slice(0, at)}\` 第 ${key.slice(at + 1)} 行起的 ${CHURN_SPAN} 行：${n} 回`); }
    }
    if (d.created.length) {
      const temp = new Set(d.notes.temp.map((n) => n.path).filter(Boolean));
      out.push('', '### 这段会话新建的文件（临时的用完要删）');
      out.push(d.created.slice(-40).map((rel) => `\`${rel}\`${temp.has(rel) || /^(_|tmp)|\.tmp$/i.test(path.basename(rel)) ? '（临时）' : ''}`).join('、'));
    }
    if (d.steps.length) out.push('', '### 最近几步', ...d.steps.slice(-MAX_STEPS).map((s) => `- ${s.replace(/`/g, "'")}`));
    return out.join('\n');
  }
}

/** 这段会话的状态卡放哪：有会话记录就挨着它（sessions/<id>.state.json），没有（桌面 / 网页那一份）就放 .zhiqu/state.json。 */
export function statePath({ store, session, root }) {
  if (store && session && session.id && /^[A-Za-z0-9_-]{1,64}$/.test(session.id) && !String(session.id).startsWith('ephemeral-')) {
    return path.join(store.sessionsDir, `${session.id}.state.json`);
  }
  return root ? path.join(root, '.zhiqu', 'state.json') : null;
}

/** 开工时和结束时各列一遍文件，比出新建的。只为了那份名单：太多（超过 limit）就不比。 */
export function listFiles(root, { limit = 4000, skip = new Set(['.git', '.zhiqu', 'node_modules', 'target', 'build', 'dist', 'out', '.idea', '.vscode', '__pycache__', '.venv', 'venv']) } = {}) {
  const out = new Set();
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      if (skip.has(e.name) || e.name === '.DS_Store') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!walk(path.join(dir, e.name), r)) return false; } else if (e.isFile()) {
        out.add(r);
        if (out.size > limit) return false;
      }
    }
    return true;
  };
  return walk(root, '') ? out : null;
}

/** 这次改动从第几行起：新旧两份第一处不一样的行。 */
export function firstChangedLine(oldText, newText) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i + 1;
  return a.length === b.length ? null : n + 1;
}
