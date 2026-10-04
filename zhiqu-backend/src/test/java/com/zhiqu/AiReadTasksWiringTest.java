package com.zhiqu;

import com.zhiqu.entity.SysUser;
import com.zhiqu.service.agent.AgentPlanDecision;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「让 AI 读我的任务」的开关和入口接上了（第二十七轮）。这几处断了都不报错：开关不保存、看板的按钮问了一句读不到任务的话、
 * 带过去的那句话被 Notebook 的草稿盖掉 —— 用户只会觉得「AI 还是不知道我有什么任务」。
 */
class AiReadTasksWiringTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String read(String path) throws Exception {
        return Files.readString(STATIC.resolve(path), StandardCharsets.UTF_8);
    }

    @Test
    @DisplayName("开关默认开（用户选的是「让它读」）：库里是空的老用户也算开")
    void 默认开() {
        SysUser user = new SysUser();
        assertTrue(user.aiReadsTasks(), "没设过（空）应当是开");
        user.setAiReadTasks(0);
        assertFalse(user.aiReadsTasks());
        user.setAiReadTasks(1);
        assertTrue(user.aiReadsTasks());
    }

    @Test
    @DisplayName("设置里的开关（第三十轮从个人中心挪到「设置 → AI 模型」）：说清楚会发给谁、按 /auth/info 的值画、点了保存到 /user/ai-read-tasks")
    void 设置里的开关() throws Exception {
        String settings = SourceText.stripComments(read("assets/settings.js"));
        assertTrue(settings.contains("TOGGLE('zq-ai-read-tasks', '让 AI 读我的任务')"), "设置里没有这个开关");
        assertTrue(settings.contains("会发给你配置的模型供应商"), "开关旁边要说清楚打开时任务会发给谁");
        assertTrue(settings.contains("setToggle(readTasks, u.aiReadTasks !== false);"), "开关要按服务端的值画（没有这个字段时当开）");
        assertTrue(settings.contains("await sh.api.put('/user/ai-read-tasks?enabled=' + next);"), "点了要保存");
        String auth = SourceText.stripComments(Files.readString(
                Path.of("src/main/java/com/zhiqu/service/impl/AuthServiceImpl.java"), StandardCharsets.UTF_8));
        assertTrue(auth.contains("data.put(\"aiReadTasks\", user.aiReadsTasks());"), "/auth/info 要带回开关的状态");
    }

    @Test
    @DisplayName("看板「让 AI 排一下今天」带过去的那句话真的会让 AI 读任务；AI 页在载入 Notebook 之后才填它")
    void 看板的入口() throws Exception {
        Matcher link = Pattern.compile("href=\"ai-assistant\\.html\\?ask=([^\"]+)\"").matcher(read("dashboard.html"));
        assertTrue(link.find(), "看板上没有带着问题去 AI 助手的入口");
        String question = URLDecoder.decode(link.group(1), StandardCharsets.UTF_8);
        assertTrue(AgentPlanDecision.taskReadIntent(question),
                "按钮带过去的「" + question + "」过不了读任务的门 —— 按钮说让 AI 排今天，AI 却看不到任务");
        String api = SourceText.stripComments(read("assets/zhiqu-api.js"));
        int boot = api.indexOf("async function bootAiAssistant()");
        int loaded = api.indexOf("await loadAiMessages();", boot);
        int ask = api.indexOf("var ask = new URLSearchParams(location.search).get('ask');", boot);
        int end = api.indexOf("\n  }\n", boot);
        assertTrue(boot >= 0 && loaded > boot && ask > loaded && ask < end,
                "?ask= 要在 bootAiAssistant 里、载入 Notebook 和消息之后再填 —— 先填会被这个 Notebook 存着的草稿盖掉");
    }
}
