// 直接执行发布模块的发送、SSE 回调、reload 与确认弹窗；只替换网络和最小 DOM。
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8')
  .replace(/^export (function|const) /gm, '$1 ')
  .replace(/^export \{[^\n]+\};/gm, '');
let failures = 0;
const check = (name, test) => { try { test(); console.log('PASS ' + name); } catch (error) {
  failures++; console.log('FAIL ' + name + ': ' + error.message);
} };

function environment(events, detail = []) {
  const requests = [], modals = [], writes = [];
  const state = { messages: [], pendingSources: [], notebookId: 4, reasoningExpanded: {} };
  const input = { value: '帮我制定下周的工作计划', style: {} };
  const artifacts = { innerHTML: '' };
  const buttons = {};
  let resolveRuns;
  let delayed = false;
  const esc = text => String(text == null ? '' : text).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
  const get = async path => {
    requests.push(path);
    if (path.startsWith('/ai/messages')) return state.messages;
    if (path.startsWith('/ai/agent-runs?')) {
      if (delayed) return new Promise(resolve => { resolveRuns = resolve; });
      return [{ id: 7, notebookId: 4 }];
    }
    if (path === '/ai/agent-runs/7') return { artifacts: detail, steps: [] };
    throw new Error('Unexpected GET: ' + path);
  };
  const shared = {
    state, api: { get, post: async (path, body) => { writes.push({ path, body }); return {}; } },
    $: (selector, scope) => {
      if (scope && scope.kind === 'modal') return buttons[selector] ||= {};
      if (selector === '#zq-draft') return input;
      if (selector === '#zq-artifacts') return artifacts;
      return null;
    }, $all: () => [], esc, empty: () => '', safe: async (name, action) => action(), toast: () => {},
    nowMs: () => Date.now(), serverTime: Date.parse, renderMarkdown: esc, freqLabel: () => '每天',
    openModal: config => {
      const root = { kind: 'modal', innerHTML: '' };
      const entry = { config, root, closed: false };
      const handle = { body: { querySelector: () => root }, close: () => {
        if (entry.closed) return;
        entry.closed = true;
        if (config.onClose) config.onClose();
      } };
      entry.handle = handle;
      modals.push(entry); return handle;
    }
  };
  // 流传输是外部边界，其余发送/回调/合并/弹窗代码照着发布实现执行。
  const module = new Function('emitEvents', source + '\n'
    + 'streamAiChat = async function (body, callback) { await emitEvents(callback); };\n'
    + 'return { bind, sendAiMessage, renderAgentPanels, messageBodyHtml, '
    + 'setAiNotebookId: typeof setAiNotebookId === "function" ? setAiNotebookId : null };')(async callback => events(callback, context));
  module.bind(shared);
  const context = { module, state, requests, modals, writes, artifacts, buttons, input, detail,
    delayReload: () => { delayed = true; },
    finishReload: () => { assert.ok(resolveRuns, 'reload must actually be waiting'); delayed = false;
      resolveRuns([{ id: 7, notebookId: 4 }]); }
  };
  return context;
}

function plan(id, content = true, status = 'DRAFT') {
  const result = { id, artifactType: 'PLAN_DRAFT', title: 'AI 计划草稿', status,
    itemTitles: ['准备汇报'], itemCount: 1 };
  if (content) result.content = { tasks: [{ title: '准备汇报', durationMinutes: 45, suggestedQuadrant: 2,
    deadline: '2026-10-15 18:00:00' }], routines: [] };
  return result;
}
const done = { status: 'DONE', assistantMessageId: 9, userMessageId: 8 };

