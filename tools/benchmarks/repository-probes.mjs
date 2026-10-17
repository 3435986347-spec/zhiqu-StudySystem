// 在 task 容器里、真实 agent 启动之前跑的无模型探针（第六十九轮）。宿主机按这里打出的一行 JSON 判，
// 任何一条不过就不启动模型。只做「能不能」的观察，不调模型、不碰真实登录：
//   - 网络：只通 broker 的模型端口；宿主机、外网、Docker DNS、IPv6、broker 的另一张网卡都不通；
//     broker 本身拒绝别的路径 / 方法、没有或错误的 capability、错误的模型（在转给网关之前）。
//   - 文件系统：系统、CLI、Node、Python 环境只读；/work 只有这一题；没有宿主机的东西、没有能力位。
//   - smoke 模式再用真正的 LocalTools（清空的子进程环境）读写 base、跑一条公开测试。
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import dgram from 'node:dgram';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';

const MODEL_PATH = '/api/harness/model/stream';

export function connect(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    socket.once('connect', () => done('connected'));
    socket.once('error', (error) => done(`error:${error.code || 'unknown'}`));
  });
}

function dnsQuery(name) {
  const header = Buffer.from([0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const labels = name.split('.').flatMap((part) => [Buffer.from([part.length]), Buffer.from(part)]);
  return Buffer.concat([header, ...labels, Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01])]);
}

export function udpDns(host, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
    const done = (value) => { clearTimeout(timer); try { socket.close(); } catch { /* closed */ } resolve(value); };
    const timer = setTimeout(() => done('no_reply'), timeoutMs);
    socket.once('message', () => done('reply'));
    socket.once('error', (error) => done(`error:${error.code || 'unknown'}`));
    socket.send(dnsQuery('example.com'), 53, host, (error) => { if (error) done(`error:${error.code || 'unknown'}`); });
  });
}

function request(host, port, { method = 'POST', pathname = MODEL_PATH, headers = {}, body = '' } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, method, path: pathname, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000 }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('timeout', () => { req.destroy(); resolve('timeout'); });
    req.once('error', (error) => resolve(`error:${error.code || 'unknown'}`));
    req.end(body);
  });
}

function tryWrite(file) {
  try { fs.writeFileSync(file, 'probe'); fs.rmSync(file); return 'written'; } catch (error) { return `error:${error.code}`; }
}

function exists(file) {
  try { fs.lstatSync(file); return true; } catch { return false; }
}

