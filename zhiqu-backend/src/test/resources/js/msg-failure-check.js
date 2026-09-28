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
const bodySrc = slice('function messageBodyHtml(m, i) {', '  /**\n   * 流式增量');
if (!/function waitText/.test(bodySrc)) throw new Error('抠出来的片段里没有 waitText —— 抠错地方了');

// 正文的 Markdown 渲染不是这里要判的：换成最朴素的转义，只看正文之外多出来的那几行
const mod = new Function(
  'var state = { reasoningExpanded: {} };\n'
  + 'var setInterval = function () {};\n'
  + 'function renderMarkdown(s) { return "<p>" + esc(s) + "</p>"; }\n'
  + 'function reflowFlatMarkdown(s) { return s; }\n'
  + escSrc + '\n' + bodySrc + '\nreturn { messageBodyHtml, waitText };')();

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

// 与其它判据脚本同一个约定：自报 ALL-GREEN 且退出码 0 才算过（NodeRunner 两样都查）
console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
