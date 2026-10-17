// A single repository episode. Paid credentials, hidden patches and grading stay outside this worker.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { Api } from '../../zhiqu-cli/src/api.js';
import { DEFAULT_MAX_TOKENS, runTurn } from '../../zhiqu-cli/src/agent.js';
import { BUILTIN_SYSTEM_PROMPT } from '../../zhiqu-cli/src/prompt.js';
import { instructionsBlock, loadInstructions } from '../../zhiqu-cli/src/instructions.js';
import { LocalTools } from '../../zhiqu-cli/src/tools/local.js';
import { SessionStore } from '../../zhiqu-cli/src/session.js';
import { Ui } from '../../zhiqu-cli/src/ui.js';
import { sha256, redact, signalAwareSleep } from './agent-worker.mjs';

export const PUBLIC_REPOSITORY_FIELDS = ['repo', 'instance_id', 'base_commit', 'problem_statement'];
// 2026-10-16 用户指定用「deepseek测试专用」（ID 6，同一个 deepseek-v4-pro、1M 上下文），在任何模型调用之前从 ID 1 换过来；
// 2026-10-18 ID 6 那组按预算停下后，用户要求用 ID 1「DeepseekV4pro」（同一个模型、另一份配置）补被打断的题。只认这两个 ID、这一个模型。
export const REPOSITORY_MODEL = Object.freeze({ id: 6, modelName: 'deepseek-v4-pro', contextWindowTokens: 1_000_000 });
export const APPROVED_MODEL_IDS = Object.freeze([6, 1]);
export const REPOSITORY_LIMITS = Object.freeze({ maxRounds: 60, timeoutMs: 1_800_000,
  execTimeoutMs: 180_000, minRequestIntervalMs: 1200, maxRequests: 200 });

export function publicRepositoryTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('Missing public repository task');
  const projected = {};
  for (const field of PUBLIC_REPOSITORY_FIELDS) {
    if (typeof task[field] !== 'string' || !task[field].trim()) throw new Error(`Invalid public task field: ${field}`);
    projected[field] = task[field];
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(projected.repo)
      || !/^[A-Za-z0-9_.-]+$/.test(projected.instance_id)
      || !/^[a-fA-F0-9]{40}$/.test(projected.base_commit)) throw new Error('Invalid repository task identity');
  return projected;
}

export function repositoryInstruction(task) {
  return `Resolve this issue in the existing ${task.repo} repository (${task.instance_id}).\n`
    + `The source is the exported public base commit ${task.base_commit}; the current working directory is its repository root.\n`
    + 'Read the relevant source and public maintenance instructions, edit the actual files, and run appropriate public checks. '
    + 'Keep the change focused on the issue. Hidden grading tests and reference patches are unavailable. '
    + 'Do not attempt to retrieve them. The parent process will collect the final repository patch after this episode.\n\n'
    + `Issue:\n${task.problem_statement}`;
}

function keysOnly(object, allowed, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`Invalid ${label}`);
  if (Object.keys(object).some((key) => !allowed.includes(key))) throw new Error(`${label} contains unsupported fields`);
}