(async () => {
  const first = environment(async (emit, env) => {
    emit('message.delta', { text: '建议周一准备汇报。', userMessageId: 8 });
    emit('message.processing', { stage: 'PLAN_DRAFT', message: '正在整理可确认的计划草稿…' });
    check('正文结束后显示实际计划整理状态', () => {
      assert.match(env.module.messageBodyHtml(env.state.messages[1], 1), /正在整理可确认的计划草稿/);
      assert.doesNotMatch(env.module.messageBodyHtml(env.state.messages[1], 1), /仍在生成/);
    });
    emit('artifact.created', plan(17, false));
    check('只有标题摘要不弹空草稿', () => assert.equal(env.modals.length, 0));
    emit('artifact.created', { artifact: plan(17) });
    check('完整SSE草稿在done和GET之前就可确认', () => {
      assert.equal(env.modals.length, 1);
      assert.equal(env.requests.length, 0);
      assert.match(env.modals[0].root.innerHTML, /准备汇报/);
      assert.match(env.modals[0].root.innerHTML, /确认后才会写入你的日历/);
      assert.doesNotMatch(env.module.messageBodyHtml(env.state.messages[1], 1), /正在整理/);
    });
    emit('artifact.created', plan(17, false));
    emit('message.processing', { stage: 'PLAN_DRAFT', message: '正在整理可确认的计划草稿…' });
    check('重复摘要保留完整内容且晚到processing不回退', () => {
      assert.equal(env.modals.length, 1);
      assert.equal(env.state.agentArtifacts[0].content?.tasks?.[0]?.durationMinutes, 45);
      assert.doesNotMatch(env.module.messageBodyHtml(env.state.messages[1], 1), /正在整理/);
    });
    emit('done', done);
  }, [plan(17, false)]);
  await first.module.sendAiMessage();
  check('终态reload不会重复弹出同一草稿', () => assert.equal(first.modals.length, 1));
  check('reload摘要不能丢掉SSE完整字段', () => assert.equal(first.state.agentArtifacts[0].content?.tasks?.[0]?.durationMinutes, 45));
  check('SSE和reload都不会自动写入日历', () => assert.equal(first.writes.length, 0));
  const confirm = first.buttons['[data-plan="ok"]'];
  if (confirm) await confirm.onclick();
  check('用户确认才调用confirm并保留完整字段', () => {
    assert.equal(first.writes.length, 1);
    assert.equal(first.writes[0].path, '/ai/artifacts/17/confirm');
    assert.equal(first.writes[0].body.tasks[0].durationMinutes, 45);
    assert.equal(first.writes[0].body.tasks[0].suggestedQuadrant, 2);
  });

  const oldPlan = plan(99);
  oldPlan.content.tasks[0].title = '过期草稿';
  const stale = environment(async (emit, env) => {
    env.delayReload();
    const loading = env.module.renderAgentPanels();
    await Promise.resolve(); await Promise.resolve();
    emit('artifact.created', plan(18));
    env.finishReload(); await loading;
    check('慢reload不能盖掉抢先到达的SSE草稿', () => {
      assert.equal(env.modals.length, 1);
      assert.equal(env.state.agentArtifacts[0].id, 18);
      assert.match(env.modals[0].root.innerHTML, /准备汇报/);
      assert.doesNotMatch(env.modals[0].root.innerHTML, /过期草稿/);
    });
    emit('done', done);
  }, [oldPlan]);
  await stale.module.sendAiMessage();

  const reverse = environment(async (emit, env) => {
    emit('done', done);
    emit('artifact.created', plan(19));
    emit('artifact.created', plan(19));
    check('done与artifact到达顺序变化仍只弹一次', () => assert.equal(env.modals.length, 1));
    emit('artifact.created', plan(19, true, 'CONFIRMED'));
    emit('artifact.created', plan(19, false, 'DRAFT'));
    check('已确认状态不被晚到DRAFT倒退', () => assert.equal(env.state.agentArtifacts[0].status, 'CONFIRMED'));
  }, [plan(19, true, 'CONFIRMED')]);
  await reverse.module.sendAiMessage();

  const switched = environment(async (emit, env) => {
    env.state.notebookId = 5;
    emit('artifact.created', plan(20)); emit('done', done);
    check('切Notebook后旧事件不弹草稿', () => assert.equal(env.modals.length, 0));
  });
  await switched.module.sendAiMessage();

  const task = { ...plan(21), artifactType: 'TASK_DRAFT' };
  const routine = { ...plan(22), artifactType: 'ROUTINE_DRAFT', content: {
    tasks: [], routines: [{ title: '每天练习', frequency: 'DAILY', durationMinutes: 30 }]
  } };
  const queued = environment(async (emit, env) => {
    emit('artifact.created', task);
    emit('artifact.created', routine);
    emit('artifact.created', routine);
    check('真实任务和例行草稿连续到达时仅有一个弹窗', () => {
      assert.equal(env.modals.length, 1);
      assert.match(env.modals[0].root.innerHTML, /准备汇报/);
    });
    env.modals[0].handle.close();
    check('用户关闭任务草稿后才展示例行草稿', () => {
      assert.equal(env.modals.length, 2);
      assert.equal(env.modals.filter(dialog => !dialog.closed).length, 1);
      assert.match(env.modals[1].root.innerHTML, /每天练习/);
      assert.equal(env.writes.length, 0);
    });
    emit('done', done);
  }, [task, routine]);
  await queued.module.sendAiMessage();
  check('终态reload不再次打开队列里的已显示草稿', () => assert.equal(queued.modals.length, 2));

  const refreshTask = { ...task, id: 31 };
  const refreshRoutine = { ...routine, id: 32 };
  const refresh = environment(async (emit, env) => {
    emit('artifact.created', refreshTask); emit('artifact.created', refreshRoutine);
    env.detail.splice(0, env.detail.length, { ...refreshTask, status: 'CONFIRMED' });
    await env.module.renderAgentPanels();
    check('reload后已确认和已消失的草稿不再留在弹窗队列', () => {
      assert.equal(env.modals.filter(dialog => !dialog.closed).length, 0);
      const count = env.modals.length;
      env.modals[0].handle.close();
      assert.equal(env.modals.length, count);
    });
    emit('done', done);
  }, [refreshTask, refreshRoutine]);
  await refresh.module.sendAiMessage();

  const switchQueue = environment(async (emit, env) => {
    emit('artifact.created', { ...task, id: 41 }); emit('artifact.created', { ...routine, id: 42 });
    if (typeof env.module.setAiNotebookId === 'function') env.module.setAiNotebookId(5);
    else env.state.notebookId = 5;
    env.modals[0].handle.close();
    check('切换Notebook后旧队列被终止且旧onClose不再推进', () => {
      assert.equal(env.modals.length, 1);
      assert.equal(env.modals.filter(dialog => !dialog.closed).length, 0);
    });
    emit('artifact.created', { ...routine, id: 43 }); emit('done', done);
    check('切换后的迟到草稿事件不进入新队列', () => assert.equal(env.modals.length, 1));
  });
  await switchQueue.module.sendAiMessage();

  let turns = 0;
  const newTurnTask = { ...task, id: 51 };
  const newTurnRoutine = { ...routine, id: 52 };
  const nextTurn = environment(async (emit, env) => {
    if (++turns === 1) {
      emit('artifact.created', newTurnTask); emit('artifact.created', newTurnRoutine);
    } else {
      env.detail.splice(0);
      check('新回合开始时立即关闭旧弹窗并清除旧待显示项', () => {
        assert.equal(env.modals.filter(dialog => !dialog.closed).length, 0);
        const count = env.modals.length;
        env.modals[0].handle.close();
        assert.equal(env.modals.length, count);
      });
    }
    emit('done', done);
  }, [newTurnTask, newTurnRoutine]);
  await nextTurn.module.sendAiMessage();
  nextTurn.input.value = '新一轮问题';
  await nextTurn.module.sendAiMessage();
  console.log(failures ? 'RED: ' + failures : 'ALL-GREEN');
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
