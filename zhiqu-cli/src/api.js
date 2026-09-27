// 服务器接口：/api/harness/**。令牌放在 Authorization 头里；业务错误是 HTTP 200 + code != 200。
//
// 重试的规矩（可靠性这一轮定的）：
//   - GET：网络闪断（连接被重置 / 被拒 / 超时）与 502 / 503 / 504 / 429 重试两次（退避 0.3s、1s；429 按 Retry-After）；
//   - POST：只在「请求肯定没被处理」时重试 —— 连接被拒、429。连接中途断开时服务器可能已经处理了（草稿可能已建），不重试；
//   - 流式模型调用：在 agent 那一层按「还没收到任何输出」决定要不要重来（见 agent.callModel）。
// 业务错误（code != 200）、登录失效一律不重试。
import { HttpError, openStream, request, RETRYABLE_STATUS, retryAfterMs, sleep } from './http.js';
import { SseParser } from './sse.js';
import { USER_AGENT } from './version.js';

export class ApiError extends Error {
  constructor(message, { status = 0, auth = false, retryable = false, retryAfter = null, beforeOutput = true, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;   // 网络层的错误码（ECONNREFUSED …）：连接被拒 = 服务器没在跑，见 desktop.js
    this.auth = auth;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
    this.beforeOutput = beforeOutput;
  }
}

const GET_BACKOFF = [300, 1000];

export class Api {
  constructor({ server, token }) {
    this.server = server;
    this.token = token;
  }

  headers(json = true, accept = 'application/json') {
    const h = { 'User-Agent': USER_AGENT, Accept: accept };
    if (json) h['Content-Type'] = 'application/json';
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  networkError(e) {
    if (e && e.name === 'AbortError') return e;
    const code = e instanceof HttpError ? e.code : null;
    const why = code === 'ECONNREFUSED' ? '连接被拒绝，服务器没有在运行？'
      : code === 'NO_RESPONSE' || code === 'IDLE_TIMEOUT' ? e.message : code || e.message;
    return new ApiError(`连不上服务器 ${this.server}（${why}）`, { retryable: e instanceof HttpError ? e.retryable : false, code });
  }

  async request(method, pathname, body, { signal, timeoutMs = 30_000, retry = true } = {}) {
    const attempts = !retry ? 1 : method === 'GET' ? GET_BACKOFF.length + 1 : 2;
    let last;
    for (let i = 0; i < attempts; i++) {
      let res;
      try {
        res = await request(this.server + pathname, {
          method, headers: this.headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body), signal, timeoutMs,
        });
      } catch (e) {
        last = this.networkError(e);
        if (last.name === 'AbortError') throw last;
        // POST 只在连接被拒时重试：请求肯定没到服务器。中途断开的 POST 可能已经处理过了
        const safe = method === 'GET' ? last.retryable : e.code === 'ECONNREFUSED';
        if (!safe || i === attempts - 1) throw last;
        await sleep(GET_BACKOFF[Math.min(i, GET_BACKOFF.length - 1)], signal);
        continue;
      }
      if ((method === 'GET' && RETRYABLE_STATUS.has(res.status)) || res.status === 429) {
        last = this.statusError(res);
        if (i === attempts - 1) throw last;
        await sleep(retryAfterMs(res.headers, GET_BACKOFF[Math.min(i, GET_BACKOFF.length - 1)]), signal);
        continue;
      }
      return this.unwrap(res);
    }
    throw last;
  }

  statusError(res) {
    if (res.status === 429) return new ApiError('请求过于频繁，请稍后再试', { status: 429, retryable: true, retryAfter: retryAfterMs(res.headers, 2000) });
    return new ApiError(`服务器暂时不可用（HTTP ${res.status}）`, { status: res.status, retryable: RETRYABLE_STATUS.has(res.status) });
  }

  unwrap(res) {
    if (res.status === 401 || res.status === 403) {
      throw new ApiError('登录已失效或令牌被撤销，请运行 zhiqu login', { status: res.status, auth: true });
    }
    if (res.status === 429 || RETRYABLE_STATUS.has(res.status)) throw this.statusError(res);
    let json;
    try { json = JSON.parse(res.text); } catch { throw new ApiError(`服务器返回了看不懂的内容（HTTP ${res.status}）`, { status: res.status }); }
    if (json.code !== 200) throw new ApiError(json.message || `请求失败（HTTP ${res.status}）`, { status: res.status });
    return json.data;
  }

  get(p, opts) { return this.request('GET', p, undefined, opts); }
  post(p, body = {}, opts) { return this.request('POST', p, body, opts); }

  /**
   * 流式：逐个事件回调 onEvent(name, data)。服务器发 error 事件就抛（带上它说的 retryable）。
   * 抛出的 ApiError.beforeOutput 表示「出错之前还没收到任何实质内容」—— 调用方据此决定能不能安全重来。
   */
  async stream(pathname, body, onEvent, { signal, idleTimeoutMs } = {}) {
    let res;
    try {
      res = await openStream(this.server + pathname, {
        headers: this.headers(true, 'text/event-stream'), body: JSON.stringify(body), signal, idleTimeoutMs,
      });
    } catch (e) {
      throw this.networkError(e);
    }
    const type = String(res.headers['content-type'] || '');
    if (res.status !== 200 || !type.includes('text/event-stream')) {
      const text = await res.readAll();
      this.unwrap({ status: res.status, headers: res.headers, text });
      throw new ApiError(`服务器没有返回流（HTTP ${res.status}）`, { status: res.status });
    }
    let serverError = null;
    let substantive = false;
    const parser = new SseParser((name, raw) => {
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
      if (name === 'error') { serverError = data; return; }
      if (name !== 'start') substantive = true;
      onEvent(name, data);
    });
    try {
      for await (const chunk of res.body) {
        parser.feed(chunk);
        if (serverError) break;
      }
      parser.end();
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      const err = this.networkError(e);
      err.message = e.code === 'IDLE_TIMEOUT' ? `模型的回复中断了：${e.message}` : `模型的回复中途断开了（${e.code || e.message}）`;
      err.beforeOutput = !substantive;
      throw err;
    }
    if (serverError) {
      throw new ApiError(serverError.message || '模型调用失败', { retryable: Boolean(serverError.retryable), beforeOutput: !substantive });
    }
  }
}
