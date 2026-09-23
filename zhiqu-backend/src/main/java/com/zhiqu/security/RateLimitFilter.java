package com.zhiqu.security;

import com.zhiqu.service.concurrency.RedisRateLimiter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 20)
public class RateLimitFilter extends OncePerRequestFilter {
    private final RedisRateLimiter redisRateLimiter;
    private final ClientIpResolver clientIpResolver;
    /**
     * Redis 挂掉时的降级限流。清理逻辑收在 {@link LocalRateWindows} 里 ——
     * 此前这里是个只增不减的 map，每个来过的 IP 永久占一个条目。
     */
    private final LocalRateWindows localWindows = new LocalRateWindows();

    public RateLimitFilter(RedisRateLimiter redisRateLimiter, ClientIpResolver clientIpResolver) {
        this.redisRateLimiter = redisRateLimiter;
        this.clientIpResolver = clientIpResolver;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String path = request.getRequestURI();
        Limit limit = limitFor(path);
        if (limit != null && !allow(clientIpResolver.resolve(request) + ":" + limit.key, limit.maxRequests, limit.windowMs)) {
            response.setStatus(429);
            response.setCharacterEncoding(StandardCharsets.UTF_8.name());
            response.setContentType("application/json;charset=UTF-8");
            response.getWriter().write("{\"code\":429,\"message\":\"请求过于频繁，请稍后再试\",\"data\":null}");
            return;
        }
        filterChain.doFilter(request, response);
    }

    private Limit limitFor(String path) {
        if (path.equals("/api/auth/login") || path.equals("/api/auth/register")) {
            return new Limit("auth", 12, 60_000);
        }
        if (path.equals("/api/feedback")) {
            return new Limit("feedback", 6, 60_000);
        }
        if (path.equals("/api/runtime-issue/client")) {
            return new Limit("runtime-issue", 10, 60_000);
        }
        // 设备码登录：start 与 poll 不需要登录，按 IP 单独一个桶。轮询间隔 3 秒，一分钟 20 次；
        // 留一点余量，但远小于 180 —— deviceCode 有 256 位熵，挡的不是猜码，是被当成免费的探活接口
        if (path.startsWith("/api/harness/device/")) {
            return new Limit("harness-device", 30, 60_000);
        }
        // 命令行的循环一轮一次模型调用，工具跑得快的时候一分钟二三十轮是正常的 —— 不和网页的 ai 桶挤
        if (path.equals("/api/harness/model/stream")) {
            return new Limit("harness-model", 60, 60_000);
        }
        if (path.startsWith("/api/ai/")) {
            return new Limit("ai", 40, 60_000);
        }
        if (path.startsWith("/api/")) {
            return new Limit("api", 180, 60_000);
        }
        return null;
    }

    private boolean allow(String key, int maxRequests, long windowMs) {
        try {
            return redisRateLimiter.allow(key, maxRequests, windowMs);
        } catch (Exception e) {
            return localWindows.allow(key, maxRequests, windowMs);
        }
    }


    private record Limit(String key, int maxRequests, long windowMs) {
    }
}
