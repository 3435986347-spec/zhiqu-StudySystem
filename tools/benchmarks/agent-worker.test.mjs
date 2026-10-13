import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTask, publicTask, redact } from './agent-worker.mjs';
import { parseArgs, renderSandbox, sampleFor, selectDeepSeekModel, createWorkerStopper,
  assertHiddenDatasetIsPrivate, assertLoopbackServer } from './run-humaneval.mjs';
import { sanitizeWorkerResult } from './run-humaneval.mjs';
import { resolveOnPath } from '../../zhiqu-cli/src/tools/exec.js';

const model = { id: 1, label: 'DeepSeek fixture', modelName: 'deepseek-fixture',
  providerType: 'OPENAI_COMPATIBLE', toolCalling: true, effectiveContextWindow: 64000 };
const task = { task_id: 'HumanEval/0', entry_point: 'double',
  prompt: 'def double(x):\n    """Return x times two.\n    >>> double(3)\n    6\n    """\n' };

function fixture(t, responses, actual = model) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-benchmark-protocol-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'solution.py'), task.prompt);
  let index = 0;
  const requests = [];
  const api = { async stream(_pathname, body, event) {
    requests.push(body);
    event('start', { model: actual, contextWindow: 64000, maxTokens: 16384 });
    const response = responses[index++] || { text: 'Done.' };
    const calls = (response.calls || []).map((call, i) => ({ id: `call-${index}-${i}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) } }));
    const message = { role: 'assistant', content: response.text || '' };
    if (calls.length) message.tool_calls = calls;
    if (response.text) event('delta', { text: response.text });
    event('done', { message, finishReason: calls.length ? 'tool_calls' : 'stop', maxTokens: 16384,
      usage: { promptTokens: 10, completionTokens: 5, estimated: false } });
  } };
  const payload = { task: { ...task }, workspace, model, auth: { server: 'http://127.0.0.1:47615',
    token: 'zqp_test_credential_must_never_escape' }, limits: { maxRounds: 10, timeoutMs: 10000 } };
  return { workspace, payload, api, requests };
}

test('worker payload projection contains only public fields', () => {
  const projected = publicTask({ ...task, canonical_solution: 'secret answer', test: 'hidden assertion', extra: 'other' });
  assert.deepEqual(Object.keys(projected), ['task_id', 'prompt', 'entry_point']);
  assert.equal(JSON.stringify(projected).includes('hidden assertion'), false);
  assert.equal(JSON.stringify(projected).includes('secret answer'), false);
});

test('real file-tool loop appends implementation, retains prompt bytes and records usage', async (t) => {
  const fixtureData = fixture(t, [
    { calls: [{ name: 'read_file', args: { path: 'solution.py' } }] },
    { calls: [{ name: 'write_file', args: { path: 'solution.py', append: true, content: '    return x * 2\n' } }] },
    { text: 'Implementation saved.' },
  ]);
  const result = await runTask(fixtureData.payload, { api: fixtureData.api });
  assert.equal(result.generation_status, 'completed');
  assert.equal(result.completion, '    return x * 2\n');
  assert.equal(fs.readFileSync(path.join(fixtureData.workspace, 'solution.py'), 'utf8'), task.prompt + result.completion);
  assert.equal(result.rounds, 3);
  assert.equal(result.model_requests, 3);
  assert.equal(result.tool_calls, 2);
  assert.deepEqual(result.usage, { prompt_tokens: 30, completion_tokens: 15, estimated: false, missing_usage: 0 });
  assert.ok(fs.existsSync(path.join(fixtureData.workspace, result.session)));
  const offered = fixtureData.requests[0].tools.map((tool) => tool.function.name);
  assert.equal(offered.includes('write_file'), true);
  assert.equal(offered.includes('run_command'), true);
  assert.equal(offered.includes('search_wiki'), false);
  assert.equal(offered.some((name) => name.startsWith('mcp__')), false);
});

test('rewriting the prompt fails protocol even if the agent claims success', async (t) => {
  const data = fixture(t, [
    { calls: [{ name: 'read_file', args: { path: 'solution.py' } }] },
    { calls: [{ name: 'write_file', args: { path: 'solution.py', content: 'def double(x):\n    return x * 2\n' } }] },
    { text: 'Done.' },
  ]);
  const result = await runTask(data.payload, { api: data.api });
  assert.equal(result.generation_status, 'protocol_error');
  assert.equal(result.completion, '');
  assert.match(result.error, /prompt prefix/);
});

test('model mismatch aborts before any proposed write runs', async (t) => {
  const data = fixture(t, [{ calls: [{ name: 'write_file', args: { path: 'leaked.py', content: 'bad' } }] }],
    { ...model, id: 3, modelName: 'corporate-claude' });
  const result = await runTask(data.payload, { api: data.api });
  assert.equal(result.generation_status, 'model_mismatch');
  assert.equal(result.completion, '');
  assert.equal(fs.existsSync(path.join(data.workspace, 'leaked.py')), false);
  assert.equal(result.requests[0].actual_model.id, 3);
});

test('a stream without an actual model start event cannot execute tool calls', async (t) => {
  const data = fixture(t, [
    { calls: [{ name: 'read_file', args: { path: 'solution.py' } }] },
    { calls: [{ name: 'write_file', args: { path: 'solution.py', append: true, content: '    return x * 2\n' } }] },
    { text: 'Done.' },
  ]);
  const stream = data.api.stream;
  data.api.stream = (pathname, body, event, options) => stream(pathname, body,
    (name, details) => { if (name !== 'start') event(name, details); }, options);
  const result = await runTask(data.payload, { api: data.api });
  assert.equal(result.generation_status, 'protocol_error');
  assert.equal(result.completion, '');
  assert.equal(result.tool_calls, 0);
  assert.equal(fs.readFileSync(path.join(data.workspace, 'solution.py'), 'utf8'), task.prompt);
});

test('worker rejects a payload with hidden fields', async (t) => {
  const data = fixture(t, []);
  data.payload.task.test = 'hidden';
  await assert.rejects(runTask(data.payload, { api: data.api }), /public task fields only/);
  assert.equal(data.requests.length, 0);
});

test('a task that uses its last round for a tool call is recorded as round_limit', async (t) => {
  const data = fixture(t, [{ calls: [{ name: 'read_file', args: { path: 'solution.py' } }] }]);
  data.payload.limits.maxRounds = 1;
  const result = await runTask(data.payload, { api: data.api });
  assert.equal(result.generation_status, 'round_limit');
  assert.equal(result.completion, '');
  assert.equal(result.model_requests, 1);
});

test('an unresponsive gateway is aborted by the worker deadline', async (t) => {
  const data = fixture(t, []);
  data.payload.limits.timeoutMs = 100;
  let aborted = false;
  const api = { stream(_pathname, _body, event, { signal }) {
    event('start', { model, contextWindow: 64000, maxTokens: 16384 });
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      aborted = true;
      const error = new Error('deadline');
      error.name = 'AbortError';
      reject(error);
    }, { once: true }));
  } };
  const result = await runTask(data.payload, { api });
  assert.equal(aborted, true);
  assert.equal(result.generation_status, 'timeout');
  assert.equal(result.completion, '');
  assert.equal(result.usage.missing_usage, 1);
});

test('transport pacing separates actual model starts, including fast tool rounds', async (t) => {
  const data = fixture(t, [
    { calls: [{ name: 'read_file', args: { path: 'solution.py' } }] },
    { calls: [{ name: 'write_file', args: { path: 'solution.py', append: true, content: '    return x * 2\n' } }] },
    { text: 'Done.' },
  ]);
  data.payload.limits.minRequestIntervalMs = 80;
  const starts = [];
  const stream = data.api.stream;
  data.api.stream = (...args) => { starts.push(performance.now()); return stream(...args); };
  const result = await runTask(data.payload, { api: data.api });
  assert.equal(result.generation_status, 'completed');
  assert.equal(starts.length, 3);
  for (let index = 1; index < starts.length; index++) {
    assert.ok(starts[index] - starts[index - 1] >= 78,
      `Actual model starts were only ${starts[index] - starts[index - 1]}ms apart`);
  }
  assert.ok(result.transport_wait_ms >= 140);
  assert.ok(result.requests[1].pacing_wait_ms >= 60);
});

test('abort during a transport wait prevents the pending model request', async (t) => {
  const data = fixture(t, [
    { calls: [{ name: 'read_file', args: { path: 'solution.py' } }] },
    { calls: [{ name: 'write_file', args: { path: 'solution.py', append: true, content: '    return x * 2\n' } }] },
    { text: 'Done.' },
  ]);
  data.payload.limits.minRequestIntervalMs = 500;
  data.payload.limits.timeoutMs = 100;
  const result = await runTask(data.payload, { api: data.api });
  assert.equal(result.generation_status, 'timeout');
  assert.equal(data.requests.length, 1);
  assert.equal(result.model_requests, 1);
  assert.equal(result.completion, '');
  assert.ok(result.transport_wait_ms >= 80);
});

test('exact model selection cannot fall back to a corporate default', () => {
  const metadata = { defaultModelId: 3, models: [model,
    { ...model, id: 3, modelName: 'corporate-claude', label: 'DeepSeek-looking label' }] };
  assert.equal(selectDeepSeekModel(metadata, 1).id, 1);
  assert.throws(() => selectDeepSeekModel(metadata, 3), /not an enabled/);
  assert.throws(() => selectDeepSeekModel(metadata, 999), /not an enabled/);
});

test('failed generations contribute an empty completion row and credential output is redacted', () => {
  const sample = sampleFor(task, { generation_status: 'gateway_error', completion: 'would otherwise pass',
    error: 'Gateway failed' });
  assert.equal(sample.completion, '');
  assert.equal(sample.generation_status, 'gateway_error');
  assert.equal(redact('token xyz-secret and Bearer other-secret', 'xyz-secret').includes('secret'), false);
});

test('persistence redacts credentials in metadata without changing legitimate candidate code', () => {
  const completion = '    return "Bearer harmless-example"  # zqp_example_identifier\n';
  const token = 'fixture-authentication-secret';
  const result = sanitizeWorkerResult({ task_id: 'HumanEval/0', generation_status: 'completed', completion,
    terminal_log: `Bearer ${token}`, error: `retry failed for ${token}` }, token);
  assert.equal(result.completion, completion, 'Candidate bytes must match the final file hash');
  assert.equal(result.terminal_log.includes(token), false);
  assert.equal(result.error.includes(token), false);
  const leaked = sanitizeWorkerResult({ generation_status: 'completed', completion: `    return "${token}"\n` }, token);
  assert.equal(leaked.generation_status, 'protocol_error');
  assert.equal(leaked.completion, '');
});

test('limit and concurrency reject empty/unsafe settings, sandbox substitution escapes paths', () => {
  assert.throws(() => parseArgs(['--concurrency', '0']), /Invalid concurrency/);
  assert.throws(() => parseArgs(['--limit', '0']), /Invalid limit/);
  assert.throws(() => parseArgs(['--requests-per-minute', '0']), /Invalid requestsPerMinute/);
  assert.throws(() => parseArgs(['--requests-per-minute', '61']), /Invalid requestsPerMinute/);
  assert.equal(parseArgs([]).concurrency, 2);
  assert.equal(parseArgs([]).requestsPerMinute, 50);
  assert.equal(parseArgs([]).minRequestIntervalMs, 2400);
  assert.equal(renderSandbox('(subpath "{{WORKSPACE}}")', { WORKSPACE: '/tmp/a"b' }), '(subpath "/tmp/a\\"b")');
});

async function exerciseWorkerShutdown(t, ignoreTerm) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-benchmark-shutdown-')));
  const bundledPython = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
  const python = fs.existsSync(bundledPython) ? bundledPython : resolveOnPath('python3');
  assert.ok(python, 'Python must be available for the command-cleanup regression');
  fs.writeFileSync(path.join(directory, 'linger.py'), 'import os, time\nfrom pathlib import Path\n'
    + 'Path("child.pid").write_text(str(os.getpid()))\ntime.sleep(1)\n'
    + 'Path("late-write.txt").write_text("command survived cancellation")\n');
  const localModule = fileURLToPath(new URL('../../zhiqu-cli/src/tools/local.js', import.meta.url));
  fs.writeFileSync(path.join(directory, 'worker.mjs'), `import {LocalTools} from ${JSON.stringify(localModule)};\n`
    + 'const controller = new AbortController();\n'
    + `process.on('SIGTERM', () => ${ignoreTerm ? '{}' : 'controller.abort()'});\n`
    + 'const local = new LocalTools({root: process.cwd()});\n'
    + "const prepared = local.prepareRun({command: 'python3', args: ['linger.py']});\n"
    + 'if (prepared.error) throw new Error(prepared.error);\n'
    + 'await local.commitRun(prepared, {signal: controller.signal});\n');
  const child = spawn(process.execPath, ['worker.mjs'], { cwd: directory, detached: true, stdio: 'ignore',
    env: { PATH: `${path.dirname(python)}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}` } });
  let commandPid = null;
  let closed = false;
  child.once('close', () => { closed = true; });
  t.after(() => {
    for (const pid of [child.pid, commandPid]) if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const ready = path.join(directory, 'child.pid');
  const deadline = performance.now() + 5000;
  while (!fs.existsSync(ready) && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(ready), 'The legitimate detached Python command must start before cancellation');
  commandPid = Number(fs.readFileSync(ready, 'utf8'));
  const stop = createWorkerStopper(child, { graceMs: 100 });
  stop();
  stop(); // Repeated interrupts must share one bounded cleanup.
  await new Promise((resolve) => setTimeout(resolve, 1250));
  assert.equal(fs.existsSync(path.join(directory, 'late-write.txt')), false,
    'A detached command wrote after its benchmark worker was stopped');
  assert.equal(closed, true, 'Worker shutdown must be bounded even if it ignores SIGTERM');
  let state = '';
  try { state = execFileSync('/bin/ps', ['-p', String(commandPid), '-o', 'stat='],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  assert.ok(!state || state.includes('Z'), `Detached command is still executing (${state})`);
}

test('worker SIGTERM aborts LocalTools detached command before a delayed write', async (t) => {
  await exerciseWorkerShutdown(t, false);
});

test('bounded escalation cleans detached command groups when a worker ignores SIGTERM', async (t) => {
  await exerciseWorkerShutdown(t, true);
});

test('the actual macOS profile allows LocalTools to abort a same-sandbox detached command',
  { skip: process.platform !== 'darwin' }, async (t) => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-benchmark-profile-abort-')));
    const runtime = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies');
    const python = path.join(runtime, 'python/bin/python3');
    assert.ok(fs.existsSync(python), 'This sandbox regression needs the configured bundled Python runtime');
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    const profile = renderSandbox(fs.readFileSync(new URL('./macos-agent.sb', import.meta.url), 'utf8'),
      { WORKSPACE: directory, REPO: repo.replace(/\/$/, ''), RUNTIME: runtime,
        SERVER_HOST: '127.0.0.1', SERVER_PORT: '47615' });
    fs.writeFileSync(path.join(directory, 'sandbox.sb'), profile);
    fs.writeFileSync(path.join(directory, 'linger.py'), 'import os, time\nfrom pathlib import Path\n'
      + 'Path("child.pid").write_text(str(os.getpid()))\ntime.sleep(1)\n'
      + 'Path("late-write.txt").write_text("command survived same-sandbox abort")\n');
    const localModule = fileURLToPath(new URL('../../zhiqu-cli/src/tools/local.js', import.meta.url));
    fs.writeFileSync(path.join(directory, 'worker.mjs'), `import fs from 'node:fs';\n`
      + `import {LocalTools} from ${JSON.stringify(localModule)};\n`
      + 'const controller = new AbortController();\nlet ready = false;\n'
      + 'const local = new LocalTools({root: process.cwd()});\n'
      + "const prepared = local.prepareRun({command: 'python3', args: ['linger.py']});\n"
      + 'if (prepared.error) throw new Error(prepared.error);\n'
      + "const poll = setInterval(() => { if (fs.existsSync('child.pid')) { ready = true; clearInterval(poll); controller.abort(); } }, 5);\n"
      + 'const result = await local.commitRun(prepared, {signal: controller.signal});\nclearInterval(poll);\n'
      + "console.log(JSON.stringify({ready, exit_code: result.exitCode, late_write: fs.existsSync('late-write.txt'), summary: result.summary}));\n");
    const child = spawn('/usr/bin/sandbox-exec', ['-f', path.join(directory, 'sandbox.sb'), process.execPath, 'worker.mjs'],
      { cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: `${path.dirname(python)}:/usr/bin:/bin`, TMPDIR: directory } });
    const stop = createWorkerStopper(child, { graceMs: 100 });
    t.after(() => {
      stop();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(stop, 5000);
      child.once('close', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    assert.equal(code, 0, `Sandbox fixture did not initialize: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.ready, true, 'Python must start before the self-abort');
    assert.equal(result.late_write, false, 'The actual profile prevented AbortController from stopping its child');
    assert.notEqual(result.exit_code, 0, 'The aborted command must not complete successfully');
  });

test('hidden official data is refused inside every broad sandbox-readable root', () => {
  const options = { repo: '/repo', runtime: '/runtime' };
  assert.throws(() => assertHiddenDatasetIsPrivate('/repo/tools/benchmarks/data/HumanEval.jsonl.gz', options),
    /sandbox-readable directory/);
  assert.throws(() => assertHiddenDatasetIsPrivate('/runtime/data/HumanEval.jsonl.gz', options),
    /sandbox-readable directory/);
  assert.throws(() => assertHiddenDatasetIsPrivate('/opt/homebrew/data/HumanEval.jsonl.gz', options),
    /sandbox-readable directory/);
  assert.throws(() => assertHiddenDatasetIsPrivate('/private/tmp/data/HumanEval.jsonl.gz', { ...options, runtime: '/' }),
    /sandbox-readable directory/);
  assert.doesNotThrow(() => assertHiddenDatasetIsPrivate('/private/tmp/assets/HumanEval.jsonl.gz', options));
  assert.doesNotThrow(() => assertHiddenDatasetIsPrivate('/runtime-sibling/HumanEval.jsonl.gz', options));
});

test('unsupported remote gateways fail before a benchmark can launch', () => {
  assert.doesNotThrow(() => assertLoopbackServer('http://127.0.0.1:47615'));
  assert.doesNotThrow(() => assertLoopbackServer('http://localhost:47615'));
  assert.doesNotThrow(() => assertLoopbackServer('http://[::1]:47615'));
  assert.throws(() => assertLoopbackServer('https://gateway.example.com'), /loopback/);
  assert.throws(() => assertLoopbackServer('http://127.0.0.1.example.com:47615'), /loopback/);
});
