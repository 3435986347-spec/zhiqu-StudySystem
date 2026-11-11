package com.zhiqu.service.harness;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.UserAccessToken;
import com.zhiqu.mapper.UserAccessTokenMapper;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 个人访问令牌：签发、认证、列出、撤销。
 *
 * <p>令牌长这样：{@code zqp_} + 32 字节随机数的 base64url。库里只存 SHA-256 —— 令牌本身有 256 位熵，
 * 不需要 bcrypt 那种慢哈希（慢哈希是给「人会挑弱口令」准备的）；库被拖走也拿不到一张可用的令牌。
 * 明文只在签发那一刻出现一次。
 *
 * <p>前缀 {@code zqp_} 让过滤器一眼分出「这是令牌不是 JWT」，也让密钥扫描器认得出它。
 */
@Service
public class AccessTokenService {

    public static final String PREFIX = "zqp_";
    public static final String SCOPE_HARNESS = "HARNESS";
    /**
     * 桌面版本机代码助手的令牌（第一百二十九轮，docs/desktop-remote-plan.md 第 2 步）：页面用网页的登录态换一张，交给外壳起的宿主去连模型网关。
     * 只在本机代码要的那几个接口被认（{@link HarnessPaths#allowsScope}），12 小时过期 —— 外壳只放在内存里，应用开着的一天里够用，过期了页面再签。
     */
    public static final String SCOPE_DESKTOP_CODE = "DESKTOP_CODE";
    public static final Duration DESKTOP_CODE_TTL = Duration.ofHours(12);
    static final String DESKTOP_CODE_NAME = "桌面版 · 本机代码";
    /** 最近使用时间最多隔这么久写一次库 —— 否则命令行的每一个请求都是一次 UPDATE。 */
    static final long TOUCH_INTERVAL_MS = 5 * 60_000L;

    private final UserAccessTokenMapper mapper;
    private final SecureRandom random = new SecureRandom();
    private final Map<Long, Long> lastTouched = new ConcurrentHashMap<>();

    public AccessTokenService(UserAccessTokenMapper mapper) {
        this.mapper = mapper;
    }

    public record Issued(UserAccessToken row, String token) {
    }

    public static boolean looksLikeAccessToken(String token) {
        return token != null && token.startsWith(PREFIX);
    }

    public static String hash(String token) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public Issued issue(Long userId, String name) {
        return issue(userId, name, SCOPE_HARNESS, null);
    }

    /** 桌面版本机代码用的那一种：范围小、会过期（见 {@link #SCOPE_DESKTOP_CODE}） */
    public Issued issueDesktopCode(Long userId) {
        return issue(userId, DESKTOP_CODE_NAME, SCOPE_DESKTOP_CODE, LocalDateTime.now().plus(DESKTOP_CODE_TTL));
    }

    private Issued issue(Long userId, String name, String scope, LocalDateTime expiresAt) {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String token = PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        UserAccessToken row = new UserAccessToken();
        row.setUserId(userId);
        row.setName(cleanName(name));
        row.setTokenHash(hash(token));
        row.setTokenHint(token.substring(token.length() - 4));
        row.setScope(scope);
        row.setExpiresAt(expiresAt);
        row.setCreatedAt(LocalDateTime.now());
        mapper.insert(row);
        return new Issued(row, token);
    }

    static String cleanName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\p{Cntrl}]", " ").trim();
        if (n.isEmpty()) {
            n = "命令行";
        }
        return n.length() > 100 ? n.substring(0, 100) : n;
    }

    /**
     * 认证一张令牌。不认识、撤销了、过期了都返回 {@code null} —— 三种情况对调用方是同一个意思，
     * 分开报会告诉猜令牌的人「这张曾经存在过」。
     */
    public UserAccessToken authenticate(String token, String ip) {
        if (!looksLikeAccessToken(token) || token.length() > 200) {
            return null;
        }
        UserAccessToken row = mapper.selectOne(new LambdaQueryWrapper<UserAccessToken>()
                .eq(UserAccessToken::getTokenHash, hash(token)));
        if (!usable(row, LocalDateTime.now())) {
            return null;
        }
        touch(row, ip);
        return row;
    }

    /** 能不能用：存在、没撤销、没过期。纯函数，判据直接喂。 */
    static boolean usable(UserAccessToken row, LocalDateTime now) {
        return row != null
                && row.getRevokedAt() == null
                && (row.getExpiresAt() == null || row.getExpiresAt().isAfter(now));
    }

    private void touch(UserAccessToken row, String ip) {
        long now = System.currentTimeMillis();
        Long last = lastTouched.get(row.getId());
        if (last != null && now - last < TOUCH_INTERVAL_MS) {
            return;
        }
        lastTouched.put(row.getId(), now);
        mapper.update(null, new LambdaUpdateWrapper<UserAccessToken>()
                .eq(UserAccessToken::getId, row.getId())
                .set(UserAccessToken::getLastUsedAt, LocalDateTime.now())
                .set(UserAccessToken::getLastUsedIp, ip == null ? null : ip.length() > 64 ? ip.substring(0, 64) : ip));
    }

    public List<Map<String, Object>> list(Long userId) {
        List<Map<String, Object>> rows = new ArrayList<>();
        LocalDateTime now = LocalDateTime.now();
        // 过期的不列（第一百二十九轮）：桌面版每开一次应用签一张 12 小时的，列着的话设置里一天多几行用不了的
        for (UserAccessToken t : mapper.selectList(new LambdaQueryWrapper<UserAccessToken>()
                .eq(UserAccessToken::getUserId, userId)
                .isNull(UserAccessToken::getRevokedAt)
                .and(w -> w.isNull(UserAccessToken::getExpiresAt).or().gt(UserAccessToken::getExpiresAt, now))
                .orderByDesc(UserAccessToken::getId))) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", t.getId());
            row.put("name", t.getName());
            // 只给末 4 位：够在列表里认出是哪一张，拿去也用不了
            row.put("hint", "zqp_…" + t.getTokenHint());
            row.put("createdAt", t.getCreatedAt());
            row.put("lastUsedAt", t.getLastUsedAt());
            row.put("lastUsedIp", t.getLastUsedIp());
            row.put("expiresAt", t.getExpiresAt());
            row.put("scope", t.getScope());
            rows.add(row);
        }
        return rows;
    }

    /** 撤销。按「id + 本人」更新 —— 别人的令牌 id 撤不动，也不告诉你它存不存在。 */
    public void revoke(Long userId, Long id) {
        int n = mapper.update(null, new LambdaUpdateWrapper<UserAccessToken>()
                .eq(UserAccessToken::getId, id)
                .eq(UserAccessToken::getUserId, userId)
                .isNull(UserAccessToken::getRevokedAt)
                .set(UserAccessToken::getRevokedAt, LocalDateTime.now()));
        if (n != 1) {
            throw new BusinessException("令牌不存在或已撤销");
        }
        lastTouched.remove(id);
    }
}
