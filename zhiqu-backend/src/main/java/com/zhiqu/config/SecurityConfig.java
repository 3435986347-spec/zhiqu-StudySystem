package com.zhiqu.config;

import com.zhiqu.security.JwtAuthenticationFilter;
import jakarta.servlet.DispatcherType;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
public class SecurityConfig {
    private final JwtAuthenticationFilter jwtAuthenticationFilter;

    public SecurityConfig(JwtAuthenticationFilter jwtAuthenticationFilter) {
        this.jwtAuthenticationFilter = jwtAuthenticationFilter;
    }

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
                .csrf(csrf -> csrf.disable())
                .cors(Customizer.withDefaults())
                .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        // SSE(SseEmitter)完成时 Tomcat 以 ASYNC dispatch 重新进入过滤链,无状态部署下
                        // SecurityContext 已不存在:不放行会 AccessDenied 并异常切断响应(缺终止 chunk),
                        // 浏览器 fetch 读取器报 network error。鉴权在初始 REQUEST dispatch 已完成,放行内部重入不削弱安全。
                        .dispatcherTypeMatchers(DispatcherType.ASYNC).permitAll()
                        .requestMatchers(
                                "/api/auth/**",
                                "/api/runtime-issue/client",
                                "/v3/api-docs/**",
                                "/swagger-ui/**",
                                "/uploads/**",
                                "/",
                                "/favicon.ico",
                                "/index.html",
                                "/dashboard.html",
                                "/ai-assistant.html",
                                "/shared-plans.html",
                                "/knowledge-wiki.html",
                                "/admin.html",
                                "/account-admin.html",
                                "/feedback-admin.html",
                                "/shared-plan-admin.html",
                                "/tasks.html",
                                "/routines.html",
                                "/statistics.html",
                                "/achievement.html",
                                "/profile.html",
                                "/manifest.json",
                                "/service-worker.js",
                                "/css/**",
                                "/js/**",
                                "/vendor/**",
                                "/assets/**"
                        ).permitAll()
                        .anyRequest().authenticated()
                )
                .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class)
                .httpBasic(httpBasic -> httpBasic.disable())
                .formLogin(form -> form.disable());
        return http.build();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
