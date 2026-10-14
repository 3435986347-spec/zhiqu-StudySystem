package com.zhiqu;

import java.nio.file.Path;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PanelMotionTest {
    @Test
    @DisplayName("发布的面板折叠助手：初始状态、键盘焦点、移动浮层、快速反向、减少动态效果与桌面偏好")
    void panelStateAndAccessibility() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/panel-motion-check.js"),
                Path.of("src/main/resources/static/assets/zhiqu-ui.js")));
    }
}
