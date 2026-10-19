// 代码草稿 diff 的行为判据 —— 直接跑 assets/zhiqu-api.js 里发布的那份实现。
//
//   用法：node src/test/resources/js/diff-check.js <zhiqu-api.js 的路径>
//   退出码 0 = 全绿。由 CodeDiffJudgmentTest 调用，手动跑也行。
//
// 最硬的一条是判据 2：把 diff 还原回去必须逐字等于原文。它同时证明了
// 「没丢行」「没凭空多行」「没改内容」—— 而这三件事在一个渲染出来的 diff 里
// 用肉眼是看不出来的：少显示一行删除，用户确认时就不知道那一行会消失。

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
// 第三十七轮起 diffLines / diffHtml 在 AI 助手的模块里：直接 import，bind 一个只带真 esc 的 sh（esc 还在壳里，照旧从壳里取）
const { esc } = new Function(escSrc + '\nreturn { esc };')();
const modPath = require('path').join(require('path').dirname(require('path').resolve(process.argv[2])), 'pages', 'ai-assistant.js');
(async () => {
  const mod = await import(require('url').pathToFileURL(modPath).href);
  mod.bind({ esc });
  for (const fn of ['diffLines', 'diffHtml']) if (typeof mod[fn] !== 'function') throw new Error('pages/ai-assistant.js 没有导出 ' + fn);
  let fail = 0;
  const judge = (name, cond, detail) => {
    if (cond) console.log('  PASS  ' + name);
    else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
  };

  // 判据 1：相同的文本没有任何增删
  console.log('── 判据 1：相同文本不产生增删 ──');
  {
    const t = 'a\nb\nc';
    const rows = mod.diffLines(t, t);
    judge('全是未改动行', rows.every(r => r[0] === ' '), JSON.stringify(rows));
  }

  // 判据 2（最硬）：还原必须逐字等于原文
  console.log('── 判据 2：还原回去必须逐字等于原文 ──');
  const pairs = [
    ['空 → 有内容', '', 'x\ny'],
    ['有内容 → 空', 'x\ny', ''],
    ['改中间一行', 'a\nb\nc', 'a\nB\nc'],
    ['开头插入', 'a\nb', 'z\na\nb'],
    ['结尾追加', 'a\nb', 'a\nb\nc'],
    ['删中间', 'a\nb\nc', 'a\nc'],
    ['整份替换', 'a\nb\nc', 'x\ny\nz'],
    ['重复行', 'a\na\na', 'a\na'],
    ['中文与符号', '第一行\n<b>第二行</b>\n"第三行"', '第一行\n<i>改了</i>\n"第三行"'],
    ['都为空', '', ''],
    ['只有换行', '\n\n', '\n'],
  ];
  for (const [name, oldT, newT] of pairs) {
    const rows = mod.diffLines(oldT, newT);
    const back = s => rows.filter(r => r[0] === ' ' || r[0] === s).map(r => r[1]).join('\n');
    judge('还原旧文 ' + name, back('-') === oldT, JSON.stringify(back('-')) + ' ≠ ' + JSON.stringify(oldT));
    judge('还原新文 ' + name, back('+') === newT, JSON.stringify(back('+')) + ' ≠ ' + JSON.stringify(newT));
  }

  // 判据 3：渲染出的 HTML 不得漏出标签（内容来自磁盘上的源码，里面什么都可能有）
  console.log('── 判据 3：渲染不得漏出标签 ──');
  {
    const rows = mod.diffLines('<script>alert(1)</script>\n"x"', '<img src=x onerror=alert(1)>\n&lt;y&gt;');
    const html = mod.diffHtml(rows);
    const stray = (html.replace(/<\/?(?:div|span)(?:\s[^>]*)?>/g, '').match(/<[^>]*>/g) || []);
    judge('没有多余标签', stray.length === 0, JSON.stringify(stray));
  }

  // 判据 4：改动行必须真的被标出来（防止判据 1-3 在「什么都不做」时空过）
  console.log('── 判据 4：改动必须真的被标出（防空过）──');
  {
    const rows = mod.diffLines('a\nb\nc', 'a\nB\nc');
    judge('有一行删除', rows.filter(r => r[0] === '-').length === 1, JSON.stringify(rows));
    judge('有一行新增', rows.filter(r => r[0] === '+').length === 1, JSON.stringify(rows));
    const html = mod.diffHtml(rows);
    // 第七十八轮起颜色在样式表（.zq-diff-row[data-op="del"] 是 --zq-bad、[data-op="add"] 是 --zq-q2，CodeDiffJudgmentTest 认那两条规则）；这里认行上的标记
    const ops = (html.match(/class="zq-diff-row" data-op="(add|del|same)"/g) || []).map((t) => t.slice(t.lastIndexOf('=') + 2, -1));
    judge('删除的那一行标成 del', ops.filter((o) => o === 'del').length === 1, JSON.stringify(ops));
    judge('新增的那一行标成 add', ops.filter((o) => o === 'add').length === 1, JSON.stringify(ops));
    judge('没改的两行标成 same', ops.filter((o) => o === 'same').length === 2, JSON.stringify(ops));
  }

  // 判据 5：大文件不做 O(n·m)，而且要明说没比对
  console.log('── 判据 5：超预算时退回并说明 ──');
  {
    const big = Array.from({ length: 2100 }, (_, i) => 'line ' + i).join('\n');
    const t0 = Date.now();
    const rows = mod.diffLines(big, big + '\nmore');
    const ms = Date.now() - t0;
    judge('超预算返回 null', rows === null, String(rows && rows.length));
    judge('没有把浏览器卡住（<500ms）', ms < 500, ms + 'ms');
    judge('退回视图明说没比对', mod.diffHtml(null).includes('没有逐行比对'));
  }

  // 判据 6：未改动的大段要折叠，否则几行改动会淹没在几百行里
  console.log('── 判据 6：未改动的大段要折叠 ──');
  {
    const a = Array.from({ length: 200 }, (_, i) => 'L' + i).join('\n');
    const b = a.replace('L100', 'CHANGED');
    const html = mod.diffHtml(mod.diffLines(a, b));
    judge('出现了省略提示', html.includes('省略'), html.slice(0, 120));
    // 数的是画出来的行（第七十八轮之前数的是内联的 <div style="display:flex —— 挪进样式表之后那样数恒为 0，这条会白绿）
    const shown = (html.match(/class="zq-diff-row"/g) || []).length;
    judge('只画了改动附近的几行（不是 0、也不是 200）', shown > 0 && shown < 30, String(shown));
  }

  console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('加载失败：' + e.stack); process.exit(1); });
