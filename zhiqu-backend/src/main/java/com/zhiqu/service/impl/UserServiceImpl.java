package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.UpdatePasswordRequest;
import com.zhiqu.dto.UpdateProfileRequest;
import com.zhiqu.entity.LoginLog;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.LoginLogMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.security.JwtUtils;
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
    private final JwtUtils jwtUtils;

    public UserServiceImpl(SysUserMapper sysUserMapper,
                           PasswordEncoder passwordEncoder,
                           UploadPathResolver uploadPathResolver,
                           LoginLogMapper loginLogMapper,
                           JwtUtils jwtUtils) {
        this.sysUserMapper = sysUserMapper;
        this.passwordEncoder = passwordEncoder;
        this.uploadPathResolver = uploadPathResolver;
        this.loginLogMapper = loginLogMapper;
        this.jwtUtils = jwtUtils;
    }

    @Override
    public Map<String, Object> updateProfile(Long userId, UpdateProfileRequest request) {
        SysUser user = mustGetUser(userId);
        user.setNickname(request.getNickname());
        user.setSchool(trimToNull(request.getSchool()));
        user.setMajor(trimToNull(request.getMajor()));
        user.setEmail(trimToNull(request.getEmail()));
        // 只动这几列（见 SysUserMapper.updateProfile）。原来 updateById 跳过 null 字段 ——
        // 把学校、专业、邮箱清空（空串 → null）根本写不进去，旧值一直留着；有版本冲突时还静默 0 行
        if (sysUserMapper.updateProfile(userId, user.getNickname(), user.getSchool(), user.getMajor(), user.getEmail()) != 1) {
            throw new BusinessException("资料没有保存成功，请刷新后重试");
        }
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

    /**
     * 改密码：之前签发的登录令牌（别的设备、被偷走的那张）一并失效，当前这个会话换一张新的、到期时间不变。
     * 见 {@link SysUserMapper#changePassword} 与 V37。
     */
    @Override
    public Map<String, Object> updatePassword(Long userId, UpdatePasswordRequest request, java.util.Date keepExpiresAt) {
        SysUser user = mustGetUser(userId);
        if (!passwordEncoder.matches(request.getOldPassword(), user.getPassword())) {
            throw new BusinessException("旧密码不正确");
        }
        com.zhiqu.common.PasswordRules.requireStorable(request.getNewPassword());
        if (sysUserMapper.changePassword(userId, passwordEncoder.encode(request.getNewPassword())) != 1) {
            throw new BusinessException("密码没有改成，请刷新后重试");
        }
        int epoch = (user.getTokenEpoch() == null ? 0 : user.getTokenEpoch()) + 1;
        java.util.Date expiresAt = keepExpiresAt != null ? keepExpiresAt
                : new java.util.Date(System.currentTimeMillis() + jwtUtils.getExpiration());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("token", jwtUtils.generateToken(userId, user.getUsername(), epoch, expiresAt));
        result.put("expiresAt", expiresAt.getTime());
        return result;
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
            if (sysUserMapper.updateAvatar(userId, avatarUrl) != 1) {
                Files.deleteIfExists(target);
                throw new BusinessException("头像没有保存成功，请刷新后重试");
            }
            deletePreviousAvatar(dir, userId, user.getAvatar(), filename);
            return Map.of("avatar", avatarUrl);
        } catch (IOException e) {
            throw new BusinessException("头像上传失败");
        }
    }

    /**
     * 换了头像，旧的那张删掉。原来每次上传都留下一个文件、永远不删：一个人反复传 5MB 的头像，
     * 按普通接口的限流一分钟能写进将近 1GB。只删「自己的、在头像目录里的」那一张 ——
     * 库里的 avatar 是一个字符串，不能它说删哪个就删哪个。删不掉只记日志：头像已经换好了。
     */
    private void deletePreviousAvatar(Path dir, Long userId, String previousUrl, String currentName) {
        String prefix = "/uploads/avatars/";
        if (previousUrl == null || !previousUrl.startsWith(prefix)) {
            return;
        }
        String name = previousUrl.substring(prefix.length());
        if (name.equals(currentName) || !name.startsWith(userId + "-")) {
            return;
        }
        // 解析、规范化之后必须正好在头像目录里（不是它的子目录、更不是外面）：「7-x/../../别处」这种名字在这里拦住
        Path old = dir.resolve(name).normalize();
        if (!dir.equals(old.getParent())) {
            return;
        }
        try {
            Files.deleteIfExists(old);
        } catch (IOException e) {
            org.slf4j.LoggerFactory.getLogger(UserServiceImpl.class).warn("旧头像没删掉：{}（{}）", old, e.getMessage());
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
