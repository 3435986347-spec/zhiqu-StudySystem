// 服务器接口：/api/harness/**。令牌放在 Authorization 头里；业务错误是 HTTP 200 + code != 200。
//
// 重试的规矩（可靠性这一轮定的）：
//   - GET：网络闪断（连接被重置 / 被拒 / 超时）与 502 / 503 / 504 / 429 重试两次（退避 0.3s、1s；429 按 Retry-After）；
//   - 登录后的 POST 带幂等键（第二十二轮）：服务器同一个键只做一次、再来交回上次的结果（IdempotentWriteAspect），
//     所以连接中途断开、超时、502 / 503 / 504、「上一次还在处理」（409）也用同一个键重来两次。
//     原来中途断开的 POST 不重来（服务器可能已经建了草稿），直接报「连不上服务器（ECONNRESET）」—— 模型看到失败，
//     多半用同样的参数再调一次，草稿就是两份。重来也不行时照实说「不确定有没有做成」，并把键留 10 分钟：
//     内容完全一样的下一次（模型照着再调、用户再来一次）还用它。
//   - 没登录的 POST（设备码登录，服务器不认键）：只在「请求肯定没被处理」时重试 —— 连接被拒、429；
//   - 流式模型调用：在 agent 那一层按「还没收到任何输出」决定要不要重来（见 agent.callModel）。
// 业务错误（code != 200）、登录失效一律不重试。
import crypto from 'node:crypto';
import { monotonic } from './clock.js';
import { HttpError, openStream, request, RETRYABLE_STATUS, retryAfterMs, sleep } from './http.js';
import { SseParser } from './sse.js';
import { USER_AGENT } from './version.js';

export class ApiError extends Error {
  constructor(message, { status = 0, auth = false, retryable = false, retryAfter = null, beforeOutput = true, code = null, inProgress = false, uncertain = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;   // 网络层的错误码（ECONNREFUSED …）：连接被拒 = 服务器没在跑，见 desktop.js
    this.auth = auth;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
    this.beforeOutput = beforeOutput;
    this.inProgress = inProgress;   // 同一个幂等键的上一次还在处理（409）
    this.uncertain = uncertain;     // 带键的写重来几次都没拿到回应：服务器可能做了、也可能没做
  }
}

const GET_BACKOFF = [300, 1000];
const UNCERTAIN_KEY_MS = 10 * 60 * 1000;   // 放弃之后留 10 分钟；服务器存结果 15 分钟（IdempotencyService.RESULT_TTL），多出来的给自动重来那几轮

export class Api {
  /** onRetry(说明)：要重来之前说一声 —— 服务器卡住时一次要等满超时，不说的话终端上一片空白，像是卡死了。 */
  constructor({ server, token, onRetry = null }) {
    this.server = server;
    this.token = token;
    this.onRetry = onRetry;
    this.uncertainKeys = new Map();   // 方法 + 地址 + 内容 → { key, at }：没弄清的那一次的键
  }

  headers(json = true, accept = 'application/json', key = null) {
    const h = { 'User-Agent': USER_AGENT, Accept: accept };
    if (json) h['Content-Type'] = 'application/json';
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (key) h['Idempotency-Key'] = key;
    return h;
  }

  /**
   * 这一次写请求用哪个键：调用方给了就用它；内容完全一样、上一次没弄清（10 分钟内）就沿用；否则新的。没登录不带。
   * 「10 分钟」用单调时钟量（系统时钟会跳，见 clock.js）。
   */
  writeKey(method, pathname, payload, given) {
    if (method === 'GET' || !this.token) return { key: null, sig: null };
    if (given) return { key: given, sig: null };
    const sig = `${method} ${pathname}\n${payload ?? ''}`;
    const kept = this.uncertainKeys.get(sig);
    const key = kept && monotonic() - kept.at < UNCERTAIN_KEY_MS ? kept.key : `cli-${crypto.randomUUID()}`;
    return { key, sig };
  }

  networkError(e) {
    if (e && e.name === 'AbortError') return e;
    const code = e instanceof HttpError ? e.code : null;
    const why = code === 'ECONNREFUSED' ? '连接被拒绝，服务器没有在运行？'
      : code === 'NO_RESPONSE' || code === 'IDLE_TIMEOUT' ? e.message : code || e.message;
    return new ApiError(`连不上服务器 ${this.server}（${why}）`, { retryable: e instanceof HttpError ? e.retryable : false, code });
  }

