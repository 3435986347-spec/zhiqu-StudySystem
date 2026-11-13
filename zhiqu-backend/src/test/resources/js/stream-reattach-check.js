// 回答到一半走开、回来还能接上（第一百三十三轮）—— 从发布的 assets/pages/ai-assistant.js 里
// 抠出「事件落地」和「这一轮的记号」那一段真跑（假的最小 state / sessionStorage / toast）。
//
//   用法：node src/test/resources/js/stream-reattach-check.js <ai-assistant.js 的路径>
//
//   用户 2026-11-12：「回答到一半我去查看索引了，回来就没了」「会回到上次回答完的状态」。
//   盯的是：发送时记下 runId；done / error 把它清掉；回来时能按记号找到那一轮；
//   重放的事件和实时的事件走同一份落地逻辑（正文、半截保留、reset 清空、补充信息的提示）。
//
//   由 AiReattachTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const assert = require('assert/strict');

const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf("var RUNNING_KEY = 'zq.ai.running';");
const b = src.indexOf('async function sendAiMessage(', a);
if (a < 0 || b < 0) throw new Error('抠不到「记号 / 事件落地」那一段');

const store = (() => {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
  };
})();

const toasts = [];
const state = { notebookId: 5, messages: [] };
const noop = () => {};
const factory = new Function(
  'state', 'toast', 'renderAiMessages', 'patchStreamingMessage', 'upsertAgentStep', 'addAgentStepNote',
  'mergeTraceStep', 'receiveAgentArtifact', 'isPlanDraft', 'planDraftItems', 'sessionStorage', 'requestError',
  src.slice(a, b) + '\nreturn { makeStreamApplier, runningTurn, markRunningTurn, clearRunningTurn, runningStorageKey };');
const { makeStreamApplier, runningTurn, markRunningTurn, clearRunningTurn, runningStorageKey } = factory(
  state, (m) => toasts.push(m), noop, () => true, noop, noop, noop, noop, noop, noop, store,
  (msg, flags) => Object.assign(new Error(msg), flags));

function turn() {
  const assistant = { role: 'assistant', content: '', reasoningSummary: '', status: 'STREAMING' };
  const st = { assistant, sameNb: () => true, reasoningMode: 'AUTO',
    stored: false, dropped: false, completed: false, failed: false, marked: false };
  return { assistant, st, apply: makeStreamApplier(st) };
}

// 1) 发送时记下这一轮；正文按增量攒；done 之后记号要清掉
{
  const t = turn();
  t.apply('stream.start', { agentRunId: 77, assistantMessageId: 900, userMessageId: 899 });
  assert.equal(JSON.parse(store.getItem(runningStorageKey(5))).runId, 77, '发送时没记下 runId —— 页面走了就再也接不回来');
  t.apply('message.delta', { text: '第一段' });
  t.apply('message.delta', { text: '，第二段' });
  assert.equal(t.assistant.content, '第一段，第二段', '增量没有拼起来');
  t.apply('done', { status: 'DONE', assistantMessageId: 900 });
  assert.equal(t.st.completed, true, 'done 没被认出来');
  assert.equal(store.getItem(runningStorageKey(5)), null, 'done 之后记号还在 —— 下次进页面会去接一轮早就结束的回答');
}

// 2) error：半截正文留着，原因另起一行；记号也清掉
{
  const t = turn();
  t.apply('stream.start', { agentRunId: 78 });
  t.apply('message.delta', { text: '说到一半' });
  t.apply('error', { message: '模型超时' });
  assert.equal(t.st.failed, true);
  assert.equal(t.assistant.content, '说到一半', '出错时把已经出来的半截丢了');
  assert.equal(t.assistant.errorMessage, '模型超时');
  assert.equal(store.getItem(runningStorageKey(5)), null, 'error 之后记号还在');
}

