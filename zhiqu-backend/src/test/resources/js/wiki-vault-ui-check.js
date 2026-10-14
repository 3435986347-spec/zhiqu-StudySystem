// Exercise the published Wiki ZIP dialog, including requests that finish after a selection changes.
const fs = require('node:fs');
const assert = require('node:assert/strict');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const source = fs.readFileSync(process.argv[2], 'utf8');
  const module = await import('data:text/javascript;base64,' + Buffer.from(source
    + '\nexport const __vault = { importWikiVault, exportWikiMarkdown };').toString('base64'));
  let checks = 0;
  async function check(name, fn) {
    await fn();
    checks++;
    console.log('PASS ' + name);
  }
  function fixture(options = {}) {
    const dialogs = [], pending = [], downloadPaths = [], toasts = [];
    const page = { id: 12, title: '当前页', pageType: 'NOTE' };
    const state = { wikiCur: page, wikiPages: [], wikiDirty: false };
    function element() {
      return { value: '', textContent: '', innerHTML: '', disabled: false, files: [], dataset: {},
        clicks: 0, click() { this.clicks++; } };
    }
    function openModal(spec) {
      const body = { nodes: new Map(), buttons: [] };
      for (const match of spec.bodyHtml.matchAll(/id="([^"]+)"/g)) body.nodes.set(match[1], element());
      for (const match of spec.bodyHtml.matchAll(/data-vault-export="([^"]+)"/g)) {
        const button = element();
        button.dataset.vaultExport = match[1];
        body.buttons.push(button);
      }
      const dialog = { spec, body, closed: false };
      if (body.nodes.has('zq-vault-parent')) body.nodes.get('zq-vault-parent').value = 'root';
      if (body.nodes.has('zq-vault-confirm')) body.nodes.get('zq-vault-confirm').disabled = true;
      const handle = { close() { if (!dialog.closed) { dialog.closed = true; if (spec.onClose) spec.onClose(); } } };
      dialogs.push(dialog);
      if (spec.onMount) spec.onMount(body, handle);
      return handle;
    }
    const $ = (selector, body) => body.nodes.get(selector.slice(1));
    const $all = (selector, body) => selector === '[data-vault-export]' ? body.buttons : [];
    module.bind({
      api: {
        get: path => options.get ? options.get(path) : Promise.resolve({ version: 3 }),
        upload: (path, file, fields, headers) => options.upload ? options.upload(path, file, fields, headers) : Promise.resolve({ previewToken: 'ready', pages: [] }),
        download: async path => { downloadPaths.push(path); throw new Error('Stop after observing URL'); }
      }, state, $, $all, openModal,
      esc: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
      icon: () => '<svg></svg>',
      safe: (_name, fn) => {
        const work = Promise.resolve().then(fn);
        const task = options.swallowSafe ? work.catch(() => {}) : work;
        pending.push(task);
        return task;
      },
      notice: () => ({ update() {}, close() {} }), toast(message, kind) { toasts.push({ message, kind }); }
    });
    function node(dialog, id) {
      const found = dialog.body.nodes.get(id);
      assert.ok(found, 'Published dialog is missing #' + id);
      return found;
    }
    return { dialogs, pending, downloadPaths, toasts, page, state, node };
  }
  function selectFile(f, dialog, file) {
    const input = f.node(dialog, 'zq-vault-file');
    input.files = [file];
    input.onchange();
  }
  const zip = { name: 'notes.zip', size: 1024 };
  const result = { previewToken: 'preview-1', pages: [], pageCount: 1, attachmentCount: 0, relationshipCount: 0 };

  await check('custom file button opens the hidden ZIP picker', async () => {
    const f = fixture();
    module.__vault.importWikiVault();
    const dialog = f.dialogs[0];
    assert.match(dialog.spec.bodyHtml, /<button[^>]+id="zq-vault-pick"/);
    f.node(dialog, 'zq-vault-pick').onclick();
    assert.equal(f.node(dialog, 'zq-vault-file').clicks, 1);
  });
  await check('an old preview stays invalid after selecting another file and then the original file', async () => {
    const wait = deferred(), f = fixture({ upload: () => wait.promise });
    module.__vault.importWikiVault();
    const dialog = f.dialogs[0];
    selectFile(f, dialog, zip);
    f.node(dialog, 'zq-vault-check').onclick();
    await Promise.resolve();
    selectFile(f, dialog, { name: 'other.zip', size: 1024 });
    selectFile(f, dialog, zip);
    wait.resolve(result);
    await f.pending[0];
    assert.equal(f.node(dialog, 'zq-vault-confirm').disabled, true);
    assert.equal(f.node(dialog, 'zq-vault-preview').innerHTML, '');
  });
  await check('an old preview stays invalid after changing the destination and changing back', async () => {
    const wait = deferred(), f = fixture({ upload: () => wait.promise });
    module.__vault.importWikiVault();
    const dialog = f.dialogs[0];
    selectFile(f, dialog, zip);
    const parent = f.node(dialog, 'zq-vault-parent');
    parent.value = 'root';
    f.node(dialog, 'zq-vault-check').onclick();
    await Promise.resolve();
    parent.value = 'current'; parent.onchange();
    parent.value = 'root'; parent.onchange();
    wait.resolve(result);
    await f.pending[0];
    assert.equal(f.node(dialog, 'zq-vault-confirm').disabled, true);
    assert.equal(f.node(dialog, 'zq-vault-preview').innerHTML, '');
  });
  await check('export keeps the page selected when the dialog opened', async () => {
    const f = fixture();
    const operation = module.__vault.exportWikiMarkdown();
    const dialog = f.dialogs[0];
    f.state.wikiCur = { id: 99, title: '别的页', pageType: 'NOTE' };
    const current = dialog.body.buttons.find(button => button.dataset.vaultExport === 'current');
    assert.ok(current);
    current.onclick();
    await operation;
    assert.deepEqual(f.downloadPaths, ['/knowledge/vault/export.zip?rootPageId=12']);
  });
  await check('uncertain ZIP confirmation retries reuse the same explicit idempotency key', async () => {
    const confirmations = [];
    const f = fixture({ swallowSafe: true, upload: (path, file, fields, headers) => {
      if (path.endsWith('/preview')) return Promise.resolve(result);
      assert.equal(path, '/knowledge/vault/import/confirm');
      confirmations.push({ file, fields, headers });
      return Promise.reject(new Error('response lost'));
    } });
    module.__vault.importWikiVault();
    const dialog = f.dialogs[0];
    selectFile(f, dialog, zip);
    f.node(dialog, 'zq-vault-check').onclick();
    await f.pending[0];
    assert.equal(f.node(dialog, 'zq-vault-confirm').disabled, false);
    f.node(dialog, 'zq-vault-confirm').onclick();
    await f.pending[1];
    assert.equal(f.node(dialog, 'zq-vault-confirm').disabled, false);
    f.node(dialog, 'zq-vault-confirm').onclick();
    await f.pending[2];
    assert.equal(confirmations.length, 2);
    assert.ok(/^ui-vault-/.test(confirmations[0].headers['Idempotency-Key']));
    assert.equal(confirmations[0].headers['Idempotency-Key'], confirmations[1].headers['Idempotency-Key']);
    assert.equal(confirmations[0].fields.previewToken, 'preview-1');
    assert.equal(confirmations[0].file, zip);
  });
  await check('confirmed import stays successful when tree refresh fails and cannot be confirmed twice', async () => {
    let confirmations = 0;
    const f = fixture({ swallowSafe: true,
      upload: path => path.endsWith('/preview') ? Promise.resolve(result) : (confirmations++, Promise.resolve({ pageCount: 1, attachmentCount: 0, pageIds: [42] })),
      get: path => path === '/knowledge/document-tree' ? Promise.reject(new Error('offline')) : Promise.resolve({ version: 3 })
    });
    module.__vault.importWikiVault();
    const dialog = f.dialogs[0];
    selectFile(f, dialog, zip);
    f.node(dialog, 'zq-vault-check').onclick();
    await f.pending[0];
    f.node(dialog, 'zq-vault-confirm').onclick();
    await f.pending[1];
    assert.equal(confirmations, 1);
    assert.equal(dialog.closed, true);
    assert.ok(f.toasts.some(item => /已导入/.test(item.message) && /刷新页面/.test(item.message)), f.toasts);
    assert.ok(!f.toasts.some(item => /导入失败|导入知识库 ZIP 失败/.test(item.message)), f.toasts);
    f.node(dialog, 'zq-vault-confirm').onclick();
    assert.equal(confirmations, 1);
  });
  assert.ok(checks >= 6, 'Empty behavior scan');
  console.log('ALL-GREEN');
}
main().catch(error => { console.error('FAIL ' + error.stack); process.exitCode = 1; });
