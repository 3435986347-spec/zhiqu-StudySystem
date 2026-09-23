// 真正起子进程的那一层。规则（能不能跑）在 execrules.js；这里管资源约束，每条都照服务器端 WorkspaceExecutor：
//
//   - 不继承父进程的环境变量：命令行的环境里有 ZHIQU_TOKEN，用户机器上还有各种云凭据。继承的话，
//     一句 os.environ 就全拿走，而输出会原样回到模型上下文里。命令名在父进程这一侧解析成绝对路径，
//     子进程只拿到一份现拼的最小环境。
//   - 超时就杀掉整个进程组（npm test 会再起子进程，只杀父进程的话孙子进程还在跑）。
//   - 输出到上限之后继续读但丢弃，不能停止读取：管道写满，子进程会卡在 write 上，一个「日志很多但确实成功了」
//     的构建会被报成超时。正好等于上限不算截断。
//   - 工作目录在工作区内（调用方用 guard.resolveDirectory 解析）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_OUTPUT_LIMIT = 64 * 1024;

/** 在父进程的 PATH 里找命令（用父进程的 PATH 去「找」，不等于把它「传下去」）。 */
export function resolveOnPath(name, env = process.env, platform = process.platform) {
  if (!name || /[\\/]/.test(name)) return null;
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      const upper = path.join(dir, name + ext);
      for (const c of new Set([candidate, upper])) {
        try {
          const st = fs.statSync(c);
          if (st.isFile()) {
            if (platform !== 'win32') fs.accessSync(c, fs.constants.X_OK);
            return c;
          }
        } catch { /* 下一个 */ }
      }
    }
  }
  return null;
}

/** 子进程的最小环境：PATH 是固定的几段 + 命令自己所在的目录（npm 要能找到同目录下的 node）。 */
export function childEnv(binary, cwd, platform = process.platform) {
  const sys = platform === 'win32'
    ? [process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32']
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const env = {
    PATH: [path.dirname(binary), ...sys].join(path.delimiter),
    HOME: cwd,
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
    CI: '1',                                            // 让工具别等交互输入
    npm_config_cache: path.join(os.tmpdir(), 'zhiqu-npm-cache'),
    npm_config_update_notifier: 'false',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  if (platform === 'win32') {
    for (const k of ['SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'PATHEXT', 'COMSPEC']) if (process.env[k]) env[k] = process.env[k];
  } else {
    env.TMPDIR = os.tmpdir();
  }
  return env;
}

export function runProcess({ binary, args, cwd, timeoutMs, outputLimit = DEFAULT_OUTPUT_LIMIT, signal, onOutput }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const posix = process.platform !== 'win32';
    let child;
    try {
      child = spawn(binary, args, {
        cwd, env: childEnv(binary, cwd), stdio: ['ignore', 'pipe', 'pipe'], detached: posix, windowsHide: true,
        shell: false,
      });
    } catch (e) {
      resolve({ exitCode: -1, output: `启动失败：${e.message}`, truncated: false, timedOut: false, aborted: false, millis: 0 });
      return;
    }
    const chunks = [];
    let size = 0;
    let truncated = false;
    const take = (buf) => {
      if (size >= outputLimit) { truncated = true; return; }      // 继续排空，但丢弃
      const room = outputLimit - size;
      const piece = buf.length > room ? buf.subarray(0, room) : buf;
      if (buf.length > room) truncated = true;
      chunks.push(piece);
      size += piece.length;
      if (onOutput) onOutput(piece.toString('utf8'));
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    let aborted = false;
    const kill = () => {
      try {
        if (posix) process.kill(-child.pid, 'SIGKILL');
        else spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { aborted = true; kill(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { chunks.push(Buffer.from(`\n启动失败：${e.message}`)); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      let output = Buffer.concat(chunks).toString('utf8');
      if (truncated) output += `\n【输出超过 ${outputLimit} 字节，已截断】`;
      if (timedOut) output += `\n【超时：超过 ${timeoutMs}ms，已强制结束】`;
      if (aborted) output += '\n【用户中断了这条命令】';
      resolve({ exitCode: code == null ? -1 : code, signal: sig, output, truncated, timedOut, aborted, millis: Date.now() - started });
    });
  });
}
