package com.zhiqu.service;

import java.util.List;
import java.util.Map;
import org.springframework.web.multipart.MultipartFile;

public interface KnowledgeService {
    List<Map<String, Object>> listPages(Long userId);

    List<Map<String, Object>> tree(Long userId);

    List<Map<String, Object>> documentTree(Long userId);

    Map<String, Object> workspace(Long userId);

    Map<String, Object> detail(Long userId, Long id);

    Map<String, Object> savePage(Long userId, Long id, Map<String, Object> body);

    Map<String, Object> movePage(Long userId, Long id, Map<String, Object> body);

    void deletePage(Long userId, Long id);

    List<Map<String, Object>> listRevisions(Long userId);

    List<Map<String, Object>> listRevisions(Long userId, String status);

    Map<String, Object> approveRevision(Long userId, Long id);

    Map<String, Object> applyRevision(Long userId, Long id, Map<String, Object> body);

    void rejectRevision(Long userId, Long id);

    List<Map<String, Object>> listPatchSets(Long userId, String status);

    Map<String, Object> createPatchSet(Long userId, Map<String, Object> body);

    Map<String, Object> listSources(Long userId, String query, String type, int page, int size);

    Map<String, Object> createSource(Long userId, Map<String, Object> body);

    Map<String, Object> createSourceFromUpload(Long userId, MultipartFile file, String title);

    Map<String, Object> createPatchSetFromSource(Long userId, Long sourceId);

    Map<String, Object> applyPatchSet(Long userId, Long id);

    void rejectPatchSet(Long userId, Long id);

    Map<String, Object> graph(Long userId);

    Map<String, Object> lint(Long userId);

    Map<String, Object> lintReport(Long userId);

    byte[] exportMarkdownZip(Long userId);
}
