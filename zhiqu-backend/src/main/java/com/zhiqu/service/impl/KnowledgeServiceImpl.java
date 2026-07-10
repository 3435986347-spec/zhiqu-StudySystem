package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.KnowledgeOperationLog;
import com.zhiqu.entity.KnowledgePageLink;
import com.zhiqu.entity.KnowledgePatchSet;
import com.zhiqu.entity.KnowledgeSource;
import com.zhiqu.entity.UserKnowledgePage;
import com.zhiqu.entity.UserKnowledgeRevision;
import com.zhiqu.mapper.KnowledgeOperationLogMapper;
import com.zhiqu.mapper.KnowledgePageLinkMapper;
import com.zhiqu.mapper.KnowledgePatchSetMapper;
import com.zhiqu.mapper.KnowledgeSourceMapper;
import com.zhiqu.mapper.UserKnowledgePageMapper;
import com.zhiqu.mapper.UserKnowledgeRevisionMapper;
import com.zhiqu.service.KnowledgeService;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import com.zhiqu.util.FileParseUtil;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

@Service
public class KnowledgeServiceImpl implements KnowledgeService {
    private static final Pattern WIKI_LINK_PATTERN = Pattern.compile("\\[\\[([^\\]\\n]{1,120})]]");
    private static final long MAX_SOURCE_UPLOAD_BYTES = 20L * 1024L * 1024L;

    private final UserKnowledgePageMapper pageMapper;
    private final UserKnowledgeRevisionMapper revisionMapper;
    private final KnowledgeSourceMapper sourceMapper;
    private final KnowledgePatchSetMapper patchSetMapper;
    private final KnowledgePageLinkMapper linkMapper;
    private final KnowledgeOperationLogMapper operationLogMapper;
    private final SensitiveCryptoService cryptoService;

    public KnowledgeServiceImpl(UserKnowledgePageMapper pageMapper,
                                UserKnowledgeRevisionMapper revisionMapper,
                                KnowledgeSourceMapper sourceMapper,
                                KnowledgePatchSetMapper patchSetMapper,
                                KnowledgePageLinkMapper linkMapper,
                                KnowledgeOperationLogMapper operationLogMapper,
                                SensitiveCryptoService cryptoService) {
        this.pageMapper = pageMapper;
        this.revisionMapper = revisionMapper;
        this.sourceMapper = sourceMapper;
        this.patchSetMapper = patchSetMapper;
        this.linkMapper = linkMapper;
        this.operationLogMapper = operationLogMapper;
        this.cryptoService = cryptoService;
    }

