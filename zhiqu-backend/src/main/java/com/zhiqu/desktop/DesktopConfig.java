package com.zhiqu.desktop;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

/**
 * 桌面形态的装配。<b>只在 {@code desktop} profile 下生效</b>，所以服务器部署里这些 bean
 * 根本不存在。
 */
@Configuration
@Profile("desktop")
public class DesktopConfig {

    /**
     * {@code @ConditionalOnMissingBean} 是给判据留的口子：测试里换一个记录用的假实现，
     * 就不会真的在跑测试的机器上弹出浏览器窗口。
     */
    @Bean
    @ConditionalOnMissingBean(BrowserOpener.class)
    public BrowserOpener browserOpener() {
        return new BrowserOpener.Platform();
    }
}
