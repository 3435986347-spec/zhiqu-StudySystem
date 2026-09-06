package com.zhiqu.service.impl;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.ApplicationContext;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import javax.sql.DataSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false"
})
class KnowledgeConcurrencyIntegrationTest {

    static {
        // Docker 29 rejects the 1.32 API used by older docker-java defaults.
        // Keep this overridable while making the test suite work on current Docker Desktop.
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
    }

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired
    private ApplicationContext applicationContext;

    private KnowledgeApi knowledgeService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private DataSource dataSource;

    private Long userId;

    @BeforeEach
    void createUser() {
        knowledgeService = new KnowledgeApi(applicationContext);
        String username = "wiki_test_" + UUID.randomUUID().toString().replace("-", "");
        jdbcTemplate.update("INSERT INTO sys_user(username, password, nickname, role, deleted) VALUES (?, ?, ?, 'USER', 0)",
                username, "test-password", "Wiki Test");
        userId = jdbcTemplate.queryForObject("SELECT id FROM sys_user WHERE username = ?", Long.class, username);
        assertNotNull(userId);
    }

    @Test
    void stalePageSaveIsRejected() {
        Map<String, Object> page = createPage("并发保存", "版本 0");
        int version = number(page.get("version"));

        Map<String, Object> first = updateBody(page, "版本 1", version);
        Map<String, Object> updated = knowledgeService.savePage(userId, numberLong(page.get("id")), first);
        assertEquals(version + 1, number(updated.get("version")));

        RuntimeException error = assertThrows(RuntimeException.class,
                () -> knowledgeService.savePage(userId, numberLong(page.get("id")), updateBody(page, "陈旧覆盖", version)));
        assertTrue(error.getMessage().contains("其他窗口修改"));
        assertEquals("版本 1", knowledgeService.detail(userId, numberLong(page.get("id"))).get("content"));
    }

    @Test
    void publicPatchSetRequiresTheVersionThatWasRead() {
        Map<String, Object> page = createPage("公共草稿", "原内容");
        int staleVersion = number(page.get("version"));
        knowledgeService.savePage(userId, numberLong(page.get("id")), updateBody(page, "新内容", staleVersion));

        Map<String, Object> item = patchItem(page, "草稿内容", staleVersion);
        assertThrows(RuntimeException.class,
                () -> knowledgeService.createPatchSet(userId, patchBody("公共草稿", item)));
        Integer count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM knowledge_patch_set WHERE user_id = ? AND deleted = 0", Integer.class, userId);
        assertEquals(0, count);
    }

    @Test
    void publicPatchSetIgnoresForgedHashAndStoresServerBaseline() {
        Map<String, Object> page = createPage("服务端基准", "真实内容");
        SnapshotView snapshot = knowledgeService.findPageSnapshotByTitle(userId, "服务端基准");
        Map<String, Object> item = patchItem(page, "待合入内容", snapshot.version());

        Map<String, Object> patch = knowledgeService.createPatchSet(userId, patchBody("服务端基准", item));
        Map<String, Object> stored = jdbcTemplate.queryForMap(
                "SELECT base_content_hash, base_page_version FROM user_knowledge_revision WHERE patch_set_id = ?",
                patch.get("id"));

        assertEquals(snapshot.stateHash(), stored.get("base_content_hash"));
        assertEquals(snapshot.version(), number(stored.get("base_page_version")));
    }

    @Test
    void staleMoveIsRejectedWithoutChangingParent() {
        Map<String, Object> firstParent = createPage("父页一", "父页一");
        Map<String, Object> secondParent = createPage("父页二", "父页二");
        Map<String, Object> childBody = new LinkedHashMap<>();
        childBody.put("title", "子页");
        childBody.put("content", "子页");
        childBody.put("pageType", "NOTE");
        childBody.put("parentId", firstParent.get("id"));
        childBody.put("sortOrder", 0);
        childBody.put("pinned", false);
        Map<String, Object> child = knowledgeService.savePage(userId, null, childBody);
        int staleVersion = number(child.get("version"));
        knowledgeService.savePage(userId, numberLong(child.get("id")), updateBody(child, "子页已更新", staleVersion));

        Map<String, Object> move = new LinkedHashMap<>();
        move.put("parentId", secondParent.get("id"));
        move.put("sortOrder", 0);
        move.put("version", staleVersion);
        assertThrows(RuntimeException.class,
                () -> knowledgeService.movePage(userId, numberLong(child.get("id")), move));
        assertEquals(numberLong(firstParent.get("id")),
                numberLong(knowledgeService.detail(userId, numberLong(child.get("id"))).get("parentId")));
    }

