// 会话记录，/resume 用。都在工作区的 .zhiqu/ 下（用户 2026-09-24 定的）：
//
//   .zhiqu/setup.json            会话索引：标题、时间、条数、最后一次用的是哪段
//   .zhiqu/sessions/<id>.jsonl   每段会话的完整记录，一行一件事（消息、压缩、档位切换）
//   .zhiqu/.gitignore            忽略上面两样（个人聊天记录）；skills/、mcp.json 可以提交共享
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './config.js';
import { monotonic } from './clock.js';
import { generatedOrigin } from './origins.js';

const GITIGNORE = '# zhiqu：个人的聊天记录与本机设置不进仓库；skills/、mcp.json、settings.json 可以提交共享\nsessions/\nsetup.json\nsettings.local.json\nmemory/\n';

/**
 * 一行一行地读，不把整个文件读成一个字符串（第一百三十七轮）：原来 readFileSync(file, 'utf8')，
 * 文件超过 512MB（V8 一个字符串的上限）就 ERR_STRING_TOO_LONG —— 用户那段带截图的会话 555MB，/resume 读不回来。
 * 同步的（load / transcript 的调用方都是同步的）。一行本身多长都行，按块攒。
 */
export function eachLine(file, fn, chunkBytes = 1 << 20) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  try {
    const buf = Buffer.allocUnsafe(chunkBytes);
    let pending = [];
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkBytes, null);
      if (n <= 0) break;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(10, start);
        if (nl < 0 || nl >= n) break;
        pending.push(Buffer.from(buf.subarray(start, nl)));
        fn(pending.length === 1 ? pending[0].toString('utf8') : Buffer.concat(pending).toString('utf8'));
        pending = [];
        start = nl + 1;
      }
      if (start < n) pending.push(Buffer.from(buf.subarray(start, n)));
    }
    if (pending.length) fn(Buffer.concat(pending).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

const DATA_URL = /^data:([a-z0-9.+/-]+);base64,/i;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const GONE = { type: 'text', text: '（这张截图的文件已经不在了）' };

/** 一轮的锁（第一百四十五轮起，docs/app-resume-plan.md 第 2 步）：拿着的进程每 LOCK_BEAT_MS 碰一下文件；超过 LOCK_STALE_MS 没碰、或者进程没了，算崩了留下的 */
export const LOCK_BEAT_MS = 10_000;
export const LOCK_STALE_MS = 30_000;

export function newSessionId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

export class SessionStore {
  constructor(root) {
    this.dir = path.join(root, '.zhiqu');
    this.sessionsDir = path.join(this.dir, 'sessions');
    this.index = path.join(this.dir, 'setup.json');
    /** 每段会话的记录文件、这个进程最后知道的长度：比它长了就是别人（应用、另一个命令行）接着写过 */
    this.marks = new Map();
  }

  ensure() {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    const gi = path.join(this.dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE);
  }

  readIndex() {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(this.index, 'utf8')); } catch { /* 没有，或者坏了：下面按会话文件补回来 */ }
    const sessions = data && Array.isArray(data.sessions) ? data.sessions.filter((s) => s && typeof s.id === 'string') : [];
    const known = new Set(sessions.map((s) => s.id));
    for (const found of this.orphanSessions(known)) sessions.push(found);
    return { version: 1, sessions, lastSessionId: (data && data.lastSessionId) || null };
  }

  /**
   * 会话文件在、索引里没有它：从文件本身重建一条（第十六轮）。原来索引坏了（强杀在写索引的那一刻、手改坏了）就当成空的，
   * 下一次写索引把它整个换掉 —— 聊天记录都还在 sessions/ 里，/resume 却再也找不到，等于丢了。
   * 平时一个都没有，只多一次 readdir；补回来的下一次写索引时就存进去了。
   */
  orphanSessions(known) {
    let files = [];
    try { files = fs.readdirSync(this.sessionsDir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
    const out = [];
    for (const f of files) {
      const id = f.slice(0, -'.jsonl'.length);
      if (known.has(id) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
      const file = path.join(this.sessionsDir, f);
      let title = '';
      let createdAt = null;
      let messages = 0;
      let mtime;
      try {
        mtime = fs.statSync(file).mtime.toISOString();
        eachLine(file, (line) => {
          if (!line) return;
          let e;
          try { e = JSON.parse(line); } catch { return; }
          if (!createdAt && e.at) createdAt = e.at;
          if (e.type === 'message' && e.message) {
            messages += 1;
            const m = e.message;
            if (!title && m.role === 'user' && typeof m.content === 'string' && !e.origin && !m.origin) title = m.content.trim().slice(0, 40);
          }
        });
      } catch { continue; }
      out.push({ id, title: title || '（从记录里找回的会话）', createdAt: createdAt || mtime, updatedAt: mtime, messages, model: null, recovered: true });
    }
    return out;
  }

  writeIndex(index) {
    index.sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    writeFileAtomic(this.index, `${JSON.stringify(index, null, 2)}\n`);
  }

  /**
   * 改索引的「读 → 改 → 写」包在一把锁里：同一个工作区开了两个 zhiqu 时，两边同时改 setup.json
   * 会互相覆盖，一边的会话就从索引里消失了（记录还在 sessions/ 里，但 /resume 找不到）。
   * 锁是一个用 wx 创建的文件；超过 10 秒没动的锁当成崩溃留下的，清掉再拿。拿不到（3 秒）就照写 ——
   * 宁可偶尔丢一条索引，也不能让命令行卡住。
   */
  withIndexLock(fn) {
    this.ensure();
    const lock = `${this.index}.lock`;
    const deadline = monotonic() + 3000;
    let fd = null;
    while (fd == null) {
      try {
        fd = fs.openSync(lock, 'wx');
      } catch (e) {
        if (e.code !== 'EEXIST') break;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmSync(lock, { force: true }); continue; }
        } catch { continue; }
        if (monotonic() > deadline) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
    try {
      return fn();
    } finally {
      if (fd != null) {
        fs.closeSync(fd);
        fs.rmSync(lock, { force: true });
      }
    }
  }

  create({ title = '', model = null } = {}) {
    this.ensure();
    const now = new Date().toISOString();
    const meta = { id: newSessionId(), title, createdAt: now, updatedAt: now, messages: 0, model };
    this.withIndexLock(() => {
      const index = this.readIndex();
      index.sessions.push(meta);
      index.lastSessionId = meta.id;
      this.writeIndex(index);
    });
    this.mark(meta.id);
    return meta;
  }

  /**
   * 用给定的 id 打开一段会话，索引里没有就补一条（第一百四十五轮）：桌面应用的本机代码助手每一轮是新进程，
   * 同一个对话（Notebook）要落在同一份记录里，id 由页面给（app-<notebookId>），不能每轮新起一个。
   * 已经在索引里的原样返回（标题等不动）。
   */
  adopt(id, { title = '', model = null, via = null } = {}) {
    this.file(id);   // 只认合规的 id
    this.ensure();
    let meta = null;
    this.withIndexLock(() => {
      const index = this.readIndex();
      meta = index.sessions.find((s) => s.id === id) || null;
      if (meta) return;
      const now = new Date().toISOString();
      meta = { id, title, createdAt: now, updatedAt: now, messages: 0, model, ...(via ? { via } : {}) };
      index.sessions.push(meta);
      index.lastSessionId = id;
      this.writeIndex(index);
    });
    this.mark(id);
    return meta;
  }

  file(id) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`会话 id 不对：${id}`);
    return path.join(this.sessionsDir, `${id}.jsonl`);
  }

  /** 这段会话的图放哪：sessions/<id>/blobs/（跟着 sessions/ 一起被 .gitignore 忽略） */
  blobDir(id) {
    return path.join(this.file(id).slice(0, -'.jsonl'.length), 'blobs');
  }

  /**
   * 图不进记录正文（第一百三十七轮）：base64 存成旁边的文件（按内容取名，同一张只存一份），记录里只留引用。
   * 原来图以 base64 躺在每条消息里，每次压缩又把整份留下的消息（连图）再存一遍 —— 96 张图的会话文件 555MB。
   */
  externalize(id, message) {
    if (!message || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((p) => {
      const url = p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string' ? p.image_url.url : null;
      const m = url && DATA_URL.exec(url);
      if (!m) return p;
      try {
        const bytes = Buffer.from(url.slice(m[0].length), 'base64');
        const mediaType = m[1].toLowerCase();
        const name = `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${EXT[mediaType] || 'bin'}`;
        const dir = this.blobDir(id);
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, bytes); }
        changed = true;
        return { type: 'image_ref', blob: name, mediaType, bytes: bytes.length };
      } catch {
        return p;   // 存不了就照原样记：宁可文件大，不能丢图
      }
    });
    return changed ? { ...message, content } : message;
  }

  /** 读回来时把引用换回图；文件不在了换成一句话（结构不变，发给模型不会被拒）。 */
  hydrate(id, message) {
    if (!message || !Array.isArray(message.content) || !message.content.some((p) => p && p.type === 'image_ref')) return message;
    return { ...message, content: message.content.map((p) => {
      if (!p || p.type !== 'image_ref') return p;
      if (!/^[a-f0-9]{8,64}\.[a-z0-9]{1,5}$/.test(String(p.blob))) return GONE;
      try {
        const bytes = fs.readFileSync(path.join(this.blobDir(id), p.blob));
        return { type: 'image_url', image_url: { url: `data:${p.mediaType || 'image/png'};base64,${bytes.toString('base64')}` } };
      } catch {
        return GONE;
      }
    }) };
  }

  append(id, entry) {
    this.ensure();
    let row = entry;
    if (entry && entry.message) row = { ...entry, message: this.externalize(id, entry.message) };
    else if (entry && Array.isArray(entry.messages)) row = { ...entry, messages: entry.messages.map((m) => this.externalize(id, m)) };
    else if (entry && Array.isArray(entry.edits)) row = { ...entry, edits: entry.edits.map((e) => ({ ...e, message: this.externalize(id, e.message) })) };
    fs.appendFileSync(this.file(id), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
    if (this.marks.has(id)) this.mark(id);
  }

  /** 记下这段记录现在多长（打开、续接时；之后自己每写一行跟着挪） */
  mark(id) {
    let size = 0;
    try { size = fs.statSync(this.file(id)).size; } catch { /* 还没有文件：0 */ }
    this.marks.set(id, size);
  }

  /**
   * 上次记下之后别人往这段记录里追加的那几行（解析好的）；没变、没记过号返回 null。读完把记号挪到末尾。
   * 文件变短了（被人截过）：返回空数组 —— 调用方照样整份重读。
   */
  appendedElsewhere(id) {
    if (!this.marks.has(id)) return null;
    const from = this.marks.get(id);
    let size;
    try { size = fs.statSync(this.file(id)).size; } catch { return null; }
    if (size === from) return null;
    this.marks.set(id, size);
    if (size < from) return [];
    const out = [];
    let fd;
    try {
      fd = fs.openSync(this.file(id), 'r');
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* 半行：下次整份重读时会读到 */ }
      }
    } catch { /* 读不了也算变了 */ } finally {
      if (fd != null) fs.closeSync(fd);
    }
    return out;
  }

  /**
   * 拿这段会话的「一轮」锁（第二步）：同一时刻只有一边（应用的本机代码助手、某一个命令行）在往这段记录里跑一轮。
   * 拿到返回 { release }；别人拿着返回 { busy: { who, pid, at } }。锁文件在 sessions/<id>.turn.lock，拿着时每 beatMs 碰一下。
   * 遗留的（超过 staleMs 没碰、或者那个进程已经没了、或者就是这个进程自己留下的）清掉再拿。
   * 建不了锁文件（只读的盘之类）：照跑，不能因为锁把人挡在外面。
   */
  lockTurn(id, who, { beatMs = LOCK_BEAT_MS, staleMs = LOCK_STALE_MS } = {}) {
    const file = `${this.file(id).slice(0, -'.jsonl'.length)}.turn.lock`;
    try { this.ensure(); } catch { return { release() {} }; }
    for (let attempt = 0; attempt < 3; attempt++) {
      let fd;
      try {
        fd = fs.openSync(file, 'wx');
      } catch (e) {
        if (e.code !== 'EEXIST') return { release() {} };
        let info = null;
        let stale = false;
        try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 刚建、还没写完；或者坏了 */ }
        try { stale = Date.now() - fs.statSync(file).mtimeMs > staleMs; } catch { continue; }   // 刚被放掉：再试
        const pid = info && Number.isSafeInteger(info.pid) ? info.pid : null;
        if (!stale && pid === process.pid) stale = true;
        if (!stale && pid) { try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') stale = true; } }
        if (stale) { try { fs.rmSync(file, { force: true }); } catch { /* 下一圈再看 */ } continue; }
        return { busy: { who: (info && info.who) || null, pid, at: (info && info.at) || null } };
      }
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, who, at: new Date().toISOString() })); } finally { fs.closeSync(fd); }
      const beat = setInterval(() => { try { const t = new Date(); fs.utimesSync(file, t, t); } catch { /* 下次再碰 */ } }, beatMs);
      if (beat.unref) beat.unref();
      let held = true;
      return {
        release() {
          if (!held) return;
          held = false;
          clearInterval(beat);
          try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file, { force: true }); } catch { /* 已经没了 */ }
        },
      };
    }
    return { busy: { who: null, pid: null, at: null } };
  }

  touch(id, patch = {}) {
    this.withIndexLock(() => {
      const index = this.readIndex();
      const row = index.sessions.find((s) => s.id === id);
      if (!row) return;
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      index.lastSessionId = id;
      this.writeIndex(index);
    });
  }

  list() {
    return this.readIndex().sessions;
  }

  last() {
    const index = this.readIndex();
    return index.sessions.find((s) => s.id === index.lastSessionId) || index.sessions[0] || null;
  }

  /** 按记录重放出对话：消息依次追加；遇到压缩就换成压缩后的那一份。坏掉的行跳过并计数。 */
  load(id) {
    const meta = this.list().find((s) => s.id === id);
    if (!meta) throw new Error(`没有这段会话：${id}`);
    let messages = [];
    let mode = null;
    let goal = null;
    let todos = [];
    let broken = 0;
    // 和应用对过账的位置（第一百四十五轮）：最后一次 sync 记的 Notebook 消息号，和那之后这份记录里人说过的话（按顺序）
    let sync = null;
    let said = [];
    eachLine(this.file(id), (line) => {
      if (!line.trim()) return;
      let e;
      try { e = JSON.parse(line); } catch { broken++; return; }
      if (e.type === 'message' && e.message) {
        messages.push(e.message);
        const m = e.message;
        if (m.role === 'user' && !e.origin && typeof m.content === 'string' && !generatedOrigin(m.content)) said.push({ text: m.content, pending: true });
        else if (said.length && said[said.length - 1].pending) said[said.length - 1] = { text: said[said.length - 1].text };
      }
      else if (e.type === 'compact' && Array.isArray(e.messages)) messages = e.messages;
      else if (e.type === 'clear' && Array.isArray(e.edits)) applyEdits(messages, e);
      else if (e.type === 'mode' && e.mode) mode = e.mode;
      else if (e.type === 'goal') goal = e.goal || null;
      else if (e.type === 'todos' && Array.isArray(e.todos)) todos = e.todos;
      else if (e.type === 'sync') { sync = Number.isSafeInteger(e.upto) ? e.upto : null; said = []; }
      // 人说的一句：said 行是原话（runTurn 记在那条消息后面）；没有 said 行的老记录（第一百四十五轮以前）退回用那条消息本身
      else if (e.type === 'said' && typeof e.text === 'string') {
        if (said.length && said[said.length - 1].pending) said[said.length - 1] = { text: e.text };
        else said.push({ text: e.text });
      }
    });
    // 图只给最后留下来的那几条换回去（中间被压缩掉的不用读）
    this.mark(id);   // 读到这里为止：之后变长的是别人写的
    return { meta, messages: dropDanglingToolCalls(messages).map((m) => this.hydrate(id, m)), mode, goal, todos, broken, sync, said: said.map((x) => x.text) };
  }

  /**
   * 给人看的完整记录：每一条原话按顺序。和 load() 不一样的地方 —— 压缩<b>不</b>替换前面的消息
   * （压缩只影响发给模型的那一份；用户翻回去要看的是原话），只在压缩发生的位置留一个标记。
   */
  transcript(id) {
    const out = [];
    eachLine(this.file(id), (line) => {
      if (!line.trim()) return;
      let e;
      try { e = JSON.parse(line); } catch { return; }
      // 给人看的记录不带图的字节（旧记录里图是整段 base64：几百张就是几百 MB，全攒在内存里）
      if (e.type === 'message' && e.message) out.push({ kind: 'message', message: briefToolOutput(withoutImageBytes(e.message)), origin: e.origin || null, at: e.at });
      else if (e.type === 'compact') out.push({ kind: 'compact', at: e.at });
      else if (e.type === 'mode' && e.mode) out.push({ kind: 'mode', mode: e.mode, at: e.at });
    });
    return out;
  }
}

