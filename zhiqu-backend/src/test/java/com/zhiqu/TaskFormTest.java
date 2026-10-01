package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 2026-10-01 用户报的三件「页面上看得见」的事里，网页这一侧的两件，外加 Wiki 导入弹窗里那个点不动的「选择文件」。
 *
 * <ul>
 *   <li>任务中心「新建任务」只能填标题：截止时间、提醒时间、象限、优先级都设置不了（列表里明明有这几列），编辑也只改标题。</li>
 *   <li>参考计划右上角「已审核模板 · 4 个」是设计稿写死的，从来不变。</li>
 *   <li>Wiki「导入来源 → 上传文件解析」的「选择文件」那行字没有 for：点字是死点击，只有点输入框本体才弹选择框。
 *       （桌面应用里点本体也没反应，那是外壳的事，见 DesktopPageViewTest。）</li>
 * </ul>
 */
class TaskFormTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String api() throws Exception {
        return SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-api.js"), StandardCharsets.UTF_8));
    }

    @Test
    @DisplayName("表单填的 → 发给服务端的：时间原样（不换时区）、过去的提醒时间要说、截止前提醒默认 / 不提醒 / 自定义、每周重复、编辑时其余字段照旧")
    void 表单到请求() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/task-form-check.js"), NodeRunner.API_JS);
    }

    @Test
    @DisplayName("任务页：新建和编辑都打开同一份表单，表单里每一项都真的读进请求")
    void 新建和编辑都走表单() throws Exception {
        String code = api();
        int a = code.indexOf("async function bootTasks()");
        int b = code.indexOf("\n  }\n", a);
        assertTrue(a >= 0 && b > a, "找不到 bootTasks");
        assertTrue(code.substring(a, b).contains("newBtn.onclick = function () { openTaskForm(null); }"), "「新建任务」没有打开任务表单");
        assertTrue(code.contains("return openTaskForm(Number(b.dataset.editTask));"), "「编辑」没有打开任务表单");
        assertFalse(code.contains("askText({ title: '新建任务'") || code.contains("askText({ title: '修改任务'"),
                "还有只问一个标题的新建 / 编辑");

        int f = code.indexOf("async function openTaskForm(id)");
        int g = code.indexOf("\n  }\n", f);
        assertTrue(f >= 0 && g > f, "找不到 openTaskForm");
        String open = code.substring(f, g);
        String html = code.substring(code.indexOf("function taskFormHtml("), code.indexOf("async function currentRemind("));
        // 表单里画出来的每个输入框，提交时都要读 —— 画了不读，用户填了也白填（一个字都不报）
        Matcher ids = Pattern.compile("id=\"(zq-tf-[a-z]+)\"").matcher(html);
        List<String> drawn = new ArrayList<>();
        while (ids.find()) if (!drawn.contains(ids.group(1))) drawn.add(ids.group(1));
        assertTrue(drawn.size() >= 10, "表单里只扫到 " + drawn.size() + " 个输入框：" + drawn);
        List<String> unread = new ArrayList<>();
        for (String id : drawn) {
            if (id.equals("zq-tf-cancel") || id.equals("zq-tf-ok")) continue;
            if (!open.contains("$('#" + id + "', b)")) unread.add(id);
        }
        assertEquals(List.of(), unread, "表单里画了、提交时没读的输入框");
        for (String key : new String[]{"deadline: $('#zq-tf-deadline', b).value", "reminderTime: $('#zq-tf-remind', b).value",
                "startTime: $('#zq-tf-start', b).value", "remindMode: modeSel.value", "remindDays: days.value"}) {
            assertTrue(open.contains(key), "提交时没有把「" + key + "」交给 taskFormPayload");
        }
        assertTrue(open.contains("taskFormPayload({") && open.contains("businessNowText(), before)"),
                "提交没有经过 taskFormPayload（判据跑的是它）");
        assertTrue(open.contains("api[plan.method](plan.url, plan.body)"), "发出去的不是 taskFormPayload 算出来的那一份");
    }

    @Test
    @DisplayName("参考计划：模板个数按接口回来的列表写，页面里没有写死的数")
    void 参考计划个数() throws Exception {
        String page = Files.readString(STATIC.resolve("shared-plans.html"), StandardCharsets.UTF_8);
        Matcher span = Pattern.compile("<span id=\"zq-plan-count\"[^>]*>([^<]*)</span>").matcher(page);
        assertTrue(span.find(), "shared-plans.html 里找不到 #zq-plan-count");
        assertFalse(span.group(1).matches(".*\\d.*"), "个数那一格里写死了数字：" + span.group(1));
        String code = api();
        int a = code.indexOf("async function loadPlans(");
        int b = code.indexOf("\n  }\n", a);
        assertTrue(a >= 0 && b > a, "找不到 loadPlans");
        // 钉整句（「if (false) count.textContent = …」也含着那几个片段 —— 扰动时这样漏过去过）
        assertTrue(code.substring(a, b).contains("if (count) count.textContent = (category ? (CAT_LABEL[category] || '已审核模板') : '已审核模板') + ' · ' + plans.length + ' 个';"),
                "loadPlans 没有按列表写个数");
    }

    /**
     * 排查「4 个」时把每一页过了一遍（页面启动后还看得见、和设计稿示例一字不差、带数字的字），只剩这一处：
     * 看板番茄钟上的「第 3 轮 · 专注阶段」，新账号一个没做也是第 3 轮。
     */
    @Test
    @DisplayName("看板番茄钟：轮次按今天已经记的个数写，页面里没有写死的轮次")
    void 番茄钟轮次() throws Exception {
        String page = Files.readString(STATIC.resolve("dashboard.html"), StandardCharsets.UTF_8);
        Matcher div = Pattern.compile("<div id=\"zq-pomo-round\"[^>]*>([^<]*)</div>").matcher(page);
        assertTrue(div.find(), "dashboard.html 里找不到 #zq-pomo-round");
        assertFalse(div.group(1).matches(".*\\d.*"), "轮次那一格里写死了数字：" + div.group(1));
        assertFalse(page.contains("第 3 轮"), "设计稿的「第 3 轮」还在页面里");
        String code = api();
        int a = code.indexOf("async function updatePomoCount()");
        int b = code.indexOf("\n  }\n", a);
        assertTrue(a >= 0 && b > a, "找不到 updatePomoCount");
        assertTrue(code.substring(a, b).contains("if (round) round.textContent = '今天第 ' + (todays.length + 1) + ' 轮';"),
                "updatePomoCount 没有按今天的个数写轮次");
    }

    @Test
    @DisplayName("文件输入框的标签点得动：label 的 for 指向那个 file input")
    void 文件输入框的标签() throws Exception {
        String code = api();
        Matcher m = Pattern.compile("<label([^>]*)>[^<]*</label><input id=\"([^\"]+)\" type=\"file\"").matcher(code);
        int seen = 0;
        while (m.find()) {
            seen++;
            assertTrue(m.group(1).contains("for=\"" + m.group(2) + "\""), "「" + m.group(2) + "」的标签没有 for：点那行字什么都不发生");
        }
        assertTrue(seen >= 1, "一个带标签的 file input 都没扫到 —— 写法变了？");
    }
}
