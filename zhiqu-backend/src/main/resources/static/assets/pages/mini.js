// 迷你番茄钟（第五十轮，docs/mini-pomodoro-plan.md 第 2 步）—— mini.html 的页面模块。形状见 pages/admin.js 的开头。
// 钟在壳里（zhiqu-api.js 的 pomo，第四十九轮）：迷你窗和主窗口是同一份登录、同一份 localStorage，看的是同一个钟 —— 这里只画胶囊、把按钮交给壳。
// 「今天第 N 轮」也是壳填的（updatePomoCount 认 #zq-pomo-round）。第 3 步（第五十一轮）macOS 外壳把这一页装进悬浮面板，「展开」经 zqMini 这座桥
// （壳的 miniBridge）告诉外壳；浏览器里（没有那座桥）直接去看板。
// dayReload：开着跨过业务日期的零点，「今天第 N 轮」从 1 重新数。

let $, pomo, icon, updatePomoCount, miniBridge;
export function bind(sh) {
  ({ $, pomo, icon, updatePomoCount, miniBridge } = sh);
}

export const boots = { 'mini.html': (sh) => { bind(sh); return bootMini(); } };
export const dayReload = { 'mini.html': () => updatePomoCount() };

async function bootMini() {
  wireMini();
  await updatePomoCount();
}

/** 进度环的周长（r = 18） */
var MINI_RING = 2 * Math.PI * 18;
/** 暂停着、刚做完的时候，小字写什么（在跑 / 待开始写关联的任务） */
var MINI_NOTE = { paused: '已暂停', done: '专注结束' };

function wireMini() {
  var go = $('#zq-mini-go'), expand = $('#zq-mini-expand');
  if (!go || go.dataset.wired) return;
  go.dataset.wired = '1';
  go.onclick = function () {
    var v = pomo.view();
    if (v.phase === 'running') { pomo.pause(); return; }
    // 暂停着的接着走；待开始 / 做完了：照上一次的时长和任务再来一个（任务和时长在看板上选）
    pomo.start({ minutes: v.total ? v.total / 60 : 25, taskId: v.taskId, taskTitle: v.taskTitle });
  };
  if (expand) expand.onclick = function () {
    var bridge = miniBridge();
    if (bridge) { try { bridge.postMessage({ action: 'expand' }); return; } catch (e) { /* 桥坏了：照浏览器的办法 */ } }
    location.href = 'dashboard.html';
  };
  pomo.subscribe(drawMini);
}

/** 一秒一次（壳那一跳）：时间、环、小字、按钮（开始 / 暂停 / 继续） */
function drawMini(v) {
  var time = $('#zq-mini-time'), note = $('#zq-mini-note'), go = $('#zq-mini-go'), ring = $('#zq-mini-ring'), box = $('.zq-main');
  if (!time || !go) return;
  var live = v.phase === 'running' || v.phase === 'paused';
  var total = v.total || 25 * 60, left = live ? v.left : total;
  time.textContent = pomo.clock(left);
  if (ring) {
    ring.setAttribute('stroke-dasharray', ((total - left) / total * MINI_RING).toFixed(1) + ' ' + MINI_RING.toFixed(1));
    // 圆头的线长度是 0 时也会画出一个点（环顶上一个白点）：没走的时候整条藏起来
    ring.setAttribute('visibility', left < total ? 'visible' : 'hidden');
  }
  if (note) note.textContent = MINI_NOTE[v.phase] || v.taskTitle || (v.phase === 'running' ? '专注中' : '开始专注');
  if (box) { box.classList.toggle('is-running', v.phase === 'running'); box.classList.toggle('is-paused', v.phase === 'paused'); }
  var label = v.phase === 'running' ? '暂停' : v.phase === 'paused' ? '继续' : '开始专注';
  // 只在变了的时候换：一秒一次地重写 title，停在按钮上的提示会一直被重新挂
  if (go.getAttribute('aria-label') !== label) {
    go.setAttribute('aria-label', label);
    go.title = label;
    var ic = go.querySelector('.zq-ic');
    if (ic) ic.innerHTML = icon(v.phase === 'running' ? 'pause' : 'play');
  }
}
