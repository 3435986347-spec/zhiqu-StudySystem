package com.zhiqu.service.agent;

import com.zhiqu.SourceText;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 从 {@code AiServiceImpl} <b>真实声明的</b> {@code runAt()} 解析出执行次序，喂给真的
 * {@link AgentStageExecutor#runOrder()}。
 *
 * <h2>为什么不在测试里手抄一份次序</h2>
 *
 * <p>手抄就是「同一事实两份拷贝」—— 这一整轮修的正是这个物种。抄来的那份一旦和
 * 真实位置分叉，判据会拿着自己那份自证清白：改一个 runner 的 {@code runAt} 之后，
 * 派生出的图变了，而判据期望的还是旧的，红得莫名其妙；或者更糟，两边一起错。
 *
 * <p>所以这里只解析<b>位置</b>（哪个 agent 在哪个相位的第几位、属于哪个并发组），
 * 排名规则本身仍然来自生产代码 —— 用解析出的位置造一批空壳 runner，交给真的
 * {@code AgentStageExecutor} 去算 {@code runOrder()}。规则错了，判据跟着错，
 * 这是对的：判据要钉的是「图的次序等于执行的次序」，不是「图的次序等于某串数字」。
 *
 * <h2>解析可能扫空</h2>
 *
 * <p>正则不匹配时得到的是空名单，而空名单形状上和「一切正常」一模一样 ——
 * 本仓库 2026-09-03 就栽过一次。所以 {@link #slots()} 断言了一个下界：
 * 少于 14 个 runner 就说明解析坏了，而不是代码少了。
 */
public final class RealRunOrder {
    private static final Path AI_SERVICE =
            Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java");

    /** 期望的 runner 数量下界 —— 防止正则失配后留下一个空名单，让后面每条断言都空过。 */
    private static final int MIN_RUNNERS = 14;

    private static final Pattern CLASS_HEAD =
            Pattern.compile("private final class (\\w+) implements AgentStageRunner \\{");
    private static final Pattern AGENT_TYPE =
            Pattern.compile("agentType\\(\\)\\s*\\{\\s*return\\s*\"([^\"]+)\";");
    private static final Pattern RUN_AT = Pattern.compile(
            "runAt\\(\\)\\s*\\{\\s*return AgentPosition\\.at\\(AgentPhase\\.(\\w+),\\s*(-?\\d+)\\);");
    private static final Pattern PARALLEL_GROUP =
            Pattern.compile("parallelGroup\\(\\)\\s*\\{\\s*return\\s*(\\w+);");
    private static final Pattern GROUP_CONST =
            Pattern.compile("private static final String (\\w+) = \"([^\"]+)\";");

    /** 一个 runner 声明的位置，直接从源码读出来。 */
    public record Declared(String agentType, AgentPhase phase, int order, String parallelGroup) {
    }

    public static List<Declared> declarations() {
        String code;
        try {
            code = SourceText.stripComments(Files.readString(AI_SERVICE, StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new IllegalStateException("读不到 AiServiceImpl 源码：" + AI_SERVICE.toAbsolutePath(), e);
        }
        Map<String, String> constants = new HashMap<>();
        Matcher constant = GROUP_CONST.matcher(code);
        while (constant.find()) {
            constants.put(constant.group(1), constant.group(2));
        }

        List<Integer> starts = new ArrayList<>();
        Matcher head = CLASS_HEAD.matcher(code);
        while (head.find()) {
            starts.add(head.start());
        }
        List<Declared> declared = new ArrayList<>();
        for (int i = 0; i < starts.size(); i++) {
            String chunk = code.substring(starts.get(i),
                    i + 1 < starts.size() ? starts.get(i + 1) : code.length());
            Matcher type = AGENT_TYPE.matcher(chunk);
            Matcher runAt = RUN_AT.matcher(chunk);
            if (!type.find() || !runAt.find()) {
                continue;
            }
            Matcher group = PARALLEL_GROUP.matcher(chunk);
            String groupName = null;
            if (group.find()) {
                String token = group.group(1);
                groupName = constants.getOrDefault(token, token);
            }
            declared.add(new Declared(type.group(1), AgentPhase.valueOf(runAt.group(1)),
                    Integer.parseInt(runAt.group(2)), groupName));
        }
        assertTrue(declared.size() >= MIN_RUNNERS,
                "只解析出 " + declared.size() + " 个 runner —— 空扫和干净的扫在形状上一模一样，"
                        + "这个下界就是用来区分它们的。多半是 AiServiceImpl 的写法变了，正则要跟着改");
        return declared;
    }

    /** 用真实位置喂真的执行器，让<b>排名规则来自生产代码</b>。 */
    public static List<AgentStageExecutor.RunSlot> slots() {
        List<AgentStageRunner> shells = new ArrayList<>();
        for (Declared item : declarations()) {
            shells.add(new AgentStageRunner() {
                @Override public String agentType() { return item.agentType(); }
                @Override public AgentPosition runAt() { return AgentPosition.at(item.phase(), item.order()); }
                @Override public String parallelGroup() { return item.parallelGroup(); }
                @Override public boolean inGraph(AgentRunContext ctx) { return true; }
                @Override public void run(AgentRunContext ctx) { }
            });
        }
        List<AgentStageExecutor.RunSlot> slots = new AgentStageExecutor(shells).runOrder();
        assertEquals(shells.size(), slots.size(),
                "每个 runner 都该在 runOrder() 里出现一次 —— 少了就说明有 runner 被漏掉，"
                        + "而漏掉的那个在建图时会被当成幽灵节点拒绝");
        return slots;
    }

    private RealRunOrder() {
    }
}
