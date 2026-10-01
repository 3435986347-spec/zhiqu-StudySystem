package com.zhiqu.rag;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * code point 偏移的跨语言平价，以及分块边界的字素簇安全。
 *
 * <p><b>为什么需要共享 fixture</b>：平价是一条跨语言性质，Java-only 或 Python-only 的测试
 * 都证明不了它 —— 各自跟自己的期望值比对，两边同时漂了也全绿。因此双方共读
 * {@code rag-service/tests/fixtures/offset_parity.json}，断言同一批数字。
 *
 * <p><b>转换负担全在 Java 侧</b>：Python 的 str 本身就是 code point 序列，{@code len()} 与切片
 * 天然是 code point 语义；Java 的 {@code length()}/{@code substring()} 是 UTF-16 语义。
 * 所以这份 fixture 对 Python 侧近乎恒等断言，真正的风险全在这边。
 *
 * <p>声称钉住四条性质，对应四次扰动（见提交说明）：
 * <ol>
 *   <li>code point 计数与切片的跨语言平价</li>
 *   <li>分块偏移的往返切片相等</li>
 *   <li>分块边界不破字素簇（独立于平价 —— 两边数出同一个数，不等于那个位置能切）</li>
 *   <li>加法合成：{@code absolute = chunkStart + segmentStart} 在 sidecar 的实际文本处理下成立</li>
 * </ol>
 */
class OffsetParityTest {

    private static final Path FIXTURE =
            Path.of("..", "rag-service", "tests", "fixtures", "offset_parity.json");

    private final RagUnitChunker chunker = new RagUnitChunker();

    // ── 性质 1：跨语言平价 ────────────────────────────────────────────────

    @Test
    void codePoint计数与切片与python侧逐条一致() throws Exception {
        JsonNode cases = new ObjectMapper().readTree(Files.readString(FIXTURE)).get("cases");
        assertTrue(cases.size() >= 7, "fixture 用例被删减了？平价覆盖面会跟着缩水");

        for (JsonNode item : cases) {
            String name = item.get("name").asText();
            String text = item.get("text").asText();

            assertEquals(item.get("codePointCount").asInt(), text.codePointCount(0, text.length()),
                    "用例 " + name + " 的 code point 计数与 Python 侧不一致。"
                            + "Java 用了 length() 而非 codePointCount 时会在此处红");

            for (JsonNode slice : item.get("slices")) {
                assertEquals(slice.get("expected").asText(),
                        RagUnitChunker.sliceByCodePoints(text, slice.get("start").asInt(), slice.get("end").asInt()),
                        "用例 " + name + " 的 code point 切片与 Python 的 text[start:end] 不一致");
            }
        }
    }

    /**
     * 反面：用 substring 直接当 code point 切片会错 —— 这条钉住「两者确实不等价」，
     * 免得有人看到 sliceByCodePoints 觉得是多余包装而改回 substring。
     */
    @Test
    void substring与codePoint切片在星平面字符上确实不等价() {
        String text = "计划🚀完成";   // 「计划🚀完成」，5 个 code point / 6 个 code unit

        assertEquals(5, text.codePointCount(0, text.length()));
        assertEquals(6, text.length());
        assertEquals("计划🚀", RagUnitChunker.sliceByCodePoints(text, 0, 3));
        assertEquals("计划\uD83D", text.substring(0, 3), "substring 在此处切开了代理对");
    }

    // ── 性质 2：往返切片相等 ──────────────────────────────────────────────

    @Test
    void 分块偏移回读后能逐字拼回原文() {
        String text = ("第一段落，包含🚀与👨‍👩‍👧。\n\n" + "第二段落。".repeat(300)
                + "\n\n第三段落𠮷结束。");

        List<RagUnitChunker.Chunk> chunks = chunker.chunk(text);
        assertTrue(chunks.size() > 1, "样本需要跨越多个块才有意义");

        StringBuilder rebuilt = new StringBuilder();
        int expectedStart = 0;
        for (RagUnitChunker.Chunk chunk : chunks) {
            assertEquals(expectedStart, chunk.charStart(), "块之间不得有空洞或重叠");
            rebuilt.append(RagUnitChunker.sliceByCodePoints(text, chunk.charStart(), chunk.charEnd()));
            expectedStart = chunk.charEnd();
        }
        assertEquals(text.codePointCount(0, text.length()), expectedStart, "最后一块必须覆盖到结尾");
        assertEquals(text, rebuilt.toString(), "按偏移回读拼接后必须逐字等于原文");
    }

    // ── 性质 3：字素簇安全（独立于平价）────────────────────────────────────

