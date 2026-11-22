const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');

(async () => {
const src = fs.readFileSync(process.argv[2], 'utf8');
const storage = (() => {
  const values = {};
  return { getItem: (key) => values[key] || null, setItem: (key, value) => { values[key] = String(value); }, removeItem: (key) => { delete values[key]; } };
})();
const panel = { hidden: true, innerHTML: '' };
const state = { user: { id: 1 }, notebookId: 5, messages: [] };
const esc = (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const posts = [];
const sh = {
  state, API: '/api', REQUEST_TIMEOUT_MS: 30, token: () => null,
  api: { get: async () => [], post: async (path, body) => { posts.push({ path, body }); return { accepted: true }; } },
  $: (selector) => selector === '#zq-decision' ? panel : null,
  $all: () => [], esc, icon: () => '<svg></svg>', nowMs: Date.now,
  requestError: (message, flags) => Object.assign(new Error(message), flags),
  toast: () => {}, safe: async (_, fn) => fn(), drafts: { clearIf: () => {} },
};
const ctx = vm.createContext({ console, Date, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  sessionStorage: storage, localStorage: storage, AbortController, TextDecoder, TextEncoder,
  window: { addEventListener: () => {}, removeEventListener: () => {} }, document: { getElementById: () => null } });
vm.runInContext(src.replace(/^export function /gm, 'function ').replace(/^export const /gm, 'const ').replace(/^export \{[^\n]*\};/gm, ''), ctx);
ctx.bind(sh);
ctx.renderAiMessages = () => {};
ctx.patchStreamingMessage = () => true;
ctx.renderAgentPanels = async () => {};
ctx.stopStreamWatch = () => {};
ctx.watchStreamingMessages = () => {};
ctx.renderSendQueue = () => {};

const data = {
  decisionId: 'd1',
  questions: [
    { id: 'q1', header: '实现', question: '采用哪种实现？', allowOther: false, options: [
      { id: 'o1', label: '方案甲<img src=x onerror=alert(1)>', description: '<b>说明</b>', recommended: true },
      { id: 'o2', label: '方案乙', description: '备选', recommended: false },
    ] },
    { id: 'q2', header: '验证', question: '怎样验证？', allowOther: true, options: [
      { id: 'o1', label: '自动验证', description: '', recommended: true },
      { id: 'o2', label: '手工验证', description: '', recommended: false },
    ] },
  ],
};
const view = ctx.createDecisionView(77, 5, data);
assert.equal(view.answers.q1, undefined, '推荐项被自动当成答案');
assert.equal(ctx.decisionComplete(view), false);
view.answers.q1 = { optionId: 'o2' };
view.answers.q2 = { optionId: '__other__', otherText: ' ' };
assert.equal(ctx.decisionComplete(view), false, '空的其他输入也能提交');
view.answers.q2.otherText = '  真浏览器验证  ';
assert.equal(ctx.decisionComplete(view), true);
assert.deepEqual(JSON.parse(JSON.stringify(ctx.decisionPayload(view))), {
  cancelled: false,
  answers: [{ questionId: 'q1', optionId: 'o2' }, { questionId: 'q2', optionId: '__other__', otherText: '真浏览器验证' }],
});

const st = { nb: 5, runId: 77, assistant: { role: 'assistant', content: '', status: 'STREAMING' }, sameNb: () => true,
  stored: true, dropped: false, completed: false, failed: false, marked: true };
const apply = ctx.makeStreamApplier(st);
apply('decision.ask', data);
assert.equal(panel.hidden, false, 'decision.ask 没有打开面板');
assert.ok(panel.innerHTML.includes('方案甲&lt;img src=x onerror=alert(1)&gt;'), '模型文字没有 HTML 转义');
assert.ok(!panel.innerHTML.includes('方案甲<img src=x'), '模型文字被当成 HTML 注入');
assert.ok(panel.innerHTML.includes('&lt;b&gt;说明&lt;/b&gt;'));
assert.ok(panel.innerHTML.includes('（推荐）'));
assert.ok(panel.innerHTML.includes('data-decision-submit disabled'), '没回答时提交按钮没有禁用');

state.notebookId = 6;
ctx.syncTurnUi();
assert.equal(panel.hidden, true, '切到另一个 Notebook 还显示旧问题');
state.notebookId = 5;
ctx.syncTurnUi();
assert.equal(panel.hidden, false, '切回来没有恢复当前 Notebook 的问题');
apply('decision.resolved', { decisionId: 'd1', cancelled: false, answers: [] });
assert.equal(panel.hidden, true, '重放 resolved 后旧面板没有收起');

apply('decision.ask', data);
const pending = ctx.decisionRuns['77'];
pending.answers.q1 = { optionId: 'o2' };
pending.answers.q2 = { optionId: '__other__', otherText: '真浏览器验证' };
await ctx.submitDecision(pending);
assert.equal(posts.length, 1, '答案接口调用次数不对');
assert.equal(posts[0].path, '/ai/runs/77/decisions/d1/answer');
assert.equal(posts[0].body.answers[1].otherText, '真浏览器验证');
assert.equal(panel.hidden, true, '服务端接受后没有收起面板');
await ctx.submitDecision(pending);
assert.equal(posts.length, 1, '成功后的重复提交再次调用了接口');

apply('decision.ask', data);
const retry = ctx.decisionRuns['77'];
retry.answers.q1 = { optionId: 'o1' };
retry.answers.q2 = { optionId: 'o1' };
sh.api.post = async () => { throw new Error('offline'); };
await ctx.submitDecision(retry);
assert.equal(retry.submitting, false, '失败后还锁着提交按钮');
assert.ok(retry.error.includes('没有确认提交'));
assert.equal(panel.hidden, false, '未确认提交时面板被误关');
apply('error', { message: '停止' });
assert.equal(panel.hidden, true, '运行失败后还留着无法回答的旧面板');

// 桌面本机问题复用同一个面板，但答案只交给外壳，不能再 POST 到服务器运行接口。
const localCalls = [];
ctx.localCall = async (body) => { localCalls.push(body); return { accepted: true }; };
const localSt = { nb: 5, runId: 'local-9', sameNb: () => true };
ctx.receiveDecision(localSt, Object.assign({}, data, { decisionId: 'd9', local: true }));
const localView = ctx.decisionRuns['local-9'];
localView.answers.q1 = { optionId: 'o2' };
localView.answers.q2 = { optionId: '__other__', otherText: '在本机验证' };
const serverPosts = posts.length;
await ctx.submitDecision(localView);
assert.equal(localCalls.length, 1, '本机答案没有走 zqLocal answer');
assert.equal(localCalls[0].action, 'answer');
assert.equal(localCalls[0].runId, 'local-9');
assert.equal(localCalls[0].decisionId, 'd9');
assert.equal(localCalls[0].answers[1].otherText, '在本机验证');
assert.equal(posts.length, serverPosts, '本机答案误发到了服务器');
assert.equal(panel.hidden, true, '外壳接受本机答案后没有收起面板');

console.log('ALL-GREEN');
})().catch((error) => { console.error(error); process.exitCode = 1; });
