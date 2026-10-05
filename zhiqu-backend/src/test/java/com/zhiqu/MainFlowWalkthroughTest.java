package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 第二十三轮：一个新用户只用界面走一遍主流程（AI 助手 → 资料 → 出计划 → 知识库；任务 → 提醒 → 番茄钟 → 统计），
 * 走出来的页面这一侧的问题。每条都在真浏览器里走过（见 docs/rounds/round-23.md）；这里钉的是接线，
 * 防的是「哪天有人顺手改回去」—— 和那几个问题当初的样子一样：功能都在，入口断了，一个字都不报。
 * 服务端那一侧（一份计划只确认一次、轨迹不说没做的事、测试连通记结果）在 AiConversationLifecycleIntegrationTest 里真跑。
 */
class MainFlowWalkthroughTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String api() throws Exception {
        return SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-api.js"), StandardCharsets.UTF_8));
    }

    private static String settings() throws Exception {
        return SourceText.stripComments(Files.readString(STATIC.resolve("assets/settings.js"), StandardCharsets.UTF_8));
    }

    private static String page(String name) throws Exception {
        return Files.readString(STATIC.resolve(name), StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", " ");
    }

    private static String fn(String code, String signature) {
        int a = code.indexOf(signature);
        assertTrue(a >= 0, "找不到 " + signature);
        int b = code.indexOf("\n  }\n", a);
        assertTrue(b > a, signature + " 没有结尾");
        return code.substring(a, b);
    }

    @Test
    @DisplayName("知识 Wiki 的待合入变更能合入、能忽略 —— 原来只列标题，写着「逐条审阅与合入将在后续版本提供」，AI 写的东西永远合不进去")
    void 待合入变更能合入能忽略() throws Exception {
        String code = api();
        String show = fn(code, "async function showWikiPatchSets()");
        assertTrue(show.contains("'/knowledge/patch-sets/' + id + '/' + (verb === '合入变更' ? 'apply' : 'reject')"),
                "审阅弹窗没有接上合入 / 忽略");
        assertTrue(show.contains("$all('[data-patch-apply]', body)") && show.contains("$all('[data-patch-reject]', body)"),
                "合入 / 忽略按钮没有接上");
        assertTrue(fn(code, "function patchSetCard(ps)").contains("renderMarkdown(String(it.content || ''))"),
                "合入之前要看得到写进去的是什么");
        assertFalse(code.contains("后续版本"), "代码里还有「后续版本提供」这类占位话");
    }

    @Test
    @DisplayName("设了提醒却发不出去时，建任务的表单当场说出来；提醒卡片写清它管的是全部提醒")
    void 提醒发不出去要说() throws Exception {
        String code = api();
        String blocker = fn(code, "async function reminderBlocker()");
        assertTrue(blocker.contains("if (!reminderChannelReady(settings)) return") && blocker.contains("if (!settings.enabled) return"),
                "要和后端 isEnabled 同一个条件：凭据齐、开关开着");
        assertTrue(fn(code, "async function openTaskForm(id, onSaved)").contains("reminderBlocker().then("),
                "建任务的表单没有查提醒发不发得出去");
        // 第三十轮起这张卡在「设置 → 提醒」里（assets/settings.js）
        String settings = settings();
        assertFalse(settings.contains(">早八提醒<"), "卡片还叫「早八提醒」—— 它的开关管的是全部提醒，设了提醒时间的人不会想到要来开它");
        assertTrue(settings.contains("任务的提醒时间、截止前提醒和每天 08:00 的待办汇总"), "卡片说明要写清它管哪些提醒");
        assertTrue(fn(code, "async function openTaskForm(id, onSaved)").contains("href=\"#settings/reminders\""),
                "建任务时说「提醒发不出去」，要能一下打开「设置 → 提醒」");
    }

    @Test
    @DisplayName("AI 助手：没有模型时说出来并给入口，下拉框不写「默认模型」；有模型但对话是空的时给几句能真触发的示例")
    void AI助手的空状态() throws Exception {
        String code = api();
        String load = fn(code, "async function loadAiModelSelect()");
        assertTrue(load.contains("state.aiNoModel = !(models || []).length;"), "没有判断「一个能用的模型都没有」");
        assertTrue(load.contains("(state.aiNoModel ? '还没有可用的模型' : '默认模型')"), "没有模型时下拉框还写「默认模型」");
        String empty = fn(code, "function aiEmptyState()");
        assertTrue(empty.contains("if (state.aiNoModel)") && empty.contains("href=\"#settings/models\""), "没有模型时要给去配置的入口（「设置 → AI 模型」）");
        assertTrue(fn(code, "function renderAiMessages(opts)").contains("host.innerHTML = moreRow + aiEmptyState();"),
                "对话区空着时没有画空状态");
        assertTrue(code.contains("'根据这些资料，帮我制定下周的工作计划'"), "示例要用真能出计划的说法（制定）");
    }

    @Test
    @DisplayName("没有 Notebook 也能上传：替用户建一个，不再只说「请先新建或选择 Notebook」")
    void 上传时自动建Notebook() throws Exception {
        String code = api();
        String upload = fn(code, "async function uploadAiFiles(files, attachToNextMessage)");
        assertTrue(upload.contains("notebookId = await ensureAiNotebook(list);"), "上传之前没有确保有 Notebook");
        String ensure = fn(code, "async function ensureAiNotebook(files)");
        assertTrue(ensure.contains("api.post('/ai/notebooks'") && ensure.contains("draft.value = typed;"),
                "要替用户建 Notebook，并把已经打的字带过去");
        assertFalse(code.contains("请先新建或选择 Notebook"), "还有地方只叫用户先去新建 Notebook");
    }

    @Test
    @DisplayName("看板：例行完成的进度条按真实比例画（原来写死六成）；「新增任务」就地打开表单；番茄钟结束要让人知道")
    void 看板() throws Exception {
        String dashboard = page("dashboard.html");
        assertFalse(dashboard.contains("width:60%"), "进度条还写死着 60%");
        assertTrue(dashboard.contains("id=\"zq-routine-bar\""), "进度条要有 id 才接得上数据");
        // 第三十五轮起看板是模块（pages/dashboard.js）
        String boot = SourceText.functionBody(SourceText.pageModule("dashboard.js"), "async function bootDashboard()");
        // 连同前面的 if 一起钉：只钉后半句的话，「if (false) routineBar.style.width = …」也满足（扰动 F8 这样漏过去过）
        assertTrue(boot.contains("if (routineBar) routineBar.style.width = (sum.routineTotal ? Math.min(100, Math.round(100 * (sum.routineDone || 0) / sum.routineTotal)) : 0) + '%';"),
                "进度条没有按 routineDone / routineTotal 画");
        assertTrue(boot.contains("add.onclick = function () { openTaskForm(null, bootDashboard); };"),
                "看板的「新增任务」要就地打开表单（原来只跳到任务页）");
        String script = SourceText.stripComments(dashboard);
        assertTrue(script.contains("zqPomoRecord(Math.round(total/60)); announceDone();"), "番茄钟结束时没有提示");
        assertTrue(script.contains("document.title='✓ 专注结束 — '+title;"), "在别的标签页时要看得出番茄钟结束了");
    }

    @Test
    @DisplayName("注册完直接登录（原来要把密码再输一遍）")
    void 注册完直接登录() throws Exception {
        String code = api();
        int a = code.indexOf("safe('注册', async function () {");
        int b = code.indexOf("});", code.indexOf("catch (err)", a));
        assertTrue(a >= 0 && b > a, "找不到注册的处理");
        String reg = code.substring(a, b);
        assertTrue(reg.indexOf("api.post('/auth/register'") < reg.indexOf("api.post('/auth/login'"), "注册之后没有接着登录");
        assertTrue(reg.contains("setAuth(data, false);"), "登录拿到的令牌没有存上");
    }
}
