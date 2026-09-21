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
 * 工作区接口必须每一个都限管理员 —— 而 {@link AdminAuthorizationTest} 覆盖不到它。
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
 * <p>工作区接口读的是<b>这台电脑上的文件</b>。漏掉一个映射，任何登录用户都能读到它们。
 */
class WorkspaceControllerGuardTest {
    private static final Path CONTROLLER =
            Path.of("src/main/java/com/zhiqu/controller/WorkspaceController.java");

    private static final Pattern MAPPING =
            Pattern.compile("@(Get|Post|Put|Delete|Patch)Mapping\\(?\\s*(?:value\\s*=\\s*)?\"?([^\")\\n]*)\"?");

    @Test
    void 每个工作区接口都必须限管理员() throws IOException {
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
            if (!chunk.contains("requireAdmin()")) {
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
        assertTrue(code.contains("row.put(\"reason\", workspaceService.access().refusalReason())"),
                "状态里必须带上 refusalReason，否则用户只看到「没开」而不知道为什么");
        assertTrue(code.contains("configuredMode"),
                "还要带上配置里写的那一档 —— 「你想开 EXEC，但没生效」比「没开」有用得多");
    }

    /**
     * 列目录接口的响应形状，前后端必须对得上。
     *
     * <h2>这一条是被自己制造的风险逼出来的</h2>
     *
     * <p>2026-09-21 把 {@code /api/workspace/files} 的响应从<b>数组</b>改成
     * {@code {entries, truncated}}（为了能说出「还有没列完的」）。后端改完、前端是<b>手工</b>
     * 跟着改的 —— 忘了的话，{@code res.entries} 取到 undefined，面板<b>一片空白而不报错</b>：
     * 用户以为工作区是空的，控制台里干干净净。
     *
     * <p>契约两端在不同语言的不同文件里，编译器看不到它们的关系。所以用判据把两个键名
     * 钉在一起：改任何一边、不改另一边，这条就红。
     *
     * <p>它<b>不</b>证明渲染正确 —— 那要靠真浏览器（本轮也看过了）。它只证明两边说的是
     * 同一个词。
     */
    @Test
    void 列目录的响应形状前后端要一致() throws IOException {
        String controller = SourceText.stripComments(
                Files.readString(CONTROLLER, StandardCharsets.UTF_8));
        String api = SourceText.stripComments(Files.readString(
                Path.of("src/main/resources/static/assets/zhiqu-api.js"), StandardCharsets.UTF_8));

        // 后端：files 方法在顶层放的就是这两个键
        int at = controller.indexOf("public Result<Map<String, Object>> files(");
        assertTrue(at > 0, "找不到 files 方法 —— 判据的锚点没了");
        String body = controller.substring(at, controller.indexOf("@GetMapping", at + 1));
        assertTrue(body.contains("row.put(\"entries\""), "后端必须放 entries。实际：" + body);
        assertTrue(body.contains("row.put(\"truncated\""), "后端必须放 truncated。实际：" + body);

        // 前端：读的必须是同样两个键
        int call = api.indexOf("'/workspace/files'");
        assertTrue(call > 0, "前端找不到 /workspace/files 的调用 —— 判据的锚点没了");
        String usage = api.substring(call, Math.min(api.length(), call + 400));
        assertTrue(usage.contains("res.entries"),
                "前端必须从 res.entries 取条目。后端改了形状而前端没跟上的话，"
                        + "面板一片空白而且不报错。这一段：" + usage);
        assertTrue(usage.contains("res.truncated"),
                "前端必须读 res.truncated 并显示出来 —— 做出信号却不用，等于没做。这一段：" + usage);
    }
}
