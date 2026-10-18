package com.zhiqu;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 知识 Wiki 换编辑内核的验证（第七十轮，docs/rounds/round-70.md）：CodeMirror 6 的实时预览，开关后面、默认关。
 * 现在的编辑器不改内容保存回来 14 页里 0 页逐字节一样（嵌套列表压平、代码块语言丢、表格对齐丢、硬换行丢、转义的 \[ \] 变成公式块）；
 * 验证版编辑的就是 Markdown 原文，14/14 一样。
 */
class WikiEditorSpikeTest {

    private static final Path VENDOR = Path.of("src/main/resources/static/assets/vendor/codemirror");

    @Test
    @DisplayName("接入（node 里跑发布的 knowledge-wiki.js / wiki-cm.js）：开着才挂、保存发原文不经过 htmlToMarkdown、换页拆掉、只读和工具栏接上、关着一点不碰；扫描双链 / 公式")
    void 接入() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/wiki-cm-check.js"),
                Path.of("src/main/resources/static/assets/pages/knowledge-wiki.js"),
                "src/main/resources/static/assets/wiki-cm.js");
    }

    @Test
    @DisplayName("打进来的 CodeMirror 和清单对得上：文件的 SHA256 和大小、每个包都是 MIT、许可证全文在、没有带进 HTML / CSS / JS 语言包")
    void 清单() throws Exception {
        JsonNode versions = new ObjectMapper().readTree(Files.readString(VENDOR.resolve("VERSIONS.json")));
        byte[] bundle = Files.readAllBytes(VENDOR.resolve("codemirror.js"));
        assertEquals(versions.get("sha256").asText(), HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bundle)),
                "codemirror.js 和 VERSIONS.json 记的不一样 —— 重新打包要连清单一起换");
        assertEquals(versions.get("bytes").asInt(), bundle.length);
        int packages = 0;
        String license = Files.readString(VENDOR.resolve("LICENSE"));
        for (JsonNode pkg : versions.get("packages")) {
            packages++;
            assertEquals("MIT", pkg.get("license").asText(), pkg.get("name").asText() + " 不是 MIT");
            assertTrue(license.contains(pkg.get("name").asText() + "@" + pkg.get("version").asText()), pkg.get("name").asText() + " 的许可证全文没带上");
            assertTrue(!pkg.get("name").asText().matches("@codemirror/lang-(html|css|javascript)|@lezer/(html|css|javascript)"),
                    "又把 " + pkg.get("name").asText() + " 打进来了（Wiki 用不着，文件大一半）");
        }
        assertTrue(packages >= 10, "清单里只有 " + packages + " 个包");
    }
}
