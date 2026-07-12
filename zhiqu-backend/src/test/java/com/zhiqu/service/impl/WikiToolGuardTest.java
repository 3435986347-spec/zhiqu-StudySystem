package com.zhiqu.service.impl;

import org.junit.jupiter.api.Test;

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
        assertTrue(AiServiceImpl.refuseExistingPageOverwrite(new HashSet<>(), "英语学习偏好"));
    }

    /** 读过但被截断（未进入 fullyReadTitles）→ 视同未完整读取 → 拒绝。 */
    @Test
    void refusesOverwriteWhenReadButTruncated() {
        Set<String> fullyRead = new HashSet<>(); // 截断读不加入该集合
        assertTrue(AiServiceImpl.refuseExistingPageOverwrite(fullyRead, "长页"));
    }

    /** 本轮完整读取过该页 → 允许整页覆盖。 */
    @Test
    void allowsOverwriteWhenFullyReadThisTurn() {
        Set<String> fullyRead = new HashSet<>();
        fullyRead.add("英语学习偏好");
        assertFalse(AiServiceImpl.refuseExistingPageOverwrite(fullyRead, "英语学习偏好"));
    }

    /** 完整读取了另一页，不代表可覆盖当前页 → 拒绝。 */
    @Test
    void distinctTitleNotCoveredByAnotherFullRead() {
        Set<String> fullyRead = new HashSet<>();
        fullyRead.add("页面a");
        assertTrue(AiServiceImpl.refuseExistingPageOverwrite(fullyRead, "页面b"));
    }

    /** 空集合（防御性 null）→ 拒绝。 */
    @Test
    void refusesOverwriteForNullSet() {
        assertTrue(AiServiceImpl.refuseExistingPageOverwrite(null, "任意页"));
    }
}
