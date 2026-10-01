package com.zhiqu.service.ai.stream;

import java.util.function.Consumer;

public interface ModelStreamAdapter {
    boolean supports(String providerType);

    ModelStreamResult stream(ModelStreamRequest request, Consumer<NormalizedStreamEvent> sink);
}
