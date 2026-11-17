// 第一百四十七轮（docs/app-resume-plan.md 第 3 步）：没有文件夹的应用对话（普通聊天、生成到产物、服务器上的代码模式）
// 在命令行里 /resume —— 列在第二段（只有文字），挑一段就在这个文件夹里开一份同 id 的会话记录，之后的每一轮存档回原来那个对话。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { archiveTurn, runTurn } from '../src/agent.js';
import { slash } from '../src/cli.js';
import { openAppSession, recordAppFolder } from '../src/handoff.js';
import { SessionStore } from '../src/session.js';
import { LocalTools } from '../src/tools/local.js';
import { fakeApi, fakeUi, tmpdir } from './helpers.js';

const CONVERSATIONS = [
  { id: 12, sessionId: 'app-12', title: '应用里的对话 A', fromCli: false, updatedAt: '2026-11-17T10:00:00' },
  { id: 'default', sessionId: 'app-default', title: '默认对话', fromCli: false },
];
const HANDOFF = {
  12: { sessionId: 'app-12', summary: 'SUMMARY-OF-EARLIER-TALK', messages: [
    { id: 101, role: 'user', content: '聊天里问的 KAPPA' }, { id: 102, role: 'assistant', content: '聊天里答的 KAPPA' }] },
  default: { sessionId: 'app-default', summary: null, messages: [{ id: 5, role: 'user', content: '默认对话里的 LAMBDA' }, { id: 6, role: 'assistant', content: '答 LAMBDA' }] },
};

function makeCtx(root, { answers = [], replies = [{ text: '好' }], conversations = CONVERSATIONS, getFails = false } = {}) {
  const store = new SessionStore(root);
  const api = fakeApi(replies);
  api.gets = [];
  api.get = async (p) => {
    api.gets.push(p);
    if (getFails) throw new Error('断网了');
    if (p === '/api/harness/conversations') return conversations;
    const m = /^\/api\/harness\/conversations\/([^/]+)\/messages$/.exec(p);
    if (m && HANDOFF[decodeURIComponent(m[1])]) return HANDOFF[decodeURIComponent(m[1])];
    throw new Error(`没有 ${p}`);
  };
  return {
    ui: fakeUi(answers), api, root, mode: 'auto', maxRounds: 10,
    local: new LocalTools({ root }), store, session: store.create(), messages: [],
    allow: { write: false, run: false, mcp: new Set() }, usage: { prompt: 0, completion: 0 }, changedFiles: new Set(),
    system: { text: '系统内容' }, instructionsText: '', skillsText: '', skills: [], remoteTools: [], todos: [],
    model: { id: 1, label: '假模型', effectiveContextWindow: 64_000 },
  };
}

/** 另起一个用户级目录（~/.zhiqu）：app-sessions.json 在那里 */
function userHome(t) {
  const dir = tmpdir();
  const old = process.env.ZHIQU_HOME;
  process.env.ZHIQU_HOME = dir;
  t.after(() => { if (old == null) delete process.env.ZHIQU_HOME; else process.env.ZHIQU_HOME = old; });
  return dir;
}

test('/resume：这个文件夹里的会话在前，应用里的对话在后（写明只有文字）；这里已经有记录的不再列第二遍', async (t) => {
  userHome(t);
  const root = tmpdir();
  const earlier = makeCtx(root);
  await runTurn(earlier, '本地的那一段');
  const local = new SessionStore(root).adopt('app-13');   // 应用的本机代码助手在这个文件夹里写过的
  assert.ok(local);
  const ctx = makeCtx(root, { answers: [''], conversations: [...CONVERSATIONS, { id: 13, sessionId: 'app-13', title: '这里已经有的 MU' }] });
  await slash(ctx, '/resume');
  const out = ctx.ui.text();
  const at = (s) => out.indexOf(s);
  assert.ok(at('本地的那一段') >= 0, out);
  assert.ok(at('应用里的对话') > at('本地的那一段'), `应用的对话没排在本地的后面：\n${out}`);
  assert.match(out, /只有文字/);
  assert.match(out, / 3\. 应用里的对话 A/, `编号没接着本地的往下排：\n${out}`);
  assert.match(out, / 4\. 默认对话/);
  assert.ok(!out.includes('这里已经有的 MU'), '这个文件夹里已经有记录的又在第二段列了一遍');
});

