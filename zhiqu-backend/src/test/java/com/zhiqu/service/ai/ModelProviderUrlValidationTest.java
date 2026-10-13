package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;

/** 模型端点可以部署在本机、内网或公网；配置阶段只校验 HTTP(S) 地址的格式。 */
class ModelProviderUrlValidationTest {

    private final ModelProviderClient provider = new ModelProviderClient(
            new ObjectMapper(), mock(SensitiveCryptoService.class), "2023-06-01", "");

    @ParameterizedTest
    @ValueSource(strings = {
            "http://localhost:11434/v1/chat/completions",
            "http://model.localhost:11434/v1/chat/completions",
            "http://127.0.0.1:8080/v1/chat/completions",
            "http://[::1]:11434/v1/chat/completions",
            "http://10.0.0.5:8000/v1/chat/completions",
            "https://172.16.0.5/v1/messages",
            "http://192.168.1.5:8000/v1/chat/completions",
            "http://100.64.0.5:8000/v1/chat/completions",
            "http://[fd00::5]:8000/v1/chat/completions",
            "http://models.corp.invalid/v1/chat/completions",
            "https://api.example.com/v1/chat/completions"
    })
    void acceptsModelEndpointsWithoutResolvingTheirHosts(String url) {
        assertDoesNotThrow(() -> provider.validateProviderRequestUrl(url));
    }

    @Test
    void productionProfileAcceptsPrivateModelEndpointsWithoutAnOptIn() {
        try (var context = new AnnotationConfigApplicationContext()) {
            context.getEnvironment().setActiveProfiles("prod");
            context.registerBean(ObjectMapper.class, () -> new ObjectMapper());
            context.registerBean(SensitiveCryptoService.class, () -> mock(SensitiveCryptoService.class));
            context.register(ModelProviderClient.class);
            context.refresh();
            assertDoesNotThrow(() -> context.getBean(ModelProviderClient.class)
                    .validateProviderRequestUrl("http://10.0.0.5:8000/v1/chat/completions"));
        }
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {
            " ", "not a url", "http://[broken", "/v1/chat/completions",
            "file:///tmp/model", "ftp://model.example.com/v1", "http:///v1/chat/completions",
            "https://"
    })
    void rejectsMissingOrMalformedHttpEndpoints(String url) {
        assertThrows(BusinessException.class, () -> provider.validateProviderRequestUrl(url));
    }
}
