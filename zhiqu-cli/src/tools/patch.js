// apply_patch（第一百一十一轮，Codex 同级第 4 步）的解析和打补丁：纯函数，不碰文件。
// 格式和 Codex 一样，模型见得多：
//   *** Begin Patch
//   *** Add File: 路径        后面每行 + 开头
//   *** Update File: 路径     可选一行 *** Move to: 新路径；然后一段段 @@ 可选的定位行 + 上下文（空格开头）/ -删 / +加；可选 *** End of File
//   *** Delete File: 路径
//   *** End Patch
// 和 Codex 不一样的一处：原文出现几处就拒绝（说出行号），不取第一处。取错了是一声不响地改错地方；edit_file 也是这个规矩。
import { hintFor } from './edit.js';

const FORMAT = '格式：*** Begin Patch / *** Add File: 路径（每行 + 开头）/ *** Update File: 路径（@@ 然后空格开头的上下文、- 删、+ 加）/ *** Delete File: 路径 / *** End Patch';

export function parsePatch(text) {
  let lines = String(text ?? '').replace(/\r\n/g, '\n').trim().split('\n');
  // 模型常包一层代码块
  if (lines.length > 1 && /^```/.test(lines[0]) && /^```\s*$/.test(lines[lines.length - 1])) lines = lines.slice(1, -1);
  if (lines[0].trim() !== '*** Begin Patch') return { error: { kind: 'format', message: `第一行要是 *** Begin Patch。${FORMAT}` } };
  if (lines[lines.length - 1].trim() !== '*** End Patch') return { error: { kind: 'format', message: `最后一行要是 *** End Patch（可能写到一半被截断了）。${FORMAT}` } };
  const ops = [];
  let i = 1;
  const end = lines.length - 1;
  const bad = (at, why) => ({ error: { kind: 'format', message: `第 ${at + 1} 行${why}：${lines[at].slice(0, 80)}。${FORMAT}` } });
  while (i < end) {
    const line = lines[i];
    let m;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) {
      const body = [];
      i += 1;
      while (i < end && !lines[i].startsWith('*** ')) {
        if (!lines[i].startsWith('+')) return bad(i, '不是 + 开头（新文件的每一行都要 +）');
        body.push(lines[i].slice(1));
        i += 1;
      }
      ops.push({ type: 'add', path: m[1].trim(), content: body.length ? `${body.join('\n')}\n` : '' });
    } else if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) {
      ops.push({ type: 'delete', path: m[1].trim() });
      i += 1;
    } else if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) {
      const op = { type: 'update', path: m[1].trim(), moveTo: null, hunks: [] };
      i += 1;
      const moved = i < end ? /^\*\*\* Move to: (.+)$/.exec(lines[i]) : null;
      if (moved) { op.moveTo = moved[1].trim(); i += 1; }
      let hunk = null;
      const open = (context) => { hunk = { context, lines: [], eof: false }; op.hunks.push(hunk); };
      while (i < end) {
        const l = lines[i];
        if (l === '*** End of File') {
          if (!hunk) return bad(i, '前面没有要改的内容');
          hunk.eof = true;
          i += 1;
          continue;
        }
        if (l.startsWith('*** ')) break;
        if (l.startsWith('@@')) {
          const context = l.slice(2).replace(/@@\s*$/, '').trim();
          open(context || null);
          i += 1;
          continue;
        }
        if (!hunk) open(null);
        // 空行当空的上下文：模型常把行首那个空格丢了
        if (l === '') hunk.lines.push({ t: ' ', s: '' });
        else if (l[0] === ' ' || l[0] === '-' || l[0] === '+') hunk.lines.push({ t: l[0], s: l.slice(1) });
        else return bad(i, '开头不是空格、- 或 +');
        i += 1;
      }
      if (!op.moveTo && !op.hunks.some((h) => h.lines.some((x) => x.t !== ' '))) return { error: { kind: 'format', message: `${op.path} 没有要改的内容（没有 - 或 + 开头的行）。` } };
      ops.push(op);
    } else {
      return bad(i, '认不出来');
    }
  }
  if (!ops.length) return { error: { kind: 'format', message: `补丁是空的。${FORMAT}` } };
  return { ops };
}

const rstrip = (s) => s.replace(/[ \t]+$/, '');

function positions(lines, block, from, same) {
  const out = [];
  for (let p = from; p + block.length <= lines.length; p++) {
    let ok = true;
    for (let k = 0; k < block.length; k++) if (!same(lines[p + k], block[k])) { ok = false; break; }
    if (ok) out.push(p);
  }
  return out;
}

