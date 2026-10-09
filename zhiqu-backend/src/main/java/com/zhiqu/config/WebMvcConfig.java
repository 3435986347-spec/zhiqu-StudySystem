package com.zhiqu.config;

import com.zhiqu.util.UploadPathResolver;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.CacheControl;
import org.springframework.lang.NonNull;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebMvcConfig implements WebMvcConfigurer {
    private final UploadPathResolver uploadPathResolver;

    public WebMvcConfig(UploadPathResolver uploadPathResolver) {
        this.uploadPathResolver = uploadPathResolver;
    }

    @Override
    public void addResourceHandlers(@NonNull ResourceHandlerRegistry registry) {
        registry.addResourceHandler("/service-worker.js")
                .addResourceLocations("classpath:/static/service-worker.js")
                .setCacheControl(CacheControl.noCache());
        registry.addResourceHandler("/uploads/**")
                .addResourceLocations(uploadPathResolver.resourceLocations());
    }
}
