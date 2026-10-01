package com.zhiqu.service.harness;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.HarnessDeviceGrant;
import com.zhiqu.mapper.HarnessDeviceGrantMapper;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.time.LocalDateTime;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 命令行的设备码登录 —— 计划里「不在网络上传密码」的那一半。
 *
 * <pre>
 *   命令行 ── start ──▶ 服务器          拿到 deviceCode（只有命令行知道）和 userCode（给人看的 8 位）
 *   用户在已登录的网页里输入 / 打开 userCode，看到「哪台设备、什么时候」之后点「允许」
 *   命令行 ── poll(deviceCode) ──▶ 服务器   允许之后换出一张个人访问令牌，只换一次
 * </pre>
 *
 * <p>几条各挡一件事：
 * <ul>
 *   <li>deviceCode 只存哈希、有 256 位熵 —— 轮询接口不需要登录，它就是凭据。</li>
 *   <li>10 分钟过期 —— 一个没人理的授权不该永远挂着等人误点。</li>
 *   <li>「换出令牌」用 {@code WHERE status='APPROVED'} 的条件更新抢一次 —— 两个并发的轮询只有一个能换到，
 *       不会签出两张令牌。</li>
 *   <li>允许之前先给用户看设备名和来源 IP —— 设备码登录的已知风险是「别人发起、骗你点允许」，
 *       让人看到「这不是我的机器」是唯一的防线。</li>
 * </ul>
 */
@Service
public class DeviceLoginService {

    static final int EXPIRES_SECONDS = 600;
    static final int POLL_INTERVAL_SECONDS = 3;
    /** 去掉了 0/O、1/I/L 这类容易看错的字符。 */
    private static final String USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

    private final HarnessDeviceGrantMapper mapper;
    private final AccessTokenService tokens;
    private final SecureRandom random = new SecureRandom();

    public DeviceLoginService(HarnessDeviceGrantMapper mapper, AccessTokenService tokens) {
        this.mapper = mapper;
        this.tokens = tokens;
    }

    public Map<String, Object> start(String clientName, String clientIp) {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String deviceCode = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        HarnessDeviceGrant grant = new HarnessDeviceGrant();
        grant.setDeviceCodeHash(AccessTokenService.hash(deviceCode));
        grant.setUserCode(uniqueUserCode());
        grant.setClientName(AccessTokenService.cleanName(clientName));
        grant.setClientIp(clientIp);
        grant.setStatus("PENDING");
        grant.setCreatedAt(LocalDateTime.now());
        grant.setExpiresAt(LocalDateTime.now().plusSeconds(EXPIRES_SECONDS));
        mapper.insert(grant);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("deviceCode", deviceCode);
        out.put("userCode", display(grant.getUserCode()));
        out.put("expiresIn", EXPIRES_SECONDS);
        out.put("interval", POLL_INTERVAL_SECONDS);
        // 网页那一侧的入口：个人中心会读这个 hash 自动弹出确认框
        out.put("verifyPath", "/profile.html#harness=" + display(grant.getUserCode()));
        return out;
    }

