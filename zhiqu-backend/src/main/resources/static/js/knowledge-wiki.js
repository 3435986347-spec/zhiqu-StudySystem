checkAuth();
renderNavbar('navbar');

let wikiTree = [];
let wikiFlat = [];
let wikiRevisionDrafts = new Map();
let wikiBlockCache = new Map();
let wikiLinks = [];
let wikiSources = [];
let wikiLogs = [];
let wikiPatchSets = [];
let wikiGraph = { nodes: [], links: [] };
let selectedWikiPageId = null;
let wikiContentVisible = true;
let wikiInspectorVisible = false;
let activeEditor = null;
let activeBlockEditor = null;
let activeTitleEditor = null;
let wikiLinkInsertion = null;
let activeWikiBlockTarget = null;
let pendingBlockEditorTarget = null;
let suppressNextWikiDocumentClick = false;
const EMPTY_WIKI_CONTENT = '<!-- empty -->';
let wikiSourceMode = false;

document.addEventListener('DOMContentLoaded', () => {
    bindWikiEvents();
    loadWiki();
});

function bindWikiEvents() {
    document.getElementById('btn-refresh-wiki')?.addEventListener('click', loadWiki);
    document.getElementById('btn-new-page')?.addEventListener('click', () => openCreateModal({}));
    document.getElementById('btn-wiki-ingest')?.addEventListener('click', openSourceModal);
    document.getElementById('btn-wiki-patches')?.addEventListener('click', openPatchModal);
    document.getElementById('btn-wiki-query')?.addEventListener('click', openQueryModal);
    document.getElementById('btn-wiki-graph')?.addEventListener('click', openGraphModal);
    document.getElementById('btn-wiki-export')?.addEventListener('click', exportWikiMarkdown);
    document.getElementById('btn-wiki-lint')?.addEventListener('click', runWikiLint);
    document.getElementById('btn-toggle-inspector')?.addEventListener('click', toggleInspector);
    document.getElementById('wiki-tree-search')?.addEventListener('input', renderWikiTree);
    document.getElementById('wiki-type-filter')?.addEventListener('change', renderWikiTree);
    document.getElementById('wiki-create-form')?.addEventListener('submit', submitCreateForm);
    document.querySelectorAll('[data-close-create]').forEach((el) => {
        el.addEventListener('click', closeCreateModal);
    });
    document.querySelectorAll('[data-close-patches]').forEach((el) => {
        el.addEventListener('click', closePatchModal);
    });
    document.querySelectorAll('[data-close-link]').forEach((el) => {
        el.addEventListener('click', closeLinkModal);
    });
    document.querySelectorAll('[data-close-graph]').forEach((el) => {
        el.addEventListener('click', closeGraphModal);
    });
    document.querySelectorAll('[data-close-source]').forEach((el) => {
        el.addEventListener('click', closeSourceModal);
    });
    document.querySelectorAll('[data-close-query]').forEach((el) => {
        el.addEventListener('click', closeQueryModal);
    });
    document.querySelectorAll('[data-close-lint]').forEach((el) => {
        el.addEventListener('click', closeLintModal);
    });
    document.getElementById('wiki-source-form')?.addEventListener('submit', submitSourceForm);
    document.getElementById('wiki-link-form')?.addEventListener('submit', submitLinkForm);
    document.getElementById('wiki-block-type-select')?.addEventListener('change', handleWikiBlockTypeChange);
    document.addEventListener('mousedown', handleGlobalWikiMouseDown, true);
    document.getElementById('wiki-format-toolbar')?.addEventListener('mousedown', (event) => {
        if (event.target.closest('[data-format-action]')) event.preventDefault();
    });
    document.getElementById('wiki-format-toolbar')?.addEventListener('click', handleWikiFormatToolbarClick);
    syncWikiSourceModeButton();
    document.getElementById('wiki-source-file')?.addEventListener('change', handleSourceFileChange);
    document.getElementById('btn-run-wiki-query')?.addEventListener('click', runWikiQuery);
    document.getElementById('wiki-query-input')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') runWikiQuery();
    });
    document.getElementById('wiki-tree')?.addEventListener('click', handleTreeClick);
    document.querySelector('.wiki-document-head')?.addEventListener('click', handleDocumentHeadClick);
    document.getElementById('wiki-document')?.addEventListener('mousedown', handleDocumentMouseDown, true);
    document.getElementById('wiki-document')?.addEventListener('click', handleDocumentClick);
    document.getElementById('wiki-document')?.addEventListener('focusout', handleDocumentFocusOut);
    document.getElementById('wiki-inspector')?.addEventListener('click', handleInspectorClick);
    document.getElementById('wiki-patch-list')?.addEventListener('click', handlePatchListClick);
    document.getElementById('wiki-lint-body')?.addEventListener('click', handleLintClick);
}

async function loadWiki() {
    const workspaceRes = await api.get('/knowledge/workspace');
    const data = workspaceRes.data || {};
    wikiTree = Array.isArray(data.tree) ? data.tree : [];
    wikiLinks = Array.isArray(data.links) ? data.links : [];
    wikiSources = Array.isArray(data.sources) ? data.sources : [];
    wikiLogs = Array.isArray(data.recentLogs) ? data.recentLogs : [];
    wikiPatchSets = Array.isArray(data.pendingPatchSets) ? data.pendingPatchSets : [];
    wikiGraph = data.graph || { nodes: [], links: [] };
    wikiFlat = flattenTree(wikiTree);
    wikiBlockCache = new Map();
    ensureSelectedWikiPage();
    renderWikiTree();
    renderDocument();
    renderInspector();
    renderParentOptions();
    setText('wiki-page-count', wikiFlat.length + ' 页');
    setText('wiki-patch-count', String(wikiPatchSets.length));
}

function renderWikiTree() {
    const box = document.getElementById('wiki-tree');
    if (!box) return;
    syncWikiWorkspaceState();
    const filteredTree = filterTreeForDisplay(wikiTree);
    box.innerHTML = filteredTree.length
        ? renderTreeNodes(filteredTree, 1)
        : '<div class="wiki-empty-state">还没有知识页。点击“新建知识页”开始。</div>';
}

function filterTreeForDisplay(nodes) {
    const query = valueOf('wiki-tree-search').toLowerCase();
    const type = valueOf('wiki-type-filter');
    const matches = (node) => {
        const haystack = ((node.title || '') + ' ' + (node.summary || '') + ' ' + (node.pageType || '')).toLowerCase();
        const queryOk = !query || haystack.includes(query);
        const typeOk = !type || String(node.pageType || '').toUpperCase() === type;
        return queryOk && typeOk;
    };
    return (nodes || []).map((node) => {
        const children = filterTreeForDisplay(node.children || []);
        if (matches(node) || children.length) {
            return { ...node, children };
        }
        return null;
    }).filter(Boolean);
}

function renderTreeNodes(nodes, level) {
    return '<div class="wiki-tree-group">' + nodes.map((node, index) => {
        const prefix = displayPrefix(level, index);
        const children = node.children || [];
        const activeClass = String(node.id) === String(selectedWikiPageId) ? ' active' : '';
        return '<div class="wiki-tree-item">' +
            '<button type="button" class="wiki-node' + activeClass + '" data-scroll-id="' + node.id + '">' +
            '<span class="wiki-node-prefix">' + escapeHtml(prefix) + '</span>' +
            '<span class="wiki-node-title">' + escapeHtml(node.title || '未命名') + '</span>' +
            '<span class="wiki-node-type">' + escapeHtml(typeLabel(node.pageType)) + '</span>' +
            '</button>' +
            (children.length ? '<div class="wiki-children">' + renderTreeNodes(children, level + 1) + '</div>' : '') +
            '</div>';
    }).join('') + '</div>';
}

function renderDocument() {
    const box = document.getElementById('wiki-document');
    if (!box) return;
    syncWikiWorkspaceState();
    if (!wikiContentVisible) {
        renderCurrentDocumentHeader(null);
        box.innerHTML = '';
        setText('wiki-save-state', '再次点击目录可展开内容');
        return;
    }
    if (!wikiTree.length) {
        box.innerHTML = '<div class="wiki-empty-state">知识树还是空的。新建一页，或者从 AI 草稿确认写入。</div>';
        renderCurrentDocumentHeader(null);
        setText('wiki-save-state', '还没有知识页');
        return;
    }
    const selected = ensureSelectedWikiPage();
    if (!selected) {
        box.innerHTML = '<div class="wiki-empty-state">知识树还是空的。新建一页，或者从 AI 草稿确认写入。</div>';
        renderCurrentDocumentHeader(null);
        setText('wiki-save-state', '还没有知识页');
        return;
    }
    renderCurrentDocumentHeader(selected);
    box.innerHTML = renderDocumentNode(selected, 1, '', true);
    setText('wiki-save-state', '当前：' + (selected.path || selected.title || '未命名'));
    renderInspector();
}

function renderCurrentDocumentHeader(node) {
    const title = document.getElementById('wiki-document-title');
    const kicker = document.getElementById('wiki-document-kicker');
    const actions = document.getElementById('wiki-current-actions');
    if (!title || !kicker || !actions) return;
    if (!node) {
        kicker.textContent = 'Document View';
        title.textContent = '知识文档';
        title.removeAttribute('data-title-id');
        actions.innerHTML = '';
        return;
    }
    kicker.textContent = typeLabel(node.pageType) + (node.updatedAt ? ' · 更新于 ' + shortDate(node.updatedAt) : '');
    title.textContent = node.title || '未命名';
    title.className = 'wiki-doc-title wiki-current-title';
    title.dataset.titleId = node.id;
    actions.innerHTML =
        '<button type="button" class="btn btn-primary btn-sm" data-action="add-block" data-id="' + node.id + '">加一行</button>' +
        '<button type="button" class="btn btn-default btn-sm" data-action="new-child" data-id="' + node.id + '">子页</button>' +
        '<button type="button" class="btn btn-default btn-sm" data-action="up" data-id="' + node.id + '">上移</button>' +
        '<button type="button" class="btn btn-default btn-sm" data-action="down" data-id="' + node.id + '">下移</button>' +
        '<button type="button" class="btn btn-default btn-sm" data-action="edit" data-id="' + node.id + '">编辑</button>' +
        '<button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="' + node.id + '">删除</button>';
}

function renderDocumentNodes(nodes, level) {
    return nodes.map((node, index) => {
        const prefix = displayPrefix(level, index);
        return renderDocumentNode(node, level, prefix, false) + renderDocumentNodes(node.children || [], level + 1);
    }).join('');
}

function renderInspector() {
    const node = selectedWikiPageId ? findNode(selectedWikiPageId) : null;
    const meta = document.getElementById('wiki-page-meta');
    const outline = document.getElementById('wiki-outline');
    const backlinks = document.getElementById('wiki-backlinks');
    const outlinks = document.getElementById('wiki-outlinks');
    const sources = document.getElementById('wiki-page-sources');
    const logs = document.getElementById('wiki-recent-logs');
    if (!meta || !outline || !backlinks || !outlinks || !sources || !logs) return;
    if (!node) {
        meta.innerHTML = '<div class="wiki-empty-mini">未选择页面</div>';
        outline.innerHTML = '';
        backlinks.innerHTML = '';
        outlinks.innerHTML = '';
        sources.innerHTML = '';
        logs.innerHTML = '';
        return;
    }
    const outLinks = wikiLinks.filter((link) => String(link.sourcePageId) === String(node.id));
    const inLinks = wikiLinks.filter((link) => String(link.targetPageId || '') === String(node.id)
        || normalizeClientTitle(link.targetTitle) === normalizeClientTitle(node.title));
    meta.innerHTML =
        '<div class="wiki-meta-line"><span>类型</span><strong>' + escapeHtml(typeLabel(node.pageType)) + '</strong></div>' +
        '<div class="wiki-meta-line"><span>出链</span><strong>' + outLinks.length + '</strong></div>' +
        '<div class="wiki-meta-line"><span>反链</span><strong>' + inLinks.length + '</strong></div>' +
        '<div class="wiki-meta-line"><span>更新</span><strong>' + escapeHtml(shortDate(node.updatedAt) || '未知') + '</strong></div>';
    outline.innerHTML = renderOutline(node.content || '');
    backlinks.innerHTML = inLinks.length
        ? inLinks.map((link) => {
            const source = findNode(link.sourcePageId);
            return '<button type="button" class="wiki-inspector-link" data-jump-page="' + escapeHtml(String(link.sourcePageId)) + '">' +
                escapeHtml(source?.title || '未知页面') +
                '<span>→ [[' + escapeHtml(link.targetTitle || '') + ']]</span>' +
                '</button>';
        }).join('')
        : '<div class="wiki-empty-mini">暂无反向链接</div>';
    outlinks.innerHTML = outLinks.length
        ? outLinks.map((link) => {
            const target = link.targetPageId ? findNode(link.targetPageId) : null;
            return '<button type="button" class="wiki-inspector-link" ' + (target ? 'data-jump-page="' + escapeHtml(String(target.id)) + '"' : 'data-create-link="' + escapeHtml(link.targetTitle || '') + '"') + '>' +
                escapeHtml(target?.title || link.targetTitle || '未创建页面') +
                '<span>' + (target ? '已连接' : '缺失页面') + '</span>' +
                '</button>';
        }).join('')
        : '<div class="wiki-empty-mini">暂无出链</div>';
    const pageSources = wikiSources.filter((source) => {
        const conversationOk = node.sourceConversationId && String(source.conversationId || '') === String(node.sourceConversationId);
        const messageOk = node.sourceMessageId && String(source.messageId || '') === String(node.sourceMessageId);
        return conversationOk || messageOk;
    });
    sources.innerHTML = pageSources.length
        ? pageSources.map(renderInspectorSource).join('')
        : '<div class="wiki-empty-mini">暂无关联来源</div>';
    logs.innerHTML = wikiLogs.length
        ? wikiLogs.slice(0, 8).map((log) => '<div class="wiki-log-line"><strong>' + escapeHtml(log.title || '') + '</strong><span>' + escapeHtml(shortDate(log.createdAt) || '') + '</span></div>').join('')
        : '<div class="wiki-empty-mini">暂无日志</div>';
}

function renderInspectorSource(source) {
    const ref = String(source.sourceRef || '').trim();
    const refHtml = isHttpUrl(ref)
        ? '<a class="wiki-source-external" href="' + escapeHtml(ref) + '" target="_blank" rel="noopener noreferrer">打开网页</a>'
        : '';
    return '<div class="wiki-source-chip">' +
        '<strong>' + escapeHtml(source.title || 'Raw Source') + '</strong>' +
        '<span>' + escapeHtml(source.sourceType || '') + ' · ' + escapeHtml(shortDate(source.createdAt) || '') + '</span>' +
        refHtml +
        '</div>';
}

function openLinkModal() {
    if (!selectedWikiPageId) {
        showToast('请先在左侧选择一个知识页', 'warning');
        return;
    }
    const modal = document.getElementById('wikiLinkModal');
    if (!modal) return;
    captureWikiLinkInsertion();
    const selectedText = wikiLinkInsertion ? wikiLinkInsertion.selectedText : '';
    document.getElementById('wiki-link-title').value = selectedText || '';
    document.getElementById('wiki-link-url').value = '';
    modal.classList.remove('hidden');
    setTimeout(() => (selectedText ? document.getElementById('wiki-link-url') : document.getElementById('wiki-link-title'))?.focus(), 40);
}

function closeLinkModal() {
    document.getElementById('wikiLinkModal')?.classList.add('hidden');
}

async function submitLinkForm(event) {
    event.preventDefault();
    if (!selectedWikiPageId) return;
    const title = valueOf('wiki-link-title');
    const url = valueOf('wiki-link-url');
    if (!title || !isHttpUrl(url)) {
        showToast('链接只支持 http 或 https 地址', 'warning');
        return;
    }
    const safeLink = '[' + title.replace(/]/g, '') + '](' + url.trim() + ')';
    const insertion = wikiLinkInsertion && String(wikiLinkInsertion.pageId) === String(selectedWikiPageId)
        ? wikiLinkInsertion
        : null;
    const blocks = getBlocks(selectedWikiPageId);
    if (insertion && blocks[insertion.blockIndex]) {
        const block = blocks[insertion.blockIndex];
        const text = insertion.plainMode ? toEditableDisplayText(block.text || '') : toEditableMarkdownText(block.text || '');
        const start = Math.max(0, Math.min(insertion.start, text.length));
        const end = Math.max(start, Math.min(insertion.end, text.length));
        block.text = text.slice(0, start) + safeLink + text.slice(end);
        if (activeBlockEditor
            && String(activeBlockEditor.pageId) === String(insertion.pageId)
            && Number(activeBlockEditor.blockIndex) === Number(insertion.blockIndex)) {
            activeBlockEditor = null;
            syncWikiSourceModeButton();
        }
    } else {
        blocks.push({ type: 'paragraph', text: safeLink });
    }
    wikiLinkInsertion = null;
    await persistBlocks(selectedWikiPageId, true);
    closeLinkModal();
    showToast('链接已插入当前知识页', 'success');
}

