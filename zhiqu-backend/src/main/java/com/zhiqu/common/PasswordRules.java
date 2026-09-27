package com.zhiqu.common;

import java.nio.charset.StandardCharsets;

/**
 * 设新密码时的规矩 —— 注册、改密码两处共用（管理员重置用的是系统生成的随机密码，不经过这里）。
 *
 * <p>第十一轮暴力测试时实测：这一版 Spring Security（6.3.4）的 BCrypt 对超过 72 字节的密码<b>静默截断</b>——
 * 30 个汉字（90 字节）的密码，拿前 24 个汉字再随便加几个字也能登上。超出的部分算法根本不看，等于没设；
 * 用户还以为自己设了一个很长很安全的密码。所以超过就明确拒绝、说清按字节算。
 * 已经存在的密码不受影响（登录时同样只比前 72 字节，照常能登）。
 */
public final class PasswordRules {

    public static final int MAX_BYTES = 72;

    private PasswordRules() {
    }

    public static void requireStorable(String password) {
        if (password != null && password.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
            throw new BusinessException("密码太长：最多 " + MAX_BYTES + " 字节（英文、数字一个字符 1 字节，汉字一个 3 字节，约 24 个汉字）"
                    + "—— 超出的部分加密算法根本不看，等于没设");
        }
    }
}
