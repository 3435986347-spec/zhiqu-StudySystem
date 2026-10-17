#!/usr/bin/env node
// 仓库评测的 Docker 编排（第六十九轮）。宿主机这一侧只做可信的事：建镜像、配网络、管 broker、杀容器、收补丁、交给官方评分；
// 候选代码只在 task 容器里跑，真实登录只经 stdin 进 broker 容器，评分走固定版本的官方 harness（官方 x86 镜像、Rosetta 转译）。
//
//   node tools/benchmarks/repository-docker.mjs runtime   --eval-dir DIR   冻结的 Node / CLI / worker 摆进只读目录，核对指纹
//   node tools/benchmarks/repository-docker.mjs images    --eval-dir DIR   从官方 env 镜像（不含仓库）+ base 建生成镜像，审计
//   node tools/benchmarks/repository-docker.mjs smoke     --eval-dir DIR   每题：网络策略、无模型探针、LocalTools 跑公开测试、整容器回收
//   node tools/benchmarks/repository-docker.mjs lifecycle --eval-dir DIR   后代进程、输出洪泛、半路的请求、超时：全部回收、能力撤销、账本对得上
//   node tools/benchmarks/repository-docker.mjs grade     --eval-dir DIR --kind gold|baseline|candidate --predictions FILE
//   node tools/benchmarks/repository-docker.mjs run       --eval-dir DIR   付费：校准一次、固定十题按顺序各一次、冻结补丁、官方评分
//
// 方案见 docs/benchmarks/repository-eval-plan.md；对照没全过、配置没写 execution_ready 时 run 拒绝开始。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG = path.join(REPO, 'docs/benchmarks/repository-pilot-20261014/run-config.json');
const PREPARER = path.join(REPO, 'tools/benchmarks/prepare-repository-eval.py');
const SUMMARIZER = path.join(REPO, 'tools/benchmarks/summarize-controls.py');
const HARNESS_WRAPPER = path.join(REPO, 'tools/benchmarks/run-official-harness.py');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export const NODE_TARBALL_SHA256 = '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647';
export const BROKER_IMAGE = 'node:24.19.0-bookworm-slim';
export const POLICY_IMAGE = 'zhiqu-eval/netpolicy:1';
export const BROKER_PORT = 8787;
export const GATEWAY_NETWORK = 'zq-eval-gw';
const RUNTIME_FILES = ['repository-worker.mjs', 'repository-broker.mjs', 'agent-worker.mjs', 'repository-probes.mjs'];

// 每个仓库：import 的模块（及它在 base 里的源码位置）、发行包名、smoke 读的文件、smoke 跑的公开测试（经 LocalTools）
export const REPO_SPECS = Object.freeze({
  'django/django': { modules: [['django', 'django']], dist: 'django', read: 'setup.py',
    smoke: ['python', 'tests/runtests.py', '--settings=test_sqlite', '--parallel', '1', 'basic'] },
  'sympy/sympy': { modules: [['sympy', 'sympy']], dist: 'sympy', read: 'setup.py',
    smoke: ['python', 'bin/test', 'sympy/sets/tests/test_contains.py'] },
  // setuptools-scm 从 .git 定版本号；导出的 base 没有 .git，安装时用官方镜像装出来的同一个版本号（只是一串版本号，见 officialVersion）
  'pytest-dev/pytest': { modules: [['_pytest', 'src/_pytest'], ['pytest', 'src/pytest']], dist: 'pytest', read: 'setup.py', scmModule: 'pytest',
    smoke: ['python', '-m', 'pytest', '-q', 'testing/test_warning_types.py'] },
  'psf/requests': { modules: [['requests', 'requests']], dist: 'requests', read: 'setup.py',
    smoke: ['python', '-m', 'pytest', '--collect-only', '-q', 'test_requests.py'] },
  'scikit-learn/scikit-learn': { modules: [['sklearn', 'sklearn']], dist: 'scikit[-_]learn', read: 'setup.py',
    smoke: ['python', '-m', 'pytest', '-q', 'sklearn/tests/test_check_build.py'] },
});

// 安装和公开测试会生成的东西：只对「base 里没有的新文件」生效（收集器拒绝排除 base 里的文件），在任何模型调用之前定下来
export const GENERATED_EXCLUDES = Object.freeze(['*__pycache__/*', '*.pyc', '.pytest_cache/*', '*.egg-info/*', '.eggs/*',
  'build/*', '*.so', '.cache/*', '.local/*', '.config/*']);

