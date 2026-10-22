package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.knowledge.KnowledgeImageService;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/** Opaque vault attachments are authenticated downloads, never executable/public resources. */
@RestController
@RequestMapping("/api/knowledge/attachments")
public class KnowledgeAttachmentController {
    private final KnowledgeImageService attachments;

    public KnowledgeAttachmentController(KnowledgeImageService attachments) {
        this.attachments = attachments;
    }

    @GetMapping
    public Result<List<KnowledgeImageService.AttachmentRecord>> list() {
        return Result.success(attachments.listOwnedAttachments(SecurityUtils.getCurrentUserId()));
    }

    @GetMapping("/{id}/preview")
    public Result<Map<String, Object>> preview(@PathVariable Long id) {
        return Result.success(attachments.previewOwnedAttachment(SecurityUtils.getCurrentUserId(), id));
    }

    @GetMapping("/{id}")
    public ResponseEntity<byte[]> attachment(@PathVariable Long id) {
        KnowledgeImageService.AttachmentData data = attachments.readOwnedAttachment(SecurityUtils.getCurrentUserId(), id);
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .header(HttpHeaders.CACHE_CONTROL, "private, no-store")
                .header("X-Content-Type-Options", "nosniff")
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment()
                        .filename(data.attachment().name(), StandardCharsets.UTF_8).build().toString())
                .body(data.bytes());
    }
}
