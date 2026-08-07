package com.zhiqu.rag;

import com.zhiqu.service.AiWorkspaceService;
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

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 资料列表的 {@code indexStatus} 读投影、投影缺失时回落旧列。
 *
 * <p><b>第三段为什么是「翻转读取」而不是「回写」：</b>
 * {@code ai_notebook_source.index_status} 是 15 写 / 1 读 —— 写入方散在
 * {@code RagIndexJobService}(8)、{@code AiWorkspaceServiceImpl}(6)、{@code RagAdminService}(1)，
 * 而唯一的生产读取方就是这个列表字段（前端拿它画一个圆点的颜色和一行文字）。
 * 给它再挂第 16 个写入方只为让那个点变色，代价与收益不成比例，且与投影表
 * 「把重复状态收敛掉」的存在意义相反。翻转这一个读取点，新增零个写入方。
 *
 * <p>两条断言缺一不可：<b>只测「读投影」的话，把回落删掉也照样绿</b>（投影有值时用不到回落）；
 * 只测「回落」的话，翻转根本没生效也照样绿（旧列本来就是数据源）。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class SourceIndexStatusReadsProjectionTest {
    static {
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
    }

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_idxstatus_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private AiWorkspaceService workspaceService;

    private Long userId;
    private Long notebookId;
    private Long sourceId;

    @BeforeEach
    void prepare() {
        jdbc.update("DELETE FROM rag_unit_chunk");
        jdbc.update("DELETE FROM rag_indexable_unit");
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES(?,?,?,'USER',0)",
                "idx_" + suffix, "test-password", "Idx");
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE username=?", Long.class, "idx_" + suffix);
        jdbc.update("INSERT INTO ai_notebook(user_id,title,status,deleted) VALUES(?,?,'ACTIVE',0)", userId, "状态来源");
        notebookId = jdbc.queryForObject(
                "SELECT id FROM ai_notebook WHERE user_id=? ORDER BY id DESC LIMIT 1", Long.class, userId);
        // 旧列刻意写成 ERROR：两条用例都靠「投影值 ≠ 旧列值」来区分读的是哪一边。
        // 两边写成同一个值的话，翻转生效与否都看不出差别——那样这组测试等于没测。
        jdbc.update("INSERT INTO ai_notebook_source(user_id,notebook_id,source_type,title,status," +
                "index_status,content_hash,deleted) VALUES(?,?,'TEXT','讲义.txt','READY','ERROR','h1',0)",
                userId, notebookId);
        sourceId = jdbc.queryForObject(
                "SELECT id FROM ai_notebook_source WHERE notebook_id=? ORDER BY id DESC LIMIT 1",
                Long.class, notebookId);
    }

    @Test
    void 投影有行时读投影而不是旧列() {
        insertUnit("INDEXED");

        assertEquals("INDEXED", indexStatusFromList(),
                "投影行在时必须以它为准；读到 ERROR 说明翻转没生效，仍在读那个有 15 个写入方的旧列");
    }

    /**
     * 回落不是防御性编程：V29 只建表不填数据，投影行由 {@code RECONCILE_UNITS} 作业从原始表
     * 枚举，<b>对账跑完之前本表是空的</b>。没有回落的话，升级后到首次对账之间，
     * 所有资料的索引状态在界面上一律变成空白。
     */
    @Test
    void 投影缺行时回落旧列() {
        assertEquals("ERROR", indexStatusFromList(),
                "投影为空时必须回落旧列，否则迁移窗口内界面上的索引状态会一律变空");
    }

    /** 投影行存在但状态为空时同样回落 —— 空字符串不该被当成「有值」。 */
    @Test
    void 投影行状态为空时也回落() {
        insertUnit(null);

        assertEquals("ERROR", indexStatusFromList());
    }

    private void insertUnit(String indexStatus) {
        jdbc.update("INSERT INTO rag_indexable_unit(user_id,namespace,ref_id,scope_kind,scope_id," +
                        "title,source_type,chunk_count,status,index_status) " +
                        "VALUES(?,?,?,'NOTEBOOK',?,'讲义.txt','TEXT',1,'READY',?)",
                userId, RagNamespace.NOTEBOOK_SOURCE, sourceId, notebookId,
                indexStatus == null ? "" : indexStatus);
    }

    private String indexStatusFromList() {
        List<Map<String, Object>> rows = workspaceService.listSources(userId, notebookId);
        assertEquals(1, rows.size(), "前提：本用例只建了一份资料");
        Object value = rows.get(0).get("indexStatus");
        return value == null ? null : String.valueOf(value);
    }
}
