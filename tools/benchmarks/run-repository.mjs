#!/usr/bin/env node
// Controller entry point. No candidate code or hidden tests execute in this process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Api } from '../../zhiqu-cli/src/api.js';
import { DEFAULT_SERVER, loadUserConfig } from '../../zhiqu-cli/src/config.js';
import { selectDeepSeekModel, assertLoopbackServer } from './run-humaneval.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_CONFIG = path.join(REPO, 'docs/benchmarks/repository-pilot-20261014/run-config.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const HELP = `Prepare the frozen Zhiqu CLI SWE-bench Verified pilot without model calls.

  node tools/benchmarks/run-repository.mjs --preflight
  node tools/benchmarks/run-repository.mjs --prepare --python /absolute/python \\
    --parquet /outside/generation/verified.parquet --pyarrow-path /outside/parser

Options:
  --preflight         Check fixed sources, Docker and existing gateway metadata; no model calls
  --prepare           Write controller-only dataset/public tasks and fetch fixed base archives
  --config PATH       Run configuration (default repository-pilot-20261014/run-config.json)
  --control-dir PATH  Private control root; default /private/tmp/zhiqu-repository-assets-20261014
  --python PATH       Direct Python executable for preparation
  --parquet PATH      Pinned official dataset, outside generation workspaces
  --pyarrow-path PATH Isolated pinned PyArrow 20.0.0 installation
  --help              Print help

This entry point does not start paid episodes. Docker controls, task-image preparation,
isolation probes and the generation/grade orchestrator must be verified before paid running.
Existing gateway credentials are only read; never saved in the output.`;