export function validateRepositoryPayload(payload) {
  keysOnly(payload, ['schema_version', 'task', 'workspace', 'broker', 'model', 'limits', 'source'], 'worker payload');
  if (payload.schema_version != null && payload.schema_version !== 1) throw new Error('Unsupported worker schema');
  const task = publicRepositoryTask(payload.task);
  keysOnly(payload.task, PUBLIC_REPOSITORY_FIELDS, 'public task');
  keysOnly(payload.broker, ['server', 'capability'], 'episode broker');
  if (typeof payload.broker.capability !== 'string' || !payload.broker.capability
      || payload.broker.capability.startsWith('zqp_')) throw new Error('Worker needs an episode capability, not a real gateway token');
  let url;
  try { url = new URL(payload.broker.server); } catch { throw new Error('Invalid broker endpoint'); }
  const octets = url.hostname.split('.').map(Number);
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
    && octets.length === 4 && octets.every((value) => value >= 0 && value <= 255);
  const privateIp = ipv4 && (octets[0] === 10 || octets[0] === 127
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168));
  if (url.protocol !== 'http:' || !privateIp || url.username || url.password || url.search || url.hash
      || url.pathname !== '/') throw new Error('Broker must be a fixed private IPv4 HTTP endpoint');
  keysOnly(payload.model, ['id', 'label', 'modelName', 'providerType', 'toolCalling', 'contextWindowTokens',
    'effectiveContextWindow'], 'model metadata');
  if (!APPROVED_MODEL_IDS.includes(payload.model.id) || payload.model.modelName !== REPOSITORY_MODEL.modelName
      || payload.model.toolCalling !== true || payload.model.contextWindowTokens !== REPOSITORY_MODEL.contextWindowTokens
      || payload.model.effectiveContextWindow !== REPOSITORY_MODEL.contextWindowTokens) {
    throw new Error('Repository protocol requires DeepSeek ID 6 or 1 / deepseek-v4-pro / 1000000-token context');
  }
  keysOnly(payload.limits || {}, Object.keys(REPOSITORY_LIMITS), 'episode limits');
  const limits = { ...REPOSITORY_LIMITS, ...payload.limits };
  for (const [key, maximum] of Object.entries(REPOSITORY_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < (key === 'timeoutMs' ? 100 : 1)
        || limits[key] > maximum) throw new Error(`Invalid ${key}`);
  }
  // Shorter values exist for offline controls; formal limits are checked against the frozen manifest by the parent.
  if (DEFAULT_MAX_TOKENS !== 16_384) throw new Error('Shipped agent output ceiling changed');
  if (payload.source != null) {
    keysOnly(payload.source, ['agent_commit', 'cli_git_tree'], 'source metadata');
    for (const value of Object.values(payload.source)) if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
      throw new Error('Source diagnostic identity must be a Git hash');
    }
  }
  if (typeof payload.workspace !== 'string') throw new Error('Missing workspace');
  const workspace = fs.realpathSync(payload.workspace);
  const baseDirectory = path.join(workspace, 'base_repo');
  const baseRepo = fs.realpathSync(baseDirectory);
  const relative = path.relative(workspace, baseRepo);
  if (relative !== 'base_repo' || !fs.statSync(baseRepo).isDirectory()) throw new Error('base_repo must be a real directory inside the task workspace');
  if (fs.existsSync(path.join(baseRepo, '.git'))) throw new Error('Generation base must contain exported source, not Git history');
  const noUserDir = path.join(workspace, '.no-personal-config');
  if (fs.existsSync(noUserDir)) throw new Error('Unexpected personal instruction directory');
  return { task, workspace, baseRepo, noUserDir, limits,
    broker: { server: url.origin, capability: payload.broker.capability }, model: { ...payload.model } };
}

function workerSourceMetadata(supplied) {
  const files = ['agent.js', 'prompt.js', 'api.js', 'sse.js', 'tools/local.js', 'tools/guard.js', 'tools/execrules.js'];
  return { ...supplied, worker_sha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
    system_prompt_sha256: sha256(BUILTIN_SYSTEM_PROMPT),
    file_sha256: Object.fromEntries(files.map((file) => [file,
      sha256(fs.readFileSync(new URL(`../../zhiqu-cli/src/${file}`, import.meta.url)))])),
    node_version: process.version, platform: process.platform, arch: process.arch };
}

