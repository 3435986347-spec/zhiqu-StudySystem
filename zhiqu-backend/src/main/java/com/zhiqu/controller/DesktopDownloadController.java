package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.service.desktop.DesktopDownloads;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * 网页版里「下载桌面版」（第八十二轮）。两条都不用登录 —— 落地页上没登录的人也要能下（SecurityConfig 里放行）。
 *
 * <p>只认平台名（macos / windows），文件名从来不从请求里来；返回 {@link Resource}，Spring 自己处理 Range（一百多 MB 的包断了能接着下）。
 */
@RestController
@RequestMapping("/api/desktop/downloads")
public class DesktopDownloadController {

    private final DesktopDownloads downloads;

    public DesktopDownloadController(DesktopDownloads downloads) {
        this.downloads = downloads;
    }

    /** 各平台现在有没有安装包、多大、什么版本、SHA-256（没有的是 null）。 */
    @GetMapping
    public Result<Map<String, Object>> list() {
        return Result.success(downloads.listing());
    }

    @GetMapping("/{platform}")
    public ResponseEntity<Resource> download(@PathVariable String platform) {
        DesktopDownloads.Platform p = DesktopDownloads.Platform.of(platform).orElse(null);
        if (p == null) return ResponseEntity.notFound().build();
        DesktopDownloads.Installer installer = downloads.latest(p).orElse(null);
        if (installer == null) return ResponseEntity.notFound().build();
        // 中文文件名（知趣象限-1.0.0.dmg）：filename* 按 RFC 5987 带 UTF-8，老浏览器退回 ASCII 的那个
        ContentDisposition disposition = ContentDisposition.attachment().filename(installer.fileName(), StandardCharsets.UTF_8).build();
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(p.contentType))
                .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
                .header("X-Content-SHA256", installer.sha256())
                .body(new FileSystemResource(installer.path()));
    }
}
