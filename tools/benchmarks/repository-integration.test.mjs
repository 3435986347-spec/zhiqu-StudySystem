// A local fake-model integration control, not a SWE-bench run or paid request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RepositoryBroker } from './repository-broker.mjs';
import { runRepositoryTask } from './repository-worker.mjs';

test('real worker Api/SSE passes through budget broker to edit and execute only public fixture code', async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-repository-integration-')));
  const workspace = path.join(folder, 'workspace');
  fs.mkdirSync(path.join(workspace, 'base_repo'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'base_repo/math.cjs'), 'exports.total = values => values[0];\n');
  const actions = [
    ['read_file', { path: 'math.cjs' }],
    ['write_file', { path: 'math.cjs', old_string: 'values[0]', new_string: 'values.reduce((a, b) => a + b, 0)' }],
    ['write_file', { path: 'check.cjs', content: "const assert = require('node:assert/strict'); const {total} = require('./math.cjs'); assert.equal(total([1,2,3]),6); assert.equal(total([]),0); console.log('PUBLIC_CHECK_PASSED');\n" }],
    ['run_command', { command: 'node', args: ['check.cjs'] }],
  ];
  let calls = 0;
  const model = { id: 6, modelName: 'deepseek-v4-pro', label: 'offline fixture', toolCalling: true,
    contextWindowTokens: 1_000_000, effectiveContextWindow: 1_000_000 };
  const broker = new RepositoryBroker({ ledgerPath: path.join(folder, 'private/ledger.jsonl'),
    api: { async stream(endpoint, body, event) {
      assert.equal(endpoint, '/api/harness/model/stream');
      event('start', { model, contextWindow: 1_000_000, maxTokens: body.maxTokens });
      const action = actions[calls++];
      const message = { role: 'assistant', content: action ? '' : 'Fixed and checked.' };
      if (action) message.tool_calls = [{ id: `fixture-${calls}`, type: 'function',
        function: { name: action[0], arguments: JSON.stringify(action[1]) } }];
      event('done', { message, finishReason: action ? 'tool_calls' : 'stop', maxTokens: body.maxTokens,
        usage: { promptTokens: 10, completionTokens: 5, estimated: false } });
    } } });
  try {
    const { server } = await broker.listen();
    const { capability } = broker.registerEpisode({ episodeId: 'offline-fixture' });
    const result = await runRepositoryTask({ task: { repo: 'fixture/repo', instance_id: 'fixture__repo-1',
      base_commit: 'a'.repeat(40), problem_statement: 'Sum all array numbers including an empty input.' },
      workspace, broker: { server, capability }, model,
      limits: { maxRounds: 10, timeoutMs: 20_000, execTimeoutMs: 5000, minRequestIntervalMs: 1, maxRequests: 10 } });
    assert.equal(result.generation_status, 'completed');
    assert.equal(result.model_requests, calls);
    assert.equal(result.command_results[0].exit_code, 0);
    assert.match(fs.readFileSync(path.join(workspace, 'base_repo/math.cjs'), 'utf8'), /reduce/);
    const summary = broker.snapshot();
    assert.equal(summary.acceptedRequests, calls);
    assert.equal(calls, 5, '4 个动作 + 交活');
    assert.equal(summary.inputUsedOrReserved, 50);
    assert.equal(summary.outputUsedOrReserved, 25);
    assert.equal(summary.chargedOrReservedMicroCny, 1125);
    assert.equal(summary.halted, false);
    const ledger = fs.readFileSync(path.join(folder, 'private/ledger.jsonl'), 'utf8');
    assert.equal(ledger.includes(capability), false);
    assert.equal(broker.revokeEpisode('offline-fixture'), true);
    assert.equal(broker.snapshot().episodes[0].active, false);
  } finally { await broker.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});
