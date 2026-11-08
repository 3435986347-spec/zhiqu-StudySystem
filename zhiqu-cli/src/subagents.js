// 子 agent（第一百二十轮，Codex 同级第 8 步）：主 agent 派一个子 agent 在单独的上下文里做一件事，和它并行跑，
// 做完只交回一段结论 —— 子 agent 读了什么、试了什么不占主 agent 的上下文。
//
// 两种：explorer 只读探索（plan 档的工具、只读沙箱 —— 是代码保证的，不是说明里叫它别改；Codex 的 explorer 没有单独的只读沙箱），
// worker 干活（和主 agent 同一档）。都不超过主 agent：plan 档、exec 只读时不能派 worker；「本会话都允许」两边共用。
// 子 agent 不能再派子 agent（深度 1），不给后台命令（活多久、谁来停说不清）。
//
// 上限（只认用户级的 ~/.zhiqu/config.json，项目里的 .zhiqu/settings.json 不能替用户调高花费）：同时在跑的个数、一句话里派的个数、
// 一句话里子 agent 一共花的 token（到了就停下所有在跑的、不再派），每个的轮数。
//
// 并行的安全另在两处：每个 agent 自己一份「读过什么」（childLocal）；终端的确认一次只问一个（Ui.choose）。
// 一句话结束时还在跑的：先推一次「wait_agent 拿结果」（agent.js 的 pendingNudge），还不等就停掉，不留到下一句。
//
// 这个模块不引 agent.js（agent.js 引它）：跑一轮用的 runTurn 由建它的地方给。
export const AGENT_TOOLS = new Set(['spawn_agent', 'wait_agent', 'send_input', 'close_agent']);

export const ROLES = Object.freeze({
  explorer: { label: '只读探索', brief: '只读探索：能读、能搜、能跑只读的命令，不能改文件' },
  worker: { label: '干活', brief: '干活：能改文件、跑命令，权限和主 agent 一样' },
});

export const DEFAULT_AGENT_LIMITS = Object.freeze({
  enabled: true,
  maxConcurrent: 3,          // 服务器的模型网关一个用户一分钟 60 次（RateLimitFilter）；Codex 默认 6
  maxPerTurn: 8,
  turnTokens: 2_000_000,     // 一句话里所有子 agent 加起来（输入 + 输出，命中缓存的也算）
  explorerRounds: 30,
});
const BOUNDS = { maxConcurrent: [1, 6], maxPerTurn: [1, 20], turnTokens: [10_000, 20_000_000], explorerRounds: [1, 60] };
export const DEFAULT_WAIT_SECONDS = 600;
export const MAX_WAIT_SECONDS = 1800;
export const REPORT_CHARS = 8000;
const KEEP_FINISHED = 20;

/** ~/.zhiqu/config.json 的 agents：false 关掉；数字在范围里才认，不认的用默认 */
export function agentLimits(config) {
  if (config === false) return { ...DEFAULT_AGENT_LIMITS, enabled: false };
  const c = config && typeof config === 'object' ? config : {};
  const out = { ...DEFAULT_AGENT_LIMITS, enabled: c.enabled !== false };
  for (const [key, [lo, hi]] of Object.entries(BOUNDS)) {
    const n = Number(c[key]);
    if (c[key] != null && Number.isInteger(n) && n >= lo && n <= hi) out[key] = n;
  }
  return out;
}

