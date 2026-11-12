// 上一轮留下的进度（第一百三十六轮）。
//
// 用户的原话：「每次做到一半，没有完全修复就暂停，下一次又得从头开始」「每次要建一个临时脚本，没改完就暂停了，
// 下一次又建临时脚本，又从头开始看」。桌面版每一轮都是**新进程**：上下文只有前端给的最近几十条问答，
// 上一轮改到哪、临时脚本在哪、跑到哪一步，全都没带过来 —— 于是模型重建一遍、从头再读一遍。
//
// 这里在项目里留一份小小的进度笔记（`.zhiqu/progress.md`）：
//   - 一轮**没做完**（被打断 / 出错 / 连着重复被停下）→ 写下来：改了哪些文件、跑过什么、最后一步；
//   - 一轮正常收尾 → 删掉，不留噪音；
//   - 下一轮开工 → 读进来，作为一条 system 消息排在用户这句话前面。
//
// 只记事实（从 ctx.changedFiles / ctx.steps 来），不让模型自己编。超过一天的不算 —— 那是上一次的活，不是接着做。
import fs from 'node:fs';
import path from 'node:path';

const REL = path.join('.zhiqu', 'progress.md');
const MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_STEPS = 8;

export function progressPath(root) {
  return path.join(root, REL);
}

/**
 * 写一份进度。done 为真时删掉（上一轮做完了，下一轮不用提）。
 * 只读目录 / 没权限 / root 是临时空间：记不上就算了，不能因为记账把这一轮弄挂。
 */
export function writeProgress(root, { done = false, files = [], steps = [], lastStep = '' } = {}) {
  if (!root) return;
  try {
    const file = progressPath(root);
    if (done) { fs.rmSync(file, { force: true }); return; }
    const kept = steps.filter(Boolean).slice(-MAX_STEPS).map((s) => String(s).split('\n')[0].slice(0, 200));
    // 这一轮什么都没做（用户只是问了一句）：不动已有的笔记 —— 上一轮没做完的进度还等着接上
    if (!files.length && !kept.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = new Date();
    const lines = [
      `<!-- zhiqu-progress ${at.toISOString()} unfinished -->`,
      `# 上一轮没做完（${at.toLocaleString('zh-CN', { hour12: false })}）`,
      '',
    ];
    if (files.length) lines.push(`改过的文件：${files.map((f) => `\`${f}\``).join('、')}`, '');
    if (kept.length) {
      lines.push('做过的步骤（最后几条）：');
      for (const s of kept) lines.push(`- ${s.replace(/`/g, "'")}`);
      lines.push('');
    }
    if (lastStep) lines.push(`最后一步：${String(lastStep).split('\n')[0].slice(0, 200).replace(/`/g, "'")}`, '');
    fs.writeFileSync(file, lines.join('\n'));
  } catch {
    /* 记不上就算了 */
  }
}

/** 读上一轮没做完的进度。没有、做完了、超过一天：都返回 null。 */
export function readProgress(root, now = Date.now()) {
  if (!root) return null;
  try {
    const text = fs.readFileSync(progressPath(root), 'utf8');
    const m = /^<!-- zhiqu-progress (\S+) (\S+) -->/.exec(text);
    if (!m || m[2] === 'done') return null;
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at) || now - at > MAX_AGE_MS) return null;
    const body = text.slice(text.indexOf('-->') + 3).trim();
    return body ? { text: body, at } : null;
  } catch {
    return null;
  }
}

/** 拼成给模型看的一段。说清楚「接着做，不要从头再看一遍」。 */
export function progressBlock(p) {
  return [
    '## 上一轮在这个项目里没做完',
    p.text,
    '',
    '接着做：先看一眼上面这些文件现在长什么样（读一次就够），不要从头再通读整个项目，',
    '也不要重建已经有的临时脚本 —— 它多半还在。上一轮没做完不是你的错，是到点被掐断了。',
  ].join('\n');
}

export function clearProgress(root) {
  try { fs.rmSync(progressPath(root), { force: true }); } catch { /* 忽略 */ }
}