export async function runProbes(args) {
  const results = [];
  const record = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: String(detail ?? '').slice(0, 4000) });
  const blocked = (value) => value !== 'connected';

  // ── 网络 ──
  const host = await connect(args.hostGatewayIp, args.gatewayPort);
  record('net_host_gateway_ip', blocked(host), host);
  for (const name of ['host.docker.internal', 'example.com']) {
    const lookup = await dns.lookup(name).then((a) => `resolved:${a.address}`, (error) => `error:${error.code}`);
    record(`net_dns_lookup_${name}`, lookup.startsWith('error:'), lookup);
  }
  for (const server of ['127.0.0.11', '8.8.8.8']) {
    const reply = await udpDns(server);
    record(`net_udp_dns_${server}`, reply !== 'reply', reply);
  }
  const tcpDns = await connect('8.8.8.8', 53);
  record('net_tcp_dns_8.8.8.8', blocked(tcpDns), tcpDns);
  const internet = await connect('1.1.1.1', 443);
  record('net_internet_tcp', blocked(internet), internet);
  const ipv6 = await connect('2606:4700:4700::1111', 443);
  record('net_ipv6', blocked(ipv6), ipv6);
  const ipv6Dns = await udpDns('2001:4860:4860::8888');
  record('net_ipv6_dns', ipv6Dns !== 'reply', ipv6Dns);
  const otherSide = await connect(args.gwBrokerIp, args.brokerPort);
  record('net_broker_gateway_side', blocked(otherSide), otherSide);
  const otherPort = await connect(args.brokerIp, args.brokerPort + 1);
  record('net_broker_other_port', blocked(otherPort), otherPort);
  const brokerTcp = await connect(args.brokerIp, args.brokerPort);
  record('net_broker_stream_port', brokerTcp === 'connected', brokerTcp);

  // ── broker 拒绝（都在转给网关之前） ──
  const json = { 'Content-Type': 'application/json' };
  const body = JSON.stringify({ modelId: 6, maxTokens: 16, messages: [{ role: 'user', content: 'probe' }], tools: [] });
  const statusOf = (options) => request(args.brokerIp, args.brokerPort, options);
  const checks = [
    ['broker_get_root', { method: 'GET', pathname: '/' }, 404],
    ['broker_management_path', { pathname: '/register', headers: json, body: '{}' }, 404],
    ['broker_other_api_path', { pathname: '/api/harness/me', headers: json, body: '{}' }, 404],
    ['broker_get_stream', { method: 'GET' }, 404],
    ['broker_no_capability', { headers: json, body }, 401],
    ['broker_wrong_capability', { headers: { ...json, Authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}` }, body }, 401],
    ['broker_real_token_shape', { headers: { ...json, Authorization: 'Bearer zqp_not_a_capability_but_a_token_shape' }, body }, 401],
  ];
  if (args.probeCapability) {
    const auth = { ...json, Authorization: `Bearer ${args.probeCapability}` };
    checks.push(['broker_wrong_model', { headers: auth, body: JSON.stringify({ ...JSON.parse(body), modelId: 1 }) }, 400]);
    checks.push(['broker_extra_field', { headers: auth, body: JSON.stringify({ ...JSON.parse(body), server: 'http://example.com' }) }, 400]);
    checks.push(['broker_not_json', { headers: { ...auth, 'Content-Type': 'text/plain' }, body }, 415]);
  }
  for (const [name, options, expected] of checks) {
    const status = await statusOf(options);
    record(name, status === expected, status);
  }

  // ── 身份与能力位 ──
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const field = (key) => (new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(status) || [])[1]?.trim();
  record('proc_uid_nonroot', process.getuid() === 1000 && process.getgid() === 1000, `${process.getuid()}:${process.getgid()}`);
  record('proc_no_capabilities', ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].every((key) => /^0+$/.test(field(key) || '')),
    ['CapEff', 'CapBnd'].map((key) => `${key}=${field(key)}`).join(' '));
  record('proc_no_new_privs', field('NoNewPrivs') === '1', field('NoNewPrivs'));
  const secretNames = Object.keys(process.env).filter((key) => /TOKEN|SECRET|PASSWORD|API_KEY|ZHIQU|DOCKER/i.test(key));
  record('env_no_credentials', secretNames.length === 0, secretNames.join(','));

  // ── 文件系统 ──
  for (const dir of ['/', '/usr/local', '/opt/zhiqu/tools/benchmarks', '/opt/zhiqu/zhiqu-cli/src', '/opt/node/bin', args.pythonPrefix]) {
    const result = tryWrite(path.join(dir, `.zhiqu-probe-${crypto.randomBytes(4).toString('hex')}`));
    record(`fs_readonly_${dir}`, result !== 'written', result);
  }
  const work = tryWrite(`/work/.zhiqu-probe-${crypto.randomBytes(4).toString('hex')}`);
  record('fs_work_writable', work === 'written', work);
  const tmp = tryWrite(`/tmp/.zhiqu-probe-${crypto.randomBytes(4).toString('hex')}`);
  record('fs_tmp_writable', tmp === 'written', tmp);
  const workEntries = fs.readdirSync('/work').sort();
  record('fs_work_only_this_task', JSON.stringify(workEntries) === JSON.stringify(['base_repo']), workEntries.join(','));
  record('fs_no_git_history', !exists('/work/base_repo/.git'), exists('/work/base_repo/.git'));
  const hostPaths = ['/var/run/docker.sock', '/run/docker.sock', '/Users', '/control', '/ledger', '/testbed'].filter(exists);
  record('fs_no_host_or_grader_paths', hostPaths.length === 0, hostPaths.join(','));
  const rootReadable = (() => { try { fs.readdirSync('/root'); return 'readable'; } catch (error) { return `error:${error.code}`; } })();
  record('fs_root_home_unreadable', rootReadable !== 'readable', rootReadable);
  const mounts = fs.readFileSync('/proc/self/mounts', 'utf8').split('\n').filter(Boolean);
  const writable = mounts.filter((line) => { const [, target, , options] = line.split(' ');
    return options.split(',').includes('rw') && !['/work', '/tmp'].includes(target) && !/^\/(proc|sys|dev)(\/|$)/.test(target)
      && !['/etc/resolv.conf', '/etc/hostname', '/etc/hosts'].includes(target); });
  record('fs_only_work_and_tmp_writable', writable.length === 0, writable.join(' | '));

  // ── smoke：真正的 LocalTools、清空的子进程环境 ──
  if (args.smokeCommand) {
    const { LocalTools } = await import('/opt/zhiqu/zhiqu-cli/src/tools/local.js');
    const tools = new LocalTools({ root: '/work/base_repo', execTimeoutMs: 180_000 });
    const read = tools.readFile({ path: args.smokeRead });
    record('localtools_read_base', !read.error && String(read.content || '').length > 0, read.error || `${String(read.content).length} chars`);
    const prep = tools.prepareWrite({ path: 'zhiqu_smoke_probe.txt', content: 'smoke\n' });
    const wrote = prep.error ? { error: prep.error } : tools.commitWrite(prep);
    record('localtools_write_base', !wrote.error && fs.readFileSync('/work/base_repo/zhiqu_smoke_probe.txt', 'utf8') === 'smoke\n', wrote.error || wrote.content);
    tools.readFile({ path: 'zhiqu_smoke_probe.txt' });   // 删之前要读过（和模型走的是同一条规矩）
    const removal = tools.prepareDelete({ path: 'zhiqu_smoke_probe.txt' });
    const removed = removal.error ? { error: removal.error } : tools.commitDelete(removal);
    record('localtools_delete_base', !removed.error && !exists('/work/base_repo/zhiqu_smoke_probe.txt'), removed.error || removed.content);
    const run = tools.prepareRun({ command: args.smokeCommand[0], args: args.smokeCommand.slice(1) });
    if (run.error) record('localtools_public_test', false, run.error);
    else {
      const result = await tools.commitRun(run);
      record('localtools_public_test', result.exitCode === 0, result.content.slice(0, 1200) + '\n…\n' + result.content.slice(-1500));
      record('localtools_python_from_task_env', run.binary.startsWith(`${args.pythonPrefix}/bin/`), run.binary);
    }
  }
  return { ok: results.every((item) => item.ok), results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  runProbes(JSON.parse(process.argv[2])).then((summary) => {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = summary.ok ? 0 : 3;
  }, (error) => { process.stdout.write(`${JSON.stringify({ ok: false, error: String(error && error.stack || error) })}\n`); process.exitCode = 1; });
}
