#!/usr/bin/env node
// 后端问「这条命令在系统沙箱里怎么起」（第一百零九轮，用户：网页也要系统沙箱，两者要一致）。
// 沙箱只有一份实现（tools/sandbox.js）：后端不在 Java 里再写一份，把根目录、工作目录、档位交过来，拿到 { binary, args, env }，由 WorkspaceExecutor 起进程。
// 这些输入只来自后端，不经过模型和 code-host；不跑命令，只回答。stdin 一个 JSON，stdout 一个 JSON。
import { detectSandbox, sandboxedLaunch } from '../tools/sandbox.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const req = JSON.parse(input);
    const env = req.env || {};
    if (req.probe) {
      process.stdout.write(JSON.stringify({ box: detectSandbox({ env, hosted: Boolean(req.hosted), network: req.network }) }));
      return;
    }
    const box = detectSandbox({ env, probe: false, hosted: Boolean(req.hosted) });
    if (!box) throw new Error('这台机器没有系统沙箱');
    process.stdout.write(JSON.stringify(sandboxedLaunch(box, { command: req.command, root: req.root, cwd: req.cwd, policy: req.policy, network: req.network,
      home: req.home, env, privateDir: req.privateDir, hosted: Boolean(req.hosted) })));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }));
  }
});
