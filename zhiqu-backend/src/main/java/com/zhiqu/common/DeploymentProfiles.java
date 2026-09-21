package com.zhiqu.common;

import java.util.Locale;
import java.util.Set;

/**
 * 「这是不是生产环境」的<b>唯一判定</b>。
 *
 * <p>原来只有 {@code WorkspaceExecutor} 需要它，所以那个集合就住在它里面。
 * 现在 {@link com.zhiqu.config.StartupSecretGuard} 也要问同一个问题 ——
 * 与其抄一份（抄完两边会分叉：一边认得 {@code "production"}，另一边只认 {@code "prod"}，
 * 而分叉的方向永远是「安全那一侧少认一个」），不如让两个调用方指向同一份。
 *
 * <p>这正是 {@code RETIRED_DECIDERS} 在防的那类事：同一个问题不该有第二个答案。
 */
public final class DeploymentProfiles {

    /** 生产 profile 的名字。 */
    private static final Set<String> PRODUCTION_PROFILES = Set.of("prod", "production");

    /**
     * 逗号分隔的 profile 列表里有没有生产。
     *
     * <p>{@code null} 与空串都返回 false —— 「没配 profile」是开发机上最常见的状态，
     * 把它判成生产会让每一次本地运行都炸。注意这条与
     * {@code WorkspaceAccess.isLoopback} 的取向<b>相反</b>而两者都对：那里「没配」意味着
     * 绑在所有网卡上，是危险的一侧；这里「没配」意味着本地跑，是安全的一侧。
     */
    public static boolean isProduction(String activeProfiles) {
        if (activeProfiles == null || activeProfiles.isBlank()) {
            return false;
        }
        for (String profile : activeProfiles.split(",")) {
            if (PRODUCTION_PROFILES.contains(profile.trim().toLowerCase(Locale.ROOT))) {
                return true;
            }
        }
        return false;
    }

    private DeploymentProfiles() {
    }
}
