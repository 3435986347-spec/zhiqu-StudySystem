package com.zhiqu.service.concurrency;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Result;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * 幂等这一层不改写业务抛出来的异常（第十四轮）。原来 {@code catch (Exception)} 一律包成
 * {@code BusinessException(e.getMessage())}：带 Idempotency-Key 的接口上，日期写错回 Java 原文，
 * 真的服务器 bug 把 SQL / 类名原样回给用户、一条运行问题都不记（GlobalExceptionHandler 只看到一个「业务错误」）。
 */
class IdempotencyPassThroughTest {

    private final IdempotencyService idem = new IdempotencyService(RedisOutageFallbackTest.redisDown(),
            new RedisDistributedLockService(RedisOutageFallbackTest.redisDown()), new ObjectMapper());

    private static String key() {
        return "k-" + UUID.randomUUID();
    }

    @Test
    @DisplayName("日期写错：原样抛 DateTimeParseException（交给异常处理回 400、说清应当像什么），不包成带 Java 原文的业务错误")
    void 日期错原样抛() {
        assertThrows(DateTimeParseException.class,
                () -> idem.execute(1L, "sharedPlan.apply:1", key(), () -> Result.success(LocalDate.parse("2026-02-30"))));
    }

    @Test
    @DisplayName("真的意外：同一个异常原样抛（交给异常处理记运行问题、只回编号），原文不变成给用户看的业务消息")
    void 意外原样抛() {
        RuntimeException boom = new IllegalStateException("### Error querying database. Cause: Table 'study_task' doesn't exist");
        RuntimeException thrown = assertThrows(RuntimeException.class,
                () -> idem.execute(1L, "task.create", key(), () -> { throw boom; }));
        assertSame(boom, thrown);
    }

    @Test
    @DisplayName("业务错误照旧是业务错误")
    void 业务错误照旧() {
        BusinessException e = assertThrows(BusinessException.class,
                () -> idem.execute(1L, "task.create", key(), () -> { throw new BusinessException("标题不能为空"); }));
        assertEquals("标题不能为空", e.getMessage());
    }

    @Test
    @DisplayName("结果存不进缓存：照样把结果交回去 —— 业务已经做完了，这时报错客户端就会再发一次")
    void 存不进缓存照样返回() {
        Object unserializable = new Object();   // 没有属性的对象，Jackson 默认拒绝序列化
        Result<Object> r = idem.execute(1L, "task.create", key(), () -> Result.success(unserializable));
        assertEquals(200, r.getCode());
        assertSame(unserializable, r.getData());
    }
}
