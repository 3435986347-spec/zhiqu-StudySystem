package com.zhiqu.service.ai;

import com.zhiqu.common.BusinessException;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 抓网页的 SSRF 防护 —— <b>此前零覆盖</b>。
 *
 * <h2>为什么这个缺口值得单独补</h2>
 *
 * <p>它是本仓库唯一一处「按用户给的 URL 发出站请求」的地方：用户在提问里贴一个链接，
 * 后端就会去抓。没有防护的话，那是一条标准的 SSRF 通道 —— 让服务器替攻击者访问
 * 内网地址、云元数据端点（169.254.169.254）、或本机上只监听 127.0.0.1 的管理接口。
 *
 * <p>它是<b>上一轮做校验闭环时撞出来的</b>：当时需要在集成层造一个「抓取失败」的局面，
 * 唯一的办法是指向一个私网地址，而防护会把整轮打挂。要绕开就得关掉
 * {@code app.ai.web-fetch.block-private-network} —— 而那个开关当时一条判据都没有，
 * 关掉它不会有任何东西红。<b>不为了测 A 去悄悄削弱 B</b>，于是那一侧改走单元判据，
 * 并记下这个缺口。这里把它补上。
 *
 * <h2>两类拒绝的形状不同，必须分开钉</h2>
 *
 * <p>私网/本机地址是<b>解析成功但目标不该访问</b>；无法解析的域名是<b>连目标都确定不了</b>。
 * 两者都必须拒绝，但如果只钉前者，把「解析失败」改成放行（当成普通抓取失败）也不会红 ——
 * 而那正是 DNS rebinding 的入口。
 */
class WebPageFetchSsrfGuardTest {

    /** 与生产默认一致：block-private-network=true。 */
    private static WebPageFetchProvider guarded() {
        return new WebPageFetchProvider(8000, 3500, true);
    }

    private static void assertRefused(String url, String expectedFragment) {
        BusinessException thrown = assertThrows(BusinessException.class, () -> guarded().fetch(url),
                "必须拒绝：" + url);
        assertTrue(String.valueOf(thrown.getMessage()).contains(expectedFragment),
                "拒绝理由应说清是哪一类，实际：" + thrown.getMessage() + "（url=" + url + "）");
    }

    @Test
    void 本机地址一律拒绝() {
        assertRefused("http://localhost:8080/admin", "本机地址");
        assertRefused("http://foo.localhost/x", "本机地址");
        assertRefused("http://127.0.0.1:8080/actuator", "内网地址");
        assertRefused("http://[::1]/x", "内网地址");
    }

    @Test
    void 内网地址一律拒绝() {
        assertRefused("http://10.0.0.5/secret", "内网地址");
        assertRefused("http://192.168.1.1/router", "内网地址");
        assertRefused("http://172.16.0.1/x", "内网地址");
        // 169.254.169.254 是云厂商的实例元数据端点 —— SSRF 最常见的目标，
        // 它是链路本地地址，被 isLinkLocalAddress 拦下
        assertRefused("http://169.254.169.254/latest/meta-data/", "内网地址");
        // 运营商级 NAT（100.64.0.0/10）：不是 RFC1918，isSiteLocalAddress 认不出，
        // 所以代码里有专门的 isCarrierNat。少了它这一条会漏。
        assertRefused("http://100.64.0.1/x", "内网地址");
    }

    @Test
    void 无法解析的域名也要拒绝而不是当成抓取失败() {
        // .invalid 是 RFC 2606 保留后缀，永远解析不出来
        assertRefused("http://never-resolves-zhiqu.invalid/x", "无法解析");
    }

    @Test
    void 非http协议一律拒绝() {
        // file:// 能读本地文件，gopher:// 历史上被用来打内网服务
        assertRefused("file:///etc/passwd", "http/https");
        assertRefused("gopher://127.0.0.1:6379/_FLUSHALL", "http/https");
        assertRefused("ftp://example.com/x", "http/https");
    }

    @Test
    void 缺少域名的链接拒绝() {
        assertRefused("http:///nohost", "缺少域名");
    }

    /**
     * 关掉开关之后私网地址就能抓 —— 这条钉的是「开关真的控制着防护」。
     *
     * <p>没有它，防护可以被写成无视配置的恒真，而上面几条照样全绿；
     * 那样生产环境想临时放开（比如内网部署抓内网文档）就会发现开关是假的。
     */
    @Test
    void 开关关掉时不再拦私网() {
        WebPageFetchProvider open = new WebPageFetchProvider(8000, 3500, false);
        // 端口 9 是 discard 服务，通常无人监听 —— 连不上会走通用异常分支返回 FAILED，
        // 而不是抛 BusinessException。这里要的正是「没有被防护拦住」。
        WebSearchProvider.SearchResult result = open.fetch("http://127.0.0.1:9/x");
        assertEquals("FAILED", result.status(),
                "关掉开关后不该再抛「不允许抓取」，而应正常走抓取流程并失败。实际：" + result);
    }

    /**
     * 公网地址不得被误拦 —— 上面所有拒绝判据的反例。
     *
     * <p>没有它，把 assertPublicHost 写成「一律抛」也能让上面全绿，而抓网页功能整个废掉。
     * 用 example.com（RFC 2606 保留域，解析得出但不保证可连）：这里只断言<b>没有被防护拒绝</b>，
     * 连不连得上不是本判据的事 —— 那取决于跑测试的机器有没有外网。
     */
    @Test
    void 公网地址不得被防护拒绝() {
        WebSearchProvider.SearchResult result = guarded().fetch("http://example.com/");
        assertTrue(result != null && !String.valueOf(result.snippet()).contains("不允许抓取"),
                "公网地址不得被 SSRF 防护拒绝，实际：" + result);
    }
}
