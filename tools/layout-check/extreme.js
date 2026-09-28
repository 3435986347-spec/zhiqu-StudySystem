// 第二十轮的极端内容：一处定义，种子脚本和假模型共用。
const combining = n => Array.from({ length: n }, (_, i) => String.fromCharCode(0x0300 + (i * 7) % 0x70)).join('');
const zalgo = s => [...s].map(c => c + combining(24)).join('');

const LONG_URL = 'https://example.com/very/long/path/' + 'abcdefghij'.repeat(26) + '?q=' + 'x'.repeat(20);
const LONG_WORD = 'Pneumonoultramicroscopicsilicovolcanoconiosis'.repeat(5);
const EMOJI = '🎯📚✅🔥💡🧠⏰🏆'.repeat(12);
const RTL = 'مراجعة التفاضل والتكامل 复习微积分 الفصل الثالث עברית טקסט ארוך';
const ZALGO = zalgo('Zalgo 复习 text');
const CJK_RUN = '高等数学期末复习计划第一章函数与极限第二章导数与微分第三章微分中值定理与导数的应用第四章不定积分'.repeat(2);

function table(cols, rows) {
  const head = '| ' + Array.from({ length: cols }, (_, i) => '列' + (i + 1) + '标题').join(' | ') + ' |';
  const sep = '|' + ' --- |'.repeat(cols);
  const body = Array.from({ length: rows }, (_, r) => '| ' + Array.from({ length: cols }, (_, i) => `r${r}c${i}数据`).join(' | ') + ' |');
  return [head, sep, ...body].join('\n');
}

const MARKDOWN = [
  '# ' + LONG_WORD,
  '',
  '一个没有空格的网址：' + LONG_URL,
  '',
  '[' + LONG_URL + '](' + LONG_URL + ')',
  '',
  EMOJI,
  '',
  RTL,
  '',
  ZALGO,
  '',
  table(40, 3),
  '',
  '```js',
  'const reallyLongLine = "' + 'x'.repeat(400) + '"; // ' + LONG_URL,
  '```',
  '',
  '行内代码 `' + LONG_WORD + '` 结束',
  '',
  '> ' + LONG_URL,
  '',
  '- ' + LONG_WORD,
  '- ' + CJK_RUN,
  '',
  '$$' + 'x^2+'.repeat(80) + '1$$',
].join('\n');

module.exports = { LONG_URL, LONG_WORD, EMOJI, RTL, ZALGO, CJK_RUN, MARKDOWN, table, zalgo };
