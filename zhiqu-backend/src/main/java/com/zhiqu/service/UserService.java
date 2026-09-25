package com.zhiqu.service;

import com.zhiqu.dto.UpdatePasswordRequest;
import com.zhiqu.dto.UpdateProfileRequest;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

public interface UserService {
    Map<String, Object> updateProfile(Long userId, UpdateProfileRequest request);

    /** 返回当前会话的新令牌（{@code token}、{@code expiresAt}）：改密码之后旧令牌全部作废。 */
    Map<String, Object> updatePassword(Long userId, UpdatePasswordRequest request, java.util.Date keepExpiresAt);

    Map<String, Object> uploadAvatar(Long userId, MultipartFile file);

    List<Map<String, Object>> loginHistory(Long userId, int limit);
}
