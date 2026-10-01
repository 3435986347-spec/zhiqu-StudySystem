package com.zhiqu.service;

import jakarta.servlet.http.HttpServletRequest;

import java.util.List;
import java.util.Map;

public interface DevicePushService {
    Map<String, Object> register(Long userId, Map<String, Object> body, HttpServletRequest request);

    List<Map<String, Object>> list(Long userId);

    void delete(Long userId, Long id);
}
