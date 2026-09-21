package com.zhiqu.rag;

import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * 可索引单元的确定性分块器。
 *
 * <p><b>偏移单位是 Unicode code point，不是 Java 的 UTF-16 code unit。</b>
 * 转换负担全在这一侧：Python 的 {@code str} 本身就是 code point 序列，{@code len()}、切片、
 * {@code find()} 全是 code point 语义，sidecar 不需要做任何转换；而 Java 的
 * {@code String.length()}/{@code substring()} 全是 code unit 语义。两边不是各转一半，
 * 是 Java 独自承担全部口径转换，风险也全集中在这里。
 *
 * <p>口径不一致的故障形态没有异常兜底：含星平面字符（emoji、部分生僻字）的文本回读时，
 * 切出来的内容会偏移几个字，或者切开代理对产生孤立代理 —— 看起来像"模型答非所问"，
 * 而不像"偏移算错了"。
 *
 * <p><b>字素簇安全是独立于 code point 平价的另一条性质。</b>两边数出同一个数（平价），
 * 不等于那个位置适合切分。{@code 👨‍👩‍👧} 是 5 个 code point（3 个人 + 2 个 ZWJ），
 * 在任意 code point 边界切分都可能切出以孤立 ZWJ 结尾的块，而平价测试照样绿。
 * 因此切点要额外过一道「续接字符」判定（见 {@code isSafeBoundary}）——
 * <b>不能依赖 {@code java.text.BreakIterator}</b>，它不实现 UAX #29 扩展字素簇，
 * 会把 emoji 的 ZWJ 序列当成多个独立簇，用它对齐等于没对齐。
 */
@Service
public class RagUnitChunker {

    /** 目标块长（code point）。段落边界优先，够长就切。 */
    private static final int TARGET_CODE_POINTS = 1200;
    /** 硬上限：超过就在字素簇边界强切，避免单段无限长撑爆 sidecar 的单批限制。 */
    private static final int MAX_CODE_POINTS = 2000;

    /**
     * 分块结果。{@code charStart}/{@code charEnd} 是 <b>code point</b> 半开区间。
     */
    public record Chunk(int index, int charStart, int charEnd) {
    }

    /**
     * 对 Wiki 页与会话轮次分块。
     *
     * <p><b>Notebook 资料不走这里</b> —— 它必须复用 {@code ai_source_chunk} 的既有父块边界，
     * 否则「Notebook 行为不变」就是假的：重新切分会让每份存量资料的 content_hash 全部变化、
     * 触发一次没人要求的全量重建。
     */
    public List<Chunk> chunk(String text) {
        if (text == null || text.isEmpty()) {
            return List.of();
        }
        int totalCodePoints = text.codePointCount(0, text.length());
        List<Chunk> chunks = new ArrayList<>();
        int cursor = 0;
        while (cursor < totalCodePoints) {
            int end = Math.min(totalCodePoints, cursor + TARGET_CODE_POINTS);
            if (end < totalCodePoints) {
                end = preferParagraphBoundary(text, cursor, end, totalCodePoints);
            }
            end = alignToGraphemeBoundary(text, end, totalCodePoints);
            if (end <= cursor) {
                // 单个字素簇就超过剩余预算的极端情况：至少前进一个字素簇，避免死循环
                end = Math.min(totalCodePoints, nextGrapheme(text, cursor, totalCodePoints));
            }
            chunks.add(new Chunk(chunks.size(), cursor, end));
            cursor = end;
        }
        return chunks;
    }

    /**
     * 在 [target-回看窗口, target] 里找最后一个段落边界（连续两个换行）。
     * 找不到就退回 target —— 宁可切在句中，也不要把块撑到硬上限之外。
     */
    private int preferParagraphBoundary(String text, int from, int target, int total) {
        int lookback = Math.min(target - from, TARGET_CODE_POINTS / 3);
        for (int cp = target; cp > target - lookback; cp--) {
            if (cp >= 2 && isParagraphBreakAt(text, cp, total)) {
                return cp;
            }
        }
        return Math.min(target, from + MAX_CODE_POINTS);
    }

    /** 判断 code point 位置 cp 之前是否是「\n\n」。 */
    private boolean isParagraphBreakAt(String text, int cp, int total) {
        if (cp < 2 || cp > total) return false;
        int a = codePointAt(text, cp - 2);
        int b = codePointAt(text, cp - 1);
        return a == '\n' && b == '\n';
    }

