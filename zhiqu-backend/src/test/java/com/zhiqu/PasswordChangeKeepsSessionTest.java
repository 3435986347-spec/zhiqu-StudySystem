package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 改完密码，旧令牌全部作废（见 TokenRevocationIntegrationTest）—— 包括这个页面自己手里那张。
 * 所以页面必须把接口回来的新令牌存起来，否则用户刚改完密码，下一个请求就被踢回登录页。
 */
class PasswordChangeKeepsSessionTest {

    @Test
    @DisplayName("个人中心改密码：拿接口回来的新令牌 setAuth（记住我照旧），不然改完就被踢下线")
    void 改密码后存新令牌() throws Exception {
        String js = SourceText.stripComments(Files.readString(NodeRunner.API_JS));
        int call = js.indexOf("api.put('/user/password'");
        assertTrue(call > 0, "找不到改密码的调用 —— 判据跟着改");
        String after = js.substring(call, Math.min(js.length(), call + 400));
        int stored = after.indexOf("setAuth(");
        assertTrue(stored > 0, "改密码之后没有存新令牌：\n" + after);
        assertTrue(after.substring(stored).startsWith("setAuth({ token: fresh.token"), "存的不是接口回来的新令牌：\n" + after);
    }
}
