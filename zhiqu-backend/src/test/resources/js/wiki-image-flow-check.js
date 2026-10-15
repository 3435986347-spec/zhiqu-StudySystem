// The published editor must not insert a late upload into a new editing session of the same page.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('function insertWikiImage(file) {');
const end = source.indexOf('function wikiToolbar(cmd) {', start);
if (start < 0 || end < 0) throw new Error('Cannot find published image editor functions');
const editor = source.slice(start, end);

function fixture() {
  let finishUpload;
  const uploaded = new Promise(resolve => { finishUpload = resolve; });
  const page = { id: 7, title: 'Risk notes' };
  const state = { wikiCur: page, wikiImageUploading: false };
  const messages = [];
  const doc = {
    dataset: { editing: '0', source: '0' }, style: {}, contentEditable: 'false',
    focus() {}, contains() { return false; }, dispatchEvent() {}
  };
  const selection = { rangeCount: 0, removeAllRanges() {}, addRange() {} };
  const fakeDocument = {
    createElement() { return { innerHTML: '', querySelector() { return { outerHTML: '<span>image</span>' }; } }; },
    createRange() { return { selectNodeContents() {}, collapse() {} }; },
    execCommand() { return true; }
  };
  let auth = 'first-token';
  const api = new Function('state', 'doc', 'uploaded', 'messages', 'fakeDocument', 'selection', 'getAuth', `
    var wikiEditSession = 0;
    var document = fakeDocument;
    var window = { getSelection: function () { return selection; } };
    var api = { upload: function () { return uploaded; } };
    function $(selector) { return selector === '#zq-doc' ? doc : null; }
    function token() { return getAuth(); }
    function isWikiImageFile() { return true; }
    function toast(message) { messages.push(message); }
    function safe(_name, fn) { return Promise.resolve().then(fn); }
    function wireWikiDrafts() {}
    function showWikiActionBar() {}
    function renderMarkdown() { return '<span>image</span>'; }
    function renderMathIn() {}
    ${editor}
    return { insertWikiImage, enterWikiEdit };
  `)(state, doc, uploaded, messages, fakeDocument, selection, () => auth);
  return { api, state, doc, page, messages, finishUpload, setAuth(value) { auth=value; } };
}

async function test(name, fn) { await fn(); console.log('PASS ' + name); }
(async () => {
  let checks = 0;
  await test('upload still inserts into the original live editing session', async () => {
    const f = fixture();
    f.api.enterWikiEdit();
    const task = f.api.insertWikiImage({ name: 'chart.png', type: 'image/png' });
    f.finishUpload({ url: '/api/knowledge/images/13', name: 'chart.png' });
    await task;
    assert.ok(f.messages.some(message => message.includes('已加入当前草稿')));
    checks++;
  });
  await test('late upload cannot enter a new edit session of the same page', async () => {
    const f = fixture();
    f.api.enterWikiEdit();
    const task = f.api.insertWikiImage({ name: 'chart.png', type: 'image/png' });
    f.doc.dataset.editing = '0'; // paintWikiDoc closes the old edit session.
    f.api.enterWikiEdit(); // The user returned to the same page before upload completed.
    f.finishUpload({ url: '/api/knowledge/images/13', name: 'chart.png' });
    await task;
    assert.ok(f.messages.some(message => message.includes('已切换')));
    assert.ok(!f.messages.some(message => message.includes('已加入当前草稿')));
    checks++;
  });
  await test('late upload cannot insert an attachment into a different login session', async () => {
    const f = fixture(); f.api.enterWikiEdit();
    const task = f.api.insertWikiImage({ name: 'chart.png', type: 'image/png' });
    f.setAuth('another-token');
    f.finishUpload({ url: '/api/knowledge/images/13', name: 'chart.png' });
    await task;
    assert.ok(!f.messages.some(message => message.includes('已加入当前草稿')));
    checks++;
  });
  assert.ok(checks >= 3, 'Empty behavior scan');
  console.log('ALL-GREEN');
})().catch(error => { console.error('FAIL ' + error.stack); process.exitCode = 1; });
