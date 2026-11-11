// 直连供应商（第一百二十九轮，用户要的「单独一个、填完整 URL、不做格式校验」）。
//
// 为什么单独一份：平时模型请求走 /api/harness/model/stream，由服务器网关去调各家；内网环境里
// 那条路走不通（网关出不去，或者根本不想让请求经过服务器）。这里直接 POST 用户填的完整地址，
// 地址原样用 —— 不拼路径、不补 /v1、不校验域名，用户说是什么就是什么（用户明确要求「不做格式校验」）。
//
// 两种协议：
//   openai     POST <url>  { model, messages, tools, stream: true }，SSE 里是 choices[0].delta
//   anthropic  POST <url>  { model, system, messages, tools, max_tokens, stream: true }，SSE 里是 content_block_*
// 两者都翻译成服务器那套事件（start / reasoning / delta / tool_call / done），agent.js 不用分家。
import { ApiError } from './api.js';
import { HttpError, openStream, RETRYABLE_STATUS } from './http.js';
import { SseParser } from './sse.js';
import { USER_AGENT } from './version.js';

const fail = (message, extra = {}) => new ApiError(message, { beforeOutput: true, ...extra });

/** 服务器那套 done 的形状：{ message: { role, content, tool_calls }, finishReason, maxTokens, usage } */
const doneEvent = ({ text, calls, finishReason, usage, maxTokens }) => ({
  message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) },
  finishReason, maxTokens,
  usage: usage || undefined,
});

/** OpenAI 的 tool_calls 分片按 index 攒；有的网关连 index 都不给，按出现顺序编 */
function toolSink() {
  const byIndex = new Map();
  return {
    add(index, part) {
      const key = Number.isInteger(index) ? index : byIndex.size;
      const slot = byIndex.get(key) || { id: '', name: '', arguments: '' };
      if (part.id) slot.id = part.id;
      if (part.name) slot.name = part.name;
      if (part.arguments) slot.arguments += part.arguments;
      byIndex.set(key, slot);
      return slot;
    },
    list() {
      return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([i, s]) => ({
        id: s.id || `call_${i}`, type: 'function', function: { name: s.name, arguments: s.arguments || '{}' },
      }));
    },
  };
}

export class DirectModel {
  /**
   * @param {{ protocol?: 'openai'|'anthropic', url: string, key?: string, model: string, maxTokens?: number }} cfg
   */
  constructor({ protocol = 'openai', url, key = '', model, maxTokens = 8192 } = {}) {
    this.protocol = protocol === 'anthropic' ? 'anthropic' : 'openai';
    this.url = url;
    this.key = key;
    this.model = model;
    this.maxTokens = maxTokens;
  }

  /** 给界面上看的：直连哪家、哪个模型 */
  get label() { return `${this.model}（直连 ${hostOf(this.url)}）`; }

  headers() {
    if (this.protocol === 'anthropic') {
      return {
        'User-Agent': USER_AGENT, 'content-type': 'application/json', accept: 'text/event-stream',
        'anthropic-version': '2023-06-01', ...(this.key ? { 'x-api-key': this.key } : {}),
      };
    }
    return {
      'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'text/event-stream',
      ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
    };
  }