function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function renderOutline(content) {
    const headings = String(content || '').split('\n')
        .map((line) => line.match(/^(#{1,6})\s+(.+)$/))
        .filter(Boolean)
        .map((match) => ({ level: match[1].length, text: toEditablePlainText(match[2]) }));
    if (!headings.length) return '<div class="wiki-empty-mini">暂无标题</div>';
    return headings.map((item) => '<div class="wiki-outline-line level-' + Math.min(item.level, 6) + '">' + escapeHtml(item.text) + '</div>').join('');
}

function normalizeClientTitle(title) {
    return String(title || '').replace(/\s+/g, '').toLowerCase();
}

function renderDocumentNode(node, level, prefix, isCurrentRoot) {
    const contentHtml = renderWikiBlocks(node);
    const levelClass = 'level-' + Math.min(level, 6);
    const rootClass = isCurrentRoot ? ' wiki-doc-current' : ' wiki-doc-child';
    const addButton = isCurrentRoot
        ? '<button type="button" class="btn btn-primary btn-sm" data-action="add-block" data-id="' + node.id + '">&#21152;&#19968;&#34892;</button>'
        : '';
    return '<article class="wiki-doc-node ' + levelClass + rootClass + '" id="wiki-page-' + node.id + '" data-page-id="' + node.id + '">' +
        '<header class="wiki-doc-header">' +
        '<div class="wiki-doc-title-wrap">' +
        '<div class="wiki-doc-title-row">' +
        '<span class="wiki-doc-prefix">' + escapeHtml(prefix) + '</span>' +
        '<h' + Math.min(level, 6) + ' class="wiki-doc-title" data-title-id="' + node.id + '">' + escapeHtml(node.title || '未命名') + '</h' + Math.min(level, 6) + '>' +
        '</div>' +
        '<div class="wiki-doc-meta">' + escapeHtml(typeLabel(node.pageType)) + (node.updatedAt ? ' · 更新于 ' + shortDate(node.updatedAt) : '') + '</div>' +
        '</div>' +
        '<div class="wiki-doc-actions">' +
        addButton +
        '<button type="button" class="btn btn-default btn-sm" data-action="new-child" data-id="' + node.id + '">子页</button>' +
        '<button type="button" class="btn btn-default btn-sm" data-action="up" data-id="' + node.id + '">上移</button>' +
        '<button type="button" class="btn btn-default btn-sm" data-action="down" data-id="' + node.id + '">下移</button>' +
        '<button type="button" class="btn btn-default btn-sm" data-action="edit" data-id="' + node.id + '">编辑</button>' +
        '<button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="' + node.id + '">删除</button>' +
        '</div>' +
        '</header>' +
        '<div class="wiki-doc-content">' + contentHtml + '</div>' +
        '</article>';
}

function handleTreeClick(event) {
    const target = event.target.closest('[data-scroll-id]');
    if (!target) return;
    toggleWikiPage(target.dataset.scrollId);
}

function toggleWikiPage(id) {
    const samePage = String(selectedWikiPageId || '') === String(id || '');
    if (samePage && wikiContentVisible) {
        wikiContentVisible = false;
        renderWikiTree();
        renderDocument();
        return;
    }
    wikiContentVisible = true;
    selectWikiPage(id);
}

async function handleDocumentHeadClick(event) {
    const button = event.target.closest('[data-action]');
    if (button) {
        event.preventDefault();
        await handleDocumentAction(button.dataset.action, button.dataset.id);
        return;
    }
    const title = event.target.closest('[data-title-id]');
    if (title) {
        event.preventDefault();
        startTitleEditor(title.dataset.titleId);
    }
}

function handleDocumentMouseDown(event) {
    const editor = activeBlockEditor;
    if (!editor || editor.cancelled) return;
    if (event.button != null && event.button !== 0) return;
    if (event.target.closest('a, button, input, textarea, select, [contenteditable="true"], .wiki-inline-editor, .vditor-lite')) return;
    const block = event.target.closest('[data-block-index]');
    if (!block) return;
    const pageId = block.dataset.pageId;
    const blockIndex = Number(block.dataset.blockIndex);
    if (String(editor.pageId) === String(pageId) && Number(editor.blockIndex) === blockIndex) return;
    const targetBlock = getBlocks(pageId)[blockIndex];
    if (!targetBlock || targetBlock.type === 'table' || targetBlock.type === 'hr') return;
    pendingBlockEditorTarget = {
        pageId: String(pageId),
        blockIndex,
        triggerEvent: { clientX: event.clientX, clientY: event.clientY }
    };
    suppressNextWikiDocumentClick = true;
    window.setTimeout(() => {
        suppressNextWikiDocumentClick = false;
    }, 350);
    event.preventDefault();
    event.stopPropagation();
    saveBlockEditor();
}

function handleGlobalWikiMouseDown(event) {
    const editor = activeBlockEditor;
    if (!editor || editor.cancelled) return;
    if (event.button != null && event.button !== 0) return;
    if (event.target.closest('.wiki-block-inline-editor, #wiki-format-toolbar, .modal')) return;
    if (event.target.closest('#wiki-document [data-block-index]')) return;
    saveBlockEditor();
}

async function handleDocumentClick(event) {
    if (suppressNextWikiDocumentClick) {
        suppressNextWikiDocumentClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
    }
    const wikiLink = event.target.closest('[data-wiki-link]');
    if (wikiLink) {
        event.preventDefault();
        openWikiLink(wikiLink.dataset.wikiLink);
        return;
    }
    const externalLink = event.target.closest('a[href^="http"]');
    if (externalLink) {
        return;
    }
    const tableCell = event.target.closest('[data-table-cell]');
    if (tableCell) {
        setActiveWikiBlock(tableCell.dataset.pageId, tableCell.dataset.blockIndex);
        return;
    }
    const blockButton = event.target.closest('[data-block-action]');
    if (blockButton) {
        event.preventDefault();
        await handleBlockAction(blockButton);
        return;
    }
    const button = event.target.closest('[data-action]');
    if (button) {
        event.preventDefault();
        await handleDocumentAction(button.dataset.action, button.dataset.id);
        return;
    }
    const title = event.target.closest('[data-title-id]');
    if (title) {
        event.preventDefault();
        startTitleEditor(title.dataset.titleId);
        return;
    }
    if (event.target.closest('a, button, input, textarea, select, [contenteditable="true"], .wiki-inline-editor, .vditor-lite')) return;
    const block = event.target.closest('[data-block-index]');
    if (block) {
        setActiveWikiBlock(block.dataset.pageId, block.dataset.blockIndex);
        startBlockEditor(block.dataset.pageId, block.dataset.blockIndex, event);
        return;
    }
    const editable = event.target.closest('[data-edit-id]');
    if (editable) {
        startInlineEditor(editable.dataset.editId);
    }
}

function handleInspectorClick(event) {
    const jump = event.target.closest('[data-jump-page]');
    if (jump) {
        selectWikiPage(jump.dataset.jumpPage);
        return;
    }
    const missing = event.target.closest('[data-create-link]');
    if (missing) {
        openWikiLink(missing.dataset.createLink);
    }
}

async function handleDocumentAction(action, id) {
    const node = findNode(id);
    if (!node) return;
    if (action === 'edit') {
        startTitleEditor(id);
        return;
    }
    if (action === 'add-block') {
        addBlockToPage(id);
        return;
    }
    if (action === 'new-child') {
        openCreateModal({ parentId: id });
        return;
    }
    if (action === 'delete') {
        const ok = await showConfirm('确定删除这条知识页吗？');
        if (!ok) return;
        await api.delete('/knowledge/pages/' + id);
        showToast('知识页已删除', 'success');
        await loadWiki();
        return;
    }
    if (action === 'up' || action === 'down') {
        await moveNode(node, action);
    }
}

function renderWikiBlocks(node) {
    const pageId = String(node.id);
    let blocks = wikiBlockCache.has(pageId) ? wikiBlockCache.get(pageId) : parseWikiBlocks(node.content || '');
    blocks = normalizeWikiBlocksForRender(blocks);
    wikiBlockCache.set(pageId, blocks);
    if (!blocks.length) {
        return '<div class="wiki-block-empty" data-block-action="add" data-page-id="' + pageId + '">&#28857;&#20987;&#28155;&#21152;&#31532;&#19968;&#34892;</div>';
    }
    return '<div class="wiki-block-list">' + blocks.map((block, index) => renderWikiBlock(pageId, block, index)).join('') + '</div>';
}

function normalizeWikiBlocksForRender(blocks) {
    const normalized = [];
    (blocks || []).forEach((block) => {
        if (!block) return;
        if (block.type === 'paragraph') {
            const repaired = splitParagraphIntoStructuredBlocks(block.text || '');
            if (repaired.length) {
                normalized.push(...repaired);
                return;
            }
        }
        if (block.type === 'list') {
            const task = parseTaskListMarker(block.text || '');
            normalized.push({
                ...block,
                text: toEditableMarkdownText(task.text),
                checked: block.checked === true || block.checked === false ? block.checked : task.checked
            });
            return;
        }
        if (block.type === 'ordered' || block.type === 'heading' || block.type === 'quote' || block.type === 'code' || block.type === 'formula') {
            normalized.push({ ...block, text: toEditableMarkdownText(block.text || '') });
            return;
        }
        if (block.type === 'table') {
            const headers = (block.headers || []).map(toEditableMarkdownText);
            const rows = (block.rows || []).map((row) => normalizeLooseTableRow(row || [], headers.length || (row || []).length).map(toEditableMarkdownText));
            normalized.push({ ...block, headers, rows });
            return;
        }
        normalized.push(block);
    });
    return repairMalformedTableRuns(normalized);
}

function repairMalformedTableRuns(blocks) {
    const repaired = [];
    for (let i = 0; i < (blocks || []).length; i++) {
        const block = blocks[i];
        if (!block || block.type !== 'table') {
            repaired.push(block);
            continue;
        }
        const table = cloneTableBlock(block);
        let cursor = i + 1;
        while (cursor < blocks.length) {
            const next = blocks[cursor];
            if (!next) {
                cursor++;
                continue;
            }
            if (next.type === 'table' && canAppendTableRows(table, next)) {
                table.rows.push(...(next.rows || []).map((row) => normalizeLooseTableRow(row || [], table.headers.length)));
                cursor++;
                continue;
            }
            const continuation = collectTableContinuationBlocks(blocks, cursor);
            if (continuation && shouldAttachContinuationToTable(table, continuation.texts)) {
                appendLooseTableContinuation(table.rows[table.rows.length - 1], continuation.texts.join('\n'));
                cursor = continuation.next;
                continue;
            }
            break;
        }
        repaired.push(table);
        i = cursor - 1;
    }
    return repaired.filter(Boolean);
}

function cloneTableBlock(block) {
    const headers = (block.headers || []).map(toEditableMarkdownText);
    return {
        ...block,
        headers,
        rows: (block.rows || []).map((row) => normalizeLooseTableRow(row || [], headers.length || (row || []).length).map(toEditableMarkdownText))
    };
}

function canAppendTableRows(current, next) {
    if (!current || !next || next.type !== 'table') return false;
    const currentHeaders = current.headers || [];
    const nextHeaders = next.headers || [];
    if (!currentHeaders.length || !nextHeaders.length) return false;
    if (currentHeaders.length !== nextHeaders.length) return false;
    const currentKey = currentHeaders.join('|');
    const nextKey = nextHeaders.join('|');
    if (currentKey === nextKey) return true;
    if (isScheduleHeader(currentHeaders) && isScheduleHeader(nextHeaders)) return true;
    if (isPhaseHeader(currentHeaders) && isPhaseHeader(nextHeaders)) return true;
    return false;
}

function isScheduleHeader(headers) {
    const joined = (headers || []).join('|');
    return /时间段/.test(joined) && /时长/.test(joined) && /内容/.test(joined);
}

function isPhaseHeader(headers) {
    const joined = (headers || []).join('|');
    return /阶段/.test(joined) && /(时间范围|核心定位|考研每日时间)/.test(joined);
}

function collectTableContinuationBlocks(blocks, startIndex) {
    const texts = [];
    let i = startIndex;
    while (i < blocks.length && texts.length < 4) {
        const block = blocks[i];
        if (!block || (block.type !== 'list' && block.type !== 'paragraph')) break;
        const text = toEditablePlainText(block.text || '');
        if (!text) break;
        texts.push(text.replace(/\s*\|\s*$/, '').trim());
        i++;
    }
    if (!texts.length) return null;
    return { texts, next: i };
}

function shouldAttachContinuationToTable(table, texts) {
    if (!table || !Array.isArray(table.rows) || !table.rows.length || !texts.length) return false;
    const joined = texts.join('');
    if (/^第[一二三四五六七八九十]+阶段/.test(joined)) return false;
    if (/^周[一二三四五六日天]/.test(joined)) return false;
    if (joined.length > 120) return false;
    if (!(isScheduleHeader(table.headers || []) || isPhaseHeader(table.headers || []))) return false;
    return texts.every((text) => looksLikeTableCellContinuationText(text, table.headers || []));
}

function looksLikeTableCellContinuationText(text, headers) {
    const value = String(text || '').trim();
    if (!value || value.length > 90) return false;
    if (/^(时间范围|假设前提|总复习时间|核心策略|底线目标|防崩盘规则|第二阶段|第三阶段|第四阶段|这是|你觉得|确认后)/.test(value)) return false;
    if (/^周[一二三四五六日天]/.test(value)) return false;
    if (/[。？！]$/.test(value)) return false;
    if (/^[+＋]/.test(value)) return true;
    if (isScheduleHeader(headers)) {
        if (/^(APP|少量|继续|若|做|看|早年|逐句|回顾|在笔记|计网|OS|数据结构|英语|数学|408|自由补弱|休息)/.test(value)) return true;
        return value.length <= 24;
    }
    if (isPhaseHeader(headers)) return /^[+＋]/.test(value);
    return false;
}

function splitParagraphIntoStructuredBlocks(text) {
    const lines = String(text || '').split('\n');
    const result = [];
    let paragraph = [];
    for (let i = 0; i < lines.length;) {
        const line = String(lines[i] || '').trim();
        if (!line) {
            flushParagraph(result, paragraph);
            paragraph = [];
            i++;
            continue;
        }
        const pipedTable = readPipedTableBlock(lines, i);
        if (pipedTable) {
            flushParagraph(result, paragraph);
            paragraph = [];
            result.push({ type: 'table', headers: pipedTable.headers, rows: pipedTable.rows });
            i = pipedTable.next;
            continue;
        }
        paragraph.push(line);
        i++;
    }
    flushParagraph(result, paragraph);
    return result;
}

function flushParagraph(result, paragraph) {
    if (!paragraph.length) return;
    const text = toEditableMarkdownText(paragraph.join('\n'));
    if (text) result.push({ type: 'paragraph', text });
}

function renderWikiBlock(pageId, block, index) {
    const controls =
        '<div class="wiki-block-controls">' +
        '<button type="button" class="wiki-block-btn" data-block-action="add-after" data-page-id="' + pageId + '" data-block-index="' + index + '" title="Add">+</button>' +
        '<button type="button" class="wiki-block-btn danger" data-block-action="delete" data-page-id="' + pageId + '" data-block-index="' + index + '" title="Delete">×</button>' +
        '</div>';
    if (block.type === 'hr') {
        return '<div class="wiki-block wiki-block-hr" data-page-id="' + pageId + '" data-block-index="' + index + '"><hr>' + controls + '</div>';
    }
    if (block.type === 'table') {
        return renderEditableTableBlock(pageId, block, index, controls);
    }
    if (block.type === 'quote') {
        return '<div class="wiki-block wiki-block-quote" data-page-id="' + pageId + '" data-block-index="' + index + '">' +
            '<div class="wiki-block-main">' +
            '<span class="wiki-block-marker">”</span>' +
            '<blockquote class="wiki-block-text">' + renderInlineMarkdown(block.text || '') + '</blockquote>' +
            '</div>' +
            controls +
            '</div>';
    }
    if (block.type === 'code') {
        return '<div class="wiki-block wiki-block-code" data-page-id="' + pageId + '" data-block-index="' + index + '">' +
            '<div class="wiki-block-main">' +
            '<span class="wiki-block-marker">{ }</span>' +
            '<pre class="wiki-block-text wiki-code-block"><code>' + escapeHtml(block.text || '') + '</code></pre>' +
            '</div>' +
            controls +
            '</div>';
    }
    if (block.type === 'formula') {
        return '<div class="wiki-block wiki-block-formula" data-page-id="' + pageId + '" data-block-index="' + index + '">' +
            '<div class="wiki-block-main">' +
            '<span class="wiki-block-marker">ƒ</span>' +
            '<div class="wiki-block-text wiki-formula-block">' + renderMath(block.text || '', true) + '</div>' +
            '</div>' +
            controls +
            '</div>';
    }
    const headingLevel = block.type === 'heading' ? Math.max(1, Math.min(block.level || 3, 6)) : 0;
    const tag = block.type === 'heading' ? 'h' + headingLevel : 'div';
    const cls = 'wiki-block wiki-block-' + escapeHtml(block.type || 'paragraph')
        + (headingLevel ? ' wiki-block-heading-level-' + headingLevel : '');
    const prefix = block.type === 'list' ? renderWikiListMarker(block) :
        block.type === 'ordered' ? '<span class="wiki-block-marker">' + escapeHtml(String(block.number || 1)) + '.</span>' : '';
    return '<div class="' + cls + '" data-page-id="' + pageId + '" data-block-index="' + index + '">' +
        '<div class="wiki-block-main">' +
        prefix +
        '<' + tag + ' class="wiki-block-text">' + renderInlineMarkdown(block.text || '') + '</' + tag + '>' +
        '</div>' +
        controls +
        '</div>';
}

function renderEditableTableBlock(pageId, block, index, controls) {
    const headers = block.headers || [];
    const rows = block.rows || [];
    const table = ['<div class="wiki-block wiki-block-table" data-page-id="' + pageId + '" data-block-index="' + index + '">'];
    table.push('<div class="wiki-table-wrap"><table><thead><tr>');
    headers.forEach((cell, cellIndex) => {
        table.push('<th contenteditable="true" data-table-cell data-page-id="' + pageId + '" data-block-index="' + index + '" data-row-index="-1" data-cell-index="' + cellIndex + '">' + renderTableCell(cell) + '</th>');
    });
    table.push('<th class="wiki-table-row-actions"><button type="button" class="wiki-block-btn" data-block-action="add-row" data-page-id="' + pageId + '" data-block-index="' + index + '">+</button></th>');
    table.push('</tr></thead><tbody>');
    rows.forEach((row, rowIndex) => {
        table.push('<tr>');
        headers.forEach((_, cellIndex) => {
            table.push('<td contenteditable="true" data-table-cell data-page-id="' + pageId + '" data-block-index="' + index + '" data-row-index="' + rowIndex + '" data-cell-index="' + cellIndex + '">' + renderTableCell(row[cellIndex] || '') + '</td>');
        });
        table.push('<td class="wiki-table-row-actions"><button type="button" class="wiki-block-btn danger" data-block-action="delete-row" data-page-id="' + pageId + '" data-block-index="' + index + '" data-row-index="' + rowIndex + '">×</button></td>');
        table.push('</tr>');
    });
    table.push('</tbody></table></div>' + controls + '</div>');
    return table.join('');
}

function renderWikiListMarker(block) {
    if (block.checked === true || block.checked === false) {
        return '<span class="wiki-block-check ' + (block.checked ? 'checked' : '') + '" aria-hidden="true">' + (block.checked ? '✓' : '') + '</span>';
    }
    return '<span class="wiki-block-marker">•</span>';
}

function parseWikiBlocks(markdown) {
    const normalized = canonicalizeWikiModelMarkdown(normalizeLooseWikiMarkdown(cleanMarkdownSource(markdown)));
    const lines = normalized ? normalized.split('\n') : [];
    const blocks = [];
    for (let i = 0; i < lines.length;) {
        const line = lines[i] || '';
        const trimmed = line.trim();
        if (!trimmed) {
            i++;
            continue;
        }
        if (isEmptyWikiContentLine(trimmed)) {
            i++;
            continue;
        }
        if (/^[-*_]{2,}$/.test(trimmed)) {
            blocks.push({ type: 'hr' });
            i++;
            continue;
        }
        if (/^```/.test(trimmed)) {
            const code = [];
            i++;
            while (i < lines.length && !/^```/.test(String(lines[i] || '').trim())) {
                code.push(lines[i++]);
            }
            if (i < lines.length) i++;
            blocks.push({ type: 'code', text: code.join('\n') });
            continue;
        }
        if (trimmed === '$$') {
            const formula = [];
            i++;
            while (i < lines.length && String(lines[i] || '').trim() !== '$$') {
                formula.push(lines[i++]);
            }
            if (i < lines.length) i++;
            blocks.push({ type: 'formula', text: formula.join('\n') });
            continue;
        }
        const table = readModelMarkdownTableBlock(lines, i);
        if (table) {
            blocks.push({ type: 'table', headers: table.headers, rows: table.rows });
            i = table.next;
            continue;
        }
        const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            blocks.push({ type: 'heading', level: heading[1].length, text: toEditableMarkdownText(heading[2]) });
            i++;
            continue;
        }
        if (/^>\s?/.test(trimmed)) {
            const quote = [];
            while (i < lines.length && /^>\s?/.test(String(lines[i] || '').trim())) {
                quote.push(String(lines[i++] || '').trim().replace(/^>\s?/, ''));
            }
            blocks.push({ type: 'quote', text: toEditableMarkdownText(quote.join('\n')) });
            continue;
        }
        if (isBareTaskListLine(trimmed)) {
            const task = parseTaskListMarker(trimmed);
            const continuation = readBareTaskContinuation(lines, i + 1);
            const text = continuation ? task.text + '\n' + continuation.text : task.text;
            blocks.push({ type: 'list', text: toEditableMarkdownText(task.text), checked: task.checked });
            blocks[blocks.length - 1].text = toEditableMarkdownText(text);
            i = continuation ? continuation.next : i + 1;
            continue;
        }
        if (isUnorderedListLine(trimmed)) {
            const task = parseTaskListMarker(stripUnorderedListMarker(trimmed));
            blocks.push({ type: 'list', text: toEditableMarkdownText(task.text), checked: task.checked });
            i++;
            continue;
        }
        const ordered = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
        if (ordered) {
            blocks.push({ type: 'ordered', number: Number(ordered[1]), text: toEditableMarkdownText(ordered[2]) });
            i++;
            continue;
        }
        const paragraph = [trimmed];
        i++;
        while (i < lines.length && shouldContinueParagraph(lines[i])) {
            paragraph.push(String(lines[i] || '').trim());
            i++;
        }
        blocks.push({ type: 'paragraph', text: toEditableMarkdownText(paragraph.join('\n')) });
    }
    return blocks;
}

function readLooseMarkdownTableBlock(lines, index) {
    const headerCells = parseLooseTableCells(lines[index]);
    if (!looksLikeLooseTableHeader(headerCells, lines[index], lines[index + 1] || '')) return null;
    const columnCount = headerCells.length;
    const rows = [];
    let i = index + 1;
    if (isMarkdownTableSeparatorLine(lines[i])) i++;
    while (i < lines.length) {
        const line = lines[i] || '';
        const trimmed = String(line).trim();
        if (!trimmed) {
            const next = nextSignificantLine(lines, i + 1, 3);
            if (rows.length && next && !isLooseTableSectionBoundary(next.line, columnCount) && hasLooseTableContinuationAhead(lines, i + 1)) {
                i++;
                continue;
            }
            break;
        }
        if (rows.length && isLooseTableSectionBoundary(trimmed, columnCount)) break;
        if (/^[-*_]{2,}$/.test(trimmed)) break;
        if (isMarkdownTableSeparatorLine(line)) {
            i++;
            continue;
        }
        const cells = parseLooseTableCells(line);
        if (meaningfulCellCount(cells) >= 2) {
            if (rows.length && shouldMergePartialLooseTableRow(rows[rows.length - 1], cells, columnCount)) {
                mergePartialTableRow(rows[rows.length - 1], cells, columnCount);
            } else {
                rows.push(normalizeLooseTableRow(cells, columnCount));
            }
            i++;
            continue;
        }
        if (rows.length && isLooseTableContinuationLine(line)) {
            appendLooseTableContinuation(rows[rows.length - 1], cleanLooseTableText(line));
            i++;
            continue;
        }
        break;
    }
    if (!rows.length) return null;
    return { headers: normalizeLooseTableRow(headerCells, columnCount), rows, next: i };
}

function readModelMarkdownTableBlock(lines, index) {
    const firstLine = String(lines[index] || '').trim();
    if (!firstLine) return null;
    const firstCells = parseLooseTableCells(firstLine);
    if (!shouldStartModelTable(firstLine, firstCells, lines[index + 1] || '')) return null;

    let headers;
    let i = index;
    if (isModelTableHeaderLine(firstLine, firstCells, lines[index + 1] || '')) {
        headers = normalizeLooseTableRow(firstCells, Math.max(2, firstCells.length));
        i++;
        if (isMarkdownTableSeparatorLine(lines[i])) i++;
    } else {
        headers = inferLooseTableHeaders(firstCells.length, firstCells);
    }

    const columnCount = headers.length;
    const rows = [];
    let currentRow = null;

    while (i < lines.length) {
        const raw = String(lines[i] || '');
        const line = raw.trim();
        if (!line) {
            const next = nextSignificantLine(lines, i + 1, 2);
            if (currentRow && next && !isModelTableBoundary(next.line, headers, columnCount)) {
                i++;
                continue;
            }
            break;
        }
        if (isMarkdownTableSeparatorLine(line)) {
            i++;
            continue;
        }
        if (isModelTableBoundary(line, headers, columnCount)) break;

        const cells = parseLooseTableCells(line);
        if (isModelTableRowLine(line, cells, headers, currentRow)) {
            if (currentRow && shouldMergeBrokenModelTableRow(currentRow, cells, columnCount, line)) {
                mergePartialTableRow(currentRow, cells, columnCount);
            } else {
                currentRow = normalizeLooseTableRow(cells, columnCount);
                rows.push(currentRow);
            }
            i++;
            continue;
        }

        if (currentRow && looksLikeModelCellContinuation(line, headers, currentRow)) {
            appendLooseTableContinuation(currentRow, cleanPipedTableContinuation(line));
            i++;
            continue;
        }
        break;
    }

    if (!rows.length) return null;
    return { headers, rows, next: i };
}

function shouldStartModelTable(line, cells, nextLine) {
    if (!Array.isArray(cells) || meaningfulCellCount(cells) < 2) return false;
    if (isMarkdownTableSeparatorLine(line)) return false;
    if (isModelTableHeaderLine(line, cells, nextLine)) return true;
    if (isTableStart([line, nextLine || ''], 0)) return true;
    if (String(line || '').includes('|') && (line.trim().startsWith('|') || line.trim().endsWith('|'))) return true;
    return looksLikeScheduleDataRow(cells) || looksLikePhaseDataRow(cells);
}

function isModelTableHeaderLine(line, cells, nextLine) {
    if (!Array.isArray(cells) || meaningfulCellCount(cells) < 2) return false;
    const joined = cells.join('|');
    if (/时间段.*时长.*内容/.test(joined)) return true;
    if (/阶段.*时间范围/.test(joined)) return true;
    if (/任务.*(时间|说明|内容)/.test(joined)) return true;
    if (/科目.*(时间|内容|说明)/.test(joined)) return true;
    if (isMarkdownTableSeparatorLine(nextLine)) return true;
    return false;
}

function isModelTableRowLine(line, cells, headers, currentRow) {
    if (!Array.isArray(cells) || meaningfulCellCount(cells) < 2) return false;
    if (isModelTableHeaderLine(line, cells, '')) return false;
    if (String(line || '').includes('|') || String(line || '').includes('\t')) return true;
    if (looksLikeScheduleDataRow(cells)) return true;
    if (looksLikePhaseDataRow(cells)) return true;
    return !!currentRow && shouldMergeBrokenModelTableRow(currentRow, cells, headers.length, line);
}

function isModelTableBoundary(line, headers, columnCount) {
    const value = String(line || '').trim();
    if (!value) return false;
    const cells = parseLooseTableCells(value);
    const multiCellData = meaningfulCellCount(cells) >= 2 && (hasLooseTableSeparator(value) || looksLikeScheduleDataRow(cells) || looksLikePhaseDataRow(cells));
    if (multiCellData && !isModelTableHeaderLine(value, cells, '')) return false;
    if (/^[-*_]{2,}$/.test(value)) return true;
    if (/^(#{1,6}\s+)/.test(value)) return true;
    if (/^(第二阶段|第三阶段|第四阶段|防崩盘规则|底线目标|这是整体节奏|你觉得|确认后)/.test(value)) return true;
    if (/^周[一二三四五六日天](?:至周[一二三四五六日天])?$/.test(value)) return true;
    if (isModelTableHeaderLine(value, cells, '') && meaningfulCellCount(cells) !== columnCount) return true;
    if (isModelTableHeaderLine(value, cells, '') && !sameTableHeaderKind(headers, cells)) return true;
    return false;
}

function sameTableHeaderKind(headers, cells) {
    const current = (headers || []).join('|');
    const next = (cells || []).join('|');
    if (/时间段.*时长.*内容/.test(current) && /时间段.*时长.*内容/.test(next)) return true;
    if (/阶段.*时间范围/.test(current) && /阶段.*时间范围/.test(next)) return true;
    return current === next;
}

function shouldMergeBrokenModelTableRow(previousRow, cells, columnCount, line) {
    const meaningful = (cells || []).map(toEditablePlainText).filter(Boolean);
    if (!previousRow || !meaningful.length) return false;
    if (/^[+＋]/.test(meaningful[0])) return true;
    if (hasUnclosedBracket(previousRow.join(' '))) return true;
    if (String(line || '').trim().endsWith('|') && meaningful.length < columnCount) return true;
    return previousRow.some((cell, index) => index < columnCount && !String(cell || '').trim()) && meaningful.length < columnCount;
}

function looksLikeModelCellContinuation(line, headers, currentRow) {
    const raw = String(line || '').trim();
    const value = cleanPipedTableContinuation(raw);
    if (!value) return false;
    if (isModelTableBoundary(value, headers, headers.length)) return false;
    if (parseLooseTableCells(value).length >= 2 && hasLooseTableSeparator(value)) return false;
    if (value.length > 120) return false;
    if (/[。？！]$/.test(value)) return false;
    if (/^[+＋]/.test(value)) return true;
    if (isScheduleHeader(headers)) {
        return /^(APP|少量|继续|若|做|看|早年|逐句|回顾|在笔记|计网|OS|数据结构|英语|数学|408|自由补弱|休息|主线推进|复习)/.test(value)
            || value.length <= 30;
    }
    if (isPhaseHeader(headers)) {
        if (/^[+＋]/.test(value)) return true;
        if (/\|\s*$/.test(raw) && value.length <= 40) return true;
        return hasUnclosedBracket((currentRow || []).join(' '))
            && value.length <= 40
            && /[）)]|周末|暑假|家教/.test(value);
    }
    return false;
}

function looksLikeScheduleDataRow(cells) {
    const joined = (cells || []).join('|');
    return /\d{1,2}[:：]\d{2}|上午|下午|晚上|通勤|饭后|主学习段|副学习段|结束前/.test(joined)
        && /(小时|分钟|英语|数学|408|内容)/.test(joined);
}

function looksLikePhaseDataRow(cells) {
    const joined = (cells || []).join('|');
    return /第[一二三四五六七八九十]+阶段|基础期|强化期|冲刺期/.test(joined)
        && /202\d|现在|暑假|大[一二三四]/.test(joined);
}

function readPipedTableBlock(lines, index) {
    if (!isPipedTableCandidate(lines[index])) return null;
    const rows = [];
    let i = index;
    while (i < lines.length) {
        const line = String(lines[i] || '').trim();
        if (!line) {
            const next = nextSignificantLine(lines, i + 1, 2);
            if (rows.length && next && isPipedTableCandidate(next.line)) {
                const currentMaxColumns = Math.max(...rows.map((row) => row.length));
                const nextColumnCount = parseLooseTableCells(next.line).length;
                if (nextColumnCount === currentMaxColumns) {
                    i = next.index;
                    continue;
                }
            }
            break;
        }
        if (isMarkdownTableSeparatorLine(line)) {
            i++;
            continue;
        }
        if (isPipedTableCandidate(line)) {
            const cells = parseLooseTableCells(line);
            const currentMaxColumns = rows.length ? Math.max(...rows.map((row) => row.length)) : cells.length;
            if (rows.length && !line.startsWith('|') && cells.length < currentMaxColumns) {
                mergePartialPipedRow(rows[rows.length - 1], cells);
            } else {
                rows.push(cells);
            }
            i++;
            continue;
        }
        if (rows.length && isPipedTableContinuationLine(line)) {
            appendLooseTableContinuation(rows[rows.length - 1], cleanPipedTableContinuation(line));
            i++;
            continue;
        }
        break;
    }
    if (!rows.length) return null;
    const columnCount = Math.max(...rows.map((row) => row.length));
    const normalizedRows = rows.map((row) => normalizeLooseTableRow(row, columnCount));
    let headers;
    let bodyRows;
    if (normalizedRows.length > 1 && isLikelyHeaderRow(normalizedRows[0], normalizedRows[1])) {
        headers = normalizedRows[0];
        bodyRows = normalizedRows.slice(1);
    } else {
        headers = inferLooseTableHeaders(columnCount, normalizedRows[0]);
        bodyRows = normalizedRows;
    }
    return { headers, rows: bodyRows, next: i };
}

function nextSignificantLine(lines, startIndex, maxDistance) {
    const end = Math.min(lines.length, startIndex + Math.max(1, maxDistance || 1));
    for (let i = startIndex; i < end; i++) {
        const line = String(lines[i] || '').trim();
        if (line) return { line, index: i };
    }
    return null;
}

function isPipedTableCandidate(line) {
    const value = String(line || '').trim();
    if (!value || !value.includes('|')) return false;
    if (isMarkdownTableSeparatorLine(value)) return false;
    const pipeCount = (value.match(/\|/g) || []).length;
    if (pipeCount < 2) return false;
    const cells = parseLooseTableCells(value);
    return cells.length >= 2 && (value.startsWith('|') || value.endsWith('|') || pipeCount >= 2);
}

function isLikelyHeaderRow(row, nextRow) {
    const joined = row.join('');
    if (/任务|时间|时长|说明|内容|阶段|范围|科目|安排|目标/.test(joined)) return true;
    if (row.some((cell) => isScheduleLikeCell(cell) || /\d{4}|小时|分钟/.test(cell))) return false;
    return row.length === nextRow.length && row.every((cell) => String(cell || '').length <= 8);
}

function isLooseTableSectionBoundary(line, currentColumnCount) {
    const value = String(line || '').trim();
    if (!value) return false;
    if (/^(#{1,6}\s+|第二阶段|第三阶段|第四阶段|防崩盘规则|底线目标|周[一二三四五六日天](?:至周[一二三四五六日天])?)$/.test(value)) return true;
    const cells = parseLooseTableCells(value);
    const joined = cells.join('|');
    const looksHeader = /时间段|时长|内容|说明|阶段|时间范围|核心定位|考研每日时间/.test(joined);
    return looksHeader && meaningfulCellCount(cells) >= 2 && meaningfulCellCount(cells) !== currentColumnCount;
}

function inferLooseTableHeaders(columnCount, firstRow) {
    const joined = (firstRow || []).join('|');
    if (columnCount === 2) return ['项目', '内容'];
    if (columnCount === 3) {
        if (/\d{1,2}[:：]\d{2}|小时|分钟/.test(joined)) return ['时间段', '时长', '内容'];
        if (/第[一二三四五六七八九十]+阶段|基础期|强化期|冲刺期|暑假|寒假|大[一二三四]/.test(joined)) return ['阶段', '时间范围', '说明'];
        return ['项目', '内容', '说明'];
    }
    if (columnCount === 4) {
        if (/\d{1,2}[:：]\d{2}|小时|分钟|英语|数学|408/.test(joined)) return ['时间段', '时长', '内容', '说明'];
        return ['项目', '内容', '说明', '备注'];
    }
    return Array.from({ length: columnCount }, (_, idx) => '列 ' + (idx + 1));
}

function isScheduleLikeCell(value) {
    return /\d{1,2}[:：]\d{2}|202\d|小时|分钟|上午|下午|晚上|早晨|周[一二三四五六日天]/.test(String(value || ''));
}

function isPipedTableContinuationLine(line) {
    const value = String(line || '').trim();
    if (!value) return false;
    if (isPipedTableCandidate(value)) return false;
    if (/^[-*_]{2,}$/.test(value)) return false;
    if (/^(#{1,6}\s+|\d+[.)]\s+)/.test(value)) return false;
    if (/^周[一二三四五六日天]$/.test(value)) return false;
    if (/^第[一二三四五六七八九十]+阶段/.test(value)) return false;
    if (isUnorderedListLine(value)) return true;
    if (value.endsWith('|')) return true;
    return /^[+＋]\s*/.test(value);
}

function cleanPipedTableContinuation(line) {
    return toEditablePlainText(stripUnorderedListMarker(String(line || '').trim()));
}

function mergePartialPipedRow(row, cells) {
    if (!row || !cells || !cells.length) return;
    const first = toEditablePlainText(cells[0]);
    if (first) {
        const lastIndex = Math.max(0, row.length - 1);
        row[lastIndex] = row[lastIndex] ? row[lastIndex] + ' ' + first : first;
    }
    cells.slice(1).forEach((cell) => {
        row.push(toEditablePlainText(cell));
    });
}

function serializeWikiBlocks(blocks) {
    const lines = [];
    (blocks || []).forEach((block, index) => {
        if (index > 0) lines.push('');
        if (block.type === 'hr') {
            lines.push('---');
        } else if (block.type === 'heading') {
            lines.push('#'.repeat(Math.max(1, Math.min(block.level || 2, 6))) + ' ' + (block.text || '').trim());
        } else if (block.type === 'quote') {
            const quoteLines = String(block.text || '').split('\n').filter((line) => line.trim());
            lines.push(quoteLines.length ? quoteLines.map((line) => '> ' + line.trim()).join('\n') : '> ');
        } else if (block.type === 'code') {
            lines.push('```');
            lines.push(String(block.text || '').replace(/```/g, '` ` `').trim());
            lines.push('```');
        } else if (block.type === 'formula') {
            lines.push('$$');
            lines.push(String(block.text || '').trim());
            lines.push('$$');
        } else if (block.type === 'list') {
            const taskPrefix = block.checked === true ? '[x] ' : block.checked === false ? '[ ] ' : '';
            lines.push('- ' + taskPrefix + (block.text || '').trim());
        } else if (block.type === 'ordered') {
            lines.push((block.number || 1) + '. ' + (block.text || '').trim());
        } else if (block.type === 'table') {
            const headers = block.headers || [];
            lines.push('| ' + headers.map(serializeTableCell).join(' | ') + ' |');
            lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
            (block.rows || []).forEach((row) => {
                lines.push('| ' + headers.map((_, cellIndex) => serializeTableCell(row[cellIndex] || '')).join(' | ') + ' |');
            });
        } else {
            lines.push((block.text || '').trim());
        }
    });
    return lines.join('\n').trim();
}

function serializeTableCell(value) {
    return String(value || '').replace(/\s*\n+\s*/g, ' / ').replace(/\|/g, '／').trim();
}

async function handleWikiBlockTypeChange(event) {
    const type = event.target.value || 'paragraph';
    let target = getActiveWikiBlockTarget();
    if (!target && selectedWikiPageId) {
        const blocks = getBlocks(selectedWikiPageId);
        if (!blocks.length) {
            blocks.push({ type: 'paragraph', text: '' });
        }
        target = { pageId: String(selectedWikiPageId), blockIndex: blocks.length - 1 };
        setActiveWikiBlock(target.pageId, target.blockIndex);
    }
    if (!target) return;
    if (activeBlockEditor && String(activeBlockEditor.pageId) === String(target.pageId) && Number(activeBlockEditor.blockIndex) === Number(target.blockIndex)) {
        const blocks = getBlocks(target.pageId);
        if (blocks[target.blockIndex]) {
            const rawValue = toEditableMarkdownText(activeBlockEditor.textarea?.value || '');
            blocks[target.blockIndex].text = activeBlockEditor.sourceMode
                ? rawValue
                : (rawValue === (activeBlockEditor.originalPlainText || '') ? (activeBlockEditor.originalMarkdown || rawValue) : rawValue);
        }
        activeBlockEditor = null;
        syncWikiSourceModeButton();
    }
    await convertWikiBlockType(target.pageId, target.blockIndex, type);
}

function handleWikiFormatToolbarClick(event) {
    const button = event.target.closest('[data-format-action]');
    if (!button) return;
    event.preventDefault();
    const action = button.dataset.formatAction;
    if (action === 'source-toggle') {
        toggleWikiSourceMode();
        return;
    }
    if (action === 'link') {
        openLinkModal();
        return;
    }
    applyInlineFormat(action);
}

function toggleWikiSourceMode() {
    wikiSourceMode = !wikiSourceMode;
    if (activeBlockEditor) {
        switchActiveBlockEditorSourceMode(activeBlockEditor, wikiSourceMode);
    }
    syncWikiSourceModeButton();
}

function syncWikiSourceModeButton() {
    const button = document.querySelector('[data-format-action="source-toggle"]');
    if (!button) return;
    const active = activeBlockEditor ? activeBlockEditor.sourceMode === true : wikiSourceMode === true;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
}

function switchActiveBlockEditorSourceMode(editor, sourceMode) {
    if (!editor || !editor.textarea || editor.sourceMode === sourceMode) return;
    const textarea = editor.textarea;
    if (sourceMode) {
        const current = toEditableMarkdownText(textarea.value || '');
        textarea.value = current === (editor.originalPlainText || '') ? (editor.originalMarkdown || current) : current;
        editor.sourceMode = true;
    } else {
        textarea.value = toEditableDisplayText(textarea.value || '');
        editor.sourceMode = false;
    }
    autosizeBlockEditor(textarea);
    updateWikiLinkInsertionFromEditor();
}

function setActiveWikiBlock(pageId, blockIndex) {
    const blocks = getBlocks(pageId);
    const index = Number(blockIndex);
    if (!blocks[index]) return;
    activeWikiBlockTarget = { pageId: String(pageId), blockIndex: index };
    document.querySelectorAll('.wiki-block.is-active').forEach((el) => el.classList.remove('is-active'));
    const blockEl = document.querySelector('[data-page-id="' + pageId + '"][data-block-index="' + index + '"]');
    if (blockEl) blockEl.classList.add('is-active');
    syncWikiBlockTypeControl(blocks[index]);
}

function getActiveWikiBlockTarget() {
    if (activeBlockEditor) {
        return { pageId: activeBlockEditor.pageId, blockIndex: activeBlockEditor.blockIndex };
    }
    if (activeWikiBlockTarget) {
        const blocks = getBlocks(activeWikiBlockTarget.pageId);
        if (blocks[activeWikiBlockTarget.blockIndex]) return activeWikiBlockTarget;
    }
    return null;
}

function syncWikiBlockTypeControl(block) {
    const select = document.getElementById('wiki-block-type-select');
    if (!select || !block) return;
    select.value = wikiBlockTypeValue(block);
}

function wikiBlockTypeValue(block) {
    if (!block) return 'paragraph';
    if (block.type === 'heading') return 'h' + Math.max(1, Math.min(block.level || 2, 3));
    if (block.type === 'list') return block.checked === true || block.checked === false ? 'task' : 'list';
    if (block.type === 'ordered') return 'ordered';
    if (block.type === 'quote') return 'quote';
    if (block.type === 'table') return 'table';
    if (block.type === 'code') return 'code';
    if (block.type === 'formula') return 'formula';
    return 'paragraph';
}

async function convertWikiBlockType(pageId, blockIndex, type) {
    const blocks = getBlocks(pageId);
    const block = blocks[blockIndex];
    if (!block) return;
    if (type === 'reference') {
        setActiveWikiBlock(pageId, blockIndex);
        openLinkModal();
        syncWikiBlockTypeControl(block);
        return;
    }
    const text = wikiBlockTextForConversion(block);
    blocks[blockIndex] = createWikiBlockByType(type, text);
    await persistBlocks(pageId, true);
    setActiveWikiBlock(pageId, blockIndex);
    if (type !== 'table') {
        startBlockEditor(pageId, blockIndex);
    }
}

function wikiBlockTextForConversion(block) {
    if (!block) return '';
    if (block.type === 'table') {
        const firstRow = block.rows && block.rows[0] ? block.rows[0] : [];
        return toEditableMarkdownText((block.headers || []).concat(firstRow).filter(Boolean).join(' '));
    }
    return toEditableMarkdownText(block.text || '');
}

function createWikiBlockByType(type, text) {
    const value = toEditableMarkdownText(text || '');
    if (type === 'h1' || type === 'h2' || type === 'h3') {
        return { type: 'heading', level: Number(type.slice(1)), text: value || '新标题' };
    }
    if (type === 'quote') return { type: 'quote', text: value || '引用内容' };
    if (type === 'list') return { type: 'list', checked: null, text: value || '列表项' };
    if (type === 'ordered') return { type: 'ordered', number: 1, text: value || '列表项' };
    if (type === 'task') return { type: 'list', checked: false, text: value || '待办事项' };
    if (type === 'table') {
        return {
            type: 'table',
            headers: ['项目', '内容', '说明'],
            rows: [
                ['', '', ''],
                ['', '', '']
            ]
        };
    }
    if (type === 'code') return { type: 'code', text: value || 'console.log("Hello, Wiki");' };
    if (type === 'formula') return { type: 'formula', text: value || 'x^2 + y^2 = z^2' };
    return { type: 'paragraph', text: value };
}

function applyInlineFormat(action) {
    if (activeBlockEditor && activeBlockEditor.sourceMode !== true && activeBlockEditor.textarea) {
        applyInlineFormatToPlainEditor(action, activeBlockEditor);
        return;
    }
    const textarea = ensureActiveWikiTextEditor(true);
    if (!textarea) return;
    const start = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
    const end = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : start;
    const rangeStart = Math.min(start, end);
    const rangeEnd = Math.max(start, end);
    const selected = textarea.value.slice(rangeStart, rangeEnd);
    const fallback = inlineFormatPlaceholder(action);
    const inner = selected || fallback;
    const wrapped = wrapInlineMarkdown(action, inner);
    textarea.value = textarea.value.slice(0, rangeStart) + wrapped + textarea.value.slice(rangeEnd);
    const innerStart = rangeStart + inlineFormatPrefix(action).length;
    const innerEnd = innerStart + inner.length;
    textarea.focus();
    textarea.setSelectionRange(selected ? rangeStart + wrapped.length : innerStart, selected ? rangeStart + wrapped.length : innerEnd);
    autosizeBlockEditor(textarea);
    updateWikiLinkInsertionFromEditor();
}

async function applyInlineFormatToPlainEditor(action, editor) {
    const textarea = editor.textarea;
    const start = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
    const end = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : start;
    const rangeStart = Math.min(start, end);
    const rangeEnd = Math.max(start, end);
    const selected = textarea.value.slice(rangeStart, rangeEnd);
    if (!selected) {
        switchActiveBlockEditorSourceMode(editor, true);
        applyInlineFormat(action);
        return;
    }
    const wrapped = wrapInlineMarkdown(action, selected);
    const blocks = getBlocks(editor.pageId);
    if (blocks[editor.blockIndex]) {
        blocks[editor.blockIndex].text = textarea.value.slice(0, rangeStart) + wrapped + textarea.value.slice(rangeEnd);
    }
    activeBlockEditor = null;
    syncWikiSourceModeButton();
    await persistBlocks(editor.pageId, true);
    setActiveWikiBlock(editor.pageId, editor.blockIndex);
}

function ensureActiveWikiTextEditor(forceSourceMode) {
    let target = getActiveWikiBlockTarget();
    if (!target && selectedWikiPageId) {
        const blocks = getBlocks(selectedWikiPageId);
        if (!blocks.length) blocks.push({ type: 'paragraph', text: '' });
        target = { pageId: String(selectedWikiPageId), blockIndex: blocks.length - 1 };
    }
    if (!target) return null;
    const block = getBlocks(target.pageId)[target.blockIndex];
    if (!block || block.type === 'table' || block.type === 'hr') {
        showToast('表格和分割线不支持行内格式，请直接编辑单元格或切换为正文块', 'warning');
        return null;
    }
    if (!activeBlockEditor || String(activeBlockEditor.pageId) !== String(target.pageId) || Number(activeBlockEditor.blockIndex) !== Number(target.blockIndex)) {
        startBlockEditor(target.pageId, target.blockIndex);
    }
    if (forceSourceMode && activeBlockEditor && activeBlockEditor.sourceMode !== true) {
        switchActiveBlockEditorSourceMode(activeBlockEditor, true);
    }
    return activeBlockEditor?.textarea || null;
}

function inlineFormatPlaceholder(action) {
    if (action === 'inline-code') return '代码';
    if (action === 'underline') return '下划线文本';
    if (action === 'italic') return '斜体文本';
    return '加粗文本';
}

function inlineFormatPrefix(action) {
    if (action === 'bold') return '**';
    if (action === 'italic') return '*';
    if (action === 'underline') return '<u>';
    if (action === 'inline-code') return '`';
    return '';
}

function wrapInlineMarkdown(action, text) {
    if (action === 'bold') return '**' + text + '**';
    if (action === 'italic') return '*' + text + '*';
    if (action === 'underline') return '<u>' + text + '</u>';
    if (action === 'inline-code') return '`' + text.replace(/`/g, '') + '`';
    return text;
}

async function handleBlockAction(button) {
    const pageId = button.dataset.pageId;
    const blockIndex = Number(button.dataset.blockIndex);
    const action = button.dataset.blockAction;
    if (action === 'add') {
        addBlockToPage(pageId);
        return;
    }
    if (action === 'add-after') {
        addBlockToPage(pageId, blockIndex + 1);
        return;
    }
    if (action === 'delete') {
        await deleteBlock(pageId, blockIndex);
        return;
    }
    if (action === 'add-row') {
        addTableRow(pageId, blockIndex);
        return;
    }
    if (action === 'delete-row') {
        await deleteTableRow(pageId, blockIndex, Number(button.dataset.rowIndex));
    }
}

function addBlockToPage(pageId, insertIndex) {
    const blocks = getBlocks(pageId);
    const index = insertIndex == null ? blocks.length : Math.max(0, Math.min(Number(insertIndex), blocks.length));
    blocks.splice(index, 0, { type: 'paragraph', text: '' });
    renderPageBlocks(pageId);
    startBlockEditor(pageId, index);
}

async function deleteBlock(pageId, blockIndex) {
    const blocks = getBlocks(pageId);
    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    blocks.splice(blockIndex, 1);
    await persistBlocks(pageId, true);
}

function addTableRow(pageId, blockIndex) {
    const blocks = getBlocks(pageId);
    const block = blocks[blockIndex];
    if (!block || block.type !== 'table') return;
    block.rows = block.rows || [];
    block.rows.push((block.headers || []).map(() => ''));
    renderPageBlocks(pageId);
}

async function deleteTableRow(pageId, blockIndex, rowIndex) {
    const blocks = getBlocks(pageId);
    const block = blocks[blockIndex];
    if (!block || block.type !== 'table') return;
    block.rows.splice(rowIndex, 1);
    await persistBlocks(pageId, true);
}

function startBlockEditor(pageId, blockIndex, triggerEvent) {
    if (activeBlockEditor) {
        if (String(activeBlockEditor.pageId) === String(pageId) && Number(activeBlockEditor.blockIndex) === Number(blockIndex)) {
            return;
        }
        pendingBlockEditorTarget = {
            pageId: String(pageId),
            blockIndex: Number(blockIndex),
            triggerEvent
        };
        saveBlockEditor();
        return;
    }
    const blocks = getBlocks(pageId);
    const block = blocks[Number(blockIndex)];
    if (!block || block.type === 'table' || block.type === 'hr') return;
    setActiveWikiBlock(pageId, blockIndex);
    const el = document.querySelector('[data-page-id="' + pageId + '"][data-block-index="' + blockIndex + '"]');
    if (!el) return;
    const textEl = el.querySelector('.wiki-block-text');
    if (!textEl) return;
    const originalMarkdown = toEditableMarkdownText(block.text || '');
    const displayText = wikiSourceMode ? originalMarkdown : toEditableDisplayText(originalMarkdown);
    const caretOffset = getCaretOffsetFromClick(textEl, triggerEvent, displayText.length);
    const textarea = document.createElement('textarea');
    textarea.className = 'wiki-block-inline-editor';
    textarea.rows = 1;
    textarea.spellcheck = true;
    textarea.value = displayText;
    applyBlockEditorTypography(textarea, textEl);
    el.classList.add('is-editing');
    textEl.replaceWith(textarea);
    const editorState = {
        pageId: String(pageId),
        blockIndex: Number(blockIndex),
        el,
        textarea,
        sourceMode: wikiSourceMode === true,
        originalMarkdown,
        originalPlainText: toEditableDisplayText(originalMarkdown),
        saving: false,
        cancelled: false
    };
    activeBlockEditor = editorState;
    syncWikiSourceModeButton();
    textarea.focus();
    const safeOffset = Math.max(0, Math.min(caretOffset, textarea.value.length));
    textarea.setSelectionRange(safeOffset, safeOffset);
    updateWikiLinkInsertionFromEditor();
    autosizeBlockEditor(textarea);
    textarea.addEventListener('input', () => {
        autosizeBlockEditor(textarea);
        updateWikiLinkInsertionFromEditor();
    });
    textarea.addEventListener('keyup', updateWikiLinkInsertionFromEditor);
    textarea.addEventListener('mouseup', updateWikiLinkInsertionFromEditor);
    textarea.addEventListener('select', updateWikiLinkInsertionFromEditor);
    textarea.addEventListener('blur', () => saveBlockEditor(editorState));
    textarea.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelBlockEditor();
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            saveBlockEditor();
        }
    });
}

function applyBlockEditorTypography(textarea, sourceEl) {
    if (!textarea || !sourceEl || !window.getComputedStyle) return;
    const style = window.getComputedStyle(sourceEl);
    const rect = sourceEl.getBoundingClientRect();
    const minHeight = Math.max(rect.height || 0, parseFloat(style.lineHeight) || 28, 28);
    textarea.setAttribute('aria-label', '编辑知识正文');
    textarea.dataset.minHeight = String(minHeight);
    textarea.style.fontFamily = style.fontFamily;
    textarea.style.fontSize = style.fontSize;
    textarea.style.fontWeight = style.fontWeight;
    textarea.style.fontStyle = style.fontStyle;
    textarea.style.lineHeight = style.lineHeight;
    textarea.style.letterSpacing = style.letterSpacing;
    textarea.style.textAlign = style.textAlign;
    textarea.style.margin = style.margin;
    textarea.style.width = rect.width ? rect.width + 'px' : style.width;
    textarea.style.maxWidth = '100%';
    textarea.style.minHeight = minHeight + 'px';
    textarea.style.boxSizing = 'border-box';
}

function captureWikiLinkInsertion() {
    updateWikiLinkInsertionFromEditor();
    if (wikiLinkInsertion && wikiLinkInsertion.pageId) {
        return wikiLinkInsertion;
    }
    const target = getActiveWikiBlockTarget();
    if (target) {
        const blocks = getBlocks(target.pageId);
        const block = blocks[target.blockIndex];
        if (block && block.type !== 'table' && block.type !== 'hr') {
            const text = toEditableMarkdownText(block.text || '');
            wikiLinkInsertion = {
                pageId: String(target.pageId),
                blockIndex: Number(target.blockIndex),
                start: text.length,
                end: text.length,
                selectedText: ''
            };
            return wikiLinkInsertion;
        }
    }
    const blocks = getBlocks(selectedWikiPageId);
    if (!blocks.length) {
        blocks.push({ type: 'paragraph', text: '' });
    }
    const blockIndex = Math.max(0, blocks.length - 1);
    const text = toEditableMarkdownText(blocks[blockIndex]?.text || '');
    wikiLinkInsertion = {
        pageId: String(selectedWikiPageId),
        blockIndex,
        start: text.length,
        end: text.length,
        selectedText: ''
    };
    return wikiLinkInsertion;
}

function updateWikiLinkInsertionFromEditor() {
    const editor = activeBlockEditor;
    if (!editor || !editor.textarea) return;
    const textarea = editor.textarea;
    const start = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
    const end = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : start;
    wikiLinkInsertion = {
        pageId: editor.pageId,
        blockIndex: editor.blockIndex,
        start,
        end,
        selectedText: textarea.value.slice(Math.min(start, end), Math.max(start, end)).trim(),
        plainMode: editor.sourceMode !== true
    };
}

function cancelBlockEditor() {
    const editor = activeBlockEditor;
    if (!editor) return;
    pendingBlockEditorTarget = null;
    editor.cancelled = true;
    const { pageId } = editor;
    activeBlockEditor = null;
    syncWikiSourceModeButton();
    renderPageBlocks(pageId);
}

async function saveBlockEditor(editorRef) {
    const editor = editorRef || activeBlockEditor;
    if (editorRef && activeBlockEditor !== editor && !editor.saving) {
        return editor.savePromise || Promise.resolve();
    }
    if (!editor || editor.cancelled) {
        if (!editorRef) openPendingBlockEditor();
        return;
    }
    if (editor.saving) return editor.savePromise || Promise.resolve();
    editor.saving = true;
    editor.savePromise = (async () => {
        const { pageId, blockIndex, el, textarea } = editor;
        const input = textarea || el.querySelector('.wiki-block-inline-editor') || el.querySelector('.wiki-block-editor');
        const rawValue = toEditableMarkdownText(input?.value || '');
        const value = editor.sourceMode
            ? rawValue
            : (rawValue === (editor.originalPlainText || '') ? (editor.originalMarkdown || rawValue) : rawValue);
        const blocks = getBlocks(pageId);
        if (blocks[blockIndex]) blocks[blockIndex].text = value;
        if (activeBlockEditor === editor) {
            activeBlockEditor = null;
            syncWikiSourceModeButton();
        }
        if (!value) {
            blocks.splice(blockIndex, 1);
            if (pendingBlockEditorTarget
                && String(pendingBlockEditorTarget.pageId) === String(pageId)
                && Number(pendingBlockEditorTarget.blockIndex) > Number(blockIndex)) {
                pendingBlockEditorTarget.blockIndex -= 1;
            }
        }
        await persistBlocks(pageId, true);
        if (!activeBlockEditor) {
            openPendingBlockEditor();
        }
    })();
    return editor.savePromise;
}

function openPendingBlockEditor() {
    const target = pendingBlockEditorTarget;
    pendingBlockEditorTarget = null;
    if (!target) return;
    const blocks = getBlocks(target.pageId);
    const index = Math.max(0, Math.min(Number(target.blockIndex), blocks.length - 1));
    if (blocks[index]) {
        startBlockEditor(target.pageId, index, target.triggerEvent);
    }
}

function autosizeBlockEditor(textarea) {
    if (!textarea) return;
    const minHeight = Number(textarea.dataset.minHeight) || 28;
    textarea.style.height = 'auto';
    textarea.style.height = Math.max(minHeight, textarea.scrollHeight) + 'px';
}

function getCaretOffsetFromClick(textEl, event, fallbackOffset) {
    if (!textEl || !event || typeof event.clientX !== 'number') return fallbackOffset;
    let node = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
        const position = document.caretPositionFromPoint(event.clientX, event.clientY);
        if (position) {
            node = position.offsetNode;
            offset = position.offset;
        }
    } else if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(event.clientX, event.clientY);
        if (range) {
            node = range.startContainer;
            offset = range.startOffset;
        }
    }
    if (!node || !textEl.contains(node)) return fallbackOffset;
    return clampTextOffset(resolveTextOffset(textEl, node, offset), fallbackOffset);
}

function resolveTextOffset(root, targetNode, targetOffset) {
    if (targetNode.nodeType === Node.TEXT_NODE) {
        return countTextBefore(root, targetNode) + targetOffset;
    }
    const childNodes = Array.from(targetNode.childNodes || []);
    let total = countTextBefore(root, targetNode);
    for (let i = 0; i < Math.min(targetOffset, childNodes.length); i++) {
        total += (childNodes[i].textContent || '').length;
    }
    return total;
}

function countTextBefore(root, targetNode) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0;
    while (walker.nextNode()) {
        const current = walker.currentNode;
        if (current === targetNode || current.parentNode === targetNode) break;
        total += (current.nodeValue || '').length;
    }
    return total;
}

function clampTextOffset(offset, fallbackOffset) {
    const safeFallback = Number.isFinite(fallbackOffset) ? fallbackOffset : 0;
    if (!Number.isFinite(offset)) return safeFallback;
    return Math.max(0, Math.min(offset, safeFallback));
}

async function handleDocumentFocusOut(event) {
    const cell = event.target.closest('[data-table-cell]');
    if (!cell) return;
    const pageId = cell.dataset.pageId;
    const blockIndex = Number(cell.dataset.blockIndex);
    const rowIndex = Number(cell.dataset.rowIndex);
    const cellIndex = Number(cell.dataset.cellIndex);
    const blocks = getBlocks(pageId);
    const block = blocks[blockIndex];
    if (!block || block.type !== 'table') return;
    const value = toEditableMarkdownText(cell.innerText || '');
    if (rowIndex < 0) {
        block.headers[cellIndex] = value;
    } else {
        block.rows[rowIndex][cellIndex] = value;
    }
    await persistBlocks(pageId, false);
}

function getBlocks(pageId) {
    const key = String(pageId);
    if (!wikiBlockCache.has(key)) {
        const node = findNode(pageId);
        wikiBlockCache.set(key, parseWikiBlocks(node ? node.content || '' : ''));
    }
    return wikiBlockCache.get(key);
}

async function persistBlocks(pageId, rerender) {
    const node = findNode(pageId);
    if (!node) return;
    const blocks = getBlocks(pageId);
    const content = serializeWikiBlocks(blocks);
    const safeContent = content || EMPTY_WIKI_CONTENT;
    node.content = content;
    try {
        await api.put('/knowledge/pages/' + pageId, {
            title: node.title || 'Untitled',
            content: safeContent,
            pageType: node.pageType || 'NOTE',
            parentId: node.parentId || null,
            sortOrder: node.sortOrder || 0,
            pinned: node.pinned === true
        });
    } catch (error) {
        showToast(error.message || '知识页保存失败', 'error');
        return;
    }
    if (rerender) renderPageBlocks(pageId);
}

function renderPageBlocks(pageId) {
    const node = findNode(pageId);
    const article = document.querySelector('[data-page-id="' + pageId + '"]');
    const content = article?.querySelector('.wiki-doc-content');
    if (!node || !content) return;
    content.innerHTML = renderWikiBlocks(node);
    if (activeWikiBlockTarget && String(activeWikiBlockTarget.pageId) === String(pageId)) {
        setActiveWikiBlock(activeWikiBlockTarget.pageId, activeWikiBlockTarget.blockIndex);
    }
}

function startTitleEditor(id) {
    if (activeBlockEditor) cancelBlockEditor();
    if (activeTitleEditor) {
        cancelTitleEditor();
    }
    const node = findNode(id);
    const titleEl = document.querySelector('[data-title-id="' + id + '"]');
    if (!node || !titleEl) return;
    const input = document.createElement('input');
    input.className = 'wiki-title-editor';
    input.value = node.title || '';
    input.maxLength = 120;
    input.setAttribute('aria-label', '知识页标题');
    titleEl.replaceWith(input);
    activeTitleEditor = {
        id: String(id),
        original: node.title || '',
        levelTag: titleEl.tagName.toLowerCase(),
        elementId: titleEl.id || '',
        className: titleEl.className || 'wiki-doc-title',
        input
    };
    input.focus();
    input.select();
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            saveTitleEditor();
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelTitleEditor();
        }
    });
    input.addEventListener('blur', () => saveTitleEditor());
}

