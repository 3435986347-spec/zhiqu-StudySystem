package com.zhiqu;

import java.nio.file.Path;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertTrue;

class ModalScrollStabilityTest {
    @Test
    @DisplayName("发布的弹窗助手保持背景宽度与阅读位置：经典/浮动滚动条、稳定间隙、嵌套与乱序关闭")
    void backgroundWidthAndReadingPositionRemainStable() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/modal-scroll-check.js"), NodeRunner.API_JS));
    }
}
