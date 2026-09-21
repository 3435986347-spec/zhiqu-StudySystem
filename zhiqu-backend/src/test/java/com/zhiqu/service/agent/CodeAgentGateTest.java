package com.zhiqu.service.agent;

import com.zhiqu.SourceText;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 代码工作区 agent 的门：三个条件缺一不可，而且<b>唯一定义</b>。
 *
 * <h2>为什么「工作区是否可读」要算进门里</h2>
 *
 * <p>不算进去的话，工作区关着时也会造出一个 {@code CODE_AGENT} 节点 —— 它跑起来什么都做不了，
 * 在执行轨迹里留下一个白占位置的方块。那正是本仓库前几轮反复清掉的<b>幽灵节点</b>，
 * 而 {@code AgentGraphOrderDerivationTest} 现在会因为「图里有执行侧没有的 agent」直接抛异常。
 *
 * <h2>为什么要有「只提到代码但没动作」的反例</h2>
 *
 * <p>「我最近在写代码」不该把一整套文件工具塞给模型：那会让它去翻不相干的文件，
 * 既慢又容易答偏。与 {@code wikiToolIntent} 同构 —— 提到 + 动作，两个都要。
 */
class CodeAgentGateTest {
    private static final Path AI_SERVICE =
            Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java");

    private static AgentPlanDecision decide(String message, boolean toolCalling, boolean workspaceReadable) {
        return AgentPlanDecision.of("AUTO", message, false, null, Map.of(),
                toolCalling, false, workspaceReadable);
    }

    @Test
    void 提到代码并且有动作才算数() {
        assertTrue(AgentPlanDecision.codeIntent("帮我看看 src/Main.java 这段代码"));
        assertTrue(AgentPlanDecision.codeIntent("这个函数为什么会报错"));
        assertTrue(AgentPlanDecision.codeIntent("审阅一下我的项目结构"));
        assertTrue(AgentPlanDecision.codeIntent("Main.java 里那个方法怎么改"));
    }

    @Test
    void 只提到代码没有动作不算() {
        assertFalse(AgentPlanDecision.codeIntent("我最近在学代码"),
                "只是提了一句代码，不该把一整套文件工具塞给模型 —— 它会去翻不相干的文件");
        assertFalse(AgentPlanDecision.codeIntent("这本书讲的是代码规范"),
                "没有动作词就不该触发");
        assertFalse(AgentPlanDecision.codeIntent("代码很有意思"));
    }

    /**
     * 一个<b>已知的过触发</b>，钉成判据是为了让它是「选的」而不是「漏的」。
     *
     * <p>「今天写了三小时代码」会触发，因为「写」+「代码」两个词都在。词袋分不开它与
     * 「帮我写一个排序函数」—— 要区分得做意图分类，那是另一次模型往返。
     *
     * <p>刻意选了过触发这一边：过触发只是多跑一轮有界的工具循环（4 轮 / 30 秒预算 /
     * 失败不影响主回答），而漏触发意味着用户问他的代码、模型却凭空编。
     * 哪天有人想收紧，这条判据会红 —— 那时他就会读到这段说明，而不是以为自己在修一个 bug。
     */
    @Test
    void 已知会过触发的那一类() {
        assertTrue(AgentPlanDecision.codeIntent("今天写了三小时代码，有点累"),
                "这是已知且有意保留的过触发。收紧之前先读这条判据的说明："
                        + "代价不对称，漏触发比过触发糟得多");
        assertTrue(AgentPlanDecision.codeIntent("帮我写一个排序函数"),
                "而这一句必须触发 —— 它和上面那句用的是同样的词，这就是词袋分不开的原因");
    }

    @Test
    void 与代码无关的话一律不算() {
        assertFalse(AgentPlanDecision.codeIntent("帮我安排下周的复习计划"));
        assertFalse(AgentPlanDecision.codeIntent("把这条记到知识 Wiki 里"));
        assertFalse(AgentPlanDecision.codeIntent(""));
        assertFalse(AgentPlanDecision.codeIntent(null));
    }

    /**
     * 工作区关着时不得造出这个节点。
     *
     * <p>扰动：把 {@code && workspaceReadable} 去掉 → 本条红。
     */
    @Test
    void 工作区不可读时不得启用() {
        assertFalse(decide("帮我看看 Main.java 这段代码", true, false).needsCodeAgent(),
                "工作区没开时造出 CODE_AGENT，就是一个跑不了的幽灵节点");
        assertTrue(decide("帮我看看 Main.java 这段代码", true, true).needsCodeAgent(),
                "反例：三个条件都满足时必须启用，否则「一律不启用」也能让上面绿");
    }

    /** 模型不支持工具调用时同理 —— 没有工具，这个 agent 什么也做不了。 */
    @Test
    void 模型不支持工具调用时不得启用() {
        assertFalse(decide("帮我看看 Main.java 这段代码", false, true).needsCodeAgent());
    }