// ── 增量的清理记录（第一百六十六轮之后，docs/agent-efficiency-plan.md 第 2 步）──
// 原来每清一次就把整份消息存一遍（{ type: 'compact', messages }）：用户那段会话 19 份快照约 2000 万字，记录涨到 28MB。
// 清理（先清、截图、压过还超时拿掉最大的）不改条数，只换掉几条：记 { type: 'clear', length, edits: [{ i, key, message }] }。
// 真摘要（条数变了）照旧记全量。
// 内存里的那份和记录重放出来的不一定一条对一条（被打断时内存里去掉了悬空的工具调用、/resume 读回来也去掉）：
// 工具结果、带调用的助手消息按调用 id 认（序号对不上就按 id 找）；别的只在条数和角色都对得上时才换 —— 对不上就不换，
// 退回没清理的样子：多背一点，不会错。

/** 认一条消息用的钥匙 */
export function messageKey(m) {
  if (!m) return 'r:';
  if (m.role === 'tool' && m.tool_call_id) return `t:${m.tool_call_id}`;
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) return `a:${m.tool_calls.map((c) => c.id).join(',')}`;
  return `r:${m.role}`;
}

/** 把一条 clear 记录用到重放出来的消息上（原地改）；返回没用上的条数 */
export function applyEdits(messages, entry) {
  let byKey = null;
  let missed = 0;
  for (const e of entry.edits) {
    if (!e || !e.message || !Number.isSafeInteger(e.i) || typeof e.key !== 'string') { missed++; continue; }
    if (e.key.startsWith('r:')) {
      if (messages.length === entry.length && messages[e.i] && messageKey(messages[e.i]) === e.key) messages[e.i] = e.message;
      else missed++;
      continue;
    }
    let at = messages[e.i] && messageKey(messages[e.i]) === e.key ? e.i : -1;
    if (at < 0) {
      if (!byKey) { byKey = new Map(); messages.forEach((m, j) => { const k = messageKey(m); if (!k.startsWith('r:')) byKey.set(k, j); }); }
      at = byKey.has(e.key) ? byKey.get(e.key) : -1;
    }
    if (at >= 0) messages[at] = e.message;
    else missed++;
  }
  return missed;
}

