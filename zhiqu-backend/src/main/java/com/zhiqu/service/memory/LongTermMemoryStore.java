package com.zhiqu.service.memory;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.UserAiMemory;
import com.zhiqu.entity.UserAiMemoryItem;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.mapper.UserAiMemoryItemMapper;
import com.zhiqu.mapper.UserAiMemoryMapper;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 长期记忆的读写 —— <b>唯一定义</b>。
 *
 * <h2>逐条（第一百四十三轮，docs/memory-plan.md 第 7 步）</h2>
 *
 * <p>原来是 {@code user_ai_memory} 里一块最多 2000 字的文本：只会加不会改（「上午不开会」改成「周三上午不开会」两条都在），
 * 满了拒绝。现在一条一行（{@code user_ai_memory_item}，V49）：改是「建一条新的、旧的标成被它取代」，作废不删，
 * <b>没有总字数上限</b> —— 上限放在读的时候（{@link #budgeted}）。
 *
 * <p><b>那块文本还在，是逐条拼回来的一份镜像</b>：连同一个库的旧后端照样读得到（它只认那一列）。
 * 旧后端改过那块文本（手动保存、确认草稿），新后端下次读的时候发现对不上，就按行对回逐条表
 * （{@link #items}）：多出来的行加成条目，少了的行作废。一个用户第一次被新后端读到时，旧的那块文本也是这样按行拆进来的 ——
 * 迁移里拆不了（密文要主密钥才解得开）。
 *
 * <p>解密兼容两种存法：{@code encrypted_memory_text}（现行）与历史明文 {@code memory_text}（V10 之前的行）。
 */
@Service
public class LongTermMemoryStore {

    /** 一条最多多少字。超过的是一段话不是一条事实，拒绝而不是截断。 */
    public static final int MAX_ITEM_CHARS = 500;
    /** 还在用的条目最多多少条（防滥用；读的时候另有预算）。 */
    public static final int MAX_ACTIVE_ITEMS = 300;
    /** 设置里整份保存时全文的上限（原来 2000；没有了总量的悬崖，这里只挡粘进来一整本书）。 */
    public static final int MAX_MANUAL_CHARS = 30_000;

    public static final String SOURCE_MANUAL = "MANUAL";
    public static final String SOURCE_WEB = "WEB";
    public static final String SOURCE_CLI = "CLI";

    /** 一条还在用的条目（明文）。 */
    public record Item(Long id, String text, String category, String source, boolean pinned,
                       LocalDateTime createdAt, LocalDateTime updatedAt, LocalDateTime lastUsedAt) {
        /** 给人和模型看的那一句：去掉开头的「- 」。 */
        public String plain() {
            return plainOf(text);
        }
    }

    /** 一次改动：加一条、把 #id 改成 text、作废 #id。 */
    public record Change(String op, Long id, String text) {
        public static Change add(String text) { return new Change("add", null, text); }
        public static Change update(Long id, String text) { return new Change("update", id, text); }
        public static Change invalidate(Long id) { return new Change("invalidate", id, null); }
    }

    /** 读预算的结果：放进来的那段文字、放进来几条、一共几条。 */
    public record Budgeted(String text, int included, int total) {}

    private final UserAiMemoryMapper memoryMapper;
    private final UserAiMemoryItemMapper itemMapper;
    private final SysUserMapper userMapper;
    private final SensitiveCryptoService cryptoService;
    private final BusinessClock clock;

    public LongTermMemoryStore(UserAiMemoryMapper memoryMapper, UserAiMemoryItemMapper itemMapper, SysUserMapper userMapper,
                               SensitiveCryptoService cryptoService, BusinessClock clock) {
        this.memoryMapper = memoryMapper;
        this.itemMapper = itemMapper;
        this.userMapper = userMapper;
        this.cryptoService = cryptoService;
        this.clock = clock;
    }

    public UserAiMemory find(Long userId) {
        return memoryMapper.selectOne(
                new LambdaQueryWrapper<UserAiMemory>().eq(UserAiMemory::getUserId, userId));
    }

    public String decrypt(UserAiMemory memory) {
        if (memory == null) {
            return "";
        }
        if (memory.getEncryptedMemoryText() != null && !memory.getEncryptedMemoryText().isBlank()) {
            return cryptoService.decrypt(memory.getEncryptedMemoryText());
        }
        return memory.getMemoryText() == null ? "" : memory.getMemoryText();
    }

    // ── 读 ─────────────────────────────────────────────────────────────────

    /**
     * 还在用的条目，按建的先后。那块文本（旧后端写的）和逐条对不上时先按行对回来（加锁再做一遍，见类注释）。
     */
    @Transactional
    public List<Item> items(Long userId) {
        List<UserAiMemoryItem> rows = itemMapper.selectActive(userId);
        String legacy = normalize(decrypt(find(userId)));
        if (legacy.equals(join(rows))) {
            return toItems(rows);
        }
        userMapper.lockMemoryOwner(userId);
        rows = itemMapper.selectActiveForUpdate(userId);
        legacy = normalize(decrypt(memoryMapper.selectForUpdate(userId)));
        if (!legacy.equals(join(rows))) {
            rows = reconcile(userId, rows, lines(legacy), SOURCE_MANUAL);
            // 镜像也照逐条重写一遍：对回来之后两边一样，下次读不再走这条路
            writeLegacy(userId, join(rows));
        }
        return toItems(rows);
    }

    /** 拼回来的全文（旧接口、旧后端看到的就是它）。没有记忆时是空串，不是 null。 */
    @Transactional
    public String read(Long userId) {
        return items(userId).stream().map(Item::text).reduce((a, b) -> a + "\n" + b).orElse("");
    }

    /**
     * 开工时给模型的那一段：置顶的在前，其余按最近改过 / 用到的排，放到 {@code maxChars} 为止。
     * 放不下的不截半句，整条留在外面，由调用方说「还有 N 条，用 read_memory 查」。排好之后按建的先后列，
     * 同一批条目每次排出来一样（这一段会进前缀，变一个字缓存就重来）。
     */
    @Transactional
    public Budgeted budgeted(Long userId, int maxChars) {
        return budget(items(userId), maxChars);
    }

    static Budgeted budget(List<Item> all, int maxChars) {
        List<Item> ranked = new ArrayList<>(all);
        ranked.sort(Comparator.comparing((Item i) -> !i.pinned())
                .thenComparing(LongTermMemoryStore::recency, Comparator.reverseOrder())
                .thenComparing(Item::id, Comparator.reverseOrder()));
        List<Item> picked = new ArrayList<>();
        int used = 0;
        for (Item item : ranked) {
            int cost = item.plain().length() + 3;
            if (used + cost > maxChars) {
                continue;
            }
            picked.add(item);
            used += cost;
        }
        picked.sort(Comparator.comparing((Item i) -> !i.pinned()).thenComparing(Item::id));
        StringBuilder sb = new StringBuilder();
        for (Item item : picked) {
            if (!sb.isEmpty()) sb.append('\n');
            sb.append("- ").append(item.plain());
        }
        return new Budgeted(sb.toString(), picked.size(), all.size());
    }

    private static LocalDateTime recency(Item i) {
        LocalDateTime a = i.updatedAt() == null ? LocalDateTime.MIN : i.updatedAt();
        LocalDateTime b = i.lastUsedAt() == null ? LocalDateTime.MIN : i.lastUsedAt();
        return a.isAfter(b) ? a : b;
    }

    /** 按关键字找（空格分开的词都要出现，不分大小写）；找到的记一下「最后用到的时间」。 */
    @Transactional
    public List<Item> search(Long userId, String query) {
        List<Item> all = items(userId);
        String q = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        if (q.isEmpty()) {
            return all;
        }
        String[] words = q.split("\\s+");
        List<Item> hits = all.stream().filter(i -> {
            String t = i.plain().toLowerCase(Locale.ROOT);
            for (String w : words) if (!t.contains(w)) return false;
            return true;
        }).toList();
        if (!hits.isEmpty()) {
            itemMapper.touch(userId, hits.stream().map(Item::id).toList(), clock.now());
        }
        return hits;
    }

    // ── 写 ─────────────────────────────────────────────────────────────────

    /**
     * 设置里整份保存：按行和现有条目对一遍 —— 没动的行还是原来那条（时间、来源不变），删掉的行作废，新的行加成条目。
     * 不是全部作废再全部新建：那样每保存一次「最近改过」就全变了。
     */
    @Transactional
    public void write(Long userId, String memoryText) {
        String text = normalize(memoryText);
        if (text.length() > MAX_MANUAL_CHARS) {
            throw new BusinessException("长期记忆太长了：" + text.length() + " 字，上限 " + MAX_MANUAL_CHARS + " 字。");
        }
        userMapper.lockMemoryOwner(userId);
        List<UserAiMemoryItem> rows = itemMapper.selectActiveForUpdate(userId);
        rows = reconcile(userId, rows, lines(text), SOURCE_MANUAL);
        writeLegacy(userId, join(rows));
    }

    /** 草稿确认的老入口：只加。 */
    @Transactional
    public String appendItems(Long userId, List<String> items) {
        List<Change> changes = new ArrayList<>();
        for (String item : items) changes.add(Change.add(item));
        apply(userId, changes, SOURCE_WEB);
        return read(userId);
    }

    /**
     * 加 / 改 / 作废，一起成或一起不成。<b>必须在事务里</b>：读—改—写，先锁用户行
     * （否则两个并发确认各读到同一份旧条目；首次写入时 {@code FOR UPDATE} 锁不住还不存在的行）。
     *
     * <p>改的是已经作废 / 被取代的、或者不是这个人的条目：拒绝并说清楚（多半是同一条草稿确认了两次，
     * 或者那一条在设置里已经删了），一条都不写。
     *
     * @return 每一项实际做了什么（给接口回给用户看）
     */
    @Transactional
    public List<String> apply(Long userId, List<Change> changes, String source) {
        userMapper.lockMemoryOwner(userId);
        // 先把旧后端可能改过的那块文本对回来，再在逐条上改
        List<UserAiMemoryItem> rows = itemMapper.selectActiveForUpdate(userId);
        String legacy = normalize(decrypt(memoryMapper.selectForUpdate(userId)));
        if (!legacy.equals(join(rows))) {
            rows = reconcile(userId, rows, lines(legacy), SOURCE_MANUAL);
        }
        Map<Long, UserAiMemoryItem> byId = new LinkedHashMap<>();
        for (UserAiMemoryItem r : rows) byId.put(r.getId(), r);
        Set<String> present = new LinkedHashSet<>();
        for (UserAiMemoryItem r : rows) present.add(key(plainOf(text(r))));

        List<String> done = new ArrayList<>();
        LocalDateTime now = clock.now();
        int active = rows.size();
        for (Change c : changes) {
            String op = c.op() == null ? "add" : c.op();
            String body = c.text() == null ? "" : clean(c.text());
            switch (op) {
                case "add" -> {
                    if (body.isEmpty() || present.contains(key(body))) {
                        continue;
                    }
                    checkLength(body);
                    if (active >= MAX_ACTIVE_ITEMS) {
                        throw new BusinessException("长期记忆已经有 " + active + " 条（上限 " + MAX_ACTIVE_ITEMS
                                + "）。先到「设置 → 长期记忆」里删掉或合并一些；这几条草稿还留着，一条都没写进去。");
                    }
                    insert(userId, "- " + body, source, now);
                    present.add(key(body));
                    active++;
                    done.add("记下：" + body);
                }
                case "update" -> {
                    UserAiMemoryItem old = c.id() == null ? null : byId.remove(c.id());
                    if (old == null) {
                        throw new BusinessException("要改的那条记忆（#" + c.id() + "）已经不在了 —— 可能在设置里删了、或者已经改过一次。"
                                + "这条草稿一条都没写进去，刷新后再看。");
                    }
                    if (body.isEmpty()) {
                        throw new BusinessException("把 #" + c.id() + " 改成什么没写；要删掉它用「作废」。");
                    }
                    checkLength(body);
                    present.remove(key(plainOf(text(old))));
                    UserAiMemoryItem fresh = insert(userId, "- " + body, source, now, old);
                    if (itemMapper.invalidate(userId, old.getId(), fresh.getId(), now) != 1) {
                        throw new BusinessException("要改的那条记忆（#" + c.id() + "）刚被别处改过，这条草稿一条都没写进去，刷新后再看。");
                    }
                    present.add(key(body));
                    done.add("改：" + plainOf(text(old)) + " → " + body);
                }
                case "invalidate" -> {
                    UserAiMemoryItem old = c.id() == null ? null : byId.remove(c.id());
                    if (old == null || itemMapper.invalidate(userId, old.getId(), null, now) != 1) {
                        throw new BusinessException("要作废的那条记忆（#" + c.id() + "）已经不在了。这条草稿一条都没写进去，刷新后再看。");
                    }
                    present.remove(key(plainOf(text(old))));
                    active--;
                    done.add("不再记：" + plainOf(text(old)));
                }
                default -> throw new BusinessException("不认识的记忆改动：" + op);
            }
        }
        writeLegacy(userId, join(itemMapper.selectActiveForUpdate(userId)));
        return done;
    }

    /** 清空：条目连同作废的一起删（用户要的是「忘掉」），镜像也删。纪元由调用方递增。 */
    @Transactional
    public void clear(Long userId) {
        itemMapper.deleteAllOf(userId);
        UserAiMemory memory = find(userId);
        if (memory != null) {
            memoryMapper.deleteById(memory.getId());
        }
    }

    // ── 内部 ───────────────────────────────────────────────────────────────

    /** 让逐条和 {@code wanted} 这几行一致：留下的不动，没了的作废，多的加上。返回之后还在用的条目（按建的先后）。 */
    private List<UserAiMemoryItem> reconcile(Long userId, List<UserAiMemoryItem> rows, List<String> wanted, String source) {
        LocalDateTime now = clock.now();
        Set<String> want = new LinkedHashSet<>(wanted);
        Set<String> kept = new LinkedHashSet<>();
        List<UserAiMemoryItem> out = new ArrayList<>();
        for (UserAiMemoryItem r : rows) {
            String t = text(r);
            if (want.contains(t) && kept.add(t)) {
                out.add(r);
            } else {
                itemMapper.invalidate(userId, r.getId(), null, now);
            }
        }
        for (String line : want) {
            if (!kept.contains(line)) {
                out.add(insert(userId, line, source, now));
            }
        }
        // 顺序照 wanted（全文拼回来要一样）：老的条目按它在文本里的位置排
        List<String> order = new ArrayList<>(want);
        out.sort(Comparator.comparingInt(r -> order.indexOf(text(r))));
        return out;
    }

    private UserAiMemoryItem insert(Long userId, String text, String source, LocalDateTime now) {
        return insert(userId, text, source, now, null);
    }

    /** {@code replacing} 不是 null 时，新的一条接着用旧的那条的置顶和类别。 */
    private UserAiMemoryItem insert(Long userId, String text, String source, LocalDateTime now, UserAiMemoryItem replacing) {
        UserAiMemoryItem row = new UserAiMemoryItem();
        row.setUserId(userId);
        row.setEncryptedText(cryptoService.encrypt(text));
        row.setSource(source);
        row.setPinned(replacing == null || replacing.getPinned() == null ? 0 : replacing.getPinned());
        row.setCategory(replacing == null ? null : replacing.getCategory());
        row.setCreatedAt(now);
        row.setUpdatedAt(now);
        itemMapper.insert(row);
        return row;
    }

    /** 镜像写回那块文本（只写密文，明文列清空）。 */
    private void writeLegacy(Long userId, String text) {
        String cipher = text.isEmpty() ? null : cryptoService.encrypt(text);
        UserAiMemory memory = memoryMapper.selectForUpdate(userId);
        if (memory == null) {
            if (cipher == null) {
                return;
            }
            memory = new UserAiMemory();
            memory.setUserId(userId);
            memory.setEncryptedMemoryText(cipher);
            memory.setEncryptionVersion("v1");
            memoryMapper.insert(memory);
            return;
        }
        memory.setMemoryText(null);
        memory.setEncryptedMemoryText(cipher);
        memory.setEncryptionVersion("v1");
        memoryMapper.updateById(memory);
    }

    private String text(UserAiMemoryItem r) {
        return cryptoService.decrypt(r.getEncryptedText());
    }

    private String join(List<UserAiMemoryItem> rows) {
        List<String> out = new ArrayList<>();
        for (UserAiMemoryItem r : rows) out.add(text(r));
        return String.join("\n", out);
    }

    private List<Item> toItems(List<UserAiMemoryItem> rows) {
        List<Item> out = new ArrayList<>();
        for (UserAiMemoryItem r : rows) {
            out.add(new Item(r.getId(), text(r), r.getCategory(), r.getSource(), r.getPinned() != null && r.getPinned() != 0,
                    r.getCreatedAt(), r.getUpdatedAt(), r.getLastUsedAt()));
        }
        return out;
    }

    private static void checkLength(String body) {
        if (body.length() > MAX_ITEM_CHARS) {
            throw new BusinessException("这一条太长了（" + body.length() + " 字，一条最多 " + MAX_ITEM_CHARS
                    + " 字）：长期记忆一条记一件事。这条草稿一条都没写进去。");
        }
    }

    /** 一行（去掉首尾空白、去重、去空行）—— 旧的 mergeItems 的规矩，拼回来的全文和原来一样。 */
    static List<String> lines(String text) {
        Set<String> out = new LinkedHashSet<>();
        for (String line : (text == null ? "" : text).split("\\R")) {
            if (!line.isBlank()) out.add(line.strip());
        }
        return new ArrayList<>(out);
    }

    static String normalize(String text) {
        return String.join("\n", lines(text));
    }

    static String plainOf(String line) {
        String s = line == null ? "" : line.strip();
        return s.startsWith("- ") ? s.substring(2).strip() : s.startsWith("-") ? s.substring(1).strip() : s;
    }

    private static String clean(String s) {
        return plainOf(s.replaceAll("\\s+", " "));
    }

    private static String key(String plain) {
        return plain.replaceAll("\\s+", " ").strip().toLowerCase(Locale.ROOT);
    }
}