    /**
     * 把 code point 位置回退到安全的字素簇边界。
     *
     * <p><b>不能用 {@link BreakIterator#getCharacterInstance}</b> —— 它遵循较早的
     * Unicode 文本边界规范，<b>不实现 UAX #29 的扩展字素簇</b>，会把 emoji 的 ZWJ 序列
     * 当成多个独立簇。于是 {@code isBoundary()} 在 {@code 👨‍} 与 {@code 👩} 之间返回 true，
     * 对齐成了空操作 —— 这正是本方法要防的那个场景。（该结论由 OffsetParityTest 的
     * 字素簇用例实测得出：改用 BreakIterator 时基线即红。）
     *
     * <p>因此改用显式的「续接字符」判定：某个位置若紧跟着 ZWJ、变体选择符、肤色修饰符、
     * 组合附加符号或 keycap，或者其前一个字符是 ZWJ，就不是安全切点，向前回退。
     */
    private int alignToGraphemeBoundary(String text, int codePointIndex, int total) {
        int index = codePointIndex;
        // 回退窗口有限：连续续接字符不会太长，兜底避免在畸形输入上退到 0
        int guard = 0;
        while (index > 0 && index < total && !isSafeBoundary(text, index, total) && guard++ < 64) {
            index--;
        }
        return index;
    }

    /**
     * 位置 {@code index} 是否可以作为切点。
     *
     * <p>判据是「下一个字符会不会依附于上一个字符」。这不是完整的 UAX #29 实现，
     * 但覆盖了实际会遇到的全部形态：emoji 家族/职业序列（ZWJ）、带变体选择符的符号、
     * 肤色修饰、组合附加符号（如 e + 锐音符）、keycap、以及国旗的区域指示符对。
     */
    private boolean isSafeBoundary(String text, int index, int total) {
        if (index <= 0 || index >= total) return true;
        int next = codePointAt(text, index);
        int prev = codePointAt(text, index - 1);

        if (prev == 0x200D) return false;                       // 前一个是 ZWJ：后面必然还有内容
        if (next == 0x200D) return false;                       // 下一个是 ZWJ：会把它与前文粘连
        if (next >= 0xFE00 && next <= 0xFE0F) return false;     // 变体选择符
        if (next >= 0x1F3FB && next <= 0x1F3FF) return false;   // 肤色修饰符
        if (next == 0x20E3) return false;                       // combining enclosing keycap
        if (isRegionalIndicator(prev) && isRegionalIndicator(next)) return false;  // 国旗成对

        int type = Character.getType(next);
        return type != Character.NON_SPACING_MARK
                && type != Character.ENCLOSING_MARK
                && type != Character.COMBINING_SPACING_MARK;
    }

    private boolean isRegionalIndicator(int codePoint) {
        return codePoint >= 0x1F1E6 && codePoint <= 0x1F1FF;
    }

    /** 从 code point 位置 from 前进到下一个安全边界，保证至少前进一位（避免死循环）。 */
    private int nextGrapheme(String text, int from, int total) {
        int index = Math.min(total, from + 1);
        int guard = 0;
        while (index < total && !isSafeBoundary(text, index, total) && guard++ < 64) {
            index++;
        }
        return index;
    }

    private int codePointAt(String text, int codePointIndex) {
        return text.codePointAt(text.offsetByCodePoints(0, codePointIndex));
    }

    /**
     * 按 code point 区间切片 —— <b>回读路径必须走这里，不能用 substring</b>。
     *
     * <p>{@code substring(charStart, charEnd)} 是把 code point 偏移当 UTF-16 偏移用。
     * 后果不是异常，是「错位但看起来正常」的文本，或者切开代理对产生孤立代理。
     * 这条没有异常兜底，只能靠约定与断言。
     */
    public static String sliceByCodePoints(String text, int startCodePoint, int endCodePoint) {
        if (text == null || text.isEmpty()) return "";
        int total = text.codePointCount(0, text.length());
        int from = Math.max(0, Math.min(startCodePoint, total));
        int to = Math.max(from, Math.min(endCodePoint, total));
        int utf16From = text.offsetByCodePoints(0, from);
        int utf16To = text.offsetByCodePoints(0, to);
        return text.substring(utf16From, utf16To);
    }
}
