package com.zhiqu.desktop;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.NodeRunner;
import com.zhiqu.SourceText;
import com.zhiqu.controller.DesktopDownloadController;
import com.zhiqu.service.desktop.DesktopDownloads;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpHeaders;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * 网页版里下载桌面版（第八十二轮，docs/rounds/round-82.md）：安装包放在服务器的下载目录里，后端按平台给最新的那个，
 * 落地页和头像菜单打开同一个弹窗。不登录也能下由 {@code DesktopDownloadIntegrationTest} 在真的过滤器链上量。
 */
class DesktopDownloadTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    @TempDir Path dir;

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private Path put(String name, byte[] bytes, long epochSecond) throws Exception {
        Path f = dir.resolve(name);
        Files.write(f, bytes);
        Files.setLastModifiedTime(f, FileTime.from(Instant.ofEpochSecond(epochSecond)));
        return f;
    }

    private static byte[] bytes(int n, int seed) {
        byte[] b = new byte[n];
        for (int i = 0; i < n; i++) b[i] = (byte) (i * 31 + seed);
        return b;
    }

    @Test
    @DisplayName("每个平台取最新的那个（按修改时间），版本从文件名认，SHA-256 照文件算；别的扩展名、点开头的、符号链接、目录都不认")
    void 挑哪一个() throws Exception {
        byte[] newer = bytes(70_000, 7);
        put("知趣象限-0.9.0.dmg", bytes(1000, 1), 1_000);
        put("知趣象限-1.0.0.dmg", newer, 2_000);
        put("知趣象限-2.0.0.DMG.txt", bytes(10, 2), 9_000);           // 不是 dmg
        put(".知趣象限-3.0.0.dmg", bytes(10, 3), 9_000);              // 点开头（Finder 拷到一半的、隐藏的）
        put("知趣象限-4.0.0.exe", bytes(10, 4), 9_000);               // Windows 的，不是 Mac 的
        Files.createDirectory(dir.resolve("知趣象限-5.0.0.dmg"));    // 目录
        Files.setLastModifiedTime(dir.resolve("知趣象限-5.0.0.dmg"), FileTime.from(Instant.ofEpochSecond(9_000)));
        Path outside = Files.createTempFile("outside", ".dmg");
        try {
            Files.write(outside, bytes(10, 5));
            Files.createSymbolicLink(dir.resolve("知趣象限-6.0.0.dmg"), outside);   // 指到目录外面去的
            DesktopDownloads downloads = new DesktopDownloads(dir.toString());
            DesktopDownloads.Installer mac = downloads.latest(DesktopDownloads.Platform.MACOS).orElseThrow();
            assertEquals("知趣象限-1.0.0.dmg", mac.fileName(), "该挑最新的那个 dmg");
            assertEquals("1.0.0", mac.version());
            assertEquals(newer.length, mac.size());
            assertEquals(sha256(newer), mac.sha256(), "SHA-256 不对");
            assertEquals("知趣象限-4.0.0.exe", downloads.latest(DesktopDownloads.Platform.WINDOWS).orElseThrow().fileName(), "Windows 认 .exe");

            // 换了内容（大小、时间变了）：校验值重算，不拿记住的旧值
            byte[] changed = bytes(80_000, 9);
            put("知趣象限-1.0.0.dmg", changed, 3_000);
            assertEquals(sha256(changed), downloads.latest(DesktopDownloads.Platform.MACOS).orElseThrow().sha256(), "文件换了，校验值还是旧的");
        } finally {
            Files.deleteIfExists(outside);
        }
    }

    @Test
    @DisplayName("目录不存在、是空的：两个平台都是 null（前端说「还在准备」），不报错；平台名只认 macos / windows")
    void 没有的时候() throws Exception {
        DesktopDownloads missing = new DesktopDownloads(dir.resolve("nope").toString());
        Map<String, Object> listing = missing.listing();
        assertTrue(listing.containsKey("macos") && listing.containsKey("windows"), "两个平台都要在列表里");
        assertNull(listing.get("macos"));
        assertNull(listing.get("windows"));
        assertNull(new DesktopDownloads(dir.toString()).listing().get("macos"));
        assertTrue(DesktopDownloads.Platform.of("MacOS").isPresent() && DesktopDownloads.Platform.of(" windows ").isPresent());
        for (String bad : new String[]{"linux", "", null, "../macos", "macos/..", "dmg"}) {
            assertTrue(DesktopDownloads.Platform.of(bad).isEmpty(), "平台名「" + bad + "」不该认");
        }
    }

    @Test
    @DisplayName("接口：列表照实给；下载是附件、中文文件名按 RFC 5987、类型对、带校验值；Range 回 206 只给那一段（断了能接着下）；不认的平台、没有的包是 404")
    void 接口() throws Exception {
        byte[] dmg = bytes(50_000, 3);
        put("知趣象限-1.0.0.dmg", dmg, 2_000);
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new DesktopDownloadController(new DesktopDownloads(dir.toString()))).build();

        MvcResult list = mvc.perform(get("/api/desktop/downloads")).andReturn();
        Map<?, ?> body = new ObjectMapper().readValue(list.getResponse().getContentAsString(StandardCharsets.UTF_8), Map.class);
        assertEquals(200, body.get("code"));
        Map<?, ?> data = (Map<?, ?>) body.get("data");
        Map<?, ?> mac = (Map<?, ?>) data.get("macos");
        assertEquals("知趣象限-1.0.0.dmg", mac.get("fileName"));
        assertEquals("/api/desktop/downloads/macos", mac.get("url"));
        assertEquals(sha256(dmg), mac.get("sha256"));
        assertTrue(data.containsKey("windows") && data.get("windows") == null, "没有 Windows 包时要照实给 null");

        MvcResult whole = mvc.perform(get("/api/desktop/downloads/macos")).andReturn();
        assertEquals(200, whole.getResponse().getStatus());
        assertArrayEquals(dmg, whole.getResponse().getContentAsByteArray(), "下载下来的和目录里的不一样");
        assertEquals("application/x-apple-diskimage", whole.getResponse().getContentType());
        String cd = whole.getResponse().getHeader(HttpHeaders.CONTENT_DISPOSITION);
        assertTrue(cd != null && cd.startsWith("attachment;") && cd.contains("filename*=UTF-8''%E7%9F%A5%E8%B6%A3%E8%B1%A1%E9%99%90-1.0.0.dmg"),
                "要是附件、带 UTF-8 的中文文件名：" + cd);
        assertEquals(sha256(dmg), whole.getResponse().getHeader("X-Content-SHA256"));

        MvcResult part = mvc.perform(get("/api/desktop/downloads/macos").header(HttpHeaders.RANGE, "bytes=1000-1999")).andReturn();
        assertEquals(206, part.getResponse().getStatus(), "Range 没有回 206：一百多 MB 断了只能从头再下");
        assertArrayEquals(Arrays.copyOfRange(dmg, 1000, 2000), part.getResponse().getContentAsByteArray());
        assertEquals("bytes 1000-1999/" + dmg.length, part.getResponse().getHeader(HttpHeaders.CONTENT_RANGE));

        assertEquals(404, mvc.perform(get("/api/desktop/downloads/windows")).andReturn().getResponse().getStatus(), "没有 Windows 包应当 404");
        assertEquals(404, mvc.perform(get("/api/desktop/downloads/linux")).andReturn().getResponse().getStatus(), "不认的平台应当 404");
    }

    @Test
    @DisplayName("前端：认电脑、画弹窗、连点只开一个（node 上直接跑 zhiqu-api.js 里发布的那一段，喂它真的列表回包）")
    void 弹窗的行为() throws Exception {
        put("知趣象限-1.0.0.dmg", bytes(1234, 5), 2_000);
        String listing = new ObjectMapper().writeValueAsString(new DesktopDownloads(dir.toString()).listing());
        NodeRunner.run(Path.of("src/test/resources/js/desktop-download-check.js"), NodeRunner.API_JS, listing);
    }

    @Test
    @DisplayName("服务器上放安装包的脚本（install-desktop-download.ps1）：只有 ASCII（PowerShell 5.1 按 ANSI 读没 BOM 的脚本）、先拷成点开头的再改名、配置按 UTF-8 读写、键名和后端认的一样")
    void 服务器上放安装包的脚本() throws Exception {
        Path script = Path.of("../deploy/windows/install-desktop-download.ps1");
        byte[] raw = Files.readAllBytes(script);
        for (int i = 0; i < raw.length; i++) {
            assertTrue(raw[i] >= 0, "脚本里有非 ASCII 字符（第 " + i + " 个字节）：Windows PowerShell 5.1 会按 ANSI 读成乱码");
        }
        String code = String.join("\n", Files.readAllLines(script).stream().map(String::strip).filter(l -> !l.startsWith("#")).toList());
        int partial = code.indexOf("$partial = Join-Path $downloads (\".\" + $name + \".part\")");
        int copy = code.indexOf("Copy-Item -LiteralPath $Installer -Destination $partial -Force");
        int move = code.indexOf("Move-Item -LiteralPath $partial -Destination $final -Force");
        assertTrue(partial >= 0 && copy > partial && move > copy, "要先拷成点开头的 .part、拷完再改名（拷到一半时后端不认它）");
        assertFalse(code.contains("-Destination $final") && code.indexOf("-Destination $final") < move, "直接拷成最终的名字了");
        assertTrue(code.contains("[System.IO.File]::ReadAllText($config, $utf8)") && code.contains("[System.IO.File]::WriteAllText($config,"),
                "application-prod.yml 要按 UTF-8 读写");
        assertFalse(code.contains("Get-Content") || code.contains("Set-Content") || code.contains("Out-File"),
                "5.1 的 Get-Content / Set-Content 按 ANSI 读写，配置里的中文注释会坏");
        assertTrue(code.contains("\"desktop-downloads-dir: \""), "脚本写进配置的键名不对");
        String svc = Files.readString(Path.of("src/main/java/com/zhiqu/service/desktop/DesktopDownloads.java"), StandardCharsets.UTF_8);
        assertTrue(svc.contains("@Value(\"${app.desktop-downloads-dir:"), "后端认的键名变了，脚本写的那个就不起作用");
    }

    @Test
    @DisplayName("入口：落地页一个按钮、头像菜单一项，都打开同一个弹窗；桌面应用里两处都不出现；安装包不进 git、不进 JAR")
    void 入口() throws Exception {
        String index = Files.readString(STATIC.resolve("index.html"), StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", " ");
        assertEquals(1, index.split("data-zq-download", -1).length - 1, "落地页上应当正好一个「下载桌面版」");
        String api = SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-api.js"), StandardCharsets.UTF_8));
        assertTrue(api.contains("$all('[data-zq-download]').forEach(function (b) { b.onclick = function () { openDesktopDownload(); }; });"), "落地页的按钮没接上");
        assertTrue(api.contains("openDesktopDownload: openDesktopDownload"), "window.zqApi 上没有 openDesktopDownload，头像菜单打不开");
        String ui = SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-ui.js"), StandardCharsets.UTF_8));
        assertTrue(ui.contains("(document.documentElement.classList.contains('zq-desktop') ? '' : '<button type=\"button\" role=\"menuitem\" data-zq-download>"),
                "头像菜单的那项要在桌面应用里不画");
        assertTrue(ui.contains("if(e.target.closest('[data-zq-download]')){ closeMenu(); if(window.zqApi && window.zqApi.openDesktopDownload) window.zqApi.openDesktopDownload(); return; }"),
                "头像菜单的那项没接上");
        String css = SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8));
        assertTrue(css.contains("html.zq-desktop [data-zq-download]{display:none !important;}"), "桌面应用里落地页的按钮要藏起来");
        assertFalse(css.substring(css.indexOf("@media (max-width: 760px)")).contains(".zq-dl"), "下载弹窗的样子写进了手机那段");

        String gitignore = Files.readString(Path.of("../.gitignore"), StandardCharsets.UTF_8);
        assertTrue(gitignore.lines().anyMatch("downloads/"::equals), "downloads/ 要进 .gitignore（dmg 一百多 MB，GitHub 单个文件上限 100MB）");
        try (var files = Files.walk(STATIC)) {
            assertTrue(files.noneMatch(f -> f.toString().matches("(?i).*\\.(dmg|exe|msi)$")), "安装包放进了 static/（会打进 JAR，桌面包里再装一份安装包）");
        }
    }
}