// 3) 服务端缓冲丢过帧：正文清空，等页面按库里的那份重铺
{
  const t = turn();
  t.apply('stream.start', { agentRunId: 79 });
  t.apply('message.delta', { text: '旧的' });
  assert.throws(() => t.apply('stream.reset', { reason: 'buffer-dropped' }), (e) => e.resync === true);
  assert.equal(t.assistant.content, '旧的', '缺帧同步不能先清空已经看到的正文');
}

// 4) 这一轮不在服务端内存里了：记号清掉，交给消息列表
{
  const t = turn();
  markRunningTurn(80, 5, 901);
  t.apply('stream.gone', { reason: 'expired' });
  assert.equal(store.getItem(runningStorageKey(5)), null, 'stream.gone 之后记号还在，页面会一直等');
}

// 5) 「立即」补进来的话要看得见
{
  const t = turn();
  toasts.length = 0;
  t.apply('message.injected', { text: '我用的是 Java 17' });
  assert.ok(toasts.some((m) => m.includes('补充给这一轮')), '补充信息没有提示，用户会以为没发出去');
}

// 6) 长任务的记号必须覆盖 15 分钟回答窗口；过期的仍清掉
{
  markRunningTurn(81, 5, 902);
  const raw = JSON.parse(store.getItem(runningStorageKey(5)));
  raw.at = Date.now() - 239 * 60 * 1000;
  store.setItem(runningStorageKey(5), JSON.stringify(raw));
  assert.equal(runningTurn().runId, 81, '任务还在合法预算内，重连记号先过期了');
  raw.at = Date.now() - 246 * 60 * 1000;
  store.setItem(runningStorageKey(5), JSON.stringify(raw));
  assert.equal(runningTurn(), null, '过期的记号还当成在跑');
}

// 7) 别的 notebook 的记号不接
{
  markRunningTurn(82, 6, 903);
  assert.equal(runningTurn(6).nb, 6);
  assert.equal(runningTurn(), null, '不能把 B 的运行当成 A');
  clearRunningTurn(6);
  assert.equal(runningTurn(6), null);
}

// 8) 桌面页面按外壳预算等待，不能在旧的 250 秒就叫停；假时钟不需要真的等 10 分钟。
const waitStart = src.indexOf('function waitLocal(');
const waitEnd = src.indexOf('async function sendDesktopTurn(', waitStart);
assert.ok(waitStart >= 0 && waitEnd > waitStart, '抠不到桌面等待函数');
let nextTimer = 0;
const timers = new Map();
const listeners = new Set();
let stopped = 0;
const waitLocal = new Function('window', 'localCall', 'mergeTraceStep', 'renderAiMessages', 'setTimeout', 'clearTimeout',
  src.slice(waitStart, waitEnd) + '\nreturn waitLocal;')(
  { addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) },
  (body) => { if (body.action === 'stop') stopped++; return Promise.resolve(); }, noop, noop,
  (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
  (id) => timers.delete(id));

