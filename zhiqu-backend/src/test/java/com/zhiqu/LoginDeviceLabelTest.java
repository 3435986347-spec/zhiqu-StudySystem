package com.zhiqu;

import com.zhiqu.cli.CliUserAgent;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;

/**
 * 个人中心「登录设备」里那一列：桌面应用、命令行、浏览器要分得开。
 *
 * <p>CLI 的那一半直接用 {@code ZhiquCli.userAgent()} 的真实值去喂前端的 {@code shortUA} ——
 * 哪边改了格式另一边没跟上，这条就红。这里模拟 macOS，因为这台开发机的
 * {@code os.name} 决定不了判据该期望什么。
 */
class LoginDeviceLabelTest {

    @Test
    @DisplayName("命令行 / 桌面应用 / 浏览器在登录设备列表里各自认得出")
    void 设备标签() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/ua-check.js"), NodeRunner.API_JS,
                CliUserAgent.of("Mac OS X", "26.0"));
    }
}
