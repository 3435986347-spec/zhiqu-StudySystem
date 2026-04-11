package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.LoginRequest;
import com.zhiqu.dto.RegisterRequest;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.security.JwtUtils;
import com.zhiqu.service.AchievementService;
import com.zhiqu.service.AuthService;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.util.Map;

@Service
public class AuthServiceImpl implements AuthService {
    private final SysUserMapper sysUserMapper;
    private final PasswordEncoder passwordEncoder;
    private final JwtUtils jwtUtils;
    private final AchievementService achievementService;

    public AuthServiceImpl(SysUserMapper sysUserMapper, PasswordEncoder passwordEncoder, JwtUtils jwtUtils,
                           AchievementService achievementService) {
        this.sysUserMapper = sysUserMapper;
        this.passwordEncoder = passwordEncoder;
        this.jwtUtils = jwtUtils;
        this.achievementService = achievementService;
    }

    @Override
    public Map<String, Object> register(RegisterRequest request) {
        if (!request.getPassword().equals(request.getConfirmPassword())) {
            throw new BusinessException("两次密码输入不一致");
        }
        SysUser exists = sysUserMapper.selectOne(new LambdaQueryWrapper<SysUser>()
                .eq(SysUser::getUsername, request.getUsername()));
        if (exists != null) {
            throw new BusinessException("用户名已存在");
        }

        SysUser user = new SysUser();
        user.setUsername(request.getUsername());
        user.setPassword(passwordEncoder.encode(request.getPassword()));
        user.setNickname(request.getUsername());
        user.setTotalStudyMinutes(0);
        user.setConsecutiveDays(0);
        user.setAchievementPoints(0);
        sysUserMapper.insert(user);

        String token = jwtUtils.generateToken(user.getId(), user.getUsername());
        return Map.of("id", user.getId(), "username", user.getUsername(), "token", token);
    }

    @Override
    public Map<String, Object> login(LoginRequest request) {
        SysUser user = sysUserMapper.selectOne(new LambdaQueryWrapper<SysUser>()
                .eq(SysUser::getUsername, request.getUsername()));
        if (user == null || !passwordEncoder.matches(request.getPassword(), user.getPassword())) {
            throw new BusinessException("用户名或密码错误");
        }
        achievementService.checkAndUnlock(user.getId(), "login");
        String token = jwtUtils.generateToken(user.getId(), user.getUsername());
        return Map.of("id", user.getId(), "username", user.getUsername(), "nickname", user.getNickname(), "token", token);
    }

    @Override
    public Map<String, Object> info(Long userId) {
        SysUser user = sysUserMapper.selectById(userId);
        if (user == null) {
            throw new BusinessException("用户不存在");
        }
        return Map.of(
                "id", user.getId(),
                "username", user.getUsername(),
                "nickname", user.getNickname() == null ? "" : user.getNickname(),
                "avatar", user.getAvatar() == null ? "" : user.getAvatar(),
                "achievementPoints", user.getAchievementPoints() == null ? 0 : user.getAchievementPoints(),
                "totalStudyMinutes", user.getTotalStudyMinutes() == null ? 0 : user.getTotalStudyMinutes(),
                "consecutiveDays", user.getConsecutiveDays() == null ? 0 : user.getConsecutiveDays()
        );
    }
}
