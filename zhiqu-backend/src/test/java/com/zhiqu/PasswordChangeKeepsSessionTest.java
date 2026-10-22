package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 改完密码，旧令牌全部作废（见 TokenRevocationIntegrationTest）—— 包括这个页面自己手里那张。
 * 所以页面必须把接口回来的新令牌存起来，否则用户刚改完密码，下一个请求就被踢回登录页。
 *
 * <p>第三十轮起改密码在设置弹窗里（assets/settings.js），存令牌在壳里（zhiqu-api.js 的 adoptNewToken，经 zqShared 给模块）——
 * 两半各钉一处：模块要把回来的令牌交出去，壳要真的存上。
 */
class PasswordChangeKeepsSessionTest {

    @Test
    @DisplayName("改密码：拿接口回来的新令牌 setAuth（记住我照旧），不然改完就被踢下线")
    void 改密码后存新令牌() throws Exception {
        String js = SourceText.stripComments(Files.readString(NodeRunner.SETTINGS_JS));
        int call = js.indexOf("var fresh = await sh.api.put('/user/password'");
        assertTrue(call > 0, "找不到改密码的调用 —— 判据跟着改");
        String after = js.substring(call, Math.min(js.length(), call + 300));
        assertTrue(after.contains("sh.adoptNewToken(fresh && fresh.token);"), "改密码之后没有把新令牌交给壳存上：\n" + after);

        String shell = SourceText.stripComments(Files.readString(NodeRunner.API_JS));
        int fn = shell.indexOf("function adoptNewToken(fresh) {");
        assertTrue(fn > 0, "壳里找不到 adoptNewToken");
        String body = shell.substring(fn, shell.indexOf("\n  }\n", fn));
        assertTrue(body.contains("setAuth({ token: fresh, role: role() || 'USER' }, Boolean(localStorage.getItem('token')));"),
                "存的不是接口回来的新令牌，或者「记住我」没照旧：\n" + body);
        assertTrue(shell.contains("adoptNewToken: adoptNewToken"), "adoptNewToken 没有经 zqShared 给模块");
    }
}
