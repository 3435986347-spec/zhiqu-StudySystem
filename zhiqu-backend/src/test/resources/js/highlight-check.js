// 代码块着色器的行为判据 —— 直接跑 assets/zhiqu-api.js 里发布的那份实现，
// 不在 Java 侧重写一遍（重写一遍就成了「测试一个副本」，那是最没用的一种绿）。
//
//   用法：node src/test/resources/js/highlight-check.js <zhiqu-api.js 的路径>
//   退出码 0 = 全绿；非 0 = 有判据红了，逐条打印在上面。
//
// 由 CodeHighlightEscapeTest 调用。手动跑也行。
//
// 四条判据各自都被扰动打红过（2026-09-21）：
//   判据 1 ← 把 esc(t[1]) 改成 t[1]（完全不转义）
//   判据 2 ← 数字分支 i = k 改成 i = k + 1（吞字符）；esc 套两层（重复转义）
//   判据 3 ← 去掉 hashIsComment 语言门（this.#x 被涂成注释）
//   判据 4 ← 把 color 恒置为 null（什么都不着色）
//
// 顺便记一个被扰动推翻的想法：原本以为「先整段 esc、再分词」会漏出标签，
// 实测不会 —— 分词器只切分、从不反转义，所以输出仍然是转义过的，
// 症状只是字符串不再被识别（判据 4 红）。别把那个顺序当成安全边界。

// 把 zhiqu-api.js 里的 esc + 着色器抠出来单独跑，喂对抗性输入。
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
const hlSrc  = slice('var CODE_KEYWORDS =', '  function renderMarkdown(');
// 扰动落地核对：抠出来的片段必须真的含着色器
if (!/function highlightCode/.test(hlSrc)) throw new Error('抠出来的片段里没有 highlightCode');

const mod = new Function(escSrc + '\n' + hlSrc + '\nreturn { highlightCode, tokenizeCode, esc };')();

let fail = 0;
function judge(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); }
  else { console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : '')); fail++; }
}

// 判据 1：任何输入产出的 HTML 里，除了我们自己加的 <span style="color:…"> 与 </span>，
// 不得出现任何其他标签。这是「转义顺序写反」唯一会表现出来的症状。
function strayTags(html) {
  return html
    .replace(/<span style="color:[a-z0-9(),\- ]+;">/g, '')
    .replace(/<\/span>/g, '')
    .match(/<[^>]*>/g) || [];
}

const payloads = [
  ['裸标签',            '<script>alert(1)</script>'],
  ['注释里藏标签',      '// <img src=x onerror=alert(1)>'],
  ['字符串里藏标签',    'var a = "<svg onload=alert(1)>";'],
  ['已转义实体再喂一次','&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['实体被切碎的构造',  '&lt' + ';script&gt;'],
  ['属性闭合逃逸',      '"><script>alert(1)</script>'],
  ['块注释未闭合',      '/* <b>never closed'],
  ['反引号模板',        '`<b>${x}</b>`'],
  ['数字紧跟标签',      '123<b>456'],
  ['关键字紧跟标签',    'return<b>1'],
];
console.log('── 判据 1：任何输入都不得漏出标签 ──');
for (const [name, p] of payloads) {
  const out = mod.highlightCode(p, 'java');
  const stray = strayTags(out);
  judge(name, stray.length === 0, JSON.stringify(stray));
}

// 判据 2：去掉所有着色 span 后，必须与「直接 esc 整段」逐字相同。
// 这一条最硬 —— 它同时证明了「没多转义」「没少转义」「没吞字符」。
console.log('── 判据 2：剥掉着色后必须与直接转义逐字相同 ──');
const samples = [
  'public class A { /* x */ int n = 0xFF; String s = "a<b>c"; } // end',
  '# python comment <b>\nprint("hi")',
  'const x = `a<b>${y}`; // note',
  '&<>"\'',
  '',
  'this.#x = 1; // JS 私有字段不是注释',
];
for (const s of samples) {
  for (const lang of ['java', 'python', '']) {
    const stripped = mod.highlightCode(s, lang)
      .replace(/<span style="color:[^"]*">/g, '').replace(/<\/span>/g, '');
    judge('逐字一致 lang=' + (lang || '无') + ' ' + JSON.stringify(s.slice(0, 28)),
      stripped === mod.esc(s), '得到 ' + JSON.stringify(stripped.slice(0, 80)));
  }
}

// 判据 3：# 只在 python 一类语言里是注释（否则 this.#x 整行被涂成注释色）
console.log('── 判据 3：# 的注释判定必须分语言 ──');
const jsTok = mod.tokenizeCode('this.#x = 1', 'javascript');
const pyTok = mod.tokenizeCode('a = 1 # note', 'python');
judge('JS 里 # 不是注释', !jsTok.some(t => t[0] === 'c'), JSON.stringify(jsTok));
judge('Python 里 # 是注释', pyTok.some(t => t[0] === 'c'), JSON.stringify(pyTok));

// 判据 4：着色真的发生了（否则以上全部会因为「什么都没做」而空过）
console.log('── 判据 4：着色必须真的发生（防空过）──');
const rich = mod.highlightCode('public int n = 0; // c\nString s = "x";', 'java');
for (const kind of ['c', 's', 'k', 'n']) {
  const color = { c: '--zq-text3', s: '--zq-q4', k: '--zq-q2', n: '--zq-q3' }[kind];
  judge('出现了 ' + kind + ' 类着色', rich.includes(color), '没找到 ' + color);
}

console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