async function saveTitleEditor() {
    const editor = activeTitleEditor;
    if (!editor) return;
    const title = editor.input.value.trim();
    if (!title) {
        showToast('标题不能为空', 'warning');
        editor.input.focus();
        return;
    }
    activeTitleEditor = null;
    const previousTitle = editor.original;
    if (title === previousTitle) {
        replaceTitleEditorInput(editor, previousTitle || '未命名');
        return;
    }
    replaceTitleEditorInput(editor, title);
    updateCachedNodeTitle(editor.id, title);
    updateSidebarTitle(editor.id, title);
    const node = findNode(editor.id);
    try {
        const content = node?.content || serializeWikiBlocks(getBlocks(editor.id)) || EMPTY_WIKI_CONTENT;
        await api.put('/knowledge/pages/' + editor.id, {
            title,
            content,
            pageType: node?.pageType || 'NOTE',
            parentId: node?.parentId || null,
            sortOrder: node?.sortOrder || 0,
            pinned: node?.pinned === true
        });
        showToast('标题已保存', 'success');
    } catch (error) {
        updateCachedNodeTitle(editor.id, previousTitle);
        updateSidebarTitle(editor.id, previousTitle);
        const titleEl = document.querySelector('[data-title-id="' + editor.id + '"]');
        if (titleEl) titleEl.textContent = previousTitle || '未命名';
        showToast('标题保存失败，请稍后再试', 'error');
    }
}

