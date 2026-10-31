// Offline only: production Api.stream talks to a loopback broker; every
// upstream model invocation is an injected fake. No Docker or provider access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Api } from '../../zhiqu-cli/src/api.js';
import { RepositoryBroker, MODEL_PATH, OUTPUT_RESERVATION_TOKENS, inputTokenUpperBound, runBrokerMain } from './repository-broker.mjs';

const CAPABILITY = 'episode_capability_'.padEnd(48, 'x');
const body = () => ({ modelId: 6, messages: [{ role: 'user', content: 'private prompt 汉字' }], tools: [], maxTokens: 1024 });
const start = (payload, overrides = {}) => ({ model: { id: 6, modelName: 'deepseek-v4-pro' },
  contextWindow: 1_000_000, maxTokens: payload.maxTokens, ...overrides });
const done = (payload, usage = { promptTokens: 100, completionTokens: 20, estimated: false }) => ({
  message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', maxTokens: payload.maxTokens, usage });
const ledger = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const settleTurn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, { handler, config = {}, episode = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-repository-broker-'));
  const ledgerPath = path.join(directory, 'ledger.jsonl');
  const calls = [];
  let clock = 0;
  const api = { stream: async (pathname, payload, emit, { signal }) => {
    calls.push({ pathname, payload, at: clock, signal });
    // A dispatch must already have a durable reservation when upstream starts.
    assert.equal(ledger(ledgerPath).at(-1).event, 'accepted');
    if (handler) return handler({ pathname, payload, emit, signal, calls });
    emit('start', start(payload)); emit('delta', { content: 'ok' }); emit('done', done(payload));
  } };
  const broker = new RepositoryBroker({ api, ledgerPath, now: () => clock,
    sleep: async (ms, signal) => { if (signal.aborted) throw Object.assign(new Error('abort'), { name: 'AbortError' }); clock += ms; }, ...config });
  t.after(async () => { await broker.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const endpoint = await broker.listen();
  broker.registerEpisode({ episodeId: 'episode-1', capability: CAPABILITY, ...episode });
  return { broker, calls, ledgerPath, directory, endpoint, client: new Api({ server: endpoint.server, token: CAPABILITY }) };
}

function request(server, { method = 'POST', pathname = MODEL_PATH, capability = CAPABILITY, payload = body(),
  bytes, headers = {}, signal } = {}) {
  const data = bytes ?? Buffer.from(JSON.stringify(payload));
  const requestHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${capability}`, 'Content-Length': data.length, ...headers };
  for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
  return new Promise((resolve, reject) => {
    const req = http.request(server + pathname, { method, signal,
      headers: requestHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('offline HTTP test timeout'))); req.end(data);
  });
}

async function stream(client, payload = body()) {
  const events = [];
  await client.stream(MODEL_PATH, payload, (name, data) => events.push({ name, data }));
  return events;
}

test('production Api.stream body/path and SSE semantics survive capability relay with exact integer accounting', async (t) => {
  const f = await fixture(t, { handler: ({ payload, emit }) => {
    emit('start', start(payload)); emit('reasoning', { content: 'reason' }); emit('delta', { content: 'ok' });
    emit('tool_call', { index: 0, id: 'call_1', name: 'read_file', arguments: '{}' });
    emit('tool_progress', { index: 0, name: 'read_file' }); emit('done', done(payload));
  } });
  const payload = body();
  const events = await stream(f.client, payload);
  assert.deepEqual(events.map((event) => event.name), ['start', 'reasoning', 'delta', 'tool_call', 'tool_progress', 'done']);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].pathname, MODEL_PATH); assert.deepEqual(f.calls[0].payload, payload);
  assert.deepEqual(Object.keys(f.calls[0].payload).sort(), ['maxTokens', 'messages', 'modelId', 'tools']);
  const state = f.broker.snapshot();
  assert.equal(state.inputUsedOrReserved, 100); assert.equal(state.outputUsedOrReserved, 20);
  assert.equal(state.chargedOrReservedMicroCny, 100 * 9 + 20 * 27); assert.equal(state.vendorInvoiceHardCap, false);
  const entries = ledger(f.ledgerPath);
  assert.equal(entries.find((entry) => entry.event === 'accepted').reservedOutputTokens, OUTPUT_RESERVATION_TOKENS);
  assert.equal(entries.find((entry) => entry.event === 'accepted').inputUpperTokens, inputTokenUpperBound(payload));
  const persisted = fs.readFileSync(f.ledgerPath, 'utf8');
  assert.ok(!persisted.includes(CAPABILITY)); assert.ok(!persisted.includes(payload.messages[0].content));
  assert.equal(fs.statSync(f.ledgerPath).mode & 0o777, 0o600);
});

test('wrong method/path/capability, extra fields, model, output cap and invalid JSON never dispatch', async (t) => {
  const f = await fixture(t);
  const cases = [
    [{ method: 'GET' }, 404], [{ pathname: '/api/harness/models' }, 404], [{ pathname: MODEL_PATH + '?x=1' }, 404],
    [{ capability: 'unknown_capability_'.padEnd(48, 'z') }, 401], [{ capability: 'short' }, 401],
    [{ headers: { 'Content-Type': 'text/plain' } }, 415],
    [{ payload: { ...body(), thinking: false } }, 400], [{ payload: { ...body(), modelId: 2 } }, 400],
    [{ payload: { ...body(), maxTokens: 0 } }, 400], [{ payload: { ...body(), maxTokens: 16_385 } }, 400],
    [{ payload: { ...body(), messages: [] } }, 400], [{ payload: { ...body(), tools: [{ type: 'function' }] } }, 400],
    [{ bytes: Buffer.from('{bad json') }, 400], [{ bytes: Buffer.from([0xff, 0xfe]) }, 400],
  ];
  for (const [options, status] of cases) assert.equal((await request(f.endpoint.server, options)).status, status);
  assert.equal(f.calls.length, 0); assert.equal(f.broker.snapshot().acceptedRequests, 0);
  assert.equal(ledger(f.ledgerPath).filter((item) => item.event === 'rejected').length, cases.length);
  assert.equal(ledger(f.ledgerPath).filter((item) => item.event === 'received').length, cases.length);
});

test('request bytes and context upper bound are enforced before dispatch', async (t) => {
  const f = await fixture(t, { config: { maxBodyBytes: 500 } });
  assert.equal((await request(f.endpoint.server, { bytes: Buffer.alloc(501, 32) })).status, 413);
  // Chunked requests cannot bypass the byte cap by omitting Content-Length.
  assert.equal((await request(f.endpoint.server, { bytes: Buffer.alloc(501, 32),
    headers: { 'Content-Length': undefined, 'Transfer-Encoding': 'chunked' } })).status, 413);
  assert.equal(f.calls.length, 0);
  const f2 = await fixture(t);
  const payload = body(); payload.messages[0].content = 'a'.repeat(980_000);
  assert.equal((await request(f2.endpoint.server, { payload })).status, 400); assert.equal(f2.calls.length, 0);
});

test('a ledger is for one approved model: ID 6 or ID 1 (both deepseek-v4-pro / 1M); any other model or window is refused', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-broker-model-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const modelId of [6, 1]) {
    const broker = new RepositoryBroker({ api: { stream() {} }, ledgerPath: path.join(directory, `ok-${modelId}.jsonl`), modelId });
    assert.equal(broker.snapshot().modelId, modelId);
    broker.releaseLock();
  }
  for (const [name, options] of [['id2', { modelId: 2 }], ['name', { modelId: 1, modelName: 'deepseek-chat' }], ['window', { modelId: 1, contextWindow: 64_000 }]]) {
    assert.throws(() => new RepositoryBroker({ api: { stream() {} }, ledgerPath: path.join(directory, name + '.jsonl'), ...options }), /6 or 1/);
  }
});

test('null, zero, unsafe and larger-than-approved budgets fail closed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-broker-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [key, value] of [['limitMicroCny', null], ['inputTokenLimit', null], ['outputTokenLimit', 0],
    ['inputTokenLimit', Number.MAX_SAFE_INTEGER + 1], ['limitMicroCny', 100_000_001], ['minRequestIntervalMs', 1199], ['maxRequestsPerEpisode', 201]]) {
    assert.throws(() => new RepositoryBroker({ api: { stream() {} }, ledgerPath: path.join(directory, key + '.jsonl'), [key]: value }));
  }
  // 第八十七轮：用户把重跑的上限定到 ¥100（保守口径）—— 正好 ¥100 收，多一分不收（上面那条）
  assert.doesNotThrow(() => new RepositoryBroker({ api: { stream() {} }, ledgerPath: path.join(directory, 'cap100.jsonl'), limitMicroCny: 100_000_000 }));
  const f = await fixture(t);
  assert.throws(() => f.broker.registerEpisode({ episodeId: 'bigger-input', inputTokenLimit: 2_000_001 }));
  assert.throws(() => f.broker.registerEpisode({ episodeId: 'bigger-output', outputTokenLimit: 131_073 }));
  assert.throws(() => f.broker.registerEpisode({ episodeId: 'bigger-requests', maxRequests: 201 }));
});

test('unknown, estimated, failed and incomplete usage retain the full output and input reservation', async (t) => {
  for (const mode of ['missing_usage', 'estimated_usage', 'upstream_error', 'missing_start', 'missing_done']) {
    const f = await fixture(t, { handler: ({ payload, emit }) => {
      if (mode === 'upstream_error') throw Object.assign(new Error('real-login-secret'), { code: 'real-login-secret' });
      if (mode !== 'missing_start') emit('start', start(payload));
      if (mode !== 'missing_done' && mode !== 'missing_start') emit('done', done(payload,
        mode === 'missing_usage' ? null : { promptTokens: 1, completionTokens: 1, estimated: true }));
    } });
    if (mode === 'missing_usage' || mode === 'estimated_usage') await stream(f.client);
    else await assert.rejects(stream(f.client), /reservation retained/);
    const state = f.broker.snapshot();
    assert.equal(state.inputUsedOrReserved, inputTokenUpperBound(body())); assert.equal(state.outputUsedOrReserved, 16_384);
    assert.equal(ledger(f.ledgerPath).at(-1).event, 'settled_unknown');
    assert.ok(!fs.readFileSync(f.ledgerPath, 'utf8').includes('real-login-secret'));
  }
});

test('wrong model/start, missing done metadata, data before start and data after done halt admission', async (t) => {
  for (const mode of ['wrong_model', 'wrong_context', 'start_output_cap', 'done_output_cap', 'missing_done_cap', 'before_start', 'after_done']) {
    const f = await fixture(t, { handler: ({ payload, emit }) => {
      if (mode === 'before_start') { emit('delta', { content: 'x' }); return; }
      emit('start', start(payload, mode === 'wrong_model' ? { model: { id: 6, modelName: 'another-model' } }
        : mode === 'wrong_context' ? { contextWindow: 999_999 }
          : mode === 'start_output_cap' ? { maxTokens: payload.maxTokens + 1 } : {}));
      const completion = done(payload);
      if (mode === 'done_output_cap') completion.maxTokens++;
      if (mode === 'missing_done_cap') delete completion.maxTokens;
      emit('done', completion);
      if (mode === 'after_done') emit('delta', { content: 'x' });
    } });
    await assert.rejects(stream(f.client));
    assert.equal(f.broker.snapshot().halted, true, mode);
    assert.equal(f.broker.snapshot().outputUsedOrReserved, 16_384, mode);
    assert.equal((await request(f.endpoint.server)).status, 402); assert.equal(f.calls.length, 1);
  }
});

test('real usage over reservation records actual charge and stops admission, including recovery before halt event', async (t) => {
  const payload = body();
  const actualInput = inputTokenUpperBound(payload) + 1;
  const f = await fixture(t, { handler: ({ payload, emit }) => {
    emit('start', start(payload)); emit('done', done(payload, { promptTokens: actualInput, completionTokens: 100, estimated: false }));
  } });
  await assert.rejects(stream(f.client), /usage_over_reservation/);
  assert.equal(f.broker.snapshot().inputUsedOrReserved, actualInput); assert.equal(f.broker.snapshot().outputUsedOrReserved, 100);
  assert.equal(f.broker.snapshot().chargedOrReservedMicroCny, actualInput * 9 + 100 * 27);
  assert.equal(f.broker.snapshot().halted, true); assert.equal(f.broker.snapshot().vendorInvoiceHardCap, false);
  assert.equal((await request(f.endpoint.server)).status, 402);
  await f.broker.close();
  const entries = ledger(f.ledgerPath).filter((entry) => entry.event !== 'halted');
  fs.writeFileSync(f.ledgerPath, entries.map((item, index) => JSON.stringify({ ...item, sequence: index + 1 })).join('\n') + '\n');
  const recovered = new RepositoryBroker({ api: { stream() { assert.fail('no upstream'); } }, ledgerPath: f.ledgerPath });
  t.after(() => recovered.close());
  assert.equal(recovered.snapshot().halted, true); assert.equal(recovered.snapshot().haltReason, 'usage_over_reservation');
});

test('invalid or overflowing reported usage and output above the requested cap stop admission', async (t) => {
  for (const [usage, reason] of [
    [{ promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 0, estimated: false }, 'invalid_reported_usage'],
    [{ promptTokens: -1, completionTokens: 1, estimated: false }, 'invalid_reported_usage'],
    [{ promptTokens: 100, completionTokens: 1025, estimated: false }, 'output_cap_exceeded'],
  ]) {
    const f = await fixture(t, { handler: ({ payload, emit }) => { emit('start', start(payload)); emit('done', done(payload, usage)); } });
    await assert.rejects(stream(f.client), new RegExp(reason));
    assert.equal(f.broker.snapshot().haltReason, reason);
    assert.equal((await request(f.endpoint.server)).status, 402);
    if (reason === 'output_cap_exceeded') assert.equal(f.broker.snapshot().outputUsedOrReserved, 1025);
    else assert.equal(f.broker.snapshot().outputUsedOrReserved, 16_384);
  }
});

test('global pacing serializes dispatch, allows two concurrent streams and rejects a third while busy', async (t) => {
  const release = deferred(); const firstTwo = deferred();
  const f = await fixture(t, { handler: async ({ payload, emit, calls }) => {
    emit('start', start(payload)); if (calls.length === 2) firstTwo.resolve();
    await release.promise; emit('done', done(payload));
  } });
  const first = stream(f.client); const second = stream(f.client);
  await firstTwo.promise;
  assert.equal(f.broker.snapshot().activeRequests, 2);
  assert.equal(f.calls[1].at - f.calls[0].at, 1200);
  assert.equal((await request(f.endpoint.server)).status, 429); assert.equal(f.calls.length, 2);
  release.resolve(); await Promise.all([first, second]);
  await stream(f.client);
  assert.ok(f.calls[2].at - f.calls[1].at >= 1200);
});

test('money, global tokens, episode tokens and request limits refuse dispatch after reservation', async (t) => {
  const unknown = ({ payload, emit }) => { emit('start', start(payload)); emit('done', done(payload, null)); };
  const reservation = inputTokenUpperBound(body()) * 9 + 16_384 * 27;
  const cases = [
    { config: { limitMicroCny: reservation }, reason: 'run_budget_exhausted' },
    { config: { inputTokenLimit: inputTokenUpperBound(body()) }, reason: 'run_budget_exhausted' },
    { config: { outputTokenLimit: 16_384 }, reason: 'run_budget_exhausted' },
    { episode: { inputTokenLimit: inputTokenUpperBound(body()) }, reason: 'episode_token_budget_exhausted' },
    { episode: { outputTokenLimit: 16_384 }, reason: 'episode_token_budget_exhausted' },
    { episode: { maxRequests: 1 }, reason: 'episode_request_limit' },
  ];
  for (const options of cases) {
    const f = await fixture(t, { handler: unknown, ...options }); await stream(f.client);
    const rejected = await request(f.endpoint.server);
    assert.equal(rejected.status, 402); assert.match(rejected.text, new RegExp(options.reason)); assert.equal(f.calls.length, 1);
  }
});

test('revocation aborts in-flight streams and capabilities cannot be reused', async (t) => {
  const started = deferred();
  const f = await fixture(t, { handler: async ({ payload, emit, signal }) => {
    emit('start', start(payload)); started.resolve();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  const active = stream(f.client); const rejected = assert.rejects(active, /reservation retained/);
  await started.promise;
  assert.equal(f.broker.revokeEpisode('episode-1'), true); await rejected;
  assert.equal(f.broker.snapshot().outputUsedOrReserved, 16_384);
  assert.equal((await request(f.endpoint.server)).status, 401);
  assert.throws(() => f.broker.registerEpisode({ episodeId: 'episode-2', capability: CAPABILITY }), /already registered or revoked/);
});

test('client disconnect conservatively retains reservations', async (t) => {
  const started = deferred(); const aborted = deferred();
  const f = await fixture(t, { handler: async ({ payload, emit, signal }) => {
    emit('start', start(payload)); started.resolve();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted.resolve(); reject(new Error('cancelled')); }, { once: true }));
  } });
  const controller = new AbortController();
  const active = request(f.endpoint.server, { signal: controller.signal });
  const rejected = assert.rejects(active, { name: 'AbortError' });
  await started.promise; controller.abort(); await rejected; await aborted.promise; await settleTurn();
  assert.equal(f.broker.snapshot().outputUsedOrReserved, 16_384);
  assert.equal(ledger(f.ledgerPath).at(-1).event, 'settled_unknown');
});

test('close aborts pending pacing and incomplete request bodies before closing the ledger', async (t) => {
  const sleeping = deferred();
  const f = await fixture(t, { config: { sleep: async (ms, signal) => {
    if (!ms) return;
    sleeping.resolve();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } } });
  await stream(f.client);
  const queued = request(f.endpoint.server); const refused = assert.rejects(queued);
  await sleeping.promise;
  // An incomplete upload also needs to wake when the broker closes.
  const req = http.request(f.endpoint.server + MODEL_PATH, { method: 'POST', headers: {
    Authorization: `Bearer ${CAPABILITY}`, 'Content-Type': 'application/json', 'Content-Length': 999,
  } });
  req.on('error', () => {}); req.write('{');
  await settleTurn(); await f.broker.close(); await refused; req.destroy();
  assert.equal(f.calls.length, 1); assert.equal(f.broker.pending.size, 0); assert.equal(f.broker.fd, null);
  assert.throws(() => f.broker.registerEpisode({ episodeId: 'closed-episode' }), /stopped/);
});

test('restart keeps money/token/request counters and invalidates old capabilities without resetting episodes', async (t) => {
  const f = await fixture(t, { handler: ({ payload, emit }) => { emit('start', start(payload)); emit('done', done(payload, null)); } });
  await stream(f.client); const before = f.broker.snapshot(); await f.broker.close();
  const recovered = new RepositoryBroker({ api: { stream() { assert.fail('offline only'); } }, ledgerPath: f.ledgerPath });
  t.after(() => recovered.close());
  const state = recovered.snapshot();
  assert.equal(state.chargedOrReservedMicroCny, before.chargedOrReservedMicroCny);
  assert.equal(state.acceptedRequests, 1); assert.equal(state.episodes[0].requests, 1); assert.equal(state.episodes[0].active, false);
  assert.throws(() => recovered.registerEpisode({ episodeId: 'episode-1', capability: CAPABILITY }), /already registered or revoked/);
  const newCapability = 'replacement_capability_'.padEnd(48, 'r');
  recovered.registerEpisode({ episodeId: 'episode-1', capability: newCapability });
  assert.equal(recovered.snapshot().episodes[0].requests, 1);
  await recovered.close();
  const again = new RepositoryBroker({ api: { stream() {} }, ledgerPath: f.ledgerPath }); t.after(() => again.close());
  assert.equal(again.snapshot().chargedOrReservedMicroCny, before.chargedOrReservedMicroCny);
});

test('empty, torn, malformed and tampered ledgers fail closed', async (t) => {
  const f = await fixture(t); await stream(f.client); await f.broker.close();
  const valid = fs.readFileSync(f.ledgerPath, 'utf8');
  const edits = [
    () => '', () => valid.slice(0, -1), () => '{}\n',
    (rows) => { rows[2].inputUpperTokens = -1; return rows; },
    (rows) => { rows[2].reservedOutputTokens = 1; return rows; },
    (rows) => { rows[2].reservedMicroCny = 0; return rows; },
    (rows) => { rows[3].promptTokens = -1; return rows; },
    (rows) => { rows[3].actualMicroCny = 0; return rows; },
    (rows) => { rows[3].event = 'unknown_event'; return rows; },
    (rows) => { rows.push({ ...rows[3], sequence: rows.length + 1 }); return rows; },
  ];
  // Fixture order is init/register/received/accepted/settled; locate entries
  // explicitly so the tampering targets financial counters, not incidental rows.
  for (const edit of edits) {
    const rows = ledger(f.ledgerPath);
    const financial = [rows[0], rows[1], rows.find((row) => row.event === 'accepted'), rows.find((row) => row.event === 'settled_verified')];
    const result = edit(financial);
    let text;
    if (typeof result === 'string') text = result;
    else {
      const originals = ledger(f.ledgerPath);
      const accepted = result[2]; const settled = result[3];
      text = [...originals.slice(0, 3), accepted, settled, ...result.slice(4)]
        .map((row, index) => JSON.stringify({ ...row, sequence: index + 1 })).join('\n') + '\n';
    }
    const file = path.join(f.directory, 'corrupt.jsonl'); fs.writeFileSync(file, text);
    assert.throws(() => new RepositoryBroker({ api: { stream() {} }, ledgerPath: file }), undefined, text);
  }
});

test('exclusive ledger locks reject other instances/processes, preserve stale owners and release only owned locks', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-broker-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, 'ledger.jsonl'); const lockPath = ledgerPath + '.lock';
  const first = new RepositoryBroker({ api: { stream() {} }, ledgerPath }); t.after(() => first.close());
  const original = fs.readFileSync(lockPath, 'utf8');
  assert.throws(() => new RepositoryBroker({ api: { stream() {} }, ledgerPath }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(lockPath, 'utf8'), original, 'a refused constructor must not delete the active owner lock');
  const source = new URL('./repository-broker.mjs', import.meta.url).href;
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
    import { RepositoryBroker } from ${JSON.stringify(source)};
    try {
      const broker = new RepositoryBroker({ api: { stream() {} }, ledgerPath: ${JSON.stringify(ledgerPath)} });
      await broker.close(); throw new Error('second process acquired an active ledger');
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  `]);
  await first.close(); assert.equal(fs.existsSync(lockPath), false);
  const second = new RepositoryBroker({ api: { stream() {} }, ledgerPath }); await second.close();
  assert.equal(fs.existsSync(lockPath), false);
  fs.writeFileSync(lockPath, 'stale-owner\n');
  const persisted = fs.readFileSync(ledgerPath, 'utf8');
  assert.throws(() => new RepositoryBroker({ api: { stream() {} }, ledgerPath }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'stale-owner\n'); assert.equal(fs.readFileSync(ledgerPath, 'utf8'), persisted);
  fs.unlinkSync(lockPath);
  const invalidPath = path.join(directory, 'empty.jsonl'); fs.writeFileSync(invalidPath, '');
  assert.throws(() => new RepositoryBroker({ api: { stream() {} }, ledgerPath: invalidPath }), /Empty ledger/);
  assert.equal(fs.existsSync(invalidPath + '.lock'), false, 'failed recovery must release its own lock');
  const third = new RepositoryBroker({ api: { stream() {} }, ledgerPath });
  fs.unlinkSync(lockPath); fs.writeFileSync(lockPath, 'replacement-owner\n'); await third.close();
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'replacement-owner\n', 'close must preserve a replacement owner lock');
});

test('trusted stdin management exposes neither real login nor episode capability and has no HTTP control route', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-broker-management-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = new PassThrough(); const output = new PassThrough(); const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
  const running = runBrokerMain({ input, output });
  t.after(async () => { input.end(); await running; });
  const waitingForReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { output.removeListener('data', take); reject(new Error('offline management ready timeout')); }, 5000);
    const take = (chunk) => {
      if (chunk.toString().includes('"type":"ready"')) { clearTimeout(timer); output.removeListener('data', take); resolve(); }
      else if (chunk.toString().includes('"type":"management_error"')) { clearTimeout(timer); output.removeListener('data', take); reject(new Error('offline management initialization failed')); }
    };
    output.on('data', take);
  });
  const token = 'production-login-secret-for-offline-test';
  input.write(JSON.stringify({ server: 'http://127.0.0.1:1', token, ledgerPath: path.join(directory, 'ledger.jsonl'),
    episodeId: 'management-episode', capability: CAPABILITY }) + '\n');
  await waitingForReady;
  const ready = JSON.parse(chunks[0]);
  assert.equal((await request(ready.server, { pathname: '/register' })).status, 404);
  input.write(JSON.stringify({ command: 'status' }) + '\n');
  input.end(JSON.stringify({ command: 'close' }) + '\n'); await running;
  const text = chunks.join('');
  assert.ok(text.includes('"type":"closed"')); assert.ok(!text.includes(token)); assert.ok(!text.includes(CAPABILITY));
  const persisted = fs.readFileSync(path.join(directory, 'ledger.jsonl'), 'utf8');
  assert.ok(!persisted.includes(token)); assert.ok(!persisted.includes(CAPABILITY));
});

