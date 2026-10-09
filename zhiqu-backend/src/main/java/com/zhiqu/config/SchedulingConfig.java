package com.zhiqu.config;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * 定时任务（早八提醒、到期提醒、RAG 索引 worker）的总开关：{@code app.scheduling.enabled}，默认开。
 *
 * <p>测试里关掉（{@code src/test/resources/application.properties}）。第十四轮查出：27 个集成测试一直写着
 * {@code spring.task.scheduling.enabled=false} —— Spring Boot 没有这个属性，写了等于没写。于是每个测试上下文里
 * RAG worker 每秒领一次作业（和测试自己调 {@code worker.run()} 抢同一批）；测试类结束时它的 MySQL 容器先停了、
 * 上下文还缓存着，worker 卡在连不上的库上 30 秒 —— 每次全量测试结束都白等 30 秒，被 surefire 强杀。
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "app.scheduling.enabled", havingValue = "true", matchIfMissing = true)
public class SchedulingConfig {
}
