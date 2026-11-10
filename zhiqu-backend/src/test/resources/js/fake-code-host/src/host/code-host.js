// JsCodeAgentTest 用的假子进程（第九十四轮）：照协议说话，但专门干坏事 —— 看后端是不是照规矩拒绝、丢掉、停下。
//   abuse：请调模型时自己填 modelId（后端要换成它定的那个）；不许执行时硬发 exec（后端要回拒绝）；交回一个跳出工作区的草稿路径（后端要丢掉）
//   abuse-shell：后端没给 shell 时硬发一条 shell 命令（后端要回拒绝）；
//   env：把自己看得到的环境变量名报上来（后端起它时只给 HOME 和 PATH），然后发一条认不出的消息（后端要停下）
//   trace：发几条步骤，有的不像样（后端要截、要丢，第一百二十七轮）
//   quit-early：请一次模型、不等回答就交 result 退出（后端往它写的时候管子已经关了 —— 第一百二十八轮）
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const waiters = new Map();
const ask = (m) => new Promise((resolve) => { waiters.set(m.id, resolve); send(m); });
rl.on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'run') {
    if (msg.type === 'event' && msg.name !== 'done') return;
    const w = waiters.get(msg.id); waiters.delete(msg.id); if (w) w(msg); return;
  }
  if (msg.message === 'crash') {
    // 不交结果就退：后端要在轨迹里说清楚、把 stderr 记进日志（第九十九轮 review）
    process.stderr.write('boom: something went wrong in the host\n');
    process.exit(3);
  }
  if (msg.message === 'env') {
    send({ type: 'step', text: Object.keys(process.env).sort().join(',') });
    send({ type: 'weird' });
    // 后端要在上一行就停下：读到这一条说明它没停
    send({ type: 'result', text: 'x', context: '不该读到', drafts: [] });
    return;
  }
  if (msg.message === 'quit-early') {
    // 第一百二十八轮（线上撞到的）：宿主到了时间预算，交了 result 就退 —— 后端这时还在往它的管子里转模型的流。
    // 先请一次模型（后端会一直往回写事件），不等回答：写下步骤和 result、马上退
    send({ type: 'model', id: 'm1', body: { messages: [{ role: 'user', content: 'x' }], tools: [], maxTokens: 100 } });
    send({ type: 'trace', step: { id: 's1', kind: 'create', title: '新建', target: 'core.js', summary: '+446 -0', status: 'ok' } });
    send({ type: 'result', text: '写好了 core.js', conclusion: '写好了 core.js，测试都过了', context: '【工作区 write_file】已写入 core.js', drafts: [], writeCalls: 1 });
    process.exit(0);
  }
  if (msg.message === 'trace') {
    // 第一百二十七轮：回答里的步骤 —— 后端照形状收、按上限截，认不出的字段 / 种类不要，没有 id 的整条丢掉
    send({ type: 'trace', step: { id: 's1', kind: 'run', title: '运行', target: 'npm test', summary: '', status: 'running' } });
    send({ type: 'trace', step: { id: 's1', kind: 'run', title: '运行', target: 'npm test', summary: '退出码 1', status: 'error', ms: 1234,
      detail: { command: 'npm test', exitCode: 1, output: 'x'.repeat(100000), omitted: 3, evil: '<script>', files: 'not-a-list' }, injected: 'drop me' } });
    send({ type: 'trace', step: { id: 's2', kind: 'rm -rf', title: 't'.repeat(500), status: 'exploded', detail: { files: [{ path: 'a.js', added: 1, removed: -5, hunks: ['+a', 7, '-b'] }] } } });
    send({ type: 'trace', step: { kind: 'read', title: '没有 id' } });
    send({ type: 'trace', step: 'not an object' });
    send({ type: 'result', text: 'done', context: 'traced', drafts: [] });
    return;
  }
  if (msg.message === 'abuse-shell') {
    // 后端没给 shell 时硬发（第一百零九轮）：要回拒绝，执行器碰都不碰
    const shell = await ask({ type: 'exec', id: 'x1', shell: true, command: 'echo pwned > pwned.txt', cwd: '' });
    send({ type: 'result', text: 'done', context: JSON.stringify({ shell }), drafts: [] });
    return;
  }
  const model = await ask({ type: 'model', id: 'm1', body: { modelId: 999, messages: [{ role: 'user', content: 'x' }], tools: [], maxTokens: 100 } });
  const exec = await ask({ type: 'exec', id: 'x1', command: 'python3', args: ['a.py'], cwd: '' });
  send({ type: 'result', text: 'done', context: JSON.stringify({ model: model.name, exec }),
    drafts: [{ path: '../evil.txt', content: 'x', baseline: 'ABSENT', creating: true }, { path: 'ok.txt', content: 'ok\n', baseline: 'ABSENT', creating: true }] });
});
