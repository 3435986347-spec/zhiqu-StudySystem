package com.zhiqu.service.ai;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 一轮的步骤收集器（第一百二十七轮）：review 查出来的几处 —— 没存的步数、截断留头尾、回滚的草稿、列表里不带细节 */
class TraceStepsTest {

    @Test
    @DisplayName("超过上限的步：同一步先 running 后收尾，只算一次没存（原来算两次）")
    void 没存的只算一次() {
        TraceSteps t = new TraceSteps();
        for (int i = 0; i < TraceSteps.MAX_STEPS + 5; i++) {
            t.put(TraceSteps.running("s" + i, "read", "读取", "f"));
            t.put(TraceSteps.step("s" + i, "read", "读取", "f", "3 行", true));
        }
        Map<String, Object> snap = t.snapshot();
        assertEquals(TraceSteps.MAX_STEPS, ((List<?>) snap.get("steps")).size());
        assertEquals(5, snap.get("dropped"));
    }

    @Test
    @DisplayName("命令输出太长：留头和尾（测试的汇总在结尾），中间说省了多少")
    @SuppressWarnings("unchecked")
    void 输出留头尾() {
        String out = "HEAD" + "x".repeat(30_000) + "SUMMARY: 3 failed";
        Map<String, Object> s = TraceSteps.sanitize(Map.of("id", "s1", "kind", "run", "detail", Map.of("output", out)));
        String kept = (String) ((Map<String, Object>) s.get("detail")).get("output");
        assertTrue(kept.startsWith("HEAD") && kept.endsWith("SUMMARY: 3 failed"), "结尾的汇总没了");
        assertTrue(kept.contains("中间省掉"), "截了没说");
        assertTrue(kept.length() < 17_000);
    }

    @Test
    @DisplayName("事务回滚：计划 / 记忆 / 知识库草稿那几步不再说「等你确认」；别的步不动")
    void 回滚的草稿() {
        TraceSteps t = new TraceSteps();
        t.put(TraceSteps.step("plan", "plan", "计划草稿", "", "2 个任务，等你确认", true));
        t.put(TraceSteps.step("tasks", "tasks", "读任务", "", "读了 3 条", true));
        t.voidDrafts("草稿没存下来");
        List<Map<String, Object>> steps = (List<Map<String, Object>>) t.snapshot().get("steps");
        assertEquals("error", steps.get(0).get("status"));
        assertFalse(String.valueOf(steps.get(0).get("summary")).contains("等你确认"));
        assertEquals("ok", steps.get(1).get("status"));
    }

    @Test
    @DisplayName("还停在 running 的收成「没做完」；接线：成功、失败两条路都收（review：宿主没交回那一步就退了，原来成功路径不收，页面一直转）")
    @SuppressWarnings("unchecked")
    void 收掉还在跑的() throws Exception {
        TraceSteps t = new TraceSteps();
        t.put(TraceSteps.running("s1", "run", "运行", "npm test"));
        t.settleRunning("没做完");
        Map<String, Object> s = ((List<Map<String, Object>>) t.snapshot().get("steps")).get(0);
        assertEquals("error", s.get("status"));
        assertEquals("没做完", s.get("summary"));
        String src = com.zhiqu.SourceText.stripComments(java.nio.file.Files.readString(java.nio.file.Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java")));
        int commit = src.indexOf("executor.execute(AgentPhase.COMMIT, ctx);");
        int completeRun = src.indexOf("aiWorkspaceService.completeRun(agentRun, state.liveAssistant);", commit);
        String between = src.substring(commit, completeRun);
        assertTrue(between.matches("(?s).*saveTraceSteps\\(state\\.liveAssistant, state\\.traceSteps, \"[^\"]+\"\\);.*"),
                "成功路径存步骤时没把还在跑的收掉（第三个参数是 null）：\n" + between);
        assertTrue(src.contains("state.traceSteps.voidDrafts(") && src.contains("saveTraceSteps(assistantMessage, state.traceSteps, \""), "失败路径没收 / 没作废草稿那几步");
    }

    @Test
    @DisplayName("生成途中阶段性写步骤（刷新 / 断线后轮询看得到）：只在 STREAMING 时写（终态不回退）、做完一步才写、有节流、COMMIT 里不写")
    void 生成途中写步骤() throws Exception {
        String mapper = java.nio.file.Files.readString(java.nio.file.Path.of("src/main/java/com/zhiqu/mapper/AiMessageMapper.java"));
        String flush = mapper.substring(mapper.indexOf("int flushStreamingSteps") - 400, mapper.indexOf("int flushStreamingSteps"));
        assertTrue(flush.contains("AND status = 'STREAMING'") && flush.contains("AND deleted = 0") && flush.contains("AND user_id = #{userId}"),
                "生成途中写步骤的那条 UPDATE 少了守卫（迟到的一次会把终态那份盖回半截）：\n" + flush);
        String src = com.zhiqu.SourceText.stripComments(java.nio.file.Files.readString(java.nio.file.Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java")));
        String emit = src.substring(src.indexOf("private void emitTraceStep("), src.indexOf("private void flushStreamingSteps("));
        assertTrue(emit.contains("flushStreamingSteps(ctx, s, step);"), "发一步时没顺手写库：刷新后要等整轮完才看得到步骤");
        String body = src.substring(src.indexOf("private void flushStreamingSteps("), src.indexOf("private Map<String, Object> saveTraceSteps("));
        assertTrue(body.contains("\"running\".equals(step.get(\"status\"))") && body.contains("ctx.phase() == AgentPhase.COMMIT")
                && body.contains("1_000_000_000L"), "生成途中写步骤没有节流 / running 也写 / COMMIT 里也写：\n" + body);
    }

    @Test
    @DisplayName("列表接口给的：一行一步、不带细节（标 hasDetail），整份留给点开时取；只有字数的思考不算有细节")
    @SuppressWarnings("unchecked")
    void 列表里不带细节() {
        Map<String, Object> stored = Map.of("steps", List.of(
                Map.of("id", "a", "kind", "run", "status", "ok", "detail", Map.of("output", "x".repeat(10_000))),
                Map.of("id", "b", "kind", "thinking", "status", "ok"),
                // 第一百二十七轮存的思考只有字数：点开是空的，不能标 hasDetail（页面会因此藏掉「思考摘要」）
                Map.of("id", "c", "kind", "thinking", "status", "ok", "detail", Map.of("chars", 900)),
                Map.of("id", "d", "kind", "thinking", "status", "ok", "detail", Map.of("chars", 9, "text", "先看看文件"))), "dropped", 2);
        Map<String, Object> list = TraceSteps.summaries(stored);
        List<Map<String, Object>> rows = (List<Map<String, Object>>) list.get("steps");
        assertFalse(rows.get(0).containsKey("detail"));
        assertEquals(true, rows.get(0).get("hasDetail"));
        assertFalse(rows.get(1).containsKey("hasDetail"));
        assertFalse(rows.get(2).containsKey("hasDetail"), "只有字数的思考标成了点得开");
        assertEquals(true, rows.get(3).get("hasDetail"), "有原文的思考要点得开");
        assertEquals(2, list.get("dropped"));
        assertTrue(((Map<String, Object>) ((List<?>) stored.get("steps")).get(0)).containsKey("detail"), "原来那份被改了");
    }
}
