package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;

/**
 * 「设置 → 账号与安全」里「登录设备」那一列：桌面应用、命令行、浏览器要分得开（第三十轮起实现在 assets/settings.js）。
 *
 * <p>「命令行」那一种来自 Java 版 zhiqu 的 UA（{@code ZhiquCLI/1.0 (系统 版本)}）。Java 版 2026-10-04 删除了，
 * 不会再有新的这种登录 —— 但已有的登录记录里还带着它，所以前端照样认，这里用它最后的真实格式喂。
 */
class LoginDeviceLabelTest {

    @Test
    @DisplayName("命令行 / 桌面应用 / 浏览器在登录设备列表里各自认得出")
    void 设备标签() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/ua-check.js"), NodeRunner.SETTINGS_JS,
                "ZhiquCLI/1.0 (Mac OS X 26.0)");
    }
}
