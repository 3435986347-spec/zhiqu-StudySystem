// 后台命令（第一百一十二轮，Codex 同级第 5 步）：shell 的 background: true、shell_output、shell_stop、/ps、/stop。
//
// 命令行这里自己起进程；网页是后端起的（WorkspaceExecutor.Background），两边给模型的说法都走 describeJob。
//   - 输出只留最后 KEEP_BYTES：dev server 跑一天，日志不能把内存吃光。丢了多少要说出来。
//   - 进程组：detached + 杀负的 pid。npm run dev 下面还有一层，只杀 npm 的话下面的接着占端口。
//   - unref：不然命令行答完了也退不出去。退出时全部收掉（process 'exit'），不留在用户电脑上。
import { spawn, spawnSync } from 'node:child_process';
import { monotonic } from '../clock.js';
import { childEnv } from './exec.js';
import { looksBlocked } from './sandbox.js';

export const MAX_JOBS = 8;
export const KEEP_BYTES = 1024 * 1024;
export const READ_BYTES = 64 * 1024;
export const MAX_WAIT_SECONDS = 60;
export const START_WAIT_MS = 1500;

/** 给模型和用户看的一段：状态 + 新输出 + 丢了 / 还有多少 */
export function describeJob(snap, { boundary = '' } = {}) {
  const secs = Math.round((snap.millis || 0) / 1000);
  const head = snap.running ? `${snap.id}：还在跑（已 ${secs} 秒）` : `${snap.id}：已结束，退出码 ${snap.exitCode}（跑了 ${secs} 秒）`;
  const parts = [head];
  if (snap.skipped) parts.push(`【前面有 ${snap.skipped} 字节输出太早，已经丢了】`);
  parts.push(snap.output || (snap.running ? '（这段时间没有新输出）' : '（没有新输出）'));
  if (snap.more) parts.push(`【后面还有 ${snap.more} 字节，再调一次 shell_output 接着看】`);
  if (!snap.running && snap.exitCode !== 0 && !snap.stopped && looksBlocked(snap.output)) parts.push(`【这条命令可能被系统沙箱挡住了（${boundary}）。换个做法，或者告诉用户缺什么权限；不要换着花样绕。】`);
  return parts.join('\n');
}

export class ShellJobs {
  constructor({ maxJobs = MAX_JOBS, keepBytes = KEEP_BYTES, readBytes = READ_BYTES } = {}) {
    this.jobs = new Map();
    this.seq = 0;
    this.maxJobs = maxJobs;
    this.keepBytes = keepBytes;
    this.readBytes = readBytes;
    this.onExit = () => this.stopAll();
  }

  running() {
    return [...this.jobs.values()].filter((j) => j.exit == null);
  }

  /** launch：sandboxedLaunch 的结果。返回 { id } 或 { error } */
  start({ binary, args, env, cwd, command }) {
    if (this.running().length >= this.maxJobs) {
      return { error: `后台已经有 ${this.maxJobs} 个命令在跑了，先用 shell_stop 停掉不用的（shell_output 看它们）。` };
    }
    let child;
    const posix = process.platform !== 'win32';
    try {
      child = spawn(binary, args, { cwd, env: { ...childEnv(binary, cwd), ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: posix, windowsHide: true, shell: false });
    } catch (e) {
      return { error: `启动失败：${e.message}` };
    }
    const id = `job-${++this.seq}`;
    const job = { id, command, child, posix, buf: Buffer.alloc(0), total: 0, cursor: 0, started: monotonic(), exit: null, stopped: false, ended: null, waiters: new Set() };
    const wake = () => { for (const w of job.waiters) w(); };
    const take = (data) => {
      job.total += data.length;
      job.buf = Buffer.concat([job.buf, data]);
      if (job.buf.length > this.keepBytes) job.buf = job.buf.subarray(job.buf.length - this.keepBytes);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => { take(Buffer.from(`启动失败：${e.message}\n`)); job.exit = -1; job.ended = monotonic(); wake(); });
    child.on('close', (code) => { if (job.exit == null) { job.exit = code == null ? -1 : code; job.ended = monotonic(); } wake(); });
    // 不拖着命令行不让退（zhiqu -p 答完就要退）
    child.unref();
    child.stdout.unref();
    child.stderr.unref();
    if (this.jobs.size === 0) process.on('exit', this.onExit);
    this.jobs.set(id, job);
    return { id };
  }

  /** 新输出。waitMs：等到结束或者到点（有新输出也接着等：盯构建时不用一行一轮） */
  async read(id, { waitMs = 0, signal } = {}) {
    const job = this.jobs.get(id);
    if (!job) return { error: `没有 ${id} 这个后台命令（${this.names()}）。` };
    if (waitMs > 0 && job.exit == null) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); job.waiters.delete(done); if (signal) signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, waitMs);
        job.waiters.add(done);
        if (signal) signal.addEventListener('abort', done, { once: true });
      });
    }
    return this.snapshot(job);
  }

  snapshot(job) {
    const base = job.total - job.buf.length;
    const from = Math.max(job.cursor, base);
    const skipped = from - job.cursor;
    const end = Math.min(from + this.readBytes, job.total);
    const output = job.buf.subarray(from - base, end - base).toString('utf8');
    job.cursor = end;
    return { id: job.id, command: job.command, running: job.exit == null, exitCode: job.exit, stopped: job.stopped, output, skipped, more: job.total - end,
      millis: (job.ended ?? monotonic()) - job.started };
  }

  kill(job) {
    try {
      if (job.posix) process.kill(-job.child.pid, 'SIGKILL');
      else spawnSync('taskkill', ['/pid', String(job.child.pid), '/T', '/F'], { windowsHide: true });
    } catch { try { job.child.kill('SIGKILL'); } catch { /* 已经退出 */ } }
  }

  /** 连进程组一起停；等它真的没了再回 */
  async stop(id) {
    const job = this.jobs.get(id);
    if (!job) return { error: `没有 ${id} 这个后台命令（${this.names()}）。` };
    if (job.exit == null) {
      job.stopped = true;
      this.kill(job);
      await new Promise((resolve) => {
        if (job.exit != null) { resolve(); return; }
        const timer = setTimeout(resolve, 2000);
        job.waiters.add(() => { clearTimeout(timer); resolve(); });
      });
    }
    return this.snapshot(job);
  }

  stopAll() {
    for (const job of this.running()) { job.stopped = true; this.kill(job); }
  }

  list() {
    return [...this.jobs.values()].map((j) => ({ id: j.id, command: j.command, running: j.exit == null, exitCode: j.exit, stopped: j.stopped, millis: (j.ended ?? monotonic()) - j.started }));
  }

  names() {
    const ids = [...this.jobs.keys()];
    return ids.length ? `现在有：${ids.join('、')}` : '现在一个都没有';
  }
}