async function checkLocalWait() {
  const pending = waitLocal('local-1', {}, () => true, 600000);
  assert.equal([...timers.values()][0].ms, 630000, '外壳给了 10 分钟，页面仍在旧时限提前停止');
  for (const fn of listeners) fn({ detail: { runId: 'other', type: 'result' } });
  assert.equal(timers.size, 1, '别的任务结果结束了当前等待');
  for (const fn of [...listeners]) fn({ detail: { runId: 'local-1', type: 'result', conclusion: '完成' } });
  assert.equal((await pending).conclusion, '完成');
  assert.equal(timers.size, 0, '完成后没有清理兜底计时器');
  assert.equal(stopped, 0, '正常完成被当成超时叫停');

  const custom = waitLocal('local-2', {}, () => true, 900000);
  const timer = [...timers.values()][0];
  assert.equal(timer.ms, 930000, '页面忽略了外壳传来的自定义预算');
  timer.fn();
  assert.equal((await custom).type, 'fatal');
  assert.equal(stopped, 1, '到点没有叫停');
  assert.equal(listeners.size, 0, '结束后还留着事件监听');

  for (const value of [undefined, 'not-a-number', -1]) {
    const old = waitLocal('local-old', {}, () => true, value);
    assert.equal([...timers.values()][0].ms, 630000, '旧外壳或无效预算缺少兜底');
    for (const fn of [...listeners]) fn({ detail: { runId: 'local-old', type: 'result' } });
    await old;
  }
}
// 真跑发布模块的发送、列表重载与恢复，而不只是断言源码里出现了函数名。
const vm = require('vm');
function harness(sharedStore = store) {
  const input = { value: '', style: {}, scrollHeight: 44 };
  const s = { user: { id: 1 }, notebookId: 5, messages: [], pendingSources: [],
    agentSteps: [], agentArtifacts: [], sendQueue: [], chatFollow: true };
  const renders = [], events = new Map();
  const ctx = vm.createContext({ console, Date, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    sessionStorage: sharedStore, localStorage: sharedStore, AbortController, TextDecoder, TextEncoder,
    window: { addEventListener: (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
      removeEventListener: (name, fn) => events.get(name)?.delete(fn) }, document: { getElementById: () => null } });
  vm.runInContext(src.replace(/^export function /gm, 'function ').replace(/^export const /gm, 'const ')
    .replace(/^export \{[^\n]*\};/gm, ''), ctx);
  const sh = { state: s, API: '/api', REQUEST_TIMEOUT_MS: 30, token: () => null,
    api: { get: async () => [], post: async () => ({}) }, $: (sel) => sel === '#zq-draft' ? input : null,
    $all: () => [], nowMs: Date.now, requestError: (msg, flags) => Object.assign(new Error(msg), flags),
    toast: noop, safe: async (_, fn) => fn(), drafts: { clearIf: noop }, icon: () => '' };
  ctx.bind(sh);
  ctx.renderAiMessages = () => renders.push(s.messages.map((m) => ({ content: m.content, status: m.status })));
  ctx.patchStreamingMessage = () => { ctx.renderAiMessages(); return true; };
  ctx.renderAgentPanels = async () => {};
  ctx.renderNotebooks = noop;
  ctx.renderSteps = noop; ctx.renderArtifacts = noop; ctx.paintSlash = noop;
  ctx.stopStreamWatch = noop; ctx.watchStreamingMessages = noop;
  ctx.renderSendQueue = noop;
  return { ctx, s, input, sh, renders, events,
    emit: (name, detail) => { for (const fn of [...events.get(name) || []]) fn({ detail }); } };
}
async function checkNavigation() {
  // A -> B -> A：后台收到的第二段必须落在回来后显示的对象上，而不是一份脱离列表的旧对象。
  const h = harness();
  let apply, finish;
  h.ctx.streamAiChat = async (_, handlers) => { apply = handlers; await new Promise((r) => { finish = r; }); };
  h.input.value = '问题 A';
  const pending = h.ctx.sendAiMessage();
  apply('stream.start', { agentRunId: 501, assistantMessageId: 9001, userMessageId: 9000 });
  apply('message.delta', { text: '第一段' });
  apply('agent.step.start', { id: 'agent-a', publicSummary: '读取资料' });
  h.ctx.setAiNotebookId(6); h.s.messages = []; h.s.agentSteps = [];
  assert.equal(h.s.aiSending, false, 'A 在后台运行不能把 B 的输入状态锁成生成中');
  apply('message.delta', { text: '，后台第二段' });
  apply('agent.step.done', { id: 'agent-a', publicSummary: '后台已读完资料' });
  apply('agent.step.note', { stepId: 'agent-a', message: '离开期间的检索结果' });
  assert.equal(h.s.messages.length, 0, 'A 的后台消息串到了 B');
  assert.equal(h.s.agentSteps.length, 0, 'A 的后台步骤串到了 B');
  h.ctx.setAiNotebookId(5);
  h.sh.api.get = async () => [{ id: 9000, role: 'user', content: '问题 A' },
    { id: 9001, role: 'assistant', agentRunId: 501, status: 'STREAMING', content: '第一段' }];
  await h.ctx.loadAiMessages();
  assert.equal(h.s.messages.at(-1).content, '第一段，后台第二段', '切回 A 被过时的列表回包覆盖，最新进度丢了');
  assert.equal(h.s.agentSteps[0].publicSummary, '后台已读完资料', '离开期间的 agent 步骤更新丢了');
  assert.equal(h.s.agentSteps[0].notes[0].message, '离开期间的检索结果');
  apply('message.delta', { text: '，第三段' });
  assert.equal(h.s.messages.at(-1).content, '第一段，后台第二段，第三段', '回来后 SSE 仍写旧对象，气泡不再更新');
  h.sh.api.get = async () => [{ id: 9001, role: 'assistant', status: 'DONE', content: '第一段，后台第二段，第三段' }];
  apply('done', { assistantMessageId: 9001 }); finish(); await pending;
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function checkReplay() {
  const h = harness();
  const old = '已经生成的内容';
  h.s.messages = [{ id: 9101, role: 'assistant', agentRunId: 601, status: 'STREAMING', content: old }];
  // 没有本地记号也必须从消息列表的 agentRunId 找回后台运行。
  let replayed = 0, replayFailure;
  h.ctx.streamRunStream = async (id, after, apply) => {
    replayed++;
    try {
    assert.equal(id, 601); assert.equal(after, 0);
    apply('message.delta', { text: '已经' });
    assert.equal(h.s.messages[0].content, old, '重连先清空/倒退到重放的第一截');
    apply('message.delta', { text: '生成的内容，离开期间继续' });
    assert.equal(h.s.messages[0].content, old + '，离开期间继续', '没补齐离开期间正文，或者重复拼接了旧正文');
    apply('trace.step', { step: { id: 'replay-step', status: 'DONE', title: '离开期间完成的步骤' } });
    assert.equal(h.s.messages[0].steps.steps[0].title, '离开期间完成的步骤');
    apply('message.delta', { text: '，回来后实时内容' });
    apply('done', { assistantMessageId: 9101 });
    } catch (e) { replayFailure = e; throw e; }
  };
  h.sh.api.get = async () => [{ id: 9101, role: 'assistant', status: 'DONE', content: old + '，离开期间继续，回来后实时内容' }];
  await h.ctx.reattachRunningTurn();
  // 实现会吞传输错误、退回读库；判据中的断言不能一起被吞掉，最后拿到正确终态不等于中途没倒退。
  if (replayFailure) throw replayFailure;
  assert.equal(replayed, 1, '重连判据没有实际跑过事件回放');
  assert.equal(h.s.messages[0].content, old + '，离开期间继续，回来后实时内容');
  assert.equal(h.s.aiSending, false);
  assert.ok(h.renders.every((r) => r[0]?.content), '重连期间出现空白气泡');
}
async function checkHeaderTimeout() {
  const h = harness();
  h.s.messages = [{ id: 9201, role: 'assistant', agentRunId: 701, status: 'STREAMING', content: '已收到正文' }];
  let signal, polled = 0;
  h.ctx.fetch = async (_, opts) => new Promise((_, reject) => {
    signal = opts.signal;
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  h.sh.api.get = async () => [{ id: 9201, role: 'assistant', agentRunId: 701, status: 'STREAMING', content: '后台继续生成的最新正文' }];
  h.ctx.watchStreamingMessages = () => { polled++; };
  await h.ctx.reattachRunningTurn();
  assert.ok(signal.aborted, '重连响应头挂住时没有超时，轮询永远无法接管');
  assert.ok(polled > 0, '重连失败没有退回快照同步');
  assert.equal(h.s.aiSending, false);
  assert.equal(h.s.messages[0].status, 'STREAMING', '观察连接失败不能把后台任务当成结束');
  assert.equal(h.s.messages[0].content, '后台继续生成的最新正文');
}
async function checkDesktopReturn() {
  const h = harness();
  h.ctx.inDesktop = () => true;
  h.ctx.wsStatus = { selectedRoot: '/test/project', selectedMode: 'READ' };
  let runId, archive = [], archivedRows = [], shellSteps = [];
  h.sh.api.post = async (path, body, headers) => {
    if (path === '/access-tokens/desktop-code') return { token: 'fake-test-token' };
    assert.equal(path, '/ai/desktop-turn'); archive.push({ body, headers });
    archivedRows = [{ id: 9301, role: 'user', content: body.message },
      { id: 9302, role: 'assistant', status: 'DONE', content: body.conclusion, steps: body.steps }];
    return { userMessageId: 9301, assistantMessageId: 9302 };
  };
  h.sh.api.get = async () => archivedRows;
  h.ctx.localCall = async (body) => {
    if (body.action === 'run') { runId = body.clientRunId; return { runId, timeoutMs: 0 }; }
    if (body.action === 'resume') return { found: true, events: shellSteps, result: null, running: true };
    return {};
  };
  h.input.value = '本机长任务';
  const firstPage = h.ctx.sendDesktopTurn('本机长任务');
  await settle();
  assert.ok(runId, '本机任务没有启动');
  const t1 = { runId, type: 'trace', step: { id: 'step-1', title: '第一步', status: 'RUNNING' } };
  h.emit('zq-local', t1);
  h.ctx.bindTurnLifecycle(); h.emit('pagehide');
  // 销毁第一份页面的所有监听。任务继续在外壳，页面上的存档协程不可能执行了。
  h.events.clear();
  shellSteps = [
    { runId, type: 'trace', step: { id: 'step-1', title: '离开后第一步已完成', status: 'DONE' } },
    { runId, type: 'trace', step: { id: 'step-2', title: '离开期间第二步', status: 'RUNNING' } }
  ];
  const back = harness(h.ctx.sessionStorage);
  back.input.value = '本机长任务'; // 旧页面发送时未清除的草稿不能误导用户再发一遍
  back.ctx.inDesktop = () => true; back.ctx.localCall = h.ctx.localCall;
  back.sh.api = h.sh.api; back.ctx.bind(back.sh);
  await back.ctx.loadAiMessages(); await settle();
  assert.equal(archive.length, 0, '不能等 done 才恢复中间步骤');
  assert.equal(back.s.messages[0].content, '本机长任务', '返回后用户消息消失');
  assert.equal(back.input.value, '', '已经启动的本机任务仍作为未发送草稿留在输入框');
  assert.equal(back.s.messages[1].steps.steps.length, 2, '离开期间新增步骤没补齐');
  assert.equal(back.s.messages[1].steps.steps[0].title, '离开后第一步已完成', '旧步骤状态没有同步外壳最新快照');
  back.emit('zq-local', { runId, type: 'trace', step: { id: 'step-3', title: '回来后第三步', status: 'DONE' } });
  assert.equal(back.s.messages[1].steps.steps.length, 3, '补齐之后没接上后续实时消息');
  back.emit('zq-local', { runId, type: 'result', conclusion: '全部完成', drafts: [] });
  await settle();
  assert.equal(archive.length, 1, '导航后最终结果未存档或存了两次');
  assert.equal(archive[0].body.steps.steps.length, 3);
  assert.equal(archive[0].headers['Idempotency-Key'], 'desktop-turn-' + runId);
  assert.equal(back.s.messages.at(-1).content, '全部完成');
  assert.equal(back.ctx.runningTurn(), null, '存档成功还残留运行记号');
  // 原页面 promise 被销毁的模拟无需等待；它没有真实定时器或 I/O，不会妨碍进程退出。
  void firstPage;
}
async function checkQueueIsolation() {
  const h = harness();
  h.ctx.enqueueSend('留在 A 的排队消息');
  h.ctx.saveSendQueue();
  h.ctx.setAiNotebookId(6); h.s.messages = [];
  let sent = [];
  h.ctx.sendAiMessage = (text) => sent.push(text);
  h.ctx.pumpSendQueue();
  assert.equal(sent.length, 0, 'A 的排队消息错误发给 B');
  h.ctx.setAiNotebookId(5); h.ctx.restoreSendQueue(); h.ctx.pumpSendQueue();
  assert.deepEqual(sent, ['留在 A 的排队消息'], '队列未跨导航保存');
}
async function checkRaces() {
  // 同一个 notebook 的旧 GET 回来得比完成后的新 GET 晚，也不能擦掉最新结果。
  const h = harness();
  let oldReply, calls = 0;
  h.sh.api.get = async () => ++calls === 1 ? new Promise((r) => { oldReply = r; })
    : [{ id: 9401, role: 'assistant', status: 'DONE', content: '最终存档' }];
  const old = h.ctx.loadAiMessages();
  await h.ctx.loadAiMessages(); oldReply([]); await old;
  assert.equal(h.s.messages.length, 1, '旧的存档前回包清空了刚完成的回答');
  assert.equal(h.s.messages[0].content, '最终存档', '旧的存档前回包覆盖了刚完成的回答');

  // 旧快照里 RUNNING，库里同一步已经 DONE；恢复不能倒退状态 / 丢掉新版细节。
  h.ctx.markRunningTurn(801, 5, 9401);
  const mark = h.ctx.runningTurn();
  mark.assistant = { id: 9401, role: 'assistant', status: 'STREAMING', content: '',
    steps: { steps: [{ id: 'same', status: 'RUNNING', title: '旧步骤' }] } };
  h.ctx.sessionStorage.setItem(h.ctx.runningStorageKey(5), JSON.stringify(mark));
  const merged = h.ctx.mergeRunningMessages([{ id: 9401, role: 'assistant', status: 'STREAMING', content: '',
    steps: { steps: [{ id: 'same', status: 'DONE', title: '已经完成', output: '新版细节' }] } }]);
  assert.equal(merged[0].steps.steps[0].status, 'DONE', '旧离页快照把库里的终态步骤倒退了');
  assert.equal(merged[0].steps.steps[0].output, '新版细节');

  // result 在 resume 应答之前先到，仍必须等历史步骤补齐才交结果存档。
  const d = harness();
  let release;
  d.ctx.localCall = () => new Promise((r) => { release = r; });
  const assistant = { role: 'assistant', content: '', steps: { steps: [] } };
  let done = false;
  const pending = d.ctx.waitLocal('local-race', assistant, () => true, 0).then((r) => { done = true; return r; });
  d.emit('zq-local', { runId: 'local-race', type: 'result', conclusion: '已完成' });
  await settle();
  assert.equal(done, false, '终态抢先结束等待，离开期间步骤还没有同步就去存档/ack');
  release({ found: true, events: [{ runId: 'local-race', type: 'trace', step: { id: 'missed', status: 'DONE' } }], result: null });
  assert.equal((await pending).conclusion, '已完成');
  assert.equal(assistant.steps.steps.length, 1, '终态先到导致历史步骤永久漏掉');

  // 新任务写快照不能继承旧任务还没存档的 result。
  const p = harness();
  p.ctx.sessionStorage.setItem(p.ctx.runningStorageKey(5), JSON.stringify({ runId: 'old-local', nb: 5, kind: 'desktop', result: { conclusion: '旧结论' } }));
  p.ctx.persistTurn({ nb: 5, runId: 'new-local', assistant: { content: '' },
    desktopInfo: { message: '新问题', folder: '/test' } }, true);
  assert.equal(p.ctx.runningTurn().result, undefined, '新任务继承旧终态，会把新问题和旧结论配对存档');
}
(async () => {
  await checkNavigation(); await checkReplay(); await checkHeaderTimeout();
  await checkDesktopReturn(); await checkQueueIsolation(); await checkRaces(); await checkLocalWait();
  console.log('ALL-GREEN');
})().catch((e) => { console.error(e); process.exitCode = 1; });
