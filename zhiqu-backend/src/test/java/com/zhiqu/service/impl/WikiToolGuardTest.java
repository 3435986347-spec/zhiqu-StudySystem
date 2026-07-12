package com.zhiqu.service.impl;

import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 覆盖写安全判定（Wiki 工具智能体“长页防丢”根治逻辑）的单元测试。
 * 该判定是纯函数，不依赖 Spring 上下文或数据库，可稳定复现。
 */
class WikiToolGuardTest {

    /** 本轮该页被截断读取 → 拒绝整页覆盖，避免据不全内容覆盖丢尾。 */
    @Test
    void refusesOverwriteWhenTargetReadIncompletely() {
        Set<String> incomplete = new HashSet<>();
        incomplete.add("英语学习偏好");
        assertTrue(AiServiceImpl.refuseFullOverwrite(incomplete, "英语学习偏好", 100));
    }

    /** 现有正文超过可完整读取上限 → 即便本轮未标记，也禁止整页覆盖（模型可能跳过 read）。 */
    @Test
    void refusesOverwriteWhenExistingPageExceedsFullReadLimit() {
        assertTrue(AiServiceImpl.refuseFullOverwrite(new HashSet<>(), "长页", AiServiceImpl.WIKI_READ_FULL_LIMIT + 1));
    }

    /** 正常大小且完整读取的页面 → 允许生成覆盖草稿。 */
    @Test
    void allowsOverwriteForNormalFullyReadPage() {
        assertFalse(AiServiceImpl.refuseFullOverwrite(new HashSet<>(), "普通页", 5000));
    }

    /** 恰好等于上限（未截断）→ 允许覆盖，边界不误伤。 */
    @Test
    void allowsOverwriteAtExactlyLimit() {
        assertFalse(AiServiceImpl.refuseFullOverwrite(new HashSet<>(), "边界页", AiServiceImpl.WIKI_READ_FULL_LIMIT));
    }

    /** incompleteTitles 为空且现有正文为空（新建/小页）→ 允许。 */
    @Test
    void allowsOverwriteForNullSetAndEmptyExisting() {
        assertFalse(AiServiceImpl.refuseFullOverwrite(null, "新页", 0));
    }
}
