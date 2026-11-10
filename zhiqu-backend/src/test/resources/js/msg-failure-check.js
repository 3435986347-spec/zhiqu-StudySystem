// 聊天气泡里「这次回答失败了 / 不完整」的行为判据（第十九轮）—— 直接跑 assets/zhiqu-api.js 里发布的那份实现。
//
//   用法：node src/test/resources/js/msg-failure-check.js <zhiqu-api.js 的路径>
//   退出码 0 = 全绿；非 0 = 有判据红了，逐条打印在上面。
//
// 由 MessageFailureRenderingTest 调用。原来：失败时已经出来了半截，就不说失败原因（看着像是模型说完了）；
// 刷新之后失败的回答是一个空白气泡（errorMessage 页面从来不读）；被截断的回答一个字都不说。
// 失败原因里有供应商给的原文 —— 那是别人服务器上的任意文本，进 innerHTML 前必须转义。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

function slice(startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error('抠不到起点: ' + startMark);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error('抠不到终点: ' + endMark);
  return src.slice(a, b);
}
const escSrc = slice('function esc(v) {', 'function maintainShellCache');

// 第三十七轮起 AI 助手的代码在 assets/pages/ai-assistant.js 里（顶格）：这一段从那里抠 —— 它要在同一个作用域里替换掉内部用到的东西，
// import 进来的模块换不掉，所以照第三十六轮 wiki-tabs-check 的做法从源码里抠同一段
const modSrc = fs.readFileSync(require('path').join(require('path').dirname(require('path').resolve(process.argv[2])), 'pages', 'ai-assistant.js'), 'utf8');
function sliceMod(startMark, endMark) {
  const a = modSrc.indexOf(startMark);
  if (a < 0) throw new Error('模块里抠不到起点: ' + startMark);
  const b = modSrc.indexOf(endMark, a);
  if (b < 0) throw new Error('模块里抠不到终点: ' + endMark);
  return modSrc.slice(a, b);
}
const bodySrc = sliceMod('function messageBodyHtml(m, i) {', '/**\n * 流式增量');
// waitText 用业务时钟（第二十一轮）：把那一段也抠进来 —— 真的实现，不是替身
const clockSrc = slice('  var clock = { zone:', '  /** 浏览器的钟面和业务时区不一样时');
if (!/function waitText/.test(bodySrc)) throw new Error('抠出来的片段里没有 waitText —— 抠错地方了');

// 正文的 Markdown 渲染不是这里要判的：换成最朴素的转义，只看正文之外多出来的那几行
const mod = new Function(
  'var state = { reasoningExpanded: {} };\n'
  + 'var setInterval = function () {};\n'
  + 'function renderMarkdown(s) { return "<p>" + esc(s) + "</p>"; }\n'
  + 'function reflowFlatMarkdown(s) { return s; }\n'
  + 'function traceStepsHtml() { return ""; }\n'
  + escSrc + '\n' + clockSrc + '\n' + bodySrc + '\nreturn { messageBodyHtml, waitText };')();

let fail = 0;
function judge(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); }
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}
function strayTags(html) {
  return (html.match(/<[^>]*>/g) || []).filter(t => !/^<(p|div|span)( [^>]*)?>$/.test(t) && !/^<\/(p|div|span)>$/.test(t));
}

// 1 失败了、已经出来半截：半截和原因都在，原因在正文后面
{
  const html = mod.messageBodyHtml({ role: 'assistant', status: 'ERROR', content: '第一段。', errorMessage: '模型的回答没说完，连接就断了' }, 0);
  judge('半截正文还在', html.includes('第一段。'), html);
  judge('失败原因也在', html.includes('没说完'), html);
  judge('原因在正文后面', html.indexOf('第一段。') < html.indexOf('没说完'), html);
}
// 2 失败了、一个字都没有：不能是空白气泡
{
  const html = mod.messageBodyHtml({ role: 'assistant', status: 'ERROR', content: '', errorMessage: 'API Key 不对' }, 0);
  judge('没有正文时原因照样显示', html.includes('API Key 不对'), html);
}
// 3 能用但不完整：说明显示在回答底下
{
  const html = mod.messageBodyHtml({ role: 'assistant', status: 'DONE', content: '说了很多', notice: '回答写到了单次输出的上限' }, 0);
  judge('不完整的说明显示', html.includes('单次输出的上限') && html.indexOf('说了很多') < html.indexOf('单次输出'), html);
  const plain = mod.messageBodyHtml({ role: 'assistant', status: 'DONE', content: '好的。' }, 0);
  judge('完整的回答不多一行', !/data-msg-(error|notice)/.test(plain), plain);
}
// 4 供应商的原文进了原因：转义，不产生标签
for (const evil of ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '"><svg/onload=alert(1)>']) {
  const e = mod.messageBodyHtml({ role: 'assistant', status: 'ERROR', content: '', errorMessage: '供应商说：' + evil }, 0);
  judge('失败原因转义：' + JSON.stringify(evil), strayTags(e).length === 0 && e.includes('&lt;'), e);
  const n = mod.messageBodyHtml({ role: 'assistant', status: 'DONE', content: 'x', notice: evil }, 0);
  judge('说明转义：' + JSON.stringify(evil), strayTags(n).length === 0, n);
}
// 5 用户自己的消息不带这些
{
  const html = mod.messageBodyHtml({ role: 'user', content: '你好', errorMessage: 'x', notice: 'y' }, 0);
  judge('用户的消息不显示失败原因 / 说明', !/data-msg-(error|notice)/.test(html), html);
}
// 6 还没收到第一个字：说出等了多久
{
  const now = Date.now();
  judge('刚开始：正在生成…', mod.waitText(now - 1000) === '正在生成…', mod.waitText(now - 1000));
  judge('10 秒：说出秒数', mod.waitText(now - 10_000).includes('已等 10 秒'), mod.waitText(now - 10_000));
  judge('40 秒：说还在等模型', mod.waitText(now - 40_000).includes('还在等模型'), mod.waitText(now - 40_000));
  const html = mod.messageBodyHtml({ role: 'assistant', status: 'STREAMING', content: '', _startedAt: now - 12_000 }, 0);
  judge('等待的那一行带着起点（每秒刷新靠它）', html.includes('data-wait-since="' + (now - 12_000) + '"') && html.includes('已等 12 秒'), html);
}

