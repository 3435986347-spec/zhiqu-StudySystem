package com.zhiqu.service.workspace;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 工作区默认的扩展名白名单（第八十一轮）。
 *
 * <p>用户在 AI 助手里说「画一张鳄鱼骑自行车」：写 crocodile_bike.svg 两次都被拒 —— 网页 / 桌面应用这边的白名单里没有 svg，
 * 命令行那边（zhiqu-cli/src/tools/guard.js）早就有。两边各写一份、各自增减，就会这样一边能写一边不能写。
 */
class WorkspaceExtensionsTest {

    /** 命令行那份 DEFAULT_EXTENSIONS（读源码，不在这里抄一份）。 */
    private static List<String> cliDefaults() throws IOException {
        String js = Files.readString(Path.of("../zhiqu-cli/src/tools/guard.js"), StandardCharsets.UTF_8);
        Matcher block = Pattern.compile("export const DEFAULT_EXTENSIONS = \\[([^\\]]*)\\]").matcher(js);
        assertTrue(block.find(), "zhiqu-cli/src/tools/guard.js 里找不到 DEFAULT_EXTENSIONS");
        List<String> out = new ArrayList<>();
        Matcher item = Pattern.compile("'([^']+)'").matcher(block.group(1).replaceAll("//[^\\n]*", ""));
        while (item.find()) out.add(item.group(1));
        assertTrue(out.size() >= 40, "只读到 " + out.size() + " 个扩展名 —— 扫空了？");
        return out;
    }

    @Test
    @DisplayName("网页 / 桌面应用的工作区和命令行用同一份扩展名白名单（原来网页这边少了 svg 等十几种）")
    void 和命令行一致() throws IOException {
        assertEquals(new TreeSet<>(cliDefaults()), new TreeSet<>(new WorkspaceProperties().getAllowedExtensions()),
                "两边的白名单不一样 —— 改一边要改另一边（WorkspaceProperties.allowedExtensions / guard.js 的 DEFAULT_EXTENSIONS）");
    }

    @Test
    @DisplayName("用默认白名单：svg 能写（用户要 AI 画的图），.env / 私钥 / 证书照样不进上下文")
    void svg能写密钥照样挡(@TempDir Path root) {
        WorkspaceGuard guard = new WorkspaceGuard(root, new WorkspaceProperties().getAllowedExtensions(), 256 * 1024);
        assertTrue(guard.extensionAllowed(root.resolve("crocodile_bike.svg")), "svg 写不进去");
        assertTrue(guard.extensionAllowed(root.resolve("drawing.SVG")), "大写的扩展名也认");
        for (String name : new String[]{".env", "id_rsa", "cert.pem", "server.key", "keystore.p12", "secrets.jks"}) {
            assertFalse(guard.extensionAllowed(root.resolve(name)), name + " 不该在白名单里");
        }
    }
}
