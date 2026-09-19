package com.zhiqu.service.concurrency;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Result;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 幂等服务：同一次提交被重复投递时只执行一次，且不同端点的同名键不得串味。
 *
 * <h2>这个机制此前在实践中是死的</h2>
 *
 * <p>后端把 {@code Idempotency-Key} 接到了四个端点上，但前端<b>全站只有一处</b>发这个头
 * （{@code zhiqu-api.js:502}），而且那一处写的是 {@code 'ui-' + Date.now()} ——
 * <b>每次调用现生成</b>。于是它只在「同一毫秒内的两次调用」才会命中（那不会发生），
 * 正常间隔的重复投递反而各拿一个新键。<b>幂等在唯一该生效的场合失效。</b>
 * 另外三个端点前端根本不调，是纯 API 端点。
 *
 * <h2>不用 Spring 上下文</h2>
 *
 * <p>这个服务只依赖 Redis，直接构造即可。现有集成测试<b>一次都没碰过 Redis</b> ——
 * {@code ConversationLockRegistry} 用的是进程内 ReentrantLock 条带，不是分布式锁，
 * 所以 StringRedisTemplate 虽然建了但从没被用过。本类是第一个真需要 Redis 的判据。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
class IdempotencyServiceIntegrationTest {
    static {
        // docker-java 默认用的 API 版本低于守护进程的 MinAPIVersion（实测 1.40），
        // 不钉住就会在 /info 上拿到 400 + 一个全空的 info 存根，
        // Testcontainers 把它报成「Could not find a valid Docker environment」——
        // 读起来像 Docker 没装，实际是版本协商。本仓库每个容器测试类都抄了这一行。
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
    }

    @Container
    static final GenericContainer<?> REDIS =
            new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);

    private static IdempotencyService service;

    @BeforeAll
    static void wire() {
        RedisStandaloneConfiguration config =
                new RedisStandaloneConfiguration(REDIS.getHost(), REDIS.getMappedPort(6379));
        LettuceConnectionFactory factory = new LettuceConnectionFactory(config);
        factory.afterPropertiesSet();
        StringRedisTemplate redisTemplate = new StringRedisTemplate(factory);
        service = new IdempotencyService(
                redisTemplate, new RedisDistributedLockService(redisTemplate), new ObjectMapper());
    }

    private static String freshKey() {
        return "k-" + UUID.randomUUID();
    }

    @Test
    void 同一个键重放时不得重复执行() {
        AtomicInteger runs = new AtomicInteger();
        String key = freshKey();

        Result<String> first = service.execute(1L, "task.create", key,
                () -> Result.success("run-" + runs.incrementAndGet()));
        Result<String> second = service.execute(1L, "task.create", key,
                () -> Result.success("run-" + runs.incrementAndGet()));

        assertEquals(1, runs.get(),
                "同一次提交被重复投递时业务只能执行一次 —— 这是幂等的本体");
        assertEquals(first.getData(), second.getData(), "第二次必须拿回第一次的结果，而不是一个新结果");
    }

    @Test
    void 不同端点的同名键不得串味() {
        AtomicInteger runs = new AtomicInteger();
        String key = freshKey();

        Result<String> task = service.execute(1L, "task.create", key,
                () -> Result.success("task-" + runs.incrementAndGet()));
        Result<String> plan = service.execute(1L, "ai.batchCreatePlan", key,
                () -> Result.success("plan-" + runs.incrementAndGet()));

        assertEquals(2, runs.get(),
                "两个端点是两件事，各自都该执行 —— 键里没有端点维度时第二个会被跳过");
        assertTrue(task.getData().startsWith("task-") && plan.getData().startsWith("plan-"),
                "而且第二个拿到的必须是自己的结果，不是第一个的缓存。实际：" + task.getData() + " / " + plan.getData());
    }

    @Test
    void 不同用户的同名键不得串味() {
        AtomicInteger runs = new AtomicInteger();
        String key = freshKey();

        service.execute(1L, "task.create", key, () -> Result.success("u1-" + runs.incrementAndGet()));
        Result<String> other = service.execute(2L, "task.create", key,
                () -> Result.success("u2-" + runs.incrementAndGet()));

        assertEquals(2, runs.get(), "幂等键按用户隔离 —— 否则一个用户能用键名影响另一个用户的请求");
        assertTrue(other.getData().startsWith("u2-"), "实际：" + other.getData());
    }

    @Test
    void 失败结果不得被缓存() {
        AtomicInteger runs = new AtomicInteger();
        String key = freshKey();

        service.execute(1L, "task.create", key, () -> {
            runs.incrementAndGet();
            Result<String> failed = new Result<>();
            failed.setCode(500);
            failed.setMessage("这次失败了");
            return failed;
        });
        Result<String> retry = service.execute(1L, "task.create", key,
                () -> Result.success("run-" + runs.incrementAndGet()));

        assertEquals(2, runs.get(), "失败必须可重试 —— 缓存了失败结果的话用户永远卡在那个错误上");
        assertEquals(200, retry.getCode(), "重试应当真的执行并成功");
    }

    @Test
    void 同键并发时第二个请求被拒而不是并行执行() throws Exception {
        String key = freshKey();
        CountDownLatch inside = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger runs = new AtomicInteger();

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<Result<String>> slow = pool.submit(() -> service.execute(1L, "task.create", key, () -> {
                runs.incrementAndGet();
                inside.countDown();
                try {
                    release.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return Result.success("slow");
            }));

            assertTrue(inside.await(10, TimeUnit.SECONDS), "下界：第一个请求必须真的进入了业务体");
            // 第一个还在执行中，第二个同键请求进来
            assertThrows(BusinessException.class,
                    () -> service.execute(1L, "task.create", key,
                            () -> Result.success("second-" + runs.incrementAndGet())),
                    "同键并发时第二个必须被拒，而不是并行执行一遍 —— "
                            + "并行执行就等于重复提交，幂等等于没有");
            release.countDown();
            slow.get(15, TimeUnit.SECONDS);
        } finally {
            pool.shutdownNow();
        }
        assertEquals(1, runs.get(), "业务体只该被执行一次");
    }

    @Test
    void 超长键被拒而不是静默截断() {
        String tooLong = "x".repeat(121);
        assertThrows(BusinessException.class,
                () -> service.execute(1L, "task.create", tooLong, () -> Result.success("ok")),
                "超长键必须报错 —— 静默截断会让两个不同的键塌成同一个，反而制造出假的重复命中");
    }

    @Test
    void 没有端点标识时必须报错() {
        assertThrows(IllegalArgumentException.class,
                () -> service.execute(1L, "  ", freshKey(), () -> Result.success("ok")),
                "scope 是防串味的唯一依据，空值必须当场报错而不是拼出一个缺维度的键");
    }

    @Test
    void 没有幂等键时直接执行() {
        AtomicInteger runs = new AtomicInteger();
        service.execute(1L, "task.create", null, () -> Result.success("run-" + runs.incrementAndGet()));
        service.execute(1L, "task.create", null, () -> Result.success("run-" + runs.incrementAndGet()));
        assertEquals(2, runs.get(),
                "不带键就是不要求幂等 —— 上面几条的反例：没有它，「一律去重」也能让它们绿");
    }
}
