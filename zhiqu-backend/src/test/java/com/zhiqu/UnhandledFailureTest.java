package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 事件处理里没接住的失败要说出来（第十四轮）。原来 onclick 里 {@code await api.post} 却没有 catch 的地方
 * （套用参考计划、点赞……）失败时页面上一个字都没有，用户以为没点上，接着点。
 * 行为判据跑在 node 上、直接加载发布的实现（unhandled-check.js）；这里另外钉住监听器真的装上了。
 */
class UnhandledFailureTest {

    @Test
    @DisplayName("没接住的失败：请求层的原样说、代码错误说「没有完成」、取消与跳登录时不吭声")
    void 兜底说出来() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/unhandled-check.js"), NodeRunner.API_JS);
    }

    @Test
    @DisplayName("unhandledrejection 的监听器装上了（函数写好了没人调，等于没有）")
    void 监听器装上了() throws Exception {
        String code = SourceText.stripComments(Files.readString(Path.of("src/main/resources/static/assets/zhiqu-api.js")));
        assertTrue(code.contains("window.addEventListener('unhandledrejection', function (e) { reportUnhandled(e.reason); });"),
                "没有把 reportUnhandled 挂到 unhandledrejection 上 —— 没接住的失败又会一声不吭");
    }
}