    @Test
    void savePageCannotMoveAParentUnderItsChild() {
        Map<String, Object> parent = createPage("环父页", "父页");
        Map<String, Object> child = createChildPage("环子页", "子页", parent);

        Map<String, Object> update = updateBody(parent, "父页", number(parent.get("version")));
        update.put("parentId", child.get("id"));
        RuntimeException error = assertThrows(RuntimeException.class,
                () -> knowledgeService.savePage(userId, numberLong(parent.get("id")), update));

        assertTrue(error.getMessage().contains("子节点"));
        assertEquals(null, knowledgeService.detail(userId, numberLong(parent.get("id"))).get("parentId"));
    }

    @Test
    void revisionApplyCannotMoveAParentUnderItsChild() {
        Map<String, Object> parent = createPage("草稿环父页", "父页");
        Map<String, Object> child = createChildPage("草稿环子页", "子页", parent);
        Map<String, Object> patch = knowledgeService.createPatchSet(userId,
                patchBody("草稿环父页", patchItem(parent, "父页更新", number(parent.get("version")))));
        Long revisionId = jdbcTemplate.queryForObject(
                "SELECT id FROM user_knowledge_revision WHERE patch_set_id = ?", Long.class, patch.get("id"));
        jdbcTemplate.update("UPDATE user_knowledge_revision SET patch_set_id = NULL WHERE id = ?", revisionId);
        Map<String, Object> applyBody = new LinkedHashMap<>();
        applyBody.put("parentId", child.get("id"));

        RuntimeException error = assertThrows(RuntimeException.class,
                () -> knowledgeService.applyRevision(userId, revisionId, applyBody));
        assertTrue(error.getMessage().contains("子节点"));
        assertEquals(null, knowledgeService.detail(userId, numberLong(parent.get("id"))).get("parentId"));
    }

    @Test
    void concurrentOppositeMovesCannotCreateACycle() throws Exception {
        Map<String, Object> first = createPage("并发环 A", "A");
        Map<String, Object> second = createPage("并发环 B", "B");
        Map<String, Object> firstMove = moveBody(second.get("id"), number(first.get("version")));
        Map<String, Object> secondMove = moveBody(first.get("id"), number(second.get("version")));

        ExecutorService executor = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            Future<Boolean> firstResult = executor.submit(
                    () -> moveAfter(start, numberLong(first.get("id")), firstMove));
            Future<Boolean> secondResult = executor.submit(
                    () -> moveAfter(start, numberLong(second.get("id")), secondMove));
            start.countDown();
            int successes = (firstResult.get(15, TimeUnit.SECONDS) ? 1 : 0)
                    + (secondResult.get(15, TimeUnit.SECONDS) ? 1 : 0);
            assertEquals(1, successes);
        } finally {
            executor.shutdownNow();
        }