  async request(method, pathname, body, { signal, timeoutMs = 30_000, retry = true, key: givenKey = null } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const { key, sig } = this.writeKey(method, pathname, payload, givenKey);
    // 带键的写和 GET 一样可以重来：同一个键服务器只做一次
    const replayable = method === 'GET' || Boolean(key);
    const attempts = !retry ? 1 : replayable ? GET_BACKOFF.length + 1 : 2;
    try {
      const data = await this.attempt(method, pathname, payload, { signal, timeoutMs, attempts, replayable, key });
      if (sig) this.uncertainKeys.delete(sig);
      return data;
    } catch (e) {
      if (sig) {
        if (e.uncertain) this.uncertainKeys.set(sig, { key, at: monotonic() });
        else this.uncertainKeys.delete(sig);
      }
      throw e;
    }
  }

  async attempt(method, pathname, payload, { signal, timeoutMs, attempts, replayable, key }) {
    let last;
    let maybeDone = false;   // 有没有哪一下可能已经到了服务器（断在半路、超时、502…、还在处理）—— 连接被拒、429 不算
    let silent = 0;          // 等满了超时、一个字节都没回的次数：服务器卡住时每一下都要等满，只再等一次（原来三次，一声不吭 91 秒）
    for (let i = 0; i < attempts; i++) {
      let res;
      try {
        res = await request(this.server + pathname, {
          method, headers: this.headers(payload !== undefined, 'application/json', key), body: payload, signal, timeoutMs,
        });
      } catch (e) {
        last = this.networkError(e);
        if (last.name === 'AbortError') throw last;
        // 不带键的 POST 只在连接被拒时重试：请求肯定没到服务器。中途断开的可能已经处理过了
        const safe = replayable ? last.retryable : e.code === 'ECONNREFUSED';
        maybeDone = maybeDone || e.code !== 'ECONNREFUSED';
        if (e.code === 'NO_RESPONSE') silent++;
        if (!safe || i === attempts - 1 || silent >= 2) throw this.uncertain(last, key, maybeDone);
        if (this.onRetry) this.onRetry(last.message);
        await sleep(GET_BACKOFF[Math.min(i, GET_BACKOFF.length - 1)], signal);
        continue;
      }
      if ((replayable && RETRYABLE_STATUS.has(res.status)) || res.status === 429) {
        last = this.statusError(res);
        maybeDone = maybeDone || res.status !== 429;
        if (i === attempts - 1) throw this.uncertain(last, key, maybeDone);
        await sleep(retryAfterMs(res.headers, GET_BACKOFF[Math.min(i, GET_BACKOFF.length - 1)]), signal);
        continue;
      }
      try {
        return this.unwrap(res);
      } catch (e) {
        if (!(key && e.inProgress) || i === attempts - 1) throw e.inProgress ? this.uncertain(e, key, true) : e;
        last = e;
        await sleep(GET_BACKOFF[Math.min(i, GET_BACKOFF.length - 1)], signal);
      }
    }
    throw last;
  }

  /**
   * 带键的写，最后一下也没拿到回应（断开、超时、502…、还在处理）：服务器可能已经做了 —— 照实说，并说清再来一次是安全的。
   * 连接被拒、429 是确定没做（没到服务器 / 进业务之前就拒了），原样说。
   */
  uncertain(e, key, maybeDone) {
    if (!key || !maybeDone) return e;
    const why = e.inProgress ? '上一次提交还在处理' : e.message;
    return new ApiError(`${why} —— 不确定这一下有没有做成；内容不变再来一次不会重复`, {
      status: e.status, code: e.code, retryable: true, inProgress: e.inProgress, uncertain: true,
    });
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
    if (json.code === 409) throw new ApiError(json.message || '上一次提交还在处理', { status: res.status, retryable: true, inProgress: true });
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
      // 断的是和<b>我们的服务器</b>之间的连接（服务器在重启、网络断了），不是模型 —— 原来说「模型的回复中途断开了」，
      // 用户会去查模型配置（第二十二轮：回答到一半 kill -9 服务器实测）
      err.message = e.code === 'IDLE_TIMEOUT'
        ? `回复中断了：${e.message}（服务器 ${this.server} 或网络卡住了）`
        : `回复中途断开了：和服务器 ${this.server} 的连接断了（${e.code || e.message}）—— 服务器可能在重启，或者网络断了；等一下再说一次就好`;
      err.beforeOutput = !substantive;
      throw err;
    }
    if (serverError) {
      throw new ApiError(serverError.message || '模型调用失败', { retryable: Boolean(serverError.retryable), beforeOutput: !substantive });
    }
  }
}
