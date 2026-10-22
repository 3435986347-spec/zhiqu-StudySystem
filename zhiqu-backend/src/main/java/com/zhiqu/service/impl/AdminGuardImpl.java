package com.zhiqu.service.impl;

import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.service.AdminGuard;
import org.springframework.stereotype.Service;

@Service
public class AdminGuardImpl implements AdminGuard {
    private final SysUserMapper userMapper;

    public AdminGuardImpl(SysUserMapper userMapper) {
        this.userMapper = userMapper;
    }

    @Override
    public void requireAdmin(Long userId) {
        SysUser user = userMapper.selectById(userId);
        if (user == null || !"ADMIN".equalsIgnoreCase(user.getRole())) {
            throw new BusinessException("无权访问监管后台");
        }
    }
}
