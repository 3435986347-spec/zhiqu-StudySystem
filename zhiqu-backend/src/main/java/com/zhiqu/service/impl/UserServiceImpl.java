package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.UpdatePasswordRequest;
import com.zhiqu.dto.UpdateProfileRequest;
import com.zhiqu.entity.LoginLog;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.LoginLogMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.service.UserService;
import com.zhiqu.util.UploadPathResolver;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@Service
public class UserServiceImpl implements UserService {
    private static final long MAX_AVATAR_BYTES = 5 * 1024 * 1024;
    private static final Set<String> ALLOWED_AVATAR_CONTENT_TYPES = Set.of(
            "image/jpeg",
            "image/png",
            "image/webp"
    );

    private final SysUserMapper sysUserMapper;
    private final PasswordEncoder passwordEncoder;
    private final UploadPathResolver uploadPathResolver;
    private final LoginLogMapper loginLogMapper;

    public UserServiceImpl(SysUserMapper sysUserMapper,
                           PasswordEncoder passwordEncoder,
                           UploadPathResolver uploadPathResolver,
                           LoginLogMapper loginLogMapper) {
        this.sysUserMapper = sysUserMapper;
        this.passwordEncoder = passwordEncoder;
        this.uploadPathResolver = uploadPathResolver;
        this.loginLogMapper = loginLogMapper;
    }

    @Override
    public Map<String, Object> updateProfile(Long userId, UpdateProfileRequest request) {
        SysUser user = mustGetUser(userId);
        user.setNickname(request.getNickname());
        user.setSchool(trimToNull(request.getSchool()));
        user.setMajor(trimToNull(request.getMajor()));
        user.setEmail(trimToNull(request.getEmail()));
        sysUserMapper.updateById(user);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("id", user.getId());
        data.put("username", user.getUsername());
        data.put("nickname", user.getNickname());
        data.put("school", user.getSchool() == null ? "" : user.getSchool());
        data.put("major", user.getMajor() == null ? "" : user.getMajor());
        data.put("email", user.getEmail() == null ? "" : user.getEmail());
        return data;
    }

    @Override
    public List<Map<String, Object>> loginHistory(Long userId, int limit) {
        int safeLimit = Math.min(50, Math.max(1, limit));
        List<LoginLog> logs = loginLogMapper.selectList(new LambdaQueryWrapper<LoginLog>()
                .eq(LoginLog::getUserId, userId)
                .orderByDesc(LoginLog::getLoginAt)
                .last("LIMIT " + safeLimit));
        return logs.stream().map(log -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("loginAt", log.getLoginAt());
            row.put("ip", log.getIp() == null ? "" : log.getIp());
            row.put("userAgent", log.getUserAgent() == null ? "" : log.getUserAgent());
            return row;
        }).toList();
    }

    private String trimToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
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
        if (file.getSize() > MAX_AVATAR_BYTES) {
            throw new BusinessException("头像文件不能超过 5MB");
        }
        AvatarImageType imageType = detectAvatarImageType(file);
        String contentType = file.getContentType() == null ? "" : file.getContentType().toLowerCase();
        if (!ALLOWED_AVATAR_CONTENT_TYPES.contains(contentType) || imageType == null || !imageType.matchesContentType(contentType)) {
            throw new BusinessException("头像仅支持 JPG、PNG、WEBP 图片");
        }
        SysUser user = mustGetUser(userId);
        String filename = userId + "-" + UUID.randomUUID() + imageType.extension();

        try {
            Path dir = uploadPathResolver.primaryPath().resolve("avatars").normalize();
            Files.createDirectories(dir);
            Path target = dir.resolve(filename).normalize();
            if (!target.startsWith(dir)) {
                throw new BusinessException("头像上传路径非法");
            }
            Files.copy(file.getInputStream(), target, StandardCopyOption.REPLACE_EXISTING);
            String avatarUrl = "/uploads/avatars/" + filename;
            user.setAvatar(avatarUrl);
            sysUserMapper.updateById(user);
            return Map.of("avatar", avatarUrl);
        } catch (IOException e) {
            throw new BusinessException("头像上传失败");
        }
    }

    private AvatarImageType detectAvatarImageType(MultipartFile file) {
        byte[] header = new byte[12];
        int length;
        try (InputStream inputStream = file.getInputStream()) {
            length = inputStream.read(header);
        } catch (IOException e) {
            throw new BusinessException("头像读取失败");
        }
        if (length >= 3
                && (header[0] & 0xFF) == 0xFF
                && (header[1] & 0xFF) == 0xD8
                && (header[2] & 0xFF) == 0xFF) {
            return AvatarImageType.JPEG;
        }
        if (length >= 8
                && (header[0] & 0xFF) == 0x89
                && header[1] == 0x50
                && header[2] == 0x4E
                && header[3] == 0x47
                && header[4] == 0x0D
                && header[5] == 0x0A
                && header[6] == 0x1A
                && header[7] == 0x0A) {
            return AvatarImageType.PNG;
        }
        if (length >= 12
                && header[0] == 0x52
                && header[1] == 0x49
                && header[2] == 0x46
                && header[3] == 0x46
                && header[8] == 0x57
                && header[9] == 0x45
                && header[10] == 0x42
                && header[11] == 0x50) {
            return AvatarImageType.WEBP;
        }
        return null;
    }

    private enum AvatarImageType {
        JPEG(".jpg"),
        PNG(".png"),
        WEBP(".webp");

        private final String extension;

        AvatarImageType(String extension) {
            this.extension = extension;
        }

        public String extension() {
            return extension;
        }

        public boolean matchesContentType(String contentType) {
            return switch (this) {
                case JPEG -> "image/jpeg".equals(contentType);
                case PNG -> "image/png".equals(contentType);
                case WEBP -> "image/webp".equals(contentType);
            };
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
