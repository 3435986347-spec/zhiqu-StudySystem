package com.zhiqu.service.agent;

import com.zhiqu.entity.AiAgentTask;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 图驱动执行器的四条判据 —— <b>各买不同的东西，不是互相冗余</b>。
 *
 * <table border="1">
 *   <caption>各自买到什么</caption>
 *   <tr><th>判据</th><th>买到什么</th><th>扰动见红</th></tr>
 *   <tr><td>{@link #次序来自声明的位置_不是注册顺序()}</td>
 *       <td>本次改造的<b>整个论点</b>：次序的来源从「语句书写顺序」换成「声明的位置」</td>
 *       <td>让 execute 按注册顺序执行（不排序），或让排序只比 order 不比 phase</td></tr>
 *   <tr><td>{@link #COMMIT相位的事件必须进缓冲不得直发()}</td>
 *       <td>防事务回滚后前端收到指向不存在数据的事件</td>
 *       <td>把 {@code AgentRunContext.emit} 改成一律直发</td></tr>
 *   <tr><td>{@link #宣告必须直发不得跟着落库相位被推迟()}</td>
 *       <td>防路由改按 runner 声明的相位走 —— 那样 PLANNER 的宣告会被推迟到事务提交后，
 *           恰好抵消 {@code announceAt()} 存在的理由</td>
 *       <td>把 execute 里的 {@code ctx.enterPhase(phase)} 改成
 *           {@code ctx.enterPhase(runner.commitAt().phase())}</td></tr>
 *   <tr><td>{@link #图里没有的节点只发跳过公告不跑工作与落库()}</td>
 *       <td>把「幽灵 agent / 隐形 agent」做成写不出来的：跑不跑由图决定，不由 runner 自己决定</td>
 *       <td>让 executor 在 inGraph 为假时照样调 run</td></tr>
 * </table>
 *
 * <p>第 2、3 条是<b>一对，方向相反</b>：一条防 COMMIT 的事件提前发，一条防宣告被推迟发。
 * 单独任何一条都挡不住另一头 —— 「一律直发」满足第 3 条，「一律缓冲」满足第 2 条。
 */
class AgentStageExecutorRoutingTest {

    /** 每到一处就记一条事件的桩；三个位置可独立指定，用来摆出真实 runner 的各种形态。 */
    private static final class Probe implements AgentStageRunner {
        private final String type;
        private final AgentPosition announceAt;
        private final AgentPosition runAt;
        private final AgentPosition commitAt;

        private Probe(String type, AgentPosition announceAt, AgentPosition runAt, AgentPosition commitAt) {
            this.type = type;
            this.announceAt = announceAt;
            this.runAt = runAt;
            this.commitAt = commitAt;
        }

        static Probe at(String type, AgentPosition everywhere) {
            return new Probe(type, everywhere, everywhere, everywhere);
        }

        @Override public String agentType() { return type; }
        @Override public AgentPosition announceAt() { return announceAt; }
        @Override public AgentPosition runAt() { return runAt; }
        @Override public AgentPosition commitAt() { return commitAt; }

        @Override public void announce(AgentRunContext ctx) { ctx.emit(type + ".announce", type); }
        @Override public void announceSkipped(AgentRunContext ctx) { ctx.emit(type + ".skipped", type); }
        @Override public void run(AgentRunContext ctx) { ctx.emit(type + ".run", type); }
        @Override public void commit(AgentRunContext ctx) { ctx.emit(type + ".commit", type); }
    }

    private static AiAgentTask node(String agentType) {
        AiAgentTask task = new AiAgentTask();
        task.setAgentType(agentType);
        return task;
    }

    /** 收集直发出去的事件名。 */
    private static final class DirectChannel {
        private final List<String> names = new ArrayList<>();

        void accept(String name, Object payload) {
            names.add(name);
        }
    }

    @Test
    void 次序来自声明的位置_不是注册顺序() {
        DirectChannel direct = new DirectChannel();
        AgentRunContext ctx = new AgentRunContext(
                List.of(node("A"), node("B"), node("C")), direct::accept);
        // 故意按 C、A、B 注册：位置声明的是 A(0) → B(10) → C(20)
        AgentStageExecutor executor = new AgentStageExecutor(List.of(
                Probe.at("C", AgentPosition.at(AgentPhase.PRE_STREAM, 20)),
                Probe.at("A", AgentPosition.at(AgentPhase.PRE_STREAM, 0)),
                Probe.at("B", AgentPosition.at(AgentPhase.PRE_STREAM, 10))));

        executor.execute(AgentPhase.PRE_STREAM, ctx);

        assertEquals(List.of(
                "A.announce", "A.run", "A.commit",
                "B.announce", "B.run", "B.commit",
                "C.announce", "C.run", "C.commit"), direct.names,
                "执行次序必须来自声明的位置。若它跟着注册顺序走，"
                        + "「加一个 agent 只改图」就仍然是假的 —— 次序还是藏在调用点的书写顺序里");
    }

    @Test
    void COMMIT相位的事件必须进缓冲不得直发() {
        DirectChannel direct = new DirectChannel();
        AgentRunContext ctx = new AgentRunContext(List.of(node("DRAFTER")), direct::accept);
        AgentStageExecutor executor = new AgentStageExecutor(List.of(
                Probe.at("DRAFTER", AgentPosition.at(AgentPhase.COMMIT, 10))));

        executor.execute(AgentPhase.COMMIT, ctx);

        assertTrue(direct.names.isEmpty(),
                "COMMIT 相位的事件不得直发，实际直发了：" + direct.names
                        + "。事务回滚时这些事件已经出去了，前端会收到指向不存在数据的事件");
        assertEquals(List.of("DRAFTER.announce", "DRAFTER.run", "DRAFTER.commit"),
                ctx.deferredEvents().stream().map(AgentSseEvent::name).toList(),
                "COMMIT 相位的事件必须原样按序留在缓冲里，等事务提交后补发");
    }

    @Test
    void 宣告必须直发不得跟着落库相位被推迟() {
        DirectChannel direct = new DirectChannel();
        AgentRunContext ctx = new AgentRunContext(List.of(node("PLANNER")), direct::accept);
        // PLANNER 的真实形态：宣告在流式之前，工作与落库都在事务里
        AgentStageExecutor executor = new AgentStageExecutor(List.of(new Probe("PLANNER",
                AgentPosition.at(AgentPhase.PRE_STREAM, 30),
                AgentPosition.at(AgentPhase.COMMIT, 20),
                AgentPosition.at(AgentPhase.COMMIT, 20))));

        executor.execute(AgentPhase.PRE_STREAM, ctx);

        assertEquals(List.of("PLANNER.announce"), direct.names,
                "宣告必须在流式之前直发出去：用户要在整个流式期间看到「正在准备计划草稿」");
        assertFalse(ctx.deferredEvents().stream().anyMatch(event -> event.name().equals("PLANNER.announce")),
                "宣告被塞进了缓冲，等事务提交后才发 —— 那正好抵消了 announceAt() 存在的理由。"
                        + "路由必须按「遍历正处的相位」，不按 runner 声明的相位");
    }

    @Test
    void 图里没有的节点只发跳过公告不跑工作与落库() {
        DirectChannel direct = new DirectChannel();
        // 图里只有 A，没有 GHOST
        AgentRunContext ctx = new AgentRunContext(List.of(node("A")), direct::accept);
        AgentStageExecutor executor = new AgentStageExecutor(List.of(
                Probe.at("A", AgentPosition.at(AgentPhase.PRE_STREAM, 0)),
                Probe.at("GHOST", AgentPosition.at(AgentPhase.PRE_STREAM, 10))));

        executor.execute(AgentPhase.PRE_STREAM, ctx);

        assertEquals(List.of("A.announce", "A.run", "A.commit", "GHOST.skipped"), direct.names,
                "节点不在图里时只该发跳过公告。跑了工作就是「隐形 agent」（干了活图里没记录）；"
                        + "而跳过公告本身不能省，用户要看到「本轮不需要…」");
    }
}