/** 按段打到文本上。段按文件里的顺序，后一段从前一段后面开始找。返回 { text } 或 { error } */
export function applyHunks(text, hunks) {
  const crlf = text.includes('\r\n') && !/(^|[^\r])\n/.test(text);
  const hay = crlf ? text.replace(/\r\n/g, '\n') : text;
  const endsNl = hay.endsWith('\n');
  const lines = hay.split('\n');
  if (endsNl || hay === '') lines.pop();
  const edits = [];
  let cursor = 0;
  for (let index = 0; index < hunks.length; index++) {
    const hunk = hunks[index];
    const no = index + 1;
    if (hunk.context) {
      let at = lines.findIndex((l, p) => p >= cursor && rstrip(l) === rstrip(hunk.context));
      if (at < 0) at = lines.findIndex((l, p) => p >= cursor && l.trim() === hunk.context.trim());
      if (at < 0) return { error: { kind: 'anchor', hunk: no, anchor: hunk.context } };
      cursor = at + 1;
    }
    const before = hunk.lines.filter((x) => x.t !== '+').map((x) => x.s);
    const added = hunk.lines.filter((x) => x.t === '+').map((x) => x.s);
    if (!before.length) {
      // 只有 + ：有定位行放在它后面，没有就放在文件末尾
      const at = hunk.context && !hunk.eof ? cursor : lines.length;
      edits.push({ at, remove: 0, insert: added });
      cursor = at;
      continue;
    }
    // 先一字不差地比；不行再放过行尾空白（缩进不放过：Python 里缩进是语义）
    let found = positions(lines, before, cursor, (a, b) => a === b);
    if (!found.length) found = positions(lines, before, cursor, (a, b) => rstrip(a) === rstrip(b));
    if (hunk.eof) found = found.filter((p) => p + before.length === lines.length);
    if (!found.length) return { error: { kind: 'not_found', hunk: no, hint: hintFor(hay, before.join('\n')) } };
    if (found.length > 1) return { error: { kind: 'ambiguous', hunk: no, lines: found.map((p) => p + 1) } };
    const start = found[0];
    const insert = [];
    let p = start;
    for (const x of hunk.lines) {
      if (x.t === '+') insert.push(x.s);
      else { if (x.t === ' ') insert.push(lines[p]); p += 1; }   // 上下文留文件里的原样，不换成补丁里的
    }
    edits.push({ at: start, remove: before.length, insert });
    cursor = start + before.length;
  }
  const out = [];
  let from = 0;
  for (const e of edits) {
    out.push(...lines.slice(from, e.at), ...e.insert);
    from = e.at + e.remove;
  }
  out.push(...lines.slice(from));
  let next = out.join('\n');
  if ((endsNl || hay === '') && out.length) next += '\n';
  if (next === hay) return { error: { kind: 'no_change' } };
  return { text: crlf ? next.replace(/\n/g, '\r\n') : next };
}

const describeHint = (hint) => {
  if (!hint) return '';
  if (hint.kind === 'whitespace') return `第 ${hint.from}${hint.to > hint.from ? `–${hint.to}` : ''} 行看着一样，但空白不一样（缩进也算）。文件里的原文：\n${hint.original}\n`;
  return `要找的第一行在第 ${hint.at} 行，后面对不上。文件现在是：\n${hint.current}\n`;
};

export function describePatchError(error, rel) {
  const where = error.hunk ? `${rel} 的第 ${error.hunk} 段` : rel;
  switch (error.kind) {
    case 'format': return `补丁写错了，一个文件都没改。${error.message}`;
    case 'anchor': return `${where}：找不到 @@ 后面那一行「${error.anchor}」，一个文件都没改。`;
    case 'not_found': return `${where}：原文对不上，一个文件都没改。${describeHint(error.hint)}先 read_file 看现在的内容，上下文和 - 的行要照原文一字不差（缩进也算）。`;
    case 'ambiguous': return `${where}：这段原文出现了 ${error.lines.length} 处（第 ${error.lines.join('、')} 行），不知道改哪一处，一个文件都没改。多带几行上下文，或者用 @@ 写上它所在的函数。`;
    case 'no_change': return `${rel}：改完和原来一模一样，一个文件都没改。`;
    default: return `${where}：补丁打不上，一个文件都没改。`;
  }
}

/** 补丁里提到的文件（给用户看的那一句用，补丁写错了也不炸） */
export function patchFiles(text) {
  return [...String(text ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
}
