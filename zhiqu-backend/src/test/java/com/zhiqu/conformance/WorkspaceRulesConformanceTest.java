package com.zhiqu.conformance;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.service.workspace.WorkspaceExecutor;
import com.zhiqu.service.workspace.WorkspaceGuard;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 工作区安全规则的一致性用例 —— Java 这一侧。npm 版 zhiqu 的 {@code test/conformance.test.js} 跑的是同一份
 * {@code conformance/workspace-rules.json}。两份实现各自绿不算数；对同一份输入给出同样的结论才算数。
 */
class WorkspaceRulesConformanceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    static JsonNode fixture() throws IOException {
        return JSON.readTree(Files.readString(Path.of("../conformance/workspace-rules.json")));
    }

    /** 按 layout 搭目录；返回是否成功建出了软链。 */
    static boolean build(Path tmp, JsonNode layout) throws IOException {
        for (Iterator<Map.Entry<String, JsonNode>> it = layout.path("files").fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> e = it.next();
            Path file = tmp.resolve(e.getKey());
            Files.createDirectories(file.getParent());
            if (e.getValue().isObject()) {
                Files.write(file, new byte[e.getValue().path("bytes").asInt()]);
            } else {
                Files.writeString(file, e.getValue().asText(), StandardCharsets.UTF_8);
            }
        }
        for (JsonNode dir : layout.path("dirs")) {
            Files.createDirectories(tmp.resolve(dir.asText()));
        }
        try {
            for (Iterator<Map.Entry<String, JsonNode>> it = layout.path("symlinks").fields(); it.hasNext(); ) {
                Map.Entry<String, JsonNode> e = it.next();
                Files.createSymbolicLink(tmp.resolve(e.getKey()), Path.of(e.getValue().asText()));
            }
            return true;
        } catch (UnsupportedOperationException | IOException e) {
            return false;
        }
    }

    private static List<String> strings(JsonNode array) {
        List<String> out = new ArrayList<>();
        array.forEach(n -> out.add(n.asText()));
        return out;
    }

    @Test
    @DisplayName("读 / 写路径：每条用例的结论与共用用例一致（新建目录也一致）")
    void 路径(@TempDir Path tmp) throws IOException {
        JsonNode f = fixture();
        boolean symlinks = build(tmp, f.path("layout"));
        WorkspaceGuard guard = new WorkspaceGuard(tmp.resolve("root"), strings(f.path("extensions")),
                f.path("limits").path("maxFileBytes").asLong());
        List<String> mismatches = new ArrayList<>();
        int checked = 0;
        for (JsonNode c : f.path("read")) {
            if (c.path("needsSymlink").asBoolean() && !symlinks) continue;
            String got = guard.resolveReadable(c.path("path").asText()).reason().name();
            checked++;
            if (!got.equals(c.path("expect").asText())) mismatches.add("read " + c.path("path") + " 期望 " + c.path("expect") + " 实际 " + got);
        }
        for (JsonNode c : f.path("write")) {
            if (c.path("needsSymlink").asBoolean() && !symlinks) continue;
            String path = c.path("path").asText();
            String got = guard.resolveWritable(path).reason().name();
            checked++;
            if (!got.equals(c.path("expect").asText())) mismatches.add("write " + c.path("path") + " 期望 " + c.path("expect") + " 实际 " + got);
            if (c.has("newDirectories") && !strings(c.path("newDirectories")).equals(guard.missingParents(path))) {
                mismatches.add("write " + c.path("path") + " 新建目录 期望 " + c.path("newDirectories") + " 实际 " + guard.missingParents(path));
            }
        }
        assertTrue(checked >= 25, "用例几乎没跑（" + checked + " 条）—— 空扫描和全绿长得一样");
        assertEquals(List.of(), mismatches);
    }

    @Test
    @DisplayName("执行：命令名与参数的结论与共用用例一致")
    void 执行() throws IOException {
        JsonNode f = fixture();
        List<String> commands = strings(f.path("commands"));
        List<String> mismatches = new ArrayList<>();
        int checked = 0;
        for (JsonNode c : f.path("exec")) {
            String got = WorkspaceExecutor.check(commands, c.path("command").asText(), strings(c.path("args"))).refusal().name();
            checked++;
            if (!got.equals(c.path("expect").asText())) mismatches.add(c.path("command") + " " + c.path("args") + " 期望 " + c.path("expect") + " 实际 " + got);
        }
        assertTrue(checked >= 15, "用例几乎没跑（" + checked + " 条）");
        assertEquals(List.of(), mismatches);
    }
}
