// 给一个账号的每一处「显示用户内容」的地方塞极端内容（第二十轮）。
//
//   node tools/layout-check/fake-model.js &                       # 假模型，回答也是极端内容
//   node tools/layout-check/seed.js <用户令牌> [管理员令牌]         # 给了管理员令牌就顺手把提交的参考计划审核通过
//
// 服务端要带 --app.ai.allow-private-provider-url=true 起（模型地址是本机）。BASE 默认 http://127.0.0.1:18080。
const X = require('./extreme');

const BASE = process.env.BASE || 'http://127.0.0.1:18080';
const MODEL_URL = process.env.MODEL_URL || 'http://127.0.0.1:18199/v1/chat/completions';
const [token, adminToken] = process.argv.slice(2);
if (!token) { console.error('用法：node seed.js <用户令牌> [管理员令牌]'); process.exit(2); }

async function call(method, path, body, tk = token) {
  const r = await fetch(BASE + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { j = { raw: text.slice(0, 200) }; }
  if (!r.ok || (j.code && j.code !== 200)) console.log('  失败', method, path, r.status, (j.message || j.raw || '').slice(0, 160));
  return j.data;
}
const cut = (s, n) => [...s].slice(0, n).join('');
const pad = (n) => String(n).padStart(2, '0');
function at(dayOffset, h) {
  const d = new Date(Date.now() + dayOffset * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(h)}:00:00`;
}

(async () => {
  // 字段长度按库里的列：任务 / 例行计划标题 200、Wiki 页名 120、Notebook 名 120、昵称 50、参考计划标题 160、反馈 1000
  const titles = [cut(X.LONG_URL, 200), cut(X.LONG_WORD, 200), cut(X.EMOJI, 60), X.RTL, cut(X.ZALGO, 200), cut(X.CJK_RUN, 200)];
  const taskIds = [];
  for (let i = 0; i < titles.length; i++) {
    const t = await call('POST', '/task', {
      title: titles[i], description: X.MARKDOWN, quadrant: (i % 4) + 1, priority: 1, status: 0, taskType: 'study', difficulty: 3,
      startTime: at((i % 3) - 1, 9 + i), durationMinutes: 45, deadline: at(i % 3, 20),
    });
    if (t && t.id) taskIds.push(t.id);
  }
  const routineIds = [];
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', '/routine', {
      title: titles[i], description: cut(X.MARKDOWN, 1900), frequency: i % 2 ? 'WEEKLY' : 'DAILY', daysOfWeek: i % 2 ? [1, 3, 5] : undefined,
      durationMinutes: 30, preferredTime: '08:00', reminderEnabled: true,
    });
    if (r && r.id) routineIds.push(r.id);
  }
  await call('PUT', '/user/profile', { nickname: cut(X.LONG_WORD, 50), school: cut(X.LONG_URL, 100), major: cut(X.EMOJI, 40) });
  for (let i = 0; i < 3; i++) await call('POST', '/knowledge/pages', { title: cut(titles[i], 120), content: X.MARKDOWN, pageType: 'topic' });
  await call('POST', '/knowledge/sources', { title: cut(X.LONG_URL, 180), content: X.MARKDOWN, sourceType: 'text' });
  const nb = await call('POST', '/ai/notebooks', { title: cut(X.LONG_WORD, 120), description: cut(X.LONG_URL, 500) });
  await call('POST', '/ai/notebooks', { title: cut(X.EMOJI, 40), description: X.RTL });
  const model = await call('POST', '/ai/models', {
    displayName: cut(X.LONG_WORD, 100), providerType: 'OPENAI_COMPATIBLE', modelName: 'fake-' + 'x'.repeat(60),
    apiUrl: MODEL_URL, apiKey: 'fake-key-0123456789',
  });
  // 一段用户的长消息 + 假模型的极端回答：普通聊天一条、Notebook 里一条
  for (const [msg, notebookId] of [[`${X.LONG_URL} ${X.EMOJI}`, null], [X.MARKDOWN, nb && nb.id]]) {
    const r = await fetch(BASE + '/api/ai/chat/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Accept: 'text/event-stream' },
      body: JSON.stringify({ message: msg, modelConfigId: model && model.id, notebookId, agentMode: 'AUTO', reasoningMode: 'OFF', contextOptions: { includeWiki: false } }),
    });
    const text = await r.text();
    if (/event:\s*error/.test(text)) console.log('  聊天失败', text.slice(text.indexOf('event:error'), 300));
  }
  await call('POST', '/shared-plans/from-existing', {
    title: cut(X.LONG_WORD, 160), description: cut(X.MARKDOWN, 1000), category: 'other', taskIds: taskIds.slice(0, 3), routineIds: routineIds.slice(0, 2), shareConsent: true,
  });
  await call('POST', '/feedback', { content: `${X.LONG_URL} ${cut(X.EMOJI, 40)} ${cut(X.ZALGO, 200)}`, type: 'bug', contact: cut(X.LONG_WORD, 100) });
  if (adminToken) {
    const pending = await call('GET', '/admin/shared-plans', null, adminToken);
    for (const p of pending || []) if (p.status !== 'APPROVED') await call('PUT', `/admin/shared-plans/${p.id}/review?action=APPROVE`, null, adminToken);
  }
  console.log(`任务 ${taskIds.length}、例行计划 ${routineIds.length}、Notebook ${nb ? nb.id : '—'}、模型 ${model ? model.id : '—'}`);
  if (nb) console.log(`看 AI 助手里那段极端回答：LS='{"zq-ai-notebook":"${nb.id}"}' node check.js …`);
})();
