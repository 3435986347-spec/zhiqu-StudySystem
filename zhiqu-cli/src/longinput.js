// 很长的输入（第九轮，用户 2026-09-27：「长上下文输入的时候的分析和工作能力」）。
//
// 用户粘贴一大段（日志、需求文档、别人的代码）原来整块塞进一条 user 消息：
//   - 超过窗口的，服务器兜底裁剪只能裁更早的消息，最新这条原样留着 —— 供应商直接拒绝整个请求；
//   - 没超但占了大半的，模型剩下的地方不够读代码、不够思考，压缩又压不掉「最近一轮」。
// 超过窗口的 30% 就把原文存成工作区里的文件（.zhiqu/inputs/），消息里放开头、结尾和路径，让模型用
// read_file 分段读、用 search 找关键字 —— 和它读一个大源文件是同一套本事，分析长东西本来就该这样做。
// 开头和结尾都放：要求常常写在最前或最后（「帮我看看这段日志 …… 重点看最后几行」）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './compact.js';

export const LONG_INPUT_SHARE = 0.3;
/** 单个文件的大小：比 read_file 能读的上限（256KB）小，留出余量。 */
export const PART_BYTES = 200 * 1024;
const HEAD_SHARE = 0.08;
const TAIL_SHARE = 0.04;

const tokenOf = (ch) => {
  const cp = ch.codePointAt(0);
  return (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x3ffff) ? 1 : 1 / 3.5;
};

/** 从开头（或结尾）取不超过 budget token 的一段，按 compact.js 同一个估算。 */
export function sliceTokens(text, budget, fromEnd = false) {
  const chars = Array.from(text);
  let used = 0;
  let n = 0;
  for (let i = 0; i < chars.length; i++) {
    const t = tokenOf(chars[fromEnd ? chars.length - 1 - i : i]);
    if (used + t > budget) break;
    used += t;
    n++;
  }
  return fromEnd ? chars.slice(chars.length - n).join('') : chars.slice(0, n).join('');
}

/** 按行切成每份不超过 PART_BYTES 字节（一行本身就超的，按字切开）。拼起来就是原文。 */
export function splitParts(text, maxBytes = PART_BYTES) {
  const parts = [];
  let cur = '';
  let curBytes = 0;
  const flush = () => { if (cur) { parts.push(cur); cur = ''; curBytes = 0; } };
  const pieces = text.split(/(?<=\n)/);
  for (let piece of pieces) {
    while (Buffer.byteLength(piece, 'utf8') > maxBytes) {
      flush();
      const head = sliceBytes(piece, maxBytes);
      parts.push(head);
      piece = piece.slice(head.length);
    }
    const b = Buffer.byteLength(piece, 'utf8');
    if (curBytes + b > maxBytes) flush();
    cur += piece;
    curBytes += b;
  }
  flush();
  return parts;
}

function sliceBytes(s, maxBytes) {
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

/**
 * 超过窗口的 LONG_INPUT_SHARE 就落盘；否则返回 null（原样发）。
 * 返回 { message, files, chars, tokens }：message 是替代原文发给模型的那条消息。
 */
export function spillLongInput(root, text, window, now = new Date()) {
  const tokens = estimateTokens(text);
  if (tokens <= window * LONG_INPUT_SHARE) return null;
  const dir = path.join(root, '.zhiqu', 'inputs');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;
  const parts = splitParts(text);
  const files = parts.map((part, i) => {
    const rel = `.zhiqu/inputs/${stamp}${parts.length > 1 ? `-${i + 1}` : ''}.txt`;
    fs.writeFileSync(path.join(root, ...rel.split('/')), part);
    return rel;
  });
  const lines = text.split('\n').length;
  const head = sliceTokens(text, Math.floor(window * HEAD_SHARE));
  const tail = sliceTokens(text, Math.floor(window * TAIL_SHARE), true);
  const chars = Array.from(text).length;
  const message = [
    `【这条消息很长（${chars} 字，约 ${tokens} token，超过这个模型一次能看的 ${Math.round(LONG_INPUT_SHARE * 100)}%），`
      + `原文存进了工作区：${files.join('、')}（共 ${lines} 行${files.length > 1 ? `，按顺序分成 ${files.length} 份` : ''}）。`,
    '下面只放了开头和结尾。要分析就用 read_file 分段读（offset / limit），或者用 search 在 .zhiqu/inputs 里找关键字；'
      + '先把和问题有关的部分读全再下结论，不要只凭开头和结尾推断中间。】',
    '',
    '—— 开头 ——',
    head,
    '…（中间省略，见文件）…',
    '—— 结尾 ——',
    tail,
  ].join('\n');
  return { message, files, chars, tokens };
}