    /**
     * 实现侧不得另起一个判定。
     *
     * <p>本仓库已经因为「同一个门两处各判一次」分叉过：建图侧与执行侧的意图判定曾经方向相反，
     * 造出跑不了的幽灵节点。所以 {@code AiServiceImpl} 里只允许<b>调用</b>这个门，
     * 不允许自己写一套关键词。
     */
    @Test
    void 实现侧只能调用这道门不能另起一套() throws IOException {
        String code = SourceText.stripComments(Files.readString(AI_SERVICE, StandardCharsets.UTF_8));
        assertTrue(code.contains("AgentPlanDecision.codeIntent("),
                "AiServiceImpl 必须调用唯一那道门");
        assertFalse(code.contains("looksCodeIntent") || code.contains("private boolean codeIntent"),
                "不得在实现侧另写一个代码意图判定 —— 两处各判一次迟早分叉");
    }

    /** 执行侧问的必须是<b>生效档位</b>，不是配置里写的那一档。 */
    @Test
    void 执行侧必须问生效档位() throws IOException {
        String code = SourceText.stripComments(Files.readString(AI_SERVICE, StandardCharsets.UTF_8));
        assertTrue(code.contains("workspaceService.access().effectiveMode().allowsRead()"),
                "三个前置有一条不满足时配置写 EXEC 也只能是 OFF —— 必须问 effectiveMode，"
                        + "问 configuredMode 会让工作区在没绑回环时也造出节点");
        assertFalse(code.contains("workspaceService.access().configuredMode()"),
                "不得用配置档位做权限判断");
    }

    /**
     * 声明给模型的每个工作区工具，都必须有执行分支。
     *
     * <h2>缺了分支不会报错，会变成模型编一个结果</h2>
     *
     * <p>{@code executeWorkspaceTool} 对认不出的名字返回「未知的工作区工具：X」。
     * 那句话是发给<b>模型</b>的，不是发给日志的：模型看到自己声明可用的工具说自己不存在，
     * 多半不会如实转述，而是换个说法继续，最后凭文件名编出一段它从没读过的代码。
     * 这类错误在日志里一片安静。
     *
     * <p>这条判据是加 {@code search_workspace} 时写的 —— 当时工具已经在提示词里
     * 写了「你可以按关键词搜」，但既没有声明也没有实现，提示词说的是一件不存在的事。
     *
     * <p>扰动：删掉 {@code executeWorkspaceTool} 里任意一个 {@code equals(name)} 分支 → 本条红。
     */
    @Test
    void 声明的工作区工具必须都能执行() throws IOException {
        String code = SourceText.stripComments(Files.readString(AI_SERVICE, StandardCharsets.UTF_8));

        Set<String> declared = new TreeSet<>();
        Matcher dm = Pattern.compile("functionTool\\(\"(\\w*workspace\\w*)\"").matcher(code);
        while (dm.find()) {
            declared.add(dm.group(1));
        }

        Set<String> handled = new TreeSet<>();
        Matcher hm = Pattern.compile("\"(\\w*workspace\\w*)\"\\.equals\\(name\\)").matcher(code);
        while (hm.find()) {
            handled.add(hm.group(1));
        }

        // 下限：扫空和「全都对上了」形状一样。三个只读工具是当前的下界。
        assertTrue(declared.size() >= 3,
                "只解析出 " + declared.size() + " 个工作区工具声明 —— 正则多半没跟上写法的变化，"
                        + "这时候的绿是「什么都没看到」，不是「没问题」。解析到的：" + declared);

        assertEquals(declared, handled,
                "声明给模型的工具和能执行的工具对不上。声明了没实现的那些，模型会调用它们、"
                        + "拿到「未知的工作区工具」，然后多半不会如实转述而是自己编一个结果。"
                        + "声明：" + declared + "，实现：" + handled);
    }

    /**
     * 写这道门比读那道窄，而且是刻意的。
     *
     * <p>读过触发的代价是白读几个文件；写过触发的代价是弹出一个用户没要的确认框，
     * 而确认框本身就会诱导人去点。所以「看看这段代码」只给读，「帮我改一下」才给写。
     */
    @Test
    void 写意图要同时命中代码与写动作() {
        assertTrue(AgentPlanDecision.codeWriteIntent("帮我改一下 Main.java 里那个方法"));
        assertTrue(AgentPlanDecision.codeWriteIntent("这段代码重构一下"));
        assertTrue(AgentPlanDecision.codeWriteIntent("修复 Calculator.java 的除零问题"));

        assertFalse(AgentPlanDecision.codeWriteIntent("帮我看看这段代码为什么报错"),
                "只是问原因 —— 给写工具就会诱导它产出一份用户没要的草稿");
        assertFalse(AgentPlanDecision.codeWriteIntent("审阅一下我的项目结构"));
        assertFalse(AgentPlanDecision.codeWriteIntent("帮我改一下复习计划"),
                "「改」命中了写动作，但整句与代码无关，不该开写工具");
        assertFalse(AgentPlanDecision.codeWriteIntent(""));
        assertFalse(AgentPlanDecision.codeWriteIntent(null));
    }