function cancelTitleEditor() {
    const editor = activeTitleEditor;
    if (!editor) return;
    activeTitleEditor = null;
    replaceTitleEditorInput(editor, editor.original || '未命名');
}

function replaceTitleEditorInput(editor, title) {
    if (!editor?.input?.parentNode) return;
    const titleEl = document.createElement(editor.levelTag || 'h2');
    titleEl.className = editor.className || 'wiki-doc-title';
    if (editor.elementId) titleEl.id = editor.elementId;
    titleEl.dataset.titleId = editor.id;
    titleEl.textContent = title || '未命名';
    editor.input.replaceWith(titleEl);
}

function updateCachedNodeTitle(id, title) {
    const apply = (nodes) => {
        for (const node of nodes || []) {
            if (String(node.id) === String(id)) {
                node.title = title;
                return true;
            }
            if (apply(node.children || [])) return true;
        }
        return false;
    };
    apply(wikiTree);
    wikiFlat = flattenTree(wikiTree);
}

function updateSidebarTitle(id, title) {
    document.querySelectorAll('.wiki-node').forEach((node) => {
        if (String(node.dataset.scrollId) === String(id)) {
            const label = node.querySelector('.wiki-node-title');
            if (label) label.textContent = title || '未命名';
        }
    });
}

function startInlineEditor(id) {
    const node = findNode(id);
    const article = document.querySelector('[data-page-id="' + id + '"]');
    if (!node || !article) return;
    if (activeEditor) {
        cancelInlineEditor();
    }
    article.classList.add('is-editing');
    const content = article.querySelector('.wiki-doc-content');
    const header = article.querySelector('.wiki-doc-header');
    if (content) content.style.display = 'none';
    if (header) header.style.display = 'none';

    const editorWrap = document.createElement('div');
    editorWrap.className = 'wiki-inline-editor';
    editorWrap.innerHTML =
        '<input class="wiki-inline-title" id="wiki-inline-title-' + id + '" maxlength="120">' +
        '<div id="wiki-inline-editor-' + id + '"></div>' +
        '<div class="wiki-inline-actions">' +
        '<button type="button" class="btn btn-default" data-inline-cancel>取消</button>' +
        '<button type="button" class="btn btn-primary" data-inline-save>保存</button>' +
        '</div>';
    article.appendChild(editorWrap);
    const titleInput = editorWrap.querySelector('.wiki-inline-title');
    titleInput.value = node.title || '';
    const vditor = createWikiEditor('#wiki-inline-editor-' + id, {
        mode: 'ir',
        value: cleanMarkdownSource(node.content || ''),
        after: () => vditor.focus()
    });
    activeEditor = { id: Number(id), node, article, editorWrap, vditor };
    editorWrap.querySelector('[data-inline-cancel]').addEventListener('click', cancelInlineEditor);
    editorWrap.querySelector('[data-inline-save]').addEventListener('click', saveInlineEditor);
}

