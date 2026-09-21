package com.zhiqu.service;

/** 「这个用户是不是管理员」的唯一判定。 */
public interface AdminGuard {

    /** 不是管理员就抛。 */
    void requireAdmin(Long userId);

    /**
     * 是不是管理员 —— 用在需要「分支」而不是「拦截」的地方。
     *
     * <p>刻意由 {@link #requireAdmin} 派生，而不是各实现再写一遍判断：
     * 两份判断迟早分叉，而这里分叉的后果是「拦截时算管理员、分支时不算」
     * 这种谁都想不到的组合。拿异常做控制流不好看，但它保证了两者不可能不一致。
     */
    default boolean isAdmin(Long userId) {
        try {
            requireAdmin(userId);
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }
}
