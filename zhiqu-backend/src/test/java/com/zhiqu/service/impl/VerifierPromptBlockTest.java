package com.zhiqu.service.impl;

import com.zhiqu.SourceText;
import com.zhiqu.entity.AiVerifierFinding;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 证据校验的结论必须<b>进回答提示词</b>，没有结论时不得凭空插入。
 *
 * <h2>为什么钉在单元层而不是集成层</h2>
 *
 * <p>集成层拿不到这个局面：能产出 WARNING 的只有「来源抓取失败」一条路，
 * 而 {@code WebPageFetchProvider} 的 SSRF 防护对私网地址与无法解析的域名<b>一律抛
 * BusinessException 打挂整轮</b>（它只把其它异常转成 FAILED 结果）。要在测试里绕开，
 * 就得关掉 {@code app.ai.web-fetch.block-private-network} —— 而那个防护<b>自己一条判据都没有</b>。
 * 不为了测 A 去悄悄削弱 B。
 *
 * <p>阻断那一侧是可达的，钉在
 * {@code AiConversationLifecycleIntegrationTest.勾了资料源却零证据必须阻断整轮()}。
 *
 * <h2>两条互为反例</h2>
 *
 * <p>「一律插入」满足第 1 条、「从不插入」满足第 2 条 —— 单独任何一条都挡不住另一头。
 */
class VerifierPromptBlockTest {

    @Test
    void 有校验结论时必须插入提示块() {
        List<Map<String, Object>> messages = new ArrayList<>();
        messages.add(Map.of("role", "system", "content", "sys"));

        AiServiceImpl.appendVerifierBlock(messages, List.of(
                finding("有来源抓取失败，未进入证据。"),
                finding("有结论没有任何证据支撑。")));

        assertEquals(2, messages.size(), "应当正好追加一条消息");
        Map<String, Object> block = messages.get(1);
        assertEquals("user", block.get("role"),
                "必须是 user 数据块而不是 system —— 它由运行期数据拼成，可能间接混入用户内容"
                        + "（失败来源的标题、URL），不该拿到 system 那一级的权重");
        String content = String.valueOf(block.get("content"));
        assertTrue(content.startsWith(AiServiceImpl.VERIFIER_BLOCK_HEADER), "表头要在最前");
        assertTrue(content.contains("有来源抓取失败") && content.contains("没有任何证据支撑"),
                "每条结论都要带进去，实际：" + content);
        assertTrue(content.contains("不要宣称你拥有实际上没有取到的资料来源"),
                "要给模型一句可执行的约束，否则它只是收到一堆事实");
    }

    @Test
    void 没有校验结论时不得插入() {
        List<Map<String, Object>> empty = new ArrayList<>();
        AiServiceImpl.appendVerifierBlock(empty, List.of());
        assertTrue(empty.isEmpty(), "没有结论就不该有提示块 —— 否则每一轮都多一段废话");

        List<Map<String, Object>> blankOnly = new ArrayList<>();
        AiServiceImpl.appendVerifierBlock(blankOnly, List.of(finding("   ")));
        assertTrue(blankOnly.isEmpty(), "结论文本为空时同样不插入，否则会插入一个只有表头的空块");
    }

    /**
     * 注入<b>调用点</b>必须还在 —— 上面两条测的是这个方法本身，测不到有没有人调它。
     *
     * <p>把 {@code appendVerifierBlock(messages, s.verifierFindings)} 从 FinalWriterRunner 里删掉，
     * 上面两条照样全绿：那正是这一轮开头要修的原状（校验做了，但没人听）。
     * 扰动逮到的，不是复核逮到的。
     *
     * <p>走源码文本是退而求其次 —— 端到端拿不到能产出 WARNING 的局面（见类注释）。
     * 必须<b>先剥注释</b>：本类与实现里的说明文字都写着这个方法名，不剥就会被说明文字满足。
     */
    @Test
    void 注入调用点必须还在() throws IOException {
        Path impl = Path.of("src", "main", "java", "com", "zhiqu", "service", "impl", "AiServiceImpl.java");
        String code = SourceText.stripComments(Files.readString(impl, StandardCharsets.UTF_8));

        assertTrue(code.contains("appendVerifierBlock(messages, s.verifierFindings)"),
                "FinalWriterRunner 组装提示词时必须调用 appendVerifierBlock —— "
                        + "没有这一句，校验结论就只发给前端看，模型照样用笃定的口气作答");
        assertTrue(code.contains("verifierService.verifyAnswerCitations(s.agentRun.getId(), s.allCitationRows"),
                "ANSWER_VERIFIER 必须核对 s.allCitationRows —— 那是模型实际带出来的引用。"
                        + "换成别的来源就等于自己核对自己取到的东西，恒为通过");
        assertTrue(code.contains("s.verifierFindings = List.copyOf(findings)"),
                "VerifierRunner 必须把 findings 存进 state，否则上一句拿到的永远是空列表 —— "
                        + "那种断链比删掉调用更隐蔽：调用点还在，内容是空的");
    }

    private static AiVerifierFinding finding(String message) {
        AiVerifierFinding item = new AiVerifierFinding();
        item.setMessage(message);
        item.setSeverity("WARNING");
        return item;
    }
}
