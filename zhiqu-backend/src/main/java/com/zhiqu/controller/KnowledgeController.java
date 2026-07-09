package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.KnowledgeService;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/knowledge")
public class KnowledgeController {
    private final KnowledgeService knowledgeService;

    public KnowledgeController(KnowledgeService knowledgeService) {
        this.knowledgeService = knowledgeService;
    }

    @GetMapping("/pages")
    public Result<List<Map<String, Object>>> pages() {
        return Result.success(knowledgeService.listPages(SecurityUtils.getCurrentUserId()));
    }

    @GetMapping("/tree")
    public Result<List<Map<String, Object>>> tree() {
        return Result.success(knowledgeService.tree(SecurityUtils.getCurrentUserId()));
    }

    @GetMapping("/document-tree")
    public Result<List<Map<String, Object>>> documentTree() {
        return Result.success(knowledgeService.documentTree(SecurityUtils.getCurrentUserId()));
    }

    @GetMapping("/workspace")
    public Result<Map<String, Object>> workspace() {
        return Result.success(knowledgeService.workspace(SecurityUtils.getCurrentUserId()));
    }

    @GetMapping("/pages/{id}")
    public Result<Map<String, Object>> detail(@PathVariable Long id) {
        return Result.success(knowledgeService.detail(SecurityUtils.getCurrentUserId(), id));
    }

    @PostMapping("/pages")
    public Result<Map<String, Object>> createPage(@RequestBody Map<String, Object> body) {
        return Result.success(knowledgeService.savePage(SecurityUtils.getCurrentUserId(), null, body));
    }

    @PutMapping("/pages/{id}")
    public Result<Map<String, Object>> updatePage(@PathVariable Long id,
                                                  @RequestBody Map<String, Object> body) {
        return Result.success(knowledgeService.savePage(SecurityUtils.getCurrentUserId(), id, body));
    }

    @PutMapping("/pages/{id}/move")
    public Result<Map<String, Object>> movePage(@PathVariable Long id,
                                                @RequestBody Map<String, Object> body) {
        return Result.success(knowledgeService.movePage(SecurityUtils.getCurrentUserId(), id, body));
    }

    @DeleteMapping("/pages/{id}")
    public Result<Void> deletePage(@PathVariable Long id) {
        knowledgeService.deletePage(SecurityUtils.getCurrentUserId(), id);
        return Result.success();
    }

    @GetMapping("/revisions")
    public Result<List<Map<String, Object>>> revisions(@RequestParam(required = false) String status) {
        return Result.success(knowledgeService.listRevisions(SecurityUtils.getCurrentUserId(), status));
    }

    @PostMapping("/revisions/{id}/approve")
    public Result<Map<String, Object>> approveRevision(@PathVariable Long id) {
        return Result.success(knowledgeService.approveRevision(SecurityUtils.getCurrentUserId(), id));
    }

    @PostMapping("/revisions/{id}/apply")
    public Result<Map<String, Object>> applyRevision(@PathVariable Long id,
                                                     @RequestBody(required = false) Map<String, Object> body) {
        return Result.success(knowledgeService.applyRevision(SecurityUtils.getCurrentUserId(), id, body));
    }

    @PostMapping("/revisions/{id}/reject")
    public Result<Void> rejectRevision(@PathVariable Long id) {
        knowledgeService.rejectRevision(SecurityUtils.getCurrentUserId(), id);
        return Result.success();
    }

    @GetMapping("/patch-sets")
    public Result<List<Map<String, Object>>> patchSets(@RequestParam(required = false) String status) {
        return Result.success(knowledgeService.listPatchSets(SecurityUtils.getCurrentUserId(), status));
    }

    @PostMapping("/patch-sets")
    public Result<Map<String, Object>> createPatchSet(@RequestBody Map<String, Object> body) {
        return Result.success(knowledgeService.createPatchSet(SecurityUtils.getCurrentUserId(), body));
    }

    @GetMapping("/sources")
    public Result<Map<String, Object>> sources(@RequestParam(required = false) String q,
                                               @RequestParam(required = false) String type,
                                               @RequestParam(defaultValue = "1") Integer page,
                                               @RequestParam(defaultValue = "20") Integer size) {
        return Result.success(knowledgeService.listSources(SecurityUtils.getCurrentUserId(), q, type, page, size));
    }

    @PostMapping("/sources")
    public Result<Map<String, Object>> createSource(@RequestBody Map<String, Object> body) {
        return Result.success(knowledgeService.createSource(SecurityUtils.getCurrentUserId(), body));
    }

    @PostMapping(value = "/sources/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<Map<String, Object>> uploadSource(@RequestParam("file") MultipartFile file,
                                                    @RequestParam(required = false) String title) {
        return Result.success(knowledgeService.createSourceFromUpload(SecurityUtils.getCurrentUserId(), file, title));
    }

    @PostMapping("/sources/{id}/patch-set")
    public Result<Map<String, Object>> createPatchSetFromSource(@PathVariable Long id) {
        return Result.success(knowledgeService.createPatchSetFromSource(SecurityUtils.getCurrentUserId(), id));
    }

    @PostMapping("/patch-sets/{id}/apply")
    public Result<Map<String, Object>> applyPatchSet(@PathVariable Long id) {
        return Result.success(knowledgeService.applyPatchSet(SecurityUtils.getCurrentUserId(), id));
    }

    @PostMapping("/patch-sets/{id}/reject")
    public Result<Void> rejectPatchSet(@PathVariable Long id) {
        knowledgeService.rejectPatchSet(SecurityUtils.getCurrentUserId(), id);
        return Result.success();
    }

    @GetMapping("/graph")
    public Result<Map<String, Object>> graph() {
        return Result.success(knowledgeService.graph(SecurityUtils.getCurrentUserId()));
    }

    @PostMapping("/lint")
    public Result<Map<String, Object>> lint() {
        return Result.success(knowledgeService.lint(SecurityUtils.getCurrentUserId()));
    }

    @GetMapping("/lint/report")
    public Result<Map<String, Object>> lintReport() {
        return Result.success(knowledgeService.lintReport(SecurityUtils.getCurrentUserId()));
    }

    @GetMapping("/export/markdown")
    public ResponseEntity<byte[]> exportMarkdown() {
        byte[] body = knowledgeService.exportMarkdownZip(SecurityUtils.getCurrentUserId());
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment().filename("zhiqu-wiki-markdown.zip").build().toString())
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .body(body);
    }
}
