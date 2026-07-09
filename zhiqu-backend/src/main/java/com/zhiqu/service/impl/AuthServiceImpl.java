package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.LoginRequest;
import com.zhiqu.dto.RegisterRequest;
import com.zhiqu.entity.LoginLog;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.LoginLogMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.security.JwtUtils;
import com.zhiqu.service.AchievementService;
import com.zhiqu.service.AuthService;
import com.zhiqu.service.concurrency.DeadlockRetry;
import com.zhiqu.util.UploadPathResolver;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.Map;

@Service
public class AuthServiceImpl implements AuthService {
    private final SysUserMapper sysUserMapper;
    private final PasswordEncoder passwordEncoder;
    private final JwtUtils jwtUtils;
    private final AchievementService achievementService;
    private final UploadPathResolver uploadPathResolver;
    private final LoginLogMapper loginLogMapper;

    public AuthServiceImpl(SysUserMapper sysUserMapper, PasswordEncoder passwordEncoder, JwtUtils jwtUtils,
                           AchievementService achievementService,
                           UploadPathResolver uploadPathResolver,
                           LoginLogMapper loginLogMapper) {
        this.sysUserMapper = sysUserMapper;
        this.passwordEncoder = passwordEncoder;
        this.jwtUtils = jwtUtils;
        this.achievementService = achievementService;
        this.uploadPathResolver = uploadPathResolver;
        this.loginLogMapper = loginLogMapper;
    }

    @Override
    @Transactional
    @DeadlockRetry
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
        user.setRole("USER");
        user.setTotalStudyMinutes(0);
        user.setConsecutiveDays(0);
        user.setAchievementPoints(0);
        try {
            sysUserMapper.insert(user);
        } catch (DuplicateKeyException e) {
            throw new BusinessException("用户名已存在");
        }

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
        if (user.getStatus() != null && user.getStatus() == 0) {
            throw new BusinessException("账号已被禁用，请联系管理员");
        }
        recordLogin(user.getId());
        achievementService.checkAndUnlock(user.getId(), "login");
        boolean rememberMe = Boolean.TRUE.equals(request.getRememberMe());
        long expiresIn = rememberMe ? jwtUtils.getRememberExpiration() : jwtUtils.getExpiration();
        String token = jwtUtils.generateToken(user.getId(), user.getUsername(), expiresIn);
        return Map.of(
                "id", user.getId(),
                "username", user.getUsername(),
                "nickname", user.getNickname(),
                "role", user.getRole() == null ? "USER" : user.getRole(),
                "token", token,
                "rememberMe", rememberMe,
                "expiresIn", expiresIn
        );
    }

    @Override
    public Map<String, Object> info(Long userId) {
        SysUser user = sysUserMapper.selectById(userId);
        if (user == null) {
            throw new BusinessException("用户不存在");
        }
        String avatar = user.getAvatar();
        if (avatar == null || !uploadPathResolver.publicUploadExists(avatar)) {
            avatar = "";
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("id", user.getId());
        data.put("username", user.getUsername());
        data.put("nickname", user.getNickname() == null ? "" : user.getNickname());
        data.put("role", user.getRole() == null ? "USER" : user.getRole());
        data.put("avatar", avatar);
        data.put("school", user.getSchool() == null ? "" : user.getSchool());
        data.put("major", user.getMajor() == null ? "" : user.getMajor());
        data.put("email", user.getEmail() == null ? "" : user.getEmail());
        data.put("achievementPoints", user.getAchievementPoints() == null ? 0 : user.getAchievementPoints());
        data.put("totalStudyMinutes", user.getTotalStudyMinutes() == null ? 0 : user.getTotalStudyMinutes());
        data.put("consecutiveDays", user.getConsecutiveDays() == null ? 0 : user.getConsecutiveDays());
        return data;
    }

    private void recordLogin(Long userId) {
        try {
            LoginLog log = new LoginLog();
            log.setUserId(userId);
            ServletRequestAttributes attrs = (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
            if (attrs != null) {
                HttpServletRequest req = attrs.getRequest();
                String xff = req.getHeader("X-Forwarded-For");
                log.setIp(xff != null && !xff.isBlank() ? xff.split(",")[0].trim() : req.getRemoteAddr());
                String ua = req.getHeader("User-Agent");
                if (ua != null && ua.length() > 300) {
                    ua = ua.substring(0, 300);
                }
                log.setUserAgent(ua);
            }
            log.setLoginAt(LocalDateTime.now());
            loginLogMapper.insert(log);
        } catch (Exception ignored) {
            // 登录日志失败不影响登录
        }
    }
}
