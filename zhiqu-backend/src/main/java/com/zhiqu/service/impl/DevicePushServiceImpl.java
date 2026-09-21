package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.DevicePushToken;
import com.zhiqu.mapper.DevicePushTokenMapper;
import com.zhiqu.service.DevicePushService;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class DevicePushServiceImpl implements DevicePushService {
    private final DevicePushTokenMapper tokenMapper;
    private final SensitiveCryptoService cryptoService;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public DevicePushServiceImpl(DevicePushTokenMapper tokenMapper, SensitiveCryptoService cryptoService) {
        this.tokenMapper = tokenMapper;
        this.cryptoService = cryptoService;
    }

    @Override
    @Transactional
    public Map<String, Object> register(Long userId, Map<String, Object> body, HttpServletRequest request) {
        String endpoint = value(body.get("endpoint"), null);
        if (endpoint == null) {
            throw new BusinessException("缺少设备推送 endpoint");
        }
        String endpointHash = cryptoService.sha256Hex(endpoint);
        DevicePushToken token = tokenMapper.selectOne(new LambdaQueryWrapper<DevicePushToken>()
                .eq(DevicePushToken::getUserId, userId)
                .eq(DevicePushToken::getEndpointHash, endpointHash));
        if (token == null) {
            token = new DevicePushToken();
            token.setUserId(userId);
            token.setEndpointHash(endpointHash);
        }
        try {
            token.setEncryptedToken(cryptoService.encrypt(objectMapper.writeValueAsString(body)));
        } catch (Exception e) {
            throw new BusinessException("设备信息保存失败");
        }
        token.setDeviceType(value(body.get("deviceType"), "PWA").toUpperCase());
        token.setPermissionStatus(value(body.get("permissionStatus"), "UNKNOWN").toUpperCase());
        token.setUserAgent(limit(request.getHeader("User-Agent"), 500));
        token.setLastActiveAt(LocalDateTime.now());
        token.setEncryptionVersion("v1");
        if (token.getId() == null) {
            tokenMapper.insert(token);
        } else {
            tokenMapper.updateById(token);
        }
        return row(tokenMapper.selectById(token.getId()));
    }

    @Override
    public List<Map<String, Object>> list(Long userId) {
        return tokenMapper.selectList(new LambdaQueryWrapper<DevicePushToken>()
                .eq(DevicePushToken::getUserId, userId)
                .orderByDesc(DevicePushToken::getLastActiveAt))
                .stream().map(this::row).toList();
    }

    @Override
    @Transactional
    public void delete(Long userId, Long id) {
        DevicePushToken token = tokenMapper.selectOne(new LambdaQueryWrapper<DevicePushToken>()
                .eq(DevicePushToken::getId, id)
                .eq(DevicePushToken::getUserId, userId));
        if (token != null) {
            tokenMapper.deleteById(token.getId());
        }
    }

    private Map<String, Object> row(DevicePushToken token) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", token.getId());
        row.put("deviceType", token.getDeviceType());
        row.put("permissionStatus", token.getPermissionStatus());
        row.put("endpointHash", token.getEndpointHash());
        row.put("userAgent", token.getUserAgent());
        row.put("lastActiveAt", token.getLastActiveAt());
        row.put("createdAt", token.getCreatedAt());
        return row;
    }

    private String value(Object value, String fallback) {
        if (value == null || value.toString().trim().isBlank()) {
            return fallback;
        }
        return value.toString().trim();
    }

    private String limit(String value, int max) {
        if (value == null) {
            return null;
        }
        return value.length() <= max ? value : value.substring(0, max);
    }
}
