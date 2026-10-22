package com.zhiqu.service.impl;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.mapper.AiModelConfigMapper;
import com.zhiqu.service.ai.ModelProviderClient;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;

import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 模型设置的保存路径允许内网模型和 Ollama 的默认本机地址，无需数据库或 Docker。 */
class AiModelPrivateUrlTest {

    private static final long USER_ID = 42L;
    private static final long MODEL_ID = 7L;
    private final AiModelConfigMapper mapper = mock(AiModelConfigMapper.class);
    private final AtomicReference<AiModelConfig> saved = new AtomicReference<>();
    private AiServiceImpl service;

    @BeforeEach
    void setUp() {
        SensitiveCryptoService crypto = mock(SensitiveCryptoService.class);
        ModelProviderClient provider = new ModelProviderClient(
                new ObjectMapper(), crypto, "2023-06-01", "");
        // 保存模型只使用 mapper、provider、crypto；其余业务依赖不参与这条路径。
        service = new AiServiceImpl(
                null, mapper, null, null, null, null, null, null, null,
                null, null, null, null, null, null, null, null, null, null,
                provider, null, crypto, null, null, mock(PlatformTransactionManager.class),
                false, "", "OPENAI_COMPATIBLE", "https://example.invalid/v1/chat/completions",
                "test-model", "", "2023-06-01", "", false,
                null, null, null, null, null, null);
        when(mapper.insert(any(AiModelConfig.class))).thenAnswer(invocation -> {
            AiModelConfig model = invocation.getArgument(0);
            model.setId(MODEL_ID);
            saved.set(model);
            return 1;
        });
        when(mapper.selectById(MODEL_ID)).thenAnswer(invocation -> saved.get());
    }

    @Test
    @DisplayName("用户模型的私网地址可以保存并补齐协议路径")
    void savePrivateModelUrl() {
        Map<String, Object> row = assertDoesNotThrow(() -> service.saveModel(USER_ID, null, Map.of(
                "providerType", "OPENAI_COMPATIBLE",
                "apiUrl", " http://10.24.8.6:8000/v1/ ",
                "modelName", "internal-model",
                "apiKey", "test-key",
                "isDefault", false)));

        assertSaved(row, "http://10.24.8.6:8000/v1/chat/completions", "OPENAI_COMPATIBLE");
    }

    @Test
    @DisplayName("Ollama 不填接口地址时，可以保存默认的 localhost 地址")
    void saveDefaultOllamaUrl() {
        Map<String, Object> row = assertDoesNotThrow(() -> service.saveModel(USER_ID, null, Map.of(
                "providerType", "OLLAMA",
                "modelName", "local-model",
                "isDefault", false)));

        assertSaved(row, "http://localhost:11434/v1/chat/completions", "OLLAMA");
    }

    private void assertSaved(Map<String, Object> row, String expectedUrl, String providerType) {
        AiModelConfig model = saved.get();
        assertEquals(expectedUrl, model.getApiUrl());
        assertEquals(expectedUrl, row.get("apiUrl"));
        assertEquals(USER_ID, model.getUserId());
        assertEquals("USER", model.getOwnerType());
        assertEquals("USER", row.get("ownerType"));
        assertEquals(providerType, row.get("providerType"));
        assertEquals(MODEL_ID, row.get("id"));
        verify(mapper).insert(model);
    }
}
