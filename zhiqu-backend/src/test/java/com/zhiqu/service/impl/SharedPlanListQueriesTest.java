package com.zhiqu.service.impl;

import com.zhiqu.common.BusinessClock;
import com.zhiqu.entity.SharedPlanCategory;
import com.zhiqu.entity.SharedPlanLike;
import com.zhiqu.entity.SharedPlanTemplate;
import com.zhiqu.mapper.SharedPlanCategoryMapper;
import com.zhiqu.mapper.SharedPlanLikeMapper;
import com.zhiqu.mapper.SharedPlanReviewMapper;
import com.zhiqu.mapper.SharedPlanRoutineTemplateMapper;
import com.zhiqu.mapper.SharedPlanTaskTemplateMapper;
import com.zhiqu.mapper.SharedPlanTemplateMapper;
import com.zhiqu.mapper.StudyRoutineMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.service.RoutineService;
import com.zhiqu.service.SharedPlanEventService;
import com.zhiqu.service.StudyTaskService;
import com.zhiqu.service.privacy.PrivacySanitizer;
import com.zhiqu.util.UploadPathResolver;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 参考计划：列表不再一行查两次；两个计数只改自己那一列，不把读到的整个模板写回去。
 */
class SharedPlanListQueriesTest {

    private final SharedPlanTemplateMapper templates = mock(SharedPlanTemplateMapper.class);
    private final SharedPlanLikeMapper likes = mock(SharedPlanLikeMapper.class);
    private final SharedPlanCategoryMapper categories = mock(SharedPlanCategoryMapper.class);
    private final SharedPlanTaskTemplateMapper taskTemplates = mock(SharedPlanTaskTemplateMapper.class);
    private final SharedPlanRoutineTemplateMapper routineTemplates = mock(SharedPlanRoutineTemplateMapper.class);
    private final SharedPlanServiceImpl service = new SharedPlanServiceImpl(templates, taskTemplates, routineTemplates, likes,
            categories, mock(SharedPlanReviewMapper.class), mock(StudyRoutineMapper.class), mock(SysUserMapper.class),
            mock(StudyTaskService.class), mock(RoutineService.class), mock(SharedPlanEventService.class),
            mock(PrivacySanitizer.class), mock(UploadPathResolver.class), new BusinessClock("Asia/Shanghai"));

    private static SharedPlanTemplate template(long id, String category) {
        SharedPlanTemplate t = new SharedPlanTemplate();
        t.setId(id);
        t.setTitle("计划" + id);
        t.setCategory(category);
        t.setStatus("APPROVED");
        t.setLikeCount(0);
        t.setApplyCount(0);
        return t;
    }

    private static SharedPlanCategory category(String key, String name) {
        SharedPlanCategory c = new SharedPlanCategory();
        c.setCategoryKey(key);
        c.setName(name);
        return c;
    }

    private static SharedPlanLike like(long templateId) {
        SharedPlanLike l = new SharedPlanLike();
        l.setTemplateId(templateId);
        l.setUserId(1L);
        return l;
    }

    @Test
    @DisplayName("公开列表：五十个计划，分类名一次取全、点赞一次查完；每一行的分类名与「我点过没有」都对")
    void 列表不再一行两查() {
        List<SharedPlanTemplate> many = new ArrayList<>();
        for (long i = 1; i <= 50; i++) {
            many.add(template(i, i == 5 ? null : i == 6 ? "UNKNOWN_KEY" : (i % 2 == 0 ? "EXAM" : "CODE")));
        }
        when(templates.selectList(any())).thenReturn(many);
        when(categories.selectList(any())).thenReturn(List.of(category("EXAM", "考试冲刺"), category("CODE", "编程入门")));
        when(likes.selectList(any())).thenReturn(List.of(like(3), like(8)));

        List<Map<String, Object>> rows = service.publicList(1L, null, null, null);

        verify(categories, times(1)).selectList(any());
        verify(categories, never()).selectOne(any());
        verify(likes, times(1)).selectList(any());
        verify(likes, never()).selectCount(any());
        assertEquals(50, rows.size());
        for (Map<String, Object> row : rows) {
            long id = ((Number) row.get("id")).longValue();
            assertEquals(id == 3 || id == 8, row.get("liked"), "计划 " + id + " 的点赞状态不对");
            String expected = id == 5 ? "通用规划" : id == 6 ? "UNKNOWN_KEY" : (id % 2 == 0 ? "考试冲刺" : "编程入门");
            assertEquals(expected, row.get("categoryName"), "计划 " + id + " 的分类名不对");
        }
    }

    @Test
    @DisplayName("没登录看列表：不查点赞；列表是空的：什么都不查")
    void 不该查的不查() {
        when(templates.selectList(any())).thenReturn(List.of(template(1, "EXAM")));
        when(categories.selectList(any())).thenReturn(List.of(category("EXAM", "考试冲刺")));
        assertEquals(false, service.publicList(null, null, null, null).get(0).get("liked"));
        verifyNoInteractions(likes);

        SharedPlanCategoryMapper untouched = categories;
        when(templates.selectList(any())).thenReturn(List.of());
        assertTrue(service.publicList(1L, null, null, null).isEmpty());
        verify(untouched, times(1)).selectList(any());   // 只有上面那一次
    }

    @Test
    @DisplayName("点赞：点赞数只改那一列（按点赞表重数），不把读到的整个模板写回去")
    void 点赞只改计数列() {
        // 第十三轮起点赞先用加锁读（selectOne … FOR UPDATE）拿这个计划 —— 并发时按计划排队，见 ConcurrencyStormIntegrationTest
        when(templates.selectOne(any())).thenReturn(template(7, "EXAM"));
        service.toggleLike(1L, 7L);
        verify(templates).refreshLikeCount(7L);
        verify(templates, never()).updateById(any(SharedPlanTemplate.class));
    }

    @Test
    @DisplayName("套用：套用次数在库里原地 +1，不把读到的整个模板写回去")
    void 套用只加计数() {
        when(templates.selectById(anyLong())).thenReturn(template(9, "EXAM"));
        when(taskTemplates.selectList(any())).thenReturn(List.of());
        when(routineTemplates.selectList(any())).thenReturn(List.of());
        service.apply(1L, 9L, Map.of());
        verify(templates).incrementApplyCount(9L);
        verify(templates, never()).updateById(any(SharedPlanTemplate.class));
    }
}
