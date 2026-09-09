package com.zhiqu.service.memory;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.UserAiMemory;
import com.zhiqu.mapper.UserAiMemoryMapper;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 长期记忆（{@code user_ai_memory}）的读写 —— <b>唯一定义</b>。
 *
 * <p>提出来是因为记忆现在有两个写入方：用户手动保存（{@code AiServiceImpl.saveMemory}）
 * 与记忆草稿确认（{@code AiWorkspaceServiceImpl.confirmArtifact}）。让第二个写入方自己
 * 拿 mapper 和 crypto 再拼一遍加密/兜底逻辑，就是这一轮反复在消灭的那个物种。
 *
 * <p>解密要兼容两种存法：{@code encrypted_memory_text}（现行）与历史明文 {@code memory_text}
 * （V10 隐私迁移之前的行）。写入一律只写密文并把明文列清空。
 */
@Service
public class LongTermMemoryStore {

    /** 记忆全文上限。写入方各自截断会漂，统一在这里。 */
    public static final int MAX_LENGTH = 2000;

    private final UserAiMemoryMapper memoryMapper;
    private final SensitiveCryptoService cryptoService;

    public LongTermMemoryStore(UserAiMemoryMapper memoryMapper, SensitiveCryptoService cryptoService) {
        this.memoryMapper = memoryMapper;
        this.cryptoService = cryptoService;
    }

    public UserAiMemory find(Long userId) {
        return memoryMapper.selectOne(
                new LambdaQueryWrapper<UserAiMemory>().eq(UserAiMemory::getUserId, userId));
    }

    /** 读出明文；没有记忆时返回空串，不返回 null。 */
    public String read(Long userId) {
        return decrypt(find(userId));
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

    /** 整份覆盖写入。 */
    public void write(Long userId, String memoryText) {
        String trimmed = memoryText == null ? "" : memoryText.trim();
        String cipher = trimmed.isEmpty() ? null : cryptoService.encrypt(limit(trimmed));
        UserAiMemory memory = find(userId);
        if (memory == null) {
            memory = new UserAiMemory();
            memory.setUserId(userId);
            memory.setMemoryText(null);
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

    /**
     * 把用户勾选的记忆条目并进现有自由文本，返回合并后的全文。
     *
     * <p>按<b>整行</b>去重：草稿条目常常是「上一轮已经记过的那句」原样再来一遍，
     * 逐条勾选的界面挡不住这种重复（用户看不出哪条是旧的）。去重放在这里而不是界面上。
     */
    public String appendItems(Long userId, List<String> items) {
        Set<String> lines = new LinkedHashSet<>();
        for (String line : read(userId).split("\\R")) {
            if (!line.isBlank()) {
                lines.add(line.strip());
            }
        }
        List<String> added = new ArrayList<>();
        for (String item : items) {
            if (item == null || item.isBlank()) {
                continue;
            }
            String line = item.strip().startsWith("-") ? item.strip() : "- " + item.strip();
            if (lines.add(line)) {
                added.add(line);
            }
        }
        String merged = limit(String.join("\n", lines));
        if (!added.isEmpty()) {
            write(userId, merged);
        }
        return merged;
    }

    private String limit(String value) {
        return value.length() <= MAX_LENGTH ? value : value.substring(0, MAX_LENGTH);
    }
}
