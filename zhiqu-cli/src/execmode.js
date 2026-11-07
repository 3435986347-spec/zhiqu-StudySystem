// zhiqu exec（第一百一十三轮，Codex 同级第 6 步）：给脚本和 CI 用的非交互模式。
//   stdout 只有最终结论（--json 时是事件流），进度走 stderr。默认只读，--mode auto 才能写，没有人能回答确认。
//   退出码：0 成功，1 失败，2 用法不对，130 被中断。
import fs from 'node:fs';
import path from 'node:path';
import { archiveTurn, runTurn } from './agent.js';
import { normalizeMode } from './config.js';
import { extractJson, validate } from './tools/jsonschema.js';

export const SCHEMA_RETRIES = 2;
const STDIN_LIMIT = 16 * 1024 * 1024;

/**
 * 读 stdin。没有提示时读到结束；有提示时 stdin 只是可能带的材料，firstByteMs 内没来东西就当没有
 * （CI 里 stdin 常常是一根开着没人写的管子，死等就卡住了）。
 */
export function readStdin(stdin, { firstByteMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let timer = null;
    const finish = (text) => {
      if (timer) clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      stdin.pause();
      if (stdin.unref) stdin.unref();
      resolve(text);
    };
    const onData = (c) => {
      if (timer) { clearTimeout(timer); timer = null; }
      size += c.length;
      if (size > STDIN_LIMIT) { stdin.removeListener('data', onData); reject(new Error(`stdin 太大（超过 ${STDIN_LIMIT} 字节）`)); return; }
      chunks.push(c);
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString('utf8'));
    const onError = () => finish(Buffer.concat(chunks).toString('utf8'));
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    if (firstByteMs != null) timer = setTimeout(() => finish(''), firstByteMs);
  });
}

/** 解析 exec 的参数和提示。返回 { flags } 或 { error }（退出码 2） */
export async function prepareExec(flags, { stdin = process.stdin } = {}) {
  const args = flags._.slice(1);
  const out = { ...flags, exec: true };
  if (args[0] === 'resume') {
    args.shift();
    if (flags.last) out.continue = true;
    else if (args.length) out.resume = args.shift();
    else return { error: 'resume 要说接哪一段：zhiqu exec resume --last "接着做"，或者 zhiqu exec resume <id> "接着做"' };
  } else if (flags.last) {
    return { error: '--last 要和 resume 一起用：zhiqu exec resume --last "接着做"' };
  }
  if (flags.ephemeral && (out.continue || out.resume)) return { error: '--ephemeral 不留会话，不能和 resume 一起用' };
  // 不看配置文件里的 mode：默认只读，要写得在这条命令上明说。项目里的 settings.json 不能替用户开写权限
  const mode = flags.mode ? normalizeMode(flags.mode) : 'plan';
  if (!mode) return { error: `--mode 只接受 plan / auto，收到 ${flags.mode}` };
  if (mode === 'ask') return { error: 'exec 没有人能回答确认，不能用 ask：只读就不用给 --mode，要写给 --mode auto' };
  out.mode = mode;
  out.execReadOnly = mode === 'plan';
  if (flags.outputSchema) {
    let schema;
    try {
      schema = JSON.parse(fs.readFileSync(flags.outputSchema, 'utf8'));
    } catch (e) {
      return { error: `--output-schema 读不了：${e.message}` };
    }
    if (schema === null || (typeof schema !== 'object' && typeof schema !== 'boolean') || Array.isArray(schema)) return { error: '--output-schema 的内容要是一个 JSON Schema（对象）' };
    out.schema = schema;
  }
  let text = args.join(' ').trim();
  const dash = text === '-';
  if (dash) text = '';
  let piped = '';
  if (!stdin.isTTY) {
    try {
      piped = (await readStdin(stdin, { firstByteMs: text ? 300 : null })).trim();
    } catch (e) {
      return { error: e.message };
    }
  } else if (dash) {
    return { error: '说了从 stdin 读（-），可是 stdin 是终端：用管道把内容传进来' };
  }
  if (!text && !piped) return { error: '没有提示：zhiqu exec "要做的事"，或者用管道传进来' };
  out.print = text && piped ? `${text}\n\n<stdin>\n${piped}\n</stdin>` : text || piped;
  return { flags: out };
}

