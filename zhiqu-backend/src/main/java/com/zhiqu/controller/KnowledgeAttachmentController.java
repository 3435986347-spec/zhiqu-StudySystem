package com.zhiqu.controller;

import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.knowledge.KnowledgeImageService;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.nio.charset.StandardCharsets;

/** Opaque vault attachments are authenticated downloads, never executable/public resources. */
@RestController
@RequestMapping("/api/knowledge/attachments")
public class KnowledgeAttachmentController {
    private final KnowledgeImageService attachments;

    public KnowledgeAttachmentController(KnowledgeImageService attachments) {
        this.attachments = attachments;
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
