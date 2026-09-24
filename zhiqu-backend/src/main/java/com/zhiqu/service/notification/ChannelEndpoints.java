package com.zhiqu.service.notification;

import com.zhiqu.common.BusinessException;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestTemplate;

import java.net.URI;
import java.util.Locale;

/**
 * 提醒渠道往外发请求的两条纪律，<b>唯一定义</b>。
 *
 * <h2>发给谁：企业微信 Webhook 只许是企业微信</h2>
 *
 * <p>Webhook 地址是用户自己填的，服务器拿它发 POST，失败原因（里面可能带着对端返回的一段内容）
 * 原样显示在「测试发送」的结果里。不限制的话，任何登录用户填一个
 * {@code http://169.254.169.254/latest/meta-data/} 或 {@code http://127.0.0.1:8001/…}（RAG 边车），
 * 就能让服务器替他去敲内网 —— 和模型 API 地址那个 SSRF 同一个形状。
 * 企业微信群机器人的地址只有一种：{@code https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…}，
 * 所以这里用<b>白名单</b>而不是「拒绝私网地址」：后者要解析 DNS、要防重绑定，前者一个字符串比较就够了。
 * 保存时判（用户当场看到原因），发送时再判一次（库里已经存着的旧值也挡住）。
 *
 * <h2>等多久：连接 5 秒、读 10 秒</h2>
 *
 * <p>原来三个渠道各自 {@code new RestTemplate()} —— 默认<b>没有任何超时</b>。而 {@code @Scheduled}
 * 默认只有一个线程：推送服务器挂住一个连接，早八提醒、每五分钟的到期提醒、RAG 索引 worker
 * 就全停了，而且没有一行日志。POST 不跟随重定向（{@code SimpleClientHttpRequestFactory} 只对 GET 跟随），
 * 所以白名单不会被一个 302 绕过去。
 */
public final class ChannelEndpoints {

    static final int CONNECT_TIMEOUT_MS = 5_000;
    static final int READ_TIMEOUT_MS = 10_000;

    static final String WECOM_HOST = "qyapi.weixin.qq.com";
    static final String WECOM_PATH = "/cgi-bin/webhook/send";

    /** 所有提醒渠道共用的这一个 —— 渠道里不许再 {@code new RestTemplate()}。 */
    static final RestTemplate HTTP = new RestTemplate(timeouts());

    private ChannelEndpoints() {
    }

    private static SimpleClientHttpRequestFactory timeouts() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(CONNECT_TIMEOUT_MS);
        factory.setReadTimeout(READ_TIMEOUT_MS);
        return factory;
    }

    /**
     * 企业微信 Webhook 地址校验：https、主机正好是 {@value #WECOM_HOST}、默认端口、没有 userinfo、
     * 路径是 {@value #WECOM_PATH}。不合格就抛出，理由里写明该长什么样。
     */
    public static String requireWeComWebhook(String url) {
        String reason = weComProblem(url);
        if (reason != null) {
            throw new BusinessException("企业微信 Webhook 地址不对（" + reason + "）。应当是群机器人给的那一条："
                    + "https://" + WECOM_HOST + WECOM_PATH + "?key=…");
        }
        return url.trim();
    }

    private static String weComProblem(String url) {
        if (url == null || url.isBlank()) {
            return "没有填";
        }
        URI uri;
        try {
            uri = URI.create(url.trim());
        } catch (IllegalArgumentException e) {
            return "不是一个合法的网址";
        }
        if (!"https".equalsIgnoreCase(uri.getScheme())) {
            return "必须是 https";
        }
        if (uri.getRawUserInfo() != null) {
            return "不能带用户名";
        }
        if (uri.getHost() == null || !WECOM_HOST.equals(uri.getHost().toLowerCase(Locale.ROOT))) {
            return "只能发往 " + WECOM_HOST;
        }
        if (uri.getPort() != -1 && uri.getPort() != 443) {
            return "不能指定端口";
        }
        if (!WECOM_PATH.equals(uri.getPath())) {
            return "路径应当是 " + WECOM_PATH;
        }
        return null;
    }
}
