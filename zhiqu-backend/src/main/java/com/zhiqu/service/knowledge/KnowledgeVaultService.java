package com.zhiqu.service.knowledge;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.KnowledgeOperationLog;
import com.zhiqu.entity.KnowledgePageLink;
import com.zhiqu.entity.UserKnowledgePage;
import com.zhiqu.mapper.KnowledgeOperationLogMapper;
import com.zhiqu.mapper.KnowledgePageLinkMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.mapper.UserKnowledgePageMapper;
import com.zhiqu.rag.RagIndexJobService;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Explicit preview/confirmation imports add new notes without overwriting existing knowledge. */
@Service
public class KnowledgeVaultService {
    private static final Pattern PRIVATE_ATTACHMENT = Pattern.compile("^/api/knowledge/(?:images|attachments)/(\\d+)$");
    private final UserKnowledgePageMapper pages;
    private final SysUserMapper users;
    private final KnowledgePageLinkMapper links;
    private final KnowledgeOperationLogMapper logs;
    private final SensitiveCryptoService crypto;
    private final RagIndexJobService rag;
    private final KnowledgeImageService attachments;
    private final KnowledgeVaultCodec codec = new KnowledgeVaultCodec();

    public KnowledgeVaultService(UserKnowledgePageMapper pages, SysUserMapper users, KnowledgePageLinkMapper links,
                                 KnowledgeOperationLogMapper logs, SensitiveCryptoService crypto,
                                 RagIndexJobService rag, KnowledgeImageService attachments) {
        this.pages = pages; this.users = users; this.links = links; this.logs = logs;
        this.crypto = crypto; this.rag = rag; this.attachments = attachments;
    }