    @Override
    public List<Map<String, Object>> listPages(Long userId) {
        return pageMapper.selectList(new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getUserId, userId)
                .orderByAsc(UserKnowledgePage::getSortOrder)
                .orderByDesc(UserKnowledgePage::getUpdatedAt))
                .stream().map(this::pageRow).toList();
    }

    @Override
    public List<Map<String, Object>> tree(Long userId) {
        List<UserKnowledgePage> pages = pageMapper.selectList(new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getUserId, userId)
                .orderByAsc(UserKnowledgePage::getSortOrder)
                .orderByDesc(UserKnowledgePage::getUpdatedAt));
        Map<Long, Map<String, Object>> nodes = new LinkedHashMap<>();
        for (UserKnowledgePage page : pages) {
            nodes.put(page.getId(), treeNode(page));
        }
        List<Map<String, Object>> roots = new ArrayList<>();
        for (UserKnowledgePage page : pages) {
            Map<String, Object> node = nodes.get(page.getId());
            Long parentId = page.getParentId();
            if (parentId != null && nodes.containsKey(parentId)) {
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> children = (List<Map<String, Object>>) nodes.get(parentId).get("children");
                children.add(node);
            } else {
                roots.add(node);
            }
        }
        sortTree(roots);
        return roots;
    }

    @Override
    public List<Map<String, Object>> documentTree(Long userId) {
        ensureSystemPages(userId);
        List<UserKnowledgePage> pages = pageMapper.selectList(new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getUserId, userId)
                .orderByAsc(UserKnowledgePage::getSortOrder)
                .orderByDesc(UserKnowledgePage::getUpdatedAt));
        Map<Long, Map<String, Object>> nodes = new LinkedHashMap<>();
        for (UserKnowledgePage page : pages) {
            nodes.put(page.getId(), documentNode(page));
        }
        List<Map<String, Object>> roots = new ArrayList<>();
        for (UserKnowledgePage page : pages) {
            Map<String, Object> node = nodes.get(page.getId());
            Long parentId = page.getParentId();
            if (parentId != null && nodes.containsKey(parentId)) {
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> children = (List<Map<String, Object>>) nodes.get(parentId).get("children");
                children.add(node);
            } else {
                roots.add(node);
            }
        }
        sortTree(roots);
        return roots;
    }

    @Override
    @Transactional
    public Map<String, Object> workspace(Long userId) {
        ensureSystemPages(userId);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("tree", documentTree(userId));
        result.put("links", listLinks(userId));
        result.put("sources", listSources(userId, 20));
        result.put("recentLogs", listOperationLogs(userId, 30));
        result.put("pendingPatchSets", listPatchSets(userId, "PENDING"));
        result.put("graph", graph(userId));
        return result;
    }

    @Override
    public Map<String, Object> detail(Long userId, Long id) {
        return pageRow(ownedPage(userId, id));
    }

    @Override
    @Transactional
    public Map<String, Object> savePage(Long userId, Long id, Map<String, Object> body) {
        UserKnowledgePage page = null;
        if (id != null) {
            page = ownedPage(userId, id);
        }
        if (page == null) {
            page = new UserKnowledgePage();
            page.setUserId(userId);
        }
        String title = required(body.get("title"), "标题不能为空");
        String content = cleanMarkdownContent(required(body.get("content"), "内容不能为空"));
        // 系统页按标题维护（ensureSystemPage 以标题查找），改名会导致重复建页，后端强制拦截
        boolean systemPage = page.getId() != null && isSystemKnowledgePage(page);
        if (systemPage && !title.trim().equals(page.getTitle())) {
            throw new BusinessException("系统页（index / log / Wiki 维护规则）不允许改名");
        }
        // 普通页占用系统保留标题会和 ensureSystemPage 的按标题查找相撞
        if (!systemPage && isSystemPageTitle(title)) {
            throw new BusinessException("「index / log / Wiki 维护规则」是系统保留标题，请换一个");
        }
        page.setTitle(limit(title, 120));
        if (systemPage) {
            // 系统页锁定结构属性：忽略请求里的 parentId/pageType/pinned，
            // 否则可先把 pageType 改成 NOTE 再绕过删除/改名保护
            page.setSortOrder(defaultInt(body.get("sortOrder"), page.getSortOrder() == null ? 0 : page.getSortOrder()));
        } else {
            // 字段缺省则保留旧值，避免更新正文时把子页挪到根节点或重置类型
            Long parentId = body.containsKey("parentId") ? parseLong(body.get("parentId")) : page.getParentId();
            if (parentId != null) {
                if (page.getId() != null && page.getId().equals(parentId)) {
                    throw new BusinessException("不能把知识页挂到自己下面");
                }
                ownedPage(userId, parentId);
            }
            page.setParentId(parentId);
            String keepType = page.getPageType() != null ? page.getPageType() : "NOTE";
            page.setPageType(limit(value(body.get("pageType"), keepType).toUpperCase(), 40));
            page.setSortOrder(defaultInt(body.get("sortOrder"), page.getSortOrder() == null ? 0 : page.getSortOrder()));
            int keepPinned = page.getPinned() != null ? page.getPinned() : 0;
            page.setPinned(body.containsKey("pinned") ? (booleanValue(body.get("pinned")) ? 1 : 0) : keepPinned);
        }
        page.setEncryptedContent(cryptoService.encrypt(content));
        page.setContentSummary(limit(content.replaceAll("\\s+", " "), 500));
        page.setEncryptionVersion("v1");
        if (page.getId() == null) {
            pageMapper.insert(page);
            writeLog(userId, "page.create", page.getId(), null, null, "创建知识页：" + page.getTitle(), page.getContentSummary());
        } else {
            pageMapper.updateById(page);
            writeLog(userId, "page.update", page.getId(), null, null, "更新知识页：" + page.getTitle(), page.getContentSummary());
        }
        syncPageLinks(userId, page.getId(), content);
        return pageRow(pageMapper.selectById(page.getId()));
    }

    @Override
    @Transactional
    public Map<String, Object> movePage(Long userId, Long id, Map<String, Object> body) {
        UserKnowledgePage page = ownedPage(userId, id);
        if (isSystemKnowledgePage(page)) {
            throw new BusinessException("系统页（index / log / Wiki 维护规则）不允许移动");
        }
        Long parentId = parseLong(body == null ? null : body.get("parentId"));
        if (parentId != null) {
            if (page.getId().equals(parentId)) {
                throw new BusinessException("不能把知识页移动到自己下面");
            }
            ownedPage(userId, parentId);
            if (isDescendant(userId, parentId, page.getId())) {
                throw new BusinessException("不能把知识页移动到自己的子节点下面");
            }
        }

        int targetIndex = Math.max(0, defaultInt(body == null ? null : body.get("sortOrder"), 0));
        page.setParentId(parentId);
        pageMapper.updateById(page);

        List<UserKnowledgePage> siblings = siblingPages(userId, parentId);
        siblings.removeIf(item -> item.getId().equals(page.getId()));
        siblings.add(Math.min(targetIndex, siblings.size()), page);
        for (int i = 0; i < siblings.size(); i++) {
            UserKnowledgePage item = siblings.get(i);
            item.setSortOrder(i * 10);
            pageMapper.updateById(item);
        }
        return pageRow(pageMapper.selectById(page.getId()));
    }

    @Override
    @Transactional
    public void deletePage(Long userId, Long id) {
        UserKnowledgePage page = ownedPage(userId, id);
        if (isSystemKnowledgePage(page)) {
            throw new BusinessException("系统页（index / log / Wiki 维护规则）不允许删除");
        }
        pageMapper.deleteById(page.getId());
        clearPageLinks(userId, page.getId());
        writeLog(userId, "page.delete", page.getId(), null, null, "删除知识页：" + page.getTitle(), null);
    }

    @Override
    public List<Map<String, Object>> listRevisions(Long userId) {
        return listRevisions(userId, "PENDING");
    }

    @Override
    public List<Map<String, Object>> listRevisions(Long userId, String status) {
        LambdaQueryWrapper<UserKnowledgeRevision> query = new LambdaQueryWrapper<UserKnowledgeRevision>()
                .eq(UserKnowledgeRevision::getUserId, userId)
                .orderByDesc(UserKnowledgeRevision::getCreatedAt);
        if (status != null && !status.isBlank()) {
            query.eq(UserKnowledgeRevision::getStatus, status.trim().toUpperCase());
        } else {
            query.eq(UserKnowledgeRevision::getStatus, "PENDING");
        }
        return revisionMapper.selectList(query).stream().map(this::revisionRow).toList();
    }

    @Override
    @Transactional
    public Map<String, Object> approveRevision(Long userId, Long id) {
        UserKnowledgeRevision revision = ownedRevision(userId, id);
        if (!"PENDING".equals(revision.getStatus())) {
            throw new BusinessException("该建议已处理");
        }
        String content = cleanMarkdownContent(cryptoService.decrypt(revision.getEncryptedContent()));
        UserKnowledgePage page = revision.getPageId() == null ? null : pageMapper.selectById(revision.getPageId());
        if ("DELETE".equalsIgnoreCase(revision.getActionType())) {
            if (page != null && page.getUserId().equals(userId)) {
                pageMapper.deleteById(page.getId());
            }
        } else {
            if (page == null) {
                page = new UserKnowledgePage();
                page.setUserId(userId);
                page.setPageType(inferPageType(revision.getTitle(), content));
                page.setSortOrder(0);
                page.setPinned(0);
            }
            page.setTitle(limit(value(revision.getTitle(), "对话提炼记忆"), 120));
            page.setEncryptedContent(cryptoService.encrypt(content));
            page.setContentSummary(limit(content.replaceAll("\\s+", " "), 500));
            page.setSourceMessageId(revision.getSourceMessageId());
            page.setSourceConversationId(revision.getSourceConversationId());
            page.setEncryptionVersion("v1");
            if (page.getId() == null) {
                pageMapper.insert(page);
            } else {
                pageMapper.updateById(page);
            }
            syncPageLinks(userId, page.getId(), content);
            writeLog(userId, "revision.apply", page.getId(), revision.getPatchSetId(), null,
                    "合入知识草稿：" + page.getTitle(), page.getContentSummary());
            revision.setPageId(page.getId());
        }
        revision.setStatus("APPROVED");
        revision.setAppliedAt(LocalDateTime.now());
        revisionMapper.updateById(revision);
        return revisionRow(revision);
    }

    @Override
    @Transactional
    public Map<String, Object> applyRevision(Long userId, Long id, Map<String, Object> body) {
        if (body == null) {
            body = Map.of();
        }
        UserKnowledgeRevision revision = ownedRevision(userId, id);
        if (!"PENDING".equals(revision.getStatus())) {
            throw new BusinessException("璇ュ缓璁凡澶勭悊");
        }
        if ("DELETE".equalsIgnoreCase(revision.getActionType())) {
            if (revision.getPageId() != null) {
                UserKnowledgePage page = pageMapper.selectById(revision.getPageId());
                if (page != null && page.getUserId().equals(userId)) {
                    pageMapper.deleteById(page.getId());
                }
            }
            revision.setStatus("APPROVED");
            revision.setAppliedAt(LocalDateTime.now());
            revisionMapper.updateById(revision);
            return revisionRow(revision);
        }

        String content = cleanMarkdownContent(value(body.get("content"), cryptoService.decrypt(revision.getEncryptedContent())));
        String title = value(body.get("title"), value(revision.getTitle(), "AI Wiki 草稿"));
        Long pageId = parseLong(body.get("pageId"));
        if (pageId == null) {
            pageId = revision.getPageId();
        }
        UserKnowledgePage page = pageId == null ? null : ownedPage(userId, pageId);
        if (page == null) {
            page = new UserKnowledgePage();
            page.setUserId(userId);
        }

        Long parentId = parseLong(body.get("parentId"));
        if (parentId != null) {
            if (page.getId() != null && page.getId().equals(parentId)) {
                throw new BusinessException("涓嶈兘鎶婄煡璇嗛〉鎸傚埌鑷繁涓嬮潰");
            }
            ownedPage(userId, parentId);
        }
        page.setParentId(parentId);
        page.setTitle(limit(title, 120));
        page.setPageType(limit(value(body.get("pageType"), value(page.getPageType(), inferPageType(title, content))).toUpperCase(), 40));
        page.setSortOrder(defaultInt(body.get("sortOrder"), page.getSortOrder() == null ? 0 : page.getSortOrder()));
        page.setPinned(body.containsKey("pinned")
                ? (booleanValue(body.get("pinned")) ? 1 : 0)
                : (page.getPinned() == null ? 0 : page.getPinned()));
        page.setEncryptedContent(cryptoService.encrypt(content));
        page.setContentSummary(limit(content.replaceAll("\\s+", " "), 500));
        page.setSourceMessageId(revision.getSourceMessageId());
        page.setSourceConversationId(revision.getSourceConversationId());
        page.setEncryptionVersion("v1");
        if (page.getId() == null) {
            pageMapper.insert(page);
        } else {
            pageMapper.updateById(page);
        }
        syncPageLinks(userId, page.getId(), content);
        writeLog(userId, "revision.apply", page.getId(), revision.getPatchSetId(), null,
                "合入知识草稿：" + page.getTitle(), page.getContentSummary());

        revision.setStatus("APPROVED");
        revision.setAppliedAt(LocalDateTime.now());
        revisionMapper.updateById(revision);
        return pageRow(pageMapper.selectById(page.getId()));
    }

    @Override
    @Transactional
    public void rejectRevision(Long userId, Long id) {
        UserKnowledgeRevision revision = ownedRevision(userId, id);
        revision.setStatus("REJECTED");
        revisionMapper.updateById(revision);
    }

    @Override
    public List<Map<String, Object>> listPatchSets(Long userId, String status) {
        LambdaQueryWrapper<KnowledgePatchSet> query = new LambdaQueryWrapper<KnowledgePatchSet>()
                .eq(KnowledgePatchSet::getUserId, userId)
                .orderByDesc(KnowledgePatchSet::getCreatedAt);
        if (status != null && !status.isBlank()) {
            query.eq(KnowledgePatchSet::getStatus, status.trim().toUpperCase());
        }
        return patchSetMapper.selectList(query).stream().map(this::patchSetRow).toList();
    }

    @Override
    @Transactional
    public Map<String, Object> createPatchSet(Long userId, Map<String, Object> body) {
        if (body == null) body = Map.of();
        KnowledgePatchSet patchSet = new KnowledgePatchSet();
        patchSet.setUserId(userId);
        patchSet.setTitle(limit(value(body.get("title"), "Wiki 变更建议"), 180));
        patchSet.setSummary(limit(value(body.get("summary"), value(body.get("description"), "")), 1200));
        patchSet.setTriggerType(limit(value(body.get("triggerType"), "MANUAL").toUpperCase(), 40));
        patchSet.setStatus("PENDING");
        patchSetMapper.insert(patchSet);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items = body.get("items") instanceof List<?> list
                ? (List<Map<String, Object>>) (List<?>) list
                : List.of();
        if (items.isEmpty()) {
            UserKnowledgeRevision revision = new UserKnowledgeRevision();
            revision.setUserId(userId);
            revision.setPatchSetId(patchSet.getId());
            revision.setActionType("UPSERT");
            revision.setTitle(limit(value(body.get("pageTitle"), patchSet.getTitle()), 120));
            revision.setEncryptedContent(cryptoService.encrypt(cleanMarkdownContent(value(body.get("content"), patchSet.getSummary()))));
            revision.setEncryptionVersion("v1");
            revision.setStatus("PENDING");
            revisionMapper.insert(revision);
        } else {
            for (Map<String, Object> item : items) {
                UserKnowledgeRevision revision = new UserKnowledgeRevision();
                revision.setUserId(userId);
                revision.setPatchSetId(patchSet.getId());
                revision.setPageId(parseLong(item.get("pageId")));
                revision.setActionType(limit(value(item.get("actionType"), "UPSERT").toUpperCase(), 20));
                revision.setTitle(limit(value(item.get("title"), patchSet.getTitle()), 120));
                revision.setEncryptedContent(cryptoService.encrypt(cleanMarkdownContent(value(item.get("content"), ""))));
                revision.setEncryptionVersion("v1");
                revision.setStatus("PENDING");
                revisionMapper.insert(revision);
            }
        }
        writeLog(userId, "patch.create", null, patchSet.getId(), null, "生成 Wiki 变更包：" + patchSet.getTitle(), patchSet.getSummary());
        return patchSetRow(patchSetMapper.selectById(patchSet.getId()));
    }

    @Override
    public Map<String, Object> listSources(Long userId, String query, String type, int page, int size) {
        int safePage = Math.max(1, page);
        int safeSize = Math.max(1, Math.min(size, 100));
        String normalizedQuery = value(query, "").toLowerCase();
        String normalizedType = value(type, "").toUpperCase();
        List<Map<String, Object>> rows = sourceMapper.selectList(new LambdaQueryWrapper<KnowledgeSource>()
                        .eq(KnowledgeSource::getUserId, userId)
                        .orderByDesc(KnowledgeSource::getCreatedAt))
                .stream()
                .filter(source -> !hasText(normalizedType) || normalizedType.equals(value(source.getSourceType(), "").toUpperCase()))
                .filter(source -> {
                    if (!hasText(normalizedQuery)) return true;
                    String haystack = (value(source.getTitle(), "") + " "
                            + value(source.getContentSummary(), "") + " "
                            + value(source.getSourceRef(), "")).toLowerCase();
                    return haystack.contains(normalizedQuery);
                })
                .map(this::sourceRow)
                .toList();
        int from = Math.min(rows.size(), (safePage - 1) * safeSize);
        int to = Math.min(rows.size(), from + safeSize);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("records", rows.subList(from, to));
        result.put("total", rows.size());
        result.put("page", safePage);
        result.put("size", safeSize);
        return result;
    }

    @Override
    @Transactional
    public Map<String, Object> createSource(Long userId, Map<String, Object> body) {
        if (body == null) body = Map.of();
        String title = required(body.get("title"), "来源标题不能为空");
        String content = required(body.get("content"), "来源内容不能为空");
        KnowledgeSource source = new KnowledgeSource();
        source.setUserId(userId);
        source.setSourceType(limit(value(body.get("sourceType"), "NOTE").toUpperCase(), 40));
        source.setTitle(limit(title, 180));
        source.setSourceRef(limit(value(body.get("sourceRef"), "manual"), 500));
        source.setEncryptedContent(cryptoService.encrypt(limit(content, 12000)));
        source.setEncryptionVersion("v1");
        source.setContentSummary(limit(cleanMarkdownContent(content).replaceAll("\\s+", " "), 780));
        source.setImmutableHash(cryptoService.sha256Hex(source.getSourceType() + "\n" + source.getTitle() + "\n" + source.getSourceRef() + "\n" + content));
        sourceMapper.insert(source);
        writeLog(userId, "source.ingest", null, null, source.getId(), "新增 Raw Source：" + source.getTitle(), source.getContentSummary());
        return sourceRow(sourceMapper.selectById(source.getId()));
    }

    @Override
    @Transactional
    public Map<String, Object> createSourceFromUpload(Long userId, MultipartFile file, String title) {
        if (file == null || file.isEmpty()) {
            throw new BusinessException("请选择要导入的文件");
        }
        if (file.getSize() > MAX_SOURCE_UPLOAD_BYTES) {
            throw new BusinessException("文件不能超过 20MB");
        }
        String fileName = sanitizeFileName(value(file.getOriginalFilename(), "未命名文件"));
        String contentType = value(file.getContentType(), "application/octet-stream");
        String content = extractSourceUploadContent(file, fileName, contentType);
        if (!hasText(content)) {
            throw new BusinessException("没有从文件中读取到可导入的内容");
        }
        String displayTitle = hasText(title) ? sanitizeFileName(title) : stripExtension(fileName);

        KnowledgeSource source = new KnowledgeSource();
        source.setUserId(userId);
        source.setSourceType(sourceTypeFromUpload(contentType, fileName));
        source.setTitle(limit(displayTitle, 180));
        source.setSourceRef(limit("file:" + fileName + " | " + contentType + " | " + file.getSize() + " bytes", 500));
        source.setEncryptedContent(cryptoService.encrypt(limit(content, 20000)));
        source.setEncryptionVersion("v1");
        source.setContentSummary(limit(cleanMarkdownContent(content).replaceAll("\\s+", " "), 780));
        source.setImmutableHash(cryptoService.sha256Hex("UPLOAD\n" + source.getSourceType() + "\n" + fileName + "\n" + file.getSize() + "\n" + content));
        sourceMapper.insert(source);
        writeLog(userId, "source.upload", null, null, source.getId(), "上传 Raw Source：" + source.getTitle(),
                "文件已作为 Raw Source 导入，内容摘要已生成，原文加密保存。");
        return sourceRow(sourceMapper.selectById(source.getId()));
    }

    @Override
    @Transactional
    public Map<String, Object> createPatchSetFromSource(Long userId, Long sourceId) {
        KnowledgeSource source = ownedSource(userId, sourceId);
        String content = cleanMarkdownContent(cryptoService.decrypt(source.getEncryptedContent()));
        KnowledgePatchSet patchSet = new KnowledgePatchSet();
        patchSet.setUserId(userId);
        patchSet.setTitle(limit("整理来源：" + source.getTitle(), 180));
        patchSet.setSummary(limit(value(source.getContentSummary(), "基于 Raw Source 生成待确认 Wiki 页面"), 1200));
        patchSet.setTriggerType("INGEST");
        patchSet.setStatus("PENDING");
        patchSet.setSourceConversationId(source.getConversationId());
        patchSet.setSourceMessageId(source.getMessageId());
        patchSetMapper.insert(patchSet);

        UserKnowledgeRevision revision = new UserKnowledgeRevision();
        revision.setUserId(userId);
        revision.setPatchSetId(patchSet.getId());
        revision.setActionType("UPSERT");
        revision.setTitle(limit(source.getTitle(), 120));
        revision.setEncryptedContent(cryptoService.encrypt(content));
        revision.setEncryptionVersion("v1");
        revision.setStatus("PENDING");
        revision.setSourceConversationId(source.getConversationId());
        revision.setSourceMessageId(source.getMessageId());
        revisionMapper.insert(revision);

        writeLog(userId, "patch.from_source", null, patchSet.getId(), source.getId(), "从 Raw Source 生成 Patch Set：" + patchSet.getTitle(), patchSet.getSummary());
        return patchSetRow(patchSetMapper.selectById(patchSet.getId()));
    }

    @Override
    @Transactional
    public Map<String, Object> applyPatchSet(Long userId, Long id) {
        KnowledgePatchSet patchSet = ownedPatchSet(userId, id);
        if (!"PENDING".equals(patchSet.getStatus())) {
            throw new BusinessException("该变更包已处理");
        }
        List<UserKnowledgeRevision> revisions = revisionMapper.selectList(new LambdaQueryWrapper<UserKnowledgeRevision>()
                .eq(UserKnowledgeRevision::getUserId, userId)
                .eq(UserKnowledgeRevision::getPatchSetId, id)
                .eq(UserKnowledgeRevision::getStatus, "PENDING")
                .orderByAsc(UserKnowledgeRevision::getId));
        if (revisions.isEmpty()) {
            throw new BusinessException("变更包没有可合入的内容");
        }
        for (UserKnowledgeRevision revision : revisions) {
            applyRevisionInternal(userId, revision, Map.of());
        }
        patchSet.setStatus("APPROVED");
        patchSet.setAppliedAt(LocalDateTime.now());
        patchSetMapper.updateById(patchSet);
        writeLog(userId, "patch.apply", null, patchSet.getId(), null, "合入 Wiki 变更包：" + patchSet.getTitle(), patchSet.getSummary());
        return patchSetRow(patchSetMapper.selectById(id));
    }

    @Override
    @Transactional
    public void rejectPatchSet(Long userId, Long id) {
        KnowledgePatchSet patchSet = ownedPatchSet(userId, id);
        patchSet.setStatus("REJECTED");
        patchSetMapper.updateById(patchSet);
        List<UserKnowledgeRevision> revisions = revisionMapper.selectList(new LambdaQueryWrapper<UserKnowledgeRevision>()
                .eq(UserKnowledgeRevision::getUserId, userId)
                .eq(UserKnowledgeRevision::getPatchSetId, id)
                .eq(UserKnowledgeRevision::getStatus, "PENDING"));
        for (UserKnowledgeRevision revision : revisions) {
            revision.setStatus("REJECTED");
            revisionMapper.updateById(revision);
        }
        writeLog(userId, "patch.reject", null, patchSet.getId(), null, "忽略 Wiki 变更包：" + patchSet.getTitle(), patchSet.getSummary());
    }

    @Override
    public Map<String, Object> graph(Long userId) {
        List<UserKnowledgePage> pages = pageMapper.selectList(new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getUserId, userId)
                .orderByAsc(UserKnowledgePage::getSortOrder)
                .orderByDesc(UserKnowledgePage::getUpdatedAt));
        List<KnowledgePageLink> links = linkMapper.selectList(new LambdaQueryWrapper<KnowledgePageLink>()
                .eq(KnowledgePageLink::getUserId, userId));
        Map<String, Object> lint = buildLintReport(userId, pages, links);
        // degree 语义 = 入度（被引用次数）；出链数单独给 outDegree，避免“引用了很多页的索引页”被误判为核心节点
        Map<Long, Integer> inDegree = new LinkedHashMap<>();
        Map<Long, Integer> outDegree = new LinkedHashMap<>();
        for (KnowledgePageLink link : links) {
            outDegree.put(link.getSourcePageId(), outDegree.getOrDefault(link.getSourcePageId(), 0) + 1);
            if (link.getTargetPageId() != null) {
                inDegree.put(link.getTargetPageId(), inDegree.getOrDefault(link.getTargetPageId(), 0) + 1);
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("nodes", pages.stream().map(page -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", page.getId());
            row.put("title", page.getTitle());
            row.put("type", page.getPageType());
            row.put("pinned", page.getPinned() != null && page.getPinned() == 1);
            row.put("degree", inDegree.getOrDefault(page.getId(), 0));
            row.put("outDegree", outDegree.getOrDefault(page.getId(), 0));
            return row;
        }).toList());
        result.put("links", links.stream().map(this::linkRow).toList());
        result.put("hubs", pages.stream()
                .filter(page -> inDegree.getOrDefault(page.getId(), 0) > 1)
                .sorted((a, b) -> Integer.compare(inDegree.getOrDefault(b.getId(), 0), inDegree.getOrDefault(a.getId(), 0)))
                .limit(8)
                .map(page -> {
                    Map<String, Object> row = treeNode(page);
                    row.put("degree", inDegree.getOrDefault(page.getId(), 0));
                    return row;
                }).toList());
        result.put("orphanPages", lint.get("orphanPages"));
        result.put("missingTargets", lint.get("missingTargets"));
        return result;
    }

    @Override
    public Map<String, Object> lint(Long userId) {
        ensureSystemPages(userId);
        List<UserKnowledgePage> pages = pageMapper.selectList(new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getUserId, userId));
        List<KnowledgePageLink> links = linkMapper.selectList(new LambdaQueryWrapper<KnowledgePageLink>()
                .eq(KnowledgePageLink::getUserId, userId));
        Map<String, Object> result = buildLintReport(userId, pages, links);
        writeLog(userId, "wiki.lint", null, null, null, "执行 Wiki 健康检查",
                "孤立页 " + ((List<?>) result.get("orphanPages")).size()
                        + " 个，缺失链接 " + ((List<?>) result.get("missingTargets")).size()
                        + " 个，重复标题 " + ((List<?>) result.get("duplicateTitles")).size()
                        + " 组");
        return result;
    }

    @Override
    public Map<String, Object> lintReport(Long userId) {
        ensureSystemPages(userId);
        List<UserKnowledgePage> pages = pageMapper.selectList(new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getUserId, userId));
        List<KnowledgePageLink> links = linkMapper.selectList(new LambdaQueryWrapper<KnowledgePageLink>()
                .eq(KnowledgePageLink::getUserId, userId));
        return buildLintReport(userId, pages, links);
    }

    private Map<String, Object> buildLintReport(Long userId, List<UserKnowledgePage> pages, List<KnowledgePageLink> links) {
        Set<Long> linkedIds = new HashSet<>();
        Set<String> existingTitles = new HashSet<>();
        Map<String, List<UserKnowledgePage>> titleGroups = new LinkedHashMap<>();
        for (UserKnowledgePage page : pages) {
            String normalized = normalizeTitle(page.getTitle());
            existingTitles.add(normalized);
            titleGroups.computeIfAbsent(normalized, key -> new ArrayList<>()).add(page);
        }
        List<Map<String, Object>> missingTargets = new ArrayList<>();
        for (KnowledgePageLink link : links) {
            linkedIds.add(link.getSourcePageId());
            if (link.getTargetPageId() != null) linkedIds.add(link.getTargetPageId());
            if (link.getTargetPageId() == null && !existingTitles.contains(normalizeTitle(link.getTargetTitle()))) {
                missingTargets.add(linkRow(link));
            }
        }
        List<Map<String, Object>> orphanPages = pages.stream()
                .filter(page -> !isSystemKnowledgePage(page))
                .filter(page -> !linkedIds.contains(page.getId()))
                .map(this::treeNode)
                .toList();
        List<Map<String, Object>> duplicateTitles = titleGroups.values().stream()
                .filter(group -> group.size() > 1)
                .map(group -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("title", group.get(0).getTitle());
                    row.put("pages", group.stream().map(this::treeNode).toList());
                    return row;
                })
                .toList();
        LocalDateTime staleCutoff = LocalDateTime.now().minusDays(90);
        List<Map<String, Object>> stalePlans = pages.stream()
                .filter(page -> "PROJECT".equals(page.getPageType()) || "SCHEDULE".equals(page.getPageType()))
                .filter(page -> page.getUpdatedAt() != null && page.getUpdatedAt().isBefore(staleCutoff))
                .map(this::treeNode)
                .toList();
        List<Map<String, Object>> unsourcedPages = pages.stream()
                .filter(page -> !isSystemKnowledgePage(page))
                .filter(page -> page.getSourceConversationId() == null && page.getSourceMessageId() == null)
                .map(this::treeNode)
                .toList();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("orphanPages", orphanPages);
        result.put("missingTargets", missingTargets);
        result.put("duplicateTitles", duplicateTitles);
        result.put("stalePlans", stalePlans);
        result.put("unsourcedPages", unsourcedPages);
        result.put("pageCount", pages.size());
        result.put("linkCount", links.size());
        result.put("sourceCount", sourceMapper.selectCount(new LambdaQueryWrapper<KnowledgeSource>()
                .eq(KnowledgeSource::getUserId, userId)));
        return result;
    }

    @Override
    public byte[] exportMarkdownZip(Long userId) {
        ensureSystemPages(userId);
        List<UserKnowledgePage> pages = pageMapper.selectList(new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getUserId, userId)
                .orderByAsc(UserKnowledgePage::getSortOrder)
                .orderByDesc(UserKnowledgePage::getUpdatedAt));
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (ZipOutputStream zip = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
                // 标题允许重复，且清洗/截断后也可能碰撞；zip 重名条目会直接抛异常导致整包失败
                java.util.Set<String> usedNames = new java.util.HashSet<>();
                for (UserKnowledgePage page : pages) {
                    String base = safeMarkdownFileName(page.getTitle());
                    String fileName = base + ".md";
                    if (!usedNames.add(fileName)) {
                        fileName = base + "-" + page.getId() + ".md";
                        usedNames.add(fileName);
                    }
                    zip.putNextEntry(new ZipEntry("wiki/" + fileName));
                    String content = markdownExportContent(page);
                    zip.write(content.getBytes(StandardCharsets.UTF_8));
                    zip.closeEntry();
                }
            }
            writeLog(userId, "wiki.export", null, null, null, "导出 Obsidian Markdown", "导出 " + pages.size() + " 个页面");
            return out.toByteArray();
        } catch (Exception e) {
            throw new BusinessException("导出失败：" + e.getMessage());
        }
    }

    private Map<String, Object> applyRevisionInternal(Long userId, UserKnowledgeRevision revision, Map<String, Object> body) {
        if (!"PENDING".equals(revision.getStatus())) {
            throw new BusinessException("该建议已处理");
        }
        if (body == null) body = Map.of();
        if ("DELETE".equalsIgnoreCase(revision.getActionType())) {
            if (revision.getPageId() != null) {
                UserKnowledgePage page = pageMapper.selectById(revision.getPageId());
                if (page != null && page.getUserId().equals(userId)) {
                    pageMapper.deleteById(page.getId());
                    clearPageLinks(userId, page.getId());
                }
            }
            revision.setStatus("APPROVED");
            revision.setAppliedAt(LocalDateTime.now());
            revisionMapper.updateById(revision);
            return revisionRow(revision);
        }

        String content = cleanMarkdownContent(value(body.get("content"), cryptoService.decrypt(revision.getEncryptedContent())));
        String title = value(body.get("title"), value(revision.getTitle(), "AI Wiki 草稿"));
        Long pageId = parseLong(body.get("pageId"));
        if (pageId == null) pageId = revision.getPageId();
        UserKnowledgePage page = pageId == null ? null : ownedPage(userId, pageId);
        if (page == null) {
            page = new UserKnowledgePage();
            page.setUserId(userId);
        }
        Long parentId = parseLong(body.get("parentId"));
        if (parentId != null) ownedPage(userId, parentId);
        page.setParentId(parentId);
        page.setTitle(limit(title, 120));
        page.setPageType(limit(value(body.get("pageType"), value(page.getPageType(), inferPageType(title, content))).toUpperCase(), 40));
        page.setSortOrder(defaultInt(body.get("sortOrder"), page.getSortOrder() == null ? 0 : page.getSortOrder()));
        page.setPinned(body.containsKey("pinned")
                ? (booleanValue(body.get("pinned")) ? 1 : 0)
                : (page.getPinned() == null ? 0 : page.getPinned()));
        page.setEncryptedContent(cryptoService.encrypt(content));
        page.setContentSummary(limit(content.replaceAll("\\s+", " "), 500));
        page.setSourceMessageId(revision.getSourceMessageId());
        page.setSourceConversationId(revision.getSourceConversationId());
        page.setEncryptionVersion("v1");
        if (page.getId() == null) {
            pageMapper.insert(page);
        } else {
            pageMapper.updateById(page);
        }
        syncPageLinks(userId, page.getId(), content);
        revision.setPageId(page.getId());
        revision.setStatus("APPROVED");
        revision.setAppliedAt(LocalDateTime.now());
        revisionMapper.updateById(revision);
        writeLog(userId, "revision.apply", page.getId(), revision.getPatchSetId(), null,
                "合入知识草稿：" + page.getTitle(), page.getContentSummary());
        return pageRow(pageMapper.selectById(page.getId()));
    }

    private KnowledgePatchSet ownedPatchSet(Long userId, Long id) {
        KnowledgePatchSet patchSet = patchSetMapper.selectOne(new LambdaQueryWrapper<KnowledgePatchSet>()
                .eq(KnowledgePatchSet::getId, id)
                .eq(KnowledgePatchSet::getUserId, userId));
        if (patchSet == null) {
            throw new BusinessException("Wiki 变更包不存在或无权访问");
        }
        return patchSet;
    }

    private KnowledgeSource ownedSource(Long userId, Long id) {
        KnowledgeSource source = sourceMapper.selectOne(new LambdaQueryWrapper<KnowledgeSource>()
                .eq(KnowledgeSource::getId, id)
                .eq(KnowledgeSource::getUserId, userId));
        if (source == null) {
            throw new BusinessException("Raw Source 不存在或无权访问");
        }
        return source;
    }

    private Map<String, Object> patchSetRow(KnowledgePatchSet patchSet) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", patchSet.getId());
        row.put("title", patchSet.getTitle());
        row.put("summary", patchSet.getSummary());
        row.put("status", patchSet.getStatus());
        row.put("triggerType", patchSet.getTriggerType());
        row.put("sourceConversationId", patchSet.getSourceConversationId());
        row.put("sourceMessageId", patchSet.getSourceMessageId());
        row.put("createdAt", patchSet.getCreatedAt());
        row.put("appliedAt", patchSet.getAppliedAt());
        List<UserKnowledgeRevision> revisions = revisionMapper.selectList(new LambdaQueryWrapper<UserKnowledgeRevision>()
                .eq(UserKnowledgeRevision::getUserId, patchSet.getUserId())
                .eq(UserKnowledgeRevision::getPatchSetId, patchSet.getId())
                .orderByAsc(UserKnowledgeRevision::getId));
        row.put("items", revisions.stream().map(this::revisionRow).toList());
        row.put("itemCount", revisions.size());
        return row;
    }

    private List<Map<String, Object>> listLinks(Long userId) {
        return linkMapper.selectList(new LambdaQueryWrapper<KnowledgePageLink>()
                .eq(KnowledgePageLink::getUserId, userId)
                .orderByDesc(KnowledgePageLink::getCreatedAt))
                .stream().map(this::linkRow).toList();
    }

    private List<Map<String, Object>> listSources(Long userId, int limit) {
        return sourceMapper.selectList(new LambdaQueryWrapper<KnowledgeSource>()
                .eq(KnowledgeSource::getUserId, userId)
                .orderByDesc(KnowledgeSource::getCreatedAt)
                .last("LIMIT " + Math.max(1, limit)))
                .stream().map(this::sourceRow).toList();
    }

    private List<Map<String, Object>> listOperationLogs(Long userId, int limit) {
        return operationLogMapper.selectList(new LambdaQueryWrapper<KnowledgeOperationLog>()
                .eq(KnowledgeOperationLog::getUserId, userId)
                .orderByDesc(KnowledgeOperationLog::getCreatedAt)
                .last("LIMIT " + Math.max(1, limit)))
                .stream().map(this::operationLogRow).toList();
    }

    private Map<String, Object> linkRow(KnowledgePageLink link) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", link.getId());
        row.put("sourcePageId", link.getSourcePageId());
        row.put("targetPageId", link.getTargetPageId());
        row.put("targetTitle", link.getTargetTitle());
        row.put("linkType", link.getLinkType());
        row.put("anchorText", link.getAnchorText());
        row.put("createdAt", link.getCreatedAt());
        return row;
    }

    private Map<String, Object> sourceRow(KnowledgeSource source) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", source.getId());
        row.put("sourceType", source.getSourceType());
        row.put("title", source.getTitle());
        row.put("sourceRef", source.getSourceRef());
        row.put("summary", source.getContentSummary());
        row.put("conversationId", source.getConversationId());
        row.put("messageId", source.getMessageId());
        row.put("createdAt", source.getCreatedAt());
        return row;
    }

    private Map<String, Object> operationLogRow(KnowledgeOperationLog log) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", log.getId());
        row.put("operationType", log.getOperationType());
        row.put("pageId", log.getPageId());
        row.put("patchSetId", log.getPatchSetId());
        row.put("sourceId", log.getSourceId());
        row.put("title", log.getTitle());
        row.put("detail", log.getDetail());
        row.put("createdAt", log.getCreatedAt());
        return row;
    }

    private void syncPageLinks(Long userId, Long pageId, String content) {
        clearPageLinks(userId, pageId);
        Matcher matcher = WIKI_LINK_PATTERN.matcher(value(content, ""));
        Set<String> seen = new HashSet<>();
        while (matcher.find()) {
            String targetTitle = matcher.group(1).trim();
            if (targetTitle.isBlank() || !seen.add(normalizeTitle(targetTitle))) continue;
            UserKnowledgePage target = findPageByTitle(userId, targetTitle);
            KnowledgePageLink link = new KnowledgePageLink();
            link.setUserId(userId);
            link.setSourcePageId(pageId);
            link.setTargetPageId(target == null ? null : target.getId());
            link.setTargetTitle(limit(targetTitle, 180));
            link.setAnchorText(limit(targetTitle, 180));
            link.setLinkType("WIKI");
            linkMapper.insert(link);
        }
    }

    private void clearPageLinks(Long userId, Long pageId) {
        List<KnowledgePageLink> links = linkMapper.selectList(new LambdaQueryWrapper<KnowledgePageLink>()
                .eq(KnowledgePageLink::getUserId, userId)
                .eq(KnowledgePageLink::getSourcePageId, pageId));
        for (KnowledgePageLink link : links) {
            linkMapper.deleteById(link.getId());
        }
    }

    private UserKnowledgePage findPageByTitle(Long userId, String title) {
        String normalized = normalizeTitle(title);
        return pageMapper.selectList(new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getUserId, userId))
                .stream()
                .filter(page -> normalizeTitle(page.getTitle()).equals(normalized))
                .findFirst()
                .orElse(null);
    }

    private void writeLog(Long userId, String type, Long pageId, Long patchSetId, Long sourceId, String title, String detail) {
        KnowledgeOperationLog log = new KnowledgeOperationLog();
        log.setUserId(userId);
        log.setOperationType(limit(type, 40));
        log.setPageId(pageId);
        log.setPatchSetId(patchSetId);
        log.setSourceId(sourceId);
        log.setTitle(limit(value(title, type), 180));
        log.setDetail(limit(detail, 1200));
        operationLogMapper.insert(log);
    }

    private void ensureSystemPages(Long userId) {
        ensureSystemPage(userId, "index", "INDEX", buildIndexPageContent(userId), 1);
        ensureSystemPage(userId, "log", "LOG", buildLogPageContent(userId), 2);
        ensureSystemPage(userId, "Wiki 维护规则", "SCHEMA", defaultSchemaContent(), 3);
    }

    private void ensureSystemPage(Long userId, String title, String type, String content, int order) {
        UserKnowledgePage existing = findPageByTitle(userId, title);
        if (existing == null) {
            UserKnowledgePage page = new UserKnowledgePage();
            page.setUserId(userId);
            page.setParentId(null);
            page.setTitle(title);
            page.setPageType(type);
            page.setSortOrder(order);
            page.setPinned(1);
            page.setEncryptedContent(cryptoService.encrypt(content));
            page.setContentSummary(limit(content.replaceAll("\\s+", " "), 500));
            page.setEncryptionVersion("v1");
            pageMapper.insert(page);
            syncPageLinks(userId, page.getId(), content);
        } else if ("INDEX".equals(type) || "LOG".equals(type) || "SCHEMA".equals(type)) {
            existing.setEncryptedContent(cryptoService.encrypt(content));
            existing.setContentSummary(limit(content.replaceAll("\\s+", " "), 500));
            existing.setPinned(1);
            // 自愈：历史数据里系统页的类型/挂载点可能被改坏（曾导致 index 摘要递归自嵌套），强制恢复规范值
            existing.setPageType(type);
            existing.setParentId(null);
            existing.setSortOrder(order);
            pageMapper.updateById(existing);
            syncPageLinks(userId, existing.getId(), content);
        }
    }

    private String buildIndexPageContent(Long userId) {
        List<UserKnowledgePage> pages = pageMapper.selectList(new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getUserId, userId)
                .orderByAsc(UserKnowledgePage::getPageType)
                .orderByAsc(UserKnowledgePage::getTitle));
        StringBuilder builder = new StringBuilder("# index\n\n");
        String currentType = "";
        for (UserKnowledgePage page : pages) {
            // 按类型和标题双重排除自身：类型被改坏的 index 页若被列入，
            // 其摘要（上一版 index 压平文本）会随每次重建递归自嵌套
            if ("INDEX".equals(page.getPageType())) continue;
            if (page.getTitle() != null && "index".equalsIgnoreCase(page.getTitle().trim())) continue;
            if (!String.valueOf(page.getPageType()).equals(currentType)) {
                currentType = String.valueOf(page.getPageType());
                builder.append("\n## ").append(typeLabelForMarkdown(currentType)).append("\n");
            }
            builder.append("- [[").append(page.getTitle()).append("]]");
            if (!shouldHideIndexSummary(page) && hasText(page.getContentSummary())) {
                builder.append(" — ").append(limit(stripMarkdownMarks(page.getContentSummary()), 90));
            }
            builder.append("\n");
        }
        return builder.toString().trim();
    }

    /**
     * 摘要是压平的页面正文，包含 # - > ` ** [[]] 等 markdown 记号，
     * 直接拼进 index 列表项会以原始符号展示，这里剥掉记号只留内文。
     */
    private String stripMarkdownMarks(String text) {
        if (text == null) {
            return "";
        }
        return text
                .replaceAll("\\[\\[([^\\]]*)\\]\\]", "$1")
                .replaceAll("\\[([^\\]]+)\\]\\([^)]*\\)", "$1")
                .replaceAll("\\[[ xX]\\]\\s*", "")
                .replaceAll("(?m)^\\s*(#{1,6}|[-*>]|\\d+[.)])\\s*", "")
                .replaceAll("\\s+(#{1,6}|[-*>])\\s+", " ")
                .replaceAll("[*`_~]", "")
                .replaceAll("\\s{2,}", " ")
                .trim();
    }

    private String buildLogPageContent(Long userId) {
        StringBuilder builder = new StringBuilder("# log\n\n");
        for (Map<String, Object> row : listOperationLogs(userId, 80)) {
            builder.append("## [").append(row.get("createdAt")).append("] ")
                    .append(row.get("operationType")).append(" | ")
                    .append(row.get("title")).append("\n\n");
        }
        return builder.toString().trim();
    }

    private String extractSourceUploadContent(MultipartFile file, String fileName, String contentType) {
        try {
            String lowerName = fileName.toLowerCase();
            if (FileParseUtil.isPdf(contentType) || lowerName.endsWith(".pdf")) {
                String text = FileParseUtil.extractPdfText(file);
                if (hasText(text)) {
                    return text;
                }
                return """
                        # %s

                        - 来源类型：扫描版 PDF 或无可提取文本 PDF
                        - 文件名：%s
                        - MIME：%s
                        - 大小：%d bytes

                        当前导入流程没有从这个 PDF 中抽取到文本。请在 AI 助手中使用视觉识别，或上传带文字层的 PDF 后再导入 Wiki。
                        """.formatted(stripExtension(fileName), fileName, contentType, file.getSize());
            }
            if (FileParseUtil.isExcel(contentType, fileName)) {
                return FileParseUtil.extractExcelText(file);
            }
            if (FileParseUtil.isText(contentType, fileName)) {
                return new String(file.getBytes(), StandardCharsets.UTF_8);
            }
            if (FileParseUtil.isImage(contentType) || isImageFileName(fileName)) {
                return """
                        # %s

                        - 来源类型：图片
                        - 文件名：%s
                        - MIME：%s
                        - 大小：%d bytes

                        为了避免把私密图片公开到 /uploads，也避免把大体积图片正文写进知识库，当前 Raw Source 只保存这条文件记录。

                        如果需要识别图片内容，请在 AI 助手上传图片完成视觉分析，再把识别结果导入 Wiki。
                        """.formatted(stripExtension(fileName), fileName, contentType, file.getSize());
            }
            throw new BusinessException("不支持的文件格式。支持：txt、md、csv、json、xml、pdf、xlsx、xls、png、jpg、jpeg、webp");
        } catch (BusinessException e) {
            throw e;
        } catch (IOException e) {
            throw new BusinessException("文件解析失败：" + e.getMessage());
        }
    }

    private String sourceTypeFromUpload(String contentType, String fileName) {
        String lowerName = fileName.toLowerCase();
        if (FileParseUtil.isPdf(contentType) || lowerName.endsWith(".pdf")) return "PDF";
        if (FileParseUtil.isExcel(contentType, fileName)) return "SHEET";
        if (FileParseUtil.isText(contentType, fileName)) return "TEXT";
        if (FileParseUtil.isImage(contentType) || isImageFileName(fileName)) return "IMAGE";
        return "FILE";
    }

    private boolean isImageFileName(String fileName) {
        String lowerName = value(fileName, "").toLowerCase();
        return lowerName.endsWith(".png")
                || lowerName.endsWith(".jpg")
                || lowerName.endsWith(".jpeg")
                || lowerName.endsWith(".webp")
                || lowerName.endsWith(".gif")
                || lowerName.endsWith(".bmp");
    }

    private String sanitizeFileName(String fileName) {
        String cleaned = value(fileName, "未命名文件").replace('\\', '_').replace('/', '_').trim();
        return cleaned.isBlank() ? "未命名文件" : limit(cleaned, 180);
    }

    private String stripExtension(String fileName) {
        String cleaned = sanitizeFileName(fileName);
        int index = cleaned.lastIndexOf('.');
        if (index <= 0) return cleaned;
        String title = cleaned.substring(0, index).trim();
        return title.isBlank() ? cleaned : title;
    }

    private String defaultSchemaContent() {
        return """
                # Wiki 维护规则

                ## 核心原则
                - Raw Sources 只记录原始来源，不在来源上直接改写。
                - Wiki Pages 是可维护的综合层，页面之间优先使用 [[双链]] 连接。
                - AI 只能生成待确认 Patch Set；用户确认后才合入。

                ## 页面约定
                - 目标、计划、偏好、薄弱点、资料、对话摘要分开建页。
                - 对话摘要属于高隐私页面，index 只保留 [[双链]]，不展示摘要或正文片段。
                - 重要结论尽量写来源或链接到相关页面。
                - 发现矛盾时，新建“冲突/待确认”小节，而不是静默覆盖。

                ## 维护动作
                - 每次合入后更新 index 和 log。
                - ingest/query/patch/lint/export 都应写入 log，方便回溯。
                - 定期运行 Wiki 健康检查，处理孤立页、缺失双链和过期计划。
                """.trim();
    }

    private boolean shouldHideIndexSummary(UserKnowledgePage page) {
        if (page == null) return false;
        String type = String.valueOf(page.getPageType()).toUpperCase();
        return "MEMORY".equals(type) || "LOG".equals(type) || "SCHEMA".equals(type);
    }

    private boolean isSystemKnowledgePage(UserKnowledgePage page) {
        if (page == null) return false;
        String type = String.valueOf(page.getPageType()).toUpperCase();
        if ("INDEX".equals(type) || "LOG".equals(type) || "SCHEMA".equals(type)) return true;
        // pageType 可能被历史请求改坏，而 ensureSystemPage 按标题查找并覆写内容，
        // 同名页面事实上就是系统页——标题才是稳定锚点
        return isSystemPageTitle(page.getTitle());
    }

    private boolean isSystemPageTitle(String title) {
        String trimmed = title == null ? "" : title.trim();
        return "index".equalsIgnoreCase(trimmed) || "log".equalsIgnoreCase(trimmed) || "Wiki 维护规则".equals(trimmed);
    }

    private String markdownExportContent(UserKnowledgePage page) {
        String content = cleanMarkdownContent(cryptoService.decrypt(page.getEncryptedContent()));
        // 标题必须加引号转义，否则「阶段: 复习」这类含冒号的标题会生成无效 YAML
        String yamlTitle = String.valueOf(page.getTitle()).replace("\\", "\\\\").replace("\"", "\\\"");
        return """
                ---
                title: "%s"
                type: %s
                updated: %s
                ---

                %s
                """.formatted(yamlTitle, page.getPageType(), page.getUpdatedAt(), content).trim();
    }

    private String safeMarkdownFileName(String title) {
        String value = value(title, "untitled").replaceAll("[\\\\/:*?\"<>|]", "-").trim();
        return value.isBlank() ? "untitled" : limit(value, 80);
    }

    private String normalizeTitle(String title) {
        return value(title, "").replaceAll("\\s+", "").toLowerCase();
    }

    private String typeLabelForMarkdown(String type) {
        return switch (String.valueOf(type)) {
            case "GOAL" -> "目标";
            case "PROJECT", "SCHEDULE" -> "计划";
            case "PREFERENCE", "REMINDER" -> "偏好";
            case "WEAKNESS" -> "薄弱点";
            case "RESOURCE", "MATERIAL" -> "资料";
            case "LOG" -> "日志";
            case "SCHEMA" -> "规则";
            case "MEMORY" -> "对话摘要";
            default -> "备注";
        };
    }

    private UserKnowledgePage ownedPage(Long userId, Long id) {
        UserKnowledgePage page = pageMapper.selectOne(new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getId, id)
                .eq(UserKnowledgePage::getUserId, userId));
        if (page == null) {
            throw new BusinessException("知识页不存在或无权访问");
        }
        return page;
    }

    private UserKnowledgeRevision ownedRevision(Long userId, Long id) {
        UserKnowledgeRevision revision = revisionMapper.selectOne(new LambdaQueryWrapper<UserKnowledgeRevision>()
                .eq(UserKnowledgeRevision::getId, id)
                .eq(UserKnowledgeRevision::getUserId, userId));
        if (revision == null) {
            throw new BusinessException("知识变更建议不存在或无权访问");
        }
        return revision;
    }

    private Map<String, Object> pageRow(UserKnowledgePage page) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", page.getId());
        row.put("parentId", page.getParentId());
        row.put("pageType", page.getPageType());
        row.put("sortOrder", page.getSortOrder());
        row.put("pinned", page.getPinned() != null && page.getPinned() == 1);
        row.put("title", page.getTitle());
        row.put("content", cryptoService.decrypt(page.getEncryptedContent()));
        row.put("summary", page.getContentSummary());
        row.put("sourceMessageId", page.getSourceMessageId());
        row.put("sourceConversationId", page.getSourceConversationId());
        row.put("lastUsedAt", page.getLastUsedAt());
        row.put("updatedAt", page.getUpdatedAt());
        return row;
    }

    private Map<String, Object> treeNode(UserKnowledgePage page) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", page.getId());
        row.put("parentId", page.getParentId());
        row.put("pageType", page.getPageType());
        row.put("sortOrder", page.getSortOrder());
        row.put("pinned", page.getPinned() != null && page.getPinned() == 1);
        row.put("title", page.getTitle());
        row.put("summary", page.getContentSummary());
        row.put("updatedAt", page.getUpdatedAt());
        row.put("children", new ArrayList<Map<String, Object>>());
        return row;
    }

    private Map<String, Object> documentNode(UserKnowledgePage page) {
        Map<String, Object> row = treeNode(page);
        row.put("content", cleanMarkdownContent(cryptoService.decrypt(page.getEncryptedContent())));
        row.put("sourceMessageId", page.getSourceMessageId());
        row.put("sourceConversationId", page.getSourceConversationId());
        row.put("lastUsedAt", page.getLastUsedAt());
        return row;
    }

    private String inferPageType(String title, String content) {
        String source = (value(title, "") + "\n" + value(content, "")).toLowerCase();
        if (source.contains("目标") || source.contains("goal")) {
            return "GOAL";
        }
        if (source.contains("偏好") || source.contains("习惯") || source.contains("preference")) {
            return "PREFERENCE";
        }
        if (source.contains("项目") || source.contains("计划") || source.contains("project") || source.contains("plan")) {
            return "PROJECT";
        }
        if (source.contains("薄弱") || source.contains("短板") || source.contains("weakness")) {
            return "WEAKNESS";
        }
        if (source.contains("时间") || source.contains("作息") || source.contains("schedule")) {
            return "SCHEDULE";
        }
        if (source.contains("提醒") || source.contains("deadline") || source.contains("ddl")) {
            return "REMINDER";
        }
        return "MEMORY";
    }

    private Map<String, Object> revisionRow(UserKnowledgeRevision revision) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", revision.getId());
        row.put("pageId", revision.getPageId());
        row.put("actionType", revision.getActionType());
        row.put("title", revision.getTitle());
        row.put("content", cryptoService.decrypt(revision.getEncryptedContent()));
        row.put("status", revision.getStatus());
        row.put("sourceMessageId", revision.getSourceMessageId());
        row.put("sourceConversationId", revision.getSourceConversationId());
        row.put("createdAt", revision.getCreatedAt());
        row.put("appliedAt", revision.getAppliedAt());
        return row;
    }

    private String required(Object value, String message) {
        String text = value(value, null);
        if (text == null) {
            throw new BusinessException(message);
        }
        return text;
    }

    private String value(Object value, String fallback) {
        if (value == null || value.toString().trim().isBlank()) {
            return fallback;
        }
        return value.toString().trim();
    }

    private boolean hasText(String value) {
        return value != null && !value.trim().isBlank();
    }

    private String limit(String value, int max) {
        if (value == null) {
            return null;
        }
        return value.length() <= max ? value : value.substring(0, max);
    }

    @SuppressWarnings("unchecked")
    private void sortTree(List<Map<String, Object>> nodes) {
        nodes.sort(Comparator
                .comparing((Map<String, Object> row) -> defaultInt(row.get("sortOrder"), 0))
                .thenComparing(row -> String.valueOf(row.get("title"))));
        for (Map<String, Object> node : nodes) {
            Object children = node.get("children");
            if (children instanceof List<?>) {
                sortTree((List<Map<String, Object>>) children);
            }
        }
    }

    private List<UserKnowledgePage> siblingPages(Long userId, Long parentId) {
        LambdaQueryWrapper<UserKnowledgePage> query = new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getUserId, userId)
                .orderByAsc(UserKnowledgePage::getSortOrder)
                .orderByDesc(UserKnowledgePage::getUpdatedAt);
        if (parentId == null) {
            query.isNull(UserKnowledgePage::getParentId);
        } else {
            query.eq(UserKnowledgePage::getParentId, parentId);
        }
        return pageMapper.selectList(query);
    }

    private boolean isDescendant(Long userId, Long possibleChildId, Long ancestorId) {
        UserKnowledgePage cursor = ownedPage(userId, possibleChildId);
        while (cursor.getParentId() != null) {
            if (cursor.getParentId().equals(ancestorId)) {
                return true;
            }
            cursor = ownedPage(userId, cursor.getParentId());
        }
        return false;
    }

    private String cleanMarkdownContent(String value) {
        if (value == null) {
            return "";
        }
        String text = value.replace("\r\n", "\n").replace("\r", "\n").trim();
        if (text.startsWith("```")) {
            text = text.replaceFirst("^```[A-Za-z0-9_-]*\\s*", "")
                    .replaceFirst("\\s*```$", "")
                    .trim();
        }
        List<String> lines = new ArrayList<>();
        for (String line : text.split("\n")) {
            String compact = line.replaceAll("\\s+", "");
            boolean emptyHeading = line.matches("^\\s*#{1,6}\\s*$");
            boolean wikiConfirmation = (compact.contains("已将") || compact.contains("已经") || compact.contains("已存入") || compact.contains("已写入"))
                    && (compact.toLowerCase().contains("wiki") || compact.contains("知识库") || compact.contains("知识树"));
            if (!emptyHeading && !wikiConfirmation) {
                lines.add(line);
            }
        }
        return String.join("\n", lines).trim();
    }

    private Long parseLong(Object value) {
        if (value == null || value.toString().trim().isBlank()) {
            return null;
        }
        try {
            return Long.parseLong(value.toString().trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private int defaultInt(Object value, int fallback) {
        if (value == null || value.toString().trim().isBlank()) {
            return fallback;
        }
        try {
            return Integer.parseInt(value.toString().trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private boolean booleanValue(Object value) {
        if (value instanceof Boolean bool) {
            return bool;
        }
        if (value == null) {
            return false;
        }
        return "true".equalsIgnoreCase(value.toString()) || "1".equals(value.toString());
    }
}
