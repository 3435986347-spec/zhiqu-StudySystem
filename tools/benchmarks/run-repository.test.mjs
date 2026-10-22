import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const modulePath = process.env.ZHIQU_REPOSITORY_RUNNER_TEST_MODULE || './run-repository.mjs';
const { parseArgs, readRunConfig, inspectDocker, preflight } = await import(modulePath);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const actual = path.join(repo, 'docs/benchmarks/repository-pilot-20261014/run-config.json');
const configCopy = change => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiqu-repo-preflight-'));
  const config = JSON.parse(fs.readFileSync(actual, 'utf8'));
  config.dataset.selection_file = path.resolve(path.dirname(actual), config.dataset.selection_file);
  change(config);
  const file = path.join(folder, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return { file, close: () => fs.rmSync(folder, { recursive: true, force: true }) };
};
const fakeApi = { async get(endpoint) {
  if (endpoint.endsWith('/me')) return { id: 1 };
  assert.equal(endpoint, '/api/harness/models');
  return { models: [{ id: 6, label: 'DeepSeek', modelName: 'deepseek-v4-pro', toolCalling: true,
    contextWindowTokens: 1_000_000, effectiveContextWindow: 1_000_000 }] };
} };
const missingDocker = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };

test('controller requires one explicit action and refuses paid-running flags', () => {
  assert.equal(parseArgs(['--preflight']).action, 'preflight');
  assert.throws(() => parseArgs(['--preflight', '--prepare']), /one action/);
  assert.throws(() => parseArgs(['--run']), /Unknown option/);
});
test('authorization cannot exceed CNY50', () => {
  const temp = configCopy(config => { config.budget.limit_rmb = 51; });
  try { assert.throws(() => readRunConfig(temp.file), /CNY budget/); } finally { temp.close(); }
});
test('an empty token ceiling cannot open the budget', () => {
  const temp = configCopy(config => { config.budget.output_token_limit = null; });
  try { assert.throws(() => readRunConfig(temp.file), /positive output_token_limit/); } finally { temp.close(); }
});
test('mismatched task revision is refused before gateway access', () => {
  const temp = configCopy(config => { config.dataset.revision = 'latest'; });
  try { assert.throws(() => readRunConfig(temp.file), /frozen dataset/); } finally { temp.close(); }
});
test('missing Docker is an explicit not-ready result even with a valid gateway', async () => {
  const result = await preflight({ config: actual }, { runDocker: missingDocker, api: fakeApi });
  assert.equal(result.ready, false);
  assert.equal(result.gateway.ready, true);
  assert.equal(result.tasks.length, 10);
  assert.equal(result.model_calls, 0);
  assert.equal(result.charged_rmb, 0);
  assert.ok(result.blockers.includes('docker_not_installed'));
  assert.ok(result.blockers.includes('docker_controls_not_verified'));
});
test('Docker version alone does not prove a usable server', () => {
  assert.equal(inspectDocker(() => '{}').ready, false);
  const info = inspectDocker(() => JSON.stringify({ ServerVersion: 'fixture', Architecture: 'aarch64', MemTotal: 16e9, NCPU: 8 }));
  assert.equal(info.ready, true);
  assert.equal(info.experimental_architecture, true);
});
test('gateway failures do not print internal transport secrets', async () => {
  const result = await preflight({ config: actual }, { runDocker: missingDocker,
    api: { async get() { throw new Error('fixture-secret-gateway-address'); } } });
  assert.equal(result.gateway.ready, false);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
});
