package com.zhiqu.security;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.InetAddress;

@Component
public class ClientIpResolver {
    @Value("${app.proxy.trust-forwarded-headers:false}")
    private boolean trustForwardedHeaders;

    public String resolve(HttpServletRequest request) {
        String remoteAddr = request.getRemoteAddr();
        if (trustForwardedHeaders && isTrustedProxy(remoteAddr)) {
            String forwarded = firstHeaderIp(request.getHeader("X-Forwarded-For"));
            if (forwarded != null) {
                return forwarded;
            }
            String realIp = firstHeaderIp(request.getHeader("X-Real-IP"));
            if (realIp != null) {
                return realIp;
            }
        }
        return remoteAddr;
    }

    private String firstHeaderIp(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        String ip = value.split(",")[0].trim();
        return ip.isBlank() ? null : ip;
    }

    private boolean isTrustedProxy(String remoteAddr) {
        if (remoteAddr == null || remoteAddr.isBlank()) {
            return false;
        }
        try {
            InetAddress address = InetAddress.getByName(remoteAddr);
            return address.isLoopbackAddress() || address.isSiteLocalAddress();
        } catch (Exception ignored) {
            return false;
        }
    }
}
