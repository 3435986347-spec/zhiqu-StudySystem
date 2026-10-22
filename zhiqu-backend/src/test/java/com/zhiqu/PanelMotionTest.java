package com.zhiqu;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PanelMotionTest {
    @Test
    @DisplayName("发布的面板折叠助手：初始状态、键盘焦点、移动浮层、快速反向、减少动态效果与桌面偏好")
    void panelStateAndAccessibility() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/panel-motion-check.js"),
                Path.of("src/main/resources/static/assets/zhiqu-ui.js")));
    }

    /**
     * 第七十轮（用户看到的）：Wiki 两侧面板默认收起，刷新时先按展开画出来，脚本加上「收起」时宽度一下缩到 44px，
     * 里面的内容却还要 0.12–0.24 秒才淡出、藏起来 —— 每次打开都闪一下被挤成一条、字一个一个竖着排的目录和页面检查。
     * 宽度的动画本来只在初始化完（zq-panel-ready）之后才有；内容和竖条的淡入淡出也得一样。
     */
    @Test
    @DisplayName("面板里内容和竖条的淡入淡出只在初始化完（zq-panel-ready）之后才有：刷新直接是收起后的样子，不闪一下挤扁的内容")
    void contentFadeOnlyAfterReady() throws Exception {
        String css = Files.readString(Path.of("src/main/resources/static/assets/zhiqu-ui.css"), StandardCharsets.UTF_8)
                .replaceAll("(?s)/\\*.*?\\*/", "");
        Matcher rule = Pattern.compile("([^{}]+)\\{([^{}]*)\\}").matcher(css);
        List<String> early = new ArrayList<>();
        int ready = 0;
        while (rule.find()) {
            String selector = rule.group(1).trim(), decl = rule.group(2);
            Matcher transition = Pattern.compile("(?:^|;)\\s*transition\\s*:([^;]+)").matcher(decl);
            if (!transition.find() || transition.group(1).trim().startsWith("none")) continue;
            for (String one : selector.split(",")) {
                one = one.trim();
                boolean panelPart = one.contains(">*:not(.zq-rail)") || one.matches(".*\\.zq-rail$");
                if (!panelPart) continue;
                if (one.contains(".zq-panel-ready")) ready++;
                else early.add(one);
            }
        }
        assertEquals(List.of(), early, "这些规则在面板初始化完之前就带着过渡 —— 刷新时会先闪一下挤扁的内容");
        assertTrue(ready >= 4, "只找到 " + ready + " 条初始化之后的过渡（内容出现 / 收起、竖条出现 / 消失）—— 扫空了？");
    }
}
