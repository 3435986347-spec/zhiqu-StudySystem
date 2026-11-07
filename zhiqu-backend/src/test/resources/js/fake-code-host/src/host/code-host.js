// JsCodeAgentTest 用的假子进程（第九十四轮）：照协议说话，但专门干坏事 —— 看后端是不是照规矩拒绝、丢掉、停下。
//   abuse：请调模型时自己填 modelId（后端要换成它定的那个）；不许执行时硬发 exec（后端要回拒绝）；交回一个跳出工作区的草稿路径（后端要丢掉）
//   abuse-shell：后端没给 shell 时硬发一条 shell 命令（后端要回拒绝）；
//   env：把自己看得到的环境变量名报上来（后端起它时只给 HOME 和 PATH），然后发一条认不出的消息（后端要停下）
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
