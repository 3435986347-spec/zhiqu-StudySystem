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
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.concurrent.ConcurrentHashMap;
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 20)
public class RateLimitFilter extends OncePerRequestFilter {
    private final RedisRateLimiter redisRateLimiter;
    private final ClientIpResolver clientIpResolver;
    private final ConcurrentHashMap<String, Deque<Long>> localWindows = new ConcurrentHashMap<>();

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
            return allowLocalFallback(key, maxRequests, windowMs);
        }
    }

    private boolean allowLocalFallback(String key, int maxRequests, long windowMs) {
        long now = System.currentTimeMillis();
        Deque<Long> window = localWindows.computeIfAbsent(key, ignored -> new ArrayDeque<>());
        synchronized (window) {
            while (!window.isEmpty() && now - window.peekFirst() > windowMs) {
                window.pollFirst();
            }
            if (window.size() >= maxRequests) {
                return false;
            }
            window.addLast(now);
            return true;
        }
    }

    private record Limit(String key, int maxRequests, long windowMs) {
    }
}
