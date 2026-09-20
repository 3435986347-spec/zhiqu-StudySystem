package com.zhiqu;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 提醒渠道的配置界面必须在<b>活着的</b>那份前端里。
 *
 * <h2>它曾经整块躺在死文件里</h2>
 *
 * <p>填 PushPlus token / 企业微信 Webhook / QQ 机器人凭据的界面一直存在 ——
 * 但在 {@code js/profile.js}，而 {@code js/*.js} <b>零页面加载</b>（CLAUDE.md 明写）。
 * 现行应用壳里只有一个开关，它发的是 {@code {channel:'PUSHPLUS', enabled:true}}，
 * 不带任何凭据。
 *
 * <p>而后端 {@code hasRequiredChannelConfig} 要求 PUSHPLUS 必须有 {@code pushplusToken}。
 * 于是每天早八 {@code isEnabled} 为假，每条提醒被标成 {@code FAILED}
 * （理由「提醒渠道未启用或未配置」，而那条理由用户看不到）。
 * 用户看到的是一个绿色的开关、一句「每天 08:00 推送今日待办与 DDL 汇总」，
 * 外加一行写死的「渠道：PushPlus · 已绑定」—— 然后什么都收不到。
 *
 * <h2>判据钉哪一层</h2>
 *
 * <p>钉「后端要求的每个凭据字段，在活着的前端里都有地方填」。这比「页面上有几个输入框」
 * 稳：后端加一个必填凭据而前端没跟上，本条会红并点名是哪个字段。
 */
class ReminderChannelWiringTest {
    private static final Path STATIC_DIR = Path.of("src/main/resources/static");
    private static final Path REMINDER_IMPL =
            Path.of("src/main/java/com/zhiqu/service/impl/ReminderServiceImpl.java");

    /**
     * 活着的前端：现行应用壳 + 所有页面，<b>且剥掉注释</b>。
     *
     * <p>{@code js/*.js} 不在其中 —— 那是死的，写在那里的界面用户碰不到。
     *
     * <p>剥注释不是洁癖：本类的扰动第一次就撞上了这个 —— 我在 {@code zhiqu-api.js} 里
     * 写的那段说明里提到了 {@code pushplusToken}，于是「前端能填这个字段」这条判据
     * <b>被一句注释满足了</b>。{@code contains} 分不出「界面里有这个字段」和
     * 「注释在解释它」，而这正是本仓库反复栽的那一跤。
     */
    private static String liveFrontend() throws IOException {
        StringBuilder all = new StringBuilder();
        all.append(SourceText.stripComments(
                Files.readString(STATIC_DIR.resolve("assets/zhiqu-api.js"), StandardCharsets.UTF_8)));
        all.append(SourceText.stripComments(
                Files.readString(STATIC_DIR.resolve("assets/zhiqu-ui.js"), StandardCharsets.UTF_8)));
        try (Stream<Path> pages = Files.list(STATIC_DIR)) {
            for (Path page : pages.filter(p -> p.toString().endsWith(".html")).sorted().toList()) {
                all.append(Files.readString(page, StandardCharsets.UTF_8)
                        .replaceAll("(?s)<!--.*?-->", " "));
            }
        }
        return all.toString();
    }

    /**
     * 后端要求的每个凭据字段，活着的前端里都要有地方填。
     *
     * <p>字段名从 {@code hasRequiredChannelConfig} 的 getter 里解析出来，不是手抄的清单 ——
     * 后端新增一个必填凭据，本条会自动跟上。
     */
    @Test
    void 后端要求的凭据前端都要能填() throws IOException {
        String impl = SourceText.stripComments(
                Files.readString(REMINDER_IMPL, StandardCharsets.UTF_8));
        int at = impl.indexOf("hasRequiredChannelConfig(UserReminderSetting setting)");
        assertTrue(at >= 0, "hasRequiredChannelConfig 不见了 —— 判据的锚点要跟着改");
        String body = impl.substring(at, Math.min(impl.length(), at + 1200));

        List<String> required = new ArrayList<>();
        Matcher getters = Pattern.compile("setting\\.get(\\w+)\\(\\)").matcher(body);
        while (getters.find()) {
            String field = getters.group(1);
            if (!"Channel".equals(field) && !required.contains(field)) {
                required.add(field);
            }
        }
        assertTrue(required.size() >= 4,
                "只解析出 " + required + " 这几个必填凭据 —— 空扫和干净的扫形状一样，"
                        + "多半是 hasRequiredChannelConfig 的写法变了");

        String live = liveFrontend();
        List<String> missing = new ArrayList<>();
        for (String field : required) {
            String camel = Character.toLowerCase(field.charAt(0)) + field.substring(1);
            if (!live.contains(camel)) {
                missing.add(camel);
            }
        }
        assertEquals(List.of(), missing,
                "后端把这些凭据列为必填，而活着的前端（assets/*.js + 所有页面）里没有它们。"
                        + "注意 js/*.js 零页面加载，写在那里不算 —— 提醒渠道就是这么坏了很久的："
                        + "开关能开，凭据没处填，每条提醒被标成 FAILED，用户什么都收不到");
    }

    /**
     * 不得再写死「已绑定」之类的状态。
     *
     * <p>原来页面上有一行「渠道：PushPlus · 已绑定」，与真实配置状态无关，恒为已绑定。
     */
    @Test
    void 不得写死渠道已绑定的字样() throws IOException {
        List<String> offenders = new ArrayList<>();
        try (Stream<Path> pages = Files.list(STATIC_DIR)) {
            for (Path page : pages.filter(p -> p.toString().endsWith(".html")).sorted().toList()) {
                // 只看会被渲染的部分：HTML 注释里提到这几个字不算 ——
                // contains 分不出「页面这么说」和「注释在解释它为什么被删掉」，
                // 而本判据第一次跑就正是被自己新写的那条注释绊住的
                String rendered = Files.readString(page, StandardCharsets.UTF_8)
                        .replaceAll("(?s)<!--.*?-->", " ");
                if (rendered.contains("已绑定")) {
                    offenders.add(page.getFileName().toString());
                }
            }
        }
        assertEquals(List.of(), offenders,
                "这些页面写死了「已绑定」。绑定状态必须来自 /reminder/settings 的真实数据 —— "
                        + "写死的话，没配凭据的用户也会被告知已绑定");
    }

    /** 渠道选择必须覆盖后端支持的全部渠道，不能只暴露其中一个。 */
    @Test
    void 前端必须能选到后端支持的每个渠道() throws IOException {
        List<String> backendChannels = new ArrayList<>();
        try (Stream<Path> files = Files.walk(Path.of("src/main/java/com/zhiqu/service/notification"))) {
            for (Path file : files.filter(p -> p.toString().endsWith(".java")).sorted().toList()) {
                String code = SourceText.stripComments(Files.readString(file, StandardCharsets.UTF_8));
                Matcher m = Pattern.compile("String channel\\(\\)\\s*\\{\\s*return\\s*\"([^\"]+)\"").matcher(code);
                if (m.find()) {
                    backendChannels.add(m.group(1));
                }
            }
        }
        assertTrue(backendChannels.size() >= 3,
                "只找到 " + backendChannels + " 这些渠道实现 —— 扫描可能坏了");

        // 钉「能被选中」，而不是「字符串出现过」：隐藏的分组 div 上也写着渠道名，
        // 但光有它选不到这个渠道
        String live = liveFrontend();
        List<String> unreachable = backendChannels.stream()
                .filter(c -> !live.contains("value=\"" + c + "\""))
                .toList();
        assertEquals(List.of(), unreachable,
                "后端实现了这些渠道，但活着的前端里选不到（没有对应的 option value）—— "
                        + "用户只能通过直接调 API 使用它们");
    }
}