export function agentSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'spawn_agent',
        description: '派一个子 agent 在单独的上下文里做一件事，和你并行跑：它读文件、试命令不占你的上下文，做完只交回一段结论。'
          + '只在这些时候用：用户明确要你派 agent / 并行做；项目说明或 skill 要求；或者有几件互不相关、各要读很多文件的调查（比如同时摸清三个模块）。'
          + '小事自己做更快更省 —— 每个子 agent 都要从头读文件，花的 token 是你自己做的几倍。'
          + '并行的 worker 不要改同一个文件：按文件把活分开。返回子 agent 的编号，之后用 wait_agent 拿结论。',
        parameters: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['explorer', 'worker'], description: 'explorer：只读探索（读、搜、跑只读命令，不能改）；worker：干活（能改文件、跑命令，权限和你一样）' },
            task: { type: 'string', description: '完整写清楚：要做什么、范围（哪些文件 / 目录）、交回什么。它看不到你和用户的对话，只知道这一段' },
          },
          required: ['role', 'task'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wait_agent',
        description: `等子 agent 做完，拿回它们的结论。ids 不给就等所有在跑的（连同做完了还没交给你的）。timeout_seconds 默认 ${DEFAULT_WAIT_SECONDS}，最多 ${MAX_WAIT_SECONDS}；到点没做完的会说还在跑，可以再等，或者 close_agent 停掉。`,
        parameters: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' }, description: '子 agent 的编号，比如 ["explorer-1"]' },
            timeout_seconds: { type: 'number' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'send_input',
        description: '给一个已经停下的子 agent 再交代一件事：它记得之前读过、做过的，接着做。之后用 wait_agent 拿结论。还在跑的不能插话。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' }, message: { type: 'string', description: '要它接着做什么' } },
          required: ['id', 'message'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'close_agent',
        description: '停掉一个在跑的子 agent（它做到一半的改动不会撤回），返回它停下时做到哪了。',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
  ];
}

