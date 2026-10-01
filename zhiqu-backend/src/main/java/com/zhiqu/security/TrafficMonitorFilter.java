package com.zhiqu.security;

import com.zhiqu.service.TrafficMonitorService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

@Component
public class TrafficMonitorFilter extends OncePerRequestFilter {
    private final TrafficMonitorService trafficMonitorService;

    public TrafficMonitorFilter(TrafficMonitorService trafficMonitorService) {
        this.trafficMonitorService = trafficMonitorService;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        long start = System.currentTimeMillis();
        try {
            filterChain.doFilter(request, response);
        } finally {
            trafficMonitorService.record(request, response.getStatus(), System.currentTimeMillis() - start);
        }
    }
}
