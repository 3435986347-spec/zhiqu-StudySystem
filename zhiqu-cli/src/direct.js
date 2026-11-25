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

/**
 * 服务器那套 done 的形状。这一轮的思考挂在 message 上（reasoning_content 或 reasoning_blocks + reasoning_model），
 * 命令行原样记进历史，下一轮才能带回 —— 和网关 ReasoningHistory.attach 同一个规矩。
 */
const doneEvent = ({ text, calls, finishReason, usage, maxTokens, reasoning, blocks, model }) => {
  const message = { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) };
  if (blocks && blocks.length) {
    message.reasoning_blocks = blocks;
    message.reasoning_model = model;
  } else if (reasoning) {
    message.reasoning_content = reasoning;
    message.reasoning_model = model;
  }
  return { message, finishReason, maxTokens, usage: usage || undefined };
};

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

// ── 缓存断点（第一百四十轮）────────────────────────────────────────────
//
// Claude 只缓存请求里标过 cache_control 的部分，不标就是全价。经服务器网关的那条路第一百零四轮就标了（PromptCacheMarks），
// 直连这条路一个都没标。这里照网关同一套标三处：系统提示（开工后不变，1 小时）、上一次压缩留下的那一段的结尾、最后一条（滚动）。
// 不认 1 小时的先退回 5 分钟，还不认就去掉，记在这个对象上（一段会话一个）。DeepSeek 这类自动缓存的不标。
const EPHEMERAL = { type: 'ephemeral' };
const EPHEMERAL_1H = { type: 'ephemeral', ttl: '1h' };
const SUMMARY_START = '【之前对话的摘要';
const RESTORE_START = '（对话刚压缩过';
const firstText = (content) => (typeof content === 'string' ? content : Array.isArray(content) && content[0] && content[0].text != null ? String(content[0].text) : null);

/** 上一次压缩留下的那一段在哪结束（和网关的 PromptCacheMarks.boundary 同一个规矩）：没有、或者它就是最后一条，返回 -1。 */
export function cacheBoundary(messages) {
  let at = -1;
  let restore = false;
  messages.forEach((m, i) => {
    const text = m.role === 'user' ? firstText(m.content) : null;
    if (text == null) return;
    if (text.startsWith(RESTORE_START)) { at = i; restore = true; } else if (text.startsWith(SUMMARY_START) && !restore) at = i;
  });
  return at >= 0 && at < messages.length - 1 ? at : -1;
}