/**
 * 给人看的记录里，工具的输出只留开头（第一百四十八轮）：回放只画它的第一行，原来整段攒在内存里 ——
 * 600MB 的记录（几百段 2MB 的读文件结果）续接时命令行占了 609MB。人说的、助手答的照原样留。
 */
export const TRANSCRIPT_TOOL_CHARS = 4000;
function briefToolOutput(message) {
  if (message.role !== 'tool' || typeof message.content !== 'string' || message.content.length <= TRANSCRIPT_TOOL_CHARS) return message;
  // 真拷一份开头：slice 切出来的是引用原串的一段（V8 的 SlicedString），原来那 2MB 照样留在内存里
  const head = Buffer.from(message.content.slice(0, TRANSCRIPT_TOOL_CHARS), 'utf8').toString('utf8');
  return { ...message, content: `${head}…（共 ${message.content.length} 字，记录里有全文）` };
}

function withoutImageBytes(message) {
  if (!Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map((p) => (p && p.type === 'image_url' ? { type: 'image_ref', blob: null } : p)) };
}

/**
 * 记录可能停在「助手发了工具调用、结果还没写下来」（Ctrl+C、断电）。那样的对话发给模型会被拒 ——
 * 工具调用与结果必须成对。续接时把没有结果的那几个调用补一条「被中断了」。
 */
export function dropDanglingToolCalls(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const answered = new Set();
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') { answered.add(messages[j].tool_call_id); j++; }
      for (let k = i + 1; k < j; k++) out.push(messages[k]);
      for (const call of m.tool_calls) {
        if (!answered.has(call.id)) out.push({ role: 'tool', tool_call_id: call.id, content: '（这次调用被中断了，没有结果）' });
      }
      i = j - 1;
    }
  }
  return out;
}
