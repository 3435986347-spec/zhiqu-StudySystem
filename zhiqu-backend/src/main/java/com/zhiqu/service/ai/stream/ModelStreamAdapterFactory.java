package com.zhiqu.service.ai.stream;

import com.zhiqu.common.BusinessException;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Locale;

@Component
public class ModelStreamAdapterFactory {
    private final List<ModelStreamAdapter> adapters;

    public ModelStreamAdapterFactory(List<ModelStreamAdapter> adapters) {
        this.adapters = adapters;
    }

    public ModelStreamAdapter getAdapter(String providerType) {
        String normalized = providerType == null ? "OPENAI_COMPATIBLE" : providerType.trim().toUpperCase(Locale.ROOT);
        for (ModelStreamAdapter adapter : adapters) {
            if (adapter.supports(normalized)) {
                return adapter;
            }
        }
        throw new BusinessException("不支持的 AI Provider：" + normalized);
    }
}
