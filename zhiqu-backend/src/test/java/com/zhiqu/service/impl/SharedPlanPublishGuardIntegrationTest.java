package com.zhiqu.service.impl;

import com.zhiqu.service.SharedPlanService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 共享计划是这个系统里<b>唯一把一个用户的内容发布给别人看</b>的功能，而它此前零测试覆盖。
 *
 * <h2>两个缺陷同源：结构化字段从请求体原样落库</h2>
 *
 * <p>{@code title} / {@code description} 走 {@code clean()}，它会脱敏并抹掉手机号邮箱 ——
 * 意图很清楚：共享内容里不能有 PII。但 {@code taskType} / {@code frequency} /
 * {@code preferredTime} 走的是 {@code value()}，<b>只 trim 和兜底，不脱敏、不校验、不限长</b>，
 * 而它们同样进对外响应。于是：
 *
 * <ol>
 *   <li><b>泄漏</b>：把密钥或别人的手机号塞进 {@code taskType}，发布出去原样可见 ——
 *       旁边的 title/description 被仔细脱敏，这几个字段把那个意图绕过去了。</li>
 *   <li><b>存储型拒绝服务</b>：{@code preferredTime} 畸形时，<b>别人</b>应用这个计划会炸 ——
 *       {@code LocalTime.parse} 抛 DateTimeParseException（不是 BusinessException，兜不住），
 *       而 routine 那条走 {@code substring(0, 5)}，字符串短于 5 字符直接越界。
 *       发布者存一次，每个想用的人都 500。</li>
 * </ol>
 *
 * <p>结构化字段的正确修法是<b>校验</b>而不是脱敏：不合法就归一到默认值，而不是把垃圾打码后留着。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class SharedPlanPublishGuardIntegrationTest {
    static {
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
    }

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_shared_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private SharedPlanService sharedPlanService;
    @Autowired private JdbcTemplate jdbcTemplate;

    private Long authorId;
    private Long readerId;

    @BeforeEach
    void seedUsers() {
        authorId = seedUser("author");
        readerId = seedUser("reader");
    }

    private Long seedUser(String prefix) {
        String username = prefix + "_" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        jdbcTemplate.update(
                "INSERT INTO sys_user(username, password, nickname, role, deleted) VALUES (?, ?, ?, 'USER', 0)",
                username, "test-password", prefix);
        return jdbcTemplate.queryForObject("SELECT id FROM sys_user WHERE username = ?", Long.class, username);
    }

    /** 发布一个计划并直接置为已通过审核 —— 审核流程不是本判据的对象。 */
    private Long publish(Map<String, Object> taskItem, Map<String, Object> routineItem) {
        Map<String, Object> result = sharedPlanService.submit(authorId, Map.of(
                // 发布前必须勾「已去除个人隐私信息」。注意这是一个<b>自述</b>：
                // 系统并不因此就信任正文 —— title/description 照样走 clean() 脱敏。
                // 本判据要问的正是：为什么结构化字段没有得到同样的对待。
                "shareConsent", true,
                "title", "共享计划判据",
                "description", "说明",
                "category", "study",
                "targetAudience", "所有人",
                "tasks", List.of(taskItem),
                "routines", routineItem == null ? List.of() : List.of(routineItem)));
        Long id = ((Number) result.get("id")).longValue();
        jdbcTemplate.update("UPDATE shared_plan_template SET status = 'APPROVED' WHERE id = ?", id);
        return id;
    }

    private Map<String, Object> task(String taskType, String preferredTime) {
        return Map.of(
                "title", "任务",
                "description", "描述",
                "relativeStartDay", 0,
                "relativeDeadlineDay", 1,
                "preferredTime", preferredTime,
                "taskType", taskType);
    }

    /**
     * <b>读侧兜底不能替代写侧归一</b>，两者买的不是同一样东西。
     *
     * <p>读侧只保证「不崩」。写侧保证「发布出去的值本身是干净的」——
     * 不归一的话，每个读者在计划详情里看到的推荐时间就是「不是时间」四个字，
     * taskType 里就是那串密钥。所以这条断言的是<b>对外响应的内容</b>，不是「没抛异常」。
     *
     * <p>把写侧归一去掉而读侧保留，其它几条判据全绿 —— 那个绿是读侧给的，不是写侧。
     */
    @Test
    void 结构化字段不得把任意文本发布出去() {
        String secret = "sk-live-ABCDEFGH12345678";
        Long id = publish(task(secret + " 13800138000", "不是时间"), null);

        Map<String, Object> detail = sharedPlanService.detail(readerId, id);
        assertNotNull(detail, "下界：别的用户必须真的能读到这个计划，否则下面查的是空响应");
        String published = String.valueOf(detail);

        assertAll(
                () -> assertFalse(published.contains(secret),
                        "taskType 会原样进对外响应 —— 密钥不得随共享计划发布给别人。实际响应：" + published),
                () -> assertFalse(published.contains("13800138000"),
                        "手机号同理：clean() 专门在抹它，结构化字段不该成为绕过它的口子"),
                () -> assertFalse(published.contains("不是时间"),
                        "畸形时间同样不得原样发布 —— 读侧兜底只保证读者不崩，"
                                + "保证不了他看到的是个像样的时间。实际响应：" + published));
    }

    @Test
    void 畸形时间不得让别人应用计划时崩掉() {
        // 发布者存一个解析不了的时间；下面炸的是「读者」，不是发布者
        Long id = publish(task("study", "不是时间"), null);

        assertDoesNotThrow(() -> sharedPlanService.apply(readerId, id, Map.of(
                        "startDate", LocalDate.now().toString())),
                "发布者存一次畸形时间，每个想应用这个计划的人都会 500 —— "
                        + "LocalTime.parse 抛的是 DateTimeParseException，不是 BusinessException，兜不住");
    }

    /**
     * <b>修复之前已经发布的坏数据，不得继续炸读者。</b>
     *
     * <p>写侧归一之后，测试里再也造不出畸形行 —— 于是读侧那层兜底<b>完全测不到</b>：
     * 把 toDateTime 退回原来的写法，上面几条判据照样全绿。而读侧保护的正是生产库里
     * <b>现在就躺着</b>的那些行（归一上线之前发布的）。所以这一条绕过写侧、直接写库，
     * 模拟的就是那个状态。
     *
     * <p>扰动：把 toDateTime 退回 {@code LocalTime.parse(...)} 直接解析 → 本条红。
     */
    @Test
    void 归一之前已发布的畸形时间不得炸读者() {
        Long id = publish(task("study", "08:00"), null);
        // 绕过 submit 的归一，直接把库里的值改坏 —— 等同于修复上线前发布的行
        jdbcTemplate.update(
                "UPDATE shared_plan_task_template SET preferred_time = ? WHERE template_id = ?",
                "不是时间", id);

        assertDoesNotThrow(() -> sharedPlanService.apply(readerId, id, Map.of(
                        "startDate", LocalDate.now().toString())),
                "光修写侧只管新数据；已经发布出去的畸形行仍会让每个应用它的读者 500");
    }

    @Test
    void 过短的时间串不得越界() {
        // routine 应用路径走 getPreferredTime().toString().substring(0, 5)
        Long id = publish(task("study", "08:00"), Map.of(
                "title", "例行",
                "description", "描述",
                "frequency", "DAILY",
                "preferredTime", "8",
                "relativeStartDay", 0,
                "relativeEndDay", 1));

        assertDoesNotThrow(() -> sharedPlanService.apply(readerId, id, Map.of(
                        "startDate", LocalDate.now().toString())),
                "长度小于 5 的时间串会让 substring(0, 5) 越界 —— 同样是发布者存、读者炸");
    }

    @Test
    void 合法的结构化值必须原样保留() {
        // 上面三条的反例：没有它，「一律改写成默认值」也能让它们全绿
        Long id = publish(task("study", "09:30"), null);

        Map<String, Object> detail = sharedPlanService.detail(readerId, id);
        List<?> tasks = (List<?>) detail.get("tasks");
        assertEquals(1, tasks.size());
        Map<?, ?> row = (Map<?, ?>) tasks.get(0);
        assertEquals("study", String.valueOf(row.get("taskType")), "合法的 taskType 不得被改写");
        assertTrue(String.valueOf(row.get("preferredTime")).startsWith("09:30"),
                "合法的时间不得被改写，实际：" + row.get("preferredTime"));
    }
}