/** Process-local diagnostics are untrusted; the independent broker/parent own the actual budget and lifecycle. */
export async function runRepositoryTask(payload, { api: suppliedApi } = {}) {
  const { task, workspace, baseRepo, noUserDir, limits, broker, model } = validateRepositoryPayload(payload);
  const started = performance.now();
  const controller = new AbortController();
  const requests = [];
  const recordedCalls = new Map();
  const toolsByName = {};
  const commandResults = [];
  let recordedToolCalls = 0;
  let recordedToolResults = 0;
  let log = '';
  let logTruncated = false;
  let timedOut = false;
  let interrupted = false;
  let protocolError = null;
  let modelMismatch = null;
  let requestLimit = false;
  let totalPacingWaitMs = 0;
  let lastRequestStarted = -Infinity;
  const output = new Writable({ write(chunk, _encoding, done) {
    const text = chunk.toString();
    if (log.length + text.length > 2_000_000) logTruncated = true;
    if (log.length < 2_000_000) log += text.slice(0, 2_000_000 - log.length);
    done();
  } });
  const input = new PassThrough();
  input.end();
  const ui = new Ui({ input, output, interactive: false, color: false });
  const api = suppliedApi || new Api({ server: broker.server, token: broker.capability });
  const originalStream = api.stream;
  api.stream = async (pathname, body, onEvent, options) => {
    if (pathname !== '/api/harness/model/stream' || body.modelId !== model.id
        || !Number.isSafeInteger(body.maxTokens) || body.maxTokens > DEFAULT_MAX_TOKENS) {
      protocolError = 'Worker attempted a non-protocol model request';
      controller.abort();
      throw new Error(protocolError);
    }
    if (requests.length >= limits.maxRequests) {
      requestLimit = true;
      controller.abort();
      throw new Error('Episode transport request limit reached');
    }
    const waitMs = Math.max(0, Math.ceil(lastRequestStarted + limits.minRequestIntervalMs - performance.now()));
    const waitStarted = performance.now();
    if (waitMs) {
      try { await signalAwareSleep(waitMs, options?.signal || controller.signal); }
      finally { totalPacingWaitMs += performance.now() - waitStarted; }
    }
    const requestStarted = performance.now();
    lastRequestStarted = requestStarted;
    const item = { index: requests.length + 1, agent_round: body.tools.length > 0,
      started_ms: Math.round(requestStarted - started), started_at: new Date().toISOString(),
      requested_model_id: body.modelId, requested_max_tokens: body.maxTokens, messages: body.messages.length,
      tools: body.tools.map((tool) => tool.function.name), pacing_wait_ms: waitMs ? Math.round(requestStarted - waitStarted) : 0 };
    requests.push(item);
    let verified = false;
    try {
      await originalStream.call(api, pathname, body, (name, data) => {
        if (name === 'start') {
          if (data.model?.id == null || typeof data.model?.modelName !== 'string' || data.contextWindow == null) {
            protocolError = 'Broker start event omitted actual model/context metadata';
            controller.abort();
            throw new Error(protocolError);
          }
          item.actual_model = { id: data.model.id, label: data.model.label, modelName: data.model.modelName,
            providerType: data.model.providerType };
          item.context_window = data.contextWindow;
          item.max_tokens = data.maxTokens;
          item.dropped_messages = data.droppedMessages || 0;
          item.elided_tool_outputs = data.elidedToolOutputs || 0;
          if (data.model.id !== model.id || data.model.modelName !== model.modelName
              || data.contextWindow !== model.effectiveContextWindow) {
            modelMismatch = 'Broker returned a different model or context window than the frozen protocol';
            controller.abort();
            throw new Error(modelMismatch);
          }
          verified = true;
        } else if (!verified) {
          protocolError = 'Broker output arrived before a verified model/context start event';
          controller.abort();
          throw new Error(protocolError);
        }
        if (name === 'done') {
          item.finish_reason = data.finishReason;
          item.max_tokens = data.maxTokens;
          item.usage = { promptTokens: data.usage?.promptTokens ?? null,
            completionTokens: data.usage?.completionTokens ?? null, estimated: data.usage?.estimated ?? true };
        }
        onEvent(name, data);
      }, options);
      if (!verified) {
        protocolError = 'Broker stream omitted the model/context start event';
        controller.abort();
        throw new Error(protocolError);
      }
    } catch (error) {
      item.error = redact(error.message, broker.capability);
      throw error;
    } finally { item.duration_ms = Math.round(performance.now() - requestStarted); }
  };
  const store = new SessionStore(baseRepo);
  const append = store.append.bind(store);
  store.append = (sessionId, event) => {
    if (event.type === 'message') {
      for (const call of event.message.tool_calls || []) {
        const name = call.function?.name || 'unknown';
        recordedCalls.set(call.id, name);
        recordedToolCalls++;
        toolsByName[name] = (toolsByName[name] || 0) + 1;
      }
      if (event.message.role === 'tool') {
        recordedToolResults++;
        if (recordedCalls.get(event.message.tool_call_id) === 'run_command') {
          const content = String(event.message.content || '');
          const exit = /退出码 (-?\d+)/.exec(content);
          commandResults.push({ call_id: event.message.tool_call_id, command: content.split('\n')[0],
            exit_code: exit ? Number(exit[1]) : null, timed_out: content.includes('【超时：'),
            aborted: content.includes('【用户中断'), refused: !content.startsWith('$ ') });
        }
      }
    }
    return append(sessionId, event);
  };
  const loaded = loadInstructions(baseRepo, noUserDir);
  const instructions = { ...loaded, files: loaded.files.filter((file) => file.file.startsWith(`${baseRepo}${path.sep}`)),
    skipped: loaded.skipped.filter((file) => file.startsWith(`${baseRepo}${path.sep}`)) };
  const ctx = { api, ui, root: baseRepo, mode: 'auto', maxRounds: limits.maxRounds,
    local: new LocalTools({ root: baseRepo, execTimeoutMs: limits.execTimeoutMs }),
    store, session: store.create({ model: model.label || model.modelName }), messages: [],
    allow: { write: false, run: false, delete: false, tasks: false, mcp: new Set() },
    usage: { prompt: 0, completion: 0 }, changedFiles: new Set(), todos: [],
    system: { text: BUILTIN_SYSTEM_PROMPT }, instructionsText: instructionsBlock(instructions, baseRepo, noUserDir),
    skillsText: '', skills: [], remoteTools: [], verbose: false, archiveDisabled: true, model };
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.timeoutMs);
  const interrupt = () => { interrupted = true; controller.abort(); };
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  let status = 'completed';
  let error = null;
  let result = null;
  try {
    result = await runTurn(ctx, repositoryInstruction(task), { signal: controller.signal });
    if (timedOut) status = 'timeout';
    else if (interrupted) status = 'interrupted';
    else if (requests.filter((request) => request.agent_round && request.finish_reason != null).length >= limits.maxRounds
        && (!result.finalText || ctx.messages.at(-1)?.role !== 'assistant')) status = 'round_limit';
  } catch (caught) {
    status = modelMismatch ? 'model_mismatch' : protocolError ? 'protocol_error' : requestLimit ? 'request_limit'
      : timedOut ? 'timeout' : interrupted ? 'interrupted' : 'gateway_error';
    error = redact(modelMismatch || protocolError || caught.message, broker.capability);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGINT', interrupt);
    api.stream = originalStream;
    store.append = append;
    ui.close();
  }
  const diagnostic = { schema_version: 1, instance_id: task.instance_id, repo: task.repo, base_commit: task.base_commit,
    issue_sha256: sha256(task.problem_statement), generation_status: status,
    source: workerSourceMetadata(payload.source), model, limits, duration_ms: Math.round(performance.now() - started),
    session: path.relative(workspace, store.file(ctx.session.id)), repository: 'base_repo',
    public_instruction_files: instructions.files.map((file) => path.relative(baseRepo, file.file)),
    rounds: requests.filter((request) => request.agent_round && request.finish_reason != null).length,
    model_requests: requests.length, tool_calls: recordedToolCalls, tools_by_name: toolsByName,
    tool_results: recordedToolResults, command_results: commandResults.map((entry) => ({ ...entry,
      command: redact(entry.command, broker.capability) })),
    usage: { prompt_tokens: ctx.usage.prompt, completion_tokens: ctx.usage.completion,
      estimated: requests.some((request) => request.usage?.estimated !== false),
      missing_usage: requests.filter((request) => !request.usage).length },
    transport_wait_ms: Math.round(totalPacingWaitMs), requests,
    final_answer: redact(result?.finalText || '', broker.capability),
    changed_files: (result?.changedFiles || [...ctx.changedFiles]).map((file) => redact(file, broker.capability)),
    ...(error ? { error } : {}), terminal_log: redact(log, broker.capability), terminal_log_truncated: logTruncated,
    diagnostics_trusted: false, patch_collection: 'parent collects untouched files after container shutdown' };
  // This object contains diagnostics only. Candidate source remains solely in the untouched repository files.
  return JSON.parse(redact(JSON.stringify(diagnostic), broker.capability));
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('Repository worker stdin exceeded its limit');
    chunks.push(chunk);
  }
  const result = await runRepositoryTask(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.generation_status === 'completed' ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(() => {
    process.stderr.write('Repository worker could not initialize; check the public payload and exported workspace.\n');
    process.exitCode = 1;
  });
}
