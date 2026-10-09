package com.zhiqu.service.impl;

import com.zhiqu.SourceText;
import org.junit.jupiter.api.DisplayName;
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
 * 参考计划的分类是三份清单：库里的种子（迁移）、自动归类补建时用的名字（{@link SharedPlanServiceImpl#CATEGORY_NAMES}）、
 * 页面的筛选与标签（{@code zhiqu-api.js} 的 {@code PLAN_CATEGORIES}）。第二十六轮改成办公方向之前，页面那份还散成五处
 * （筛选、卡片、提交表单、审核列表、审核编辑），各写各的。只改一处，同一个分类就有两三种叫法、筛选也对不上 key。
 */
class PlanCategoryListTest {

    private static final Path MIGRATIONS = Path.of("src/main/resources/db/migration");
    private static final Path API_JS = Path.of("src/main/resources/static/assets/zhiqu-api.js");
    private static final String SEED = "V40__office_plan_categories.sql";

    private static List<String> pairs(Matcher m) {
        List<String> out = new ArrayList<>();
        while (m.find()) {
            out.add(m.group(1) + "=" + m.group(2));
        }
        return out;
    }

    @Test
    @DisplayName("迁移、服务、页面三份分类清单一致（key、名字、先后）")
    void 三份清单一致() throws IOException {
        String sql = Files.readString(MIGRATIONS.resolve(SEED), StandardCharsets.UTF_8);
        List<String> seeded = pairs(Pattern.compile("\\('([A-Z_]+)',\\s*'([^']+)'").matcher(sql));
        assertTrue(seeded.size() >= 5, "迁移里只解析出 " + seeded + " —— 空扫和干净的扫长得一样");

        List<String> java = new ArrayList<>();
        SharedPlanServiceImpl.CATEGORY_NAMES.forEach((k, v) -> java.add(k + "=" + v));
        assertEquals(seeded, java, "SharedPlanServiceImpl.CATEGORY_NAMES 和 " + SEED + " 不一致");

        String api = SourceText.stripComments(Files.readString(API_JS, StandardCharsets.UTF_8));
        int at = api.indexOf("var PLAN_CATEGORIES = [");
        assertTrue(at >= 0, "zhiqu-api.js 里找不到 PLAN_CATEGORIES");
        String list = api.substring(at, api.indexOf("];", at));
        List<String> page = pairs(Pattern.compile("\\['([A-Z_]+)',\\s*'([^']+)',\\s*'q[1-4]'\\]").matcher(list));
        assertEquals(seeded, page, "zhiqu-api.js 的 PLAN_CATEGORIES 和 " + SEED + " 不一致");
    }

    @Test
    @DisplayName("页面里只有 PLAN_CATEGORIES 这一份：不另写分类表、不在 HTML 里写死选项")
    void 页面只有一份() throws IOException {
        String api = SourceText.stripComments(Files.readString(API_JS, StandardCharsets.UTF_8));
        // 每个分类的名字在 zhiqu-api.js 里只出现一次（就在 PLAN_CATEGORIES 里）；出现第二次就是又写了一份分类表
        List<String> twice = new ArrayList<>();
        SharedPlanServiceImpl.CATEGORY_NAMES.values().forEach(name -> {
            int n = api.split("'" + Pattern.quote(name) + "'", -1).length - 1;
            if (n != 1) {
                twice.add(name + " ×" + n);
            }
        });
        assertEquals(List.of(), twice, "分类名字在 zhiqu-api.js 里应当正好出现一次（PLAN_CATEGORIES 里）");
        assertTrue(!api.contains("<option value=\"EXAM\""), "分类选项要从 PLAN_CATEGORIES 生成，不要写死");
        String html = Files.readString(Path.of("src/main/resources/static/shared-plans.html"), StandardCharsets.UTF_8);
        assertTrue(!html.contains("<option>考试备考</option>") && !html.contains("value=\"EXAM\""), "筛选的选项由壳从 PLAN_CATEGORIES 填");
    }

    @Test
    @DisplayName("之后的迁移没有再改分类（改了就要把这条判据指到新的那份）")
    void 种子就是最后一份() throws IOException {
        List<String> later = new ArrayList<>();
        try (Stream<Path> files = Files.list(MIGRATIONS)) {
            for (Path f : files.toList()) {
                String name = f.getFileName().toString();
                Matcher v = Pattern.compile("^V(\\d+)__").matcher(name);
                if (v.find() && Integer.parseInt(v.group(1)) > 40
                        && Files.readString(f, StandardCharsets.UTF_8).contains("shared_plan_category")) {
                    later.add(name);
                }
            }
        }
        assertEquals(List.of(), later, "这些迁移又改了分类：PlanCategoryListTest 还在核对 " + SEED);
    }
}
