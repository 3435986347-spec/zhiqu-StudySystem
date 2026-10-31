// 仓库评测 Docker 编排里不碰 Docker 的那部分（第六十九轮）：网络规则、排除规则、生成镜像的写法、审计的判法、评分命令的改写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditScript, BROKER_PORT, compareTrees, continuationPlan, controlProblems, pilotLedger, previousEpisode, replayLedger, rerunPlan, parseArgs, fnmatchEscape, GENERATED_EXCLUDES, generationDockerfile, globMatch,
  harnessArgv, installExcludes, parseAudit, policyFingerprint, policyScript, REPO_SPECS, workerPayload } from './repository-docker.mjs';

test('网络规则：默认丢弃、先挡 Docker DNS 和 53 端口、只放行 loopback 和 broker 的那一个端口、IPv6 全丢', () => {
  const rules = policyScript('10.231.3.2').split('\n');
  const at = (line) => rules.indexOf(line);
  assert.ok(at('iptables -P OUTPUT DROP') > 0);
  assert.ok(at('iptables -A OUTPUT -d 127.0.0.11 -j DROP') > 0, 'Docker 内嵌 DNS 经 DNAT 之后端口不是 53，要按地址挡');
  assert.ok(at('iptables -A OUTPUT -d 127.0.0.11 -j DROP') < at('iptables -A OUTPUT -o lo -d 127.0.0.0/8 -j ACCEPT'), '放行 loopback 之前先挡 127.0.0.11');
  assert.ok(at('iptables -A OUTPUT -p udp --dport 53 -j DROP') > 0 && at('iptables -A OUTPUT -p tcp --dport 53 -j DROP') > 0);
  assert.ok(at(`iptables -A OUTPUT -p tcp -d 10.231.3.2 --dport ${BROKER_PORT} -j ACCEPT`) > 0);
  assert.ok(at('ip6tables -P OUTPUT DROP') > 0);
  assert.equal(rules.filter((line) => / -j ACCEPT$/.test(line)).length, 2, '放行的只有 loopback 和 broker');
  assert.throws(() => policyScript('172.17.0.2'), /broker address/);
  assert.throws(() => policyScript('10.231.3.2; iptables -F'), /broker address/);
});

test('规则指纹去掉随题目变的 broker 地址：十题同一个哈希，规则别处变了哈希就变', () => {
  const a = policyFingerprint(policyScript('10.231.1.2'), '10.231.1.2');
  assert.equal(policyFingerprint(policyScript('10.231.9.2'), '10.231.9.2'), a);
  assert.notEqual(policyFingerprint(policyScript('10.231.1.2').replace('ip6tables -P OUTPUT DROP', ''), '10.231.1.2'), a);
});

