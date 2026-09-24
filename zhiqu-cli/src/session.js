// 会话记录，/resume 用。都在工作区的 .zhiqu/ 下（用户 2026-09-24 定的）：
//
//   .zhiqu/setup.json            会话索引：标题、时间、条数、最后一次用的是哪段
//   .zhiqu/sessions/<id>.jsonl   每段会话的完整记录，一行一件事（消息、压缩、档位切换）
//   .zhiqu/.gitignore            忽略上面两样（个人聊天记录）；skills/、mcp.json 可以提交共享
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './config.js';

const GITIGNORE = '# zhiqu：个人的聊天记录与本机设置不进仓库；skills/、mcp.json、settings.json 可以提交共享\nsessions/\nsetup.json\nsettings.local.json\n';

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
  }

  ensure() {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    const gi = path.join(this.dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE);
  }

  readIndex() {
    try {
      const data = JSON.parse(fs.readFileSync(this.index, 'utf8'));
      return { version: 1, sessions: Array.isArray(data.sessions) ? data.sessions : [], lastSessionId: data.lastSessionId || null };
    } catch {
      return { version: 1, sessions: [], lastSessionId: null };
    }
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
    const deadline = Date.now() + 3000;
    let fd = null;
    while (fd == null) {
      try {
        fd = fs.openSync(lock, 'wx');
      } catch (e) {
        if (e.code !== 'EEXIST') break;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmSync(lock, { force: true }); continue; }
        } catch { continue; }
        if (Date.now() > deadline) break;
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
    return meta;
  }

  file(id) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`会话 id 不对：${id}`);
    return path.join(this.sessionsDir, `${id}.jsonl`);
  }

  append(id, entry) {
    this.ensure();
    fs.appendFileSync(this.file(id), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
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
    let broken = 0;
    const text = fs.existsSync(this.file(id)) ? fs.readFileSync(this.file(id), 'utf8') : '';
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { broken++; continue; }
      if (e.type === 'message' && e.message) messages.push(e.message);
      else if (e.type === 'compact' && Array.isArray(e.messages)) messages = e.messages;
      else if (e.type === 'mode' && e.mode) mode = e.mode;
      else if (e.type === 'goal') goal = e.goal || null;
    }
    return { meta, messages: dropDanglingToolCalls(messages), mode, goal, broken };
  }

  /**
   * 给人看的完整记录：每一条原话按顺序。和 load() 不一样的地方 —— 压缩<b>不</b>替换前面的消息
   * （压缩只影响发给模型的那一份；用户翻回去要看的是原话），只在压缩发生的位置留一个标记。
   */
  transcript(id) {
    const text = fs.existsSync(this.file(id)) ? fs.readFileSync(this.file(id), 'utf8') : '';
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'message' && e.message) out.push({ kind: 'message', message: e.message, origin: e.origin || null, at: e.at });
      else if (e.type === 'compact') out.push({ kind: 'compact', at: e.at });
      else if (e.type === 'mode' && e.mode) out.push({ kind: 'mode', mode: e.mode, at: e.at });
    }
    return out;
  }
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
