package com.zhiqu.rag;

import com.zhiqu.service.KnowledgeService;
import com.zhiqu.service.privacy.SensitiveCryptoService;
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

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Wiki 写路径是否真的把 RAG 作业入了队。
 *
 * <p><b>为什么需要单独一组：</b>全量测试变绿只说明钩子没有打坏既有行为，
 * 不说明它做了事。少接一个钩子的故障形态是「那条路径写的内容永不入索引」——
 * 页面本身完好，检索里悄悄少一块，没有任何报错。
 *
 * <p>断言的是 {@code rag_index_job} 里的行，不是「方法调用成功」。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class KnowledgeRagHookTest {
    static {
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
    }

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_hook_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private KnowledgeService knowledgeService;
    @Autowired private SensitiveCryptoService crypto;

    private Long userId;

    @BeforeEach
    void prepare() {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES(?,?,?,'USER',0)",
                "hook_" + suffix, "test-password", "Hook");
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE username=?", Long.class, "hook_" + suffix);
        // ensureSystemPages 会在首次 workspace 时建系统页并可能入队，先把队列清干净再断言。
        knowledgeService.workspace(userId);
        jdbc.update("DELETE FROM rag_index_job");
    }

    @Test
    void 创建知识页会入队更新作业() {
        Long pageId = savePage(null, "高数复习", "第一章 极限");

        assertEquals(List.of("UPSERT_UNIT"), operationsFor(pageId),
                "创建后不入队的话，这页永远不会进检索，而页面本身看起来完好");
    }

    @Test
    void 更新知识页会入队更新作业() {
        Long pageId = savePage(null, "高数复习", "第一章 极限");
        jdbc.update("DELETE FROM rag_index_job");

        Integer version = jdbc.queryForObject(
                "SELECT version FROM user_knowledge_page WHERE id=?", Integer.class, pageId);
        Map<String, Object> body = new HashMap<>();
        body.put("title", "高数复习");
        body.put("content", "第一章 极限（已修订）");
        body.put("version", version);
        knowledgeService.savePage(userId, pageId, body);

        assertEquals(List.of("UPSERT_UNIT"), operationsFor(pageId), "更新必须重新入队，否则检索停在旧版");
    }

    @Test
    void 删除知识页会入队退役作业() {
        Long pageId = savePage(null, "临时草稿", "写完就删");
        jdbc.update("DELETE FROM rag_index_job");

        Integer version = jdbc.queryForObject(
                "SELECT version FROM user_knowledge_page WHERE id=?", Integer.class, pageId);
        knowledgeService.deletePage(userId, pageId, version);

        assertEquals(List.of("DELETE_UNIT"), operationsFor(pageId),
                "不发退役作业的话，向量留在库里——用户以为删掉的内容仍能被检索到");
    }

    /**
     * 纯结构改动不入队。
     *
     * <p>{@code movePage} 只改 {@code parentId}/{@code sortOrder}，而 Wiki 单元的
     * {@code scope_kind} 恒为 WIKI_TREE、{@code scope_id} 恒为 null —— 移动不改变检索范围。
     * 接上钩子只会让每拖一次页面就白跑一轮解密、规范化、重算哈希，然后发现哈希没变。
     */
    @Test
    void 移动知识页不入队() {
        Long parentId = savePage(null, "父页", "父页正文");
        Long childId = savePage(null, "子页", "子页正文");
        jdbc.update("DELETE FROM rag_index_job");

        Integer version = jdbc.queryForObject(
                "SELECT version FROM user_knowledge_page WHERE id=?", Integer.class, childId);
        Map<String, Object> body = new HashMap<>();
        body.put("parentId", parentId);
        body.put("version", version);
        knowledgeService.movePage(userId, childId, body);

        assertEquals(List.of(), operationsFor(childId), "结构改动不改变检索范围，不该触发重新索引");
    }

    /**
     * 普通页被改成 GUIDE 后必须<b>退役</b>，而不是继续更新。
     *
     * <p>GUIDE 每轮逐字注入提示词，再索引一遍等于同一段文字重复计数。若这里仍发更新作业，
     * 那份向量会一直留在库里被检索到。
     */
    @Test
    void 普通页改成GUIDE会入队退役作业() {
        Long pageId = savePage(null, "学习守则", "每天先做重要不紧急的事");
        jdbc.update("DELETE FROM rag_index_job");

        Integer version = jdbc.queryForObject(
                "SELECT version FROM user_knowledge_page WHERE id=?", Integer.class, pageId);
        Map<String, Object> body = new HashMap<>();
        body.put("title", "学习守则");
        body.put("content", "每天先做重要不紧急的事");
        body.put("pageType", "GUIDE");
        body.put("version", version);
        knowledgeService.savePage(userId, pageId, body);

        assertEquals(List.of("DELETE_UNIT"), operationsFor(pageId),
                "变成 GUIDE 后必须退役，否则留下一份会被检索到的孤儿向量");
    }

    /** 入队的行必须带对 namespace 与 ref_id，否则 worker 定位不到投影行、静默无操作。 */
    @Test
    void 入队的行带着正确的命名空间与引用id() {
        Long pageId = savePage(null, "高数复习", "第一章 极限");

        Map<String, Object> row = jdbc.queryForMap(
                "SELECT namespace, source_id, user_id, protocol_version FROM rag_index_job WHERE source_id=?", pageId);
        assertEquals(RagNamespace.WIKI_PAGE, row.get("namespace"));
        assertEquals(pageId.longValue(), ((Number) row.get("source_id")).longValue());
        assertEquals(userId.longValue(), ((Number) row.get("user_id")).longValue());
        assertTrue(((Number) row.get("protocol_version")).intValue() >= 1);
    }

    /**
     * AI 草稿合入（{@code upsertRevisionPage}）也必须入队。
     *
     * <p><b>这条不能靠 savePage 的用例代劳</b>：两者是两段独立的代码，去掉 savePage 钩子的扰动
     * 打不到这一条。而这正是 AI 写入知识库走的路径 —— 漏了它，AI 写的内容永远不进检索，
     * 而页面在 Wiki 里好好的。
     */
    @Test
    void AI草稿合入也会入队更新作业() {
        jdbc.update("INSERT INTO user_knowledge_revision(user_id,page_id,action_type,title," +
                        "encrypted_content,status,encryption_version,deleted) " +
                        "VALUES(?,NULL,'CREATE',?,?,'PENDING','v1',0)",
                userId, "AI 整理的复习要点", crypto.encrypt("极限的定义与常见误区"));
        Long revisionId = jdbc.queryForObject(
                "SELECT id FROM user_knowledge_revision WHERE user_id=? ORDER BY id DESC LIMIT 1", Long.class, userId);
        jdbc.update("DELETE FROM rag_index_job");

        knowledgeService.applyRevision(userId, revisionId, new HashMap<>());

        Long pageId = jdbc.queryForObject(
                "SELECT page_id FROM user_knowledge_revision WHERE id=?", Long.class, revisionId);
        assertEquals(List.of("UPSERT_UNIT"), operationsFor(pageId),
                "AI 草稿合入不入队的话，AI 写进知识库的内容永远不会被检索到");
    }

    private Long savePage(Long id, String title, String content) {
        Map<String, Object> body = new HashMap<>();
        body.put("title", title);
        body.put("content", content);
        Map<String, Object> saved = knowledgeService.savePage(userId, id, body);
        return ((Number) saved.get("id")).longValue();
    }

    private List<String> operationsFor(Long pageId) {
        return jdbc.queryForList(
                "SELECT operation FROM rag_index_job WHERE source_id=? AND namespace=? ORDER BY id",
                String.class, pageId, RagNamespace.WIKI_PAGE);
    }
}
