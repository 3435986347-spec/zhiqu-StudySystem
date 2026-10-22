#!/usr/bin/env node
// Generation only. The separate scorer is the sole process that executes hidden tests.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Api } from '../../zhiqu-cli/src/api.js';
import { DEFAULT_SERVER, loadUserConfig } from '../../zhiqu-cli/src/config.js';
import { BUILTIN_SYSTEM_PROMPT } from '../../zhiqu-cli/src/prompt.js';
import { publicTask, redact, sha256, signalAwareSleep } from './agent-worker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const WORKER = path.join(HERE, 'agent-worker.mjs');
const STATUS = new Set(['completed', 'timeout', 'model_mismatch', 'gateway_error', 'protocol_error',
  'round_limit', 'worker_error', 'interrupted', 'not_run']);
const HELP = `Run the shipped zhiqu agent on the official HumanEval prompts, with hidden tests withheld.

  node tools/benchmarks/run-humaneval.mjs --preflight [--model-id 1]
  node tools/benchmarks/run-humaneval.mjs --dataset /outside/workspaces/HumanEval.jsonl.gz --dry-run
  node tools/benchmarks/run-humaneval.mjs --dataset /outside/workspaces/HumanEval.jsonl.gz --model-id 1

Options:
  --dataset PATH          Official JSONL or gzip dataset (164 tasks by default)
  --output PATH           Output directory; default is a fresh /private/tmp directory
  --server URL            Existing authenticated zhiqu gateway; no auto-start or login changes
  --model-id ID           Exact configured DeepSeek model ID; never falls back
  --concurrency N         Concurrent isolated episodes (default 2)
  --max-rounds N          Agent tool rounds per episode (default 20)
  --timeout-seconds N     Episode timeout (default 300)
  --requests-per-minute N Aggregate model transport rate (default 50; 1..60)
  --limit N               First N tasks for protocol smoke testing, clearly recorded as a subset
  --sandbox-profile PATH  macOS sandbox-exec template (default tools/benchmarks/macos-agent.sb)
  --runtime-root PATH     Runtime read-only root (default inferred from node executable)
  --preflight             Check auth and DeepSeek metadata; no model calls
  --dry-run               Validate dataset and protocol locally; no network or model calls
  --help                  Show this help

Credentials are read from ZHIQU_TOKEN or existing ~/.zhiqu/config.json and sent to workers on stdin.
Completed episode artifacts are resumed only when the exact run fingerprint matches.
The scorer should read samples.jsonl and the external official dataset after generation completes.`;

