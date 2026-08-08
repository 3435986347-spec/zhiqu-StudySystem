package com.zhiqu.rag;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 每个作业类型都必须有生产端。
 *
 * <p>这个代码库结构上会长出一种洞：<b>有消费端、没有生产端的作业类型</b>。
 * 已经发生过三次，没有一次是编译或测试发现的 ——
 * {@code RECONCILE_UNITS} 靠回滚演练走到第 3 步无路可走时暴露、
 * {@code DELETE_SCOPE} 靠自查、{@code DELETE_INDEX_VERSION} 靠评审（且它一直就没有生产端，
 * 已随 {@link RagOperation} 的引入删除）。
 *
 * <p><b>消费端那一半不在这里测</b>：{@code RagIndexWorker.process()} 对枚举做增强 switch
 * 且不写 default，漏掉一个常量是编译错误。能交给编译器的不写测试 —— 写了反而会让人以为
 * 那一半也需要维护。
 *
 * <p>生产端没有等价的语言机制（没有任何东西能要求「这个常量必须被谁调用」），
 * 所以只能靠一条测试。**一次断言覆盖整个词表**，而不是每个操作各写一条：
 * 后者的失效方式恰好是「加了新常量的人也不会想起来加那一条」，
 * 与它要防的问题是同一个。
 */
class RagOperationCoverageTest {

    /**
     * 判据是「作业类型的名字出现在生产端源码里」，不是「有一个叫 enqueueXxx 的方法」。
     *
     * <p>选前者是因为入队点的命名与形态并不统一：有的走私有 {@code enqueue(...)} 辅助方法
     * 并把 operation 当参数传（{@code enqueueDeleteSource}），有的直接
     * {@code job.setOperation("RECONCILE_UNITS")}，还有的经 {@code enqueueUnit} 中转。
     * 按方法名匹配会漏掉后两种。
     *
     * <p>匹配的是 <b>{@code RagOperation.XXX} 这个引用形式</b>，不是裸字符串
     * {@code "XXX"}。注释里几乎不会出现全限定的枚举引用，误命中面因此小一大截 ——
     * 这是近乎零成本的收紧。
     *
     * <p><b>但定义域仍然比它声称的性质宽 —— 明写在这里。</b>
     * 它挡的是「消费端写完了、生产端整个忘了」这一种，挡不住「入队方法写了但没人调它」。
     * 后者是下一层问题，需要的是集成测试（{@code RagIncrementalEnqueueTest} 那种：
     * 调业务 API、查库里有没有作业行），不是这一条。
     *
     * <p><b>1b 会把 {@code enqueue(...)} 的参数从 {@code String} 换成 {@link RagOperation}。
     * 那不能取代本测试 —— 曾经在这里写过「到时本测试可整个删掉」，那句话是错的。</b>
     * 三条性质摊开看：
     * <ul>
     *   <li>每个常量有<b>消费端</b> → switch 表达式无 default，编译器管（1a 已落地）；</li>
     *   <li>作业不能带词表<b>外</b>的 operation → 类型化后编译器管（1b 要加）；</li>
     *   <li>每个常量有<b>生产端</b> → 以上两者都不给，只有本测试。</li>
     * </ul>
     * 第三条是<b>可达性</b>性质，不是类型性质。类型化之后照样可以加一个
     * {@code RagOperation.FOO}、被编译器逼着写好消费端分支、然后从不调用
     * {@code enqueue(FOO, ...)} —— 而那正是 {@code DELETE_SCOPE} 与
     * {@code DELETE_INDEX_VERSION} 的形状。
     *
     * <p>一句话：<b>类型化收窄的是词表的取值范围，不是词表被用到的程度。</b>
     *
     * <p>1b 该做的是<b>改进</b>本测试而不是取代它：类型化之后生产端写的就是
     * {@code RagOperation.XXX}，匹配模式已经在本轮提前收紧到那个形式，1b 之后它反而更强。
     * 做那一步时同样记得**验证编译器真的接住了** —— 见本文件末尾扰动 A 的教训。
     */
    @Test
    void 每个作业类型都至少有一个生产端() throws IOException {
        Path producer = Path.of("src/main/java/com/zhiqu/rag/RagIndexJobService.java");
        assertTrue(Files.exists(producer), "生产端源码未找到：" + producer.toAbsolutePath());
        String source = Files.readString(producer, StandardCharsets.UTF_8);

        List<String> missing = new ArrayList<>();
        for (RagOperation operation : RagOperation.values()) {
            if (!source.contains("RagOperation." + operation.name())) missing.add(operation.name());
        }

        assertTrue(missing.isEmpty(),
                "以下作业类型有定义、有消费端，却没有任何生产端 —— "
                        + "它们会以「作业永远不出现」的形式静默失效，"
                        + "而消费端的代码单看完全正常：" + missing);
    }