test('/resume 挑一段应用的对话：这里开一份同 id 的记录（摘要 + 问答，只有文字），模型看得到；之后存档回原来那个对话；对过账', async (t) => {
  userHome(t);
  const root = tmpdir();
  const ctx = makeCtx(root, { answers: ['1'], replies: [{ text: '接着答' }] });
  await slash(ctx, '/resume');
  assert.equal(ctx.session.id, 'app-12', '没换到那段对话上');
  assert.match(ctx.ui.text(), /从应用接过来「应用里的对话 A」：前面 1 句问答和一段摘要，只有文字/);
  const row = ctx.store.list().find((s) => s.id === 'app-12');
  assert.equal(row.title, '应用里的对话 A');
  assert.equal(row.via, 'app');

  await runTurn(ctx, '命令行接着问');
  const sent = JSON.stringify(ctx.api.requests.at(-1).messages);
  for (const s of ['SUMMARY-OF-EARLIER-TALK', '聊天里问的 KAPPA', '聊天里答的 KAPPA', '命令行接着问']) assert.ok(sent.includes(s), `发给模型的里没有「${s}」：${sent.slice(0, 600)}`);
  assert.equal(sent.split('聊天里答的 KAPPA').length - 1, 1);

  ctx.local.root = root;
  await archiveTurn(ctx, '命令行接着问', { finalText: '接着答' });
  assert.deepEqual(ctx.api.posts.map((p) => p.pathname), ['/api/harness/sessions/app-12/messages'], '存档没回原来那个对话');

  // 之后桌面应用在这个文件夹里接着这段对话：对过账的不再补一遍
  const again = openAppSession(root, 'app-12', [{ role: 'user', content: '【前情摘要】\nSUMMARY-OF-EARLIER-TALK' }, ...HANDOFF[12].messages,
    { id: 103, role: 'user', content: '命令行接着问' }, { id: 104, role: 'assistant', content: '接着答' }]);
  const all = JSON.stringify(again.messages);
  assert.equal(all.split('聊天里答的 KAPPA').length - 1, 1, '桌面应用接着时把接过来的那几轮又补了一遍');
  assert.equal(all.split('SUMMARY-OF-EARLIER-TALK').length - 1, 1, '摘要又补了一遍');
});

test('/resume <编号> / <会话 id> 直接接；默认对话也接得上', async (t) => {
  userHome(t);
  const root = tmpdir();
  const ctx = makeCtx(root);
  await slash(ctx, '/resume 2');
  assert.equal(ctx.session.id, 'app-default');
  assert.ok(JSON.stringify(ctx.store.load('app-default').messages).includes('默认对话里的 LAMBDA'));
  const other = makeCtx(tmpdir());
  await slash(other, '/resume app-12');
  assert.equal(other.session.id, 'app-12');
  // 本地有会话时，编号先数本地的、再接着数应用的
  const busy = tmpdir();
  await runTurn(makeCtx(busy), '本地的 XI');
  const third = makeCtx(busy);
  await slash(third, '/resume 3');
  assert.equal(third.session.id, 'app-default', '本地有会话时按编号挑应用的对话错了位');
  const none = makeCtx(tmpdir());
  await slash(none, '/resume 9');
  assert.match(none.ui.text(), /没有 9 这段会话/);
});

test('这段对话在别的文件夹里有完整记录：先指路；不要就不接，要的话接文字版', async (t) => {
  const home = userHome(t);
  const there = tmpdir();
  new SessionStore(there).adopt('app-12');
  new SessionStore(there).append('app-12', { type: 'message', message: { role: 'user', content: 'x' } });
  recordAppFolder(path.join(home, 'app-sessions.json'), 'app-12', there);
  const root = tmpdir();
  const no = makeCtx(root, { answers: ['1', 'n'] });
  await slash(no, '/resume');
  assert.match(no.ui.text(), /里有完整的记录（带工具调用）：cd 过去再 \/resume/);
  assert.notEqual(no.session.id, 'app-12', '说了不要还是接了');
  assert.equal(fs.existsSync(path.join(root, '.zhiqu', 'sessions', 'app-12.jsonl')), false);
  const yes = makeCtx(tmpdir(), { answers: ['1', 'y'] });
  await slash(yes, '/resume');
  assert.equal(yes.session.id, 'app-12', '说了要却没接');
  // 对照：记着的那个文件夹里记录已经没了 —— 不指路，直接接
  fs.rmSync(path.join(there, '.zhiqu'), { recursive: true });
  const gone = makeCtx(tmpdir(), { answers: ['1'] });
  await slash(gone, '/resume');
  assert.ok(!gone.ui.text().includes('cd 过去'), '记录已经不在了还指路');
  assert.equal(gone.session.id, 'app-12');
});

test('取不到应用的对话（断网 / 直连没有服务器）：本地那一段照样列、照样能接', async (t) => {
  userHome(t);
  const root = tmpdir();
  const earlier = makeCtx(root);
  await runTurn(earlier, '本地的 NU');
  const ctx = makeCtx(root, { answers: ['1'], getFails: true });
  await slash(ctx, '/resume');
  assert.match(ctx.ui.text(), /本地的 NU/);
  assert.ok(!ctx.ui.text().includes('应用里的对话'));
  assert.equal(ctx.session.id, earlier.session.id);
  const direct = makeCtx(tmpdir());
  direct.api = null;
  await slash(direct, '/resume');
  assert.match(direct.ui.text(), /这个工作区没有别的会话，应用里也没有可以接的对话/);
});

test('服务器给的会话 id 不合规：不列（id 要拼进文件名）', async (t) => {
  userHome(t);
  const ctx = makeCtx(tmpdir(), { answers: [''], conversations: [{ id: 1, sessionId: '../../evil', title: 'EVIL' }, ...CONVERSATIONS] });
  await slash(ctx, '/resume');
  assert.ok(!ctx.ui.text().includes('EVIL'));
  assert.match(ctx.ui.text(), / 1\. 应用里的对话 A/);
});
