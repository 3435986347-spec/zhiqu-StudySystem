package com.zhiqu.service.privacy;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.UserAiConfig;
import com.zhiqu.entity.UserAiMemory;
import com.zhiqu.mapper.AiModelConfigMapper;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.UserAiConfigMapper;
import com.zhiqu.mapper.UserAiMemoryMapper;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

@Component
public class PrivacyDataMigrationRunner implements ApplicationRunner {
    private static final String PLACEHOLDER_TITLE = "[encrypted]";

    private final UserAiConfigMapper legacyConfigMapper;
    private final AiModelConfigMapper modelConfigMapper;
    private final UserAiMemoryMapper memoryMapper;
    private final StudyTaskMapper taskMapper;
    private final SensitiveCryptoService cryptoService;

    public PrivacyDataMigrationRunner(UserAiConfigMapper legacyConfigMapper,
                                      AiModelConfigMapper modelConfigMapper,
                                      UserAiMemoryMapper memoryMapper,
                                      StudyTaskMapper taskMapper,
                                      SensitiveCryptoService cryptoService) {
        this.legacyConfigMapper = legacyConfigMapper;
        this.modelConfigMapper = modelConfigMapper;
        this.memoryMapper = memoryMapper;
        this.taskMapper = taskMapper;
        this.cryptoService = cryptoService;
    }

    @Override
    public void run(ApplicationArguments args) {
        migrateLegacyAiKeys();
        migrateLegacyMemory();
        migrateLegacyTasks();
    }

    private void migrateLegacyAiKeys() {
        for (UserAiConfig legacy : legacyConfigMapper.selectList(new LambdaQueryWrapper<UserAiConfig>()
                .isNotNull(UserAiConfig::getApiKey))) {
            if (legacy.getApiKey() == null || legacy.getApiKey().isBlank()) {
                continue;
            }
            Long existing = modelConfigMapper.selectCount(new LambdaQueryWrapper<AiModelConfig>()
                    .eq(AiModelConfig::getUserId, legacy.getUserId())
                    .eq(AiModelConfig::getOwnerType, "USER"));
            if (existing == null || existing == 0) {
                AiModelConfig model = new AiModelConfig();
                model.setUserId(legacy.getUserId());
                model.setOwnerType("USER");
                model.setProviderType(inferProviderType(legacy.getApiUrl()));
                model.setDisplayName((legacy.getModelName() == null ? "迁移模型" : legacy.getModelName()) + "（我的）");
                model.setApiUrl(normalizeApiUrl(legacy.getApiUrl(), model.getProviderType()));
                model.setEncryptedApiKey(cryptoService.encrypt(legacy.getApiKey()));
                model.setModelName(legacy.getModelName() == null || legacy.getModelName().isBlank() ? "gpt-4o-mini" : legacy.getModelName());
                model.setCapabilities("TEXT,VISION");
                model.setEnabled(1);
                model.setIsDefault(1);
                model.setUsedToday(0);
                model.setEncryptionVersion("v1");
                modelConfigMapper.insert(model);
            }
            legacy.setApiKey(null);
            legacyConfigMapper.updateById(legacy);
        }
    }

    private void migrateLegacyMemory() {
        for (UserAiMemory memory : memoryMapper.selectList(new LambdaQueryWrapper<UserAiMemory>()
                .isNotNull(UserAiMemory::getMemoryText)
                .isNull(UserAiMemory::getEncryptedMemoryText))) {
            if (memory.getMemoryText() == null || memory.getMemoryText().isBlank()) {
                continue;
            }
            memory.setEncryptedMemoryText(cryptoService.encrypt(memory.getMemoryText()));
            memory.setEncryptionVersion("v1");
            memory.setMemoryText(null);
            memoryMapper.updateById(memory);
        }
    }

    private void migrateLegacyTasks() {
        for (StudyTask task : taskMapper.selectList(new LambdaQueryWrapper<StudyTask>()
                .isNull(StudyTask::getEncryptedTitle))) {
            if (task.getTitle() == null || task.getTitle().isBlank() || PLACEHOLDER_TITLE.equals(task.getTitle())) {
                continue;
            }
            task.setEncryptedTitle(cryptoService.encrypt(task.getTitle()));
            if (task.getDescription() != null && !task.getDescription().isBlank()) {
                task.setEncryptedDescription(cryptoService.encrypt(task.getDescription()));
            }
            task.setTitle(PLACEHOLDER_TITLE);
            task.setDescription(null);
            task.setEncryptionVersion("v1");
            taskMapper.updateById(task);
        }
    }

    private String inferProviderType(String apiUrl) {
        String url = apiUrl == null ? "" : apiUrl.toLowerCase();
        if (url.contains("anthropic.com")) {
            return "ANTHROPIC";
        }
        if (url.contains("11434") || url.contains("ollama")) {
            return "OLLAMA";
        }
        return "OPENAI_COMPATIBLE";
    }

    private String normalizeApiUrl(String apiUrl, String providerType) {
        if (apiUrl == null || apiUrl.isBlank()) {
            return "ANTHROPIC".equals(providerType)
                    ? "https://api.anthropic.com/v1/messages"
                    : "https://api.openai.com/v1/chat/completions";
        }
        return apiUrl.trim();
    }
}