    /** 反面：判据本身要能报错。词表为空时上面那条会空转通过，这条挡住它。 */
    @Test
    void 作业类型词表非空() {
        assertTrue(RagOperation.values().length >= 9,
                "词表意外收缩 —— 删作业类型是可以的，但要确认消费端与本测试同步更新");
    }

    /** 未知字符串必须解析成 null，让 worker 能把它当失败作业上报而不是炸掉整个批次循环。 */
    @Test
    void 未知操作名解析为null而不是抛异常() {
        org.junit.jupiter.api.Assertions.assertNull(RagOperation.from("SOMETHING_FROM_THE_FUTURE"));
        org.junit.jupiter.api.Assertions.assertNull(RagOperation.from(null));
        org.junit.jupiter.api.Assertions.assertEquals(
                RagOperation.DELETE_SCOPE, RagOperation.from("DELETE_SCOPE"));
    }
}

// ── 扰动记录（2026-08-08 实测）──────────────────────────────────────────────
//
// 本文件与 RagIndexWorker.process() 分管同一条不变量的两半：
//   消费端「每个作业类型都被处理」→ 交给编译器（switch 表达式，无 default）
//   生产端「每个作业类型都被入队」→ 只能靠本测试
//
//   扰动                                  预期        实测
//   ────────────────────────────────────────────────────────────────────────
//   A  只加枚举常量，不加 switch 分支        COMPILE-FAIL  **COMPILE-OK ✗**（第一版）
//   A' 同上，process() 改成 switch 表达式后  COMPILE-FAIL  COMPILE-FAIL ✓
//   B  加常量 + 加分支，但无生产端           RED           RED ✓
//
// **A 第一版是绿的，这是本轮最值钱的一条实证。**
// 第一版 process() 写的是 switch **语句**，而注释里声称「加常量会编译失败」。
// 实测：Java 只对 switch **表达式**做穷尽性检查；枚举常量的 switch **语句**
// 漏掉一个常量照常编译通过。改成 `Runnable action = switch (...) {...}` 之后才成立。
//
// 由此得到一条比「消除型修法需要扰动验证」更窄、也更可操作的规则：
//
//   **凡是「某件事现在不可能发生」的声称，如果依据是工具链的行为**
//   **（编译器、构建插件、框架、数据库约束），必须有一次尝试做那件事的扰动。**
//   代码里的消除可以靠读代码确认；工具链的消除不能。
//
// 同类前科（本项目）：pom 的 useIncrementalCompilation —— 声称 false 让编译器全量
// 重编，实测方向相反，true 才是。两次都是关于工具链行为的断言，两次都错，
// 两次都只能靠执行发现：switch 语句与表达式在源码里几乎一样，两者都编译、都运行，
// 差别只在结果有没有被使用。
//
// 分工也值得记：B 一直是绿的，只有 A 会红 —— 而 A 验的正好是唯一没有测试、
// 只有一句注释的那半。只跑 B 就会以为整件事成立，而那句注释还会替误解背书。
