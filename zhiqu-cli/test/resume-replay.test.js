// /resume 之后把那段会话之前的聊天记录显示出来：原话（压缩过也照样显示原话）、每一步当时怎么显示就怎么显示、
// 不是用户打的消息（goal 推的下一轮、命令行补的说明）不冒充「› …」。
// 会话用真的 runTurn + 假模型产生 —— 判的是循环实际写下来的格式，不是手写的一份样本。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from '../src/agent.js';
import { resumeInto } from '../src/cli.js';
import { replayTranscript } from '../src/replay.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

function makeCtx(root, replies) {
  const store = new SessionStore(root);
  return {
    ui: fakeUi(), api: fakeApi(replies), root, mode: 'auto', maxRounds: 10,
    local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 64_000 },
  };
}

async function recordedSession() {
  const root = tmpdir();
  const ctx = makeCtx(root, [
    { calls: [{ name: 'write_file', args: { path: 'mario.html', content: '<html></html>\n' } }] },
    { text: '做好了，**mario.html** 打开就能玩。' },
    { text: '好，改成 P 暂停。' },
  ]);
  await runTurn(ctx, '帮我做一个超级马里奥的游戏');
  await runTurn(ctx, '（第二轮）空格别暂停');
  return { root, ctx };
}

test('/resume：之前说过的话、做过的每一步、结果、回答按原来的顺序显示出来', async () => {
  const { root, ctx } = await recordedSession();
  const later = makeCtx(root, [{ text: '好' }]);
  const before = later.ui.text().length;
  resumeInto(later, ctx.session.id);
  const shown = later.ui.text().slice(before);

  const order = ['── 之前的记录 ──', '› 帮我做一个超级马里奥的游戏', '⏺ 写入 mario.html', '⎿ 已新建 mario.html',
    '做好了，mario.html 打开就能玩。', '› （第二轮）空格别暂停', '好，改成 P 暂停。', '── 以上是之前的记录 ──', '接着「'];
  let at = -1;
  for (const piece of order) {
    const i = shown.indexOf(piece, at + 1);
    assert.ok(i > at, `「${piece}」没按顺序出现：\n${shown}`);
    at = i;
  }
  assert.equal(later.messages.length, ctx.messages.length, '模型那边的上下文也要接上');
});

test('压缩过：模型那边只剩摘要，屏幕上照样显示原话，并标出压缩的位置', async () => {
  const { root, ctx } = await recordedSession();
  ctx.store.append(ctx.session.id, { type: 'compact', messages: [{ role: 'user', content: '【之前对话的摘要】做了马里奥' }] });
  ctx.store.append(ctx.session.id, { type: 'message', message: { role: 'user', content: '压缩之后又说了一句' } });

  const loaded = ctx.store.load(ctx.session.id);
  assert.ok(!loaded.messages.some((m) => m.content === '帮我做一个超级马里奥的游戏'), '模型那边应当只有摘要');

  const ui = fakeUi();
  replayTranscript(ui, ctx.store.transcript(ctx.session.id));
  const shown = ui.text();
  assert.ok(shown.includes('› 帮我做一个超级马里奥的游戏'), '压缩前的原话没显示');
  assert.ok(shown.indexOf('压缩过一次') > shown.indexOf('好，改成 P 暂停。'));
  assert.ok(shown.indexOf('› 压缩之后又说了一句') > shown.indexOf('压缩过一次'));
  assert.ok(!shown.includes('【之前对话的摘要】'), '摘要是给模型的，不当成聊天记录显示');
});

test('不是用户打的消息不冒充「› …」：goal 推的一轮显示成 🎯，命令行补的说明不显示（旧记录没有标记也认得出）', async () => {
  const root = tmpdir();
  const ctx = makeCtx(root, [{ text: '在做' }, { text: '接着说' }]);
  // 标记那一路要单独见红：这句话故意不长得像旧格式，只有 origin 标记认得出它
  await runTurn(ctx, '把贪吃蛇的计分板也做完', { origin: 'goal' });
  ctx.store.append(ctx.session.id, { type: 'message', message: { role: 'user', content: '（你的回答被输出上限截断了，请从断开的地方接着说，不要重复前面的内容）' }, origin: 'system' });
  ctx.store.append(ctx.session.id, { type: 'message', message: { role: 'user', content: '继续朝目标推进：做个贪吃蛇' } });   // 旧格式：没有 origin

  const ui = fakeUi();
  const users = replayTranscript(ui, ctx.store.transcript(ctx.session.id));
  const shown = ui.text();
  assert.equal(users, 0, `这些都不是用户打的：\n${shown}`);
  assert.ok(!/› (目标|继续朝目标|（你的回答)/.test(shown), shown);
  assert.equal((shown.match(/🎯/g) || []).length, 2);
  assert.ok(!shown.includes('输出上限截断'));
});

test('还没聊过的会话：说一句「还没有聊天记录」，不画空框', () => {
  const store = new SessionStore(tmpdir());
  const s = store.create();
  const ui = fakeUi();
  assert.equal(replayTranscript(ui, store.transcript(s.id)), 0);
  assert.match(ui.text(), /还没有聊天记录/);
  assert.ok(!ui.text().includes('── 之前的记录 ──'));
});

test('/resume：任务清单和用户最后一次的原话也接回来（压缩过、原话不在 messages 里了也一样）', async () => {
  const root = tmpdir();
  const ctx = makeCtx(root, [
    { calls: [{ name: 'update_todos', args: { todos: [{ content: '改接口', status: 'completed' }, { content: '改前端', status: 'pending' }] } }] },
    { text: '接口改好了，前端要等设计稿？' },
  ]);
  await runTurn(ctx, '把用户名改成昵称，但数据库字段别动');
  ctx.store.append(ctx.session.id, { type: 'compact', messages: [{ role: 'user', content: '【之前对话的摘要】改名' }] });
  const later = makeCtx(root, [{ text: '好' }]);
  resumeInto(later, ctx.session.id);
  assert.deepEqual(later.todos.map((t) => t.content), ['改接口', '改前端']);
  assert.match(later.ui.text(), /任务清单还有 1 项没做完：改前端/);
  assert.equal(later.request.text, '把用户名改成昵称，但数据库字段别动');
});