// 第一百二十八轮：命令行旧存档的「> 过程：…」那一行（heredoc 被当 Markdown / 公式渲染成乱码）—— 收起来、只说一共几步；正文照旧
{
  const old = { role: 'assistant', content: '做好了。\n\n> 过程：列出 . · 运行 cat <<\'EOF\'\n$x$ · 读取 a.js …共 32 步' };
  const h = mod.messageBodyHtml(old, 1);
  judge('旧存档的「过程：」那一行收起来（不进正文）', !h.includes('过程：') && !h.includes('EOF') && h.includes('做好了。'), h);
  judge('只说一共几步', h.includes('做了 32 步'), h);
  const plain = mod.messageBodyHtml({ role: 'assistant', content: '我在回答里提到了 > 过程：这个词，但不在结尾' }, 2);
  judge('正文里正常提到「过程：」的不动', plain.includes('过程：这个词'), plain);
  const quoted = mod.messageBodyHtml({ role: 'assistant', content: '解法如下。\n\n> 过程：先求导，令导数为 0\n\n所以最小值是 3。' }, 7);
  judge('回答里正常的一段「> 过程：先求导…」不当旧存档吞掉（review：原来连后面的结论一起藏了）', quoted.includes('先求导') && quoted.includes('所以最小值是 3') && !quoted.includes('旧的存档没有分步记下'), quoted);
  const agentFirst = mod.messageBodyHtml({ role: 'assistant', content: '好了\n\n> 过程：派干活的子 agent：改测试 · 等子 agent agent-1' }, 8);
  judge('头一步是派子 agent 的旧存档也认得', agentFirst.includes('做了 2 步') && !agentFirst.includes('派干活的'), agentFirst);
  const mine = mod.messageBodyHtml({ role: 'user', content: '帮我看看\n\n> 过程：这是我自己写的' }, 3);
  judge('用户自己说的话不动', mine.includes('这是我自己写的'), mine);
}

// 第一百二十八轮补：旧消息的思考步骤只有字数（没有 detail、也没有 hasDetail），点不开 ——
// 「下面不再放思考摘要」的判断不能把它也算成「已经有思考原文」，否则 reasoningSummary 被整条藏掉，页面上再也没有入口
{
  const base = { role: 'assistant', status: 'DONE', reasoningMode: 'ON', reasoningSummary: '旧的思考摘要', content: '答' };
  const old = { ...base, steps: { steps: [{ id: 's1', kind: 'thinking', title: '思考', summary: '3 秒', status: 'ok' }] } };
  judge('旧的思考步骤没有内容时，仍显示思考摘要', mod.messageBodyHtml(old, 4).includes('思考摘要'), mod.messageBodyHtml(old, 4));
  // 第一百二十七轮代码模式存的思考步骤带着 detail，但只有字数 {chars}：点开是空的，也不能算「有原文」（流式时手上就是这一份）
  const charsOnly = { ...base, steps: { steps: [{ id: 's1', kind: 'thinking', title: '思考', summary: '3 秒', status: 'ok', detail: { chars: 900 } }] } };
  judge('只有字数的思考步骤不藏思考摘要', mod.messageBodyHtml(charsOnly, 9).includes('旧的思考摘要'), mod.messageBodyHtml(charsOnly, 9));
  judge('旧的思考摘要的字还在', mod.messageBodyHtml(old, 4).includes('旧的思考摘要'), mod.messageBodyHtml(old, 4));
  const fresh = { ...base, steps: { steps: [{ id: 's1', kind: 'thinking', title: '思考', summary: '3 秒', status: 'ok', detail: { text: '想了什么' } }] } };
  judge('思考步骤有原文时不重复显示摘要', !mod.messageBodyHtml(fresh, 5).includes('思考摘要'), mod.messageBodyHtml(fresh, 5));
  const loaded = { ...base, steps: { steps: [{ id: 's1', kind: 'thinking', title: '思考', summary: '3 秒', status: 'ok', hasDetail: true }] } };
  judge('思考步骤能点开（hasDetail）时也不重复显示', !mod.messageBodyHtml(loaded, 6).includes('思考摘要'), mod.messageBodyHtml(loaded, 6));
}

// 与其它判据脚本同一个约定：自报 ALL-GREEN 且退出码 0 才算过（NodeRunner 两样都查）
console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