function createWikiEditor(target, options) {
    options = options || {};
    if (window.Vditor) {
        return new window.Vditor(target, options);
    }
    const container = typeof target === 'string' ? document.querySelector(target) : target;
    if (!container) {
        return {
            getValue: () => options.value || '',
            focus: () => undefined,
            destroy: () => undefined
        };
    }
    container.innerHTML = '';
    const textarea = document.createElement('textarea');
    textarea.className = 'wiki-fallback-editor';
    textarea.value = options.value || '';
    container.appendChild(textarea);
    const editor = {
        getValue: () => textarea.value,
        focus: () => textarea.focus(),
        destroy: () => {
            container.innerHTML = '';
        }
    };
    if (typeof options.after === 'function') {
        setTimeout(options.after, 0);
    }
    return editor;
}

function cancelInlineEditor() {
    if (!activeEditor) return;
    const { article, editorWrap, vditor } = activeEditor;
    if (vditor && vditor.destroy) vditor.destroy();
    editorWrap.remove();
    article.classList.remove('is-editing');
    const content = article.querySelector('.wiki-doc-content');
    const header = article.querySelector('.wiki-doc-header');
    if (content) content.style.display = '';
    if (header) header.style.display = '';
    activeEditor = null;
}

async function saveInlineEditor() {
    if (!activeEditor) return;
    const { id, node, article, vditor } = activeEditor;
    const title = article.querySelector('.wiki-inline-title')?.value.trim();
    const content = cleanMarkdownSource(vditor.getValue());
    if (!title || !content) {
        showToast('请填写标题和内容', 'warning');
        return;
    }
    await api.put('/knowledge/pages/' + id, {
        title,
        content,
        pageType: node.pageType || 'NOTE',
        parentId: node.parentId || null,
        sortOrder: node.sortOrder || 0,
        pinned: node.pinned === true
    });
    showToast('知识页已保存', 'success');
    activeEditor = null;
    await loadWiki();
    scrollToNode(id);
}

