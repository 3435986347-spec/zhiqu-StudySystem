package com.zhiqu.service.impl;

import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 覆盖写安全判定（Wiki 工具智能体“长页防丢”根治逻辑）的单元测试。
 * 不变量：对已存在的页，只有本轮【完整读取过】才允许整页覆盖。
 * 该判定是纯函数，不依赖 Spring 上下文或数据库，可稳定复现。
 */
class WikiToolGuardTest {

    /** 关键场景：模型跳过 read_wiki_page，直接覆盖一个已有页 → fullyReadTitles 为空 → 拒绝。 */
    @Test
    void refusesOverwriteWhenExistingPageNeverRead() {
        assertTrue(refuseExistingPageOverwrite(new HashSet<>(), "英语学习偏好"));
    }

    /** 读过但被截断（未进入 fullyReadTitles）→ 视同未完整读取 → 拒绝。 */
    @Test
    void refusesOverwriteWhenReadButTruncated() {
        Set<String> fullyRead = new HashSet<>(); // 截断读不加入该集合
        assertTrue(refuseExistingPageOverwrite(fullyRead, "长页"));
    }

    /** 本轮完整读取过该页 → 允许整页覆盖。 */
    @Test
    void allowsOverwriteWhenFullyReadThisTurn() {
        Set<String> fullyRead = new HashSet<>();
        fullyRead.add("英语学习偏好");
        assertFalse(refuseExistingPageOverwrite(fullyRead, "英语学习偏好"));
    }

    /** 完整读取了另一页，不代表可覆盖当前页 → 拒绝。 */
    @Test
    void distinctTitleNotCoveredByAnotherFullRead() {
        Set<String> fullyRead = new HashSet<>();
        fullyRead.add("页面a");
        assertTrue(refuseExistingPageOverwrite(fullyRead, "页面b"));
    }

    /** 空集合（防御性 null）→ 拒绝。 */
    @Test
    void refusesOverwriteForNullSet() {
        assertTrue(refuseExistingPageOverwrite(null, "任意页"));
    }

    // ===== 写/工具意图分类 =====

    /** “更新知识页”既是工具意图也是写意图（此前只触发工具循环却拿不到写工具的缺口）。 */
    @Test
    void updateKnowledgePageIsWriteIntent() {
        assertTrue(looksWikiToolIntent("更新知识页里的算法笔记"));
        assertTrue(looksWikiWriteIntent("更新知识页里的算法笔记"));
    }

    /** 不变量：写意图 ⟹ 工具意图（否则会启动 Agent 却不下发写工具）。 */
    @Test
    void writeIntentImpliesToolIntent() {
        String[] writes = {"把这段写进笔记", "写入知识页", "更新知识wiki", "保存到知识库", "记录到笔记", "补充到知识树", "新建一个知识页"};
        for (String m : writes) {
            assertTrue(looksWikiWriteIntent(m), "应判为写意图: " + m);
            assertTrue(looksWikiToolIntent(m), "写意图必然是工具意图: " + m);
        }
    }

    /** 纯查询是工具意图但不是写意图（最小权限：不下发写工具）。 */
    @Test
    void pureQueryIsToolButNotWrite() {
        assertTrue(looksWikiToolIntent("查一下我知识wiki里的英语偏好"));
        assertFalse(looksWikiWriteIntent("查一下我知识wiki里的英语偏好"));
    }

    /** 与 Wiki 无关的消息两者都不触发。 */
    @Test
    void nonWikiMessageTriggersNeither() {
        assertFalse(looksWikiToolIntent("今天天气怎么样"));
        assertFalse(looksWikiWriteIntent("帮我写一首诗"));
    }

    private static boolean refuseExistingPageOverwrite(Set<String> titles, String targetTitle) {
        return invokeBoolean("refuseExistingPageOverwrite", new Class<?>[]{Set.class, String.class}, titles, targetTitle);
    }

    private static boolean looksWikiToolIntent(String message) {
        return invokeBoolean("looksWikiToolIntent", new Class<?>[]{String.class}, message);
    }

    private static boolean looksWikiWriteIntent(String message) {
        return invokeBoolean("looksWikiWriteIntent", new Class<?>[]{String.class}, message);
    }

    private static boolean invokeBoolean(String name, Class<?>[] parameterTypes, Object... args) {
        try {
            Class<?> type = Class.forName("com.zhiqu.service.impl.AiServiceImpl");
            Method method = type.getDeclaredMethod(name, parameterTypes);
            method.setAccessible(true);
            return (Boolean) method.invoke(null, args);
        } catch (ReflectiveOperationException ex) {
            throw new AssertionError("无法调用生产判定方法: " + name, ex);
        }
    }
}