export function parseArgs(argv) {
  const opts = { config: DEFAULT_CONFIG, controlDir: '/private/tmp/zhiqu-repository-assets-20261014' };
  const values = { '--config': 'config', '--control-dir': 'controlDir', '--python': 'python',
    '--parquet': 'parquet', '--pyarrow-path': 'pyarrowPath' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
    else if (argv[i] === '--preflight' || argv[i] === '--prepare') {
      if (opts.action) throw new Error('Choose one action');
      opts.action = argv[i].slice(2);
    } else if (values[argv[i]]) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} requires a value`);
      opts[values[argv[i]]] = path.resolve(argv[++i]);
    } else throw new Error(`Unknown option: ${argv[i]}`);
  }
  if (!opts.help && !opts.action) throw new Error('Choose --preflight or --prepare');
  return opts;
}

export function readRunConfig(filename) {
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (config.dataset?.revision !== 'c104f840cc67f8b6eec6f759ebc8b2693d585d4a'
      || config.dataset?.size !== 10 || config.model?.id !== 6
      || config.model?.model_name !== 'deepseek-v4-pro') throw new Error('Wrong frozen dataset/model');
  const budget = config.budget;
  if (!budget || !Number.isFinite(budget.limit_rmb) || budget.limit_rmb <= 0 || budget.limit_rmb > 50) {
    throw new Error('This authorized pilot requires a CNY budget in (0, 50]');
  }
  for (const key of ['input_token_limit', 'output_token_limit', 'per_episode_input_token_limit', 'per_episode_output_token_limit']) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] <= 0) throw new Error(`Missing positive ${key}`);
  }
  if (config.harness?.commit !== '3f01bd622c0a22c00406139f69a234ef08225f22') {
    throw new Error('The pilot requires the compatible fixed official v3.0.17 harness');
  }
  const selectionPath = path.resolve(path.dirname(filename), config.dataset.selection_file);
  const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
  if (selection.revision !== config.dataset.revision || selection.tasks?.length !== 10
      || new Set(selection.tasks.map(t => t.instance_id)).size !== 10) throw new Error('Invalid frozen selection');
  for (const [file, expected] of Object.entries(config.agent?.file_sha256 || {})) {
    if (sha(fs.readFileSync(path.join(REPO, file))) !== expected) throw new Error(`Shipped agent changed: ${file}`);
  }
  if (Object.keys(config.agent?.file_sha256 || {}).length !== 4) throw new Error('Missing shipped source fingerprints');
  const currentTree = execFileSync('git', ['rev-parse', 'HEAD:zhiqu-cli'], { cwd: REPO, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'zhiqu-cli'], { cwd: REPO, encoding: 'utf8' }).trim();
  if (currentTree !== config.agent.cli_git_tree || dirty) throw new Error('Frozen CLI tree changed or has local modifications');
  return { config, selection, selectionPath, configSha256: sha(fs.readFileSync(filename)) };
}

export function inspectDocker(run = execFileSync) {
  try {
    const metadata = JSON.parse(run('docker', ['info', '--format', '{{json .}}'], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    if (!metadata.ServerVersion || !metadata.Architecture || !(metadata.MemTotal > 0) || !(metadata.NCPU > 0)) {
      throw new Error('Docker returned incomplete server metadata');
    }
    return { ready: true, version: metadata.ServerVersion, architecture: metadata.Architecture,
      memory_bytes: metadata.MemTotal, cpus: metadata.NCPU,
      experimental_architecture: !['x86_64', 'amd64'].includes(metadata.Architecture) };
  } catch (error) {
    return { ready: false, reason: error.code === 'ENOENT' ? 'docker_not_installed' : 'docker_unavailable',
      error_code: error.code || null };
  }
}

export async function preflight(opts, { runDocker = execFileSync, api: suppliedApi } = {}) {
  const { config, selection, configSha256 } = readRunConfig(opts.config);
  const docker = inspectDocker(runDocker);
  let gateway;
  try {
    const user = loadUserConfig();
    const server = process.env.ZHIQU_SERVER || user.server || DEFAULT_SERVER;
    const token = process.env.ZHIQU_TOKEN || user.token;
    assertLoopbackServer(server);
    if (!token && !suppliedApi) throw new Error('missing_existing_login');
    const api = suppliedApi || new Api({ server, token });
    await api.get('/api/harness/me', { retry: false, timeoutMs: 5000 });
    const metadata = await api.get('/api/harness/models', { retry: false, timeoutMs: 5000 });
    const model = selectDeepSeekModel(metadata, config.model.id);
    if (model.modelName !== config.model.model_name || model.effectiveContextWindow !== config.model.expected_context_window_tokens) {
      throw new Error('model_metadata_mismatch');
    }
    gateway = { ready: true, model };
  } catch (error) {
    // No raw transport message: it may embed internal addresses or credentials.
    gateway = { ready: false, reason: error.auth ? 'existing_login_invalid' : 'gateway_or_model_metadata_unavailable' };
  }
  const blockers = [];
  if (!docker.ready) blockers.push(docker.reason);
  if (!gateway.ready) blockers.push(gateway.reason);
  if (!config.runtime.generation_image_digests || !config.runtime.grader_image_digests) blockers.push('task_images_not_frozen');
  if (!Object.values(config.controls || {}).every(value => value === true)) blockers.push('docker_controls_not_verified');
  if (!config.agent.worker_sha256 || !config.agent.broker_sha256 || !config.agent.collector_sha256) blockers.push('adapters_not_frozen');
  if (!config.execution_ready) blockers.push('generation_orchestrator_not_approved_by_controls');
  return { mode: 'preflight', ready: blockers.length === 0, model_calls: 0, charged_rmb: 0,
    config_sha256: configSha256, dataset_revision: selection.revision, tasks: selection.tasks.map(t => t.instance_id),
    budget_rmb: config.budget.limit_rmb, docker, gateway, blockers };
}

function runChild(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let out = '', errors = '';
    child.stdout.on('data', bytes => { if (out.length < 1_000_000) out += bytes; });
    child.stderr.on('data', bytes => { if (errors.length < 50_000) errors += bytes; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(`Preparation child failed (${code}): ${errors.slice(-2000)}`)));
  });
}

export async function prepare(opts) {
  const { config, selection, selectionPath, configSha256 } = readRunConfig(opts.config);
  if (!opts.python || !opts.parquet || !opts.pyarrowPath) throw new Error('--prepare needs --python, --parquet and --pyarrow-path');
  const control = path.resolve(opts.controlDir);
  // The control root contains hidden fields. Never put it inside the repo or a model-readable workspace.
  const relative = path.relative(REPO, control);
  if (!relative.startsWith('..') || path.dirname(control) === control) throw new Error('Use an external private control directory');
  fs.mkdirSync(control, { recursive: true, mode: 0o700 });
  const script = path.join(REPO, 'tools/benchmarks/prepare-repository-eval.py');
  await runChild(opts.python, [script, 'prepare-data', '--control-dir', control, '--parquet', opts.parquet,
    '--pyarrow-path', opts.pyarrowPath, '--selection', selectionPath, '--protocol', opts.config]);
  for (const task of selection.tasks) {
    const summary = await runChild(opts.python, [script, 'fetch-base', '--control-dir', control, '--instance-id', task.instance_id]);
    process.stderr.write(`Prepared ${task.instance_id}\n`);
    // Child outputs metadata only. Keep source verification in the private control directory.
    if (summary) fs.writeFileSync(path.join(control, 'tasks', task.instance_id, 'prepare-output.json'), `${summary}\n`, { mode: 0o600 });
  }
  const result = { mode: 'prepared_data_and_base', model_calls: 0, charged_rmb: 0,
    config_sha256: configSha256, dataset_revision: config.dataset.revision, prepared_tasks: selection.tasks.length,
    budget_rmb: config.budget.limit_rmb, docker_ready: inspectDocker().ready,
    actual_generation_started: false, official_controls_verified: false };
  fs.writeFileSync(path.join(control, 'preparation-status.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return; }
  const result = opts.action === 'preflight' ? await preflight(opts) : await prepare(opts);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (opts.action === 'preflight' && !result.ready) process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Repository evaluation preparation: ${error.message}\n`); process.exitCode = 1; });
}
