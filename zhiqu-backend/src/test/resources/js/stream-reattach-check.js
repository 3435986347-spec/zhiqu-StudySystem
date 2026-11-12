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
  'mergeTraceStep', 'receiveAgentArtifact', 'isPlanDraft', 'planDraftItems', 'sessionStorage',
  src.slice(a, b) + '\nreturn { makeStreamApplier, runningTurn, markRunningTurn, clearRunningTurn };');
const { makeStreamApplier, runningTurn, markRunningTurn, clearRunningTurn } = factory(
  state, (m) => toasts.push(m), noop, () => true, noop, noop, noop, noop, noop, noop, store);

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
  assert.equal(JSON.parse(store.getItem('zq.ai.running')).runId, 77, '发送时没记下 runId —— 页面走了就再也接不回来');
  t.apply('message.delta', { text: '第一段' });
  t.apply('message.delta', { text: '，第二段' });
  assert.equal(t.assistant.content, '第一段，第二段', '增量没有拼起来');
  t.apply('done', { status: 'DONE', assistantMessageId: 900 });
  assert.equal(t.st.completed, true, 'done 没被认出来');
  assert.equal(store.getItem('zq.ai.running'), null, 'done 之后记号还在 —— 下次进页面会去接一轮早就结束的回答');
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
  assert.equal(store.getItem('zq.ai.running'), null, 'error 之后记号还在');
}

// 3) 服务端缓冲丢过帧：正文清空，等页面按库里的那份重铺
{
  const t = turn();
  t.apply('stream.start', { agentRunId: 79 });
  t.apply('message.delta', { text: '旧的' });
  t.apply('stream.reset', { reason: 'buffer-dropped' });
  assert.equal(t.assistant.content, '', 'reset 之后本地还留着正文，会接成两份');
}

// 4) 这一轮不在服务端内存里了：记号清掉，交给消息列表
{
  const t = turn();
  markRunningTurn(80, 5, 901);
  t.apply('stream.gone', { reason: 'expired' });
  assert.equal(store.getItem('zq.ai.running'), null, 'stream.gone 之后记号还在，页面会一直等');
}

// 5) 「立即」补进来的话要看得见
{
  const t = turn();
  toasts.length = 0;
  t.apply('message.injected', { text: '我用的是 Java 17' });
  assert.ok(toasts.some((m) => m.includes('补充给这一轮')), '补充信息没有提示，用户会以为没发出去');
}

// 6) 太老的记号不认（服务端 5 分钟就清了，留着只会白等）
{
  markRunningTurn(81, 5, 902);
  const raw = JSON.parse(store.getItem('zq.ai.running'));
  raw.at = Date.now() - 11 * 60 * 1000;
  store.setItem('zq.ai.running', JSON.stringify(raw));
  assert.equal(runningTurn(), null, '十分钟前的记号还当成在跑');
}

// 7) 别的 notebook 的记号不接
{
  markRunningTurn(82, 6, 903);
  assert.equal(runningTurn().nb, 6);
  clearRunningTurn();
  assert.equal(runningTurn(), null);
}

console.log('ALL-GREEN');