const markLastBlock = (m) => {
  if (!Array.isArray(m.content) || !m.content.length) return m;
  const blocks = m.content.slice();
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL };
  return { ...m, content: blocks };
};
/** Anthropic 的请求体：system 变成带标记的块，历史里标两处。不动传进来的那一份。 */
export function markAnthropic(payload, longTtl) {
  const out = { ...payload };
  if (typeof out.system === 'string' && out.system) out.system = [{ type: 'text', text: out.system, cache_control: longTtl ? EPHEMERAL_1H : EPHEMERAL }];
  const messages = (out.messages || []).slice();
  const boundary = cacheBoundary(messages);
  if (boundary >= 0) messages[boundary] = markLastBlock(messages[boundary]);
  if (messages.length) messages[messages.length - 1] = markLastBlock(messages[messages.length - 1]);
  out.messages = messages;
  return out;
}
const markText = (m, control) => (typeof m.content === 'string' && m.content.trim() ? { ...m, content: [{ type: 'text', text: m.content, cache_control: control }] } : m);
/** OpenAI 兼容的请求体（中转的 Claude）：系统提示、压缩留下的那一段、最后一条的文字拆成带标记的块。 */
export function markOpenAi(payload, longTtl) {
  const messages = (payload.messages || []).slice();
  if (!messages.length) return payload;
  const boundary = cacheBoundary(messages);
  if (messages[0].role === 'system') messages[0] = markText(messages[0], longTtl ? EPHEMERAL_1H : EPHEMERAL);
  if (boundary > 0) messages[boundary] = markText(messages[boundary], EPHEMERAL);
  if (messages.length > 1) messages[messages.length - 1] = markText(messages[messages.length - 1], EPHEMERAL);
  return { ...payload, messages };
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
    /** 2 = 标断点、最前一段 1 小时；1 = 标断点、都是 5 分钟；0 = 不标。被拒了往下退并记住 */
    this.cacheMode = this.protocol === 'anthropic' || /claude/i.test(String(model || '')) ? 2 : 0;
  }

  payload(body, mode, dropReasoning = false) {
    const plain = this.protocol === 'anthropic' ? anthropicBody(this, body, dropReasoning) : openaiBody(this, body, dropReasoning);
    if (!mode) return plain;
    return this.protocol === 'anthropic' ? markAnthropic(plain, mode === 2) : markOpenAi(plain, mode === 2);
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
    const host = hostOf(this.url);
    const started = this.cacheMode;
    // 这家不收思考参数就记住，下次直接不发（和网关 noReasoning 同一条路）。缓存标记的退档另算。
    let dropReasoning = this.reasoningOff === true;
    let res;
    for (let mode = started; ; mode--) {
      let payload;
      try {
        payload = this.payload(body, mode, dropReasoning);
        res = await openStream(this.url, { headers: this.headers(), body: JSON.stringify(payload), signal });
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        // 和 Api.networkError 一个口径：连不上/断了可以重来，地址写错（ECONNREFUSED）也照实说
        const code = e instanceof HttpError ? e.code : null;
        const why = code === 'ECONNREFUSED' ? '连接被拒绝，这个地址上没有服务在听？'
          : code === 'NO_RESPONSE' || code === 'IDLE_TIMEOUT' ? e.message : code || e.message;
        throw new ApiError(`连不上 ${host}（${why}）—— 地址是 ${this.url}`, { retryable: e instanceof HttpError ? e.retryable : false, code });
      }
      if (res.status === 200) {
        this.cacheMode = mode;
        if (dropReasoning) this.reasoningOff = true;
        break;
      }   // 退了一档才成：这家不认，记住
      const text = await res.readAll().catch(() => '');
      // 思考参数被拒：去掉再试一次，不把它当成缓存标记的错（两边的 400 长得不一样）
      if (!dropReasoning && payloadHasReasoning(payload) && reasoningRejected(res.status, text)) {
        dropReasoning = true;
        mode += 1;   // continue 仍会 mode--，加回去才是同一档缓存再试
        continue;
      }
      // 带着缓存标记被 400：先退回 5 分钟，再去掉，各重试一次（中转报的错不一定提到它）。去掉了还是 400 就照常报错，也不记
      if (mode > 0 && (res.status === 400 || res.status === 422)) continue;
      throw new ApiError(httpMessage(res.status, text), { status: res.status, retryable: res.status === 429 || RETRYABLE_STATUS.has(res.status) });
    }
    onEvent('start', { contextWindow: null, droppedMessages: 0, elidedToolOutputs: 0 });
    // 收到过实质内容之后再断，就不能自动重来了（会重复输出、工具调用可能重复）
    let substantive = false;
    const emit = (name, data) => { if (name !== 'start') substantive = true; onEvent(name, data); };
    try {
      if (this.protocol === 'anthropic') return await readAnthropic(res, emit, this.maxTokens, this.model);
      return await readOpenAI(res, emit, this.maxTokens, this.model);
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

/**
 * 思考档位的词和网关是同一张表（ReasoningEffort / AiStreamAdapterSupport.applyOpenAiReasoningOptions）。
 * 改一边要改另一边。没选档位（body.reasoning 空）什么都不加：直连没有「服务端默认」可听。
 * 选了 instant 才是关。DeepSeek 不说就自己想，所以关的时候显式 thinking: disabled；reasoner 那个名字不收这个字段。
 * @returns {{ fields: object, echo: boolean }}
 */
export function openAiReasoning(modelName, effort) {
  const level = effortLevel(effort);
  const name = String(modelName || '').toLowerCase();
  const deepSeek = name.includes('deepseek');
  if (level == null) return { fields: {}, echo: false };
  if (level === 'off') {
    return { fields: deepSeek && !name.includes('reasoner') ? { thinking: { type: 'disabled' } } : {}, echo: false };
  }
  const fields = {};
  if (deepSeek) {
    if (!name.includes('reasoner')) fields.thinking = { type: 'enabled' };
    fields.reasoning_effort = deepSeekEffort(level);
    return { fields, echo: true };
  }
  if (openAiReasoner(name) || name.includes('claude')) fields.reasoning_effort = openAiEffort(name, level);
  return { fields, echo: false };
}

/** 和 ReasoningEffort.forAnthropic / applyAnthropicThinking 同一张表。没选或关着就不发（Claude 关不掉，发 disabled 会 400）。 */
export function anthropicReasoning(modelName, effort) {
  const level = effortLevel(effort);
  if (level == null || level === 'off') return {};
  const name = String(modelName || '').toLowerCase();
  if (name.includes('claude-2') || name.includes('claude-3')) {
    const budget = level === 'medium' ? 1024 : level === 'extra' ? 4096 : level === 'max' ? 8192 : 2048;
    return { thinking: { type: 'enabled', budget_tokens: budget } };
  }
  const effortName = level === 'medium' ? 'medium' : level === 'extra' ? 'xhigh' : level === 'max' ? 'max' : 'high';
  return { thinking: { type: 'adaptive' }, output_config: { effort: effortName } };
}

/** null = 没选；off = instant / 认不出的值。 */
function effortLevel(effort) {
  if (effort == null || effort === '') return null;
  switch (String(effort).trim().toLowerCase()) {
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'extra': return 'extra';
    case 'max': return 'max';
    case 'instant':
    case 'off': return 'off';
    default: return 'off';
  }
}
const deepSeekEffort = (level) => (level === 'medium' ? 'low' : level === 'max' ? 'max' : 'high');
const openAiReasoner = (name) => /(?:^|\/)(?:o[134]|gpt-[5-9])/.test(name);
const openAiEffort = (name, level) => (level === 'medium' ? 'medium' : level === 'extra' ? 'xhigh' : level === 'max' ? (openAiReasoner(name) ? 'xhigh' : 'max') : 'high');

/** 发给 OpenAI 兼容接口的历史。echo 时每条助手消息都有 reasoning_content（不是这个模型想的就给空串）。三个内部字段不原样送出去。 */
function wireOpenAiMessages(messages, { echo, model }) {
  return (messages || []).map((m) => {
    if (!m || typeof m !== 'object') return m;
    const has = m.reasoning_content != null || m.reasoning_blocks != null || m.reasoning_model != null;
    if (!has && !(echo && m.role === 'assistant')) return m;
    const copy = { ...m };
    delete copy.reasoning_content;
    delete copy.reasoning_blocks;
    delete copy.reasoning_model;
    if (echo && m.role === 'assistant') {
      copy.reasoning_content = m.reasoning_model === model && typeof m.reasoning_content === 'string' ? m.reasoning_content : '';
    }
    return copy;
  });
}

function openaiBody(self, body, dropReasoning = false) {
  const tools = (body.tools || []).filter(Boolean);
  const spec = dropReasoning ? { fields: {}, echo: false } : openAiReasoning(self.model, body.reasoning);
  return {
    model: self.model,
    messages: wireOpenAiMessages(body.messages, { echo: spec.echo, model: self.model }),
    stream: true,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    ...(body.maxTokens ? { max_tokens: body.maxTokens } : {}),
    ...spec.fields,
  };
}

const payloadHasReasoning = (payload) => Boolean(payload && (payload.thinking || payload.reasoning_effort || payload.output_config));
const reasoningRejected = (status, text) => {
  if (status !== 400 && status !== 422) return false;
  const t = String(text || '').toLowerCase();
  return t.includes('reasoning') || t.includes('thinking') || t.includes('output_config') || t.includes('effort');
};

async function readOpenAI(res, onEvent, maxTokens, modelName) {
  const sink = toolSink();
  const announced = new Set();
  let text = '';
  let reasoning = '';
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
    if (think) { reasoning += String(think); onEvent('reasoning', { text: String(think) }); }
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
  onEvent('done', doneEvent({ text, calls: sink.list(), finishReason: finish, usage, maxTokens, reasoning, model: modelName }));
}

function openaiUsage(u) {
  return {
    promptTokens: u.prompt_tokens || 0,
    completionTokens: u.completion_tokens || 0,
    cachedTokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens || 0,
  };
}

// ── Anthropic ────────────────────────────────────────────────────────────

function anthropicBody(self, body, dropReasoning = false) {
  const level = dropReasoning ? null : effortLevel(body.reasoning);
  const replay = !dropReasoning && level && level !== 'off' ? self.model : '';
  const { system, messages } = toAnthropicMessages(body.messages || [], replay);
  const tools = (body.tools || []).filter(Boolean).map((t) => ({
    name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} },
  }));
  const reasoning = dropReasoning ? {} : anthropicReasoning(self.model, body.reasoning);
  return {
    model: self.model,
    max_tokens: body.maxTokens || self.maxTokens,
    ...(system ? { system } : {}),
    messages,
    stream: true,
    ...(tools.length ? { tools } : {}),
    ...reasoning,
  };
}

