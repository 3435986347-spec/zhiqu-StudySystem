package com.zhiqu.security;

import com.zhiqu.common.BusinessException;
import org.springframework.security.core.context.SecurityContextHolder;

public class SecurityUtils {
    private SecurityUtils() {
    }

    public static Long getCurrentUserId() {
        Long userId = getCurrentUserIdOrNull();
        if (userId != null) {
            return userId;
        }
        throw new BusinessException("未登录或登录状态已过期");
    }

    public static Long getCurrentUserIdOrNull() {
        Object principal = SecurityContextHolder.getContext().getAuthentication() == null
                ? null
                : SecurityContextHolder.getContext().getAuthentication().getPrincipal();
        if (principal instanceof Long userId) {
            return userId;
        }
        return null;
    }
}