function openCreateModal(options) {
    options = options || {};
    setValue('wiki-create-revision-id', options.revisionId || '');
    setValue('wiki-create-page-id', options.pageId || '');
    setValue('wiki-create-name', options.title || '');
    setValue('wiki-create-parent', options.parentId || '');
    setValue('wiki-create-type', options.pageType || 'NOTE');
    setValue('wiki-create-content', options.content || '');
    setText('wiki-create-title', options.revisionId ? '编辑 AI 草稿' : '新建知识页');
    renderParentOptions();
    document.getElementById('wikiCreateModal')?.classList.remove('hidden');
    if (window.refreshCustomSelects) window.refreshCustomSelects();
    setTimeout(() => document.getElementById('wiki-create-name')?.focus(), 40);
}

function closeCreateModal() {
    document.getElementById('wikiCreateModal')?.classList.add('hidden');
}

async function submitCreateForm(event) {
    event.preventDefault();
    const title = valueOf('wiki-create-name');
    const content = cleanMarkdownSource(valueOf('wiki-create-content'));
    if (!title || !content) {
        showToast('请填写标题和内容', 'warning');
        return;
    }
    const body = {
        title,
        content,
        pageType: valueOf('wiki-create-type') || 'NOTE',
        parentId: valueOf('wiki-create-parent') || null,
        sortOrder: siblingCount(valueOf('wiki-create-parent') || null) * 10,
        pinned: false
    };
    const revisionId = valueOf('wiki-create-revision-id');
    const pageId = valueOf('wiki-create-page-id');
    let res;
    if (revisionId) {
        body.pageId = pageId || null;
        res = await api.post('/knowledge/revisions/' + revisionId + '/apply', body);
        showToast('AI 草稿已写入 Wiki', 'success');
    } else {
        res = await api.post('/knowledge/pages', body);
        showToast('知识页已创建', 'success');
    }
    closeCreateModal();
    await loadWiki();
    if (res.data && res.data.id) scrollToNode(res.data.id);
}

function renderParentOptions() {
    const select = document.getElementById('wiki-create-parent');
    if (!select) return;
    const currentPageId = valueOf('wiki-create-page-id');
    const selected = select.value;
    select.innerHTML = '<option value="">根节点</option>' + wikiFlat
        .filter((node) => String(node.id) !== String(currentPageId))
        .map((node) => '<option value="' + node.id + '">' + escapeHtml(node.path) + '</option>')
        .join('');
    select.value = selected || '';
    if (window.refreshCustomSelects) window.refreshCustomSelects();
}

function renderRevisions(rows) {
    const box = document.getElementById('wiki-revisions');
    if (!box) return;
    wikiRevisionDrafts = new Map();
    rows = Array.isArray(rows) ? rows : [];
    rows.forEach((row) => wikiRevisionDrafts.set(String(row.id), row));
    box.innerHTML = rows.length ? rows.map((row) => (
        '<div class="wiki-revision-card" data-open-revision="' + row.id + '" tabindex="0" role="button">' +
        '<div class="wiki-revision-title-row">' +
        '<strong>' + escapeHtml(row.title || 'AI Wiki 草稿') + '</strong>' +
        '<span>待确认</span>' +
        '</div>' +
        '<div class="wiki-revision-preview">' + renderWikiMarkdown(limitText(row.content || '', 600)) + '</div>' +
        '<div class="wiki-revision-actions">' +
        '<button type="button" class="btn btn-default btn-sm" data-reject="' + row.id + '">忽略</button>' +
        '<button type="button" class="btn btn-default btn-sm" data-edit-revision="' + row.id + '">载入编辑</button>' +
        '<button type="button" class="btn btn-primary btn-sm" data-approve="' + row.id + '">直接写入</button>' +
        '</div>' +
        '</div>'
    )).join('') : '<div class="wiki-empty-state">暂无 AI 草稿。</div>';

    box.querySelectorAll('[data-open-revision]').forEach((card) => {
        card.addEventListener('click', (event) => {
            if (event.target.closest('button')) return;
            openRevisionDraft(card.dataset.openRevision);
        });
        card.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (event.target.closest('button')) return;
            event.preventDefault();
            openRevisionDraft(card.dataset.openRevision);
        });
    });
    box.querySelectorAll('[data-edit-revision]').forEach((btn) => {
        btn.addEventListener('click', () => {
            openRevisionDraft(btn.dataset.editRevision);
        });
    });
    box.querySelectorAll('[data-approve]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const row = wikiRevisionDrafts.get(String(btn.dataset.approve));
            const res = await api.post('/knowledge/revisions/' + btn.dataset.approve + '/approve', {});
            showToast('已写入知识 Wiki', 'success');
            await loadWiki();
            const pageId = res.data && res.data.pageId;
            if (pageId) {
                scrollToNode(pageId);
            } else if (row && row.title) {
                const node = findNodeByTitle(row.title);
                if (node) scrollToNode(node.id);
            }
        });
    });
    box.querySelectorAll('[data-reject]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            await api.post('/knowledge/revisions/' + btn.dataset.reject + '/reject', {});
            showToast('已忽略建议', 'success');
            await loadWiki();
        });
    });
}

function openRevisionDraft(id) {
    const row = wikiRevisionDrafts.get(String(id));
    if (!row) return;
    openCreateModal({
        revisionId: row.id,
        pageId: row.pageId || '',
        title: row.title || '',
        content: row.content || '',
        pageType: row.pageType || inferRevisionPageType(row)
    });
}

function inferRevisionPageType(row) {
    const source = ((row && row.title) || '') + '\n' + ((row && row.content) || '');
    if (source.includes('目标') || /goal/i.test(source)) return 'GOAL';
    if (source.includes('偏好') || source.includes('习惯') || /preference/i.test(source)) return 'PREFERENCE';
    if (source.includes('项目') || source.includes('计划') || /project|plan/i.test(source)) return 'PROJECT';
    if (source.includes('薄弱') || source.includes('短板') || /weakness/i.test(source)) return 'WEAKNESS';
    if (source.includes('资料') || source.includes('笔记') || /resource|material/i.test(source)) return 'RESOURCE';
    if (source.includes('时间') || source.includes('作息') || source.includes('提醒') || /schedule|deadline|ddl/i.test(source)) return 'PREFERENCE';
    return 'MEMORY';
}

function ensureSelectedWikiPage() {
    if (!wikiFlat.length) {
        selectedWikiPageId = null;
        return null;
    }
    let selected = selectedWikiPageId ? findNode(selectedWikiPageId) : null;
    if (!selected) {
        selected = wikiTree[0] || wikiFlat[0];
        selectedWikiPageId = selected ? String(selected.id) : null;
        selected = selectedWikiPageId ? findNode(selectedWikiPageId) : null;
    }
    return selected;
}

function selectWikiPage(id, options) {
    options = options || {};
    const node = findNode(id) || ensureSelectedWikiPage();
    if (!node) return;
    if (activeBlockEditor) cancelBlockEditor();
    if (activeTitleEditor) cancelTitleEditor();
    if (activeEditor) cancelInlineEditor();
    selectedWikiPageId = String(node.id);
    wikiContentVisible = true;
    renderWikiTree();
    renderDocument();
    const documentBox = document.getElementById('wiki-document');
    if (documentBox && options.keepScroll !== true) {
        documentBox.scrollTop = 0;
    }
}

function syncWikiWorkspaceState() {
    const workspace = document.querySelector('.wiki-workspace');
    if (!workspace) return;
    workspace.classList.toggle('wiki-content-collapsed', !wikiContentVisible);
    workspace.classList.toggle('wiki-inspector-collapsed', !wikiInspectorVisible);
    setText('btn-toggle-inspector', wikiInspectorVisible ? '收起' : '展开');
}

async function moveNode(node, direction) {
    const siblings = wikiFlat.filter((item) => String(item.parentId || '') === String(node.parentId || ''));
    const index = siblings.findIndex((item) => String(item.id) === String(node.id));
    if (index < 0) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= siblings.length) {
        showToast(direction === 'up' ? '已经在最上面' : '已经在最下面', 'info');
        return;
    }
    await api.put('/knowledge/pages/' + node.id + '/move', {
        parentId: node.parentId || null,
        sortOrder: targetIndex
    });
    await loadWiki();
    scrollToNode(node.id);
}

function flattenTree(nodes, level, pathPrefix) {
    const result = [];
    level = level || 1;
    (nodes || []).forEach((node, index) => {
        const prefix = displayPrefix(level, index);
        const path = pathPrefix ? pathPrefix + ' / ' + (prefix ? prefix + ' ' : '') + node.title : (prefix ? prefix + ' ' : '') + node.title;
        const row = { ...node, level, prefix, path, siblingIndex: index };
        result.push(row);
        result.push(...flattenTree(node.children || [], level + 1, path));
    });
    return result;
}

function findNode(id) {
    return wikiFlat.find((node) => String(node.id) === String(id));
}

function findNodeByTitle(title) {
    const normalized = String(title || '').trim();
    if (!normalized) return null;
    return wikiFlat.find((node) => String(node.title || '').trim() === normalized) || null;
}

function siblingCount(parentId) {
    return wikiFlat.filter((node) => String(node.parentId || '') === String(parentId || '')).length;
}

