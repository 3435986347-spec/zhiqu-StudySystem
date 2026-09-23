package com.zhiqu.service.harness;

/**
 * 哪些路径接受个人访问令牌 —— <b>唯一</b>的判定处。
 *
 * <p>计划里的要求是「只能访问 harness 用的接口」。令牌放在命令行所在的机器上，比网页的登录态更容易泄露
 * （配置文件、同步盘、截图）。所以它的能力要小到泄露了也只是「有人能用你的模型额度、读你的 Wiki」，
 * 而不是「有人能改你的密码、给自己再签一张令牌、撤掉你的撤销」。
 *
 * <p>做法是路径白名单而不是黑名单：令牌只在 {@code /api/harness/} 下被认；管理令牌的接口放在
 * {@code /api/access-tokens/}，结构上就不在它的够得着的范围里 —— 以后有人往 harness 下面加接口，
 * 默认也不会让令牌摸到别处。
 */
public final class HarnessPaths {
    public static final String PREFIX = "/api/harness/";
    /** 设备码登录的两个接口本身不需要登录（命令行此时还没有任何凭据）。 */
    public static final String DEVICE_PREFIX = "/api/harness/device/";

    private HarnessPaths() {
    }

    /**
     * @param path 去掉 context path 之后的请求路径（{@code request.getRequestURI()} 减 {@code getContextPath()}）
     */
    public static boolean acceptsAccessToken(String path) {
        return path != null && path.startsWith(PREFIX) && !path.startsWith(DEVICE_PREFIX)
                // Spring Security 的 StrictHttpFirewall 已经拒了这些，这里再挡一次：判定不依赖别处的配置
                && !path.contains("..") && !path.contains(";") && !path.contains("%") && !path.contains("//");
    }
}
