// 收尾时把 README 里的「已知边界」升级成要问用户的风险（testagent-review-plan 3.5 第 5 条，第一百七十七轮）。
// 那次会话把「只存在浏览器本地」「run_shell 不做隔离」写在 README 末尾，最终回复没有拿来问用户。
import fs from 'node:fs';
import path from 'node:path';

const RISK_TITLE = /^(已知边界|已知限制|已知缺陷|已知风险|known limitations|known boundaries)$/i;

function heading(line) {
  const trimmed = line.trim();
  const hash = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(trimmed);
  if (hash) return { level: hash[1].length, text: hash[2].replace(/\*\*/g, '').trim() };
  const bold = /^\*\*(.+?)\*\*$/.exec(trimmed);
  if (bold) return { level: 6, text: bold[1].trim() };
  return null;
}

/** 一个 README 正文里，「已知边界 / 已知限制」那一节的条目。下一节标题就停。 */
export function boundaryItems(markdown) {
  const items = [];
  let on = false;
  let level = 99;
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const h = heading(raw);
    if (h) {
      if (RISK_TITLE.test(h.text)) { on = true; level = h.level; continue; }
      if (on && h.level <= level) on = false;
      continue;
    }
    if (!on) continue;
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (!item) continue;
    const text = item[1].trim().replace(/\s+/g, ' ');
    if (text.length >= 4) items.push(text);
  }
  return items.slice(0, 6);
}

export function readmePaths(changed) {
  const out = [];
  for (const raw of changed || []) {
    const rel = String(raw || '').replace(/\\/g, '/');
    if (rel.includes('已删除')) continue;
    if (/(^|\/)readme\.md$/i.test(rel)) out.push(rel);
  }
  return out;
}

/** 问过「已知边界」，或问题里带上某一条的开头，这一条就算问过了。 */
export function unansweredRisks(items, asked) {
  const blob = String(asked || '').replace(/\s+/g, '');
  if (!items.length) return [];
  if (/已知边界|已知限制|已知缺陷|已知风险|knownlimitations|knownboundaries/i.test(blob)) return [];
  return items.filter((item) => {
    const key = item.replace(/\s+/g, '').slice(0, 12);
    return key.length >= 4 && !blob.includes(key);
  });
}

export function collectReadmeRisks(root, changed) {
  const items = [];
  for (const rel of readmePaths(changed)) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'); } catch { continue; }
    items.push(...boundaryItems(text));
  }
  return items.slice(0, 6);
}

export function boundaryAsk(items, { canAsk = true } = {}) {
  const list = items.map((s, i) => `${i + 1}. ${s}`).join('\n');
  if (!canAsk) {
    return `README 里有已知边界。收尾时要把它们当作需要用户决定的风险说出来，不要只留在文档里：\n${list}`;
  }
  return `README 里有已知边界。收尾前先用 ask_user 问用户要不要收紧（每一条一个问题，标一个推荐），不要只留在文档里：\n${list}`;
}