/**
 * 我们历史里的形状（OpenAI 那套）翻成 Anthropic 的：
 *   system 提到顶层；assistant 的 tool_calls 变 tool_use 块；role:'tool' 变 user 的 tool_result 块。
 * 相邻的 user 并成一条（工具结果、截图、补充），tool_result 排在前面 —— Anthropic 要求 user/assistant 交替。
 */
/** {url:'data:image/png;base64,…'} → Anthropic 的 image 块；不是 base64 的 data URL（外链等）返回 null（和后端 AnthropicFormat.dataImage 同一个规矩） */
function dataImage(raw) {
  const url = String((raw && typeof raw === 'object' ? raw.url : raw) ?? '');
  if (!url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const data = url.slice(comma + 1);
  if (!meta.includes('base64') || !data) return null;
  return { type: 'image', source: { type: 'base64', media_type: meta.split(';')[0] || 'image/png', data } };
}

/**
 * user 消息的内容块。content 可以是数组（预览截图那条：一段文字 + 几张 data URL 的图，agent.js）——
 * 原来一律 String(m.content)，数组成了「[object Object],[object Object]」，直连 Claude 时图根本没发出去（第一百五十轮记下的）。
 * 照后端 AnthropicFormat.userBlocks：文字照发、图拆成 image 块，认不出的（压缩留下的图占位）不发；什么都没有时给一个「（空）」—— Anthropic 不收空文本块
 */
function userBlocks(content) {
  const blocks = [];
  if (Array.isArray(content)) {
    for (const p of content) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'image_url') { const image = dataImage(p.image_url); if (image) blocks.push(image); continue; }
      if (typeof p.text === 'string' && p.text.trim()) blocks.push({ type: 'text', text: p.text });
    }
  } else {
    const text = String(content ?? '');
    if (text.trim()) blocks.push({ type: 'text', text });
  }
  return blocks.length ? blocks : [{ type: 'text', text: '（空）' }];
}