export function parseArgs(argv) {
  const flags = { concurrency: 2, maxRounds: 20, timeoutSeconds: 300, requestsPerMinute: 50,
    sandboxProfile: path.join(HERE, 'macos-agent.sb'),
    runtimeRoot: path.resolve(path.dirname(process.execPath), '../..') };
  const values = { '--dataset': 'dataset', '--output': 'output', '--server': 'server',
    '--model-id': 'modelId', '--concurrency': 'concurrency', '--max-rounds': 'maxRounds',
    '--timeout-seconds': 'timeoutSeconds', '--limit': 'limit', '--sandbox-profile': 'sandboxProfile',
    '--runtime-root': 'runtimeRoot', '--requests-per-minute': 'requestsPerMinute' };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--preflight') flags.preflight = true;
    else if (name === '--dry-run') flags.dryRun = true;
    else if (name === '--help' || name === '-h') flags.help = true;
    else if (values[name]) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${name} requires a value`);
      flags[values[name]] = argv[++i];
    } else throw new Error(`Unknown option: ${name}`);
  }
  for (const [key, minimum, maximum] of [['concurrency', 1, 8], ['maxRounds', 1, 100],
    ['timeoutSeconds', 1, 3600], ['requestsPerMinute', 1, 60], ['limit', 1, 164],
    ['modelId', 1, Number.MAX_SAFE_INTEGER]]) {
    if (flags[key] == null) continue;
    flags[key] = Number(flags[key]);
    if (!Number.isSafeInteger(flags[key]) || flags[key] < minimum || flags[key] > maximum) {
      throw new Error(`Invalid ${key}: expected integer ${minimum}..${maximum}`);
    }
  }
  if (flags.preflight && flags.dryRun) throw new Error('Choose --preflight or --dry-run');
  flags.minRequestIntervalMs = Math.ceil(flags.concurrency * 60_000 / flags.requestsPerMinute);
  return flags;
}

export function readDataset(filename, limit) {
  const bytes = fs.readFileSync(filename);
  const decoded = filename.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes;
  const rows = decoded.toString('utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  if (rows.length !== 164) throw new Error(`Expected the complete official 164-task dataset, received ${rows.length}`);
  const seen = new Set();
  for (const row of rows) {
    publicTask(row);
    if (!/^HumanEval\/(?:0|[1-9]\d*)$/.test(row.task_id) || seen.has(row.task_id)) throw new Error('Invalid or duplicate task_id');
    if (typeof row.test !== 'string' || typeof row.canonical_solution !== 'string') {
      throw new Error(`Official hidden fields are missing for ${row.task_id}`);
    }
    seen.add(row.task_id);
  }
  for (let id = 0; id < 164; id++) if (!seen.has(`HumanEval/${id}`)) throw new Error(`Missing HumanEval/${id}`);
  rows.sort((a, b) => Number(a.task_id.split('/')[1]) - Number(b.task_id.split('/')[1]));
  // Drop hidden fields here; nothing downstream receives the original rows.
  return { tasks: rows.slice(0, limit ?? 164).map(publicTask), sha256: sha256(bytes),
    uncompressed_sha256: sha256(decoded), official_count: rows.length };
}

export function selectDeepSeekModel(metadata, requestedId) {
  if (!metadata || !Array.isArray(metadata.models)) throw new Error('Gateway did not return a model list');
  const candidates = metadata.models.filter((model) => /deepseek/i.test(model.modelName || '') && model.toolCalling);
  const model = requestedId != null ? candidates.find((item) => String(item.id) === String(requestedId))
    : candidates.find((item) => String(item.id) === String(metadata.defaultModelId))
      || candidates.find((item) => item.modelName === 'deepseek-chat') || (candidates.length === 1 ? candidates[0] : null);
  if (!model) throw new Error(requestedId != null
    ? `Model ID ${requestedId} is not an enabled tool-calling DeepSeek model`
    : candidates.length ? 'Several DeepSeek models are enabled; choose an exact --model-id'
      : 'No enabled tool-calling DeepSeek model is configured');
  if (!Number.isSafeInteger(model.id)) throw new Error('Gateway model ID is not a safe integer');
  return { id: model.id, label: model.label, modelName: model.modelName, providerType: model.providerType,
    toolCalling: model.toolCalling, contextWindowTokens: model.contextWindowTokens ?? null,
    effectiveContextWindow: model.effectiveContextWindow || 64_000 };
}

function credentials(flags) {
  const config = loadUserConfig(); // Read-only; no systemContent or login call.
  const server = flags.server || process.env.ZHIQU_SERVER || config.server || DEFAULT_SERVER;
  const token = process.env.ZHIQU_TOKEN || config.token;
  if (!token) throw new Error('No existing zhiqu login; run zhiqu login first');
  const url = new URL(server);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid gateway URL');
  assertLoopbackServer(server);
  return { server: server.replace(/\/+$/, ''), token };
}

export function assertLoopbackServer(server) {
  const hostname = new URL(server).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    throw new Error('This macOS runner supports a loopback zhiqu gateway only (localhost, 127.0.0.1 or ::1)');
  }
}

function sourceFingerprint() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && file.endsWith('.js')) files.push(file);
    }
  }
  walk(path.join(REPO, 'zhiqu-cli/src'));
  files.push(path.join(REPO, 'zhiqu-cli/package.json'));
  const hash = sha256(files.sort().map((file) => `${path.relative(REPO, file)}\0${sha256(fs.readFileSync(file))}\n`).join(''));
  let commit = 'unknown';
  let dirty = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--', 'zhiqu-cli', 'zhiqu-backend'],
      { cwd: REPO, encoding: 'utf8' }).trim());
  } catch { /* The source hash remains sufficient for snapshot identity. */ }
  const adapterHash = sha256([WORKER, fileURLToPath(import.meta.url)].sort()
    .map((file) => `${path.basename(file)}\0${sha256(fs.readFileSync(file))}\n`).join(''));
  return { commit, dirty, source_sha256: hash, adapter_sha256: adapterHash,
    system_prompt_sha256: sha256(BUILTIN_SYSTEM_PROMPT),
    source_files: files.length, node: process.version, platform: process.platform, arch: process.arch };
}

function sandboxDetails(flags) {
  if (process.platform !== 'darwin') throw new Error('This runner currently requires the reviewed macOS sandbox profile');
  if (!fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('sandbox-exec is unavailable; no unsandboxed fallback');
  const profile = fs.readFileSync(path.resolve(flags.sandboxProfile), 'utf8');
  const runtime = fs.realpathSync(flags.runtimeRoot);
  for (const variable of ['WORKSPACE', 'REPO', 'RUNTIME']) {
    if (!profile.includes(`{{${variable}}}`)) throw new Error(`Sandbox profile is missing {{${variable}}}`);
  }
  return { profile, runtime, profile_sha256: sha256(profile) };
}

export function renderSandbox(template, values) {
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    if (!(key in values)) throw new Error(`Unknown sandbox placeholder ${key}`);
    return String(values[key]).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  });
  return rendered;
}

export function assertHiddenDatasetIsPrivate(datasetPath, { repo = REPO, runtime }) {
  const readableRoots = ['/System', '/usr', '/bin', '/sbin', '/dev', '/private/etc',
    '/private/var/db', '/opt/homebrew', runtime, path.join(repo, 'zhiqu-cli/src'),
    path.join(repo, 'tools/benchmarks')].filter(Boolean);
  const normalized = (value) => process.platform === 'darwin' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const filename = normalized(datasetPath);
  for (const root of readableRoots) {
    const relative = path.relative(normalized(root), filename);
    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      throw new Error(`Hidden dataset is inside a sandbox-readable directory: ${root}`);
    }
  }
}

function commandGroupsBelow(workerPid) {
  if (!workerPid) return [];
  try {
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='],
      { encoding: 'utf8', timeout: 2000 }).split('\n').map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      return match ? { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]) } : null;
    }).filter(Boolean);
    const descendants = new Set([workerPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
    // Only groups led by our worker or one of its descendants can be terminated.
    return [...new Set(rows.filter((row) => descendants.has(row.pid) && descendants.has(row.group)
      && row.group > 1).map((row) => row.group))];
  } catch { return []; } // Graceful abort still uses LocalTools' own command-group cleanup.
}

/** LocalTools uses separate detached groups, so killing only the worker's group leaks commands. */
export function createWorkerStopper(child, { graceMs = 5000 } = {}) {
  let stopping = false;
  let closed = false;
  let timer = null;
  let groups = [];
  const force = () => {
    for (const group of new Set([child.pid, ...groups])) {
      if (!Number.isSafeInteger(group) || group <= 1) continue;
      try { process.kill(-group, 'SIGKILL'); } catch { /* Already reaped. */ }
    }
    try { child.kill('SIGKILL'); } catch { /* Already reaped. */ }
  };
  child.once('close', () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (stopping) force();
  });
  return () => {
    if (stopping || closed) return;
    stopping = true;
    // Snapshot before SIGTERM so a detached command cannot become an untracked orphan.
    groups = commandGroupsBelow(child.pid);
    try { child.kill('SIGTERM'); } catch { force(); }
    timer = setTimeout(force, graceMs);
    timer.unref();
  };
}

function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}
const taskName = (task) => `HumanEval-${task.task_id.split('/')[1].padStart(3, '0')}`;
export function sampleFor(task, result) {
  return { task_id: task.task_id, completion: result?.generation_status === 'completed' ? result.completion || '' : '',
    generation_status: result?.generation_status || 'pending', solution_sha256: result?.solution_sha256 ?? null,
    duration_ms: result?.duration_ms ?? null, ...(result?.error ? { error: result.error } : {}) };
}
export function sanitizeWorkerResult(result, token) {
  const { completion, ...metadata } = result;
  const safe = JSON.parse(redact(JSON.stringify(metadata), token));
  if (token && completion.includes(token)) {
    return { ...safe, completion: '', generation_status: 'protocol_error',
      error: 'Candidate code contained the gateway credential' };
  }
  return { ...safe, completion };
}
function writeSamples(output, tasks, results) {
  const file = path.join(output, 'samples.jsonl');
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, tasks.map((task) => JSON.stringify(sampleFor(task, results.get(task.task_id)))).join('\n') + '\n',
    { mode: 0o600 });
  fs.renameSync(temp, file);
}

function workerEnv(workspace, runtime) {
  const runtimeBins = [path.join(runtime, 'python/bin'), path.join(runtime, 'node/bin')]
    .filter((directory) => fs.existsSync(directory));
  const environment = { PATH: [...runtimeBins, process.env.PATH || '/usr/bin:/bin'].join(path.delimiter),
    TMPDIR: path.join(workspace, '.tmp'),
    LANG: 'en_US.UTF-8', TERM: 'dumb', CI: '1', TZ: 'Asia/Shanghai', PYTHONDONTWRITEBYTECODE: '1' };
  // Do not forward HOME, ZHIQU_TOKEN, cloud keys, proxy credentials, or user-specific settings.
  return environment;
}

function runWorker(payload, taskDirectory, flags, sandbox, active) {
  const { workspace, auth } = payload;
  const url = new URL(auth.server);
  const profile = renderSandbox(sandbox.profile, { WORKSPACE: workspace, REPO,
    RUNTIME: sandbox.runtime, SERVER_HOST: url.hostname, SERVER_PORT: url.port || (url.protocol === 'https:' ? '443' : '80') });
  const profileFile = path.join(taskDirectory, 'sandbox.sb');
  fs.writeFileSync(profileFile, profile, { mode: 0o600 });
  const started = performance.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let hardTimeout = false;
    let tooLarge = false;
    let child;
    try {
      child = spawn('/usr/bin/sandbox-exec', ['-f', profileFile, process.execPath, WORKER],
        { cwd: workspace, env: workerEnv(workspace, sandbox.runtime), stdio: ['pipe', 'pipe', 'pipe'], detached: true, shell: false });
    } catch (error) {
      resolve({ task_id: payload.task.task_id, completion: '', generation_status: 'worker_error',
        error: redact(error.message, auth.token), duration_ms: 0 });
      return;
    }
    const kill = createWorkerStopper(child);
    active.set(child, kill);
    const take = (kind, chunk) => {
      if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
      if (stdout.length + stderr.length > 8_000_000) { tooLarge = true; kill(); }
    };
    child.stdout.on('data', (chunk) => take('stdout', chunk));
    child.stderr.on('data', (chunk) => take('stderr', chunk));
    child.stdin.on('error', () => {}); // Early worker rejection can close stdin before end.
    child.stdin.end(JSON.stringify(payload));
    const timeout = setTimeout(() => { hardTimeout = true; kill(); }, flags.timeoutSeconds * 1000 + 5000);
    child.on('error', (error) => { stderr += redact(error.message, auth.token); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      active.delete(child);
      let result;
      try {
        result = JSON.parse(stdout);
        if (result.task_id !== payload.task.task_id || !STATUS.has(result.generation_status)
          || typeof result.completion !== 'string') throw new Error('Invalid worker result');
        if (result.generation_status === 'completed' && code !== 0) throw new Error('Worker failed after reporting completion');
      } catch {
        result = { task_id: payload.task.task_id, completion: '', generation_status: hardTimeout ? 'timeout' : 'worker_error',
          duration_ms: Math.round(performance.now() - started), error: hardTimeout ? 'Worker exceeded its hard deadline'
            : tooLarge ? 'Worker output exceeded its limit' : `Worker exited without a valid result (code ${code}, signal ${signal || 'none'})` };
      }
      // Redact again at the persistence boundary, even if the worker failed before its own redactor.
      result = sanitizeWorkerResult(result, auth.token);
      const terminal = `${result.terminal_log || ''}${stderr ? `\nWorker stderr:\n${redact(stderr, auth.token)}` : ''}`;
      delete result.terminal_log;
      fs.writeFileSync(path.join(taskDirectory, 'terminal.log'), terminal, { mode: 0o600 });
      result.worker_exit_code = code;
      result.worker_signal = signal;
      resolve(result);
    });
  });
}

async function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help) { process.stdout.write(`${HELP}\n`); return; }
  const sandbox = sandboxDetails(flags);
  const source = sourceFingerprint();
  let dataset = null;
  let datasetPath = null;
  if (!flags.preflight) {
    if (!flags.dataset) throw new Error('--dataset is required for generation or --dry-run');
    datasetPath = fs.realpathSync(flags.dataset);
    assertHiddenDatasetIsPrivate(datasetPath, { runtime: sandbox.runtime });
    dataset = readDataset(datasetPath, flags.limit);
  }
  if (flags.dryRun) {
    process.stdout.write(`${JSON.stringify({ mode: 'dry_run', model_calls: 0, network_requests: 0,
      tasks: dataset.tasks.length, full_humaneval: dataset.tasks.length === 164,
      dataset_sha256: dataset.sha256, source, concurrency: flags.concurrency,
      max_rounds: flags.maxRounds, timeout_seconds: flags.timeoutSeconds,
      requests_per_minute: flags.requestsPerMinute, min_request_interval_ms: flags.minRequestIntervalMs,
      sandbox_profile_sha256: sandbox.profile_sha256 }, null, 2)}\n`);
    return;
  }
  const auth = credentials(flags);
  const api = new Api(auth);
  const [, metadata] = await Promise.all([
    api.get('/api/harness/me', { timeoutMs: 5000, retry: false }),
    api.get('/api/harness/models', { timeoutMs: 5000, retry: false }),
  ]);
  const model = selectDeepSeekModel(metadata, flags.modelId);
  if (flags.preflight) {
    process.stdout.write(`${JSON.stringify({ mode: 'preflight', ready: true, model_calls: 0,
      server: auth.server, model, source, sandbox_profile_sha256: sandbox.profile_sha256 }, null, 2)}\n`);
    return;
  }
  const output = flags.output ? path.resolve(flags.output) : fs.mkdtempSync('/private/tmp/zhiqu-humaneval-');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const outputReal = fs.realpathSync(output);
  if (datasetPath.startsWith(`${path.join(outputReal, 'tasks')}${path.sep}`)) throw new Error('Hidden dataset must be outside every task workspace');
  const protocol = { version: 3, benchmark: 'HumanEval', official_tasks: 164, tasks: dataset.tasks.length,
    subset: dataset.tasks.length !== 164, dataset_sha256: dataset.sha256,
    dataset_uncompressed_sha256: dataset.uncompressed_sha256, source, model, server: auth.server,
    concurrency: flags.concurrency, max_rounds: flags.maxRounds, timeout_seconds: flags.timeoutSeconds,
    requests_per_minute: flags.requestsPerMinute, min_request_interval_ms: flags.minRequestIntervalMs,
    sandbox_profile_sha256: sandbox.profile_sha256, runtime_root: sandbox.runtime,
    permissions: 'auto with shipped LocalTools guard; OS sandbox; local tools only',
    prompt_protocol: 'solution.py exact official prompt prefix; implementation appended; no hidden test feedback',
    office_tools: false, mcp: false, personal_instructions: false, personal_skills: false, remote_archive: false,
    thinking: 'production gateway OFF', temperature: 'production gateway configuration',
    samples_per_task: 1 };
  const fingerprint = sha256(JSON.stringify(protocol));
  const manifestFile = path.join(outputReal, 'manifest.json');
  let previousManifest = null;
  if (fs.existsSync(manifestFile)) {
    previousManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (previousManifest.fingerprint !== fingerprint) throw new Error('Output belongs to a different dataset, agent, model or protocol; use a fresh --output');
  }
  let lock;
  const lockFile = path.join(outputReal, '.generation.lock');
  try { lock = fs.openSync(lockFile, 'wx', 0o600); } catch { throw new Error('Output is already locked; verify no generation process is running'); }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  const results = new Map();
  const active = new Map();
  const runController = new AbortController();
  let interrupted = false;
  let fatal = null;
  const stop = () => { interrupted = true; runController.abort(); for (const kill of active.values()) kill(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const manifest = { ...protocol, fingerprint,
    started_at: previousManifest?.started_at || new Date().toISOString(), output: outputReal };
  try {
    for (const task of dataset.tasks) {
      const file = path.join(outputReal, 'tasks', taskName(task), 'result.json');
      if (!fs.existsSync(file)) continue;
      const result = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (result.fingerprint !== fingerprint || result.task_id !== task.task_id || !STATUS.has(result.generation_status)) {
        throw new Error(`Resume artifact does not match ${task.task_id}`);
      }
      results.set(task.task_id, result);
    }
    atomicJson(manifestFile, manifest);
    writeSamples(outputReal, dataset.tasks, results);
    process.stdout.write(`Output: ${outputReal}\nModel: ${model.id} / ${model.modelName}\n`
      + `Tasks: ${dataset.tasks.length}; resumed: ${results.size}; concurrency: ${flags.concurrency}\n`);
    let next = 0;
    const queue = dataset.tasks.filter((task) => !results.has(task.task_id));
    const consume = async () => {
      try {
      while (!interrupted && !fatal && next < queue.length) {
        const task = queue[next++];
        const taskDirectory = path.join(outputReal, 'tasks', taskName(task));
        const workspace = path.join(taskDirectory, 'workspace');
        if (fs.existsSync(workspace)) {
          // Preserve an interrupted attempt; it never counts as a fresh successful first attempt.
          throw new Error(`Unfinished workspace exists for ${task.task_id}; choose a fresh output or inspect it before resuming`);
        }
        fs.mkdirSync(path.join(workspace, '.tmp'), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(workspace, 'solution.py'), Buffer.from(task.prompt, 'utf8'));
        fs.writeFileSync(path.join(taskDirectory, 'public-task.json'), `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
        const result = await runWorker({ task: publicTask(task), auth, model,
          workspace, limits: { maxRounds: flags.maxRounds, timeoutMs: flags.timeoutSeconds * 1000,
            minRequestIntervalMs: flags.minRequestIntervalMs } },
        taskDirectory, flags, sandbox, active);
        if (interrupted) {
          result.generation_status = 'interrupted';
          result.completion = '';
          result.error ||= 'Generation interrupted by the operator';
        }
        result.fingerprint = fingerprint;
        atomicJson(path.join(taskDirectory, 'result.json'), result);
        results.set(task.task_id, result);
        writeSamples(outputReal, dataset.tasks, results);
        process.stdout.write(`[${results.size}/${dataset.tasks.length}] ${task.task_id}: ${result.generation_status} `
          + `(${Math.round((result.duration_ms || 0) / 1000)}s; ${result.model_requests || 0} model requests)\n`);
        if (result.generation_status === 'model_mismatch') {
          fatal = 'Actual gateway model changed; remaining tasks were not run';
          runController.abort();
          for (const kill of active.values()) kill();
        }
        // A new child has no previous-request timestamp. Preserve this slot's interval across episodes.
        if (!interrupted && !fatal && next < queue.length) {
          await signalAwareSleep(flags.minRequestIntervalMs, runController.signal);
        }
      }
      } catch (error) {
        if (!interrupted && !fatal) fatal = redact(error.message, auth.token);
        runController.abort();
        for (const kill of active.values()) kill();
      }
    };
    await Promise.all(Array.from({ length: flags.concurrency }, consume));
    for (const task of dataset.tasks) if (!results.has(task.task_id)) {
      results.set(task.task_id, { task_id: task.task_id, completion: '', generation_status: 'not_run',
        error: fatal || 'Run interrupted before this task started' });
    }
    writeSamples(outputReal, dataset.tasks, results);
    const counts = {};
    for (const result of results.values()) counts[result.generation_status] = (counts[result.generation_status] || 0) + 1;
    manifest.finished_at = new Date().toISOString();
    manifest.generation_counts = counts;
    manifest.model_requests = [...results.values()].reduce((sum, result) => sum + (result.model_requests || 0), 0);
    manifest.usage = [...results.values()].reduce((sum, result) => ({
      prompt_tokens: sum.prompt_tokens + (result.usage?.prompt_tokens || 0),
      completion_tokens: sum.completion_tokens + (result.usage?.completion_tokens || 0),
      estimated: sum.estimated || Boolean(result.usage?.estimated),
    }), { prompt_tokens: 0, completion_tokens: 0, estimated: false });
    atomicJson(manifestFile, manifest);
    process.stdout.write(`Generation finished: ${JSON.stringify(counts)}\nSamples: ${path.join(outputReal, 'samples.jsonl')}\n`);
    if (interrupted || fatal || [...results.values()].some((result) => result.generation_status !== 'completed')) process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    for (const kill of active.values()) kill();
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    // Errors are redacted independently of whether auth loading succeeded.
    let token = process.env.ZHIQU_TOKEN;
    try { token ||= loadUserConfig().token; } catch {}
    process.stderr.write(`HumanEval generation: ${redact(error.message, token)}\n`);
    process.exitCode = 1;
  });
}
