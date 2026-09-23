// 执行轨迹里「coding agent 逐步叙述」的行为判据 —— 直接跑 assets/zhiqu-api.js 里发布的那份实现。
//
//   用法：node src/test/resources/js/step-note-check.js <zhiqu-api.js 的路径>
//   退出码 0 = 全绿；非 0 = 有判据红了，逐条打印在上面。
//
// 由 StepNoteRenderingTest 调用。
//
// 为什么这里要判 XSS：命令输出是用户机器上**跑出来的任意文本** —— 一个打印 HTML 的脚本、
// 一段含 <script> 的测试夹具，都会原样进 agent.step.note。它被拼进轨迹栏的 innerHTML，
// 少一个 esc 就是在自己的页面里执行它。
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
const noteSrc = slice('function stepNoteHtml(n) {', '/** 单行时的高度');
// 扰动落地核对：抠出来的片段必须真的是那个函数，而且不能是空壳
if (!/esc\(/.test(noteSrc)) throw new Error('抠出来的 stepNoteHtml 里一次 esc 都没有 —— 抠错地方了，或者转义被删了');

const mod = new Function(escSrc + '\n' + noteSrc + '\nreturn { stepNoteHtml, esc };')();

let fail = 0;
function judge(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); }
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}

// 除了我们自己的 <pre …> / <div …> 与对应的闭合，不许有任何标签
function strayTags(html) {
  return (html.match(/<[^>]*>/g) || []).filter(t => !/^<(pre|div) [^>]*>$/.test(t) && t !== '</pre>' && t !== '</div>');
}

const evil = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '"><svg/onload=alert(1)>',
  "'; alert(1); '",
  '</pre><img src=x onerror=alert(1)>',
];

// 判据 1：命令输出（result）里的任何 HTML 都被转义，不产生标签
for (const e of evil) {
  const html = mod.stepNoteHtml({ phase: 'result', message: '退出码 0\n' + e });
  judge('result 转义：' + JSON.stringify(e), strayTags(html).length === 0, html);
}

// 判据 2：调用叙述（call / budget / 无 phase）同样转义 —— 文件名也可能是 <x>.html
for (const phase of ['call', 'budget', '']) {
  const html = mod.stepNoteHtml({ phase, message: '读取 ' + evil[0] });
  judge('「' + (phase || '无 phase') + '」转义', strayTags(html).length === 0, html);
}

// 判据 3：转义不是把内容吞掉 —— 字符还要看得见（&lt; 而不是空）
{
  const html = mod.stepNoteHtml({ phase: 'result', message: '<b>' });
  judge('转义后内容仍可见', html.includes('&lt;b&gt;'), html);
}

// 判据 4：命令输出只显示前 6 行，截了要有「…」
{
  const msg = Array.from({ length: 10 }, (_, i) => 'L' + i).join('\n');
  const html = mod.stepNoteHtml({ phase: 'result', message: msg });
  judge('长输出只留 6 行', html.includes('L5') && !html.includes('L6'), html);
  judge('截了要说出来（…）', html.includes('…'), html);
  const short = mod.stepNoteHtml({ phase: 'result', message: 'a\nb' });
  judge('没截就不加「…」', !short.includes('…'), short);
}

// 与其它判据脚本同一个约定：自报 ALL-GREEN 且退出码 0 才算过（NodeRunner 两样都查）
console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
