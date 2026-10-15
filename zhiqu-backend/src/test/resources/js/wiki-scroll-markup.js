// Feed the published JSON preview markup to the real WebKit layout check.
// This fixture contains synthetic data only; it never reads a vault or calls the API.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
function between(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'published preview function must exist');
  return source.slice(from, to);
}
const render = new Function(between('  function esc(v) {', '  function maintainShellCache')
  + between('  function attachmentPreviewHtml(', '  async function hydrateAttachment(')
  + '\nreturn attachmentPreviewHtml;')();
const text = JSON.stringify(Array.from({length: 100}, (_, index) => ({
  index, description: 'Synthetic JSON scrolling fixture', value: 'long-value-'.repeat(24)
})));
const markup = render({name: 'synthetic-scroll.json', previewType: 'JSON', text}, '/api/knowledge/attachments/21');
assert.ok(markup.includes('zq-embed-text') && markup.includes('<pre><code>'));
fs.writeFileSync(process.argv[3], '<span class="zq-embed" contenteditable="false">' + markup + '</span>');
console.log('ALL-GREEN');
