package com.zhiqu.security;

import com.zhiqu.service.workspace.WorkspaceAccess;
import jakarta.servlet.http.HttpServletRequest;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 这个请求是不是这台电脑上的人发的 —— 代码工作区的门（第一百一十五轮）。
 *
 * <p>代码功能开放给所有登录用户之后，这是原来管理员校验替我们挡掉的那一半：注册是开放的，
 * 一个陌生网页用 DNS 重绑定（它的域名解析到 127.0.0.1）就能连上用户电脑上的后端，注册一个账号、登录
 * （真后端上试过，都成功）。绑回环挡不住它：连接确实来自本机。认得出它的只有 {@code Host}，那是它自己的域名。
 *
 * <p>三条都要满足：
 * <ul>
 *   <li>连接来自回环地址；</li>
 *   <li>{@code Host} 是 {@code localhost} / {@code 127.x.x.x} / {@code [::1]}。不认 {@code *.localhost}、
 *       {@code 0.0.0.0}、十进制写法：真正的本机页面用不到它们，放开只多一些要想清楚的情况；</li>
 *   <li>没有反向代理的转发头：服务器上是 Caddy 转给绑在回环上的后端，连接同样来自本机。</li>
 * </ul>
 *
 * <p>读的是请求头的原文，不是 {@code getServerName()}：后者可能被转发头改写过。
 */
public final class LocalRequest {

    private static final Pattern IPV4_LOOPBACK = Pattern.compile("127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}");
    private static final Pattern PORT = Pattern.compile(":\\d{1,5}");

    private LocalRequest() {
    }

    public static boolean isLocal(HttpServletRequest request) {
        return WorkspaceAccess.isLoopback(request.getRemoteAddr())
                && loopbackHost(request.getHeader("Host"))
                && !ClientIpResolver.viaProxy(request);
    }

    static boolean loopbackHost(String header) {
        if (header == null) {
            return false;
        }
        String host = header.trim().toLowerCase(Locale.ROOT);
        if (host.startsWith("[")) {
            int end = host.indexOf(']');
            return end > 0 && host.substring(1, end).equals("::1") && portOrNothing(host.substring(end + 1));
        }
        int colon = host.indexOf(':');
        String name = colon < 0 ? host : host.substring(0, colon);
        return (colon < 0 || portOrNothing(host.substring(colon)))
                && (name.equals("localhost") || IPV4_LOOPBACK.matcher(name).matches());
    }

    private static boolean portOrNothing(String rest) {
        return rest.isEmpty() || PORT.matcher(rest).matches();
    }
}