test('budget and exclusive-lock assertions have been seen red under known regressions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-broker-red-proof-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourceUrl = new URL('./repository-broker.mjs', import.meta.url);
  const source = fs.readFileSync(sourceUrl, 'utf8')
    .replace("'../../zhiqu-cli/src/api.js'", JSON.stringify(pathToFileURL(path.resolve('zhiqu-cli/src/api.js')).href))
    .replace('createRequire(import.meta.url)', `createRequire(${JSON.stringify(sourceUrl.href)})`);
  for (const [name, mutatedSource, options, pattern] of [
    ['null', source.replace('options[key] === undefined ? value : options[key]', 'options[key] ?? value'), { inputTokenLimit: null }, /positive safe integer/],
    ['empty', source.replace("if (!raw) throw new Error('Empty ledger: refuse to reset budget');", ''), {}, /Empty ledger/],
    ['lock', source.replace("fs.openSync(this.lockPath, 'wx', 0o600)", "fs.openSync(this.lockPath, 'w', 0o600)"), {}, /EEXIST/],
  ]) {
    const { RepositoryBroker: MutatedBroker } = await import('data:text/javascript;base64,' + Buffer.from(mutatedSource).toString('base64'));
    const ledgerPath = path.join(directory, name + '.jsonl');
    if (name === 'empty') fs.writeFileSync(ledgerPath, '');
    const owner = name === 'lock' ? new RepositoryBroker({ api: { stream() {} }, ledgerPath }) : null;
    let created;
    assert.throws(() => assert.throws(() => {
      created = new MutatedBroker({ api: { stream() {} }, ledgerPath, ...options });
    }, pattern), { name: 'AssertionError' }, `${name}: assertion must speak, rather than a setup error`);
    await created?.close();
    await owner?.close();
  }
});
