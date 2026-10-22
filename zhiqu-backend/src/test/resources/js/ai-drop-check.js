// 拖文件进 AI 助手的对话栏（第四十四轮）—— 从发布的 assets/pages/ai-assistant.js 里抠出 bindAiDropZone 真跑（假的最小 DOM）。
//
//   用法：node src/test/resources/js/ai-drop-check.js <ai-assistant.js 的路径>
//   原来输入框上面一直摆着一条虚线拖拽框；现在平时不出现，文件拖到对话这一栏上方时整栏盖一层「松开即可上传」（#zq-chat-col.is-dragging）。
//   拖着走的时候每进出栏里的一个子元素，dragenter / dragleave 都各来一次 —— 只看最后一个事件，那一层会一闪一闪；
//   拖的不是文件（页面里的一段字）不该管；不拦 dragover 浏览器就不让放（松手会直接打开那个文件）；拖出窗口时有的浏览器不给 dragleave。
//   由 AiComposerTest 调用；打印 ALL-GREEN 且退出码 0 = 全绿。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('function bindAiDropZone() {');
const b = src.indexOf('\nfunction clearPendingSources', a);
if (a < 0 || b < 0) throw new Error('抠不到 bindAiDropZone');
const body = src.slice(a, b);

function el(id) {
  const classes = new Set();
  const handlers = {};
  return {
    id, classes,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    addEventListener: (t, f) => { (handlers[t] = handlers[t] || []).push(f); },
    fire(t, ev) { (handlers[t] || []).forEach((f) => f(ev)); },
    has: (t) => !!(handlers[t] && handlers[t].length),
  };
}
function dragEvent(types, files) {
  return {
    prevented: false, stopped: false,
    dataTransfer: { types, files: files || [] },
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
  };
}

function setup() {
  const col = el('zq-chat-col'), zone = el('zq-drop-zone'), draft = el('zq-draft');
  const uploads = [], timers = [];
  const fakes = {
    $: (sel) => ({ '#zq-chat-col': col, '#zq-drop-zone': zone, '#zq-draft': draft }[sel] || null),
    uploadAiFiles: (files, attach) => uploads.push({ files, attach }),
    chooseAiFiles: () => {},
    setTimeout: (f, ms) => { timers.push({ f, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (id && timers[id - 1]) timers[id - 1].live = false; },
  };
  const bind = new Function('$', 'uploadAiFiles', 'chooseAiFiles', 'setTimeout', 'clearTimeout', body + '\nreturn bindAiDropZone;')(
    fakes.$, fakes.uploadAiFiles, fakes.chooseAiFiles, fakes.setTimeout, fakes.clearTimeout);
  bind();
  return { col, zone, uploads, timers, on: () => col.classList.contains('is-dragging') };
}

let fail = 0;
function judge(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (detail !== undefined ? '  →  ' + JSON.stringify(detail) : '')); fail++; }
}
const FILES = ['Files'];

let t = setup();
judge('拖拽的事件挂在整个对话栏上（不是那条状态上）', t.col.has('dragenter') && t.col.has('dragover') && t.col.has('dragleave') && t.col.has('drop'));
judge('那条状态上不再挂拖拽事件（它平时不出现，挂在它上面就拖不进来）', !t.zone.has('dragenter') && !t.zone.has('drop'));
judge('那条状态点一下照样能选文件', t.zone.has('click') && t.zone.has('keydown'));

t.col.fire('dragenter', dragEvent(FILES));
judge('文件拖进来：整栏盖上一层', t.on());
t.col.fire('dragenter', dragEvent(FILES));   // 进到栏里的一个子元素（输入框）
t.col.fire('dragleave', dragEvent(FILES));   // 离开原来那个子元素
judge('在栏里从一个子元素挪到另一个：不闪（还盖着）', t.on());
t.col.fire('dragleave', dragEvent(FILES));
judge('真的拖出这一栏：收起', !t.on());
t.col.fire('dragleave', dragEvent(FILES));   // 多来一次 dragleave（有的浏览器会）
t.col.fire('dragenter', dragEvent(FILES));
t.col.fire('dragleave', dragEvent(FILES));
judge('多来的 dragleave 不把层数减成负的（不然下一次拖出去收不起来）', !t.on());

const over = dragEvent(FILES);
t.col.fire('dragover', over);
judge('拖着文件经过：拦下 dragover（不拦浏览器就不让放，松手会直接打开那个文件）', over.prevented);
const drop = dragEvent(FILES, [{ name: 'a.pdf' }]);
t.col.fire('drop', drop);
judge('松手：拦下默认动作、收起那一层', drop.prevented && !t.on());
judge('松手：交给上传，附到下一条消息', t.uploads.length === 1 && t.uploads[0].files.length === 1 && t.uploads[0].attach === true, t.uploads);

t = setup();
const text = dragEvent(['text/plain']);
t.col.fire('dragenter', text);
t.col.fire('dragover', text);
judge('拖的是一段字（不是文件）：不盖、不拦', !t.on() && !text.prevented);
t.col.fire('drop', dragEvent(['text/plain']));
judge('拖一段字松手：不上传', t.uploads.length === 0);

t = setup();
t.col.fire('dragenter', dragEvent(FILES));
t.col.fire('dragover', dragEvent(FILES));
const live = t.timers.filter((x) => x.live);
judge('拖出窗口没有 dragleave 时：dragover 停了一会儿也收（留了一个看门的定时器）', live.length === 1 && live[0].ms >= 600, t.timers.map((x) => [x.ms, x.live]));
if (live.length) live[live.length - 1].f();
judge('看门的定时器到点：收起', !t.on());
t.col.fire('dragenter', dragEvent(FILES));
t.col.fire('dragleave', dragEvent(FILES));
judge('定时器收过之后再拖进来、拖出去：照常（层数清零了）', !t.on());

console.log(fail === 0 ? '\nALL-GREEN' : '\nRED: ' + fail + ' 条');
process.exit(fail === 0 ? 0 : 1);
