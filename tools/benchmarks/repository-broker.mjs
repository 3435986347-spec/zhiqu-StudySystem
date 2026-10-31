// Paid-model boundary for isolated repository benchmark episodes. The task only
// sees a revocable capability; the production login remains in this process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import readline from 'node:readline';
import { Api } from '../../zhiqu-cli/src/api.js';

const http = createRequire(import.meta.url)('node:http');
export const MODEL_PATH = '/api/harness/model/stream';
export const OUTPUT_RESERVATION_TOKENS = 16_384;
export const INPUT_MICRO_CNY_PER_TOKEN = 9;
export const OUTPUT_MICRO_CNY_PER_TOKEN = 27;
const EVENTS = new Set(['start', 'delta', 'reasoning', 'tool_call', 'tool_progress', 'done']);
const DEFAULTS = Object.freeze({ limitMicroCny: 50_000_000, inputTokenLimit: 4_000_000, outputTokenLimit: 500_000,
  perEpisodeInputTokenLimit: 2_000_000, perEpisodeOutputTokenLimit: 131_072, maxRequestsPerEpisode: 200,
  minRequestIntervalMs: 1_200, modelId: 6, modelName: 'deepseek-v4-pro', contextWindow: 1_000_000,
  maxBodyBytes: 2_000_000, maxBufferedResponseBytes: 1_000_000, maxStreamBytes: 8_000_000,
  maxActiveRequests: 2, streamTimeoutMs: 300_000 });

export class BrokerError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status = 400) => { throw new BrokerError(code, status); };
const positive = (value, name) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
};
const nonnegative = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
  return value;
};
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isId = (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const charge = (input, output) => {
  const value = input * INPUT_MICRO_CNY_PER_TOKEN + output * OUTPUT_MICRO_CNY_PER_TOKEN;
  if (!Number.isSafeInteger(value)) fail('usage_integer_overflow', 502);
  return value;
};
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return; }
  const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
  const timer = setTimeout(finish, ms);
  const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(abortError()); };
  signal?.addEventListener('abort', cancel, { once: true });
});

/** Conservative accounting bound, NOT a tokenizer or a vendor invoice cap.
 * Every serialized UTF-8 byte counts as a token, plus explicit framing cushions.
 * Server-side context trimming can only lower this input reservation. If real
 * reported usage exceeds it, admission stops and the overrun is recorded.
 */
export function inputTokenUpperBound(body) {
  return Buffer.byteLength(JSON.stringify(body), 'utf8') + 4096 + body.messages.length * 256 + body.tools.length * 256;
}

function validateBody(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid_body');
  const fields = Object.keys(body).sort();
  if (JSON.stringify(fields) !== JSON.stringify(['maxTokens', 'messages', 'modelId', 'tools'])) fail('unexpected_body_fields');
  if (body.modelId !== config.modelId) fail('wrong_requested_model');
  if (!Number.isSafeInteger(body.maxTokens) || body.maxTokens <= 0 || body.maxTokens > OUTPUT_RESERVATION_TOKENS) fail('invalid_output_cap');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 2000) fail('invalid_messages');
  if (!Array.isArray(body.tools) || body.tools.length > 128) fail('invalid_tools');
  for (const message of body.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
        || !['system', 'user', 'assistant', 'tool'].includes(message.role)) fail('invalid_message');
  }
  for (const tool of body.tools) {
    if (!tool || tool.type !== 'function' || !tool.function || typeof tool.function.name !== 'string') fail('invalid_tool');
  }
  const upper = inputTokenUpperBound(body);
  if (!Number.isSafeInteger(upper) || upper <= 0 || upper + OUTPUT_RESERVATION_TOKENS > config.contextWindow) fail('input_context_cap');
  return upper;
}

