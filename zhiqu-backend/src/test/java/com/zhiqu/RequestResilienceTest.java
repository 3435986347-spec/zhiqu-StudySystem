package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;

/**
 * 网页请求的超时与重试、聊天流的心跳帧与空闲超时 —— 行为判据跑在 node 上，直接加载发布的 zhiqu-api.js。
 * 判据本体：src/test/resources/js/request-check.js。
 */
class RequestResilienceTest {

    @Test
    @DisplayName("请求：GET 安全重试、写操作只在 429 重试、超时、非 JSON 说人话；SSE 心跳帧与空闲超时")
    void 请求与流() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/request-check.js"), NodeRunner.API_JS);
    }
}
