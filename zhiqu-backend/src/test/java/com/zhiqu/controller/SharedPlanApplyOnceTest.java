package com.zhiqu.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.NodeRunner;
import com.zhiqu.SourceText;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Result;
import com.zhiqu.service.SharedPlanEventService;
import com.zhiqu.service.SharedPlanService;
import com.zhiqu.service.concurrency.IdempotencyService;
import com.zhiqu.service.concurrency.RedisDistributedLockService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

import java.nio.file.Files;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 参考计划「套用」只执行一次：原来没有任何去重，连点两下（或者等得不耐烦又点一次）就是两整份任务进日历。
 */
class SharedPlanApplyOnceTest {

    private final SharedPlanService plans = mock(SharedPlanService.class);
    private final AtomicInteger applied = new AtomicInteger();
    private SharedPlanController controller;

    @SuppressWarnings("unchecked")
    private static StringRedisTemplate redisDown() {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        ValueOperations<String, String> ops = mock(ValueOperations.class);
        RedisConnectionFailureException down = new RedisConnectionFailureException("down");
        when(redis.opsForValue()).thenReturn(ops);
        when(ops.get(anyString())).thenThrow(down);
        when(ops.setIfAbsent(anyString(), anyString(), any(Duration.class))).thenThrow(down);
        org.mockito.Mockito.doThrow(down).when(ops).set(anyString(), anyString(), any(Duration.class));
        when(redis.execute(any(), anyList(), any())).thenThrow(down);
        return redis;
    }

    @BeforeEach
    void setUp() {
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(1L, null, List.of()));
        when(plans.apply(anyLong(), anyLong(), any())).thenAnswer(inv -> Map.of("createdTasks", 12, "run", applied.incrementAndGet()));
        controller = new SharedPlanController(plans, mock(SharedPlanEventService.class),
                new IdempotencyService(redisDown(), new RedisDistributedLockService(redisDown()), new ObjectMapper()));
    }

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    @Test
    @DisplayName("同一个键点两次：只套用一次，第二次拿到第一次的结果")
    void 连点只套用一次() {
        Result<Map<String, Object>> first = controller.apply(9L, Map.of("startDate", "2026-10-01"), "ui-abc:2026-10-01");
        Result<Map<String, Object>> again = controller.apply(9L, Map.of("startDate", "2026-10-01"), "ui-abc:2026-10-01");
        assertEquals(1, applied.get(), "连点两下建了两整份任务");
        assertEquals(1, ((Number) again.getData().get("run")).intValue(), "第二次拿到的不是第一次的结果");
        assertEquals(first.getData().get("createdTasks"), ((Number) again.getData().get("createdTasks")).intValue());
    }

    @Test
    @DisplayName("换个日期、别的计划、不带键：都是另一次")
    void 别的都是另一次() {
        controller.apply(9L, Map.of(), "ui-abc:2026-10-01");
        controller.apply(9L, Map.of(), "ui-abc:2026-11-01");
        assertEquals(2, applied.get(), "换了开始日期却没套用");
        controller.apply(10L, Map.of(), "ui-abc:2026-10-01");
        assertEquals(3, applied.get(), "同一个键串到了别的计划上");
        controller.apply(9L, Map.of(), null);
        controller.apply(9L, Map.of(), null);
        assertEquals(5, applied.get(), "不带键的请求（旧页面）应当照常执行");
    }

    @Test
    @DisplayName("第一次失败了：同一个键重试照常执行（失败不缓存）")
    void 失败可以重试() {
        // doThrow().when() 的写法：when(plans.apply(...)) 会先真调一次 setUp 里的桩，计数白白多一
        org.mockito.Mockito.doThrow(new BusinessException("该计划暂不可套用"))
                .doAnswer(inv -> Map.of("createdTasks", 12, "run", applied.incrementAndGet()))
                .when(plans).apply(anyLong(), anyLong(), any());
        assertThrows(BusinessException.class, () -> controller.apply(9L, Map.of(), "ui-k:2026-10-01"));
        controller.apply(9L, Map.of(), "ui-k:2026-10-01");
        assertEquals(1, applied.get());
    }

    @Test
    @DisplayName("页面：键在打开计划时生成（不在点击里），套用时带上键和日期；请求没回来之前按钮不响应")
    void 页面带键() throws Exception {
        String js = SourceText.stripComments(Files.readString(NodeRunner.API_JS));
        int keyAt = js.indexOf("var applyKey = writeKey();");
        int handlerAt = js.indexOf("applyBtn.onclick = async function () {");
        assertTrue(keyAt > 0 && handlerAt > keyAt, "键要在点击处理之外、打开计划时生成 —— 每次点击都新生成一个键就等于没去重");
        String handler = js.substring(handlerAt, js.indexOf("};", handlerAt));
        assertTrue(handler.contains("{ 'Idempotency-Key': applyKey + ':' + startDate.trim() }"), "套用请求没带键：\n" + handler);
        assertTrue(handler.contains("if (applyBtn.disabled) return;") && handler.contains("applyBtn.disabled = true;"),
                "请求在路上时按钮还能再点：\n" + handler);
    }
}