function readBody(req, maxBytes, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    const settle = (error, value) => {
      if (finished) return;
      finished = true;
      req.removeListener('data', take); req.removeListener('end', end); req.removeListener('error', errorHandler);
      signal.removeEventListener('abort', abort);
      if (error) { req.pause(); reject(error); } else resolve(value);
    };
    const take = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { settle(new BrokerError('body_too_large', 413)); return; }
      chunks.push(chunk);
    };
    const end = () => {
      try { settle(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { settle(new BrokerError('invalid_json')); }
    };
    const errorHandler = () => settle(new BrokerError('body_interrupted'));
    const abort = () => settle(new BrokerError('request_aborted', 403));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    req.on('data', take); req.on('end', end); req.on('error', errorHandler);
  });
}

export class RepositoryBroker {
  constructor(options = {}) {
    this.config = Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, options[key] === undefined ? value : options[key]]));
    for (const key of Object.keys(DEFAULTS).filter((key) => !['modelName', 'modelId'].includes(key))) positive(this.config[key], key);
    // 一本账一个模型 ID：ID 6（2026-10-16 用户指定）或 ID 1（2026-10-18 用户要求补被预算打断的题），都是 deepseek-v4-pro / 1M
    if (![6, 1].includes(this.config.modelId) || this.config.modelName !== 'deepseek-v4-pro' || this.config.contextWindow !== 1_000_000) {
      throw new Error('Broker model must be 6 or 1 / deepseek-v4-pro with 1000000 context');
    }
    if (this.config.minRequestIntervalMs < 1200 || this.config.maxRequestsPerEpisode > 200) throw new Error('Pacing/request limits exceed approved scope');
    // 一本账的钱数上限：第六十九轮用户批的 ¥50；第八十七轮重跑用户定 ¥100（2026-10-31，同样的保守口径）
    if (this.config.limitMicroCny > 100_000_000) throw new Error('Money limit exceeds approved 100 CNY scope');
    if (!options.ledgerPath) throw new Error('ledgerPath is required');
    this.api = options.api || new Api({ server: options.server, token: options.token });
    if (typeof this.api.stream !== 'function') throw new Error('Production-compatible api.stream required');
    this.now = options.now || (() => performance.now());
    this.sleep = options.sleep || defaultSleep;
    this.ledgerPath = path.resolve(options.ledgerPath);
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true, mode: 0o700 });
    this.lockPath = this.ledgerPath + '.lock'; this.lockFd = null; this.lockIdentity = null; this.lockWritten = false; this.fd = null;
    this.lockContents = JSON.stringify({ pid: process.pid, ownerId: crypto.randomUUID() }) + '\n';
    this.episodes = new Map(); this.capabilities = new Map(); this.usedCapabilityHashes = new Set(); this.requests = new Map(); this.active = new Map();
    this.pending = new Map(); this.handlers = new Set(); this.closed = false; this.closing = null;
    this.inputUsed = 0; this.outputUsed = 0; this.received = 0; this.accepted = 0; this.halted = false;
    this.haltReason = null; this.lastDispatch = -Infinity; this.gate = Promise.resolve(); this.sequence = 0;
    try {
      // Exclusive creation works across processes. A stale lock deliberately
      // requires operator review; never remove it automatically or reset money.
      this.lockFd = fs.openSync(this.lockPath, 'wx', 0o600);
      this.lockIdentity = fs.fstatSync(this.lockFd);
      fs.writeFileSync(this.lockFd, this.lockContents); this.lockWritten = true; fs.fsyncSync(this.lockFd);
      if (fs.existsSync(this.ledgerPath)) this.recover();
      this.fd = fs.openSync(this.ledgerPath, 'a', 0o600);
      fs.chmodSync(this.ledgerPath, 0o600);
      if (!this.sequence) this.append({ event: 'init', config: this.config, prices: { inputMicroCnyPerToken: 9, outputMicroCnyPerToken: 27 },
        inputBound: 'serialized UTF8 bytes + 4096 + 256 per message + 256 per tool', vendorInvoiceHardCap: false });
    } catch (error) {
      if (this.fd != null) { fs.closeSync(this.fd); this.fd = null; }
      this.releaseLock(); throw error;
    }
    this.http = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
      const operation = this.handle(req, res).catch(() => res.destroy());
      this.handlers.add(operation); operation.finally(() => this.handlers.delete(operation));
    });
    this.http.headersTimeout = 10_000; this.http.requestTimeout = 30_000;
  }

  recover() {
    const raw = fs.readFileSync(this.ledgerPath, 'utf8');
    if (!raw) throw new Error('Empty ledger: refuse to reset budget');
    if (raw && !raw.endsWith('\n')) throw new Error('Incomplete ledger: refuse to reset budget');
    const receivedIds = new Set();
    for (const line of raw.split('\n').filter(Boolean)) {
      const item = JSON.parse(line);
      if (item.sequence !== this.sequence + 1) throw new Error('Ledger sequence mismatch');
      if (this.sequence === 0 && item.event !== 'init') throw new Error('Ledger must begin with its budget configuration');
      this.sequence = item.sequence;
      if (item.event === 'init') {
        if (this.sequence !== 1 || JSON.stringify(item.config) !== JSON.stringify(this.config)) throw new Error('Ledger budget/config mismatch');
        if (item.prices?.inputMicroCnyPerToken !== 9 || item.prices?.outputMicroCnyPerToken !== 27
            || item.vendorInvoiceHardCap !== false) throw new Error('Ledger prices/config mismatch');
      } else if (item.event === 'received') {
        if (!isId(item.requestId) || receivedIds.has(item.requestId) || !isHash(item.pathSha256)
            || typeof item.method !== 'string' || item.method.length > 16) throw new Error('Invalid received ledger entry');
        receivedIds.add(item.requestId); this.received++;
      }
      else if (item.event === 'episode_registered') {
        positive(item.inputLimit, 'ledger episode input'); positive(item.outputLimit, 'ledger episode output');
        positive(item.requestLimit, 'ledger episode requests');
        if (!isId(item.episodeId) || !isHash(item.capabilitySha256) || this.usedCapabilityHashes.has(item.capabilitySha256)
            || item.inputLimit > this.config.perEpisodeInputTokenLimit || item.outputLimit > this.config.perEpisodeOutputTokenLimit
            || item.requestLimit > this.config.maxRequestsPerEpisode) throw new Error('Invalid ledger episode');
        const prior = this.episodes.get(item.episodeId);
        if (prior && (prior.inputLimit !== item.inputLimit || prior.outputLimit !== item.outputLimit
            || prior.requestLimit !== item.requestLimit)) throw new Error('Invalid repeated ledger episode');
        this.usedCapabilityHashes.add(item.capabilitySha256);
        if (!this.episodes.has(item.episodeId)) this.episodes.set(item.episodeId, { id: item.episodeId,
          inputLimit: item.inputLimit, outputLimit: item.outputLimit, requestLimit: item.requestLimit,
          inputUsed: 0, outputUsed: 0, requests: 0, active: false });
        this.episodes.get(item.episodeId).active = true;
      } else if (item.event === 'episode_revoked') {
        const episode = this.episodes.get(item.episodeId);
        if (!episode?.active) throw new Error('Invalid ledger revocation');
        episode.active = false;
      } else if (item.event === 'accepted') {
        const episode = this.episodes.get(item.episodeId);
        positive(item.inputUpperTokens, 'ledger input reservation'); positive(item.requestedMaxTokens, 'ledger requested output');
        if (!episode?.active || !receivedIds.has(item.requestId) || this.requests.has(item.requestId)
            || !isHash(item.bodySha256) || item.reservedOutputTokens !== OUTPUT_RESERVATION_TOKENS
            || item.requestedMaxTokens > OUTPUT_RESERVATION_TOKENS
            || item.inputUpperTokens + OUTPUT_RESERVATION_TOKENS > this.config.contextWindow
            || item.reservedMicroCny !== charge(item.inputUpperTokens, item.reservedOutputTokens)
            || this.halted || episode.requests >= episode.requestLimit
            || this.inputUsed + item.inputUpperTokens > this.config.inputTokenLimit
            || this.outputUsed + item.reservedOutputTokens > this.config.outputTokenLimit
            || charge(this.inputUsed + item.inputUpperTokens, this.outputUsed + item.reservedOutputTokens) > this.config.limitMicroCny
            || episode.inputUsed + item.inputUpperTokens > episode.inputLimit
            || episode.outputUsed + item.reservedOutputTokens > episode.outputLimit) throw new Error('Invalid ledger acceptance');
        this.requests.set(item.requestId, { ...item, settled: false });
        this.inputUsed += item.inputUpperTokens; this.outputUsed += item.reservedOutputTokens;
        episode.inputUsed += item.inputUpperTokens; episode.outputUsed += item.reservedOutputTokens; episode.requests++; this.accepted++;
      } else if (item.event === 'settled_verified') {
        const accepted = this.requests.get(item.requestId);
        if (!accepted || accepted.settled) throw new Error('Invalid ledger settlement');
        positive(item.promptTokens, 'ledger prompt usage'); nonnegative(item.completionTokens, 'ledger completion usage');
        const over = item.promptTokens > accepted.inputUpperTokens || item.completionTokens > accepted.reservedOutputTokens;
        if (item.actualMicroCny !== charge(item.promptTokens, item.completionTokens)
            || !['verified_usage', 'usage_over_reservation', 'output_cap_exceeded'].includes(item.status)
            || (item.status === 'verified_usage' && (over || item.completionTokens > accepted.requestedMaxTokens))
            || (item.status === 'usage_over_reservation' && !over)) throw new Error('Invalid verified ledger settlement');
        const episode = this.episodes.get(accepted.episodeId);
        this.inputUsed += item.promptTokens - accepted.inputUpperTokens;
        this.outputUsed += item.completionTokens - accepted.reservedOutputTokens;
        episode.inputUsed += item.promptTokens - accepted.inputUpperTokens;
        episode.outputUsed += item.completionTokens - accepted.reservedOutputTokens;
        accepted.settled = true; accepted.status = item.status;
        if (over || item.status === 'output_cap_exceeded') { this.halted = true; this.haltReason = item.status; }
      } else if (item.event === 'settled_unknown') {
        const accepted = this.requests.get(item.requestId);
        if (!accepted || accepted.settled || item.retainedMicroCny !== accepted.reservedMicroCny
            || typeof item.status !== 'string' || !/^[a-z_]{1,64}$/.test(item.status)) throw new Error('Invalid unknown ledger settlement');
        accepted.settled = true; accepted.status = item.status;
      } else if (item.event === 'halted') {
        if (typeof item.reason !== 'string' || !/^[a-z_]{1,64}$/.test(item.reason)) throw new Error('Invalid ledger halt');
        this.halted = true; this.haltReason = item.reason;
      } else if (item.event === 'rejected') {
        if (!receivedIds.has(item.requestId) || typeof item.reason !== 'string'
            || !/^[a-z_]{1,64}$/.test(item.reason)) throw new Error('Invalid ledger rejection');
      } else if (item.event === 'invalid_usage') {
        if (!this.requests.has(item.requestId)) throw new Error('Invalid usage diagnostic');
        this.halted = true; this.haltReason = 'invalid_reported_usage';
      } else throw new Error('Unknown ledger event');
      nonnegative(this.inputUsed, 'recovered input'); nonnegative(this.outputUsed, 'recovered output');
      charge(this.inputUsed, this.outputUsed);
    }
    // Restart never resurrects an episode capability. A trusted parent must
    // register a fresh capability without resetting persisted episode budgets.
    for (const episode of this.episodes.values()) episode.active = false;
  }

  append(item) {
    const data = { sequence: this.sequence + 1, at: new Date().toISOString(), ...item };
    try {
      const bytes = Buffer.from(JSON.stringify(data) + '\n');
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(this.fd, bytes, offset, bytes.length - offset);
        if (!written) throw new Error('Ledger write made no progress');
        offset += written;
      }
      fs.fsyncSync(this.fd); this.sequence++;
    } catch (error) {
      this.halted = true; this.haltReason = 'ledger_write_failed';
      for (const request of this.pending.values()) request.controller.abort();
      throw error;
    }
  }

  registerEpisode({ episodeId, capability = crypto.randomBytes(32).toString('base64url'),
    inputTokenLimit = this.config.perEpisodeInputTokenLimit, outputTokenLimit = this.config.perEpisodeOutputTokenLimit,
    maxRequests = this.config.maxRequestsPerEpisode } = {}) {
    if (this.closed || this.halted) throw new Error('Broker admission is stopped');
    if (!isId(episodeId)) throw new Error('Invalid episode ID');
    if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(capability)) throw new Error('Capability requires at least 32 safe characters');
    positive(inputTokenLimit, 'episode input budget'); positive(outputTokenLimit, 'episode output budget'); positive(maxRequests, 'episode request budget');
    if (inputTokenLimit > this.config.perEpisodeInputTokenLimit || outputTokenLimit > this.config.perEpisodeOutputTokenLimit) throw new Error('Episode token limit exceeds broker scope');
    if (maxRequests > 200 || maxRequests > this.config.maxRequestsPerEpisode) throw new Error('Episode request limit exceeds broker scope');
    const key = hash(capability);
    if (this.usedCapabilityHashes.has(key)) throw new Error('Capability already registered or revoked');
    let episode = this.episodes.get(episodeId);
    if (episode?.active) throw new Error('Episode already active');
    if (episode) {
      if (episode.inputLimit !== inputTokenLimit || episode.outputLimit !== outputTokenLimit || episode.requestLimit !== maxRequests) throw new Error('Episode cannot reset its persisted limits');
    } else {
      episode = { id: episodeId, inputLimit: inputTokenLimit, outputLimit: outputTokenLimit,
        requestLimit: maxRequests, inputUsed: 0, outputUsed: 0, requests: 0, active: false };
      this.episodes.set(episodeId, episode);
    }
    this.append({ event: 'episode_registered', episodeId, inputLimit: inputTokenLimit, outputLimit: outputTokenLimit,
      requestLimit: maxRequests, capabilitySha256: key });
    episode.active = true; episode.capabilityHash = key; this.capabilities.set(key, episode);
    this.usedCapabilityHashes.add(key);
    return { episodeId, capability };
  }

  revokeEpisode(episodeId) {
    if (this.closed) return false;
    const episode = this.episodes.get(episodeId);
    if (!episode?.active) return false;
    this.append({ event: 'episode_revoked', episodeId });
    episode.active = false; this.capabilities.delete(episode.capabilityHash);
    for (const request of this.pending.values()) if (request.episodeId === episodeId) request.controller.abort();
    return true;
  }

  halt(reason) {
    if (this.halted) return;
    this.append({ event: 'halted', reason }); this.halted = true; this.haltReason = reason;
    for (const request of this.pending.values()) request.controller.abort();
  }

  snapshot() {
    return { modelId: this.config.modelId, modelName: this.config.modelName, contextWindow: this.config.contextWindow,
      limitMicroCny: this.config.limitMicroCny, chargedOrReservedMicroCny: charge(this.inputUsed, this.outputUsed),
      inputTokenLimit: this.config.inputTokenLimit, outputTokenLimit: this.config.outputTokenLimit,
      inputUsedOrReserved: this.inputUsed, outputUsedOrReserved: this.outputUsed,
      receivedRequests: this.received, acceptedRequests: this.accepted, activeRequests: this.active.size,
      halted: this.halted, haltReason: this.haltReason, vendorInvoiceHardCap: false,
      episodes: [...this.episodes.values()].map((episode) => ({ episodeId: episode.id, active: episode.active,
        requests: episode.requests, inputUsedOrReserved: episode.inputUsed, outputUsedOrReserved: episode.outputUsed })) };
  }

  async listen({ host = '127.0.0.1', port = 0 } = {}) {
    if (this.closed) throw new Error('Broker is closed');
    await new Promise((resolve, reject) => { this.http.once('error', reject); this.http.listen(port, host, resolve); });
    const address = this.http.address();
    return { server: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`, port: address.port };
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      try {
        for (const request of this.pending.values()) request.controller.abort();
        this.http.closeAllConnections?.();
        if (this.http.listening) await new Promise((resolve) => this.http.close(resolve));
        await Promise.allSettled([...this.handlers]);
        await this.gate;
      } finally {
        try { if (this.fd != null) { fs.closeSync(this.fd); this.fd = null; } }
        finally { this.releaseLock(); }
      }
    })();
    return this.closing;
  }

  releaseLock() {
    if (this.lockFd == null) return;
    try {
      const current = fs.lstatSync(this.lockPath);
      if (current.isFile() && current.dev === this.lockIdentity?.dev && current.ino === this.lockIdentity?.ino
          && (!this.lockWritten || (current.size === Buffer.byteLength(this.lockContents)
          && fs.readFileSync(this.lockPath, 'utf8') === this.lockContents))) fs.unlinkSync(this.lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { fs.closeSync(this.lockFd); this.lockFd = null; this.lockIdentity = null; }
  }

  reject(res, error) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(error.status || 400, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ code: error.status || 400, message: `Repository broker: ${error.code || 'request_refused'}` }));
  }

  async handle(req, res) {
    if (this.closed) { res.destroy(); return; }
    const requestId = crypto.randomUUID();
    this.append({ event: 'received', requestId, method: String(req.method).slice(0, 16), pathSha256: hash(req.url || '') }); this.received++;
    let episode;
    let record;
    const controller = new AbortController();
    const pending = { controller, episodeId: null };
    this.pending.set(requestId, pending);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (req.url !== MODEL_PATH || req.method !== 'POST') fail('endpoint_not_allowed', 404);
      const authorization = req.headers.authorization;
      if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization)) fail('invalid_episode_capability', 401);
      episode = this.capabilities.get(hash(authorization.slice(7)));
      if (!episode?.active) fail('invalid_episode_capability', 401);
      pending.episodeId = episode.id;
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) fail('json_content_type_required', 415);
      const declared = req.headers['content-length'];
      if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > this.config.maxBodyBytes)) fail('body_too_large', 413);
      const body = await readBody(req, this.config.maxBodyBytes, controller.signal);
      const upper = validateBody(body, this.config);
      const operation = this.gate.then(async () => {
        if (this.closed) fail('broker_closed', 403);
        if (controller.signal.aborted || !episode.active) fail('episode_revoked', 403);
        if (this.halted) fail('broker_budget_stopped', 402);
        await this.sleep(Math.max(0, Math.ceil(this.lastDispatch + this.config.minRequestIntervalMs - this.now())), controller.signal);
        if (this.closed) fail('broker_closed', 403);
        if (controller.signal.aborted || !episode.active) fail('episode_revoked', 403);
        if (this.halted) fail('broker_budget_stopped', 402);
        if (this.active.size >= this.config.maxActiveRequests) fail('broker_busy', 429);
        if (episode.requests >= episode.requestLimit) fail('episode_request_limit', 402);
        const output = OUTPUT_RESERVATION_TOKENS;
        if (this.inputUsed + upper > this.config.inputTokenLimit || this.outputUsed + output > this.config.outputTokenLimit
            || charge(this.inputUsed + upper, this.outputUsed + output) > this.config.limitMicroCny) fail('run_budget_exhausted', 402);
        if (episode.inputUsed + upper > episode.inputLimit || episode.outputUsed + output > episode.outputLimit) fail('episode_token_budget_exhausted', 402);
        record = { requestId, episodeId: episode.id, inputUpperTokens: upper, reservedOutputTokens: output,
          reservedMicroCny: charge(upper, output), requestedMaxTokens: body.maxTokens, bodySha256: hash(JSON.stringify(body)),
          controller, settled: false, verifiedStart: false, done: null, bytes: 0 };
        this.append({ event: 'accepted', requestId, episodeId: episode.id, inputUpperTokens: upper,
          reservedOutputTokens: output, reservedMicroCny: record.reservedMicroCny, requestedMaxTokens: body.maxTokens,
          bodySha256: record.bodySha256 });
        this.requests.set(requestId, record); this.active.set(requestId, record);
        this.inputUsed += upper; this.outputUsed += output; this.accepted++;
        episode.inputUsed += upper; episode.outputUsed += output; episode.requests++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' });
        const timer = setTimeout(() => controller.abort(), this.config.streamTimeoutMs);
        let stream;
        try { stream = this.api.stream(MODEL_PATH, body, (name, data) => this.relay(record, res, name, data), { signal: controller.signal }); }
        catch (error) { stream = Promise.reject(error); }
        // Include synchronous API setup time in spacing, so TLS/bootstrap cannot
        // shorten the interval between actual dispatch attempts.
        this.lastDispatch = this.now();
        record.completion = Promise.resolve(stream).then(() => {
          if (controller.signal.aborted) throw abortError();
          if (!record.verifiedStart || !record.done) throw new BrokerError('incomplete_stream', 502);
          this.settle(record, record.done.usage);
        }).catch((error) => {
          const reason = error instanceof BrokerError ? error.code : controller.signal.aborted ? 'aborted' : 'upstream_error';
          if (!record.settled) this.unknown(record, reason);
          if (!res.destroyed && !res.writableEnded) {
            res.write(`event:error\ndata:${JSON.stringify({ message: `Repository broker: ${reason}; reservation retained`, retryable: Boolean(error.retryable) })}\n\n`);
          }
        }).finally(() => { clearTimeout(timer); this.active.delete(requestId); if (!res.destroyed && !res.writableEnded) res.end(); });
        return { completion: record.completion };
      });
      // Never serialize the whole stream in the pacing gate: only dispatch is
      // serialized. The wrapper object prevents promise assimilation here.
      this.gate = operation.then(() => {}, () => {});
      const dispatched = await operation;
      await dispatched.completion;
    } catch (error) {
      if (record && !record.settled) this.unknown(record, error instanceof BrokerError ? error.code : 'broker_error');
      else if (!record) this.append({ event: 'rejected', requestId, episodeId: episode?.id || null,
        reason: error instanceof BrokerError ? error.code : controller.signal.aborted ? 'request_aborted' : 'invalid_request' });
      if (!res.headersSent) this.reject(res, error);
      else if (!res.destroyed && !res.writableEnded) res.end();
    } finally {
      this.pending.delete(requestId);
      if (record && !record.completion) this.active.delete(requestId);
    }
  }

  relay(record, res, name, data) {
    if (record.controller.signal.aborted) throw abortError();
    if (!EVENTS.has(name) || !data || typeof data !== 'object' || Array.isArray(data)) { this.halt('invalid_sse_event'); fail('invalid_sse_event', 502); }
    if (record.done) { this.halt('data_after_done'); fail('data_after_done', 502); }
    if (name === 'start') {
      if (record.verifiedStart || data.model?.id !== this.config.modelId || data.model?.modelName !== this.config.modelName
          || data.contextWindow !== this.config.contextWindow || !Number.isSafeInteger(data.maxTokens)
          || data.maxTokens <= 0 || data.maxTokens > record.requestedMaxTokens) {
        this.halt('wrong_sse_start'); fail('wrong_sse_start', 502);
      }
      record.verifiedStart = true; record.startedMaxTokens = data.maxTokens;
    } else if (!record.verifiedStart) { this.halt('data_before_start'); fail('data_before_start', 502); }
    if (name === 'done') {
      if (!Number.isSafeInteger(data.maxTokens) || data.maxTokens <= 0 || data.maxTokens > record.startedMaxTokens) {
        this.halt('wrong_sse_done'); fail('wrong_sse_done', 502);
      }
      record.done = data;
      const usage = data.usage;
      if (usage?.estimated === false) {
        try {
          positive(usage.promptTokens, 'reported prompt usage'); nonnegative(usage.completionTokens, 'reported output usage');
          charge(usage.promptTokens, usage.completionTokens);
          charge(this.inputUsed + usage.promptTokens - record.inputUpperTokens,
            this.outputUsed + usage.completionTokens - record.reservedOutputTokens);
        } catch {
          this.append({ event: 'invalid_usage', requestId: record.requestId,
            promptTokens: Number.isSafeInteger(usage.promptTokens) ? usage.promptTokens : null,
            completionTokens: Number.isSafeInteger(usage.completionTokens) ? usage.completionTokens : null });
          this.halt('invalid_reported_usage'); fail('invalid_reported_usage', 502);
        }
        const over = usage.promptTokens > record.inputUpperTokens || usage.completionTokens > record.reservedOutputTokens;
        if (over || usage.completionTokens > data.maxTokens) {
          const status = over ? 'usage_over_reservation' : 'output_cap_exceeded';
          this.verified(record, usage, status); this.halt(status); fail(status, 502);
        }
      }
    }
    const frame = `event:${name}\ndata:${JSON.stringify(data)}\n\n`;
    const bytes = Buffer.byteLength(frame);
    if (record.bytes + bytes > this.config.maxStreamBytes || res.writableLength + bytes > this.config.maxBufferedResponseBytes) {
      this.halt('stream_buffer_cap'); fail('stream_buffer_cap', 502);
    }
    record.bytes += bytes; res.write(frame);
  }

  settle(record, usage) {
    if (usage?.estimated === false && Number.isSafeInteger(usage.promptTokens) && usage.promptTokens > 0
        && Number.isSafeInteger(usage.completionTokens) && usage.completionTokens >= 0) this.verified(record, usage, 'verified_usage');
    else this.unknown(record, 'missing_or_estimated_usage');
  }

  verified(record, usage, status) {
    if (record.settled) throw new Error('Double settlement');
    const episode = this.episodes.get(record.episodeId);
    charge(usage.promptTokens, usage.completionTokens);
    this.append({ event: 'settled_verified', requestId: record.requestId, promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens, actualMicroCny: charge(usage.promptTokens, usage.completionTokens), status });
    this.inputUsed += usage.promptTokens - record.inputUpperTokens; this.outputUsed += usage.completionTokens - record.reservedOutputTokens;
    episode.inputUsed += usage.promptTokens - record.inputUpperTokens; episode.outputUsed += usage.completionTokens - record.reservedOutputTokens;
    record.settled = true; record.status = status;
  }

  unknown(record, status) {
    if (record.settled) return;
    this.append({ event: 'settled_unknown', requestId: record.requestId, status, retainedMicroCny: record.reservedMicroCny });
    record.settled = true; record.status = status;
  }
}

export const createRepositoryBroker = (options) => new RepositoryBroker(options);

/** Trusted parent stdin only. No HTTP control route and no capabilities or
 * production login are printed. Root chooses each capability before register.
 */
export async function runBrokerMain({ input = process.stdin, output = process.stdout } = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let broker;
  let serial = Promise.resolve();
  const emit = (data) => output.write(JSON.stringify(data) + '\n');
  lines.on('line', (line) => {
    serial = serial.then(async () => {
      if (Buffer.byteLength(line) > 256_000) throw new Error('Management line too large');
      const message = JSON.parse(line);
      if (!broker) {
        if (!message.server || !message.token || !message.ledgerPath) throw new Error('Initial server/token/ledgerPath required');
        const candidate = new RepositoryBroker(message);
        let endpoint;
        try {
          endpoint = await candidate.listen(message.listen);
          if (message.episodeId) {
            if (!message.capability) throw new Error('Parent must supply episode capability');
            candidate.registerEpisode({ episodeId: message.episodeId, capability: message.capability });
          }
        } catch (error) { await candidate.close(); throw error; }
        broker = candidate;
        emit({ type: 'ready', ...endpoint, budget: broker.snapshot() }); return;
      }
      if (message.command === 'register') {
        if (!message.capability) throw new Error('Parent must supply episode capability');
        broker.registerEpisode(message); emit({ type: 'registered', episodeId: message.episodeId });
      } else if (message.command === 'revoke') emit({ type: 'revoked', episodeId: message.episodeId, revoked: broker.revokeEpisode(message.episodeId) });
      else if (message.command === 'status') emit({ type: 'status', budget: broker.snapshot() });
      else if (message.command === 'close') { await broker.close(); broker = null; emit({ type: 'closed' }); lines.close(); }
      else throw new Error('Unknown management command');
    }).catch(() => { emit({ type: 'management_error', message: 'Broker management command refused' }); });
  });
  await new Promise((resolve) => lines.once('close', resolve));
  await serial;
  if (broker) await broker.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runBrokerMain().catch(() => { process.stderr.write('Repository broker stopped\n'); process.exitCode = 1; });
}