  /** 和 Api.stream 一个签名：body 里的 modelId 不用，模型名来自配置 */
  async stream(body, onEvent, { signal } = {}) {
    const payload = this.protocol === 'anthropic' ? anthropicBody(this, body) : openaiBody(this, body);
    const host = hostOf(this.url);
    let res;
    try {
      res = await openStream(this.url, { headers: this.headers(), body: JSON.stringify(payload), signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      // 和 Api.networkError 一个口径：连不上/断了可以重来，地址写错（ECONNREFUSED）也照实说
      const code = e instanceof HttpError ? e.code : null;
      const why = code === 'ECONNREFUSED' ? '连接被拒绝，这个地址上没有服务在听？'
        : code === 'NO_RESPONSE' || code === 'IDLE_TIMEOUT' ? e.message : code || e.message;
      throw new ApiError(`连不上 ${host}（${why}）—— 地址是 ${this.url}`, { retryable: e instanceof HttpError ? e.retryable : false, code });
    }
    if (res.status !== 200) {
      const text = await res.readAll().catch(() => '');
      throw new ApiError(httpMessage(res.status, text), { status: res.status, retryable: res.status === 429 || RETRYABLE_STATUS.has(res.status) });
    }
    onEvent('start', { contextWindow: null, droppedMessages: 0, elidedToolOutputs: 0 });
    // 收到过实质内容之后再断，就不能自动重来了（会重复输出、工具调用可能重复）
    let substantive = false;
    const emit = (name, data) => { if (name !== 'start') substantive = true; onEvent(name, data); };
    try {
      if (this.protocol === 'anthropic') return await readAnthropic(res, emit, this.maxTokens);
      return await readOpenAI(res, emit, this.maxTokens);
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (e instanceof ApiError) throw e;
      throw new ApiError(`回复中断了：和 ${host} 的连接断了（${e.code || e.message}）`, { retryable: false, beforeOutput: !substantive });
    }
  }
}

const hostOf = (url) => {
  try { return new URL(url).host; } catch { return String(url || '').replace(/^https?:\/\//, '').split('/')[0] || '直连地址'; }
};

/** 400/401 这种要说清是哪一步坏了 —— 地址是用户自己填的，拼错一个字符最难查 */
function httpMessage(status, text) {
  const snippet = String(text || '').replace(/\s+/g, ' ').slice(0, 300);
  const hint = status === 401 || status === 403 ? '（密钥可能不对，或者这个地址要的是别的认证头）'
    : status === 404 ? '（地址可能不对：这里要求填完整的接口地址，不是站点根目录）'
      : status === 400 ? '（请求被拒：可能是模型名不对，或者这个网关不认 tools / stream 参数）' : '';
  return `模型接口返回 HTTP ${status}${hint}${snippet ? `：${snippet}` : ''}`;
}

function openaiBody(self, body) {
  const tools = (body.tools || []).filter(Boolean);
  return {
    model: self.model,
    messages: body.messages || [],
    stream: true,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    ...(body.maxTokens ? { max_tokens: body.maxTokens } : {}),
  };
}

async function readOpenAI(res, onEvent, maxTokens) {
  const sink = toolSink();
  const announced = new Set();
  let text = '';
  let finish = null;
  let usage = null;
  const parser = new SseParser((_name, raw) => {
    const data = String(raw || '').trim();
    if (!data || data === '[DONE]') return;
    let json;
    try { json = JSON.parse(data); } catch { return; }
    if (json.usage) usage = openaiUsage(json.usage);
    const choice = (json.choices || [])[0];
    if (!choice) return;
    const d = choice.delta || {};
    // 思考：DeepSeek 用 reasoning_content，vLLM 一类用 reasoning，别家可能叫 thinking
    const think = d.reasoning_content ?? d.reasoning ?? d.thinking;
    if (think) onEvent('reasoning', { text: String(think) });
    if (d.content) { text += d.content; onEvent('delta', { text: String(d.content) }); }
    for (const [i, part] of (d.tool_calls || []).entries()) {
      const slot = sink.add(Number.isInteger(part.index) ? part.index : i, {
        id: part.id, name: part.function && part.function.name, arguments: part.function && part.function.arguments,
      });
      const key = slot.id || String(i);
      if (slot.name && !announced.has(key)) { announced.add(key); onEvent('tool_call', { index: Number.isInteger(part.index) ? part.index : i, name: slot.name }); }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  });
  for await (const chunk of res.body) parser.feed(chunk);
  parser.end();
  onEvent('done', doneEvent({ text, calls: sink.list(), finishReason: finish, usage, maxTokens }));
}

function openaiUsage(u) {
  return {
    promptTokens: u.prompt_tokens || 0,
    completionTokens: u.completion_tokens || 0,
    cachedTokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens || 0,
  };
}

// ── Anthropic ────────────────────────────────────────────────────────────

function anthropicBody(self, body) {
  const { system, messages } = toAnthropicMessages(body.messages || []);
  const tools = (body.tools || []).filter(Boolean).map((t) => ({
    name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} },
  }));
  return {
    model: self.model,
    max_tokens: body.maxTokens || self.maxTokens,
    ...(system ? { system } : {}),
    messages,
    stream: true,
    ...(tools.length ? { tools } : {}),
  };
}

/**
 * 我们历史里的形状（OpenAI 那套）翻成 Anthropic 的：
 *   system 提到顶层；assistant 的 tool_calls 变 tool_use 块；role:'tool' 变 user 的 tool_result 块。
 * 连着几条 tool 结果要并进同一条 user 消息 —— Anthropic 要求 user/assistant 交替。
 */
export function toAnthropicMessages(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content || '')).filter(Boolean).join('\n\n');
  const out = [];
  const isResults = (m) => m && m.role === 'user' && Array.isArray(m.content) && m.content.length && m.content.every((b) => b.type === 'tool_result');
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') };
      const last = out[out.length - 1];
      if (isResults(last)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      for (const c of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(c.function.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: 'user', content: [{ type: 'text', text: String(m.content ?? '') }] });
  }
  return { system, messages: out };
}

/** Anthropic 的用量分两次给（message_start 有 input，message_delta 有 output）：缺的沿用上一次的 */
const mergeUsage = (prev, u) => ({
  promptTokens: u.input_tokens ?? (prev ? prev.promptTokens : 0),
  completionTokens: u.output_tokens ?? (prev ? prev.completionTokens : 0),
  cachedTokens: u.cache_read_input_tokens ?? (prev ? prev.cachedTokens : 0),
});

async function readAnthropic(res, onEvent, maxTokens) {  let text = '';
  let finish = null;
  let usage = null;
  const blocks = new Map();   // index → { id, name, json }
  const parser = new SseParser((name, raw) => {
    let json;
    try { json = raw ? JSON.parse(raw) : {}; } catch { return; }
    if (name === 'content_block_start') {
      const b = json.content_block || {};
      if (b.type === 'tool_use') {
        blocks.set(json.index, { id: b.id, name: b.name, json: '' });
        onEvent('tool_call', { index: json.index, name: b.name });
      }
      return;
    }
    if (name === 'content_block_delta') {
      const d = json.delta || {};
      if (d.type === 'text_delta' && d.text) { text += d.text; onEvent('delta', { text: d.text }); }
      else if (d.type === 'thinking_delta' && d.thinking) onEvent('reasoning', { text: d.thinking });
      else if (d.type === 'input_json_delta' && d.partial_json != null) {
        const slot = blocks.get(json.index);
        if (slot) slot.json += d.partial_json;
      }
      return;
    }
    if (name === 'message_delta') {
      if (json.delta && json.delta.stop_reason) finish = json.delta.stop_reason;
      // message_delta 只带 output_tokens，input 在 message_start 里 —— 不能整个覆盖
      if (json.usage) usage = mergeUsage(usage, json.usage);
      return;
    }
    if (name === 'message_start' && json.message && json.message.usage) {
      usage = mergeUsage(usage, json.message.usage);
      return;
    }
    if (name === 'error') throw fail(`模型接口报错：${(json.error && json.error.message) || '未知错误'}`);
  });
  for await (const chunk of res.body) parser.feed(chunk);
  parser.end();
  const calls = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([i, s]) => ({
    id: s.id || `call_${i}`, type: 'function', function: { name: s.name, arguments: s.json || '{}' },
  }));
  onEvent('done', doneEvent({ text, calls, finishReason: finish, usage, maxTokens }));
}
