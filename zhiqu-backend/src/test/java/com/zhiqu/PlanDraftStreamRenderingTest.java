package com.zhiqu;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

class PlanDraftStreamRenderingTest {
    @Test
    void 真实SSE草稿直接可确认且乱序和reload不重复弹窗() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/plan-stream-check.js"),
                Path.of("src/main/resources/static/assets/pages/ai-assistant.js")));
    }
}
