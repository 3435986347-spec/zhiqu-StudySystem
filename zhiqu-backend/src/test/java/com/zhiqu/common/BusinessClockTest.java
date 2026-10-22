package com.zhiqu.common;

import com.zhiqu.SourceText;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「今天是哪一天」必须只有一个答案。
 *
 * <h2>此前有两个</h2>
 *
 * <p>AI 侧用 {@code LocalDate.now(ZoneId.of("Asia/Shanghai"))}，并把它写进提示词
 * （「今天是 %s，时区是 Asia/Shanghai」），模型据此产出任务日期；
 * 而看板的「今日任务」、例行计划的打卡与排期用裸 {@code LocalDate.now()}，走 JVM 默认时区。
 *
 * <p>而 JVM 时区在这个仓库里哪里都没钉：部署文档没提、启动命令没加 {@code -Duser.timezone}、
 * 代码里也没有 {@code TimeZone.setDefault}。唯一的时区声明是 JDBC URL 里的
 * {@code serverTimezone}，那管的是驱动怎么解释时间戳。
 *
 * <p>于是在一台 UTC 的机器上（Docker 默认），凌晨 0 点到 8 点之间：AI 说「今天是 21 号」
 * 并生成 21 号的任务，看板按 20 号筛、打卡记成 20 号、连续天数跟着错。
 * 两边都没写错代码，只是问的不是同一个问题。
 */
class BusinessClockTest {
    private static final Path MAIN = Path.of("src/main/java/com/zhiqu");

    /** 业务日期判定点的数量下界 —— 低于它说明扫描坏了，不是代码变干净了。 */
    private static final int MIN_CLOCK_USES = 8;

    @Test
    void 按配置的时区给出今天() {
        BusinessClock shanghai = new BusinessClock("Asia/Shanghai");
        assertEquals(LocalDate.now(ZoneId.of("Asia/Shanghai")), shanghai.today());

        BusinessClock utc = new BusinessClock("UTC");
        assertEquals(LocalDate.now(ZoneId.of("UTC")), utc.today());
        assertEquals(ZoneId.of("UTC"), utc.zone(), "zone() 必须如实报告，别处要靠它做同样的判断");
    }

    @Test
    void 空配置回落到默认时区() {
        assertEquals(ZoneId.of(BusinessClock.DEFAULT_ZONE), new BusinessClock(null).zone());
        assertEquals(ZoneId.of(BusinessClock.DEFAULT_ZONE), new BusinessClock("   ").zone());
    }

    /**
     * 业务代码里不得再出现裸 {@code LocalDate.now()} 或硬编码时区。
     *
     * <p>扰动：把任意一处改回 {@code LocalDate.now()} → 本条红，并点名文件与行。
     */
    @Test
    void 不得再出现第二套今天() throws IOException {
        List<String> naked = new ArrayList<>();
        List<String> hardcoded = new ArrayList<>();
        int clockUses = 0;
        int scannedFiles = 0;

        try (Stream<Path> files = Files.walk(MAIN)) {
            for (Path file : files.filter(p -> p.toString().endsWith(".java")).sorted().toList()) {
                // BusinessClock 自己就是那个唯一判定处，它必须能写这些
                if (file.getFileName().toString().equals("BusinessClock.java")) {
                    continue;
                }
                scannedFiles++;
                String code = SourceText.stripComments(Files.readString(file, StandardCharsets.UTF_8));
                clockUses += countOf(code, Pattern.compile("clock\\.(today|now|zone)\\("));
                collect(naked, file, code, Pattern.compile("LocalDate\\.now\\(\\s*\\)"));
                collect(hardcoded, file, code, Pattern.compile("ZoneId\\.of\\(\\s*\"[^\"]+\"\\s*\\)"));
            }
        }

        assertTrue(scannedFiles > 50,
                "只扫到 " + scannedFiles + " 个源文件 —— 空扫和干净的扫形状一样");
        assertTrue(clockUses >= MIN_CLOCK_USES,
                "只找到 " + clockUses + " 处 clock.today()/now() —— 业务日期判定应当都走它，"
                        + "这么少说明要么被绕过了，要么扫描坏了");
        assertEquals(List.of(), naked,
                "这些地方用裸 LocalDate.now() 判定「今天」，走的是 JVM 默认时区，"
                        + "与 AI 侧的业务时区可能差一天");
        assertEquals(List.of(), hardcoded,
                "这些地方硬编码了时区。时区只该有一处定义（BusinessClock），"
                        + "写第二遍就会出现改了一处漏了另一处的情形");
    }

    /**
     * 提醒 cron 的 zone 必须与默认业务时区一致。
     *
     * <p>注解里只能写常量、读不了配置，所以这条一致性没法在代码里表达，只能由判据看着。
     * 不一致的话：cron 在东八区的早八点触发，而它取到的「今天」是另一个时区的 ——
     * 早八汇总会汇总错日期的任务。
     */
    @Test
    void 提醒cron的时区必须与默认业务时区一致() throws IOException {
        Path scheduler = MAIN.resolve("scheduler/ReminderScheduler.java");
        String code = SourceText.stripComments(Files.readString(scheduler, StandardCharsets.UTF_8));
        Matcher zones = Pattern.compile("zone\\s*=\\s*\"([^\"]+)\"").matcher(code);
        List<String> found = new ArrayList<>();
        while (zones.find()) {
            found.add(zones.group(1));
        }
        assertTrue(found.size() >= 2,
                "至少该有两个定时任务带 zone，实际 " + found.size() + " 个 —— 扫描可能坏了");
        for (String zone : found) {
            assertEquals(BusinessClock.DEFAULT_ZONE, zone,
                    "cron 的时区与 BusinessClock.DEFAULT_ZONE 不一致：早八汇总会在一个时区触发、"
                            + "按另一个时区取「今天」，汇总错日期的任务");
        }
    }

    private static int countOf(String code, Pattern pattern) {
        Matcher m = pattern.matcher(code);
        int n = 0;
        while (m.find()) {
            n++;
        }
        return n;
    }

    private static void collect(List<String> into, Path file, String code, Pattern pattern) {
        Matcher m = pattern.matcher(code);
        while (m.find()) {
            int line = (int) code.substring(0, m.start()).chars().filter(c -> c == '\n').count() + 1;
            into.add(MAIN.relativize(file) + ":" + line + " " + m.group());
        }
    }
}