    public Map<String, Object> preview(Long userId, MultipartFile file, Long parentId, Integer parentVersion) {
        ImportPlan plan = plan(userId, codec.decode(upload(file)), parentId, parentVersion);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("previewToken", plan.token());
        result.put("pageCount", plan.archive().notes().size());
        result.put("attachmentCount", plan.archive().attachments().size());
        result.put("relationshipCount", plan.relationshipCount());
        result.put("mode", "ADD_NEW");
        result.put("pages", plan.archive().notes().stream().map(note -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("path", note.path()); row.put("title", plan.titles().get(note.path()));
            row.put("originalTitle", note.title()); row.put("parentPath", note.parentPath());
            row.put("pageType", note.type()); row.put("folder", note.folder());
            row.put("contentPreview", note.content().substring(0, Math.min(1000, note.content().length())));
            return row;
        }).toList());
        result.put("attachments", plan.archive().attachments().entrySet().stream()
                .map(e -> Map.of("path", e.getKey(), "byteSize", e.getValue().length)).toList());
        result.put("warnings", plan.warnings().stream().limit(200).toList());
        result.put("warningCount", plan.warnings().size());
        return result;
    }

    @Transactional
    public Map<String, Object> confirm(Long userId, MultipartFile file, String previewToken, Long parentId, Integer parentVersion) {
        if (previewToken == null || previewToken.isBlank()) throw new BusinessException("请先预览 ZIP 内容再确认导入");
        // Reparse and recheck all ownership/collisions while the user's structural-write lock is held.
        if (users.lockKnowledgeTreeOwner(userId) == null) throw new BusinessException("用户不存在或无权修改知识目录");
        ImportPlan plan = plan(userId, codec.decode(upload(file)), parentId, parentVersion);
        if (!java.security.MessageDigest.isEqual(plan.token().getBytes(StandardCharsets.US_ASCII), previewToken.getBytes(StandardCharsets.US_ASCII)))
            throw new BusinessException("ZIP 或知识目录已变化，请重新预览后再导入");
        Map<String, String> attachmentUrls = new LinkedHashMap<>();
        for (var entry : plan.archive().attachments().entrySet()) {
            String path = entry.getKey();
            String name = path.substring(path.lastIndexOf('/') + 1);
            attachmentUrls.put(path, attachments.storeOwnedAttachment(userId, name, entry.getValue(), path).url());
        }
        Map<String, UserKnowledgePage> imported = new LinkedHashMap<>();
        Map<String, String> contents = new LinkedHashMap<>();
        int order = 0;
        for (var note : plan.archive().notes()) {
            String content = importContent(note, plan, attachmentUrls);
            UserKnowledgePage page = new UserKnowledgePage();
            page.setUserId(userId);
            page.setTitle(plan.titles().get(note.path()));
            page.setPageType(note.type());
            page.setParentId(note.parentPath() == null ? parentId : imported.get(note.parentPath()).getId());
            page.setSortOrder(order++ * 10); page.setPinned(0); page.setVersion(0); page.setDeleted(0);
            page.setEncryptedContent(crypto.encrypt(content)); page.setEncryptionVersion("v1");
            page.setContentSummary(content.replaceAll("\\s+", " ").substring(0, Math.min(500, content.replaceAll("\\s+", " ").length())));
            if (pages.insert(page) != 1 || page.getId() == null) throw new BusinessException("ZIP 知识页导入失败，请重试");
            imported.put(note.path(), page); contents.put(note.path(), content);
            rag.enqueueWikiPageChanged(userId, page.getId());
        }
        // Resolve links after every target exists. Forward references therefore have actual target ids.
        Map<String, UserKnowledgePage> targets = new LinkedHashMap<>();
        imported.values().forEach(page -> targets.put(titleKey(page.getTitle()), page));
        int relationshipCount = 0;
        for (var entry : imported.entrySet()) {
            Set<String> seen = new HashSet<>();
            for (var link : VaultMarkdownLinks.read(contents.get(entry.getKey()))) {
                if (link.image() || !link.wiki() || link.target().isBlank()) continue;
                String key = titleKey(link.target());
                if (!seen.add(key)) continue;
                UserKnowledgePage target = targets.get(key);
                KnowledgePageLink row = new KnowledgePageLink();
                row.setUserId(userId); row.setSourcePageId(entry.getValue().getId());
                row.setTargetPageId(target == null ? null : target.getId()); row.setTargetTitle(link.target());
                row.setLinkType("WIKI"); row.setAnchorText(link.label() == null ? link.target() : link.label());
                if (links.insert(row) != 1) throw new BusinessException("ZIP 双链导入失败，请重试");
                relationshipCount++;
            }
        }
        log(userId, "wiki.vault.import", "导入 Obsidian ZIP", "新增 " + imported.size() + " 页、"
                + attachmentUrls.size() + " 个附件、" + relationshipCount + " 条双链");
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("pageCount", imported.size()); result.put("attachmentCount", attachmentUrls.size());
        result.put("relationshipCount", relationshipCount);
        result.put("pageIds", imported.values().stream().map(UserKnowledgePage::getId).toList());
        result.put("pages", imported.entrySet().stream().map(e -> Map.of("path", e.getKey(), "id", e.getValue().getId(), "title", e.getValue().getTitle())).toList());
        return result;
    }

    public byte[] export(Long userId, Long rootPageId) {
        List<UserKnowledgePage> owned = ownedPages(userId);
        Map<Long, UserKnowledgePage> byId = new LinkedHashMap<>();
        owned.forEach(page -> byId.put(page.getId(), page));
        if (rootPageId != null && !byId.containsKey(rootPageId)) throw new BusinessException("知识页不存在或无权访问");
        List<UserKnowledgePage> selected = rootPageId == null ? owned : owned.stream().filter(page -> inSubtree(page, rootPageId, byId)).toList();
        if (selected.size() > KnowledgeVaultCodec.MAX_NOTES) throw new BusinessException("导出笔记超过 1000 页，请选择较小的目录");
        List<KnowledgeVaultCodec.ExportNote> notes = new ArrayList<>(selected.size());
        long noteBytes = 0;
        for (UserKnowledgePage page : selected) {
            String content = crypto.decrypt(page.getEncryptedContent());
            if (content.length() > KnowledgeVaultCodec.MAX_EXPANDED_BYTES) throw exportTooLarge();
            noteBytes += content.getBytes(StandardCharsets.UTF_8).length;
            if (noteBytes > KnowledgeVaultCodec.MAX_EXPANDED_BYTES) throw exportTooLarge();
            notes.add(new KnowledgeVaultCodec.ExportNote(page.getId(), page.getId().equals(rootPageId) ? null : page.getParentId(),
                    page.getTitle(), page.getPageType(), content));
        }
        Map<Long, String> paths = codec.exportPaths(notes);
        Map<String, String> titlePaths = new LinkedHashMap<>();
        notes.stream().sorted(Comparator.comparing(KnowledgeVaultCodec.ExportNote::id)).forEach(note -> titlePaths.putIfAbsent(titleKey(note.title()), paths.get(note.id()).replaceAll("\\.md$", "")));
        Map<Long, KnowledgeImageService.AttachmentRecord> metadata = new LinkedHashMap<>();
        attachments.listOwnedAttachments(userId).forEach(item -> metadata.put(item.id(), item));
        Set<Long> needed = new LinkedHashSet<>();
        if (rootPageId == null) needed.addAll(metadata.keySet());
        for (var note : notes) for (var link : VaultMarkdownLinks.read(note.content())) {
            Matcher match = PRIVATE_ATTACHMENT.matcher(link.target());
            if (match.matches()) needed.add(Long.parseLong(match.group(1)));
        }
        if (notes.size() + needed.size() > KnowledgeVaultCodec.MAX_ENTRIES)
            throw new BusinessException("导出条目超过 3000 个，请选择较小的目录");
        long estimatedBytes = noteBytes;
        for (Long id : needed) {
            var item = metadata.get(id);
            if (item == null) throw new BusinessException("知识页包含不可访问的附件，无法完整导出");
            if (item.byteSize() < 0 || item.byteSize() > KnowledgeImageService.MAX_IMAGE_BYTES)
                throw new BusinessException("附件数据损坏，请重新上传");
            estimatedBytes += item.byteSize();
            if (estimatedBytes > KnowledgeVaultCodec.MAX_EXPANDED_BYTES) throw exportTooLarge();
        }
        Map<String, byte[]> files = new LinkedHashMap<>();
        Set<String> used = new HashSet<>(); paths.values().forEach(path -> used.add(KnowledgeVaultCodec.fold(path)));
        Map<Long, String> attachmentPaths = new LinkedHashMap<>();
        long materializedAttachmentBytes = 0;
        for (Long id : needed) {
            var data = attachments.readOwnedAttachment(userId, id);
            var item = data.attachment();
            String original = item.originalPath();
            String path = original == null || original.isBlank() ? "attachments/" + portableAttachmentName(item.name(), id) : KnowledgeVaultCodec.safePath(original);
            if (!availablePath(used, path)) path = "attachments/" + portableAttachmentName(item.name(), id);
            int suffix = 2;
            String base = path;
            while (!availablePath(used, path)) path = "attachments/" + id + "-" + suffix++ + "-" + base.substring(base.lastIndexOf('/') + 1);
            used.add(KnowledgeVaultCodec.fold(path));
            byte[] bytes = data.bytes();
            materializedAttachmentBytes += bytes.length;
            if (noteBytes + materializedAttachmentBytes > KnowledgeVaultCodec.MAX_EXPANDED_BYTES) throw exportTooLarge();
            attachmentPaths.put(id, path); files.put(path, bytes);
        }
        long finalBytes = materializedAttachmentBytes;
        for (var note : notes) {
            String content = VaultMarkdownLinks.rewrite(note.content(), link -> {
                Matcher attachment = PRIVATE_ATTACHMENT.matcher(link.target());
                if (attachment.matches()) {
                    String target = attachmentPaths.get(Long.parseLong(attachment.group(1)));
                    if (target == null) throw new BusinessException("知识页包含不可访问的附件，无法完整导出");
                    if (link.wiki()) return (link.image() ? "!" : "") + "[[" + target + link.anchor() + (link.label() == null ? "" : "|" + link.label()) + "]]";
                    return (link.image() ? "!" : "") + "[" + safeLabel(link.label(), target) + "](" + urlPath(relativeAttachment(paths.get(note.id()), target)) + link.anchor() + ")";
                }
                if (link.wiki() && !link.image()) {
                    String target = titlePaths.get(titleKey(link.target()));
                    if (target != null) return "[[" + target + link.anchor() + "|" + safeLabel(link.label(), link.target()) + "]]";
                }
                return link.original();
            });
            byte[] markdownBytes = KnowledgeVaultCodec.exportedMarkdown(note, content).getBytes(StandardCharsets.UTF_8);
            finalBytes += markdownBytes.length;
            if (finalBytes > KnowledgeVaultCodec.MAX_EXPANDED_BYTES) throw exportTooLarge();
            files.put(paths.get(note.id()), markdownBytes);
        }
        byte[] result = codec.encode(files);
        log(userId, "wiki.vault.export", "导出 Obsidian ZIP", "导出 " + notes.size() + " 页、" + needed.size() + " 个附件");
        return result;
    }

    private ImportPlan plan(Long userId, KnowledgeVaultCodec.Archive archive, Long parentId, Integer parentVersion) {
        // A preview must catch the same unsupported/corrupt raster files that confirmation
        // would reject; otherwise an apparently valid plan fails only after the user confirms.
        for (var entry : archive.attachments().entrySet()) {
            if (KnowledgeImageService.isRasterName(entry.getKey())) {
                try { KnowledgeImageValidator.validate(entry.getValue()); }
                catch (BusinessException e) { throw new BusinessException("ZIP 图片无效：" + entry.getKey() + "；" + e.getMessage()); }
            }
        }
        List<UserKnowledgePage> existing = ownedPages(userId);
        if (parentId != null) {
            UserKnowledgePage parent = existing.stream().filter(p -> parentId.equals(p.getId())).findFirst()
                    .orElseThrow(() -> new BusinessException("导入目录不存在或无权访问"));
            if (parentVersion == null || !parentVersion.equals(parent.getVersion())) throw new BusinessException("导入目录已变化，请刷新后重试");
            if (com.zhiqu.common.SystemPageTitles.matches(parent.getTitle()) || Set.of("INDEX", "LOG", "SCHEMA").contains(parent.getPageType()))
                throw new BusinessException("不能导入到系统页，请选择普通知识页或整个 Wiki");
        }
        Set<String> used = new HashSet<>(); existing.forEach(page -> used.add(titleKey(page.getTitle())));
        Map<String, String> titles = new LinkedHashMap<>();
        List<String> warnings = new ArrayList<>(archive.warnings());
        for (var note : archive.notes()) {
            String title = note.title();
            int seq = 2;
            while (!used.add(titleKey(title))) {
                String suffix = "（导入 " + seq++ + "）";
                title = note.title().substring(0, Math.min(note.title().length(), 120 - suffix.length())) + suffix;
            }
            titles.put(note.path(), title);
            if (!title.equals(note.title())) warnings.add("重名笔记将新增为「" + title + "」：" + note.path());
        }
        int relationCount = 0;
        int scannedLinks = 0;
        for (var note : archive.notes()) for (var link : VaultMarkdownLinks.read(note.content())) {
            if (++scannedLinks > 20000) throw new BusinessException("ZIP 引用超过 20000 条，请拆分导入");
            if (link.target().isBlank() || link.target().matches("^[A-Za-z][A-Za-z0-9+.-]*:.*")) continue;
            String notePath = resolveNote(archive, note.path(), link.target());
            String filePath = KnowledgeVaultCodec.resolve(note.path(), link.target(), archive.attachments().keySet());
            if (!link.image() && notePath != null) relationCount++;
            else if (filePath == null && (link.wiki() || link.image() || link.target().toLowerCase(Locale.ROOT).endsWith(".md")))
                warnings.add("未解析的引用保留原文：" + note.path() + " → " + link.target());
        }
        StringBuilder tokenData = new StringBuilder(archive.hash()).append('\n').append(userId).append('\n').append(parentId).append('\n').append(parentVersion);
        titles.forEach((path, title) -> tokenData.append('\n').append(path).append('\0').append(title));
        return new ImportPlan(archive, titles, warnings, relationCount, KnowledgeVaultCodec.sha256(tokenData.toString().getBytes(StandardCharsets.UTF_8)));
    }

    private String importContent(KnowledgeVaultCodec.Note note, ImportPlan plan, Map<String, String> attachmentUrls) {
        return VaultMarkdownLinks.rewrite(note.content(), link -> {
            String file = KnowledgeVaultCodec.resolve(note.path(), link.target(), attachmentUrls.keySet());
            if (file != null) {
                String url = attachmentUrls.get(file);
                boolean image = link.image() && url.startsWith("/api/knowledge/images/");
                if (image && link.wiki()) return "![[" + url + (link.label() == null ? "" : "|" + link.label()) + "]]";
                return (image ? "!" : "") + "[" + safeLabel(link.label(), link.target()) + "](" + url + link.anchor() + ")";
            }
            if (link.image()) return link.original();
            String target = resolveNote(plan.archive(), note.path(), link.target());
            return target == null ? link.original() : "[[" + plan.titles().get(target) + link.anchor()
                    + (link.label() == null ? "" : "|" + safeLabel(link.label(), link.target())) + "]]";
        });
    }

    private static String resolveNote(KnowledgeVaultCodec.Archive archive, String from, String target) {
        Set<String> paths = new LinkedHashSet<>(); archive.notes().forEach(n -> paths.add(n.path()));
        String path = KnowledgeVaultCodec.resolve(from, target, paths);
        if (path != null) return path;
        if (target.contains("/") || target.contains(":") || target.isBlank()) return null;
        var matches = archive.notes().stream().filter(n -> titleKey(n.title()).equals(titleKey(target))).toList();
        return matches.size() == 1 ? matches.get(0).path() : null;
    }
    private List<UserKnowledgePage> ownedPages(Long userId) {
        return pages.selectList(new LambdaQueryWrapper<UserKnowledgePage>().eq(UserKnowledgePage::getUserId, userId).orderByAsc(UserKnowledgePage::getId));
    }
    private byte[] upload(MultipartFile file) {
        if (file == null || file.isEmpty() || file.getSize() > KnowledgeVaultCodec.MAX_ZIP_BYTES) throw new BusinessException("请选择不超过 20 MiB 的 ZIP 包");
        try { return file.getBytes(); } catch (Exception e) { throw new BusinessException("ZIP 文件无法读取"); }
    }
    private static boolean inSubtree(UserKnowledgePage page, Long root, Map<Long, UserKnowledgePage> pages) {
        Set<Long> visited = new HashSet<>();
        while (page != null) {
            if (root.equals(page.getId())) return true;
            if (!visited.add(page.getId())) throw new BusinessException("知识目录包含循环关系，无法导出");
            page = pages.get(page.getParentId());
        }
        return false;
    }
    private static boolean availablePath(Set<String> used, String path) {
        String key = KnowledgeVaultCodec.fold(path);
        return used.stream().noneMatch(p -> p.equals(key) || p.startsWith(key + "/") || key.startsWith(p + "/"));
    }
    private static String portableAttachmentName(String name, Long id) {
        String safe = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "-").replaceAll("[ .]+$", "");
        if (safe.isBlank()) safe = "attachment";
        return id + "-" + safe;
    }
    private static String titleKey(String title) { return KnowledgeVaultCodec.fold(title).replaceAll("\\s+", ""); }
    private static BusinessException exportTooLarge() { return new BusinessException("导出内容超过 64 MiB，请选择较小的目录"); }
    private static String safeLabel(String label, String fallback) { return (label == null ? fallback : label).replaceAll("[\\[\\]\\r\\n]", " "); }
    private static String urlPath(String path) { return java.net.URLEncoder.encode(path, StandardCharsets.UTF_8).replace("+", "%20").replace("%2F", "/"); }
    private static String relativeAttachment(String notePath, String attachmentPath) {
        int slash = notePath.lastIndexOf('/');
        java.nio.file.Path directory = java.nio.file.Path.of(slash < 0 ? "" : notePath.substring(0, slash));
        return directory.relativize(java.nio.file.Path.of(attachmentPath)).toString().replace('\\', '/');
    }
    private void log(Long userId, String operation, String title, String detail) {
        KnowledgeOperationLog row = new KnowledgeOperationLog(); row.setUserId(userId); row.setOperationType(operation); row.setTitle(title); row.setDetail(detail);
        if (logs.insert(row) != 1) throw new BusinessException("知识库操作记录保存失败，请重试");
    }
    private record ImportPlan(KnowledgeVaultCodec.Archive archive, Map<String, String> titles, List<String> warnings, int relationshipCount, String token) { }
}
