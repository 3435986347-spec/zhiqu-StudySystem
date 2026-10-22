package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 界面打磨第 8 步（三）（第七十五轮，docs/ui-plan.md）：设置、成就两个弹窗。
 *
 * <p>原来 assets/settings.js 里 76 处内联样式，开关、提醒渠道的显隐、状态的颜色、成就筛选按下的样子都是 JS 改 {@code style}——
 * 深色下打开的开关是白底配白钮；打开设置时焦点落在第一栏，从「AI 模型」进来两栏看着都选上了；模型卡片上「（我的）」写两遍、Provider 写代码。
 * 画出来的东西（卡片、开关、分栏的键盘、表单标题）在 settings-check.js 里真跑；这里管样式表和接线的静态那一半。
 */
class SettingsLookTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String settings() throws IOException {
        return SourceText.stripComments(Files.readString(STATIC.resolve("assets/settings.js"), StandardCharsets.UTF_8));
    }

    private static String css() throws IOException {
        return Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8);
    }

    @Test
    @DisplayName("模块只管类和 aria-*：不拼内联样式、不在 JS 里改样子")
    void 模块不写样子() throws IOException {
        String js = settings();
        assertTrue(js.length() > 15000, "settings.js 只读到 " + js.length() + " 字 —— 读错文件了？");
        assertFalse(js.contains("style="), "settings.js 又在拼内联样式");
        assertFalse(js.contains(".style."), "settings.js 又在 JS 里改样子（开关看 aria-checked、筛选看 aria-pressed、渠道用 hidden、状态用 data-state）");
    }

    @Test
    @DisplayName("开关：role=switch + aria-checked，样子在样式表；打开时滑块是「主色上的字」那个颜色（深色下主色是浅的，白钮看不见）")
    void 开关() throws IOException {
        String js = settings();
        assertTrue(js.contains("role=\"switch\" aria-checked=\"false\" class=\"zq-switch\""), "开关不是 role=switch / 没有 aria-checked");
        assertTrue(js.contains("var next = !toggleOn(readTasks);") && js.contains("var next = !toggleOn(morning);"), "两个开关点了之后不是按 aria-checked 切");
        String css = css();
        assertTrue(css.contains(".zq-switch[aria-checked=\"true\"]{background:var(--zq-primary);}"), "打开的开关没有主色底");
        assertTrue(css.contains(".zq-switch[aria-checked=\"true\"]>i{left:21px;background:var(--zq-on-primary);}"), "打开时滑块没挪到右边，或者还是白的（深色下白底白钮）");
    }

    @Test
    @DisplayName("分栏：选中的那栏 tabindex=0、带 autofocus（打开时焦点落在它上面）；方向键换栏；面板 aria-labelledby 跟着换")
    void 分栏() throws IOException {
        String js = settings();
        Matcher open = Pattern.compile("export function openSettings\\(sh, opts\\) \\{(.*?)\\n\\}", Pattern.DOTALL).matcher(js);
        assertTrue(open.find(), "找不到 openSettings");
        String body = open.group(1);
        assertTrue(body.contains("var first = PANES[opts.tab] ? opts.tab : SETTINGS_TABS[0][0];"), "开头没算出要打开哪一栏");
        assertTrue(body.contains("' aria-selected=\"' + on + '\" tabindex=\"' + (on ? 0 : -1) + '\"' + (on ? ' class=\"on\" autofocus' : '')"),
                "选中的那一栏没有 tabindex=0 + autofocus —— openModal 会把焦点给第一栏（「个人资料」）");
        assertTrue(body.contains("b.tabIndex = on ? 0 : -1;") && body.contains("pane.setAttribute('aria-labelledby', 'zq-set-tab-' + name);"), "换栏时 tabindex / aria-labelledby 没跟着换");
        assertTrue(body.contains("var next = tabAfterKey(e.key, current);") && body.contains("e.preventDefault();\n    pick(next);"), "分栏上按方向键不换栏");
        assertTrue(body.contains("if (on && focusTab) b.focus();"), "换栏时焦点留在上一栏（地址换栏、方向键换栏）");
    }

    @Test
    @DisplayName("提醒渠道：三组用 hidden（全局 [hidden] 带 !important），状态用 data-state")
    void 提醒渠道() throws IOException {
        String js = settings();
        assertTrue(js.contains("group.hidden = group.dataset.rmGroup !== channel;"), "渠道的三组不是用 hidden 切");
        assertTrue(js.contains("status.dataset.state = ready() ? 'ok' : 'bad';"), "渠道状态的颜色不是交给 data-state");
        assertTrue(css().contains("[hidden]{display:none !important;}"), "全局的 [hidden] 没了 —— .zq-set-group 的 display:flex 会压过它，三组同时露出来");
    }

    @Test
    @DisplayName("成就：筛选是 .zq-seg + aria-pressed（原来 JS 改背景色）；卡片一行几张按宽度来")
    void 成就() throws IOException {
        String js = settings();
        assertTrue(js.contains("<div class=\"zq-seg\" data-ach-filters role=\"group\" aria-label=\"筛选成就\">"), "成就筛选不是 .zq-seg");
        assertTrue(js.contains("b.setAttribute('aria-pressed', b.dataset.k === filter ? 'true' : 'false');"), "成就筛选按下的样子不是 aria-pressed");
        String css = css();
        assertTrue(css.contains(".zq-seg>button.on,.zq-seg>button[aria-pressed=\"true\"]{"), ".zq-seg 没有 aria-pressed 按下的样子");
        assertTrue(css.contains(".zq-ach-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));"), "成就卡片不是按宽度排（auto-fill）");
    }

    @Test
    @DisplayName("遮罩盖满整个视口，连滚动条的槽一起（html 的 scrollbar-gutter:stable 留着槽，inset:0 不算它，右边漏一条没变暗的边）")
    void 遮罩盖满() throws IOException {
        String css = css();
        assertTrue(css.contains("html{scrollbar-gutter:stable;}"), "html 上不再留滚动条的槽了？那这条判据的前提变了，改理由");
        Matcher mask = Pattern.compile("\\n\\.zq-modal-mask\\{([^}]*)\\}").matcher(css);
        assertTrue(mask.find(), "找不到 .zq-modal-mask");
        assertTrue(mask.group(1).contains("inset:0;width:100vw;"), "遮罩只有 inset:0 —— 占位滚动条的平台上右边漏一条没变暗的边");
        assertFalse(mask.find(), ".zq-modal-mask 定义了不止一次");
    }

    @Test
    @DisplayName("模型表单的下拉和卡片上的 Provider 用同一份表（MODEL_PROVIDERS）；下拉的 value 是接口里的代码")
    void 模型的Provider一份表() throws IOException {
        String js = settings();
        assertEquals(1, count(js, "export const MODEL_PROVIDERS = "), "MODEL_PROVIDERS 应当正好一份");
        assertTrue(js.contains("MODEL_PROVIDERS.map((p) => '<option value=\"' + p[0] + '\">' + p[1] + '</option>')"), "下拉不是照 MODEL_PROVIDERS 画的");
        assertTrue(js.contains("providerType: els.provider.value || MODEL_PROVIDERS[0][0],"), "保存时不是取下拉的 value");
        assertTrue(js.contains("els.display.value = m.displayName || m.label || '';"), "编辑时名字框里是 label（「名字（我的）」）");
    }

    private static int count(String text, String needle) {
        int n = 0;
        for (int i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) n++;
        return n;
    }
}
