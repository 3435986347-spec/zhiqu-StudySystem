// 服务器接口：/api/harness/**。令牌放在 Authorization 头里；业务错误是 HTTP 200 + code != 200。
import { SseParser } from './sse.js';
import { USER_AGENT } from './version.js';

export class ApiError extends Error {
  constructor(message, { status = 0, auth = false } = {}) {
    super(message);
    this.status = status;
    this.auth = auth;
  }
}

export class Api {
  constructor({ server, token }) {
    this.server = server;
    this.token = token;
  }

  headers(json = true) {
    const h = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
    if (json) h['Content-Type'] = 'application/json';
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async request(method, pathname, body, { signal, timeoutMs = 30_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetch(this.server + pathname, {
        method, headers: this.headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      throw new ApiError(`连不上服务器 ${this.server}（${e.cause && e.cause.code ? e.cause.code : e.message}）`);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    return this.unwrap(res);
  }

  async unwrap(res) {
    if (res.status === 401 || res.status === 403) {
      throw new ApiError('登录已失效或令牌被撤销，请运行 zhiqu login', { status: res.status, auth: true });
    }
    if (res.status === 429) throw new ApiError('请求过于频繁，请稍后再试', { status: 429 });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new ApiError(`服务器返回了看不懂的内容（HTTP ${res.status}）`, { status: res.status }); }
    if (json.code !== 200) throw new ApiError(json.message || `请求失败（HTTP ${res.status}）`, { status: res.status });
    return json.data;
  }

  get(p, opts) { return this.request('GET', p, undefined, opts); }
  post(p, body = {}, opts) { return this.request('POST', p, body, opts); }

  /** 流式：逐个事件回调 onEvent(name, data)；服务器发 error 事件就抛。 */
  async stream(pathname, body, onEvent, { signal } = {}) {
    let res;
    try {
      res = await fetch(this.server + pathname, {
        method: 'POST', headers: { ...this.headers(true), Accept: 'text/event-stream' }, body: JSON.stringify(body), signal,
      });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      throw new ApiError(`连不上服务器 ${this.server}（${e.cause && e.cause.code ? e.cause.code : e.message}）`);
    }
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('text/event-stream')) {
      await this.unwrap(res);
      throw new ApiError(`服务器没有返回流（HTTP ${res.status}）`, { status: res.status });
    }
    let serverError = null;
    const parser = new SseParser((name, raw) => {
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
      if (name === 'error') { serverError = data.message || '模型调用失败'; return; }
      onEvent(name, data);
    });
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      parser.feed(decoder.decode(chunk, { stream: true }));
      if (serverError) break;
    }
    parser.end();
    if (serverError) throw new ApiError(serverError);
  }
}