export function toAnthropicMessages(messages, modelName = '') {
  const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content || '')).filter(Boolean).join('\n\n');
  const out = [];
  // 相邻的 user 并成一条（后端 AnthropicFormat.append 同一个规矩）：工具结果、紧跟着的截图、再紧跟着的补充，
  // 原来只并「整条都是 tool_result」的那一下 —— 截图并进去之后下一条 user 就并不上，成了连着两条 user，Anthropic 直接拒。
  // tool_result 排在其它内容前面。
  const pushUser = (blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === 'user') {
      last.content.push(...blocks);
      const results = [];
      const rest = [];
      for (const b of last.content) (b.type === 'tool_result' ? results : rest).push(b);
      last.content = results.concat(rest);
      return;
    }
    out.push({ role: 'user', content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      pushUser([{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }]);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      // 思考块在最前面、原样（带签名）。只回给想出它的那个模型；reasoning_content 是 OpenAI 那条路的，这里不送
      if (modelName && m.reasoning_model === modelName && Array.isArray(m.reasoning_blocks)) {
        for (const b of m.reasoning_blocks) if (b && typeof b === 'object') blocks.push({ ...b });
      }
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      for (const c of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(c.function.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    pushUser(userBlocks(m.content));
  }
  return { system, messages: out };
}

/** Anthropic 的用量分两次给（message_start 有 input，message_delta 有 output）：缺的沿用上一次的 */
const mergeUsage = (prev, u) => ({
  promptTokens: u.input_tokens ?? (prev ? prev.promptTokens : 0),
  completionTokens: u.output_tokens ?? (prev ? prev.completionTokens : 0),
  cachedTokens: u.cache_read_input_tokens ?? (prev ? prev.cachedTokens : 0),
});

async function readAnthropic(res, onEvent, maxTokens, modelName) {
  let text = '';
  let finish = null;
  let usage = null;
  const blocks = new Map();   // index → { id, name, json }
  const thoughts = new Map();   // index → 要原样回放的思考块
  const parser = new SseParser((name, raw) => {
    let json;
    try { json = raw ? JSON.parse(raw) : {}; } catch { return; }
    if (name === 'content_block_start') {
      const b = json.content_block || {};
      if (b.type === 'tool_use') {
        blocks.set(json.index, { id: b.id, name: b.name, json: '' });
        onEvent('tool_call', { index: json.index, name: b.name });
      } else if (b.type === 'thinking') {
        thoughts.set(json.index, { type: 'thinking', thinking: b.thinking || '', signature: b.signature || '' });
      } else if (b.type === 'redacted_thinking') {
        thoughts.set(json.index, { type: 'redacted_thinking', data: b.data || '' });
      }
      return;
    }
    if (name === 'content_block_delta') {
      const d = json.delta || {};
      if (d.type === 'text_delta' && d.text) { text += d.text; onEvent('delta', { text: d.text }); }
      else if (d.type === 'thinking_delta' && d.thinking) {
        onEvent('reasoning', { text: d.thinking });
        const slot = thoughts.get(json.index);
        if (slot && slot.type === 'thinking') slot.thinking += d.thinking;
      } else if (d.type === 'signature_delta' && d.signature) {
        const slot = thoughts.get(json.index);
        if (slot && slot.type === 'thinking') slot.signature += d.signature;
      }
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
  const thoughtBlocks = [...thoughts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  onEvent('done', doneEvent({ text, calls, finishReason: finish, usage, maxTokens, blocks: thoughtBlocks, model: modelName }));
}
