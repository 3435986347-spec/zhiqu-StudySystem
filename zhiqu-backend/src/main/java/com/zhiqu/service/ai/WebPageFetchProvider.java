package com.zhiqu.service.ai;

import com.zhiqu.common.BusinessException;
import org.jsoup.Connection;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.InetAddress;
import java.net.URI;
import java.time.LocalDateTime;
import java.util.Locale;

@Service
public class WebPageFetchProvider {
    private static final int MAX_REDIRECTS = 3;

    private final int timeoutMs;
    private final int maxContentChars;
    private final boolean blockPrivateNetwork;

    public WebPageFetchProvider(@Value("${app.ai.web-fetch.timeout-ms:8000}") int timeoutMs,
                                @Value("${app.ai.web-fetch.max-content-chars:3500}") int maxContentChars,
                                @Value("${app.ai.web-fetch.block-private-network:true}") boolean blockPrivateNetwork) {
        this.timeoutMs = Math.max(2000, Math.min(timeoutMs, 20000));
        this.maxContentChars = Math.max(800, Math.min(maxContentChars, 12000));
        this.blockPrivateNetwork = blockPrivateNetwork;
    }

    public WebSearchProvider.SearchResult fetch(String url) {
        String normalized = normalizeUrl(url);
        try {
            Connection.Response response = fetchResponse(normalized);
            normalized = response.url() == null ? normalized : response.url().toString();
            String contentType = response.contentType() == null ? "" : response.contentType().toLowerCase(Locale.ROOT);
            String title;
            String text;
            if (contentType.contains("html") || response.body().contains("<html")) {
                Document document = response.parse();
                document.select("script,style,noscript,svg,canvas,nav,header,footer,aside,form,iframe").remove();
                title = clean(document.title());
                Element article = document.selectFirst("article, main, [role=main], .content, #content");
                text = clean((article == null ? document.body() : article).text());
            } else {
                title = normalized;
                text = clean(response.body());
            }
            if (title.isBlank()) {
                title = normalized;
            }
            if (text.isBlank()) {
                return new WebSearchProvider.SearchResult(title, normalized, "网页正文为空或无法提取。", "WEB_FETCH", "EMPTY");
            }
            return new WebSearchProvider.SearchResult(title, normalized, limit(text, maxContentChars), "WEB_FETCH", "OK");
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            return new WebSearchProvider.SearchResult(normalized, normalized, "抓取失败：" + safeMessage(e), "WEB_FETCH", "FAILED");
        }
    }

    private Connection.Response fetchResponse(String initialUrl) throws Exception {
        String current = initialUrl;
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            Connection.Response response = Jsoup.connect(current)
                    .userAgent("ZhiquResearchBot/1.0")
                    .timeout(timeoutMs)
                    .maxBodySize(1024 * 1024)
                    .followRedirects(false)
                    .ignoreContentType(true)
                    .execute();
            int statusCode = response.statusCode();
            String location = response.header("Location");
            if (statusCode >= 300 && statusCode < 400 && location != null && !location.isBlank()) {
                if (redirect == MAX_REDIRECTS) {
                    throw new BusinessException("网页跳转次数过多");
                }
                current = normalizeUrl(URI.create(current).resolve(location.trim()).toString());
                continue;
            }
            return response;
        }
        throw new BusinessException("网页跳转次数过多");
    }

    private String normalizeUrl(String raw) {
        String value = raw == null ? "" : raw.trim();
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) {
                throw new BusinessException("只支持 http/https 网页链接");
            }
            String host = uri.getHost();
            if (host == null || host.isBlank()) {
                throw new BusinessException("网页链接缺少域名");
            }
            if (blockPrivateNetwork) {
                assertPublicHost(host);
            }
            return uri.toString();
        } catch (IllegalArgumentException e) {
            throw new BusinessException("网页链接格式不正确");
        }
    }

    private void assertPublicHost(String host) {
        String lower = host.toLowerCase(Locale.ROOT);
        if ("localhost".equals(lower) || lower.endsWith(".localhost")) {
            throw new BusinessException("不允许抓取本机地址");
        }
        try {
            for (InetAddress address : InetAddress.getAllByName(host)) {
                if (address.isAnyLocalAddress()
                        || address.isLoopbackAddress()
                        || address.isLinkLocalAddress()
                        || address.isSiteLocalAddress()
                        || address.isMulticastAddress()
                        || isCarrierNat(address)) {
                    throw new BusinessException("不允许抓取内网地址");
                }
            }
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw new BusinessException("无法解析网页域名");
        }
    }

    private boolean isCarrierNat(InetAddress address) {
        byte[] bytes = address.getAddress();
        return bytes.length == 4
                && (bytes[0] & 0xFF) == 100
                && (bytes[1] & 0xC0) == 64;
    }

    private String clean(String value) {
        return value == null ? "" : value.replaceAll("\\s+", " ").trim();
    }

    private String limit(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max) + "...";
    }

    private String safeMessage(Exception e) {
        String message = e.getMessage();
        return message == null || message.isBlank() ? e.getClass().getSimpleName() : limit(message, 180);
    }
}
