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
        // 静态文件：浏览器存着，每次先问一句改过没有（Last-Modified；没改过回 304，几十字节）。原来什么都没设，
        // Spring Security 给没有 Cache-Control 的响应一律补 no-store —— 线上服务器只有 1.5 Mbps，每切一个页面都把
        // 160KB 的样式表、170KB 的壳重下一遍（第一百二十轮）。不给 max-age：令牌忘了换，用户也不会拿着旧的。
        // 接口不经过这里，照旧 no-store；/uploads 是用户的文件，不在这里。
        // 每个前缀各指各的目录：「/assets/**」交给目录的是去掉前缀之后的那段（zhiqu-ui.css），指到 static/ 就找不到 ——
        // 第一次就写成了这样，找不到的按业务错误回 200 + 一段 JSON，页面脚本全成了这 55 个字节（压缩那条判据照出来的）
        CacheControl revalidate = CacheControl.noCache().cachePrivate();
        registry.addResourceHandler("/assets/**").addResourceLocations("classpath:/static/assets/").setCacheControl(revalidate);
        registry.addResourceHandler("/vendor/**").addResourceLocations("classpath:/static/vendor/").setCacheControl(revalidate);
        registry.addResourceHandler("/*.html", "/favicon.ico", "/manifest.json").addResourceLocations("classpath:/static/").setCacheControl(revalidate);
        registry.addResourceHandler("/uploads/**")
                .addResourceLocations(uploadPathResolver.resourceLocations());
    }
}