        Map<String, Object> storedFirst = knowledgeService.detail(userId, numberLong(first.get("id")));
        Map<String, Object> storedSecond = knowledgeService.detail(userId, numberLong(second.get("id")));
        boolean firstIsChild = numberLong(first.get("id")).equals(numberLong(storedSecond.get("parentId")));
        boolean secondIsChild = numberLong(second.get("id")).equals(numberLong(storedFirst.get("parentId")));
        assertTrue(firstIsChild ^ secondIsChild);
    }

    @Test
    void staleDeleteRevisionCannotDeleteThePage() {
        Map<String, Object> page = createPage("删除保护", "保留我");
        int version = number(page.get("version"));
        Map<String, Object> deleteItem = patchItem(page, "", version);
        deleteItem.put("actionType", "DELETE");
        Map<String, Object> patch = knowledgeService.createPatchSet(userId, patchBody("删除保护", deleteItem));

        knowledgeService.savePage(userId, numberLong(page.get("id")), updateBody(page, "用户后来修改", version));
        assertThrows(RuntimeException.class,
                () -> knowledgeService.applyPatchSet(userId, numberLong(patch.get("id"))));
        assertEquals("用户后来修改", knowledgeService.detail(userId, numberLong(page.get("id"))).get("content"));
        assertEquals("PENDING", jdbcTemplate.queryForObject(
                "SELECT status FROM knowledge_patch_set WHERE id = ?", String.class, patch.get("id")));
    }

    @Test
    void deletingAParentReparentsItsChildrenToTheGrandparent() {
        Map<String, Object> grandparent = createPage("删除迁移祖页", "祖页");
        Map<String, Object> parent = createChildPage("删除迁移父页", "父页", grandparent);
        Map<String, Object> child = createChildPage("删除迁移子页", "子页", parent);
        int childVersion = number(child.get("version"));

        knowledgeService.deletePage(userId, numberLong(parent.get("id")), number(parent.get("version")));

        Map<String, Object> movedChild = knowledgeService.detail(userId, numberLong(child.get("id")));
        assertEquals(numberLong(grandparent.get("id")), numberLong(movedChild.get("parentId")));
        assertEquals(childVersion + 1, number(movedChild.get("version")));
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT deleted FROM user_knowledge_page WHERE id = ?", Integer.class, parent.get("id")));
    }

    @Test
    void deleteRevisionAlsoReparentsChildren() {
        Map<String, Object> parent = createPage("草稿删除父页", "父页");
        Map<String, Object> child = createChildPage("草稿删除子页", "子页", parent);
        Map<String, Object> deleteItem = patchItem(parent, "", number(parent.get("version")));
        deleteItem.put("actionType", "DELETE");
        Long patchId = numberLong(knowledgeService.createPatchSet(
                userId, patchBody("草稿删除父页", deleteItem)).get("id"));

        knowledgeService.applyPatchSet(userId, patchId);

        Map<String, Object> movedChild = knowledgeService.detail(userId, numberLong(child.get("id")));
        assertEquals(null, movedChild.get("parentId"));
        assertEquals("APPROVED", jdbcTemplate.queryForObject(
                "SELECT status FROM knowledge_patch_set WHERE id = ?", String.class, patchId));
    }

    @Test
    void v23RepairsHistoricalOrphanAndThePageCanBeSaved() {
        Map<String, Object> parent = createPage("历史孤儿父页", "父页");
        Map<String, Object> child = createChildPage("历史孤儿子页", "修复前", parent);
        int childVersion = number(child.get("version"));
        jdbcTemplate.update("UPDATE user_knowledge_page SET deleted = 1 WHERE id = ?", parent.get("id"));

        runV23RepairMigration();

        Map<String, Object> repaired = knowledgeService.detail(userId, numberLong(child.get("id")));
        assertEquals(null, repaired.get("parentId"));
        assertEquals(childVersion + 1, number(repaired.get("version")));
        Map<String, Object> saved = knowledgeService.savePage(userId, numberLong(child.get("id")),
                updateBody(repaired, "修复后可以保存", number(repaired.get("version"))));
        assertEquals("修复后可以保存", saved.get("content"));
    }

    @Test
    void oldDeleteRevisionWithoutBaselineIsRejected() {
        Map<String, Object> page = createPage("旧删除草稿", "不能被删");
        jdbcTemplate.update("""
                INSERT INTO user_knowledge_revision(user_id, page_id, action_type, title, status, deleted)
                VALUES (?, ?, 'DELETE', ?, 'PENDING', 0)
                """, userId, page.get("id"), page.get("title"));
        Long revisionId = jdbcTemplate.queryForObject("SELECT MAX(id) FROM user_knowledge_revision WHERE user_id = ?",
                Long.class, userId);

        assertThrows(RuntimeException.class, () -> knowledgeService.approveRevision(userId, revisionId));
        assertNotNull(knowledgeService.detail(userId, numberLong(page.get("id"))));
    }

    @Test
    void oldUpsertRevisionWithoutBaselineCannotBeRedirectedToExistingPage() {
        Map<String, Object> page = createPage("旧更新草稿", "必须保留");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", "原本是新页");
        body.put("pageTitle", "原本是新页");
        body.put("content", "不允许覆盖");
        Map<String, Object> patch = knowledgeService.createPatchSet(userId, body);
        jdbcTemplate.update("UPDATE user_knowledge_revision SET page_id = ? WHERE patch_set_id = ?",
                page.get("id"), patch.get("id"));

        assertThrows(RuntimeException.class,
                () -> knowledgeService.applyPatchSet(userId, numberLong(patch.get("id"))));
        assertEquals("必须保留", knowledgeService.detail(userId, numberLong(page.get("id"))).get("content"));
    }

    @Test
    void trustedSnapshotUsesTheSameNormalizedMarkdownForApply() {
        Map<String, Object> page = createPage("规范化", "```markdown\r\n# 标题\r\n\r\n| A | B |\r\n| --- | --- |\r\n| 1 | 2 |\r\n```");
        SnapshotView snapshot = knowledgeService.findPageSnapshotByTitle(userId, "规范化");
        assertNotNull(snapshot);

        Map<String, Object> item = new LinkedHashMap<>();
        item.put("pageId", snapshot.pageId());
        item.put("actionType", "UPSERT");
        item.put("title", snapshot.title());
        item.put("content", snapshot.content() + "\n\n补充");
        Map<String, Object> patch = knowledgeService.createPatchSet(userId, patchBody("规范化", item),
                Map.of(snapshot.pageId(), snapshot));

        knowledgeService.applyPatchSet(userId, numberLong(patch.get("id")));
        assertTrue(String.valueOf(knowledgeService.detail(userId, snapshot.pageId()).get("content")).endsWith("补充"));
    }

    @Test
    void concurrentApplyOfANewPageDraftCreatesOnePage() throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", "并发新页");
        body.put("pageTitle", "并发新页");
        body.put("content", "只应创建一次");
        Map<String, Object> patch = knowledgeService.createPatchSet(userId, body);
        Long patchId = numberLong(patch.get("id"));

        ExecutorService executor = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            Future<Boolean> first = executor.submit(() -> applyAfter(start, patchId));
            Future<Boolean> second = executor.submit(() -> applyAfter(start, patchId));
            start.countDown();
            int successes = (first.get() ? 1 : 0) + (second.get() ? 1 : 0);
            assertEquals(2, successes);
        } finally {
            executor.shutdownNow();
        }

        Integer pages = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM user_knowledge_page WHERE user_id = ? AND title = '并发新页' AND deleted = 0",
                Integer.class, userId);
        assertEquals(1, pages);
    }

    @Test
    void concurrentApplyOfAnUpdateDraftChangesThePageOnce() throws Exception {
        Map<String, Object> page = createPage("并发更新页", "初始内容");
        int version = number(page.get("version"));
        Map<String, Object> patch = knowledgeService.createPatchSet(userId,
                patchBody("并发更新页", patchItem(page, "只更新一次", version)));
        Long patchId = numberLong(patch.get("id"));

        ExecutorService executor = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            Future<Boolean> first = executor.submit(() -> applyAfter(start, patchId));
            Future<Boolean> second = executor.submit(() -> applyAfter(start, patchId));
            start.countDown();
            assertTrue(first.get());
            assertTrue(second.get());
        } finally {
            executor.shutdownNow();
        }

        Map<String, Object> updated = knowledgeService.detail(userId, numberLong(page.get("id")));
        assertEquals("只更新一次", updated.get("content"));
        assertEquals(version + 1, number(updated.get("version")));
    }

    @Test
    void rejectedRevisionCannotBeAppliedAsAnIdempotentSuccess() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", "已驳回建议");
        body.put("pageTitle", "已驳回建议");
        body.put("content", "不会创建");
        Map<String, Object> patch = knowledgeService.createPatchSet(userId, body);
        Long revisionId = jdbcTemplate.queryForObject(
                "SELECT id FROM user_knowledge_revision WHERE patch_set_id = ?", Long.class, patch.get("id"));
        jdbcTemplate.update("UPDATE user_knowledge_revision SET patch_set_id = NULL WHERE id = ?", revisionId);

        knowledgeService.rejectRevision(userId, revisionId);
        RuntimeException error = assertThrows(RuntimeException.class,
                () -> knowledgeService.approveRevision(userId, revisionId));
        assertTrue(error.getMessage().contains("已驳回"));
        assertEquals("REJECTED", jdbcTemplate.queryForObject(
                "SELECT status FROM user_knowledge_revision WHERE id = ?", String.class, revisionId));
    }

    @Test
    void revisionInsidePatchSetCannotBeProcessedIndividually() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", "包内建议");
        body.put("pageTitle", "包内建议");
        body.put("content", "必须整包处理");
        Map<String, Object> patch = knowledgeService.createPatchSet(userId, body);
        Long revisionId = jdbcTemplate.queryForObject(
                "SELECT id FROM user_knowledge_revision WHERE patch_set_id = ?", Long.class, patch.get("id"));

        RuntimeException approveError = assertThrows(RuntimeException.class,
                () -> knowledgeService.approveRevision(userId, revisionId));
        RuntimeException applyError = assertThrows(RuntimeException.class,
                () -> knowledgeService.applyRevision(userId, revisionId, Map.of()));
        RuntimeException rejectError = assertThrows(RuntimeException.class,
                () -> knowledgeService.rejectRevision(userId, revisionId));

        assertTrue(approveError.getMessage().contains("变更包"));
        assertTrue(applyError.getMessage().contains("变更包"));
        assertTrue(rejectError.getMessage().contains("变更包"));
        assertEquals("PENDING", jdbcTemplate.queryForObject(
                "SELECT status FROM user_knowledge_revision WHERE id = ?", String.class, revisionId));
        assertEquals("PENDING", jdbcTemplate.queryForObject(
                "SELECT status FROM knowledge_patch_set WHERE id = ?", String.class, patch.get("id")));
    }

    @Test
    void patchWithRejectedChildCannotBeApproved() {
        Map<String, Object> patch = knowledgeService.createPatchSet(userId, patchBody("混合驳回包", List.of(
                newPagePatchItem("混合驳回一", "一"), newPagePatchItem("混合驳回二", "二"))));
        List<Long> revisionIds = jdbcTemplate.queryForList(
                "SELECT id FROM user_knowledge_revision WHERE patch_set_id = ? ORDER BY id", Long.class, patch.get("id"));
        jdbcTemplate.update("UPDATE user_knowledge_revision SET status = 'REJECTED' WHERE id = ?", revisionIds.get(0));

        RuntimeException error = assertThrows(RuntimeException.class,
                () -> knowledgeService.applyPatchSet(userId, numberLong(patch.get("id"))));
        assertTrue(error.getMessage().contains("已驳回"));
        assertEquals("PENDING", jdbcTemplate.queryForObject(
                "SELECT status FROM knowledge_patch_set WHERE id = ?", String.class, patch.get("id")));
        assertEquals("PENDING", jdbcTemplate.queryForObject(
                "SELECT status FROM user_knowledge_revision WHERE id = ?", String.class, revisionIds.get(1)));
    }

    @Test
    void patchWithApprovedChildCannotBeRejected() {
        Map<String, Object> patch = knowledgeService.createPatchSet(userId, patchBody("混合通过包", List.of(
                newPagePatchItem("混合通过一", "一"), newPagePatchItem("混合通过二", "二"))));
        List<Long> revisionIds = jdbcTemplate.queryForList(
                "SELECT id FROM user_knowledge_revision WHERE patch_set_id = ? ORDER BY id", Long.class, patch.get("id"));
        jdbcTemplate.update("UPDATE user_knowledge_revision SET status = 'APPROVED' WHERE id = ?", revisionIds.get(0));

        RuntimeException error = assertThrows(RuntimeException.class,
                () -> knowledgeService.rejectPatchSet(userId, numberLong(patch.get("id"))));
        assertTrue(error.getMessage().contains("完成合入"));
        assertEquals("PENDING", jdbcTemplate.queryForObject(
                "SELECT status FROM knowledge_patch_set WHERE id = ?", String.class, patch.get("id")));
        assertEquals("PENDING", jdbcTemplate.queryForObject(
                "SELECT status FROM user_knowledge_revision WHERE id = ?", String.class, revisionIds.get(1)));
    }

    @Test
    void fullyApprovedLegacyChildrenReconcilePendingPatchSet() {
        Map<String, Object> patch = knowledgeService.createPatchSet(userId, patchBody(
                "历史全通过包", List.of(newPagePatchItem("历史全通过", "已处理"))));
        jdbcTemplate.update("UPDATE user_knowledge_revision SET status = 'APPROVED' WHERE patch_set_id = ?", patch.get("id"));

        knowledgeService.applyPatchSet(userId, numberLong(patch.get("id")));

        assertEquals("APPROVED", jdbcTemplate.queryForObject(
                "SELECT status FROM knowledge_patch_set WHERE id = ?", String.class, patch.get("id")));
    }

    @Test
    void v23FinalizesHistoricalMixedPatchSetAsPartial() {
        Map<String, Object> patch = knowledgeService.createPatchSet(userId, patchBody("历史混合包", List.of(
                newPagePatchItem("历史混合一", "一"),
                newPagePatchItem("历史混合二", "二"),
                newPagePatchItem("历史混合三", "三"))));
        List<Long> revisionIds = jdbcTemplate.queryForList(
                "SELECT id FROM user_knowledge_revision WHERE patch_set_id = ? ORDER BY id", Long.class, patch.get("id"));
        jdbcTemplate.update("UPDATE user_knowledge_revision SET status = 'APPROVED' WHERE id = ?", revisionIds.get(0));
        jdbcTemplate.update("UPDATE user_knowledge_revision SET status = 'REJECTED' WHERE id = ?", revisionIds.get(1));

        runV23RepairMigration();

        assertEquals("PARTIAL", jdbcTemplate.queryForObject(
                "SELECT status FROM knowledge_patch_set WHERE id = ?", String.class, patch.get("id")));
        assertEquals(List.of("APPROVED", "REJECTED", "REJECTED"), jdbcTemplate.queryForList(
                "SELECT status FROM user_knowledge_revision WHERE patch_set_id = ? ORDER BY id",
                String.class, patch.get("id")));
        RuntimeException applyError = assertThrows(RuntimeException.class,
                () -> knowledgeService.applyPatchSet(userId, numberLong(patch.get("id"))));
        RuntimeException rejectError = assertThrows(RuntimeException.class,
                () -> knowledgeService.rejectPatchSet(userId, numberLong(patch.get("id"))));
        assertTrue(applyError.getMessage().contains("部分合入"));
        assertTrue(rejectError.getMessage().contains("部分合入"));
        assertEquals(0, jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM knowledge_patch_set WHERE id = ? AND status = 'PENDING'",
                Integer.class, patch.get("id")));
    }

    @Test
    void concurrentPatchApplyAndRejectHasOneTruthfulOutcome() throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", "合入驳回竞态");
        body.put("pageTitle", "合入驳回竞态");
        body.put("content", "只能有一种结果");
        Long patchId = numberLong(knowledgeService.createPatchSet(userId, body).get("id"));

        ExecutorService executor = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        String applyResult;
        String rejectResult;
        try {
            Future<String> apply = executor.submit(() -> applyOutcomeAfter(start, patchId));
            Future<String> reject = executor.submit(() -> rejectOutcomeAfter(start, patchId));
            start.countDown();
            applyResult = apply.get(15, TimeUnit.SECONDS);
            rejectResult = reject.get(15, TimeUnit.SECONDS);
        } finally {
            executor.shutdownNow();
        }

        String status = jdbcTemplate.queryForObject(
                "SELECT status FROM knowledge_patch_set WHERE id = ?", String.class, patchId);
        if ("APPROVED".equals(status)) {
            assertEquals("APPROVED", applyResult);
            assertEquals("ERROR", rejectResult);
        } else {
            assertEquals("REJECTED", status);
            assertEquals("ERROR", applyResult);
            assertEquals("REJECTED", rejectResult);
        }
    }

    @Test
    void crossPatchSetsLockSharedPagesInPageIdOrder() throws Exception {
        Map<String, Object> firstPage = createPage("锁序 A", "A0");
        Map<String, Object> secondPage = createPage("锁序 B", "B0");
        Map<String, Object> firstPatchBody = patchBody("锁序一", List.of(
                patchItem(firstPage, "A1", number(firstPage.get("version"))),
                patchItem(secondPage, "B1", number(secondPage.get("version")))));
        Map<String, Object> secondPatchBody = patchBody("锁序二", List.of(
                patchItem(secondPage, "B2", number(secondPage.get("version"))),
                patchItem(firstPage, "A2", number(firstPage.get("version")))));
        Long firstPatchId = numberLong(knowledgeService.createPatchSet(userId, firstPatchBody).get("id"));
        Long secondPatchId = numberLong(knowledgeService.createPatchSet(userId, secondPatchBody).get("id"));

        ExecutorService executor = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        ApplyAttempt firstAttempt;
        ApplyAttempt secondAttempt;
        try {
            Future<ApplyAttempt> first = executor.submit(() -> applyAttemptAfter(start, firstPatchId));
            Future<ApplyAttempt> second = executor.submit(() -> applyAttemptAfter(start, secondPatchId));
            start.countDown();
            firstAttempt = first.get(15, TimeUnit.SECONDS);
            secondAttempt = second.get(15, TimeUnit.SECONDS);
            int successes = (firstAttempt.success() ? 1 : 0) + (secondAttempt.success() ? 1 : 0);
            assertEquals(1, successes);
        } finally {
            executor.shutdownNow();
        }
        ApplyAttempt failure = firstAttempt.success() ? secondAttempt : firstAttempt;
        assertNotNull(failure.error());
        assertEquals("com.zhiqu.common.BusinessException", failure.error().getClass().getName());
        assertTrue(failure.error().getMessage().contains("其他窗口修改"));
        String failureText = String.valueOf(failure.error().getMessage()).toLowerCase();
        assertTrue(!failureText.contains("deadlock")
                && !failureText.contains("lock wait")
                && !failureText.contains("connection"));
    }

    private boolean applyAfter(CountDownLatch start, Long patchId) throws InterruptedException {
        start.await();
        try {
            knowledgeService.applyPatchSet(userId, patchId);
            return true;
        } catch (RuntimeException expected) {
            return false;
        }
    }

    private ApplyAttempt applyAttemptAfter(CountDownLatch start, Long patchId) throws InterruptedException {
        start.await();
        try {
            knowledgeService.applyPatchSet(userId, patchId);
            return new ApplyAttempt(true, null);
        } catch (RuntimeException error) {
            return new ApplyAttempt(false, error);
        }
    }

    private boolean moveAfter(CountDownLatch start, Long pageId, Map<String, Object> body) throws InterruptedException {
        start.await();
        try {
            knowledgeService.movePage(userId, pageId, body);
            return true;
        } catch (RuntimeException expected) {
            return false;
        }
    }

    private String applyOutcomeAfter(CountDownLatch start, Long patchId) throws InterruptedException {
        start.await();
        try {
            knowledgeService.applyPatchSet(userId, patchId);
            return "APPROVED";
        } catch (RuntimeException expected) {
            return "ERROR";
        }
    }

    private String rejectOutcomeAfter(CountDownLatch start, Long patchId) throws InterruptedException {
        start.await();
        try {
            knowledgeService.rejectPatchSet(userId, patchId);
            return "REJECTED";
        } catch (RuntimeException expected) {
            return "ERROR";
        }
    }

    private Map<String, Object> createPage(String title, String content) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", title);
        body.put("content", content);
        body.put("pageType", "NOTE");
        body.put("sortOrder", 0);
        body.put("pinned", false);
        return knowledgeService.savePage(userId, null, body);
    }

    private Map<String, Object> createChildPage(String title, String content, Map<String, Object> parent) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", title);
        body.put("content", content);
        body.put("pageType", "NOTE");
        body.put("parentId", parent.get("id"));
        body.put("sortOrder", 0);
        body.put("pinned", false);
        return knowledgeService.savePage(userId, null, body);
    }

    private Map<String, Object> moveBody(Object parentId, int version) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("parentId", parentId);
        body.put("sortOrder", 0);
        body.put("version", version);
        return body;
    }

    private Map<String, Object> updateBody(Map<String, Object> page, String content, int version) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", page.get("title"));
        body.put("content", content);
        body.put("pageType", page.get("pageType"));
        body.put("parentId", page.get("parentId"));
        body.put("sortOrder", page.get("sortOrder"));
        body.put("pinned", page.get("pinned"));
        body.put("version", version);
        return body;
    }

    private Map<String, Object> patchItem(Map<String, Object> page, String content, int baseVersion) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("pageId", page.get("id"));
        item.put("basePageVersion", baseVersion);
        item.put("actionType", "UPSERT");
        item.put("title", page.get("title"));
        item.put("content", content);
        item.put("baseContentHash", "forged-client-hash");
        return item;
    }

    private Map<String, Object> newPagePatchItem(String title, String content) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("actionType", "UPSERT");
        item.put("title", title);
        item.put("content", content);
        return item;
    }

    private Map<String, Object> patchBody(String title, Map<String, Object> item) {
        return patchBody(title, List.of(item));
    }

    private Map<String, Object> patchBody(String title, List<Map<String, Object>> items) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", title);
        body.put("summary", "integration test");
        body.put("items", items);
        return body;
    }

    private void runV23RepairMigration() {
        new ResourceDatabasePopulator(
                new ClassPathResource("db/migration/V23__knowledge_history_repair.sql"))
                .execute(dataSource);
    }

    private int number(Object value) {
        return ((Number) value).intValue();
    }

    private Long numberLong(Object value) {
        return value == null ? null : ((Number) value).longValue();
    }

    private record ApplyAttempt(boolean success, RuntimeException error) {
    }

    /**
     * The repository lives under a Chinese Windows path. The JDK 17 javac command used by
     * Maven cannot resolve target/classes from that path during test compilation, although
     * the runtime class loader can. Keep the integration test runnable without weakening it
     * by resolving the application service through Spring at runtime.
     */
    private static final class KnowledgeApi {
        private final Object target;
        private final Class<?> contract;

        private KnowledgeApi(ApplicationContext context) {
            try {
                contract = Class.forName("com.zhiqu.service.KnowledgeService");
                target = context.getBean(contract);
            } catch (ClassNotFoundException ex) {
                throw new IllegalStateException(ex);
            }
        }

        @SuppressWarnings("unchecked")
        private Map<String, Object> savePage(Long userId, Long pageId, Map<String, Object> body) {
            return (Map<String, Object>) invoke("savePage", new Class<?>[]{Long.class, Long.class, Map.class},
                    userId, pageId, body);
        }

        @SuppressWarnings("unchecked")
        private Map<String, Object> detail(Long userId, Long pageId) {
            return (Map<String, Object>) invoke("detail", new Class<?>[]{Long.class, Long.class}, userId, pageId);
        }

        private void deletePage(Long userId, Long pageId, Integer version) {
            invoke("deletePage", new Class<?>[]{Long.class, Long.class, Integer.class}, userId, pageId, version);
        }

        @SuppressWarnings("unchecked")
        private Map<String, Object> movePage(Long userId, Long pageId, Map<String, Object> body) {
            return (Map<String, Object>) invoke("movePage", new Class<?>[]{Long.class, Long.class, Map.class},
                    userId, pageId, body);
        }

        @SuppressWarnings("unchecked")
        private Map<String, Object> createPatchSet(Long userId, Map<String, Object> body) {
            return (Map<String, Object>) invoke("createPatchSet", new Class<?>[]{Long.class, Map.class}, userId, body);
        }

        @SuppressWarnings("unchecked")
        private Map<String, Object> createPatchSet(Long userId, Map<String, Object> body,
                                                    Map<Long, SnapshotView> snapshots) {
            Map<Long, Object> trusted = new LinkedHashMap<>();
            snapshots.forEach((id, snapshot) -> trusted.put(id, snapshot.delegate()));
            return (Map<String, Object>) invoke("createPatchSet",
                    new Class<?>[]{Long.class, Map.class, Map.class}, userId, body, trusted);
        }

        @SuppressWarnings("unchecked")
        private Map<String, Object> applyPatchSet(Long userId, Long patchSetId) {
            return (Map<String, Object>) invoke("applyPatchSet", new Class<?>[]{Long.class, Long.class},
                    userId, patchSetId);
        }

        @SuppressWarnings("unchecked")
        private Map<String, Object> applyRevision(Long userId, Long revisionId, Map<String, Object> body) {
            return (Map<String, Object>) invoke("applyRevision", new Class<?>[]{Long.class, Long.class, Map.class},
                    userId, revisionId, body);
        }

        @SuppressWarnings("unchecked")
        private Map<String, Object> approveRevision(Long userId, Long revisionId) {
            return (Map<String, Object>) invoke("approveRevision", new Class<?>[]{Long.class, Long.class},
                    userId, revisionId);
        }

        private void rejectRevision(Long userId, Long revisionId) {
            invoke("rejectRevision", new Class<?>[]{Long.class, Long.class}, userId, revisionId);
        }

        private void rejectPatchSet(Long userId, Long patchSetId) {
            invoke("rejectPatchSet", new Class<?>[]{Long.class, Long.class}, userId, patchSetId);
        }

        private SnapshotView findPageSnapshotByTitle(Long userId, String title) {
            Object snapshot = invoke("findPageSnapshotByTitle", new Class<?>[]{Long.class, String.class}, userId, title);
            return snapshot == null ? null : new SnapshotView(snapshot);
        }

        private Object invoke(String name, Class<?>[] parameterTypes, Object... args) {
            try {
                Method method = contract.getMethod(name, parameterTypes);
                return method.invoke(target, args);
            } catch (InvocationTargetException ex) {
                Throwable cause = ex.getCause();
                if (cause instanceof RuntimeException runtimeException) {
                    throw runtimeException;
                }
                throw new IllegalStateException(cause);
            } catch (ReflectiveOperationException ex) {
                throw new IllegalStateException(ex);
            }
        }
    }

    private record SnapshotView(Object delegate) {
        private Long pageId() {
            return (Long) read("pageId");
        }

        private String title() {
            return (String) read("title");
        }

        private String content() {
            return (String) read("content");
        }

        private Integer version() {
            return (Integer) read("version");
        }

        private String stateHash() {
            return (String) read("stateHash");
        }

        private Object read(String accessor) {
            try {
                return delegate.getClass().getMethod(accessor).invoke(delegate);
            } catch (ReflectiveOperationException ex) {
                throw new IllegalStateException(ex);
            }
        }
    }
}
