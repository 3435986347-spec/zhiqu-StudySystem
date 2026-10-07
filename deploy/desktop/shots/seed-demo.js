// 给首页轮播截图准备一个「像真的在用」的账号（第二十六轮：定位改成 AI 办公助手，截图换成办公场景）。
//
//   node deploy/desktop/shots/seed-demo.js <令牌写到哪个文件>
//   swiftc -O -o /tmp/Snapshot deploy/desktop/shots/Snapshot.swift
//   浅色、深色各一套（第四十六轮起首页跟着页面的明暗换图）；AI 助手展开右边的执行轨迹、Wiki 展开目录：
//   SNAP_THEME=light SNAP_STORAGE='{"zq.c.执行轨迹 · 产物":"0","zq.c.zq-wiki-toc":"0"}' \
//     /tmp/Snapshot @<令牌文件> <输出目录> http://127.0.0.1:18080 /ai-assistant.html /dashboard.html /tasks.html /knowledge-wiki.html
//   SNAP_THEME=dark …（同上）
//   cwebp -q 80 -resize 2048 1280 <输出目录>/<页>-<light|dark>.png -o zhiqu-backend/src/main/resources/static/assets/shots/<页>-<light|dark>.webp
//
// 服务端要连一个可以随便写的库（不要连自己在用的那个），并带 --app.ai.allow-private-provider-url=true 起（模型是本机的假模型）。
// 账号每次新注册一个、密码随机生成且不打印；令牌写进给的文件（600 权限），只给 Snapshot 用。
// 截图里是示例数据 —— 它们是宣传图，不是谁的记录。
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const BASE = process.env.BASE || 'http://127.0.0.1:18080';
const MODEL_PORT = Number(process.env.MODEL_PORT || 18199);
const tokenFile = process.argv[2];
if (!tokenFile) { console.error('用法：node seed-demo.js <令牌写到哪个文件>'); process.exit(2); }