test('globMatch 和收集器用的 Python fnmatchcase 一致（* 跨目录、[] 转义）', () => {
  const python = spawnSync('python3', ['-I', '-c', `import fnmatch,json,sys
cases=json.loads(sys.argv[1])
print(json.dumps([fnmatch.fnmatchcase(n,p) for p,n in cases]))`, JSON.stringify([
    ['*.so', 'sklearn/tree/_tree.cpython-36m-x86_64-linux-gnu.so'], ['build/*', 'build/lib/x.py'], ['build/*', 'src/build/x.py'],
    ['*__pycache__/*', '__pycache__/a.pyc'], ['*__pycache__/*', 'pkg/__pycache__/a.pyc'], ['*.egg-info/*', 'Django.egg-info/PKG-INFO'],
    ['.pytest_cache/*', 'testing/.pytest_cache/v'], [fnmatchEscape('a[1]*?.py'), 'a[1]*?.py'], [fnmatchEscape('a[1]*?.py'), 'a1xx.py'],
    ['*.pyc', 'x.py'], ['.cache/*', '.cache/matplotlib/fontlist.json'],
  ])], { encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  const expected = JSON.parse(python.stdout);
  const ours = [['*.so', 'sklearn/tree/_tree.cpython-36m-x86_64-linux-gnu.so'], ['build/*', 'build/lib/x.py'], ['build/*', 'src/build/x.py'],
    ['*__pycache__/*', '__pycache__/a.pyc'], ['*__pycache__/*', 'pkg/__pycache__/a.pyc'], ['*.egg-info/*', 'Django.egg-info/PKG-INFO'],
    ['.pytest_cache/*', 'testing/.pytest_cache/v'], [fnmatchEscape('a[1]*?.py'), 'a[1]*?.py'], [fnmatchEscape('a[1]*?.py'), 'a1xx.py'],
    ['*.pyc', 'x.py'], ['.cache/*', '.cache/matplotlib/fontlist.json']].map(([p, n]) => globMatch(p, n));
  assert.deepEqual(ours, expected);
  assert.ok(expected.includes(true) && expected.includes(false), '样本两边都要有');
});

test('安装多出来的文件：通用规则管得到的不重复列，剩下的逐个精确列出（带转义）', () => {
  const excludes = installExcludes(['Django.egg-info/PKG-INFO', 'sklearn/_isotonic.c', 'build/temp/x.o', 'src/_pytest/_version.py', 'odd[1].txt']);
  assert.deepEqual(excludes, ['sklearn/_isotonic.c', 'src/_pytest/_version.py', 'odd[[]1].txt']);
  assert.ok(excludes.every((pattern) => !GENERATED_EXCLUDES.includes(pattern)));
});

test('树比较：新文件、改过的、删掉的分开', () => {
  const base = { 'a.py': 'file:-:1', 'b.py': 'file:-:2', 'run.sh': 'file:x:3' };
  const final = { 'a.py': 'file:-:1', 'b.py': 'file:-:9', 'run.sh': 'file:-:3', 'new.py': 'file:-:4' };
  assert.deepEqual(compareTrees(base, final), { added: ['new.py'], changed: ['b.py', 'run.sh'], removed: [] });
  assert.deepEqual(compareTrees(final, base).removed, ['new.py']);
});

test('生成镜像：从官方 env 镜像起、只拷导出的 base、照官方 install、删 /testbed、别的版本只留给 root、最后是非 root', () => {
  const text = generationDockerfile({ envImage: 'sweb.env.py.x86_64.abc:latest', install: 'python -m pip install -e .', modules: REPO_SPECS['pytest-dev/pytest'].modules });
  const lines = text.split('\n');
  assert.equal(lines.filter((line) => line.startsWith('FROM ')).length, 1);
  assert.match(text, /^FROM --platform=linux\/amd64 sweb\.env\.py\.x86_64\.abc:latest$/m);
  assert.doesNotMatch(text, /sweb\.eval|swebench\//, '不能拿官方 instance 镜像当生成镜像或它的祖先');
  assert.equal(lines.filter((line) => line.startsWith('COPY ')).join('|'), 'COPY --chown=1000:1000 base_repo /work/base_repo');
  assert.match(text, /conda activate testbed && python -m pip install -e \./);
  assert.match(text, /rm -rf \/testbed/);
  assert.match(text, /chmod 700 \/opt\/miniconda3\/pkgs \/root/);
  assert.match(text, /restrict _pytest \/work\/base_repo\/src\/_pytest && restrict pytest \/work\/base_repo\/src\/pytest/);
  assert.equal(lines.filter((line) => line.startsWith('USER ')).at(-1), 'USER 1000:1000');
  assert.ok(lines.findIndex((line) => line.startsWith('USER ')) > lines.findIndex((line) => line.includes('restrict()')), '收权限要在切到非 root 之前');
  assert.doesNotMatch(text, /SETUPTOOLS_SCM_PRETEND_VERSION/, '没有给版本号就不该设');
  const scm = generationDockerfile({ envImage: 'e:latest', install: 'python -m pip install -e .', modules: [['_pytest', 'src/_pytest']], pretendVersion: '7.2.0.dev312+g3c1534944' });
  assert.match(scm, /bash -c 'export SETUPTOOLS_SCM_PRETEND_VERSION=7\.2\.0\.dev312\+g3c1534944 && source \/opt\/miniconda3/);
  assert.throws(() => generationDockerfile({ envImage: 'e', install: 'i', modules: [], pretendVersion: "7.2'; rm -rf /" }), /version/);
});

const AUDIT_OK = ['### git', '### copies', 'identical /opt/miniconda3/envs/testbed/lib/python3.9/site-packages/requests',
  'unreadable /opt/miniconda3/lib/python3.11/site-packages/requests', '### archives', '### import', '/work/base_repo/requests/__init__.py',
  '### testbed', 'ls: cannot access \'/testbed\': No such file or directory', '### work', 'base_repo', '### eval-materials',
  '### root', 'ls: cannot open directory \'/root\': Permission denied', '### end'].join('\n');

test('审计：干净的样本过；Git、读得到的不同版本、压缩包、评估脚本、/testbed、/root 可读、没跑完各自都不过', () => {
  assert.deepEqual(parseAudit(AUDIT_OK).problems, []);
  const broken = {
    git: AUDIT_OK.replace('### copies', '/opt/x/.git\n### copies'),
    different: AUDIT_OK.replace('unreadable /opt', 'DIFFERENT /opt'),
    archive: AUDIT_OK.replace('### import', '/home/x/requests-2.31.0-py3-none-any.whl\n### import'),
    evalScript: AUDIT_OK.replace('### root', '/eval.sh\n### root'),
    testbed: AUDIT_OK.replace("ls: cannot access '/testbed': No such file or directory", '.git'),
    work: AUDIT_OK.replace('### work\nbase_repo', '### work\nbase_repo\nother_task'),
    root: AUDIT_OK.replace('Permission denied', 'x'),
    unfinished: AUDIT_OK.replace('### end', ''),
  };
  for (const [name, text] of Object.entries(broken)) assert.equal(parseAudit(text).ok, false, name);
});

test('审计脚本：每个模块都查、压缩包按发行包名、import 从 /tmp 起（不让当前目录遮住）', () => {
  const script = auditScript(REPO_SPECS['pytest-dev/pytest'].modules, 'pytest');
  assert.match(script, /copies _pytest \/work\/base_repo\/src\/_pytest; copies pytest \/work\/base_repo\/src\/pytest/);
  assert.match(script, /-iname 'pytest-\[0-9\]\*\.whl'/);
  assert.match(script, /cd \/tmp && python -c "import _pytest/);
});

test('评分命令：只把 -m swebench.harness.run_evaluation 换成固定的 x86 包装，其它参数原样', () => {
  const command = { argv: ['/py', '-m', 'swebench.harness.run_evaluation', '--dataset_name', 'd.json', '--run_id', 'r'] };
  assert.deepEqual(harnessArgv(command, '/py', '/w.py'), ['/py', '/w.py', '--dataset_name', 'd.json', '--run_id', 'r']);
  assert.throws(() => harnessArgv({ argv: ['/py', 'other.py', '--x'] }, '/py', '/w.py'), /shape/);
});

test('worker 的输入：只有公开的四个字段、broker 是固定私有地址、带 capability 不带真实令牌', () => {
  const payload = workerPayload({ task: { repo: 'psf/requests', instance_id: 'psf__requests-1724', base_commit: 'a'.repeat(40), problem_statement: 'x',
    version: '2.0', FAIL_TO_PASS: '["hidden"]', patch: 'gold' }, model: { id: 6, label: 'l', modelName: 'deepseek-v4-pro', providerType: 'p',
    toolCalling: true, contextWindowTokens: 1_000_000, effectiveContextWindow: 1_000_000 }, brokerIp: '10.231.8.2', capability: 'c'.repeat(43),
  config: { agent: { commit: 'b'.repeat(40), cli_git_tree: 'c'.repeat(40) } } });
  assert.deepEqual(Object.keys(payload.task).sort(), ['base_commit', 'instance_id', 'problem_statement', 'repo']);
  assert.equal(payload.broker.server, `http://10.231.8.2:${BROKER_PORT}/`);
  assert.equal(payload.workspace, '/work');
  assert.doesNotMatch(JSON.stringify(payload), /hidden|gold|zqp_/);
});


test('开跑前的门：gold / 基线按题判，没过的题必须在 run-config 里写明原因和证据；镜像、smoke、生命周期、execution_ready 缺一不可', () => {
  const tasks = ['a', 'b'].map((instance_id) => ({ instance_id }));
  const ok = (id) => ({ instance_id: id, ok: true });
  const base = { tasks, images: { a: { ok: true }, b: { ok: true } }, smokeRun: { ok: true, results: { a: {}, b: {}, _broker: {} } },
    lifecycleRun: { ok: true }, gold: { per_task: { tasks: [ok('a'), ok('b')] } }, baseline: { per_task: { tasks: [ok('a'), ok('b')] } },
    exceptions: [], executionReady: true };
  assert.deepEqual(controlProblems(base), []);
  const goldB = { per_task: { tasks: [ok('a'), { instance_id: 'b', ok: false }] } };
  assert.match(controlProblems({ ...base, gold: goldB }).join(), /gold control failed without a recorded exception: b/);
  const why = { control: 'gold', instance_id: 'b', reason: '测试连外网，本机 Docker 转发回 502（三遍都是）', evidence: 'state/grade-gold-*.json: network_symptom_in_log' };
  assert.deepEqual(controlProblems({ ...base, gold: goldB, exceptions: [why] }), []);
  assert.equal(controlProblems({ ...base, gold: goldB, exceptions: [{ ...why, control: 'baseline' }] }).length, 1, '基线的例外不能顶 gold');
  assert.equal(controlProblems({ ...base, gold: goldB, exceptions: [{ ...why, reason: '网络' }] }).length, 1, '一句话的理由不算写明');
  assert.match(controlProblems({ ...base, gold: { per_task: { tasks: [ok('a')] } } }).join(), /no per-task result/);
  assert.match(controlProblems({ ...base, gold: { validation_ok: false } }).join(), /no per-task result/);
  assert.match(controlProblems({ ...base, images: { a: { ok: true } } }).join(), /images/);
  assert.match(controlProblems({ ...base, smokeRun: { ok: true, results: { a: {} } } }).join(), /smoke/);
  assert.match(controlProblems({ ...base, lifecycleRun: null }).join(), /lifecycle/);
  assert.match(controlProblems({ ...base, executionReady: false }).join(), /execution_ready/);
});

test('账本重放和 broker 同一个记法：受理按上界预留，核实过的换成实际，没核实的一直按预留；停过的账认得出来', () => {
  const lines = [{ event: 'init' }, { event: 'accepted', requestId: 'a', inputUpperTokens: 1000, reservedOutputTokens: 16384 },
    { event: 'settled_verified', requestId: 'a', promptTokens: 300, completionTokens: 50 },
    { event: 'accepted', requestId: 'b', inputUpperTokens: 4463, reservedOutputTokens: 16384 }, { event: 'settled_unknown', requestId: 'b' }];
  assert.deepEqual(replayLedger(lines), { input: 300 + 4463, output: 50 + 16384, microCny: (300 + 4463) * 9 + (50 + 16384) * 27, halted: false });
  assert.equal(replayLedger([...lines, { event: 'halted', reason: 'wrong_sse_start' }]).halted, true);
});

test('账停了就开下一本、额度扣掉之前花的和留着的；没停就接着用最新那本；总额不超过 ¥50，用完了拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-ledger-'));
  const write = (name, lines) => fs.writeFileSync(path.join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.deepEqual(pilotLedger(dir).limits, { limitMicroCny: 50_000_000, inputTokenLimit: 4_000_000, outputTokenLimit: 500_000 });
  assert.equal(pilotLedger(dir).ledgerName, 'pilot-20261014.jsonl');
  write('pilot-20261014.jsonl', [{ event: 'accepted', requestId: 'a', inputUpperTokens: 4463, reservedOutputTokens: 16384 }, { event: 'halted', reason: 'x' }]);
  const next = pilotLedger(dir);
  assert.equal(next.ledgerName, 'pilot-20261014-1.jsonl');
  assert.deepEqual(next.limits, { limitMicroCny: 50_000_000 - 482_535, inputTokenLimit: 4_000_000 - 4463, outputTokenLimit: 500_000 - 16384 });
  write('pilot-20261014-1.jsonl', [{ event: 'accepted', requestId: 'b', inputUpperTokens: 100, reservedOutputTokens: 100 }]);
  const resume = pilotLedger(dir);
  assert.equal(resume.ledgerName, 'pilot-20261014-1.jsonl', '没停的账接着用（broker 从里面恢复已花的）');
  assert.deepEqual(resume.limits, next.limits, '接着用同一本时额度必须和开这本时一样（broker 会核对）');
  write('pilot-20261014-1.jsonl', [{ event: 'accepted', requestId: 'b', inputUpperTokens: 3_995_537, reservedOutputTokens: 100 }, { event: 'halted', reason: 'run_budget' }]);
  assert.throws(() => pilotLedger(dir), /used up/);
});

test('补跑的计划要在 run-config 里写全：同一个模型名和窗口、题目、账本前缀、¥50 以内的额度；缺一项就不跑', () => {
  const config = { model: { id: 6, model_name: 'deepseek-v4-pro', expected_context_window_tokens: 1_000_000 },
    continuation: { model: { id: 1, model_name: 'deepseek-v4-pro', expected_context_window_tokens: 1_000_000 }, instance_ids: ['psf__requests-1724'],
      ledger_prefix: 'continuation-id1-20261018', budget: { limit_rmb: 50, input_token_limit: 4_000_000, output_token_limit: 500_000 } } };
  assert.deepEqual(continuationPlan(config).limits, { limitMicroCny: 50_000_000, inputTokenLimit: 4_000_000, outputTokenLimit: 500_000 });
  const broken = (patch) => ({ ...config, continuation: { ...config.continuation, ...patch } });
  for (const [name, patch] of [['other model', { model: { ...config.continuation.model, model_name: 'deepseek-chat' } }],
    ['other window', { model: { ...config.continuation.model, expected_context_window_tokens: 64_000 } }], ['no tasks', { instance_ids: [] }],
    ['over budget', { budget: { ...config.continuation.budget, limit_rmb: 51 } }], ['bad prefix', { ledger_prefix: '../x' }]]) {
    assert.throws(() => continuationPlan(broken(patch)), /continuation/, name);
  }
  assert.throws(() => continuationPlan({ model: config.model }), /continuation/);
});

test('补跑用自己的账本前缀，和 pilot 那几本分开记', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-ledger-c-'));
  fs.writeFileSync(path.join(dir, 'pilot-20261014-1.jsonl'), JSON.stringify({ event: 'accepted', requestId: 'a', inputUpperTokens: 3_000_000, reservedOutputTokens: 1 }) + '\n');
  const plan = pilotLedger(dir, 'continuation-id1-20261018', { limitMicroCny: 50_000_000, inputTokenLimit: 4_000_000, outputTokenLimit: 500_000 });
  assert.equal(plan.ledgerName, 'continuation-id1-20261018.jsonl');
  assert.deepEqual(plan.limits, { limitMicroCny: 50_000_000, inputTokenLimit: 4_000_000, outputTokenLimit: 500_000 }, 'pilot 的账不扣补跑的额度');
});

// 第八十七轮：同样十题换一版 agent 重跑 —— 另一份 run-config、自己的 run 前缀和账本，额度是用户定的 ¥100 以内
test('重跑的计划要在 run-config 里写全：前缀对得上、¥100 以内、token 上限按价算不超过钱数；缺一项就不跑', () => {
  const config = { rerun: { run_prefix: 'rerun-20261031-', ledger_prefix: 'rerun-20261031' },
    budget: { limit_rmb: 100, input_token_limit: 8_000_000, output_token_limit: 1_000_000 } };
  assert.deepEqual(rerunPlan(config).limits, { limitMicroCny: 100_000_000, inputTokenLimit: 8_000_000, outputTokenLimit: 1_000_000 });
  assert.equal(rerunPlan({ budget: config.budget }), null, '没有 rerun 一节就是原来的 pilot');
  assert.equal(rerunPlan({ ...config, rerun: { run_prefix: 'rerun88-20261031-', ledger_prefix: 'rerun88-20261031' } }).ledger_prefix, 'rerun88-20261031', '同一天第二次重跑：前缀带轮次');
  for (const [name, patch] of [['over 100', { budget: { ...config.budget, limit_rmb: 101 } }],
    ['tokens cost more than the money', { budget: { ...config.budget, input_token_limit: 9_000_000 } }],
    ['prefixes differ', { rerun: { ...config.rerun, run_prefix: 'rerun-20261101-' } }], ['pilot prefix', { rerun: { run_prefix: 'pilot-', ledger_prefix: 'pilot-20261014' } }],
    ['path in prefix', { rerun: { run_prefix: '../x-', ledger_prefix: '../x' } }], ['letters after rerun', { rerun: { run_prefix: 'rerunx-20261031-', ledger_prefix: 'rerunx-20261031' } }]]) {
    assert.throws(() => rerunPlan({ ...config, ...patch }), /rerun/, name);
  }
});

test('重跑用自己的账本：第六十九轮那几本花掉的不扣这一次的额度', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-ledger-r-'));
  fs.writeFileSync(path.join(dir, 'pilot-20261014-1.jsonl'), JSON.stringify({ event: 'accepted', requestId: 'a', inputUpperTokens: 3_000_000, reservedOutputTokens: 1 }) + '\n');
  const plan = rerunPlan({ rerun: { run_prefix: 'rerun-20261031-', ledger_prefix: 'rerun-20261031' }, budget: { limit_rmb: 100, input_token_limit: 8_000_000, output_token_limit: 1_000_000 } });
  const ledger = pilotLedger(dir, plan.ledger_prefix, plan.limits);
  assert.equal(ledger.ledgerName, 'rerun-20261031.jsonl');
  assert.deepEqual(ledger.limits, plan.limits);
});

test('--config 选哪份 run-config（默认第六十九轮那份）', () => {
  assert.equal(parseArgs(['run', '--eval-dir', '/x', '--config', 'docs/b.json']).config, 'docs/b.json');
  assert.equal(parseArgs(['run', '--eval-dir', '/x']).config, undefined);
});

// 第八十七轮：重跑时 django-15987 第一个请求在网关那一侧失败（0 轮、模型没回一个字）—— 列进 run-config 的才补跑，而且只补一次
test('基础设施补跑：列了的题、网关错且 0 轮的那次不算起过；补跑那次再失败就算数；没列的、跑过几轮的照旧算', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-retry-'));
  const put = (run, id, record) => { fs.mkdirSync(path.join(root, 'runs', run, id), { recursive: true }); fs.writeFileSync(path.join(root, 'runs', run, id, 'result.json'), JSON.stringify(record)); };
  const failed = { generation_status: 'gateway_error', rounds: 0 };
  put('rerun-20261031-a', 'x', failed);
  put('rerun-20261031-a', 'y', { generation_status: 'gateway_error', rounds: 7 });
  put('rerun-20261031-a', 'z', failed);
  const ctx = { root, config: { rerun: { infrastructure_retry: { instance_ids: ['x', 'y'] } } } };
  assert.equal(previousEpisode(ctx, 'x', 'rerun-20261031-'), null, '列了、0 轮的网关错：补跑');
  assert.equal(previousEpisode(ctx, 'y', 'rerun-20261031-'), 'rerun-20261031-a', '跑过 7 轮才失败的不补（模型已经回过话）');
  assert.equal(previousEpisode(ctx, 'z', 'rerun-20261031-'), 'rerun-20261031-a', '没列进 run-config 的不补');
  assert.equal(previousEpisode({ root, config: {} }, 'x', 'rerun-20261031-'), 'rerun-20261031-a', '没有补跑一节就照旧算');
  put('rerun-20261031-b', 'x', failed);
  assert.equal(previousEpisode(ctx, 'x', 'rerun-20261031-'), 'rerun-20261031-b', '补跑那次又这样：算数，不再补');
});