const firstLine = (s, n) => {
  const t = String(s || '').trim().split('\n')[0];
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function describeAgentCall(name, args = {}) {
  switch (name) {
    case 'spawn_agent': return `派${args.role === 'worker' ? '干活的' : args.role === 'explorer' ? '只读探索的' : ''}子 agent：${firstLine(args.task, 50)}`;
    case 'wait_agent': return `等子 agent ${Array.isArray(args.ids) && args.ids.length ? args.ids.join('、') : '（在跑的全部）'}`;
    case 'send_input': return `给 ${args.id} 交代：${firstLine(args.message, 40)}`;
    case 'close_agent': return `停掉子 agent ${args.id}`;
    default: return name;
  }
}

/** 子 agent 的第一句：它是谁、能做什么、交回什么 */
export function taskPrompt(agent) {
  const careful = agent.role === 'worker'
    ? '别的子 agent 可能同时在改别的文件：只动任务说的范围，改之前先读，不要整份重写不归你管的文件。\n'
    : '';
  return `你是主 agent 派出来的子 agent ${agent.id}（${ROLES[agent.role].brief}）。\n${careful}\n主 agent 交给你的任务：\n${agent.task}\n\n`
    + '做完用一段话交结论 —— 主 agent 只看得到这段话，看不到你读了什么、跑了什么：查到 / 做了什么，关键的文件和行号，没做完或拿不准的地方。'
    + '不要贴大段代码；不要问问题（没有人回答你），拿不准就写进结论。';
}

/**
 * 子 agent 自己一份「读过什么」：工作区、沙箱、后台命令表都是同一个，只有 known 分开。
 * 原来共用一份：worker A 写完，known 里记的是 A 写的版本，B 没读过也算「读过」，能拿旧内容整份盖掉 A 的改动。
 */
export function childLocal(local) {
  const own = Object.create(local);
  own.known = new Map();
  return own;
}

/**
 * 子 agent 的终端：每一行前面标上是谁；不边收边打、不画自己的「思考中」（主 agent 那个一直在转，状态行写着哪个子 agent 在做什么）；
 * 确认问题标上是谁，停下了就不再问（问出去的回答回来时已经停了，也按不同意）。
 */
export function agentUi(ui, label, stopped) {
  const tag = `[${label}]`;
  const quietMd = { feed() {}, finish() {}, wroteAnything: false };
  return new Proxy(ui, {
    get(target, key) {
      switch (key) {
        case 'step': return (t) => target.step(`${tag} ${t}`);
        case 'result': return (t, ok = true) => target.result(`${tag} ${t}`, ok);
        case 'note': return (t) => target.note(`${tag} ${t}`);
        case 'warn': return (t) => target.warn(`${tag} ${t}`);
        case 'error': return (t) => target.error(`${tag} ${t}`);
        case 'line': return (t = '') => target.line(t ? `${target.paint.dim(tag)} ${t}` : t);
        case 'choose': return async (q, options, fallback) => {
          if (stopped()) return fallback;
          const pick = await target.choose(`${tag} ${q}`, options, fallback);
          return stopped() ? fallback : pick;
        };
        case 'markdown': return () => quietMd;
        case 'startThinking': case 'stopThinking': return () => {};
        case 'setActivity': return (t) => target.setActivity(`${label}：${t || '等模型'}`);
        case 'status': return { set() {}, clear() {} };
        default: {
          const v = target[key];
          return typeof v === 'function' ? v.bind(target) : v;
        }
      }
    },
  });
}

const STATUS_TEXT = { running: '在跑', done: '做完了', failed: '出错停了', closed: '被停掉了', budget: '预算用完，停了', interrupted: '被打断了', 'turn-end': '这一句结束时还没做完，停了' };
const kTokens = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}K` : String(n));

export class SubAgents {
  constructor({ runTurn, limits = DEFAULT_AGENT_LIMITS, now = () => Date.now() } = {}) {
    if (typeof runTurn !== 'function') throw new Error('SubAgents 要给 runTurn');
    this.runTurn = runTurn;
    this.limits = { ...DEFAULT_AGENT_LIMITS, ...limits };
    this.now = now;
    this.agents = new Map();
    this.counters = { explorer: 0, worker: 0 };
    this.beginTurn(null, null);
  }

  /** 主 agent 的一句话开始：这一句的个数和 token 重新算；Ctrl+C 连子 agent 一起停 */
  beginTurn(parent, signal) {
    this.parent = parent;
    this.signal = signal;
    this.turnSpawned = 0;
    this.turnTokens = 0;
    this.budgetHit = false;
    this.nudged = false;
  }

  running() { return [...this.agents.values()].filter((a) => a.status === 'running'); }
  list() { return [...this.agents.values()]; }
  get(id) { return this.agents.get(String(id || '').trim()); }

  /** /new、换会话：在跑的停掉，记录清空 */
  async reset() {
    await this.stopAll('closed');
    this.forget();
  }

  /** 换一段会话（两句话之间，没有在跑的）：记录清空、编号从头数 */
  forget() {
    this.agents.clear();
    this.counters = { explorer: 0, worker: 0 };
  }

  async stopAll(reason) {
    const left = this.running();
    for (const a of left) this.stop(a, reason);
    await Promise.allSettled(left.map((a) => a.promise));
    return left;
  }

  stop(agent, reason) {
    if (agent.status !== 'running') return;
    agent.stopReason = agent.stopReason || reason;
    agent.controller.abort();
  }

  /** 主 agent 的一句话结束：还在跑的停掉，不留到下一句 */
  async endTurn(parent) {
    const left = await this.stopAll('turn-end');
    if (left.length && parent && parent.ui) {
      parent.ui.note(`· 这一句结束时 ${left.map((a) => a.id).join('、')} 还没做完，已经停下（没交结论）。要它接着做，说「让 ${left[0].id} 接着做」`);
    }
  }

  /** 一句话收尾之前还有在跑的：推一次 */
  nudgeText() {
    if (this.nudged) return null;
    const left = this.running();
    if (!left.length) return null;
    this.nudged = true;
    return `（你派出去的 ${left.map((a) => a.id).join('、')} 还在跑，结论还没拿回来。用 wait_agent 等它们做完再收尾；不需要了就 close_agent 停掉。这一句结束时还在跑的会被停下。）`;
  }

  /** 每次子 agent 调完模型：算进主 agent 的用量、它自己的、这一句的；到了预算就全停 */
  charge(agent, usage = {}) {
    const p = Number(usage.promptTokens) || 0;
    const c = Number(usage.completionTokens) || 0;
    const cached = Number(usage.cachedTokens) || 0;
    const target = agent.parent && agent.parent.usage;
    if (target) {
      target.prompt += p;
      target.completion += c;
      target.cached = (target.cached || 0) + cached;
    }
    agent.calls += 1;
    agent.tokens += p + c;
    this.turnTokens += p + c;
    if (!this.budgetHit && this.turnTokens >= this.limits.turnTokens) {
      this.budgetHit = true;
      const left = this.running();
      for (const a of left) this.stop(a, 'budget');
      if (agent.parent && agent.parent.ui) {
        agent.parent.ui.warn(`子 agent 这一句一共花了约 ${kTokens(this.turnTokens)} token，到了上限（${kTokens(this.limits.turnTokens)}）：${left.map((a) => a.id).join('、') || '在跑的'}已停下，这一句不再派新的`);
      }
    }
  }

  /** 主 agent 调的四个工具。返回 { content, summary, ok } 或 { error } */
  async call(parent, name, args = {}, { signal } = {}) {
    if (name === 'spawn_agent') return this.spawn(parent, args);
    if (name === 'wait_agent') return this.wait(args, signal);
    if (name === 'send_input') return this.sendInput(parent, args);
    if (name === 'close_agent') return this.close(args);
    return { error: `不认识的工具：${name}` };
  }

  /** 能不能再让一个跑起来（派新的、send_input 都看这几条） */
  roomError(parent, role) {
    if (role === 'worker' && (parent.mode === 'plan' || parent.execReadOnly)) {
      return `现在是只读的${parent.execReadOnly ? '（zhiqu exec 默认只读）' : ' plan 档'}：只能派 explorer，worker 会改文件。要改的话先把计划交给用户${parent.execReadOnly ? '（或者用 --mode auto 重跑）' : '（exit_plan_mode）'}。`;
    }
    if (this.budgetHit) return `这一句里子 agent 已经花了约 ${kTokens(this.turnTokens)} token，到了上限（${kTokens(this.limits.turnTokens)}）：不再派新的。用已经拿到的结论自己接着做。`;
    const running = this.running();
    if (running.length >= this.limits.maxConcurrent) {
      return `已经有 ${running.length} 个子 agent 在跑（${running.map((a) => a.id).join('、')}，同时最多 ${this.limits.maxConcurrent} 个）：先 wait_agent 等它们做完，或者 close_agent 停掉一个。`;
    }
    return null;
  }

  spawn(parent, args) {
    const role = String(args.role || '').trim().toLowerCase();
    if (!ROLES[role]) return { error: 'role 只有两种：explorer（只读探索）、worker（干活）' };
    const task = String(args.task || '').trim();
    if (!task) return { error: 'task 是空的：写清楚要它做什么、范围、交回什么（它看不到你和用户的对话）' };
    const room = this.roomError(parent, role);
    if (room) return { error: room };
    if (this.turnSpawned >= this.limits.maxPerTurn) {
      return { error: `这一句已经派了 ${this.turnSpawned} 个子 agent（一句话最多 ${this.limits.maxPerTurn} 个）：用已经拿到的结论自己接着做。` };
    }
    this.turnSpawned += 1;
    const id = `${role}-${++this.counters[role]}`;
    const agent = {
      id, role, task, status: 'running', parent, calls: 0, tokens: 0, turns: 0,
      startedAt: this.now(), endedAt: null, result: null, error: null, stopReason: null, reported: false, changedFiles: new Set(),
    };
    agent.ctx = this.childContext(parent, agent);
    this.agents.set(id, agent);
    this.prune();
    this.start(agent, taskPrompt(agent));
    return { content: `已派出 ${id}（${ROLES[role].label}）。它看不到你和用户的对话，只知道你给的任务。用 wait_agent 拿它的结论；等的同时你可以做别的。`, summary: `${id} 开始了` };
  }

  childContext(parent, agent) {
    const explorer = agent.role === 'explorer';
    return {
      ...parent,
      ui: agentUi(parent.ui, agent.id, () => !agent.controller || agent.controller.signal.aborted),
      mode: explorer ? 'plan' : parent.mode,
      execReadOnly: explorer ? true : parent.execReadOnly,
      exec: true,                 // 结论不当成回答打出来：交回主 agent
      verbose: false,
      emit: null,
      store: null,
      goal: null,
      messages: [],
      todos: [],
      request: null,
      claimCheck: null,
      subagent: { id: agent.id, role: agent.role },
      maxRounds: explorer ? Math.min(this.limits.explorerRounds, parent.maxRounds || 60) : (parent.maxRounds || 60),
      usage: { prompt: 0, completion: 0, cached: 0 },
      onUsage: (u) => this.charge(agent, u),
      changedFiles: agent.changedFiles,
      local: childLocal(parent.local),
    };
  }

  /** 跑它的一句话（派出去、send_input 都走这里），不等 */
  start(agent, text) {
    agent.status = 'running';
    agent.stopReason = null;
    agent.reported = false;
    agent.controller = new AbortController();
    const outer = this.signal;
    const onOuter = () => this.stop(agent, 'interrupted');
    if (outer) {
      if (outer.aborted) onOuter();
      else outer.addEventListener('abort', onOuter, { once: true });
    }
    agent.promise = (async () => {
      try {
        const r = await this.runTurn(agent.ctx, text, { signal: agent.controller.signal });
        agent.result = r;
        agent.turns += 1;
        agent.status = agent.controller.signal.aborted ? (agent.stopReason || 'closed') : r.stalled ? 'failed' : 'done';
        if (r.stalled) agent.error = r.finalText;
      } catch (e) {
        agent.status = agent.controller.signal.aborted ? (agent.stopReason || 'closed') : 'failed';
        if (agent.status === 'failed') agent.error = e && e.message ? e.message : String(e);
      } finally {
        if (outer) outer.removeEventListener('abort', onOuter);
        agent.endedAt = this.now();
        const parent = agent.parent;
        if (parent && parent.changedFiles) for (const f of agent.changedFiles) parent.changedFiles.add(f);
        if (parent && parent.ui && agent.status !== 'interrupted') parent.ui.note(`· [${agent.id}] ${STATUS_TEXT[agent.status]}（调了 ${agent.calls} 次模型，约 ${kTokens(agent.tokens)} token）`);
      }
    })();
  }

  async wait(args, signal) {
    const given = Array.isArray(args.ids) ? args.ids.map((x) => String(x).trim()).filter(Boolean) : [];
    const unknown = given.filter((id) => !this.agents.has(id));
    if (unknown.length) return { error: `没有 ${unknown.join('、')} 这个子 agent。${this.agents.size ? `有：${[...this.agents.keys()].join('、')}` : '这段会话还没派过子 agent。'}` };
    const targets = given.length ? given.map((id) => this.agents.get(id))
      : this.list().filter((a) => a.status === 'running' || !a.reported);
    if (!targets.length) return { content: '没有在跑的子 agent，做完的结论也都交给过你了。', summary: '没有要等的' };
    const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, Number(args.timeout_seconds) || DEFAULT_WAIT_SECONDS));
    await new Promise((resolve) => {
      const t = setTimeout(done, seconds * 1000);
      if (t.unref) t.unref();
      function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); resolve(); }
      if (signal) { if (signal.aborted) return done(); signal.addEventListener('abort', done, { once: true }); }
      Promise.allSettled(targets.map((a) => a.promise)).then(done);
    });
    const parts = targets.map((a) => this.report(a));
    for (const a of targets) if (a.status !== 'running') a.reported = true;
    const left = targets.filter((a) => a.status === 'running');
    const finished = targets.filter((a) => a.status !== 'running');
    const summary = [finished.length ? finished.map((a) => `${a.id} ${STATUS_TEXT[a.status]}`).join('、') : '', left.length ? `${left.map((a) => a.id).join('、')} 还在跑` : '']
      .filter(Boolean).join('；');
    return { content: parts.join('\n\n'), summary, ok: !finished.some((a) => a.status === 'failed') };
  }

  sendInput(parent, args) {
    const agent = this.get(args.id);
    if (!agent) return { error: `没有 ${args.id} 这个子 agent。${this.agents.size ? `有：${[...this.agents.keys()].join('、')}` : ''}` };
    const message = String(args.message || '').trim();
    if (!message) return { error: 'message 是空的：写清楚要它接着做什么' };
    if (agent.status === 'running') return { error: `${agent.id} 还在跑，不能插话：等它做完（wait_agent）再交代，或者 close_agent 停掉重派。` };
    const room = this.roomError(parent, agent.role);
    if (room) return { error: room };
    // 这期间主 agent 可能换了模型、思考档位、档位：跟着现在的走（权限不超过主 agent 现在的）
    Object.assign(agent.ctx, {
      model: parent.model, effort: parent.effort, allow: parent.allow,
      mode: agent.role === 'explorer' ? 'plan' : parent.mode, execReadOnly: agent.role === 'explorer' ? true : parent.execReadOnly,
    });
    agent.parent = parent;
    this.start(agent, message);
    return { content: `已交给 ${agent.id}，它接着做（记得之前读过、做过的）。用 wait_agent 拿结论。`, summary: `${agent.id} 接着做` };
  }

  async close(args) {
    const agent = this.get(args.id);
    if (!agent) return { error: `没有 ${args.id} 这个子 agent。${this.agents.size ? `有：${[...this.agents.keys()].join('、')}` : ''}` };
    if (agent.status === 'running') {
      this.stop(agent, 'closed');
      await agent.promise;
    }
    agent.reported = true;
    return { content: this.report(agent), summary: `${agent.id} ${STATUS_TEXT[agent.status]}` };
  }

  /** 交给主 agent 的那段（/agents <编号> 也是它） */
  report(agent) {
    const head = `## ${agent.id}（${ROLES[agent.role].label}）：${STATUS_TEXT[agent.status]}`;
    if (agent.status === 'running') return `${head}（已经 ${Math.round((this.now() - agent.startedAt) / 1000)} 秒，调了 ${agent.calls} 次模型）`;
    const lines = [head, `调了 ${agent.calls} 次模型，约 ${kTokens(agent.tokens)} token。`];
    if (agent.error) lines.push(`出错：${agent.error}`);
    const text = String((agent.result && agent.result.finalText) || '').trim();
    if (text) lines.push(text.length > REPORT_CHARS ? `${text.slice(0, REPORT_CHARS)}\n…（结论有 ${text.length} 字，只给了前 ${REPORT_CHARS} 字）` : text);
    else if (agent.status !== 'done') {
      const steps = (agent.result && agent.result.steps) || [];
      lines.push(steps.length ? `停下之前做了：${steps.slice(-8).join(' · ')}` : '停下之前还没做什么。');
      if (agent.status !== 'failed') lines.push(`要它接着做：send_input（id: ${agent.id}）。`);
    } else lines.push('（它没有写结论）');
    if (agent.changedFiles.size) lines.push(`改过的文件：${[...agent.changedFiles].join('、')}`);
    return lines.join('\n');
  }

  /** /agents 里的一行 */
  row(agent) {
    const secs = Math.round(((agent.endedAt || this.now()) - agent.startedAt) / 1000);
    return `${agent.id}  ${STATUS_TEXT[agent.status]}（${secs} 秒，${agent.calls} 次模型，约 ${kTokens(agent.tokens)} token）  ${firstLine(agent.task, 50)}`;
  }

  /** 做完的只留最近 KEEP_FINISHED 个（每个都攥着一整段上下文） */
  prune() {
    const finished = this.list().filter((a) => a.status !== 'running');
    for (const a of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.agents.delete(a.id);
  }
}
