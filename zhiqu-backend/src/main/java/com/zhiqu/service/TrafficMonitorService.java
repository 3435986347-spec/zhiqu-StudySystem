package com.zhiqu.service;

import jakarta.servlet.http.HttpServletRequest;

import java.util.Map;

public interface TrafficMonitorService {
    void record(HttpServletRequest request, int status, long durationMs);

    Map<String, Object> snapshot();
}
