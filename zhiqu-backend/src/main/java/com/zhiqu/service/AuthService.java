package com.zhiqu.service;

import com.zhiqu.dto.LoginRequest;
import com.zhiqu.dto.RegisterRequest;

import java.util.Map;

public interface AuthService {
    Map<String, Object> register(RegisterRequest request);

    Map<String, Object> login(LoginRequest request);

    Map<String, Object> info(Long userId);
}
