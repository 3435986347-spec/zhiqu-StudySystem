package com.zhiqu.conformance;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.service.workspace.TextEdit;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「按原文替换一段」的一致性用例 —— 网页 code agent 这一侧（{@link TextEdit}）。npm 版 zhiqu 的
 * {@code test/edit-conformance.test.js} 跑的是同一份 {@code conformance/text-edit.json}。
 */
class TextEditConformanceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode cases() throws Exception {
        return JSON.readTree(Files.readString(Path.of("../conformance/text-edit.json"))).path("cases");
    }

    @Test
    @DisplayName("用例文件没扫空，成功与拒绝两类都有")
    void 没扫空() throws Exception {
        JsonNode cases = cases();
        assertTrue(cases.size() >= 15, "只读到 " + cases.size() + " 条");
        boolean ok = false, refused = false;
        for (JsonNode c : cases) {
            ok |= c.path("expect").has("text");
            refused |= c.path("expect").has("error");
        }
        assertTrue(ok && refused);
    }

    @TestFactory
    List<DynamicTest> 每一条用例() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : cases()) {
            tests.add(DynamicTest.dynamicTest("替换：" + c.path("name").asText(), () -> check(c)));
        }
        return tests;
    }

    private static void check(JsonNode c) {
        TextEdit.Result r = TextEdit.apply(c.path("text").asText(), c.path("old").asText(), c.path("new").asText(),
                c.path("replaceAll").asBoolean(false));
        JsonNode e = c.path("expect");
        if (e.has("text")) {
            assertTrue(r.ok(), () -> TextEdit.describe(r.error(), "f"));
            assertEquals(e.path("text").asText(), r.text());
            if (e.has("replaced")) {
                assertEquals(e.path("replaced").asInt(), r.replaced());
            }
            return;
        }
        assertNotNull(r.error(), () -> "应当拒绝，却换成了：" + r.text());
        assertEquals(e.path("error").asText(), r.error().kind().name().toLowerCase());
        if ("ambiguous".equals(e.path("error").asText())) {
            assertEquals(e.path("count").asInt(), r.error().count());
            List<Integer> lines = new ArrayList<>();
            e.path("lines").forEach(n -> lines.add(n.asInt()));
            assertEquals(lines, r.error().lines());
        }
        if ("not_found".equals(e.path("error").asText())) {
            if (e.path("hint").isNull()) {
                assertNull(r.error().hint(), () -> "不该有线索：" + r.error().hint());
            } else {
                assertNotNull(r.error().hint());
                assertEquals(e.path("hint").asText(), r.error().hint().kind());
                if (e.has("from")) {
                    assertEquals(List.of(e.path("from").asInt(), e.path("to").asInt()),
                            List.of(r.error().hint().from(), r.error().hint().to()));
                }
                if (e.has("at")) {
                    assertEquals(e.path("at").asInt(), r.error().hint().at());
                }
            }
        }
        assertTrue(TextEdit.describe(r.error(), "f").length() > 0);
    }
}
