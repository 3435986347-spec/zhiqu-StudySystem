package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.knowledge.KnowledgeVaultService;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.Map;

@RestController
@RequestMapping("/api/knowledge/vault")
public class KnowledgeVaultController {
    private final KnowledgeVaultService vault;
    public KnowledgeVaultController(KnowledgeVaultService vault) { this.vault = vault; }

    @GetMapping("/export.zip")
    public ResponseEntity<byte[]> export(@RequestParam(required = false) Long rootPageId) {
        return ResponseEntity.ok().contentType(MediaType.parseMediaType("application/zip"))
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename("zhiqu-wiki-vault.zip").build().toString())
                .body(vault.export(SecurityUtils.getCurrentUserId(), rootPageId));
    }

    @PostMapping(value = "/import/preview", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<Map<String, Object>> preview(@RequestParam("file") MultipartFile file,
                                               @RequestParam(required = false) Long parentId,
                                               @RequestParam(required = false) Integer parentVersion) {
        return Result.success(vault.preview(SecurityUtils.getCurrentUserId(), file, parentId, parentVersion));
    }

    @PostMapping(value = "/import/confirm", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<Map<String, Object>> confirm(@RequestParam("file") MultipartFile file,
                                               @RequestParam String previewToken,
                                               @RequestParam(required = false) Long parentId,
                                               @RequestParam(required = false) Integer parentVersion) {
        return Result.success(vault.confirm(SecurityUtils.getCurrentUserId(), file, previewToken, parentId, parentVersion));
    }
}