    /** 读意图成立、写意图不成立时，写工具<b>连声明都不能有</b>。 */
    @Test
    void 没有写意图时不得下发写工具() throws IOException {
        String code = SourceText.stripComments(Files.readString(AI_SERVICE, StandardCharsets.UTF_8));

        assertTrue(code.contains("buildWorkspaceTools(canWrite)"),
                "工具集必须按写意图分档下发 —— 不下发，模型就不会尝试，也不会承诺自己改了文件");
        assertTrue(code.contains("AgentPlanDecision.codeWriteIntent("),
                "写意图必须问 AgentPlanDecision 那道唯一的门");
        assertFalse(code.contains("private boolean codeWriteIntent") || code.contains("looksCodeWriteIntent"),
                "不得在实现侧另写一套写意图判定 —— 两处各判一次迟早分叉");

        // write_workspace_file 的声明必须在 canWrite 分支里，不能无条件加进工具集
        int declaration = code.indexOf("functionTool(\"write_workspace_file\"");
        assertTrue(declaration > 0, "找不到写工具的声明 —— 判据的锚点没了");
        int gate = code.indexOf("if (canWrite) {");
        assertTrue(gate > 0 && gate < declaration,
                "写工具的声明必须在 if (canWrite) 里面。无条件声明的话，"
                        + "用户只是问「这段代码为什么报错」，模型也会拿到改文件的能力");
    }

    /** 磁盘那一侧也要问档位：写意图成立但工作区是只读的，同样不能下发写工具。 */
    @Test
    void 只读档下即使有写意图也不下发写工具() throws IOException {
        String code = SourceText.stripComments(Files.readString(AI_SERVICE, StandardCharsets.UTF_8));
        // 只看 canWrite 那一条语句本身。用 code.contains("allowsWrite()") 这种全文匹配的话，
        // 这两个字符串在文件里到处都是，判据永远绿 —— 那是一条不可能红的判据。
        int at = code.indexOf("boolean canWrite =");
        assertTrue(at > 0, "找不到 canWrite 的赋值 —— 判据的锚点没了，它现在什么都没看到");
        int end = code.indexOf(';', at);
        String statement = code.substring(at, end + 1);

        assertTrue(statement.contains("allowsWrite()"),
                "canWrite 必须要求工作区本身允许写。少了这一条，只读工作区里模型照样会产出草稿，"
                        + "用户点确认才发现写不了。实际语句：" + statement);
        assertTrue(statement.contains("codeWriteIntent("),
                "canWrite 必须要求这句话确实是写意图。实际语句：" + statement);
    }

    /**
     * 读工作区也要管理员 —— 否则 {@code /api/workspace/**} 上那道管理员限制是装饰。
     *
     * <h2>两条路通向同一批文件</h2>
     *
     * <p>工作区的内容有两个出口：管理员限定的 HTTP 端点，和 AI 助手的 code agent。
     * 后者一度只检查「工作区生效档位允许读」，不检查用户是谁。于是在多用户部署上，
     * 任何登录用户只要对助手说一句「看看 src/main/resources/application.yml」，
     * 就能拿到服务器磁盘上的内容 —— 而 {@code WorkspaceController} 上那道
     * {@code requireAdmin()} 一点作用都没起。
     *
     * <p>工作区读的是<b>服务器</b>的磁盘，不像 Notebook 那样按 userId 分账，
     * 所以「登录了」远远不够。
     *
     * <p>判定必须由 {@code AdminGuard} 给出，不许另写 —— {@code AdminGuard.isAdmin}
     * 本身就是从 {@code requireAdmin} 派生的，为的是两者不可能分叉。
     *
     * <p>扰动：把 {@code workspaceReadableBy} 里的 {@code adminGuard.isAdmin} 去掉 → 本条红。
     */
    @Test
    void 读工作区必须同时要求管理员() throws IOException {
        String code = SourceText.stripComments(Files.readString(AI_SERVICE, StandardCharsets.UTF_8));

        int at = code.indexOf("private boolean workspaceReadableBy(");
        assertTrue(at > 0, "找不到 workspaceReadableBy —— 判据的锚点没了，它现在什么都没看到");
        int end = code.indexOf('}', code.indexOf('{', at));
        String body = code.substring(at, end);

        assertTrue(body.contains("adminGuard.isAdmin("),
                "读工作区必须要求管理员。少了这一条，普通用户对助手说一句「看看 xxx」"
                        + "就绕过了 /api/workspace/** 上的管理员限制。实际：" + body);
        assertTrue(body.contains("allowsRead()"),
                "也必须要求生效档位允许读。实际：" + body);

        // 两个入口都要走这一个判定，不许其中一个直接问档位
        assertEquals(1, countOccurrences(code, "effectiveMode().allowsRead()"),
                "「工作区能不能读」只允许有一处判定（workspaceReadableBy）。"
                        + "多出来的那一处迟早只改一边 —— 本仓库反复在消灭的就是这个物种");
    }

    private static int countOccurrences(String haystack, String needle) {
        int n = 0;
        for (int i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length())) {
            n++;
        }
        return n;
    }
}