const schemaInstruction = (schema) => `\n\n【输出格式】最终回答必须是一个 JSON，符合下面的 JSON Schema。只输出这个 JSON，不要代码块，不要别的文字：\n${JSON.stringify(schema)}`;
const schemaNudge = (errors) => `你的回答不符合要求的格式：\n${errors.slice(0, 10).map((e) => `- ${e}`).join('\n')}\n重新输出：只输出符合 JSON Schema 的 JSON，不要代码块，不要别的文字。`;

function writeAtomic(file, text) {
  const abs = path.resolve(file);
  const tmp = `${abs}.zhiqu-tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, abs);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 已经改名走了 */ }
  }
}

const usageOf = (ctx, before) => ({ input_tokens: ctx.usage.prompt - before.prompt, cached_input_tokens: (ctx.usage.cached || 0) - (before.cached || 0), output_tokens: ctx.usage.completion - before.completion });

/** 跑一次。返回退出码 */
export async function execShot(ctx, flags, { out = process.stdout } = {}) {
  const emit = flags.json ? (type, data = {}) => out.write(`${JSON.stringify({ type, ...data })}\n`) : null;
  let item = 0;
  ctx.emit = emit ? (kind, it) => emit(`item.${kind}`, { item: it }) : null;
  ctx.nextItemId = () => `item_${++item}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  ctx.ui.onInterrupt = abort;
  const fail = (message, code = 1) => {
    if (emit) emit('turn.failed', { error: { message } });
    process.stderr.write(`zhiqu exec：${message}\n`);
    return code;
  };
  if (emit) emit('thread.started', { thread_id: ctx.session.id });
  else process.stderr.write(`会话 ${ctx.session.id}（接着做：zhiqu exec resume ${ctx.session.id} "…"）\n`);
  const before = { ...ctx.usage };
  try {
    if (emit) emit('turn.started');
    const prompt = flags.print + (flags.schema !== undefined ? schemaInstruction(flags.schema) : '');
    let result = await runTurn(ctx, prompt, { signal: controller.signal });
    let final = result.finalText;
    if (controller.signal.aborted) return fail('被中断了', 130);
    if (result.stalled) return fail(result.finalText);
    if (flags.schema !== undefined) {
      let problems = [];
      for (let attempt = 0; ; attempt++) {
        const parsed = extractJson(final);
        problems = parsed.error ? [parsed.error] : validate(flags.schema, parsed.value);
        if (!problems.length) { final = JSON.stringify(parsed.value); break; }
        if (attempt >= SCHEMA_RETRIES) return fail(`回答不符合 --output-schema（试了 ${attempt + 1} 次）：${problems.slice(0, 3).join('；')}`);
        result = await runTurn(ctx, schemaNudge(problems), { signal: controller.signal, origin: 'system' });
        final = result.finalText;
        if (controller.signal.aborted) return fail('被中断了', 130);
        if (result.stalled) return fail(result.finalText);
      }
    }
    if (!String(final || '').trim()) return fail('模型没有给出结论（可能是工具轮数用完了）');
    if (flags.output) writeAtomic(flags.output, `${final}\n`);
    if (emit) emit('turn.completed', { usage: usageOf(ctx, before), final_message: final });
    else out.write(`${final}\n`);
    archiveTurn(ctx, flags.print, result);
    return 0;
  } catch (e) {
    if (controller.signal.aborted || (e && e.name === 'AbortError')) return fail('被中断了', 130);
    return fail(e && e.message ? e.message : String(e));
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