// 业务时区（东八区）的钟面时间，写成 2026-10-04T09:30:00
function at(dayOffset, h, m = 0) {
  const d = new Date(Date.now() + 8 * 3600e3 + dayOffset * 86400e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(h)}:${p(m)}:00`;
}

const REPLY = [
  '## 这周的先后顺序',
  '',
  '按「重要 / 紧急」排了一下：',
  '',
  '| 象限 | 事项 | 建议 |',
  '| --- | --- | --- |',
  '| 重要且紧急 | 周五的季度汇报 | 周三前出初稿，周四找主管过一遍 |',
  '| 重要不紧急 | 官网改版的首页需求 | 今天下午的会上和设计部把范围定下来 |',
  '| 紧急不重要 | 回复客户的报价邮件 | 上午 11 点前集中回完 |',
  '| 不重要不紧急 | 整理旧项目文档 | 放到周五下午，有空再做 |',
  '',
  '**今天可以这样排**：上午先回邮件（30 分钟），再用两个番茄钟写汇报大纲；下午 3 点的需求会之前，把上季度的转化数据拉好。',
  '',
  '要我把这些建成任务、带上截止前提醒吗？说一声「生成任务」就行。',
].join('\n');

// 假模型（OpenAI 兼容）：主对话回上面那段；改写检索、整理记忆、摘要这些后台调用各回一个不出错的最小答案
function fakeModel() {
  return http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(buf || '{}'); } catch (e) { /* 空请求 */ }
      const system = (body.messages || []).filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
      const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
      let content = REPLY;
      if (system.includes('你是检索查询改写器')) content = String((lastUser && lastUser.content) || '').slice(0, 60);
      else if (system.includes('你是长期记忆整理器')) content = '[]';
      else if (system.includes('你是对话摘要器')) content = '- 用户这周要交季度汇报，同时在推进官网改版';
      else if ((body.tools || []).length) content = '好的。';
      if (body.stream !== true) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const c of content.match(/[\s\S]{1,60}/g) || ['']) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
}

let token = null;
async function call(method, path, body) {
  const r = await fetch(BASE + '/api' + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { j = { raw: text.slice(0, 200) }; }
  if (!r.ok || (j.code && j.code !== 200)) throw new Error(`${method} ${path} → ${r.status} ${(j.message || j.raw || '').slice(0, 160)}`);
  return j.data;
}

(async () => {
  const model = fakeModel();
  await new Promise((ok) => model.listen(MODEL_PORT, '127.0.0.1', ok));
  try {
    const username = 'shots_' + crypto.randomBytes(4).toString('hex');
    const password = crypto.randomBytes(18).toString('base64url');
    await call('POST', '/auth/register', { username, password, confirmPassword: password });
    token = (await call('POST', '/auth/login', { username, password })).token;
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    await call('PUT', '/user/profile', { nickname: '林舟', school: '星河科技', major: '市场部 · 产品运营' });

    const tasks = [
      { title: '准备周五的季度汇报', description: '数据截至 9 月 30 日，先出大纲再补图表', quadrant: 1, priority: 2, startTime: at(0, 10, 0), durationMinutes: 90, deadline: at(2, 18) },
      { title: '和设计部对齐官网首页需求', description: '带上上周的用户访谈结论', quadrant: 2, priority: 1, startTime: at(0, 15, 0), durationMinutes: 60, deadline: at(0, 16) },
      { title: '回复星河客户的报价邮件', quadrant: 3, priority: 1, startTime: at(0, 9, 30), durationMinutes: 30, deadline: at(0, 11) },
      { title: '梳理下季度 OKR 草案', quadrant: 2, priority: 1, startTime: at(1, 14, 0), durationMinutes: 60, deadline: at(4, 18) },
      { title: '提交 9 月报销单', quadrant: 3, priority: 0, startTime: at(1, 11, 0), durationMinutes: 20, deadline: at(3, 12) },
      { title: '约新同事做一次 1:1', quadrant: 2, priority: 1, startTime: at(2, 16, 0), durationMinutes: 30, deadline: at(2, 17) },
      { title: '整理旧项目文档', quadrant: 4, priority: 0, startTime: at(4, 15, 0), durationMinutes: 60, deadline: at(4, 18) },
    ];
    const ids = [];
    for (const t of tasks) ids.push((await call('POST', '/task', Object.assign({ status: 0, reminderOffsets: [] }, t))).id);
    // 这周已经过去的那几天各放一两件做完的事 —— 不然在周末、周一跑，看板的本周日历几乎是空的
    const weekday = new Date(Date.now() + 8 * 3600e3).getUTCDay() || 7;   // 1=周一 … 7=周日
    const done = [['发出周会纪要', 10], ['更新竞品对比表', 14], ['和财务确认预算', 11], ['评审活动落地页文案', 16],
      ['整理客户反馈', 10], ['跟进合同盖章', 15], ['写渠道合作方案', 9], ['复盘上周投放数据', 14], ['准备面试题', 11], ['回访老客户', 16]];
    for (let back = weekday - 1, i = 0; back >= 1; back--) {
      for (let k = 0; k < 2 && i < done.length; k++, i++) {
        const [title, h] = done[i];
        const t = await call('POST', '/task', { title, quadrant: 2, priority: 1, status: 0, startTime: at(-back, h), durationMinutes: 45, deadline: at(-back, h + 2), reminderOffsets: [] });
        await call('PUT', `/task/${t.id}/status?status=2`);
      }
    }
    await call('PUT', `/task/${ids[2]}/status?status=1`);   // 邮件：进行中
    await call('POST', '/record', { taskId: ids[0], durationMinutes: 25, note: '汇报大纲' });
    await call('POST', '/record', { taskId: ids[0], durationMinutes: 25, note: '拉数据' });

    await call('POST', '/routine', { title: '晨会前过一遍今日待办', frequency: 'DAILY', durationMinutes: 10, preferredTime: '09:20', reminderEnabled: true });
    await call('POST', '/routine', { title: '下班前写工作日志', frequency: 'DAILY', durationMinutes: 15, preferredTime: '17:30', reminderEnabled: true });
    await call('POST', '/routine', { title: '周一写本周计划', frequency: 'WEEKLY', daysOfWeek: [1], durationMinutes: 20, preferredTime: '09:00', reminderEnabled: true });

    await call('POST', '/knowledge/pages', { title: '官网改版', pageType: 'topic', content: '# 官网改版\n\n- 目标：首页转化率提升到 4%\n- 负责人：林舟（产品）、设计部\n- 关联：[[用户访谈结论（9 月）]]、[[汇报：第三季度]]\n\n## 里程碑\n\n| 阶段 | 时间 |\n| --- | --- |\n| 需求冻结 | 10 月 10 日 |\n| 设计稿 | 10 月 24 日 |\n| 上线 | 11 月 15 日 |\n' });
    await call('POST', '/knowledge/pages', { title: '用户访谈结论（9 月）', pageType: 'topic', content: '# 用户访谈结论（9 月）\n\n访谈 12 位用户：\n\n1. 首页信息太多，找不到「免费试用」\n2. 价格页对比不清楚\n3. 移动端加载慢\n\n见 [[官网改版]]。\n' });
    await call('POST', '/knowledge/pages', { title: '汇报：第三季度', pageType: 'topic', content: '# 汇报：第三季度\n\n- 新增客户 46 家，环比 +18%\n- 续费率 91%\n- 下季度重点：[[官网改版]]、渠道合作\n' });

    const nb = await call('POST', '/ai/notebooks', { title: '官网改版项目', description: '需求、访谈和排期' });
    await call('POST', `/ai/notebooks/${nb.id}/sources`, { title: '9 月用户访谈纪要', sourceType: 'text', content: '访谈 12 位用户，主要问题：首页信息太多、价格页对比不清、移动端加载慢。' });
    const cfg = await call('POST', '/ai/models', { displayName: '示例模型', providerType: 'OPENAI_COMPATIBLE', modelName: 'demo', apiUrl: `http://127.0.0.1:${MODEL_PORT}/v1/chat/completions`, apiKey: 'demo-key-0123456789' });
    const r = await fetch(BASE + '/api/ai/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Accept: 'text/event-stream' },
      body: JSON.stringify({ message: '这周要交季度汇报，还在推进官网改版，另外有几封客户邮件要回。帮我理一下先后。', modelConfigId: cfg.id, notebookId: nb.id, agentMode: 'AUTO', reasoningMode: 'OFF', contextOptions: { includeWiki: false } }),
    });
    const sse = await r.text();
    if (/event:\s*error/.test(sse)) throw new Error('聊天失败：' + sse.slice(sse.search(/event:\s*error/), 300));
    await new Promise((ok) => setTimeout(ok, 3000));   // 回答之后的后台步骤（摘要、记忆）还会再调一两次模型
    console.log('示例账号已就绪，令牌在 ' + tokenFile);
  } finally {
    model.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
