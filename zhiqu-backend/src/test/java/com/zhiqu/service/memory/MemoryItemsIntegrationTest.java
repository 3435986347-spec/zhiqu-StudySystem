package com.zhiqu.service.memory;

import com.zhiqu.common.BusinessException;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 用户记忆逐条（第一百四十三轮，docs/memory-plan.md 第 7 步）的三条验收，在真的 MySQL 上：
 * 旧数据拆进来前后拼回来的全文一样；第 41 条（原来 2000 字的悬崖之外）照样写得进；改过的条目旧的不再出现在提示词里。
 * 另钉两件：旧后端改了那块文本，新后端读的时候对回来；改一条已经被改掉的，整批拒绝。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class MemoryItemsIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_memory_items_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private LongTermMemoryStore store;
    @Autowired private SensitiveCryptoService crypto;

    private Long userId;

    @BeforeEach
    void seedUser() {
        String username = "mem_items_" + UUID.randomUUID().toString().replace("-", "");
        jdbc.update("INSERT INTO sys_user(username, password, nickname, role, deleted) VALUES (?, ?, ?, 'USER', 0)",
                username, "test-password", "Mem Items");
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE username = ?", Long.class, username);
    }

    /** 旧后端那样写：只写那块文本，不碰逐条表。 */
    private void legacyWrite(String text) {
        Integer rows = jdbc.queryForObject("SELECT COUNT(*) FROM user_ai_memory WHERE user_id = ?", Integer.class, userId);
        if (rows == 0) {
            jdbc.update("INSERT INTO user_ai_memory(user_id, encrypted_memory_text, encryption_version) VALUES (?, ?, 'v1')",
                    userId, crypto.encrypt(text));
        } else {
            jdbc.update("UPDATE user_ai_memory SET encrypted_memory_text = ? WHERE user_id = ?", crypto.encrypt(text), userId);
        }
    }

    private String legacyText() {
        String c = jdbc.queryForObject("SELECT encrypted_memory_text FROM user_ai_memory WHERE user_id = ?", String.class, userId);
        return c == null ? "" : crypto.decrypt(c);
    }

    private int activeRows() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM user_ai_memory_item WHERE user_id = ? AND invalidated_at IS NULL",
                Integer.class, userId);
    }

    @Test
    @DisplayName("旧数据：第一次读到时按行拆进来，拼回来的全文和原来一样（空行、重复行按原来的规矩去掉）")
    void 旧数据拆进来前后一样() {
        String old = "- 上午不开会\n- 用 Python 刷题\n\n- 周五写周报";
        legacyWrite(old);
        assertEquals(0, activeRows(), "前置：逐条表里还没有");
        assertEquals(old.replace("\n\n", "\n"), store.read(userId));
        assertEquals(3, activeRows());
        assertEquals(old.replace("\n\n", "\n"), legacyText(), "镜像照逐条重写过一遍，两边一样");
        // 再读一次不再拆（行数不变）
        store.read(userId);
        assertEquals(3, activeRows());
    }

    @Test
    @DisplayName("第 41 条（原来 2000 字的悬崖之外）照样写得进；全文超过 2000 字")
    void 第41条写得进() {
        List<String> forty = new ArrayList<>();
        for (int i = 0; i < 40; i++) forty.add("第 " + i + " 条：" + "记".repeat(45));
        store.appendItems(userId, forty);
        assertTrue(store.read(userId).length() > 2000, "前置：已经过了原来的上限");
        store.appendItems(userId, List.of("第 41 条：新确认的这一条"));
        assertEquals(41, store.items(userId).size());
        assertTrue(store.read(userId).contains("第 41 条：新确认的这一条"));
        assertTrue(legacyText().contains("第 41 条：新确认的这一条"), "旧后端读的那块文本里也有");
    }

    @Test
    @DisplayName("改过的条目：旧的不再出现在全文、读的预算、关键字查里；新的一条接着用旧的置顶")
    void 改过的旧条目不再出现() {
        store.appendItems(userId, List.of("上午不开会", "用 Python 刷题"));
        Long id = store.items(userId).get(0).id();
        jdbc.update("UPDATE user_ai_memory_item SET pinned = 1 WHERE id = ?", id);
        List<String> done = store.apply(userId, List.of(LongTermMemoryStore.Change.update(id, "周三上午不开会")),
                LongTermMemoryStore.SOURCE_CLI);
        assertEquals(List.of("改：上午不开会 → 周三上午不开会"), done);
        String all = store.read(userId);
        assertFalse(all.contains("- 上午不开会"), all);
        assertTrue(all.contains("周三上午不开会"), all);
        assertFalse(store.budgeted(userId, 5000).text().contains("- 上午不开会"));
        assertTrue(store.search(userId, "上午").stream().allMatch(i -> i.plain().equals("周三上午不开会")));
        assertTrue(store.items(userId).stream().filter(i -> i.plain().equals("周三上午不开会")).findFirst().orElseThrow().pinned());
        Long superseded = jdbc.queryForObject("SELECT superseded_by FROM user_ai_memory_item WHERE id = ?", Long.class, id);
        assertTrue(superseded != null && superseded > id, "旧的那条记着被哪条取代");
        // 作废
        Long python = store.items(userId).stream().filter(i -> i.plain().contains("Python")).findFirst().orElseThrow().id();
        store.apply(userId, List.of(LongTermMemoryStore.Change.invalidate(python)), LongTermMemoryStore.SOURCE_WEB);
        assertFalse(store.read(userId).contains("Python"));
    }

    @Test
    @DisplayName("改一条已经被改掉的（同一条草稿确认两次）：整批拒绝，一条都不写")
    void 改已经改掉的整批拒绝() {
        store.appendItems(userId, List.of("上午不开会"));
        Long id = store.items(userId).get(0).id();
        store.apply(userId, List.of(LongTermMemoryStore.Change.update(id, "周三上午不开会")), LongTermMemoryStore.SOURCE_WEB);
        String before = store.read(userId);
        int everBefore = jdbc.queryForObject("SELECT COUNT(*) FROM user_ai_memory_item WHERE user_id = ?", Integer.class, userId);
        BusinessException e = assertThrows(BusinessException.class, () -> store.apply(userId, List.of(
                LongTermMemoryStore.Change.add("这一条不该写进去"),
                LongTermMemoryStore.Change.update(id, "周四上午不开会")), LongTermMemoryStore.SOURCE_WEB));
        assertTrue(e.getMessage().contains("不在了"), e.getMessage());
        // 先数表里一共多少行（连作废的）：只看拼回来的全文不够 —— 镜像对回来的那一步会把多写的那行作废掉，看着一样（扰动照出来的）
        assertEquals(everBefore, (int) jdbc.queryForObject("SELECT COUNT(*) FROM user_ai_memory_item WHERE user_id = ?", Integer.class, userId),
                "整批回滚：加的那条连一行都不该留下");
        assertEquals(before, store.read(userId), "整批回滚：加的那条也没写进去");
    }

    @Test
    @DisplayName("旧后端改了那块文本（删一行、加一行）：新后端读的时候对回逐条 —— 没动的那条还是原来那条")
    void 旧后端改过对回来() {
        store.appendItems(userId, List.of("上午不开会", "用 Python 刷题"));
        Long keep = store.items(userId).get(0).id();
        legacyWrite("- 上午不开会\n- 旧后端加的一条");
        List<LongTermMemoryStore.Item> items = store.items(userId);
        assertEquals(List.of("上午不开会", "旧后端加的一条"), items.stream().map(LongTermMemoryStore.Item::plain).toList());
        assertEquals(keep, items.get(0).id(), "没动的行不重建");
        // 设置里整份保存同理
        store.write(userId, "- 上午不开会\n- 设置里新写的");
        assertEquals(keep, store.items(userId).get(0).id());
        assertEquals("- 上午不开会\n- 设置里新写的", store.read(userId));
        store.clear(userId);
        assertEquals("", store.read(userId));
        assertEquals(0, (int) jdbc.queryForObject("SELECT COUNT(*) FROM user_ai_memory_item WHERE user_id = ?", Integer.class, userId),
                "清空连作废的一起删");
    }
}
