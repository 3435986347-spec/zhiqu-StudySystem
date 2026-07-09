package com.zhiqu.service;

public interface AdminGuard {
    void requireAdmin(Long userId);
}
