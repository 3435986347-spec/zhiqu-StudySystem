import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_COMMANDS } from '../../zhiqu-cli/src/tools/execrules.js';
import { runRepositoryTask, publicRepositoryTask, validateRepositoryPayload, REPOSITORY_LIMITS }
  from './repository-worker.mjs';

const MODEL = { id: 6, modelName: 'deepseek-v4-pro', label: 'DeepSeek fixture', providerType: 'OPENAI_COMPATIBLE',
  toolCalling: true, contextWindowTokens: 1_000_000, effectiveContextWindow: 1_000_000 };
const TASK = { repo: 'demo/demo', instance_id: 'demo__demo-1', base_commit: 'a'.repeat(40),
  problem_statement: 'The total function must sum every number in the input array, including empty arrays.' };
const CAPABILITY = 'episode_capability_fixture_only';

function fixture(t, replies = [], { actual = MODEL, context = 1_000_000, omitStart = false } = {}) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-repository-worker-')));
  const base = path.join(workspace, 'base_repo');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'math.cjs'), 'exports.total = function total(values) {\n  return values[0];\n};\n');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const requests = [];
  let index = 0;
  const api = {
    async get() { throw new Error('Worker must not query broker management routes'); },
    async post() { throw new Error('Worker must not call office tools or archive routes'); },
    async stream(pathname, body, event) {
      requests.push({ pathname, body });
      if (!omitStart) event('start', { model: actual, contextWindow: context, maxTokens: body.maxTokens });
      const response = replies[index++] || { text: 'Finished.' };
      if (response.text) event('delta', { text: response.text });
      const calls = (response.calls || []).map((call, i) => ({ id: `c-${index}-${i}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) } }));
      const message = { role: 'assistant', content: response.text || '' };
      if (calls.length) message.tool_calls = calls;
      event('done', { message, finishReason: calls.length ? 'tool_calls' : 'stop', maxTokens: body.maxTokens,
        usage: { promptTokens: 10, completionTokens: 5, estimated: false } });
    },
  };
  const payload = { schema_version: 1, task: { ...TASK }, workspace,
    broker: { server: 'http://10.77.0.2:18081', capability: CAPABILITY }, model: { ...MODEL },
    limits: { maxRounds: 10, timeoutMs: 10_000, execTimeoutMs: 5000, minRequestIntervalMs: 1, maxRequests: 200 },
    source: { agent_commit: 'b'.repeat(40), cli_git_tree: 'c'.repeat(40) } };
  return { workspace, base, payload, api, requests };
}

test('repository task projection excludes patches, hints and grading test lists', () => {
  const projected = publicRepositoryTask({ ...TASK, patch: 'hidden gold', test_patch: 'hidden tests',
    hints_text: 'hidden hint', FAIL_TO_PASS: ['hidden test'] });
  assert.deepEqual(Object.keys(projected), ['repo', 'instance_id', 'base_commit', 'problem_statement']);
  assert.equal(JSON.stringify(projected).includes('hidden'), false);
});

test('real file tools edit repository bytes and execute a public Node check with shipped commands', async (t) => {
  const data = fixture(t, [
    { calls: [{ name: 'read_file', args: { path: 'math.cjs' } }] },
    { calls: [{ name: 'write_file', args: { path: 'math.cjs', old_string: 'return values[0];',
      new_string: 'return values.reduce((sum, value) => sum + value, 0); // Bearer harmless-example' } }] },
    { calls: [{ name: 'write_file', args: { path: 'check.cjs', content:
      "const assert = require('node:assert/strict');\nconst {total} = require('./math.cjs');\n"
        + "assert.equal(total([1, 2, 3]), 6);\nassert.equal(total([]), 0);\nconsole.log('PUBLIC_CHECK_PASSED');\n" } }] },
    { calls: [{ name: 'run_command', args: { command: 'node', args: ['check.cjs'] } }] },
    { text: 'Updated and checked.' },
  ]);
  fs.writeFileSync(path.join(data.base, 'ZHIQU.md'), 'PUBLIC_REPOSITORY_RULE: keep the edit focused.\n');
  const result = await runRepositoryTask(data.payload, { api: data.api });
  assert.equal(result.generation_status, 'completed');
  assert.equal(result.model_requests, 5);
  assert.equal(result.rounds, 5);
  assert.equal(result.tool_calls, 4);
  assert.equal(result.tool_results, 4);
  assert.equal(result.command_results.length, 1);
  assert.equal(result.command_results[0].exit_code, 0);
  assert.equal(result.command_results[0].refused, false);
  assert.ok(fs.readFileSync(path.join(data.base, 'math.cjs'), 'utf8').includes('Bearer harmless-example'));
  const events = fs.readFileSync(path.join(data.workspace, result.session), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((event) => event.type === 'message' && event.message.role === 'tool'
    && event.message.content.startsWith('$ node check.cjs') && event.message.content.includes('PUBLIC_CHECK_PASSED')
    && event.message.content.includes('退出码 0')));
  assert.equal(result.usage.prompt_tokens, 50);
  assert.equal(result.usage.completion_tokens, 25);
  assert.equal(result.usage.estimated, false);
  assert.deepEqual(result.public_instruction_files, ['ZHIQU.md']);
  const system = data.requests[0].body.messages[0].content;
  assert.ok(system.includes('PUBLIC_REPOSITORY_RULE'));
  assert.ok(system.includes(`run_command 能跑的命令：${DEFAULT_COMMANDS.join('、')}`));
  const tools = data.requests[0].body.tools.map((tool) => tool.function.name);
  assert.deepEqual(tools, ['list_files', 'read_file', 'search', 'write_file', 'delete_file', 'run_command', 'update_todos']);
  assert.equal(data.requests[0].body.maxTokens, 16_384);
  assert.equal(JSON.stringify(result).includes(CAPABILITY), false);
  assert.equal(result.diagnostics_trusted, false);
});

test('hidden fields and real gateway credentials are rejected before model requests', async (t) => {
  const data = fixture(t);
  data.payload.task.test_patch = 'hidden';
  await assert.rejects(runRepositoryTask(data.payload, { api: data.api }), /unsupported fields/);
  delete data.payload.task.test_patch;
  data.payload.broker.capability = 'zqp_fake_real_gateway_pat';
  await assert.rejects(runRepositoryTask(data.payload, { api: data.api }), /episode capability/);
  assert.equal(data.requests.length, 0);
});

test('the generation repository must be exported source without Git history', (t) => {
  const data = fixture(t);
  fs.mkdirSync(path.join(data.base, '.git'));
  assert.throws(() => validateRepositoryPayload(data.payload), /Git history/);
});

test('a missing model start event refuses all tool calls', async (t) => {
  const data = fixture(t, [{ calls: [{ name: 'write_file', args: { path: 'unexpected.txt', content: 'bad' } }] }],
    { omitStart: true });
  const result = await runRepositoryTask(data.payload, { api: data.api });
  assert.equal(result.generation_status, 'protocol_error');
  assert.equal(result.tool_calls, 0);
  assert.equal(fs.existsSync(path.join(data.base, 'unexpected.txt')), false);
});

test('a different actual model is refused before editing the repository', async (t) => {
  const data = fixture(t, [{ calls: [{ name: 'write_file', args: { path: 'unexpected.txt', content: 'bad' } }] }],
    { actual: { ...MODEL, id: 3, modelName: 'corporate-claude' } });
  const result = await runRepositoryTask(data.payload, { api: data.api });
  assert.equal(result.generation_status, 'model_mismatch');
  assert.equal(result.tool_calls, 0);
  assert.equal(fs.existsSync(path.join(data.base, 'unexpected.txt')), false);
});

test('only the two approved DeepSeek IDs pass validation; any other ID is refused before a request', async (t) => {
  for (const id of [6, 1]) {
    const data = fixture(t, [{ text: 'Finished.' }]);
    assert.doesNotThrow(() => validateRepositoryPayload({ ...data.payload, model: { ...data.payload.model, id } }), String(id));
  }
  for (const id of [2, 3, 0, '6']) {
    const data = fixture(t, [{ text: 'Finished.' }]);
    assert.throws(() => validateRepositoryPayload({ ...data.payload, model: { ...data.payload.model, id } }), /ID 6 or 1/, String(id));
  }
});

test('a different actual context window is refused even with the correct model ID', async (t) => {
  const data = fixture(t, [{ text: 'Finished.' }], { context: 64_000 });
  const result = await runRepositoryTask(data.payload, { api: data.api });
  assert.equal(result.generation_status, 'model_mismatch');
  assert.equal(result.requests[0].context_window, 64_000);
});

test('the deadline aborts a stalled model stream', async (t) => {
  const data = fixture(t);
  data.payload.limits.timeoutMs = 100;
  let aborted = false;
  const api = { stream(_pathname, _body, event, { signal }) {
    event('start', { model: MODEL, contextWindow: 1_000_000, maxTokens: 16_384 });
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      aborted = true;
      const error = new Error('deadline');
      error.name = 'AbortError';
      reject(error);
    }, { once: true }));
  } };
  const result = await runRepositoryTask(data.payload, { api });
  assert.equal(aborted, true);
  assert.equal(result.generation_status, 'timeout');
  assert.equal(result.usage.missing_usage, 1);
});

test('last-round tool work is round_limit rather than an unverified completed episode', async (t) => {
  const data = fixture(t, [{ calls: [{ name: 'read_file', args: { path: 'math.cjs' } }] }]);
  data.payload.limits.maxRounds = 1;
  const result = await runRepositoryTask(data.payload, { api: data.api });
  assert.equal(result.generation_status, 'round_limit');
  assert.equal(result.model_requests, 1);
});

test('the worker request ceiling stops the next call before the broker sees it', async (t) => {
  const data = fixture(t, [{ calls: [{ name: 'read_file', args: { path: 'math.cjs' } }] }]);
  data.payload.limits.maxRequests = 1;
  const result = await runRepositoryTask(data.payload, { api: data.api });
  assert.equal(result.generation_status, 'request_limit');
  assert.equal(result.model_requests, 1);
  assert.equal(data.requests.length, 1);
});

test('production command guards still refuse git without executing it', async (t) => {
  const data = fixture(t, [{ calls: [{ name: 'run_command', args: { command: 'git', args: ['status'] } }] },
    { text: 'The command is unavailable.' }]);
  const result = await runRepositoryTask(data.payload, { api: data.api });
  assert.equal(result.command_results[0].refused, true);
  assert.equal(result.command_results[0].exit_code, null);
  const transcript = fs.readFileSync(path.join(data.workspace, result.session), 'utf8');
  assert.ok(transcript.includes('命令不在允许清单里：git'));
});

test('normal episode defaults match the frozen repository design without expanding commands', (t) => {
  const data = fixture(t);
  delete data.payload.limits;
  assert.deepEqual(validateRepositoryPayload(data.payload).limits, REPOSITORY_LIMITS);
  data.payload.limits = { allowedCommands: ['git', 'bash'] };
  assert.throws(() => validateRepositoryPayload(data.payload), /unsupported fields/);
});

test('capability values echoed in diagnostic labels and answers are never returned', async (t) => {
  const data = fixture(t, [{ text: `Finished: ${CAPABILITY}` }], { actual: { ...MODEL, label: CAPABILITY } });
  data.payload.model.label = CAPABILITY;
  const result = await runRepositoryTask(data.payload, { api: data.api });
  assert.equal(result.generation_status, 'completed');
  assert.equal(JSON.stringify(result).includes(CAPABILITY), false);
  assert.ok(result.final_answer.includes('[REDACTED]'));
});
