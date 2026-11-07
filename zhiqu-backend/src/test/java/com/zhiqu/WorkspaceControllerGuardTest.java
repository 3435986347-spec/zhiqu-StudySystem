package com.zhiqu;

import com.zhiqu.SourceText;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 工作区接口必须每一个都只认本机的请求（第一百一十五轮起不再限管理员）—— 而 {@link AdminAuthorizationTest} 覆盖不到它。
 *
 * <h2>为什么要单独一条</h2>
 *
 * <p>{@code AdminAuthorizationTest} 扫的是 {@code AdminController} 里的映射，判定依据是
 * 「方法体里有没有 requireAdmin()」。{@code WorkspaceController} 不在那个文件里，
 * 所以它的映射<b>一个都不会被那条判据看到</b>。
 *
 * <p>这正是「按文件枚举」这类判据的固有盲区：新开一个控制器，它就在覆盖范围之外，
 * 而且没有任何东西提示你。同样的盲区当初让 {@code POST /api/ai/web-fetch/test} 也需要
 * 一条单独的判据。
 *
 * <p>工作区接口读的是<b>这台电脑上的文件</b>。漏掉一个映射，一个陌生网页（DNS 重绑定）注册个账号就能读到它们。
 */
class WorkspaceControllerGuardTest {
    private static final Path CONTROLLER =
            Path.of("src/main/java/com/zhiqu/controller/WorkspaceController.java");

    private static final Pattern MAPPING =
            Pattern.compile("@(Get|Post|Put|Delete|Patch)Mapping\\(?\\s*(?:value\\s*=\\s*)?\"?([^\")\\n]*)\"?");

    @Test
    void 每个工作区接口都必须只认本机的请求() throws IOException {
        String code = SourceText.stripComments(Files.readString(CONTROLLER, StandardCharsets.UTF_8));

        List<Integer> starts = new ArrayList<>();
        Matcher heads = MAPPING.matcher(code);
        while (heads.find()) {
            starts.add(heads.start());
        }
        assertTrue(starts.size() >= 3,
                "只解析出 " + starts.size() + " 个工作区接口 —— 空扫和干净的扫形状一样");

        List<String> unguarded = new ArrayList<>();
        for (int i = 0; i < starts.size(); i++) {
            String chunk = code.substring(starts.get(i),
                    i + 1 < starts.size() ? starts.get(i + 1) : code.length());
            Matcher head = MAPPING.matcher(chunk);
            head.find();
            if (!chunk.contains("requireLocal()")) {
                unguarded.add(head.group(1).toUpperCase() + " " + head.group(2));
            }
        }
        assertEquals(List.of(), unguarded,
                "这些工作区接口没有限管理员。它们读的是这台电脑上的文件 —— "
                        + "漏一个，任何登录用户都能读到。注意 AdminAuthorizationTest 只扫 "
                        + "AdminController，覆盖不到这里");
    }

    /**
     * 状态接口必须如实给出「为什么没开」。
     *
     * <p>用户在配置里写了 mode 却看不到工作区时，必须能知道是哪一条前置没满足 ——
     * 静默关掉是这类开关最糟的失败方式：他会一直以为它开着。
     */
    @Test
    void 状态接口必须给出未启用的原因() throws IOException {
        String code = SourceText.stripComments(Files.readString(CONTROLLER, StandardCharsets.UTF_8));
        assertTrue(code.contains("row.put(\"reason\", workspace().access().refusalReason())"),
                "状态里必须带上 refusalReason，否则用户只看到「没开」而不知道为什么");
        assertTrue(code.contains("configuredMode"),
                "还要带上配置里写的那一档 —— 「你想开 EXEC，但没生效」比「没开」有用得多");
    }

    @org.junit.jupiter.api.DisplayName("弹系统选文件夹框的接口（第一百零五轮）：除了本机的请求还要回环 —— 框弹在跑后端的这台电脑上，别人的服务器上弹了没人看得见，还卡住一个请求线程")
    @Test
    void 弹选文件夹框要回环() throws IOException {
        String code = SourceText.stripComments(Files.readString(CONTROLLER, StandardCharsets.UTF_8));
        int at = code.indexOf("@PostMapping(\"/pick-folder\")");
        assertTrue(at > 0, "找不到 /pick-folder");
        String body = code.substring(at, code.indexOf("@GetMapping", at));
        int admin = body.indexOf("requireLocal()"), loopback = body.indexOf("workspaces.loopbackBound()"), dialog = body.indexOf("folderDialog.pick(");
        assertTrue(admin > 0 && loopback > admin && dialog > loopback, "顺序应该是 本机的请求 → 回环 → 弹框：" + body);
    }
}