function scrollToNode(id) {
    selectWikiPage(id, { keepScroll: false });
    const target = document.getElementById('wiki-page-' + id);
    if (!target) {
        if (typeof showToast === 'function') {
            showToast('没有找到这个知识页，请刷新 Wiki 后再试', 'warning');
        }
        return;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function displayPrefix(level, index) {
    if (level <= 1) return '';
    if (level === 2) return circledNumber(index + 1);
    if (level === 3) return '·';
    return (index + 1) + '.';
}

function circledNumber(value) {
    const symbols = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];
    return symbols[value - 1] || value + '.';
}

function typeLabel(type) {
    const map = {
        GOAL: '目标',
        PREFERENCE: '偏好',
        PROJECT: '计划',
        WEAKNESS: '薄弱点',
        SCHEDULE: '计划',
        REMINDER: '偏好',
        RESOURCE: '资料',
        MATERIAL: '资料',
        MEMORY: '对话摘要',
        INDEX: 'index',
        LOG: 'log',
        SCHEMA: '规则',
        NOTE: '备注'
    };
    return map[String(type || '').toUpperCase()] || '备注';
}

function renderWikiMarkdown(markdown) {
    const html = renderMarkdownBlocks(canonicalizeWikiModelMarkdown(normalizeLooseWikiMarkdown(cleanMarkdownSource(markdown))));
    return sanitizeWikiHtml(html);
}

function normalizeLooseWikiMarkdown(markdown) {
    const text = String(markdown || '').replace(/\r\n?/g, '\n');
    const parts = text.split(/(```[\s\S]*?```)/g);
    const normalized = parts.map((part) => {
        if (/^```[\s\S]*```$/.test(part)) return part;
        return normalizeLooseWikiMarkdownPart(part);
    }).join('');
    return splitLooseTableTitleLines(normalized).trim();
}

function canonicalizeWikiModelMarkdown(markdown) {
    const lines = String(markdown || '').split('\n');
    const output = [];
    let inCode = false;
    for (let i = 0; i < lines.length;) {
        const line = String(lines[i] || '');
        if (/^```/.test(line.trim())) {
            inCode = !inCode;
            output.push(line);
            i++;
            continue;
        }
        if (inCode) {
            output.push(line);
            i++;
            continue;
        }

        const table = readModelMarkdownTableBlock(lines, i);
        if (table) {
            if (output.length && output[output.length - 1].trim()) output.push('');
            output.push(...serializeWikiModelMarkdownTable(table));
            output.push('');
            i = table.next;
            continue;
        }

        output.push(line);
        i++;
    }
    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function serializeWikiModelMarkdownTable(table) {
    const headers = table.headers || [];
    const rows = table.rows || [];
    if (!headers.length || !rows.length) return [];
    const lines = [];
    lines.push('| ' + headers.map(serializeWikiModelMarkdownTableCell).join(' | ') + ' |');
    lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
    rows.forEach((row) => {
        lines.push('| ' + headers.map((_, index) => serializeWikiModelMarkdownTableCell(row[index] || '')).join(' | ') + ' |');
    });
    return lines;
}

function serializeWikiModelMarkdownTableCell(value) {
    return String(value || '')
        .replace(/\s*\n+\s*/g, '<br>')
        .replace(/\|/g, '／')
        .replace(/\s{2,}/g, ' ')
        .trim() || ' ';
}

function splitLooseTableTitleLines(text) {
    return String(text || '')
        .replace(/([^\n|]{2,80}?)\s+\|\s*((?:\u4efb\u52a1|\u79d1\u76ee)\s*\|\s*(?:\u65f6\u95f4|\u4efb\u52a1)\s*\|[^\n]+)/g, '$1\n| $2');
}

function normalizeLooseWikiMarkdownPart(text) {
    return String(text || '')
        .replace(/(^|\n)\s*(?:\*\*|__)\s*(?=\n|$)/g, '$1')
        .replace(/([：:])\s*(?:\*\*|__)\s*(?=\n|$)/g, '$1')
        .replace(/^\s*\*\*\s+(?=[-+*•·])/g, '')
        .replace(/(^|\n)\s*\*\*\s+([-+*•·]\s*)/g, '$1$2')
        .replace(/([^\n])\s+([-+*]\s*(?=\*\*|[\u4e00-\u9fffA-Za-z0-9`【《（(]))/g, '$1\n$2')
        .replace(/([^\n])\s+([•·]\s*(?=\*\*|[\u4e00-\u9fffA-Za-z0-9`【《（(]))/g, '$1\n$2')
        .replace(/([^\n])\s+(\d{1,2}[.)]\s+(?=[\u4e00-\u9fffA-Za-z`【《（(]))/g, '$1\n$2')
        .replace(/(^|\n)\s*([-+*])(?=\*\*|[\u4e00-\u9fffA-Za-z0-9`【《（(])/g, '$1$2 ');
}

function sanitizeWikiHtml(html) {
    if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
        return window.DOMPurify.sanitize(html);
    }
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    const allowedTags = new Set('A ABBR B BLOCKQUOTE BR CODE DEL DIV EM H1 H2 H3 H4 H5 H6 HR I INPUT KBD LI OL P PRE S SPAN STRONG SUB SUP TABLE TBODY TD TH THEAD TR U UL'.split(' '));
    const allowedAttrs = new Set('href target rel class id title type checked disabled aria-label aria-hidden'.split(' '));
    template.content.querySelectorAll('*').forEach((node) => {
        if (!allowedTags.has(node.tagName)) {
            node.replaceWith(document.createTextNode(node.textContent || ''));
            return;
        }
        Array.from(node.attributes).forEach((attr) => {
            const name = attr.name.toLowerCase();
            const value = attr.value || '';
            if (!allowedAttrs.has(name) && !name.startsWith('aria-')) {
                node.removeAttribute(attr.name);
                return;
            }
            if (name === 'href' && !/^https?:\/\//i.test(value)) {
                node.removeAttribute(attr.name);
            }
        });
    });
    return template.innerHTML;
}

function cleanMarkdownSource(value) {
    let text = String(value == null ? '' : value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (text.startsWith('```')) {
        text = text.replace(/^```[A-Za-z0-9_-]*\s*/, '').replace(/\s*```$/, '').trim();
    }
    return text.split('\n').filter((line) => {
        const compact = line.replace(/\s+/g, '');
        const emptyHeading = /^#{1,6}\s*$/.test(line.trim());
        const wikiConfirmation = /(已将|已经|已存入|已写入)/.test(compact) && /(wiki|知识库|知识树)/i.test(compact);
        return !emptyHeading && !wikiConfirmation;
    }).join('\n').trim();
}

function renderMarkdownBlocks(text) {
    const lines = String(text || '').split('\n');
    const html = [];
    for (let i = 0; i < lines.length;) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) {
            i++;
            continue;
        }
        if (isEmptyWikiContentLine(trimmed)) {
            i++;
            continue;
        }
        if (/^```/.test(trimmed)) {
            const code = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
            if (i < lines.length) i++;
            html.push('<pre class="wiki-code-block"><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
            continue;
        }
        if (trimmed === '$$') {
            const formula = [];
            i++;
            while (i < lines.length && lines[i].trim() !== '$$') formula.push(lines[i++]);
            if (i < lines.length) i++;
            html.push(renderMath(formula.join('\n'), true));
            continue;
        }
        if (/^[-*_]{2,}$/.test(trimmed)) {
            html.push('<hr>');
            i++;
            continue;
        }
        const modelTable = readModelMarkdownTableBlock(lines, i);
        if (modelTable) {
            html.push(renderWikiTable(modelTable.headers, modelTable.rows));
            i = modelTable.next;
            continue;
        }
        if (isTableStart(lines, i)) {
            const table = readMarkdownTable(lines, i);
            html.push(table.html);
            i = table.next;
            continue;
        }
        const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            const level = heading[1].length;
            html.push('<h' + level + '>' + renderInlineMarkdown(heading[2]) + '</h' + level + '>');
            i++;
            continue;
        }
        if (/^>\s?/.test(trimmed)) {
            const quote = [];
            while (i < lines.length && /^>\s?/.test(lines[i].trim())) quote.push(lines[i++].trim().replace(/^>\s?/, ''));
            html.push('<blockquote>' + renderInlineMarkdown(quote.join('\n')) + '</blockquote>');
            continue;
        }
        if (isUnorderedListLine(trimmed)) {
            const items = [];
            while (i < lines.length && isUnorderedListLine(lines[i].trim())) {
                items.push(parseTaskListMarker(stripUnorderedListMarker(lines[i++].trim())));
            }
            html.push('<ul>' + items.map(renderListItem).join('') + '</ul>');
            continue;
        }
        if (isBareTaskListLine(trimmed)) {
            const items = [];
            while (i < lines.length && isBareTaskListLine(lines[i].trim())) {
                items.push(parseTaskListMarker(lines[i++].trim()));
            }
            html.push('<ul>' + items.map(renderListItem).join('') + '</ul>');
            continue;
        }
        if (/^\d+[.)]\s+/.test(trimmed)) {
            const items = [];
            while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
                items.push(lines[i++].trim().replace(/^\d+[.)]\s+/, ''));
            }
            html.push('<ol>' + items.map(renderListItem).join('') + '</ol>');
            continue;
        }
        const paragraph = [trimmed];
        i++;
        while (i < lines.length && shouldContinueParagraph(lines[i])) {
            paragraph.push(lines[i].trim());
            i++;
        }
        html.push('<p>' + paragraph.map(renderInlineMarkdown).join('<br>') + '</p>');
    }
    return html.join('');
}

function isUnorderedListLine(line) {
    const trimmed = String(line || '').trim();
    if (/^[-*_]{2,}$/.test(trimmed)) return false;
    return /^[-*+]\s+/.test(trimmed)
        || /^[-*+][\u4e00-\u9fffA-Za-z0-9`【《（(]/.test(trimmed)
        || /^[•·]\s*/.test(trimmed);
}

function isBareTaskListLine(line) {
    return /^\[[ xX]\]\s+/.test(String(line || '').trim());
}

function readBareTaskContinuation(lines, startIndex) {
    const value = String(lines[startIndex] || '').trim();
    if (!value || value.length > 40) return null;
    if (isBareTaskListLine(value) || isUnorderedListLine(value)) return null;
    if (/^(#{1,6}\s+|[-*_]{2,}|周[一二三四五六日天]|第[一二三四五六七八九十]+阶段|防崩盘规则|底线目标)/.test(value)) return null;
    if (hasLooseTableSeparator(value) || /[。？！；;]$/.test(value)) return null;
    if (!isBareTaskListLine(lines[startIndex + 1] || '')) return null;
    return { text: value, next: startIndex + 1 };
}

function stripUnorderedListMarker(line) {
    return String(line || '').trim()
        .replace(/^[-*+]\s+/, '')
        .replace(/^[-*+](?=[\u4e00-\u9fffA-Za-z0-9`【《（(])/, '')
        .replace(/^[•·]\s*/, '');
}

function renderListItem(item) {
    const task = typeof item === 'string' ? parseTaskListMarker(item) : item;
    if (task && (task.checked === true || task.checked === false)) {
        return '<li><input type="checkbox" disabled ' + (task.checked ? 'checked' : '') + '> ' + renderInlineMarkdown(task.text || '') + '</li>';
    }
    return '<li>' + renderInlineMarkdown(typeof item === 'string' ? item : item.text || '') + '</li>';
}

function parseTaskListMarker(value) {
    const match = String(value || '').trim().match(/^\[([ xX])\]\s*(.*)$/);
    if (!match) return { text: value, checked: null };
    return { text: match[2] || '', checked: match[1].toLowerCase() === 'x' };
}

function shouldContinueParagraph(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return false;
    if (/^(#{1,6})\s+/.test(trimmed)) return false;
    if (/^```/.test(trimmed)) return false;
    if (/^>\s?/.test(trimmed)) return false;
    if (/^[-*_]{2,}$/.test(trimmed)) return false;
    if (isPipedTableCandidate(trimmed)) return false;
    if (hasLooseTableSeparator(trimmed) && parseLooseTableCells(trimmed).length >= 2) return false;
    if (isBareTaskListLine(trimmed)) return false;
    if (isUnorderedListLine(trimmed)) return false;
    if (/^\d+[.)]\s+/.test(trimmed)) return false;
    return true;
}

function readLooseMarkdownTable(lines, index) {
    const headerCells = parseLooseTableCells(lines[index]);
    if (!looksLikeLooseTableHeader(headerCells, lines[index], lines[index + 1] || '')) {
        return null;
    }

    const columnCount = headerCells.length;
    const rows = [];
    let i = index + 1;
    if (isMarkdownTableSeparatorLine(lines[i])) i++;

    while (i < lines.length) {
        const line = lines[i] || '';
        const trimmed = String(line).trim();
        if (!trimmed) {
            if (rows.length && hasLooseTableContinuationAhead(lines, i + 1)) {
                i++;
                continue;
            }
            break;
        }
        if (/^[-*_]{2,}$/.test(trimmed)) break;
        if (isMarkdownTableSeparatorLine(line)) {
            i++;
            continue;
        }
        const cells = parseLooseTableCells(line);
        if (cells.length >= 2) {
            rows.push(normalizeLooseTableRow(cells, columnCount));
            i++;
            continue;
        }
        if (rows.length && isLooseTableContinuationLine(line)) {
            appendLooseTableContinuation(rows[rows.length - 1], cleanLooseTableText(line));
            i++;
            continue;
        }
        break;
    }

    if (!rows.length) return null;
    return { html: renderWikiTable(headerCells, rows), next: i };
}

function looksLikeLooseTableHeader(cells, line, nextLine) {
    if (!Array.isArray(cells) || cells.length < 2) return false;
    const header = cells.join('|');
    if (/\u4efb\u52a1.*\u65f6\u95f4/.test(header)) return true;
    if (/\u4efb\u52a1.*\u8bf4\u660e/.test(header)) return true;
    if (/\u9636\u6bb5.*\u65e5\u5386\u65f6\u95f4/.test(header)) return true;
    if (isMarkdownTableSeparatorLine(nextLine)) return true;
    return hasLooseTableSeparator(line) && parseLooseTableCells(nextLine).length >= 2;
}

function parseLooseTableCells(line) {
    let value = String(line || '').trim();
    if (!value) return [];
    if (value.includes('|')) {
        if (value.startsWith('|')) value = value.slice(1);
        if (value.endsWith('|')) value = value.slice(0, -1);
        return trimOuterEmptyCells(value.split('|').map(cleanLooseTableText));
    }
    if (value.includes('\t')) {
        return trimOuterEmptyCells(value.split('\t').map(cleanLooseTableText));
    }
    if (/\s{2,}/.test(value)) {
        return value.split(/\s{2,}/).map(cleanLooseTableText).filter(Boolean);
    }
    return [cleanLooseTableText(value)].filter(Boolean);
}

function hasLooseTableSeparator(line) {
    const value = String(line || '');
    return value.includes('|') || value.includes('\t') || /\s{2,}/.test(value);
}

function normalizeLooseTableRow(cells, columnCount) {
    let row = cells.map(toEditablePlainText);
    if (row.length > columnCount) {
        row = row.slice(0, columnCount - 1).concat(row.slice(columnCount - 1).join(' '));
    }
    while (row.length < columnCount) row.push('');
    return row;
}

function trimOuterEmptyCells(cells) {
    const result = [...(cells || [])];
    while (result.length && !String(result[0] || '').trim()) result.shift();
    while (result.length && !String(result[result.length - 1] || '').trim()) result.pop();
    return result;
}

function meaningfulCellCount(cells) {
    return (cells || []).filter((cell) => String(cell || '').trim()).length;
}

function shouldMergePartialLooseTableRow(previousRow, cells, columnCount) {
    const meaningful = cells.map(toEditablePlainText).filter(Boolean);
    if (!previousRow || !meaningful.length) return false;
    if (meaningful.length >= columnCount) return false;
    if (/^[+＋]/.test(meaningful[0])) return true;
    if (hasUnclosedBracket(previousRow.join(' '))) return true;
    return previousRow.some((cell, index) => index < columnCount && !String(cell || '').trim());
}

function hasUnclosedBracket(value) {
    const text = String(value || '');
    const opens = (text.match(/[（(]/g) || []).length;
    const closes = (text.match(/[）)]/g) || []).length;
    return opens > closes;
}

function mergePartialTableRow(row, cells, columnCount) {
    const meaningful = (cells || []).map(toEditablePlainText).filter(Boolean);
    if (!row || !meaningful.length) return;
    const attachIndex = findTableContinuationAttachIndex(row);
    row[attachIndex] = row[attachIndex] ? row[attachIndex] + ' ' + meaningful[0].replace(/^[+＋]\s*/, '') : meaningful[0].replace(/^[+＋]\s*/, '');
    meaningful.slice(1).forEach((cell) => {
        const emptyIndex = row.findIndex((value, index) => index > attachIndex && index < columnCount && !String(value || '').trim());
        if (emptyIndex >= 0) {
            row[emptyIndex] = cell;
        } else if (row.length < columnCount) {
            row.push(cell);
        } else {
            const lastIndex = Math.max(0, Math.min(columnCount, row.length) - 1);
            row[lastIndex] = row[lastIndex] ? row[lastIndex] + ' ' + cell : cell;
        }
    });
    while (row.length < columnCount) row.push('');
}

function findTableContinuationAttachIndex(row) {
    for (let i = 0; i < row.length; i++) {
        if (!String(row[i] || '').trim()) return Math.max(0, i - 1);
    }
    return Math.max(0, row.length - 1);
}

function hasLooseTableContinuationAhead(lines, startIndex) {
    for (let i = startIndex; i < Math.min(lines.length, startIndex + 3); i++) {
        const line = String(lines[i] || '').trim();
        if (!line) continue;
        return parseLooseTableCells(line).length >= 2 || isLooseTableContinuationLine(line);
    }
    return false;
}

function isLooseTableContinuationLine(line) {
    const value = cleanLooseTableText(line);
    if (!value) return false;
    if (/^[-*_]{2,}$/.test(value)) return false;
    if (/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/.test(value)) return false;
    if (value.length > 90) return false;
    return true;
}

function appendLooseTableContinuation(row, text) {
    if (!text) return;
    const index = Math.max(0, row.length - 1);
    row[index] = row[index] ? row[index] + '\n' + text : text;
}

function cleanLooseTableText(text) {
    return toEditablePlainText(String(text || '')
        .replace(/^\s*\|\s*/, '')
        .replace(/\s*\|\s*$/, '')
        .trim());
}

function isMarkdownTableSeparatorLine(line) {
    const cells = parseTableRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function isTableStart(lines, index) {
    const current = lines[index] || '';
    const next = lines[index + 1] || '';
    return current.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

function readMarkdownTable(lines, index) {
    const headers = parseTableRow(lines[index]);
    let i = index + 2;
    const rows = [];
    while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(parseTableRow(lines[i]));
        i++;
    }
    return { html: renderWikiTable(headers, rows), next: i };
}

function renderWikiTable(headers, rows) {
    const html = ['<div class="wiki-table-wrap"><table><thead><tr>'];
    headers.forEach((cell) => {
        html.push('<th>' + renderTableCell(cell) + '</th>');
    });
    html.push('</tr></thead><tbody>');
    rows.forEach((row) => {
        html.push('<tr>');
        headers.forEach((_, col) => {
            html.push('<td>' + renderTableCell(row[col] || '') + '</td>');
        });
        html.push('</tr>');
    });
    html.push('</tbody></table></div>');
    return html.join('');
}

function renderTableCell(cell) {
    return String(cell || '').split(/\n+|<br\s*\/?>/i).map(renderInlineMarkdown).join('<br>');
}

function toEditablePlainText(value) {
    let text = String(value == null ? '' : value).replace(/<br\s*\/?>/gi, '\n').replace(/\r\n?/g, '\n').trim();
    if (!text) return '';
    text = text
        .replace(/^\s*\[([ xX])\]\s*/, '')
        .replace(/!\[([^\]\n]*)]\([^)]+\)/g, '$1')
        .replace(/\[([^\]\n]+)]\((?:https?:\/\/)?[^)\s]+\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
        .replace(/__([\s\S]+?)__/g, '$1')
        .replace(/~~([\s\S]+?)~~/g, '$1')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
        .replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
        .replace(/^\s*(?:\*\*|__)+\s*/g, '')
        .replace(/\s*(?:\*\*|__)+\s*$/g, '')
        .replace(/\*\*/g, '')
        .replace(/__/g, '');
    return text
        .split('\n')
        .map((line) => line.replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '').replace(/[ \t]{2,}/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}

function toEditableMarkdownText(value) {
    return String(value == null ? '' : value)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .trim();
}

function toEditableDisplayText(value) {
    return String(value == null ? '' : value)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/\[([^\]\n]+)]\((https?:\/\/[^)\s]+)\)/gi, '$1')
        .replace(/\[\[([^\]\n]{1,120})]]/g, '$1')
        .replace(/<u>([\s\S]*?)<\/u>/gi, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
        .replace(/__([\s\S]*?)__/g, '$1')
        .replace(/~~([\s\S]*?)~~/g, '$1')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
        .replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .trim();
}

function isEmptyWikiContentLine(value) {
    return String(value || '').trim().toLowerCase() === EMPTY_WIKI_CONTENT;
}

function parseTableRow(line) {
    let value = String(line || '').trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|')) value = value.slice(0, -1);
    return value.split('|').map(cleanLooseTableText);
}

function renderInlineMarkdown(text) {
    const tokens = [];
    let value = String(text || '');
    value = value.replace(/\$\$([\s\S]+?)\$\$/g, (_, formula) => token(tokens, renderMath(formula, true)));
    value = value.replace(/\\\[([\s\S]+?)\\]/g, (_, formula) => token(tokens, renderMath(formula, true)));
    value = value.replace(/\\\(([\s\S]+?)\\\)/g, (_, formula) => token(tokens, renderMath(formula, false)));
    value = value.replace(/\$([^$\n]+?)\$/g, (_, formula) => token(tokens, renderMath(formula, false)));
    value = value.replace(/`([^`]+)`/g, (_, code) => token(tokens, '<code>' + escapeHtml(code) + '</code>'));
    value = escapeHtml(value)
        .replace(/&lt;u&gt;([\s\S]+?)&lt;\/u&gt;/g, '<u>$1</u>')
        .replace(/\[\[([^\]\n]{1,120})]]/g, (_, title) => renderWikiInternalLink(title))
        .replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>')
        .replace(/__([\s\S]*?)__/g, '<strong>$1</strong>')
        .replace(/~~([\s\S]+?)~~/g, '<del>$1</del>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
        .replace(/\[([^\]\n]+)]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/\*\*/g, '')
        .replace(/__/g, '');
    tokens.forEach((item, index) => {
        value = value.replace('@@TOKEN' + index + '@@', item);
    });
    return value;
}

function renderWikiInternalLink(title) {
    const clean = String(title || '').trim();
    const node = findNodeByTitle(clean);
    const cls = node ? 'wiki-internal-link' : 'wiki-internal-link missing';
    return '<a href="#" class="' + cls + '" data-wiki-link="' + escapeHtml(clean) + '">' + escapeHtml(clean) + '</a>';
}

function openWikiLink(title) {
    const node = findNodeByTitle(title);
    if (node) {
        selectWikiPage(node.id);
        return;
    }
    openCreateModal({ title, content: '# ' + title + '\n', pageType: 'NOTE' });
}

function token(tokens, html) {
    const marker = '@@TOKEN' + tokens.length + '@@';
    tokens.push(html);
    return marker;
}

function renderMath(formula, display) {
    try {
        if (window.katex && typeof window.katex.renderToString === 'function') {
            return window.katex.renderToString(formula.trim(), { displayMode: display, throwOnError: false });
        }
        return '<span class="' + (display ? 'katex katex-display' : 'katex') + '">' + escapeHtml(formula) + '</span>';
    } catch (e) {
        return '<span class="katex-error">' + escapeHtml(formula) + '</span>';
    }
}

function valueOf(id) {
    return document.getElementById(id)?.value.trim() || '';
}

function setValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value == null ? '' : String(value);
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function shortDate(value) {
    return value ? String(value).replace('T', ' ').slice(0, 16) : '-';
}

function formatFileSize(size) {
    const bytes = Number(size || 0);
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
}

function toggleInspector() {
    wikiInspectorVisible = !wikiInspectorVisible;
    renderInspector();
    syncWikiWorkspaceState();
}

function openSourceModal() {
    setValue('wiki-source-title', '');
    setValue('wiki-source-type', 'NOTE');
    setValue('wiki-source-ref', '');
    setValue('wiki-source-content', '');
    const fileInput = document.getElementById('wiki-source-file');
    if (fileInput) fileInput.value = '';
    setText('wiki-source-file-name', '未选择文件。也可以直接在下面粘贴原始内容。');
    document.getElementById('wikiSourceModal')?.classList.remove('hidden');
    if (window.refreshCustomSelects) window.refreshCustomSelects();
    setTimeout(() => document.getElementById('wiki-source-title')?.focus(), 40);
}

function closeSourceModal() {
    document.getElementById('wikiSourceModal')?.classList.add('hidden');
}

function handleSourceFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
        setText('wiki-source-file-name', '未选择文件。也可以直接在下面粘贴原始内容。');
        return;
    }
    setText('wiki-source-file-name', file.name + ' · ' + formatFileSize(file.size));
    if (!valueOf('wiki-source-title')) {
        setValue('wiki-source-title', file.name.replace(/\.[^.]+$/, ''));
    }
    setValue('wiki-source-type', 'FILE');
    setValue('wiki-source-ref', file.name);
    if (window.refreshCustomSelects) window.refreshCustomSelects();
}

async function submitSourceFormLegacy(event) {
    event.preventDefault();
    const title = valueOf('wiki-source-title');
    const content = valueOf('wiki-source-content');
    if (!title || !content) {
        showToast('请填写来源标题和内容', 'warning');
        return;
    }
    const res = await api.post('/knowledge/sources', {
        title,
        sourceType: valueOf('wiki-source-type') || 'NOTE',
        sourceRef: valueOf('wiki-source-ref') || 'manual',
        content
    });
    closeSourceModal();
    showToast('Raw Source 已保存', 'success');
    const source = res.data || {};
    const ok = await showConfirm('是否基于这个来源生成一份待合入 Wiki 变更？');
    if (ok && source.id) {
        await api.post('/knowledge/sources/' + source.id + '/patch-set', {});
        showToast('已生成待合入变更', 'success');
    }
    await loadWiki();
}

async function submitSourceForm(event) {
    event.preventDefault();
    const submitButton = document.getElementById('wiki-source-submit');
    const fileInput = document.getElementById('wiki-source-file');
    const file = fileInput && fileInput.files ? fileInput.files[0] : null;
    const title = valueOf('wiki-source-title');
    const content = valueOf('wiki-source-content');
    if (!file && (!title || !content)) {
        showToast('请上传文件，或填写来源标题和原始内容', 'warning');
        return;
    }
    if (file && file.size > 20 * 1024 * 1024) {
        showToast('文件不能超过 20MB', 'warning');
        return;
    }
    try {
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.textContent = file ? '正在导入...' : '正在保存...';
        }
        const res = file
            ? await api.upload('/knowledge/sources/upload', file, {
                title: title || file.name.replace(/\.[^.]+$/, ''),
                sourceRef: valueOf('wiki-source-ref') || file.name
            })
            : await api.post('/knowledge/sources', {
                title,
                sourceType: valueOf('wiki-source-type') || 'NOTE',
                sourceRef: valueOf('wiki-source-ref') || 'manual',
                content
            });
        closeSourceModal();
        showToast('Raw Source 已保存', 'success');
        const source = res.data || {};
        const ok = await showConfirm('是否基于这个来源生成一份待合入 Wiki 变更？');
        if (ok && source.id) {
            await api.post('/knowledge/sources/' + source.id + '/patch-set', {});
            showToast('已生成待合入变更', 'success');
        }
        await loadWiki();
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = '保存来源';
        }
    }
}

function openQueryModal() {
    setValue('wiki-query-input', valueOf('wiki-tree-search'));
    renderQueryResults([]);
    document.getElementById('wikiQueryModal')?.classList.remove('hidden');
    setTimeout(() => document.getElementById('wiki-query-input')?.focus(), 40);
}

function closeQueryModal() {
    document.getElementById('wikiQueryModal')?.classList.add('hidden');
}

async function runWikiQuery() {
    const query = valueOf('wiki-query-input');
    if (!query) {
        showToast('请输入查询关键词', 'warning');
        return;
    }
    const localPages = wikiFlat.filter((node) => {
        const haystack = ((node.title || '') + ' ' + (node.summary || '') + ' ' + (node.content || '')).toLowerCase();
        return haystack.includes(query.toLowerCase());
    }).slice(0, 12);
    let sources = [];
    try {
        const res = await api.get('/knowledge/sources?q=' + encodeURIComponent(query) + '&page=1&size=12');
        sources = (res.data && Array.isArray(res.data.records)) ? res.data.records : [];
    } catch (e) {
        sources = [];
    }
    renderQueryResults({ pages: localPages, sources });
}

function renderQueryResults(result) {
    const box = document.getElementById('wiki-query-results');
    if (!box) return;
    const pages = Array.isArray(result.pages) ? result.pages : [];
    const sources = Array.isArray(result.sources) ? result.sources : [];
    if (!pages.length && !sources.length) {
        box.innerHTML = '<div class="wiki-empty-state">输入关键词后，会同时搜索 Wiki Pages 和 Raw Sources。</div>';
        return;
    }
    const pageHtml = pages.length ? pages.map((page) =>
        '<button type="button" class="wiki-query-result" data-query-page="' + page.id + '">' +
        '<strong>' + escapeHtml(page.title || '未命名') + '</strong>' +
        '<span>' + escapeHtml(typeLabel(page.pageType)) + ' · ' + escapeHtml(limitText(page.summary || '', 120)) + '</span>' +
        '</button>'
    ).join('') : '<div class="wiki-empty-mini">没有匹配的页面</div>';
    const sourceHtml = sources.length ? sources.map((source) =>
        '<div class="wiki-query-result source">' +
        '<strong>' + escapeHtml(source.title || 'Raw Source') + '</strong>' +
        '<span>' + escapeHtml(source.sourceType || '') + ' · ' + escapeHtml(limitText(source.summary || source.sourceRef || '', 140)) + '</span>' +
        '<button type="button" class="btn btn-default btn-sm" data-source-patch="' + source.id + '">生成 Patch Set</button>' +
        '</div>'
    ).join('') : '<div class="wiki-empty-mini">没有匹配的 Raw Source</div>';
    box.innerHTML = '<div class="wiki-query-columns">' +
        '<section><h3>Wiki Pages</h3>' + pageHtml + '</section>' +
        '<section><h3>Raw Sources</h3>' + sourceHtml + '</section>' +
        '</div>';
    box.querySelectorAll('[data-query-page]').forEach((button) => {
        button.addEventListener('click', () => {
            closeQueryModal();
            selectWikiPage(button.dataset.queryPage);
        });
    });
    box.querySelectorAll('[data-source-patch]').forEach((button) => {
        button.addEventListener('click', async () => {
            await api.post('/knowledge/sources/' + button.dataset.sourcePatch + '/patch-set', {});
            showToast('已生成待合入变更', 'success');
            closeQueryModal();
            await loadWiki();
            openPatchModal();
        });
    });
}

function openPatchModal() {
    renderPatchSets();
    document.getElementById('wikiPatchModal')?.classList.remove('hidden');
}

function closePatchModal() {
    document.getElementById('wikiPatchModal')?.classList.add('hidden');
}

function renderPatchSets() {
    const box = document.getElementById('wiki-patch-list');
    if (!box) return;
    const rows = Array.isArray(wikiPatchSets) ? wikiPatchSets : [];
    box.innerHTML = rows.length ? rows.map((patch) => {
        const items = Array.isArray(patch.items) ? patch.items : [];
        const itemHtml = items.length ? items.map((item) => (
            '<details class="wiki-patch-item">' +
            '<summary>' +
            '<span>' + escapeHtml(item.actionType || 'UPSERT') + '</span>' +
            '<strong>' + escapeHtml(item.title || '未命名页面') + '</strong>' +
            '</summary>' +
            '<div class="wiki-patch-preview">' + renderWikiMarkdown(limitText(item.content || '', 1400)) + '</div>' +
            '</details>'
        )).join('') : '<div class="wiki-empty-mini">这个变更包还没有页面项。</div>';
        return '<section class="wiki-patch-card" data-patch-card="' + patch.id + '">' +
            '<div class="wiki-patch-head">' +
            '<div>' +
            '<span class="wiki-patch-kicker">' + escapeHtml(patch.triggerType || 'PATCH') + ' · ' + escapeHtml(shortDate(patch.createdAt)) + renderPatchSourceLabel(patch) + '</span>' +
            '<h3>' + escapeHtml(patch.title || 'Wiki 变更包') + '</h3>' +
            '<p>' + escapeHtml(patch.summary || '等待确认后合入 Wiki。') + '</p>' +
            '</div>' +
            '<div class="wiki-patch-actions">' +
            '<button type="button" class="btn btn-default btn-sm" data-patch-action="reject" data-patch-id="' + patch.id + '">忽略</button>' +
            '<button type="button" class="btn btn-primary btn-sm" data-patch-action="apply" data-patch-id="' + patch.id + '">确认合入</button>' +
            '</div>' +
            '</div>' +
            itemHtml +
            '</section>';
    }).join('') : '<div class="wiki-empty-state">暂无待合入变更。对 AI 说“整理进 Wiki”后，会先出现在这里等待确认。</div>';
}

function renderPatchSourceLabel(patch) {
    const source = wikiSources.find((item) =>
        (patch.sourceMessageId && String(item.messageId || '') === String(patch.sourceMessageId))
        || (patch.sourceConversationId && String(item.conversationId || '') === String(patch.sourceConversationId))
    );
    return source ? ' · 来源：' + escapeHtml(source.title || 'Raw Source') : '';
}

async function handlePatchListClick(event) {
    const action = event.target.closest('[data-patch-action]');
    if (!action) return;
    const id = action.dataset.patchId;
    if (!id) return;
    if (action.dataset.patchAction === 'reject') {
        await api.post('/knowledge/patch-sets/' + id + '/reject', {});
        showToast('已忽略 Wiki 变更', 'success');
    } else {
        await api.post('/knowledge/patch-sets/' + id + '/apply', {});
        showToast('Wiki 变更已合入', 'success');
    }
    closePatchModal();
    await loadWiki();
}

async function openGraphModal() {
    try {
        const res = await api.get('/knowledge/graph');
        wikiGraph = res.data || wikiGraph || { nodes: [], links: [] };
    } catch (e) {
        showToast(e.message || '图谱加载失败', 'error');
    }
    renderGraphModal();
    document.getElementById('wikiGraphModal')?.classList.remove('hidden');
}

function closeGraphModal() {
    document.getElementById('wikiGraphModal')?.classList.add('hidden');
}

function renderGraphModal() {
    const box = document.getElementById('wiki-graph-body');
    if (!box) return;
    const nodes = Array.isArray(wikiGraph.nodes) ? wikiGraph.nodes : [];
    const links = Array.isArray(wikiGraph.links) ? wikiGraph.links : [];
    const hubs = Array.isArray(wikiGraph.hubs) ? wikiGraph.hubs : [];
    const orphans = Array.isArray(wikiGraph.orphanPages) ? wikiGraph.orphanPages : [];
    const missing = Array.isArray(wikiGraph.missingTargets) ? wikiGraph.missingTargets : [];
    const degree = new Map();
    links.forEach((link) => {
        const source = String(link.sourcePageId || '');
        const target = String(link.targetPageId || link.targetTitle || '');
        degree.set(source, (degree.get(source) || 0) + 1);
        degree.set(target, (degree.get(target) || 0) + 1);
    });
    const nodeHtml = nodes.length ? nodes.map((node) => {
        const count = node.degree != null ? node.degree : (degree.get(String(node.id)) || 0);
        return '<button type="button" class="wiki-graph-node" data-graph-page="' + escapeHtml(String(node.id)) + '">' +
            '<strong>' + escapeHtml(node.title || '未命名') + '</strong>' +
            '<span>' + escapeHtml(typeLabel(node.type)) + ' · ' + count + ' 条连接</span>' +
            '</button>';
    }).join('') : '<div class="wiki-empty-mini">暂无页面节点。</div>';
    const hubHtml = hubs.length ? hubs.map((node) =>
        '<button type="button" class="wiki-graph-node hub" data-graph-page="' + escapeHtml(String(node.id)) + '">' +
        '<strong>' + escapeHtml(node.title || '未命名') + '</strong>' +
        '<span>核心页面 · ' + escapeHtml(String(node.degree || 0)) + ' 条连接</span>' +
        '</button>'
    ).join('') : '<div class="wiki-empty-mini">暂时没有核心枢纽页面</div>';
    const orphanHtml = orphans.length ? orphans.map((node) =>
        '<button type="button" class="wiki-graph-node warning" data-graph-page="' + escapeHtml(String(node.id)) + '">' +
        '<strong>' + escapeHtml(node.title || '未命名') + '</strong><span>孤立页面</span></button>'
    ).join('') : '<div class="wiki-empty-mini">没有孤立页面</div>';
    const missingHtml = missing.length ? missing.map((link) =>
        '<div class="wiki-graph-link warning"><span>' + escapeHtml(findNode(link.sourcePageId)?.title || '未知页面') + '</span><strong>→</strong><span>缺失：' + escapeHtml(link.targetTitle || '') + '</span></div>'
    ).join('') : '<div class="wiki-empty-mini">没有缺失双链</div>';
    const linkHtml = links.length ? links.slice(0, 80).map((link) => {
        const source = findNode(link.sourcePageId);
        const target = link.targetPageId ? findNode(link.targetPageId) : null;
        return '<div class="wiki-graph-link">' +
            '<span>' + escapeHtml(source?.title || '未知页面') + '</span>' +
            '<strong>→</strong>' +
            '<span>' + escapeHtml(target?.title || link.targetTitle || '未创建页面') + '</span>' +
            '</div>';
    }).join('') : '<div class="wiki-empty-mini">暂无双链关系。</div>';
    box.innerHTML = '<div class="wiki-graph-summary">' +
        '<span>页面 ' + nodes.length + '</span><span>链接 ' + links.length + '</span><span>孤立 ' + orphans.length + '</span><span>缺失 ' + missing.length + '</span>' +
        '</div><div class="wiki-graph-grid">' +
        '<section><h3>核心页面</h3><div class="wiki-graph-nodes">' + hubHtml + '</div></section>' +
        '<section><h3>孤立页面</h3><div class="wiki-graph-nodes">' + orphanHtml + '</div></section>' +
        '<section><h3>缺失双链</h3><div class="wiki-graph-links">' + missingHtml + '</div></section>' +
        '<section><h3>页面节点</h3><div class="wiki-graph-nodes">' + nodeHtml + '</div></section>' +
        '<section><h3>链接关系</h3><div class="wiki-graph-links">' + linkHtml + '</div></section>' +
        '</div>';
    box.querySelectorAll('[data-graph-page]').forEach((button) => {
        button.addEventListener('click', () => {
            closeGraphModal();
            selectWikiPage(button.dataset.graphPage);
        });
    });
}

async function exportWikiMarkdown() {
    const token = typeof getAuthToken === 'function' ? getAuthToken() : '';
    const response = await fetch('/api/knowledge/export/markdown', {
        method: 'GET',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        credentials: 'same-origin'
    });
    if (!response.ok) {
        showToast('导出失败，请稍后再试', 'error');
        return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zhiqu-wiki-markdown.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

async function runWikiLint() {
    const res = await api.post('/knowledge/lint', {});
    const data = res.data || {};
    renderLintReport(data);
    document.getElementById('wikiLintModal')?.classList.remove('hidden');
    await loadWiki();
}

function closeLintModal() {
    document.getElementById('wikiLintModal')?.classList.add('hidden');
}

function renderLintReport(data) {
    const box = document.getElementById('wiki-lint-body');
    if (!box) return;
    const orphanPages = Array.isArray(data.orphanPages) ? data.orphanPages : [];
    const missingTargets = Array.isArray(data.missingTargets) ? data.missingTargets : [];
    const duplicateTitles = Array.isArray(data.duplicateTitles) ? data.duplicateTitles : [];
    const stalePlans = Array.isArray(data.stalePlans) ? data.stalePlans : [];
    const unsourcedPages = Array.isArray(data.unsourcedPages) ? data.unsourcedPages : [];
    box.innerHTML = '<div class="wiki-lint-summary">' +
        '<span>页面 ' + escapeHtml(String(data.pageCount || 0)) + '</span>' +
        '<span>链接 ' + escapeHtml(String(data.linkCount || 0)) + '</span>' +
        '<span>来源 ' + escapeHtml(String(data.sourceCount || 0)) + '</span>' +
        '</div>' +
        renderLintSection('孤立页面', orphanPages, (item) => renderLintPageButton(item, '建议补充 [[双链]] 或归入已有页面')) +
        renderLintSection('缺失双链', missingTargets, (item) => '<div class="wiki-lint-row"><strong>' + escapeHtml(item.targetTitle || '') + '</strong><span>来源页：' + escapeHtml(findNode(item.sourcePageId)?.title || '未知页面') + '</span></div>') +
        renderLintSection('重复标题', duplicateTitles, (item) => '<div class="wiki-lint-row"><strong>' + escapeHtml(item.title || '') + '</strong><span>' + (item.pages || []).map((page) => escapeHtml(page.title || '')).join(' / ') + '</span></div>') +
        renderLintSection('过期计划', stalePlans, (item) => renderLintPageButton(item, '90 天未更新，建议复盘')) +
        renderLintSection('无来源页面', unsourcedPages, (item) => renderLintPageButton(item, '建议关联 Raw Source 或补充引用'));
}

function renderLintSection(title, rows, renderer) {
    const list = Array.isArray(rows) ? rows : [];
    return '<section class="wiki-lint-section"><h3>' + escapeHtml(title) + '<span>' + list.length + '</span></h3>' +
        (list.length ? list.map(renderer).join('') : '<div class="wiki-empty-mini">无问题</div>') +
        '</section>';
}

function renderLintPageButton(item, note) {
    return '<button type="button" class="wiki-lint-row" data-lint-page="' + escapeHtml(String(item.id)) + '">' +
        '<strong>' + escapeHtml(item.title || '未命名') + '</strong><span>' + escapeHtml(note || '') + '</span></button>';
}

function handleLintClick(event) {
    const page = event.target.closest('[data-lint-page]');
    if (!page) return;
    closeLintModal();
    selectWikiPage(page.dataset.lintPage);
}

function limitText(value, max) {
    const text = String(value == null ? '' : value);
    return text.length <= max ? text : text.slice(0, max) + '...';
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