export function fnmatchEscape(name) {
  return name.replace(/[[*?]/g, (c) => `[${c}]`);
}

export function imageName(instanceId) {
  return `zhiqu-eval/gen-${instanceId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}:1`;
}

export function generationDockerfile({ envImage, install, modules, pretendVersion }) {
  if (pretendVersion != null && !/^[0-9][0-9A-Za-z.+-]{0,63}$/.test(pretendVersion)) throw new Error('Unexpected package version');
  const scm = pretendVersion ? `export SETUPTOOLS_SCM_PRETEND_VERSION=${pretendVersion} && ` : '';
  // 依赖环境来自官方 env 镜像（只有 conda 环境、没有仓库）；仓库只有导出的 base。
  // 安装照官方 instance 镜像的 install 命令，在可信构建时联网做；之后 task 容器断网、只读。
  // 同一个包的「别的版本」（conda 的包缓存、base 环境的 site-packages、pip 内置的副本）只留给 root：
  // 从 base 装出来的那份（requests 的非 editable 安装：每个文件都在 base 里、内容一样，只是少了 README 这类非代码文件）照常可读。
  const restrict = modules.map(([module, source]) => `restrict ${module} /work/base_repo/${source}`).join(' && ');
  return `# 第六十九轮：生成镜像。官方 env 镜像（本机按固定 harness 的 Dockerfile 建，不含仓库源码）+ 导出的 base。
FROM --platform=linux/amd64 ${envImage}
COPY --chown=1000:1000 base_repo /work/base_repo
WORKDIR /work/base_repo
RUN /bin/bash -c '${scm}source /opt/miniconda3/bin/activate && conda activate testbed && ${install}' \\
 && chown -R 1000:1000 /work && chmod 755 /work && rm -rf /testbed
RUN /bin/bash -c 'set -euo pipefail; chmod 700 /opt/miniconda3/pkgs /root; \\
 restrict() { find / -xdev \\( -path /proc -o -path /sys -o -path /dev -o -path /work \\) -prune -o -type d -name "$1" -print | while read -r d; do \\
   [ -f "$d/__init__.py" ] || continue; \\
   if [ -z "$(diff -rq -x __pycache__ -x "*.pyc" -x "*.so" -x "*.c" -x "*.cpp" "$d" "$2" 2>&1 | grep -v "^Only in $2")" ]; then echo "keep-identical $d"; else chmod 700 "$d"; echo "restricted $d"; fi; \\
 done; }; ${restrict}'
USER 1000:1000
ENV PATH=/opt/miniconda3/envs/testbed/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/tmp/home LANG=C.UTF-8
`;
}

export function auditScript(modules, dist) {
  const copies = modules.map(([module, source]) => `copies ${module} /work/base_repo/${source}`).join('; ');
  return `set -u
copies() { find / -xdev \\( -path /proc -o -path /sys -o -path /dev -o -path /work \\) -prune -o -type d -name "$1" -print 2>/dev/null | while read -r d; do
  if ls "$d" >/dev/null 2>&1; then
    [ -f "$d/__init__.py" ] || continue
    if [ -z "$(diff -rq -x __pycache__ -x "*.pyc" -x "*.so" -x "*.c" -x "*.cpp" "$d" "$2" 2>&1 | grep -v "^Only in $2")" ]; then echo "identical $d"; else echo "DIFFERENT $d"; fi
  else echo "unreadable $d"; fi
done; }
echo "### git"; find / -xdev \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -name .git -print 2>/dev/null
echo "### copies"; ${copies}
echo "### archives"; find / -xdev \\( -path /proc -o -path /sys -o -path /dev -o -path /work \\) -prune -o -type f \\( -iname '${dist}-[0-9]*.whl' -o -iname '${dist}-[0-9]*.tar.gz' -o -iname '${dist}-[0-9]*.tar.bz2' -o -iname '${dist}-[0-9]*.conda' -o -iname '${dist}-[0-9]*.zip' \\) -readable -print 2>/dev/null
echo "### import"; cd /tmp && python -c "import ${modules[0][0]}; print(${modules[0][0]}.__file__)" 2>&1
echo "### testbed"; ls -A /testbed 2>&1
echo "### work"; ls -A /work
echo "### eval-materials"; find / -xdev \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -type f \\( -name eval.sh -o -name setup_repo.sh -o -name setup_env.sh \\) -readable -print 2>/dev/null
echo "### root"; ls /root 2>&1 | head -1
echo "### end"`;
}

export function parseAudit(text) {
  const sections = {};
  let current = null;
  for (const line of text.split('\n')) {
    const header = /^### (\S+)$/.exec(line);
    if (header) { current = header[1]; sections[current] = []; continue; }
    if (current && line.trim()) sections[current].push(line.trim());
  }
  const problems = [];
  if (!sections.end) problems.push('audit did not finish');
  if (sections.git?.length) problems.push(`git directories: ${sections.git.join(', ')}`);
  for (const line of sections.copies || []) if (line.startsWith('DIFFERENT ')) problems.push(`readable different copy: ${line.slice(10)}`);
  if (sections.archives?.length) problems.push(`readable archives: ${sections.archives.join(', ')}`);
  if (sections.testbed?.length && !/No such file/.test(sections.testbed.join(' '))) problems.push('/testbed exists');
  if (JSON.stringify(sections.work) !== JSON.stringify(['base_repo'])) problems.push(`/work holds ${sections.work}`);
  if (sections['eval-materials']?.length) problems.push(`readable evaluation scripts: ${sections['eval-materials'].join(', ')}`);
  if (!/Permission denied/.test((sections.root || []).join(' '))) problems.push('/root is readable');
  return { sections, problems, ok: problems.length === 0 };
}

export function policyScript(brokerIp, port = BROKER_PORT) {
  if (!/^10\.231\.\d{1,3}\.2$/.test(brokerIp)) throw new Error('Unexpected broker address');
  return `set -eu
iptables -P OUTPUT DROP
iptables -A OUTPUT -d 127.0.0.11 -j DROP
iptables -A OUTPUT -p udp --dport 53 -j DROP
iptables -A OUTPUT -p tcp --dport 53 -j DROP
iptables -A OUTPUT -o lo -d 127.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -p tcp -d ${brokerIp} --dport ${port} -j ACCEPT
ip6tables -P OUTPUT DROP
ip6tables -P FORWARD DROP
echo '## ipv4'; iptables -S OUTPUT
echo '## ipv6'; ip6tables -S OUTPUT`;
}

/** 规则里只有 broker 地址随题目变；哈希时换成占位，十题的策略应当是同一个哈希 */
export function policyFingerprint(rules, brokerIp) {
  return sha(rules.split(brokerIp).join('BROKER_IP').trim());
}

export function harnessArgv(command, python, wrapper = HARNESS_WRAPPER) {
  const at = command.argv.indexOf('-m');
  if (at !== 1 || command.argv[2] !== 'swebench.harness.run_evaluation') throw new Error('Unexpected harness command shape');
  return [python, wrapper, ...command.argv.slice(3)];
}

export function workerPayload({ task, model, brokerIp, capability, config }) {
  return { schema_version: 1, task: { repo: task.repo, instance_id: task.instance_id, base_commit: task.base_commit,
    problem_statement: task.problem_statement }, workspace: '/work',
  broker: { server: `http://${brokerIp}:${BROKER_PORT}/`, capability },
  model: { id: model.id, label: model.label, modelName: model.modelName, providerType: model.providerType,
    toolCalling: model.toolCalling, contextWindowTokens: model.contextWindowTokens, effectiveContextWindow: model.effectiveContextWindow },
  limits: {}, source: { agent_commit: config.agent.commit, cli_git_tree: config.agent.cli_git_tree } };
}

// ── 子进程 ──────────────────────────────────────────────────────────────

export function run(binary, args, { input, timeoutMs = 600_000, stdoutFile, maxBytes = 20_000_000, env } = {}) {
  return new Promise((resolve) => {
    const out = stdoutFile ? fs.openSync(stdoutFile, 'w') : 'pipe';
    const child = spawn(binary, args, { stdio: ['pipe', out, 'pipe'], env: env || process.env });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout?.on('data', (b) => { if (stdout.length < maxBytes) stdout += b; });
    child.stderr.on('data', (b) => { if (stderr.length < 200_000) stderr += b; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (error) => { stderr += String(error); });
    child.on('close', (code) => { clearTimeout(timer); if (stdoutFile) fs.closeSync(out); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

const docker = (args, options) => run('docker', args, options);
async function dockerOk(args, options) {
  const result = await docker(args, options);
  if (result.code !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed (${result.code}): ${result.stderr.slice(-1500)}`);
  return result.stdout;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function scanTree(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name); const key = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) out[key] = `link:${fs.readlinkSync(abs)}`;
      else if (st.isDirectory()) walk(abs, key);
      else if (st.isFile()) out[key] = `file:${(st.mode & 0o111) ? 'x' : '-'}:${sha(fs.readFileSync(abs))}`;
      else out[key] = 'special';
    }
  };
  walk(root, '');
  return out;
}

export function compareTrees(base, final) {
  const added = []; const changed = []; const removed = [];
  for (const key of Object.keys(final)) if (!(key in base)) added.push(key); else if (base[key] !== final[key]) changed.push(key);
  for (const key of Object.keys(base)) if (!(key in final)) removed.push(key);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

export function installExcludes(added) {
  const generic = (name) => GENERATED_EXCLUDES.some((pattern) => globMatch(pattern, name));
  return added.filter((name) => !generic(name)).map(fnmatchEscape);
}

/** Python fnmatchcase 的子集：* 跨目录、? 一个字符、[...] 字符类 —— 收集器用的就是它 */
export function globMatch(pattern, name) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') { const end = pattern.indexOf(']', i + 2); if (end < 0) re += '\\['; else { re += `[${pattern.slice(i + 1, end).replace(/\\/g, '\\\\')}]`; i = end; } }
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's').test(name);
}

// ── 上下文 ──────────────────────────────────────────────────────────────

function context(evalDir) {
  const root = path.resolve(evalDir);
  const control = path.join(root, 'control');
  const selection = readJson(path.join(control, 'selection.json'));
  const config = readJson(CONFIG);
  const python = path.join(root, 'harness-venv/bin/python');
  const tasks = selection.tasks.map((entry, index) => {
    const task = readJson(path.join(control, 'tasks', entry.instance_id, 'public-task.json'));
    const spec = REPO_SPECS[task.repo];
    if (!spec) throw new Error(`No repository spec for ${task.repo}`);
    return { ...task, index: index + 1, spec, image: imageName(task.instance_id) };
  });
  return { root, control, config, python, tasks, state: path.join(root, 'state'), runtime: path.join(root, 'runtime') };
}

function pick(ctx, only) {
  return only ? ctx.tasks.filter((task) => task.instance_id === only) : ctx.tasks;
}

// ── runtime ─────────────────────────────────────────────────────────────

async function stageRuntime(ctx) {
  const tarball = path.join(ctx.root, 'downloads/node24/node-v24.19.0-linux-x64.tar.xz');
  if (sha(fs.readFileSync(tarball)) !== NODE_TARBALL_SHA256) throw new Error('Node tarball checksum mismatch');
  const nodeDir = path.join(ctx.runtime, 'node');
  if (!fs.existsSync(path.join(nodeDir, 'bin/node'))) {
    const staging = `${nodeDir}.staging`;
    fs.rmSync(staging, { recursive: true, force: true }); fs.mkdirSync(staging, { recursive: true });
    const untar = spawnSync('tar', ['-xJf', tarball, '-C', staging, '--strip-components', '1']);
    if (untar.status !== 0) throw new Error('Could not extract Node');
    fs.renameSync(staging, nodeDir);
  }
  const zhiqu = path.join(ctx.runtime, 'zhiqu');
  if (fs.existsSync(zhiqu)) { spawnSync('chmod', ['-R', 'u+w', zhiqu]); fs.rmSync(zhiqu, { recursive: true, force: true }); }
  fs.mkdirSync(path.join(zhiqu, 'tools/benchmarks'), { recursive: true });
  const tree = spawnSync('git', ['rev-parse', `${ctx.config.agent.commit}:zhiqu-cli`], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  if (tree !== ctx.config.agent.cli_git_tree) throw new Error('Frozen CLI tree does not match the configured commit');
  const archive = spawnSync('git', ['archive', '--format=tar', ctx.config.agent.commit, 'zhiqu-cli'], { cwd: REPO, maxBuffer: 200_000_000 });
  if (archive.status !== 0) throw new Error('git archive failed');
  const untar = spawnSync('tar', ['-x', '-C', zhiqu], { input: archive.stdout });
  if (untar.status !== 0) throw new Error('Could not extract the frozen CLI');
  for (const file of RUNTIME_FILES) fs.copyFileSync(path.join(REPO, 'tools/benchmarks', file), path.join(zhiqu, 'tools/benchmarks', file));
  const hashOf = (file) => sha(fs.readFileSync(path.join(zhiqu, 'tools/benchmarks', file)));
  if (hashOf('repository-worker.mjs') !== ctx.config.agent.worker_sha256) throw new Error('Worker differs from the frozen fingerprint');
  if (hashOf('repository-broker.mjs') !== ctx.config.agent.broker_sha256) throw new Error('Broker differs from the frozen fingerprint');
  const committed = spawnSync('git', ['show', `${ctx.config.agent.commit}:tools/benchmarks/agent-worker.mjs`], { cwd: REPO, maxBuffer: 10_000_000 }).stdout;
  if (sha(committed) !== hashOf('agent-worker.mjs')) throw new Error('agent-worker.mjs differs from the frozen commit');
  spawnSync('chmod', ['-R', 'a-w', zhiqu]);
  const summary = { node_tarball_sha256: NODE_TARBALL_SHA256, node_binary_sha256: sha(fs.readFileSync(path.join(nodeDir, 'bin/node'))),
    node_version: '24.19.0', cli_git_tree: tree, agent_commit: ctx.config.agent.commit,
    files: Object.fromEntries(RUNTIME_FILES.map((file) => [file, hashOf(file)])), staged_at: new Date().toISOString() };
  writeJson(path.join(ctx.state, 'runtime.json'), summary);
  return summary;
}

function requireRuntime(ctx) {
  const summary = readJson(path.join(ctx.state, 'runtime.json'));
  for (const [file, hash] of Object.entries(summary.files)) {
    if (sha(fs.readFileSync(path.join(ctx.runtime, 'zhiqu/tools/benchmarks', file))) !== hash) throw new Error(`Staged ${file} changed`);
  }
  return summary;
}

// ── 生成镜像 ────────────────────────────────────────────────────────────

function harnessFacts(ctx) {
  const cached = path.join(ctx.state, 'harness-facts.json');
  if (fs.existsSync(cached)) return readJson(cached);
  const harness = path.join(ctx.control, 'SWE-bench-3f01bd622c0a22c00406139f69a234ef08225f22');
  const code = `import json,platform,sys
platform.machine=lambda:"x86_64"
sys.path.insert(0, sys.argv[1])
from swebench.harness.test_spec.test_spec import make_test_spec
from swebench.harness.constants import MAP_REPO_VERSION_TO_SPECS
out={}
for row in json.load(open(sys.argv[2])):
    s=make_test_spec(row)
    out[row["instance_id"]]={"env_image":s.env_image_key,"instance_image":"swebench/"+s.instance_image_key.replace("__","_1776_") if "/" not in s.instance_image_key else s.instance_image_key,"install":MAP_REPO_VERSION_TO_SPECS[row["repo"]][row["version"]]["install"]}
print(json.dumps(out))`;
  const result = spawnSync(ctx.python, ['-I', '-c', code, harness, path.join(ctx.control, 'private/dataset.json')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`harness facts failed: ${result.stderr.slice(-800)}`);
  const facts = JSON.parse(result.stdout);
  writeJson(cached, facts);
  return facts;
}

async function buildImages(ctx, only) {
  const facts = harnessFacts(ctx);
  const file = path.join(ctx.state, 'images.json');
  const summary = fs.existsSync(file) ? readJson(file) : {};
  for (const task of pick(ctx, only)) {
    try { await buildImage(ctx, task, facts[task.instance_id], summary); } catch (error) {
      summary[task.instance_id] = { ok: false, error: String(error.message || error).slice(0, 2000) };
    }
    writeJson(file, summary);
    const row = summary[task.instance_id];
    process.stderr.write(`${task.instance_id}: ${row.ok ? 'ok' : `PROBLEMS ${row.error || row.problems.join('; ')}`}\n`);
  }
  return summary;
}

/** 官方 instance 镜像里装出来的版本号（setuptools-scm 在有 .git 时算出来的）。只读这一串，镜像本身不进生成镜像 */
async function officialVersion(instanceImage, module) {
  const out = await dockerOk(['run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--entrypoint', '/bin/bash', instanceImage, '-c',
    `source /opt/miniconda3/bin/activate testbed && python -c "import ${module}; print(${module}.__version__)"`]);
  return out.trim().split('\n').at(-1);
}

async function buildImage(ctx, task, fact, summary) {
  const started = Date.now();
  const dir = path.join(ctx.root, 'gen-build', task.instance_id);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  if (spawnSync('cp', ['-Rp', path.join(ctx.control, 'tasks', task.instance_id, 'base_repo'), path.join(dir, 'base_repo')]).status !== 0) throw new Error('copy base failed');
  const pretendVersion = task.spec.scmModule ? await officialVersion(fact.instance_image, task.spec.scmModule) : null;
  fs.writeFileSync(path.join(dir, 'Dockerfile'), generationDockerfile({ envImage: fact.env_image, install: fact.install, modules: task.spec.modules, pretendVersion }));
  await dockerOk(['image', 'inspect', '--format', '{{.Id}}', fact.env_image]);
  const log = path.join(ctx.root, 'logs', `gen-build-${task.instance_id}.log`);
  const build = await docker(['build', '--progress=plain', '--platform', 'linux/amd64', '--pull=false', '-t', task.image,
    '--label', `zhiqu.eval.instance=${task.instance_id}`, dir], { timeoutMs: 3_600_000 });
  fs.writeFileSync(log, build.stdout + build.stderr);
  if (build.code !== 0) { summary[task.instance_id] = { ok: false, error: `build_failed (${log})` }; return; }
  const imageId = (await dockerOk(['image', 'inspect', '--format', '{{.Id}}', task.image])).trim();
  const restricted = (build.stderr.match(/(?:restricted|keep-identical) \/\S+/g) || []).filter((v, i, all) => all.indexOf(v) === i);
  // 安装之后的 base：和导出的 base 比，只许多出新文件，不许改 base 里的文件
  const tarFile = path.join(dir, 'post-install.tar');
  await dockerOk(['run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--user', '1000:1000', '--entrypoint', 'tar', task.image,
    '-C', '/work/base_repo', '-cf', '-', '.'], { stdoutFile: tarFile, timeoutMs: 600_000 });
  const post = path.join(dir, 'post-install'); fs.mkdirSync(post);
  if (spawnSync('tar', ['-xf', tarFile, '-C', post]).status !== 0) throw new Error('post-install extract failed');
  const diff = compareTrees(scanTree(path.join(ctx.control, 'tasks', task.instance_id, 'base_repo')), scanTree(post));
  const audit = await docker(['run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--user', '1000:1000',
    '--entrypoint', '/bin/bash', task.image, '-c', auditScript(task.spec.modules, task.spec.dist)], { timeoutMs: 1_200_000 });
  const parsed = parseAudit(audit.stdout);
  const problems = [...parsed.problems];
  if (diff.changed.length || diff.removed.length) problems.push(`install changed base files: ${[...diff.changed, ...diff.removed].slice(0, 20).join(', ')}`);
  summary[task.instance_id] = { ok: problems.length === 0, image: task.image, image_id: imageId, env_image: fact.env_image,
    env_image_id: (await dockerOk(['image', 'inspect', '--format', '{{.Id}}', fact.env_image])).trim(),
    install: fact.install, pretend_version: pretendVersion, grader_image: fact.instance_image, dockerfile_sha256: sha(fs.readFileSync(path.join(dir, 'Dockerfile'))),
    install_added_files: diff.added.length, install_excludes: installExcludes(diff.added), restricted_copies: restricted,
    audit: parsed.sections, problems, build_seconds: Math.round((Date.now() - started) / 1000) };
}

// ── broker 容器与单题环境 ─────────────────────────────────────────────────

export class BrokerContainer {
  constructor({ name, runtime, ledgerDir, logFile }) { Object.assign(this, { name, runtime, ledgerDir, logFile }); this.waiters = []; this.lines = []; }

  async start({ server, token, ledgerName, limits = {} }) {
    if ((await docker(['network', 'inspect', GATEWAY_NETWORK])).code !== 0) {
      await dockerOk(['network', 'create', '--driver', 'bridge', '--label', 'zhiqu.eval=1', '-o', 'com.docker.network.bridge.enable_icc=false', GATEWAY_NETWORK]);
    }
    fs.mkdirSync(this.ledgerDir, { recursive: true, mode: 0o700 });
    await docker(['rm', '-f', this.name]);
    this.child = spawn('docker', ['run', '-i', '--rm', '--name', this.name, '--label', 'zhiqu.eval=1', '--network', GATEWAY_NETWORK,
      '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', '1000:1000', '--sysctl', 'net.ipv4.ip_forward=0', '--memory', '512m', '--pids-limit', '64',
      '--mount', `type=bind,src=${path.join(this.runtime, 'zhiqu')},dst=/opt/zhiqu,readonly`,
      '--mount', `type=bind,src=${this.ledgerDir},dst=/ledger`,
      BROKER_IMAGE, 'node', '/opt/zhiqu/tools/benchmarks/repository-broker.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(this.logFile, { flags: 'a', mode: 0o600 });
    this.child.stderr.pipe(log);
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message; try { message = JSON.parse(line); } catch { message = { type: 'unparsed' }; }
      log.write(`${JSON.stringify(message)}\n`);
      const waiter = this.waiters.shift(); if (waiter) waiter(message); else this.lines.push(message);
    });
    this.exited = new Promise((resolve) => this.child.on('close', resolve));
    // 真实登录只出现在这一行 stdin 里：不打日志、不进参数、不进环境变量
    const ready = await this.send({ ...limits, server, token, ledgerPath: `/ledger/${ledgerName}`, listen: { host: '0.0.0.0', port: BROKER_PORT } });
    if (ready.type !== 'ready') throw new Error(`Broker did not start: ${ready.type}`);
    const inspect = JSON.parse(await dockerOk(['inspect', this.name]))[0];
    this.gatewayIp = inspect.NetworkSettings.Networks[GATEWAY_NETWORK].IPAddress;
    return ready;
  }

  send(message, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Broker management timeout')), timeoutMs);
      const done = (reply) => { clearTimeout(timer); resolve(reply); };
      if (this.lines.length) { done(this.lines.shift()); } else this.waiters.push(done);
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  async status() { return (await this.send({ command: 'status' })).budget; }
  async register(episodeId, capability) {
    const reply = await this.send({ command: 'register', episodeId, capability });
    if (reply.type !== 'registered') throw new Error('Broker refused episode registration');
  }
  async revoke(episodeId) { return this.send({ command: 'revoke', episodeId }); }

  async stop() {
    if (!this.child) return;
    try { await this.send({ command: 'close' }, 60_000); } catch { /* 下面强停 */ }
    this.child.stdin.end();
    const timer = setTimeout(() => docker(['kill', this.name]), 30_000);
    await this.exited; clearTimeout(timer);
  }
}

export class TaskEnv {
  constructor({ ctx, task, tag }) {
    const label = `${task.index}-${tag}`;
    Object.assign(this, { ctx, task, name: `zq-eval-task-${label}`, network: `zq-eval-net-${label}`, volume: `zq-eval-work-${label}`,
      subnet: `10.231.${task.index}.0/24`, brokerIp: `10.231.${task.index}.2`, taskIp: `10.231.${task.index}.3` });
  }

  async up(broker) {
    const limits = this.ctx.config.limits;
    this.broker = broker;
    await dockerOk(['network', 'create', '--internal', '--subnet', this.subnet, '--label', 'zhiqu.eval=1', this.network]);
    await dockerOk(['network', 'connect', '--ip', this.brokerIp, this.network, broker.name]);
    await dockerOk(['create', '--name', this.name, '--label', 'zhiqu.eval=1', '--platform', 'linux/amd64', '--init',
      '--network', this.network, '--ip', this.taskIp, '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', `/tmp:rw,exec,nosuid,size=${limits.container_tmp_bytes}`,
      '--mount', `type=volume,src=${this.volume},dst=/work`,
      '--mount', `type=bind,src=${path.join(this.ctx.runtime, 'node')},dst=/opt/node,readonly`,
      '--mount', `type=bind,src=${path.join(this.ctx.runtime, 'zhiqu')},dst=/opt/zhiqu,readonly`,
      '--memory', String(limits.container_memory_bytes), '--memory-swap', String(limits.container_memory_bytes),
      '--pids-limit', String(limits.container_pids), '--cpus', String(limits.container_cpus),
      '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1', '--entrypoint', '/bin/sleep', this.task.image, 'infinity']);
    await dockerOk(['start', this.name]);
    // 规则由临时的 policy 容器在 task 的网络命名空间里设：只有它在这一下拿 NET_ADMIN，不挂任何卷，设完就删
    const policy = await docker(['run', '--rm', '--network', `container:${this.name}`, '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN',
      '--cap-add', 'NET_RAW', POLICY_IMAGE, 'sh', '-c', policyScript(this.brokerIp)], { timeoutMs: 60_000 });
    if (policy.code !== 0) throw new Error(`Network policy failed: ${policy.stderr.slice(-800)}`);
    this.policyRules = policy.stdout;
    this.policySha256 = policyFingerprint(policy.stdout, this.brokerIp);
    await dockerOk(['exec', '-u', '1000:1000', this.name, '/bin/mkdir', '-p', '/tmp/home']);
  }

  exec(args, options = {}) {
    return docker(['exec', '-i', '-u', '1000:1000', '-w', '/work/base_repo', this.name, ...args], options);
  }

  async probes({ hostGatewayIp, gatewayPort, probeCapability, smoke }) {
    const args = { brokerIp: this.brokerIp, brokerPort: BROKER_PORT, gwBrokerIp: this.broker.gatewayIp, hostGatewayIp, gatewayPort,
      probeCapability, pythonPrefix: '/opt/miniconda3/envs/testbed',
      ...(smoke ? { smokeCommand: this.task.spec.smoke, smokeRead: this.task.spec.read } : {}) };
    const result = await this.exec(['/opt/node/bin/node', '/opt/zhiqu/tools/benchmarks/repository-probes.mjs', JSON.stringify(args)], { timeoutMs: 900_000 });
    try { return JSON.parse(result.stdout.trim().split('\n').at(-1)); } catch { return { ok: false, error: `probe output unreadable (${result.code}): ${result.stderr.slice(-800)}` }; }
  }

  async processCount() {
    const top = await docker(['top', this.name, '-eo', 'pid']);
    return top.code === 0 ? top.stdout.trim().split('\n').length - 1 : 0;
  }

  /** 停整个容器（cgroup 里的每个进程），不是只杀 Node */
  async kill() {
    await docker(['kill', this.name]);
    const state = await docker(['inspect', '--format', '{{.State.Running}} {{.State.Pid}}', this.name]);
    return { running: state.stdout.trim().startsWith('true'), processes_after_kill: await this.processCount() };
  }

  async exportWork(dest) {
    fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
    const tarFile = `${dest}.tar`;
    await dockerOk(['run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--user', '1000:1000', '--read-only',
      '--mount', `type=volume,src=${this.volume},dst=/work,readonly`, '--entrypoint', 'tar', this.task.image,
      '-C', '/work/base_repo', '-cf', '-', '.'], { stdoutFile: tarFile, timeoutMs: 600_000 });
    if (spawnSync('tar', ['-xf', tarFile, '-C', dest]).status !== 0) throw new Error('Could not extract the frozen workspace');
    fs.rmSync(tarFile);
  }

  async down() {
    await docker(['rm', '-f', this.name]);
    await docker(['network', 'disconnect', '-f', this.network, this.broker.name]);
    await docker(['network', 'rm', this.network]);
    await docker(['volume', 'rm', '-f', this.volume]);
    const left = await Promise.all([docker(['ps', '-aq', '--filter', `name=^${this.name}$`]), docker(['network', 'ls', '-q', '--filter', `name=^${this.network}$`]),
      docker(['volume', 'ls', '-q', '--filter', `name=^${this.volume}$`])]);
    return { container_left: Boolean(left[0].stdout.trim()), network_left: Boolean(left[1].stdout.trim()), volume_left: Boolean(left[2].stdout.trim()) };
  }
}

async function hostGateway() {
  // ahostsv4：Docker Desktop 先给 IPv6（fdc4:…::254），任务网络只有 IPv4、探针按 IPv4 去连
  const out = await dockerOk(['run', '--rm', '--network', GATEWAY_NETWORK, POLICY_IMAGE, 'getent', 'ahostsv4', 'host.docker.internal']);
  const ip = out.trim().split(/\s+/)[0];
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error('Could not resolve the Docker host gateway');
  return ip;
}

const capability = () => crypto.randomBytes(32).toString('base64url');
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');

// ── smoke ───────────────────────────────────────────────────────────────

async function smoke(ctx, only) {
  requireRuntime(ctx);
  const images = readJson(path.join(ctx.state, 'images.json'));
  const tag = `s${stamp()}`;
  const dir = path.join(ctx.state, 'smoke'); fs.mkdirSync(dir, { recursive: true });
  // 不接真实网关：上游是 broker 容器里一个连不上的地址，探针里任何东西漏到上游也不会花钱
  const broker = new BrokerContainer({ name: `zq-eval-broker-${tag}`, runtime: ctx.runtime, ledgerDir: path.join(ctx.root, 'smoke-ledger'), logFile: path.join(ctx.root, 'logs', `broker-${tag}.log`) });
  await broker.start({ server: 'http://127.0.0.1:9', token: 'smoke-no-upstream', ledgerName: `smoke-${tag}.jsonl` });
  const results = {};
  let hostGatewayIp = null;
  try {
    hostGatewayIp = await hostGateway();
    for (const task of pick(ctx, only)) {
      if (!images[task.instance_id]?.ok) { results[task.instance_id] = { ok: false, error: 'image_not_ready' }; continue; }
      const env = new TaskEnv({ ctx, task, tag });
      const started = Date.now();
      let record;
      try {
        await env.up(broker);
        const episodeId = `smoke-${task.index}-${tag}`;
        const cap = capability();
        await broker.register(episodeId, cap);
        const probes = await env.probes({ hostGatewayIp, gatewayPort: 47615, probeCapability: cap, smoke: true });
        const revoked = await broker.revoke(episodeId);
        const killed = await env.kill();
        record = { ok: probes.ok && revoked.revoked === true && !killed.running && killed.processes_after_kill === 0,
          policy_sha256: env.policySha256, policy_rules: env.policyRules, probes, revoked: revoked.revoked, killed };
      } catch (error) { record = { ok: false, error: String(error.message || error) }; }
      const left = await env.down();
      record.cleanup = left; record.ok = record.ok && !left.container_left && !left.network_left && !left.volume_left;
      record.seconds = Math.round((Date.now() - started) / 1000);
      results[task.instance_id] = record;
      writeJson(path.join(dir, `${task.instance_id}.json`), record);
      process.stderr.write(`${task.instance_id}: ${record.ok ? 'ok' : `FAILED ${record.error || (record.probes?.results || []).filter((r) => !r.ok).map((r) => r.name).join(',')}`}\n`);
    }
  } finally {
    const budget = await broker.status().catch(() => null);
    await broker.stop();
    results._broker = { accepted_requests: budget?.acceptedRequests, received_requests: budget?.receivedRequests, charged_or_reserved_micro_cny: budget?.chargedOrReservedMicroCny };
  }
  const policies = new Set(Object.values(results).map((r) => r.policy_sha256).filter(Boolean));
  const summary = { ok: Object.entries(results).filter(([k]) => !k.startsWith('_')).every(([, r]) => r.ok) && results._broker.accepted_requests === 0 && policies.size === 1,
    tag, policy_sha256: [...policies], host_gateway_ip: hostGatewayIp, results };
  writeJson(path.join(ctx.state, `smoke-${tag}.json`), summary);
  return { ok: summary.ok, tag, policy_sha256: summary.policy_sha256, failed: Object.entries(results).filter(([k, r]) => !k.startsWith('_') && !r.ok).map(([k]) => k), broker: results._broker };
}

// ── lifecycle ───────────────────────────────────────────────────────────

const LIFECYCLE_SCRIPT = `
const { spawn } = require('node:child_process');
const http = require('node:http');
const [brokerIp, port, cap] = process.argv.slice(1);
// 三个孙子进程各自一个新会话（detached 已经 setsid 过；再调一次会 EPERM 退出）：杀 node 的进程组碰不到它们，只有停整个容器才收得掉
for (let i = 0; i < 3; i++) spawn('python', ['-c', 'import time\\ntime.sleep(3600)'], { detached: true, stdio: 'ignore' }).unref();
const flood = spawn('python', ['-c', 'import sys\\nwhile True: sys.stdout.write("x" * 65536)'], { stdio: ['ignore', 'pipe', 'ignore'] });
flood.stdout.on('data', (chunk) => process.stdout.write(chunk));
const req = http.request({ host: brokerIp, port: Number(port), method: 'POST', path: '/api/harness/model/stream',
  headers: { Authorization: 'Bearer ' + cap, 'Content-Type': 'application/json', 'Content-Length': 100000 } });
req.on('error', () => {});
req.write('{"modelId":6,');
process.stdout.write('\\nLIFECYCLE_READY\\n');
setInterval(() => {}, 1000);
`;

async function lifecycle(ctx, only) {
  requireRuntime(ctx);
  const task = pick(ctx, only || 'psf__requests-1724')[0];
  const tag = `l${stamp()}`;
  const ledgerDir = path.join(ctx.root, 'smoke-ledger');
  const ledgerName = `lifecycle-${tag}.jsonl`;
  const broker = new BrokerContainer({ name: `zq-eval-broker-${tag}`, runtime: ctx.runtime, ledgerDir, logFile: path.join(ctx.root, 'logs', `broker-${tag}.log`) });
  await broker.start({ server: 'http://127.0.0.1:9', token: 'smoke-no-upstream', ledgerName });
  const result = { task: task.instance_id, tag };
  try {
    // 1. 后代进程 + 输出洪泛 + 半路的请求，然后取消：撤销能力、停整个容器
    const env = new TaskEnv({ ctx, task, tag });
    await env.up(broker);
    const episodeId = `lifecycle-${tag}`; const cap = capability();
    await broker.register(episodeId, cap);
    const child = spawn('docker', ['exec', '-i', '-u', '1000:1000', env.name, '/opt/node/bin/node', '-e', LIFECYCLE_SCRIPT, env.brokerIp, String(BROKER_PORT), cap], { stdio: ['pipe', 'pipe', 'pipe'] });
    let seen = 0; let ready = false;
    const readyPromise = new Promise((resolve) => child.stdout.on('data', (chunk) => { seen += chunk.length; if (!ready && chunk.includes('LIFECYCLE_READY')) { ready = true; resolve(); } }));
    const exitPromise = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    await Promise.race([readyPromise, new Promise((resolve) => setTimeout(resolve, 60_000))]);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    result.ready = ready;
    result.processes_before_cancel = await env.processCount();
    result.flood_bytes_seen_before_cancel = seen;
    const status = await broker.status();
    result.broker_before_cancel = { received: status.receivedRequests, accepted: status.acceptedRequests, active: status.activeRequests };
    result.revoked = (await broker.revoke(episodeId)).revoked;
    const killed = await env.kill();
    const exit = await Promise.race([exitPromise, new Promise((resolve) => setTimeout(() => resolve('exec_still_attached'), 30_000))]);
    result.cancel = { ...killed, exec_exit: exit };
    const after = await broker.status();
    result.broker_after_cancel = { received: after.receivedRequests, accepted: after.acceptedRequests, active: after.activeRequests,
      episode_active: after.episodes.find((e) => e.episodeId === episodeId)?.active };
    result.cleanup_cancel = await env.down();

    // 2. 宿主机这一侧的超时：一个不肯结束的「worker」到点整个容器停掉
    const env2 = new TaskEnv({ ctx, task, tag: `${tag}t` });
    await env2.up(broker);
    const timed = await runEpisodeProcess(env2, ['/opt/node/bin/node', '-e', 'setInterval(() => {}, 1000)'], '', 5000);
    result.timeout = { status: timed.status, ...(await env2.kill()) };
    result.cleanup_timeout = await env2.down();
  } finally { await broker.stop(); }
  // 3. 账本：每一个收到的请求都有记录，没有一个被受理（上游一次都没碰），能力有登记有撤销
  const ledger = fs.readFileSync(path.join(ledgerDir, ledgerName), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const count = (event) => ledger.filter((item) => item.event === event).length;
  result.ledger = { received: count('received'), rejected: count('rejected'), accepted: count('accepted'), registered: count('episode_registered'), revoked: count('episode_revoked') };
  result.ok = result.ready && result.processes_before_cancel >= 6 && result.flood_bytes_seen_before_cancel > 1_000_000
    && result.broker_before_cancel.received >= 1 && result.revoked === true && !result.cancel.running && result.cancel.processes_after_kill === 0
    && result.cancel.exec_exit !== 'exec_still_attached' && result.broker_after_cancel.active === 0 && result.broker_after_cancel.episode_active === false
    && result.timeout.status === 'host_timeout' && !result.timeout.running && result.timeout.processes_after_kill === 0
    && result.ledger.accepted === 0 && result.ledger.received >= 1 && result.ledger.received === result.ledger.rejected
    && [result.cleanup_cancel, result.cleanup_timeout].every((c) => !c.container_left && !c.network_left && !c.volume_left);
  writeJson(path.join(ctx.state, `lifecycle-${tag}.json`), result);
  return result;
}

/** 跑一个 episode 进程；宿主机到点就停整个容器。stdout 只收诊断（有上限），候选源码只从卷里收。 */
function runEpisodeProcess(env, argv, input, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('docker', ['exec', '-i', '-u', '1000:1000', '-w', '/work/base_repo', env.name, ...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.on('data', (b) => { if (stdout.length < 20_000_000) stdout += b; });
    child.stderr.on('data', (b) => { if (stderr.length < 100_000) stderr += b; });
    const timer = setTimeout(() => { timedOut = true; docker(['kill', env.name]); }, timeoutMs);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: timedOut ? 'host_timeout' : 'exited', code, stdout, stderr }); });
  });
}

// ── 官方评分 ─────────────────────────────────────────────────────────────

/**
 * 评分走官方 harness 自己的容器网络，不给评分容器加代理变量（第六十九轮试过：老版本 requests 在设了 HTTP(S)_PROXY 时
 * 行为本身就变了 —— HTTPS 拿代理的主机名对证书、会话里没有 proxy_manager —— gold 换了一批测试挂，等于换了题）。
 * 这台 Mac 上 Docker Desktop 替容器经系统代理转发外网，到 httpbin.org 约 4% 回 502：requests 两题的 gold 因此过不了，
 * 记成本机网络没通过，冻结的补丁等网络修好再原样重评（docs/rounds/round-69.md）。
 */
async function grade(ctx, kind, predictions) {
  const python = ctx.python;
  const command = JSON.parse((await run(python, ['-I', PREPARER, 'harness-command', '--control-dir', ctx.control, '--predictions', path.resolve(predictions),
    '--protocol', CONFIG, '--kind', kind, '--python', python])).stdout);
  const argv = harnessArgv(command, python);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8', PYTHONPATH: command.env_overrides.PYTHONPATH,
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) };
  const log = path.join(ctx.root, 'logs', `grade-${command.run_id}.log`);
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const out = fs.openSync(log, 'w');
    const child = spawn(argv[0], argv.slice(1), { cwd: command.cwd, env, stdio: ['ignore', out, out] });
    child.on('close', (code) => { fs.closeSync(out); resolve(code); });
  });
  const reportsDir = path.join(command.cwd, 'logs/run_evaluation', command.run_id);
  const validation = await run(python, ['-I', PREPARER, 'validate-reports', '--control-dir', ctx.control, '--reports-dir', reportsDir, '--kind', kind, '--python', python]);
  let validated = null; try { validated = JSON.parse(validation.stdout); } catch { /* 下面记错误 */ }
  // gold / 基线的门在第一题不过就停；另外按题看一遍（同一套判法），开跑前的检查按题判
  let perTask = null;
  if (kind !== 'candidate') {
    const per = await run(python, ['-I', SUMMARIZER, '--control-dir', ctx.control, '--reports-dir', reportsDir, '--kind', kind, '--python', python]);
    try { perTask = JSON.parse(per.stdout); } catch { perTask = { error: per.stderr.slice(-2000) }; }
  }
  const summary = { kind, run_id: command.run_id, predictions_sha256: command.predictions_sha256, protocol_sha256: command.protocol_sha256,
    per_task: perTask, harness_exit: result, seconds: Math.round((Date.now() - started) / 1000), log, reports_dir: reportsDir,
    validation_ok: validation.code === 0, validation: validated, validation_error: validation.code === 0 ? null : validation.stderr.slice(-2000) };
  writeJson(path.join(ctx.state, `grade-${kind}-${command.run_id}.json`), summary);
  return summary;
}

// ── 正式运行（付费） ───────────────────────────────────────────────────────

async function gatewayModel(config, modelId = config.model.id) {
  const { Api } = await import('../../zhiqu-cli/src/api.js');
  const { DEFAULT_SERVER, loadUserConfig } = await import('../../zhiqu-cli/src/config.js');
  const { selectDeepSeekModel, assertLoopbackServer } = await import('./run-humaneval.mjs');
  const user = loadUserConfig();
  const server = process.env.ZHIQU_SERVER || user.server || DEFAULT_SERVER;
  const token = process.env.ZHIQU_TOKEN || user.token;
  assertLoopbackServer(server);
  if (!token) throw new Error('No existing zhiqu login');
  const model = selectDeepSeekModel(await new Api({ server, token }).get('/api/harness/models', { retry: false, timeoutMs: 5000 }), modelId);
  if (model.modelName !== config.model.model_name || model.effectiveContextWindow !== config.model.expected_context_window_tokens) throw new Error('Gateway model metadata changed');
  const upstream = new URL(server); upstream.hostname = 'host.docker.internal';
  return { model, token, upstream: upstream.origin };
}

/**
 * 开跑之前的门。gold / 基线按题判：每一题要么过，要么 run-config 的 controls_exceptions 里写明了原因和证据
 * （第六十九轮：requests 两题的测试连外网、本机 Docker 网络回 502；两题的红由日志人工核对）。没写的就不开跑。
 */
export function controlProblems({ tasks, images, smokeRun, lifecycleRun, gold, baseline, exceptions = [], executionReady }) {
  const problems = [];
  if (!tasks.every((task) => images[task.instance_id]?.ok)) problems.push('generation images not all audited');
  if (!smokeRun?.ok || Object.keys(smokeRun.results || {}).filter((k) => !k.startsWith('_')).length !== tasks.length) problems.push('smoke not passed for all tasks');
  if (!lifecycleRun?.ok) problems.push('lifecycle smoke not passed');
  const excused = (kind, id) => exceptions.some((e) => e.control === kind && e.instance_id === id
    && typeof e.reason === 'string' && e.reason.length >= 20 && typeof e.evidence === 'string' && e.evidence.length >= 20);
  for (const [kind, run] of [['gold', gold], ['baseline', baseline]]) {
    const rows = run?.per_task?.tasks || [];
    if (rows.length !== tasks.length) { problems.push(`${kind} control has no per-task result for every task`); continue; }
    for (const row of rows) if (!row.ok && !excused(kind, row.instance_id)) problems.push(`${kind} control failed without a recorded exception: ${row.instance_id}`);
  }
  if (executionReady !== true) problems.push('run-config execution_ready is not true');
  return problems;
}

function requireControls(ctx) {
  // 最新一次按修改时间（run_id 带随机后缀，按名字排不是按时间）
  const latest = (prefix) => fs.readdirSync(ctx.state).filter((f) => f.startsWith(prefix))
    .map((f) => path.join(ctx.state, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs).map(readJson).at(-1);
  const images = readJson(path.join(ctx.state, 'images.json'));
  const smokeRun = latest('smoke-');
  const problems = controlProblems({ tasks: ctx.tasks, images, smokeRun, lifecycleRun: latest('lifecycle-'), gold: latest('grade-gold-'),
    baseline: latest('grade-baseline-'), exceptions: ctx.config.controls_exceptions, executionReady: ctx.config.execution_ready });
  if (problems.length) throw new Error(`Refusing paid run: ${problems.join('; ')}`);
  return { images, smoke: smokeRun };
}

const CALIBRATION_SCRIPT = `
import('/opt/zhiqu/zhiqu-cli/src/api.js').then(async ({ Api }) => {
  const [server, cap, modelId] = process.argv.slice(1);
  const api = new Api({ server, token: cap });
  const seen = {};
  // 256：网关的输出上限最少给 256（HarnessModelGateway.maxTokens），要 16 会让 start 里的 256 超过请求、broker 按协议停下（第六十九轮踩过）
  await api.stream('/api/harness/model/stream', { modelId: Number(modelId), maxTokens: 256, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], tools: [] },
    (name, data) => { if (name === 'start') seen.start = { id: data.model?.id, modelName: data.model?.modelName, contextWindow: data.contextWindow };
      if (name === 'delta') seen.text = (seen.text || '') + (data.text || data.content || '');
      if (name === 'done') seen.done = { finishReason: data.finishReason, usage: data.usage }; });
  process.stdout.write(JSON.stringify(seen) + '\\n');
});`;

export const PILOT_LIMITS = Object.freeze({ limitMicroCny: 50_000_000, inputTokenLimit: 4_000_000, outputTokenLimit: 500_000 });

/**
 * 一本账按 broker 的记法重放：受理时按上界预留，有核实过的用量就换成实际值，没有就一直按预留算（宁多勿少）。
 * 账里出现过 halted / invalid_usage 就是停了的账：broker 以后都不受理，要换一本新的接着记（第六十九轮：校准请求踩了协议，账停了）。
 */
export function replayLedger(lines) {
  const accepted = new Map();
  let input = 0; let output = 0; let halted = false;
  for (const item of lines) {
    if (item.event === 'accepted') { accepted.set(item.requestId, item); input += item.inputUpperTokens; output += item.reservedOutputTokens; }
    else if (item.event === 'settled_verified') {
      const a = accepted.get(item.requestId);
      input += item.promptTokens - a.inputUpperTokens; output += item.completionTokens - a.reservedOutputTokens;
    } else if (item.event === 'halted' || item.event === 'invalid_usage') halted = true;
  }
  return { input, output, microCny: input * 9 + output * 27, halted };
}

/**
 * 这次用哪本账、额度多少。最新那本没停：接着用它（broker 从里面恢复已花的）。停了：开下一本，额度是 ¥50 减去之前每一本花掉 / 留着的。
 * 账本只增不删，总额永远不超过用户定的 ¥50。
 */
export function pilotLedger(ledgerDir, prefix = 'pilot-20261014', base = PILOT_LIMITS) {
  const name = new RegExp(`^${prefix}(-\\d+)?\\.jsonl$`);
  const books = fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir).filter((f) => name.test(f))
    .sort((a, b) => bookNumber(a, prefix) - bookNumber(b, prefix)) : [];
  const read = (f) => fs.readFileSync(path.join(ledgerDir, f), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const replays = books.map((f) => ({ file: f, ...replayLedger(read(f)) }));
  const last = replays.at(-1);
  if (last && !last.halted) {
    const before = replays.slice(0, -1);
    return { ledgerName: last.file, limits: limitsAfter(before, base), carried: before };
  }
  return { ledgerName: books.length ? `${prefix}-${books.length}.jsonl` : `${prefix}.jsonl`, limits: limitsAfter(replays, base), carried: replays };
}

// <prefix>.jsonl 是第 0 本（只认 -N 后缀：日期里的数字不是序号）
const bookNumber = (name, prefix) => Number((new RegExp(`^${prefix}-(\\d+)\\.jsonl$`).exec(name) || [0, 0])[1]);

function limitsAfter(books, base = PILOT_LIMITS) {
  const used = books.reduce((sum, b) => ({ input: sum.input + b.input, output: sum.output + b.output, micro: sum.micro + b.microCny }), { input: 0, output: 0, micro: 0 });
  const limits = { limitMicroCny: base.limitMicroCny - used.micro, inputTokenLimit: base.inputTokenLimit - used.input,
    outputTokenLimit: base.outputTokenLimit - used.output };
  if (Object.values(limits).some((v) => !Number.isSafeInteger(v) || v <= 0)) throw new Error('Pilot budget is used up across earlier ledgers');
  return limits;
}

/** 这一题在之前同一类（pilot- / continuation-）的正式运行里已经起过 episode（不管结果）：返回那次的 runId */
function previousEpisode(ctx, instanceId, kind = 'pilot-') {
  const runs = path.join(ctx.root, 'runs');
  if (!fs.existsSync(runs)) return null;
  return fs.readdirSync(runs).filter((run) => run.startsWith(kind)).sort().find((run) => {
    const file = path.join(runs, run, instanceId, 'result.json');
    return fs.existsSync(file) && readJson(file).status !== 'budget_stopped';
  }) || null;
}

/**
 * 补跑（第六十九轮，用户 2026-10-18）：ID 6 那组按预算停下，被打断的题按 run-config 的 continuation 用另一个已批准的 ID
 * （同一个 deepseek-v4-pro）各跑一次新的 episode，不论结果都替换被打断的那次；两次记录都留。题目、模型、额度都在调用之前写进 run-config。
 */
export function continuationPlan(config) {
  const plan = config.continuation;
  if (!plan || !Number.isSafeInteger(plan.model?.id) || plan.model.model_name !== config.model.model_name
      || plan.model.expected_context_window_tokens !== config.model.expected_context_window_tokens
      || !Array.isArray(plan.instance_ids) || !plan.instance_ids.length || typeof plan.ledger_prefix !== 'string' || !/^[a-z0-9-]+$/.test(plan.ledger_prefix)
      || !(plan.budget?.limit_rmb > 0 && plan.budget.limit_rmb <= 50) || !Number.isSafeInteger(plan.budget.input_token_limit)
      || !Number.isSafeInteger(plan.budget.output_token_limit)) throw new Error('run-config continuation is missing or incomplete');
  return { ...plan, limits: { limitMicroCny: Math.round(plan.budget.limit_rmb * 1_000_000), inputTokenLimit: plan.budget.input_token_limit,
    outputTokenLimit: plan.budget.output_token_limit } };
}

async function formalRun(ctx, { continuation = false } = {}) {
  requireRuntime(ctx);
  const { images, smoke: smokeRun } = requireControls(ctx);
  const plan = continuation ? continuationPlan(ctx.config) : null;
  if (plan && !plan.instance_ids.every((id) => ctx.tasks.some((task) => task.instance_id === id))) throw new Error('continuation lists an unknown task');
  const modelId = plan ? plan.model.id : ctx.config.model.id;
  const kind = plan ? 'continuation-' : 'pilot-';
  const { model, token, upstream } = await gatewayModel(ctx.config, modelId);
  const runId = `${kind}${stamp()}`;
  const dir = path.join(ctx.root, 'runs', runId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 账本固定在 <eval>/ledger：中途停了再跑，broker 从账里恢复已花的；账停过就开下一本、额度扣掉之前的（pilotLedger）
  const ledger = plan ? pilotLedger(path.join(ctx.root, 'ledger'), plan.ledger_prefix, plan.limits) : pilotLedger(path.join(ctx.root, 'ledger'));
  writeJson(path.join(dir, 'ledger-choice.json'), ledger);
  const broker = new BrokerContainer({ name: `zq-eval-broker-${runId}`, runtime: ctx.runtime, ledgerDir: path.join(ctx.root, 'ledger'), logFile: path.join(dir, 'broker.log') });
  await broker.start({ server: upstream, token, ledgerName: ledger.ledgerName, limits: { ...ledger.limits, modelId } });
  const results = {};
  let hostGatewayIp = null;
  const manifest = { run_id: runId, started_at: new Date().toISOString(), model, continuation: plan, config_sha256: sha(fs.readFileSync(CONFIG)),
    runtime: readJson(path.join(ctx.state, 'runtime.json')), smoke_tag: smokeRun.tag, policy_sha256: smokeRun.policy_sha256, images };
  writeJson(path.join(dir, 'manifest.json'), manifest);
  try {
    hostGatewayIp = await hostGateway();
    // 校准：一次最小的真实请求走完整条路（task 网络 → broker → 网关），核对模型、入同一本账
    const first = ctx.tasks[0];
    const calibrationEnv = new TaskEnv({ ctx, task: first, tag: `${runId.slice(-6)}c` });
    await calibrationEnv.up(broker);
    const calCap = capability();
    await broker.register('calibration', calCap);
    const cal = await calibrationEnv.exec(['/opt/node/bin/node', '-e', CALIBRATION_SCRIPT, `http://${calibrationEnv.brokerIp}:${BROKER_PORT}`, calCap, String(modelId)], { timeoutMs: 300_000 });
    await broker.revoke('calibration'); await calibrationEnv.kill(); await calibrationEnv.down();
    let calibration = null; try { calibration = JSON.parse(cal.stdout.trim().split('\n').at(-1)); } catch { /* 下面判 */ }
    writeJson(path.join(dir, 'calibration.json'), { calibration, exit: cal.code, stderr: cal.stderr.slice(-1000), budget: await broker.status() });
    if (calibration?.start?.id !== modelId || calibration.start.modelName !== 'deepseek-v4-pro' || calibration.start.contextWindow !== 1_000_000 || !calibration.done) {
      throw new Error(`Calibration did not verify model ${modelId} / deepseek-v4-pro / 1M through the broker`);
    }

    for (const task of plan ? ctx.tasks.filter((t) => plan.instance_ids.includes(t.instance_id)) : ctx.tasks) {
      const earlier = previousEpisode(ctx, task.instance_id, kind);
      if (earlier) { results[task.instance_id] = { status: 'already_run', run: earlier }; continue; }   // 协议：不重生成择优
      const taskDir = path.join(dir, task.instance_id); fs.mkdirSync(taskDir, { recursive: true });
      const before = await broker.status();
      if (before.halted) { results[task.instance_id] = { status: 'budget_stopped', reason: before.haltReason }; writeJson(path.join(taskDir, 'result.json'), results[task.instance_id]); continue; }
      const env = new TaskEnv({ ctx, task, tag: runId.slice(-6) });
      const record = { instance_id: task.instance_id, started_at: new Date().toISOString() };
      try {
        await env.up(broker);
        record.policy_sha256 = env.policySha256;
        const probes = await env.probes({ hostGatewayIp, gatewayPort: Number(new URL(upstream).port), probeCapability: null, smoke: false });
        record.probes_ok = probes.ok;
        if (!probes.ok) { record.status = 'isolation_failed'; record.probes = probes; }
        else {
          const cap = capability();
          await broker.register(task.instance_id, cap);
          const payload = workerPayload({ task, model, brokerIp: env.brokerIp, capability: cap, config: ctx.config });
          const episode = await runEpisodeProcess(env, ['/opt/node/bin/node', '/opt/zhiqu/tools/benchmarks/repository-worker.mjs'],
            JSON.stringify(payload), ctx.config.limits.episode_seconds * 1000 + 120_000);
          record.revoked = (await broker.revoke(task.instance_id)).revoked;
          record.process = { status: episode.status, code: episode.code, stderr_tail: episode.stderr.slice(-2000) };
          let diagnostic = null; try { diagnostic = JSON.parse(episode.stdout.trim().split('\n').at(-1)); } catch { /* 记成缺 */ }
          if (diagnostic) writeJson(path.join(taskDir, 'worker.json'), diagnostic);
          record.generation_status = diagnostic?.generation_status || (episode.status === 'host_timeout' ? 'host_timeout' : 'worker_output_missing');
          record.rounds = diagnostic?.rounds; record.model_requests = diagnostic?.model_requests;
          record.usage = diagnostic?.usage; record.duration_ms = diagnostic?.duration_ms;
        }
        record.kill = await env.kill();
        await env.exportWork(path.join(taskDir, 'final'));
        const excludes = [...GENERATED_EXCLUDES, ...images[task.instance_id].install_excludes];
        const collected = await run(ctx.python, ['-I', PREPARER, 'collect-patch', '--control-dir', ctx.control, '--instance-id', task.instance_id,
          '--final-workspace', path.join(taskDir, 'final'), '--workspace-stopped', '--output-dir', path.join(taskDir, 'collected'),
          ...excludes.flatMap((pattern) => ['--exclude', pattern])]);
        record.collection = collected.code === 0 ? JSON.parse(collected.stdout) : { error: collected.stderr.slice(-2000) };
      } catch (error) { record.status = 'infrastructure_error'; record.error = String(error.message || error); }
      record.cleanup = await env.down();
      record.broker_after = (await broker.status()).episodes.find((e) => e.episodeId === task.instance_id) || null;
      record.finished_at = new Date().toISOString();
      results[task.instance_id] = record;
      writeJson(path.join(taskDir, 'result.json'), record);
      process.stderr.write(`${task.instance_id}: ${record.generation_status || record.status} patch=${record.collection?.patch_bytes ?? '-'}\n`);
    }
  } finally {
    const budget = await broker.status().catch(() => null);
    await broker.stop();
    writeJson(path.join(dir, 'budget.json'), budget);
  }
  // 预测：固定十行；没生成出补丁的题也在分母里（空补丁），状态另记。补跑时：补跑的题用补跑的那次，其余用 pilot 那次
  const sourceRun = (task) => {
    if (results[task.instance_id]?.status === 'already_run') return path.join(ctx.root, 'runs', results[task.instance_id].run);
    if (results[task.instance_id]) return dir;
    const pilot = previousEpisode(ctx, task.instance_id, 'pilot-');
    return pilot ? path.join(ctx.root, 'runs', pilot) : dir;
  };
  const rows = ctx.tasks.map((task) => {
    const from = sourceRun(task);
    const file = path.join(from, task.instance_id, 'collected/prediction.json');
    return fs.existsSync(file) ? readJson(file) : { instance_id: task.instance_id, model_name_or_path: 'zhiqu-cli-deepseek-v4-pro', model_patch: '' };
  });
  const predictions = path.join(dir, 'predictions.jsonl');
  fs.writeFileSync(predictions, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  writeJson(path.join(dir, 'results.json'), results);
  const graded = await grade(ctx, 'candidate', predictions);
  writeJson(path.join(dir, 'grade.json'), graded);
  return { run_id: runId, dir, graded: graded.validation };
}

// ── 入口 ────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--continuation') { opts.continuation = true; continue; }
    const key = { '--eval-dir': 'evalDir', '--only': 'only', '--kind': 'kind', '--predictions': 'predictions' }[rest[i]];
    if (!key || !rest[i + 1]) throw new Error(`Unknown or incomplete option: ${rest[i]}`);
    opts[key] = rest[++i];
  }
  if (!['runtime', 'images', 'smoke', 'lifecycle', 'grade', 'run'].includes(command)) throw new Error('Choose runtime | images | smoke | lifecycle | grade | run');
  if (!opts.evalDir) throw new Error('--eval-dir is required');
  if (command === 'grade' && (!['gold', 'baseline', 'candidate'].includes(opts.kind) || !opts.predictions)) throw new Error('grade needs --kind and --predictions');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ctx = context(opts.evalDir);
  fs.mkdirSync(ctx.state, { recursive: true, mode: 0o700 }); fs.mkdirSync(path.join(ctx.root, 'logs'), { recursive: true });
  const result = opts.command === 'runtime' ? await stageRuntime(ctx)
    : opts.command === 'images' ? await buildImages(ctx, opts.only)
      : opts.command === 'smoke' ? await smoke(ctx, opts.only)
        : opts.command === 'lifecycle' ? await lifecycle(ctx, opts.only)
          : opts.command === 'grade' ? await grade(ctx, opts.kind, opts.predictions)
            : await formalRun(ctx, { continuation: opts.continuation });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // broker 子进程（docker run -i）开着就退不出去：出错直接退，别挂着（容器靠 --rm 和 stdin 关闭收掉）
  main().catch((error) => { process.stderr.write(`repository-docker: ${error.message}\n`); process.exit(1); });
}
