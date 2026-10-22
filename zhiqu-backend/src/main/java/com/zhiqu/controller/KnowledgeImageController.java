package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.knowledge.KnowledgeImageService;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/knowledge/images")
public class KnowledgeImageController {
    private final KnowledgeImageService images;

    public KnowledgeImageController(KnowledgeImageService images) {
        this.images = images;
    }

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<Map<String, Object>> upload(@RequestParam("file") MultipartFile file) {
        return Result.success(images.uploadOwnedImage(SecurityUtils.getCurrentUserId(), file).asMap());
    }

    @GetMapping
    public Result<List<KnowledgeImageService.ImageRecord>> list() {
        return Result.success(images.listOwnedImages(SecurityUtils.getCurrentUserId()));
    }

    /** Authenticated fetch to a browser Blob; no credentials or public upload path in the Markdown URL. */
    @GetMapping("/{id}")
    public ResponseEntity<byte[]> image(@PathVariable Long id) {
        KnowledgeImageService.ImageData data = images.readOwnedImage(SecurityUtils.getCurrentUserId(), id);
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(data.image().mimeType()))
                .header(HttpHeaders.CACHE_CONTROL, "private, no-store")
                .header("X-Content-Type-Options", "nosniff")
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.inline()
                        .filename(data.image().name(), StandardCharsets.UTF_8).build().toString())
                .body(data.bytes());
    }
}
