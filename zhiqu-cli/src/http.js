// 最小的 HTTP 客户端（node:http / node:https），替掉 fetch。
//
// 由来（2026-09-24 实测）：本机 Node 22 上，只要调用过一次全局 fetch —— 哪怕连的是一个会被拒绝的端口 ——
// 进程退出就要多等约 2.4 秒（exit 事件早就触发了，进程却还在）。换成 http 模块，同样一个请求整个进程 0.19 秒。
// zhiqu 的每一条命令都白白多等两秒多；这一层自己写，顺带把超时、重试分类、流式的空闲超时都攥在手里。
//
// 长连接：全局一个 keepAlive 的 Agent。闲着的连接 Agent 会 unref，不会拖住进程退出。
//
// TLS 用到才加载（同一天查出来的第二件事）：环境里设了 NODE_USE_SYSTEM_CA=1 时，加载 TLS 要把 macOS
// 钥匙串里的系统证书全读一遍 —— 1.1～1.5 秒，而且哪怕一个 https 请求都不发，只要加载了就付这笔钱。
// 连本机桌面应用（http://127.0.0.1）的时候根本用不着它。
//
// 连 node:http 也不能用 ESM 的 import：`import http from 'node:http'` 会把 tls 一起拉进来（ESM 包装内置模块时
// 读遍了所有导出，触发了某个懒加载的 getter），CommonJS 的 require 不会 —— 所以两个都走 createRequire。
// 判据 FastStartupTest 钉着「只加载 zhiqu 的模块不许加载 tls」。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const http = require('node:http');
const agents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 8 }) };

function libFor(protocol) {
  if (protocol !== 'https:') return http;
  const https = require('node:https');
  if (!agents['https:']) agents['https:'] = new https.Agent({ keepAlive: true, maxSockets: 8 });
  return https;
}

export class HttpError extends Error {
  constructor(message, { code = null, status = 0, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/** 网络层的错误里，哪些值得重试：连接被重置 / 被拒（服务在重启）/ 超时 / DNS 暂时失败。 */
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'IDLE_TIMEOUT', 'NO_RESPONSE']);
export const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);

function open(urlString, { method = 'GET', headers = {}, body, signal }) {
  const url = new URL(urlString);
  const lib = libFor(url.protocol);
  const payload = body == null ? null : Buffer.from(body);
  const req = lib.request(url, {
    method, agent: agents[url.protocol],
    headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
  });
  if (signal) {
    if (signal.aborted) req.destroy(abortError(signal));
    else signal.addEventListener('abort', () => req.destroy(abortError(signal)), { once: true });
  }
  if (payload) req.write(payload);
  req.end();
  return req;
}

function abortError(signal) {
  const e = new Error('已中断');
  e.name = 'AbortError';
  e.cause = signal && signal.reason;
  return e;
}

function wrap(e) {
  if (e && e.name === 'AbortError') return e;
  if (e instanceof HttpError) return e;
  const code = e && e.code;
  return new HttpError((e && e.message) || code || '网络错误', { code, retryable: RETRYABLE_CODES.has(code) || /socket hang up/i.test(e && e.message) });
}

/** 普通请求：整个响应读完再返回 { status, headers, text }。timeoutMs 是从发出到读完的总时限。 */
export function request(url, { method, headers, body, signal, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = open(url, { method, headers, body, signal });
    // 连接接上了、服务器一个字节都不回（卡死、半开连接）：原来报「ETIMEDOUT」—— 和系统层的连不上混在一起，用户看不懂
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`服务器 ${Math.round(timeoutMs / 1000)} 秒没有回应`), { code: 'NO_RESPONSE' })), timeoutMs);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }); });
      res.on('error', (e) => { clearTimeout(timer); reject(wrap(e)); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(wrap(e)); });
  });
}

/**
 * 流式请求：响应头一到就 resolve { status, headers, body }，body 是一个异步迭代器（一块块字符串）。
 * idleTimeoutMs：两块数据之间最多等多久 —— 服务器的心跳（SSE 注释行）也算数据，所以慢模型不会被误杀，
 * 真正断掉的连接也不会让命令行永远挂着。
 */
export function openStream(url, { method = 'POST', headers, body, signal, idleTimeoutMs = 240_000, connectTimeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = open(url, { method, headers, body, signal });
    let timer = setTimeout(() => req.destroy(Object.assign(new Error(`服务器 ${Math.round(connectTimeoutMs / 1000)} 秒没有回应`), { code: 'NO_RESPONSE' })), connectTimeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(wrap(e)); });
    req.on('response', (res) => {
      clearTimeout(timer);
      res.setEncoding('utf8');
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => res.destroy(Object.assign(new Error(`${Math.round(idleTimeoutMs / 1000)} 秒没有收到任何数据`), { code: 'IDLE_TIMEOUT' })), idleTimeoutMs);
      };
      arm();
      async function* chunks() {
        try {
          for await (const chunk of res) {
            arm();
            yield chunk;
          }
        } catch (e) {
          throw wrap(e);
        } finally {
          clearTimeout(timer);
        }
      }
      resolve({ status: res.statusCode, headers: res.headers, body: chunks(), readAll: async () => { let s = ''; for await (const c of res) s += c; clearTimeout(timer); return s; } });
    });
  });
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(abortError(signal)); }, { once: true });
});

/** Retry-After（秒）→ 毫秒；没给就用默认。 */
export function retryAfterMs(headers, fallback) {
  const v = headers && headers['retry-after'];
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n * 1000, 30_000) : fallback;
}
