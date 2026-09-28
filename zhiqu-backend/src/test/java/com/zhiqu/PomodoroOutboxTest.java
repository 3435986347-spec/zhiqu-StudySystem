package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 番茄钟的待补记（第二十二轮）：专注完的那一刻网断了，先存在这台设备上，连上网自动补记。
 * 行为判据跑在 node 上，直接加载发布的 zhiqu-api.js：src/test/resources/js/pomo-outbox-check.js。
 */
class PomodoroOutboxTest {

    @Test
    @DisplayName("先存再发；断网时照实说「先存着」；网回来用同一个键补记；跨了天带完成那天；拒了说原因；登录过期、别的账号的留着；同时补只发一次")
    void 待补记() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/pomo-outbox-check.js"), NodeRunner.API_JS);
    }

    @Test
    @DisplayName("接线：看板的番茄钟走 recordPomodoro（不再直接 post）；每一页打开时、网回来时、每分钟都补一趟")
    void 接线() throws Exception {
        String dashboard = SourceText.stripComments(Files.readString(Path.of("src/main/resources/static/dashboard.html")));
        String record = dashboard.substring(dashboard.indexOf("function zqPomoRecord("), dashboard.indexOf("elMin.addEventListener"));
        assertTrue(record.contains("window.zqApi.recordPomodoro({") && !record.contains("api.post('/record'"),
                "番茄钟又直接发了 —— 网断着的那一下就丢了：\n" + record);
        String js = SourceText.stripComments(Files.readString(NodeRunner.API_JS));
        String route = js.substring(js.indexOf("function route() {"), js.indexOf("window.zqApi = {"));
        assertTrue(route.contains("catchUpPomodoros();") && route.contains("window.addEventListener('online', catchUpPomodoros);")
                && route.contains("setInterval(catchUpPomodoros, 60000);"), "打开页面 / 网回来 / 每分钟补一趟，少了哪个：\n" + route);
        assertTrue(js.contains("recordPomodoro: recordPomodoro"), "window.zqApi 上没有 recordPomodoro");
    }
}
