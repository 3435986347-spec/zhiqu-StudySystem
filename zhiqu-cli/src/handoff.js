// 应用里的对话和这个项目的会话记录之间的交接（第一百四十五轮起，docs/app-resume-plan.md）：
//   - 桌面应用的本机代码助手（host/code-host.js）每一轮打开这段对话的记录，记录里没有的几轮拍扁补进去；
//   - 命令行 /resume 从服务器接一段应用里的对话（只有文字，第一百四十七轮），走的是同一条路。
// 还有一个只在本机的小索引：应用里的对话在哪个文件夹里有记录（~/.zhiqu/app-sessions.json），命令行在别的文件夹里接时据此指路。
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './config.js';
import { SessionStore } from './session.js';
import { WorkState } from './state.js';

/**
 * 前面的对话（第九十五轮）：网页给的只有每一轮的问和最终回答 —— 原样当成一问一答放进去，模型学的是「不调工具直接答」，
 * 两回照着上一次的结果编了这一次的（0 轮）。命令行的历史里有真的工具调用，没有这个问题。所以合成一段带标注的参考，不当成示范。
 */
export function historyBlock(history) {
  const turns = (Array.isArray(history) ? history : []).filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim());
  if (!turns.length) return [];
  const text = turns.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.trim()}`).join('\n\n');
  return [{ role: 'user', content: `【前面的对话，供参考 —— 里面说到的文件内容、命令结果都是当时的，文件可能已经变了；这一次要的结果用工具重新查、重新跑，不要照抄】\n${text}` },
    { role: 'assistant', content: '好的，前面的对话我当参考；这一次要的结果我用工具重新查。' }];
}

const sameText = (s) => String(s || '').trim().slice(0, 4000);

/**
 * 应用那边带来的问答里，记录里还没有的那几轮（在普通聊天、网页上接着说的）。
 *   - 对过账的（消息号不比上次记的 sync 大）不看；没有消息号的（页面压缩的那段前情）只在第一次看；
 *   - 记录里已经有的（宿主自己跑的这几轮、命令行接着说的 —— 都记着 said）按顺序对掉，连同后面的回答。
 */
export function appGap(history, { sync = null, said = [] } = {}) {
  const items = (Array.isArray(history) ? history : []).filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim());
  const fresh = sync == null ? items : items.filter((m) => Number.isSafeInteger(Number(m.id)) && Number(m.id) > sync);
  const pending = said.map(sameText);
  const out = [];
  for (let i = 0; i < fresh.length; i++) {
    const m = fresh[i];
    if (m.role === 'user') {
      const at = pending.indexOf(sameText(m.content));
      if (at >= 0) {
        pending.splice(0, at + 1);
        while (i + 1 < fresh.length && fresh[i + 1].role === 'assistant') i++;
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

/** 这一轮带来的消息号里最大的（没有就是 null） */
export function maxMessageId(history) {
  let max = null;
  for (const m of Array.isArray(history) ? history : []) {
    const n = Number(m && m.id);
    if (m && m.id != null && Number.isSafeInteger(n) && n > 0 && (max == null || n > max)) max = n;
  }
  return max;
}

const LEGACY_TAIL = '接着做的话：先看一眼上面这些文件现在长什么样（读一次就够），不要从头再通读整个项目，也不要重建已经有的临时文件。';

/**
 * 打开（没有就建）这段对话的记录，把前面的对话接好。返回 { store, session, messages, todos }。
 *   - 记录在：用它的消息（带工具调用），记录里没有的那几轮拍扁成「供参考」追加在后面；
 *   - 记录不在：照原来拍扁整段问答起头（也写进记录，命令行 /resume 回去时一样有）；
 *   - 旧版整个文件夹共用的 .zhiqu/state.json：上一轮没做完的话，它的状态卡作为一条说明接进这段，然后删掉（状态卡从此按会话分开）。
 */
export function openAppSession(root, id, history, { model = null } = {}) {
  const store = new SessionStore(root);
  const existed = fs.existsSync(store.file(id));
  const session = store.adopt(id, { model, via: 'app' });
  let messages = [];
  let todos = [];
  let gap;
  if (existed) {
    const loaded = store.load(id);
    messages = loaded.messages;
    todos = loaded.todos || [];
    gap = appGap(history, loaded);
  } else {
    gap = appGap(history);
  }
  const add = (message) => { messages.push(message); store.append(id, { type: 'message', message, origin: 'system' }); };
  if (gap.length) {
    const block = historyBlock(gap);
    if (existed) block[0] = { ...block[0], content: block[0].content.replace('【前面的对话，供参考', '【这段对话在别处（应用的普通聊天、网页）接着说过的几轮，只有文字，供参考') };
    for (const m of block) add(m);
  }
  const upto = maxMessageId(history);
  if (upto != null) store.append(id, { type: 'sync', upto });
  const legacy = path.join(root, '.zhiqu', 'state.json');
  if (fs.existsSync(legacy)) {
    const old = WorkState.open(legacy);
    if (old.inherited && !old.isEmpty()) {
      add({ role: 'user', content: `（上一轮在这个项目里没做完${old.data.turn.status === 'running' ? '：进程没正常结束' : ''}。下面是命令行记着的工作状态。）\n\n${old.card()}\n\n${LEGACY_TAIL}` });
      add({ role: 'assistant', content: '好的，我知道上一轮做到哪了。' });
    }
    try { fs.rmSync(legacy, { force: true }); } catch { /* 删不掉下次再删 */ }
  }
  return { store, session, messages, todos };
}

/** 应用里的对话在哪个文件夹有记录（只在本机）：最多记这么多条，旧的挤掉 */
export const APP_FOLDERS_MAX = 500;

/** 读那个小索引：{ <会话 id>: { root, at } }；没有、坏了都当空的 */
export function appFolders(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && data.sessions && typeof data.sessions === 'object' ? data.sessions : {};
  } catch {
    return {};
  }
}

/** 记一条：这段对话的记录在这个文件夹里。记不上不要紧（只是指路用的） */
export function recordAppFolder(file, id, root) {
  try {
    const all = appFolders(file);
    all[id] = { root: path.resolve(root), at: new Date().toISOString() };
    const kept = Object.entries(all).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, APP_FOLDERS_MAX);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify({ version: 1, sessions: Object.fromEntries(kept) }, null, 2)}\n`);
  } catch { /* 记不上不要紧 */ }
}