    /**
     * 平价测试证明「两边数出同一个数」，不证明「那个位置适合切」。
     * {@code 👨‍👩‍👧} 是 5 个 code point（3 个人 + 2 个 ZWJ），在任意 code point 边界切分
     * 都可能切出以孤立 ZWJ 结尾的块 —— 而平价测试照样绿，因为两边确实都数到了同一个位置。
     */
    @Test
    void 分块边界不会切开字素簇() {
        // 家庭 emoji 是 5 个 code point（👨 ZWJ 👩 ZWJ 👧）。填充长度必须让目标切点
        // （TARGET_CODE_POINTS = 1200）落进这个簇的**内部**，否则边界本就干净、
        // 对齐逻辑成了空操作，删掉它测试也照样绿——本条就白写了。
        // filler 取 1198：簇占 cp 1198..1202，1200 恰好卡在 👨‍ 与 👩 之间。
        String filler = "文".repeat(1198);
        String text = filler + "👨‍👩‍👧" + "尾".repeat(1200);
        assertEquals(1198 + 5 + 1200, text.codePointCount(0, text.length()),
                "样本构造前提：簇必须横跨目标切点 1200");

        List<RagUnitChunker.Chunk> chunks = chunker.chunk(text);

        // 刻意不用 java.text.BreakIterator 来校验：它不实现 UAX #29 扩展字素簇，
        // 会把 ZWJ 序列当成多个独立簇，拿它当尺子等于用同一个错误验证自己。
        // 改为直接断言可观察的后果。
        List<String> violations = new ArrayList<>();
        for (RagUnitChunker.Chunk chunk : chunks) {
            String body = RagUnitChunker.sliceByCodePoints(text, chunk.charStart(), chunk.charEnd());
            if (body.isEmpty()) continue;
            int lastCp = body.codePointBefore(body.length());
            int firstCp = body.codePointAt(0);
            if (lastCp == 0x200D) {
                violations.add("块 " + chunk.index() + " 以孤立 ZWJ 结尾");
            }
            if (firstCp == 0x200D) {
                violations.add("块 " + chunk.index() + " 以孤立 ZWJ 开头");
            }
            if (Character.getType(firstCp) == Character.NON_SPACING_MARK) {
                violations.add("块 " + chunk.index() + " 以失去基字的组合附加符号开头");
            }
            if (firstCp >= 0x1F3FB && firstCp <= 0x1F3FF) {
                violations.add("块 " + chunk.index() + " 以失去基字的肤色修饰符开头");
            }
        }
        assertEquals(List.of(), violations, String.join("；", violations));
        assertFalse(chunks.isEmpty());
    }

    /** 续接字符逐类覆盖：任一类漏判，对应的块都会以"失去依附对象"的字符开头。 */
    @Test
    void 各类续接字符都不会被切开() {
        List<String> samples = List.of(
                "👨‍👩‍👧",   // ZWJ 家族
                "❤️",               // 变体选择符
                "👋🏻",        // 肤色修饰符
                "é",               // 组合锐音符
                "1⃣",               // keycap
                "🇨🇳" // 国旗（区域指示符对）
        );
        for (String sample : samples) {
            String text = "前".repeat(1199) + sample + "后".repeat(1200);
            for (RagUnitChunker.Chunk chunk : chunker.chunk(text)) {
                String body = RagUnitChunker.sliceByCodePoints(text, chunk.charStart(), chunk.charEnd());
                if (body.isEmpty()) continue;
                assertFalse(body.startsWith("‍") || body.endsWith("‍"),
                        "样本 " + sample + " 被 ZWJ 处切开");
                assertFalse(sample.contains(body) && !sample.equals(body) && body.length() < sample.length(),
                        "样本 " + sample + " 被拆成了片段：" + body);
            }
        }
    }

    // ── 性质 4：加法合成 ──────────────────────────────────────────────────

    /**
     * sidecar 返回的 segment 偏移是**相对父块**的，回读时必须做
     * {@code absolute = chunk.charStart + segment.charStart}。
     *
     * <p>这条成立的前提是 sidecar 在**未经任何变换的该文本**上算偏移。已核实
     * {@code segment_text} 直接对收到的文本调 tokenizer、我们的代码零归一化；
     * HF fast tokenizer 跨归一化维护对齐并指向原串，slow tokenizer 则对
     * {@code return_offsets_mapping} 抛 NotImplementedError（失败是响亮的）。
     */
    @Test
    void 父块偏移与段偏移可加法合成() {
        String text = "开头🚀" + "内容".repeat(900) + "结尾𠮷";
        List<RagUnitChunker.Chunk> chunks = chunker.chunk(text);
        RagUnitChunker.Chunk second = chunks.get(1);

        String chunkBody = RagUnitChunker.sliceByCodePoints(text, second.charStart(), second.charEnd());
        // 模拟 sidecar：在父块文本内取一段（相对偏移）
        int segStart = 5;
        int segEnd = 20;
        String viaComposition = RagUnitChunker.sliceByCodePoints(
                text, second.charStart() + segStart, second.charStart() + segEnd);
        String viaChunkLocal = RagUnitChunker.sliceByCodePoints(chunkBody, segStart, segEnd);

        assertEquals(viaChunkLocal, viaComposition,
                "绝对偏移 = 父块起点 + 段内偏移；不成立说明某一侧的偏移单位不是 code point");
    }
}