    private String uniqueUserCode() {
        for (int attempt = 0; attempt < 10; attempt++) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) {
                sb.append(USER_CODE_ALPHABET.charAt(random.nextInt(USER_CODE_ALPHABET.length())));
            }
            String code = sb.toString();
            Long clash = mapper.selectCount(new LambdaQueryWrapper<HarnessDeviceGrant>()
                    .eq(HarnessDeviceGrant::getUserCode, code)
                    .eq(HarnessDeviceGrant::getStatus, "PENDING")
                    .gt(HarnessDeviceGrant::getExpiresAt, LocalDateTime.now()));
            if (clash == null || clash == 0) {
                return code;
            }
        }
        throw new BusinessException("生成设备码失败，请重试");
    }

    static String display(String code) {
        return code.substring(0, 4) + "-" + code.substring(4);
    }

    /** 用户输入的码：去掉横线空格、转大写。 */
    static String normalize(String userCode) {
        return userCode == null ? "" : userCode.replaceAll("[\\s-]", "").toUpperCase(Locale.ROOT);
    }

    private HarnessDeviceGrant pendingByUserCode(String userCode) {
        String code = normalize(userCode);
        if (code.length() != 8) {
            throw new BusinessException("设备码格式不对，应当是 8 位（如 ABCD-EFGH）");
        }
        HarnessDeviceGrant grant = mapper.selectOne(new LambdaQueryWrapper<HarnessDeviceGrant>()
                .eq(HarnessDeviceGrant::getUserCode, code)
                .eq(HarnessDeviceGrant::getStatus, "PENDING")
                .gt(HarnessDeviceGrant::getExpiresAt, LocalDateTime.now())
                .orderByDesc(HarnessDeviceGrant::getId)
                .last("LIMIT 1"));
        if (grant == null) {
            throw new BusinessException("设备码不存在或已过期，请在命令行里重新运行 zhiqu login");
        }
        return grant;
    }

    /** 允许之前给用户看的东西：哪台设备、从哪里、什么时候发起。 */
    public Map<String, Object> describe(String userCode) {
        HarnessDeviceGrant grant = pendingByUserCode(userCode);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("userCode", display(grant.getUserCode()));
        out.put("clientName", grant.getClientName());
        out.put("clientIp", grant.getClientIp());
        out.put("createdAt", grant.getCreatedAt());
        out.put("expiresAt", grant.getExpiresAt());
        return out;
    }

    public void approve(Long userId, String userCode) {
        decide(userId, userCode, "APPROVED");
    }

    public void deny(Long userId, String userCode) {
        decide(userId, userCode, "DENIED");
    }

    private void decide(Long userId, String userCode, String status) {
        HarnessDeviceGrant grant = pendingByUserCode(userCode);
        int n = mapper.update(null, new LambdaUpdateWrapper<HarnessDeviceGrant>()
                .eq(HarnessDeviceGrant::getId, grant.getId())
                .eq(HarnessDeviceGrant::getStatus, "PENDING")
                .set(HarnessDeviceGrant::getStatus, status)
                .set(HarnessDeviceGrant::getUserId, userId));
        if (n != 1) {
            throw new BusinessException("这个设备码刚刚已经被处理过了");
        }
    }

    /**
     * 命令行轮询。返回 {@code status}：PENDING / APPROVED（带 token，只此一次）/ DENIED / EXPIRED。
     * 未知的 deviceCode 也报 EXPIRED —— 不区分「不存在」和「过期」。
     */
    public Map<String, Object> poll(String deviceCode) {
        if (deviceCode == null || deviceCode.isBlank() || deviceCode.length() > 200) {
            return Map.of("status", "EXPIRED");
        }
        HarnessDeviceGrant grant = mapper.selectOne(new LambdaQueryWrapper<HarnessDeviceGrant>()
                .eq(HarnessDeviceGrant::getDeviceCodeHash, AccessTokenService.hash(deviceCode)));
        if (grant == null) {
            return Map.of("status", "EXPIRED");
        }
        switch (grant.getStatus()) {
            case "DENIED":
                return Map.of("status", "DENIED");
            case "CONSUMED":
                // 已经换过一次了：同一个 deviceCode 不能换第二张令牌
                return Map.of("status", "EXPIRED");
            case "APPROVED":
                return exchange(grant);
            default:
                if (grant.getExpiresAt().isBefore(LocalDateTime.now())) {
                    return Map.of("status", "EXPIRED");
                }
                return Map.of("status", "PENDING");
        }
    }

    private Map<String, Object> exchange(HarnessDeviceGrant grant) {
        // 抢一次：只有把 APPROVED 改成 CONSUMED 的那一个请求能签出令牌
        int n = mapper.update(null, new LambdaUpdateWrapper<HarnessDeviceGrant>()
                .eq(HarnessDeviceGrant::getId, grant.getId())
                .eq(HarnessDeviceGrant::getStatus, "APPROVED")
                .set(HarnessDeviceGrant::getStatus, "CONSUMED"));
        if (n != 1) {
            return Map.of("status", "EXPIRED");
        }
        AccessTokenService.Issued issued = tokens.issue(grant.getUserId(), grant.getClientName());
        mapper.update(null, new LambdaUpdateWrapper<HarnessDeviceGrant>()
                .eq(HarnessDeviceGrant::getId, grant.getId())
                .set(HarnessDeviceGrant::getTokenId, issued.row().getId()));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", "APPROVED");
        out.put("token", issued.token());
        out.put("tokenName", issued.row().getName());
        return out;
    }
}
