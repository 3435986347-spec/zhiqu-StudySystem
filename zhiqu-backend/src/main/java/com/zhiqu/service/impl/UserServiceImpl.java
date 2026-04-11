package com.zhiqu.service.impl;

import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.UpdatePasswordRequest;
import com.zhiqu.dto.UpdateProfileRequest;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.service.UserService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.Map;
import java.util.UUID;

@Service
public class UserServiceImpl implements UserService {
    private final SysUserMapper sysUserMapper;
    private final PasswordEncoder passwordEncoder;

    @Value("${app.upload-dir:uploads}")
    private String uploadDir;

    public UserServiceImpl(SysUserMapper sysUserMapper, PasswordEncoder passwordEncoder) {
        this.sysUserMapper = sysUserMapper;
        this.passwordEncoder = passwordEncoder;
    }

    @Override
    public Map<String, Object> updateProfile(Long userId, UpdateProfileRequest request) {
        SysUser user = mustGetUser(userId);
        user.setNickname(request.getNickname());
        sysUserMapper.updateById(user);
        return Map.of("id", user.getId(), "username", user.getUsername(), "nickname", user.getNickname());
    }

    @Override
    public void updatePassword(Long userId, UpdatePasswordRequest request) {
        SysUser user = mustGetUser(userId);
        if (!passwordEncoder.matches(request.getOldPassword(), user.getPassword())) {
            throw new BusinessException("旧密码不正确");
        }
        user.setPassword(passwordEncoder.encode(request.getNewPassword()));
        sysUserMapper.updateById(user);
    }

    @Override
    public Map<String, Object> uploadAvatar(Long userId, MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new BusinessException("请选择头像文件");
        }
        SysUser user = mustGetUser(userId);
        String original = file.getOriginalFilename() == null ? "avatar.png" : file.getOriginalFilename();
        String ext = original.contains(".") ? original.substring(original.lastIndexOf(".")) : ".png";
        String filename = userId + "-" + UUID.randomUUID() + ext;

        try {
            Path dir = Paths.get(uploadDir);
            Files.createDirectories(dir);
            Path target = dir.resolve(filename);
            Files.copy(file.getInputStream(), target, StandardCopyOption.REPLACE_EXISTING);
            String avatarUrl = "/uploads/" + filename;
            user.setAvatar(avatarUrl);
            sysUserMapper.updateById(user);
            return Map.of("avatar", avatarUrl);
        } catch (IOException e) {
            throw new BusinessException("头像上传失败");
        }
    }

    private SysUser mustGetUser(Long userId) {
        SysUser user = sysUserMapper.selectById(userId);
        if (user == null) {
            throw new BusinessException("用户不存在");
        }
        return user;
    }
}
