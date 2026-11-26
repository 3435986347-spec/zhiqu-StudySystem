// Chrome 调试端口上的一小段 WebSocket（第一百八十八轮）。不引 Playwright，也不加 npm 包。
// 只够发 CDP 的文本帧：客户端掩码、服务端不掩码、ping 回 pong。截图的 JSON 可能有几 MB。
import crypto from 'node:crypto';
import net from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 12_000_000;

function maskBytes(data, mask) {
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i & 3];
  return out;
}

/** opcode：1 文本，10 pong。masked 为真是客户端帧。 */
export function encodeFrame(opcode, data, { masked = false } = {}) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (payload.length > MAX_FRAME) throw new Error('帧太长');
  const head = [0x80 | (opcode & 0x0f)];
  const bit = masked ? 0x80 : 0;
  if (payload.length < 126) head.push(bit | payload.length);
  else if (payload.length < 65536) head.push(bit | 126, payload.length >> 8, payload.length & 255);
  else {
    head.push(bit | 127);
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(payload.length));
    const mask = masked ? crypto.randomBytes(4) : Buffer.alloc(0);
    return Buffer.concat([Buffer.from(head), len, mask, masked ? maskBytes(payload, mask) : payload]);
  }
  const mask = masked ? crypto.randomBytes(4) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(head), mask, masked ? maskBytes(payload, mask) : payload]);
}

export function encodeClientText(text) {
  return encodeFrame(1, text, { masked: true });
}

export function encodeServerText(text) {
  return encodeFrame(1, text, { masked: false });
}

/** 从缓冲区切出完整帧。rest 是还没到齐的尾巴。 */
export function decodeFrames(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const frames = [];
  let o = 0;
  while (o + 2 <= b.length) {
    const opcode = b[o] & 0x0f;
    let len = b[o + 1] & 0x7f;
    const masked = (b[o + 1] & 0x80) !== 0;
    let p = o + 2;
    if (len === 126) {
      if (p + 2 > b.length) break;
      len = b.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > b.length) break;
      const n = b.readBigUInt64BE(p);
      if (n > BigInt(MAX_FRAME)) throw new Error('帧太长');
      len = Number(n);
      p += 8;
    }
    if (len > MAX_FRAME) throw new Error('帧太长');
    const maskLen = masked ? 4 : 0;
    if (p + maskLen + len > b.length) break;
    const mask = masked ? b.subarray(p, p + 4) : null;
    p += maskLen;
    const data = Buffer.from(b.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    p += len;
    o = p;
    frames.push({ opcode, data });
  }
  return { frames, rest: b.subarray(o) };
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key).trim() + GUID).digest('base64');
}

/**
 * 连上 ws://127.0.0.1:port/devtools/... 。
 * 返回 { call(method, params), close() }。call 在时限内等同一个 id 的结果。
 */
export function connectCdp(wsUrl, { timeoutMs = 15_000 } = {}) {
  const url = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: url.hostname, port: Number(url.port) });
    const key = crypto.randomBytes(16).toString('base64');
    let upgraded = false;
    let pending = Buffer.alloc(0);
    let buf = Buffer.alloc(0);
    const waiters = new Map();
    const listeners = new Map();
    let seq = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      for (const [, w] of waiters) w.reject(err);
      waiters.clear();
      reject(err);
    };
    sock.on('error', (e) => fail(e));
    sock.on('data', (chunk) => {
      if (!upgraded) {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('latin1');
        const got = /Sec-WebSocket-Accept:\s*(\S+)/i.exec(head);
        if (!head.startsWith('HTTP/1.1 101') || !got || got[1] !== acceptKey(key)) {
          sock.destroy();
          fail(new Error('调试端口没有升成 WebSocket'));
          return;
        }
        upgraded = true;
        pending = buf.subarray(end + 4);
        buf = Buffer.alloc(0);
        resolve(api);
      } else pending = Buffer.concat([pending, chunk]);
      let decoded;
      try { decoded = decodeFrames(pending); } catch (e) { sock.destroy(); fail(e); return; }
      pending = Buffer.from(decoded.rest);
      for (const frame of decoded.frames) {
        if (frame.opcode === 0x9) {
          try { sock.write(encodeFrame(0xA, frame.data, { masked: true })); } catch { /* 回 pong 失败就等对面关 */ }
          continue;
        }
        if (frame.opcode === 0x8) { sock.end(); continue; }
        if (frame.opcode !== 0x1) continue;
        let msg;
        try { msg = JSON.parse(frame.data.toString('utf8')); } catch { continue; }
        if (msg.id != null && waiters.has(msg.id)) {
          const w = waiters.get(msg.id);
          waiters.delete(msg.id);
          clearTimeout(w.timer);
          if (msg.error) w.reject(new Error(msg.error.message || 'CDP 错误'));
          else w.resolve(msg.result || {});
        } else if (msg.method) {
          const list = listeners.get(msg.method);
          if (list) for (const fn of list) fn(msg.params || {});
        }
      }
    });
    const api = {
      call(method, params = {}, ms = timeoutMs) {
        if (!upgraded) return Promise.reject(new Error('调试连接还没好'));
        const id = ++seq;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            waiters.delete(id);
            rej(new Error(`CDP ${method} 超时`));
          }, ms);
          waiters.set(id, { resolve: res, reject: rej, timer });
          try { sock.write(encodeClientText(JSON.stringify({ id, method, params }))); }
          catch (e) { clearTimeout(timer); waiters.delete(id); rej(e); }
        });
      },
      once(event, ms) {
        return new Promise((res) => {
          const timer = setTimeout(() => {
            const list = listeners.get(event) || [];
            listeners.set(event, list.filter((f) => f !== fn));
            res(null);
          }, ms);
          const fn = (params) => {
            clearTimeout(timer);
            const left = (listeners.get(event) || []).filter((f) => f !== fn);
            if (left.length) listeners.set(event, left); else listeners.delete(event);
            res(params);
          };
          const list = listeners.get(event) || [];
          list.push(fn);
          listeners.set(event, list);
        });
      },
      close() {
        try { sock.end(); } catch { /* 已经关了 */ }
        try { sock.destroy(); } catch { /* 同上 */ }
      },
    };
    sock.write([
      `GET ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '', '',
    ].join('\r\n'));
  });
}
