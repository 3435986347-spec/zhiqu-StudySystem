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
// 第三十七轮起 stepNoteHtml 在 AI 助手的模块里：直接 import，bind 一个只带真 esc 的 sh（esc 还在壳里，照旧从壳里取）
const { esc } = new Function(escSrc + '\nreturn { esc };')();
const modPath = require('path').join(require('path').dirname(require('path').resolve(process.argv[2])), 'pages', 'ai-assistant.js');
(async () => {
  const mod = await import(require('url').pathToFileURL(modPath).href);
  mod.bind({ esc });
  for (const fn of ['stepNoteHtml']) if (typeof mod[fn] !== 'function') throw new Error('pages/ai-assistant.js 没有导出 ' + fn);
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
})().catch((e) => { console.log('加载失败：' + e.stack); process.exit(1); });
