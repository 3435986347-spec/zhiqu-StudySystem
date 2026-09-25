package com.zhiqu.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.Date;

@Component
public class JwtUtils {
    @Value("${jwt.secret}")
    private String secret;

    @Value("${jwt.expiration}")
    private long expiration;

    @Value("${jwt.remember-expiration:2592000000}")
    private long rememberExpiration;

    /** 令牌里的「纪元」声明：签发时用户的 {@code token_epoch}。改密码后纪元 +1，旧令牌对不上就失效。 */
    public static final String EPOCH_CLAIM = "te";

    /*
     * 签发令牌必须给出纪元 —— 不留一个不带纪元的重载：那样的令牌按 0 算，
     * 改过一次密码的人拿它就登不上，而签发处看不出哪里错了。
     */
    public String generateToken(Long userId, String username, int epoch, long ttlMillis) {
        return generateToken(userId, username, epoch, new Date(System.currentTimeMillis() + ttlMillis));
    }

    /** 到期时间照给定的来：改完密码给当前会话换一张新令牌时，保持原来那张的到期时间（记住我 / 不记住）。 */
    public String generateToken(Long userId, String username, int epoch, Date expiresAt) {
        return Jwts.builder()
                .subject(String.valueOf(userId))
                .claim("username", username)
                .claim(EPOCH_CLAIM, epoch)
                .issuedAt(new Date())
                .expiration(expiresAt)
                .signWith(getSecretKey())
                .compact();
    }

    /** 令牌里的纪元；上线前签发的旧令牌没有这个声明，按 0 算。 */
    public static int epochOf(Claims claims) {
        Object value = claims.get(EPOCH_CLAIM);
        return value instanceof Number n ? n.intValue() : 0;
    }

    public Claims parseToken(String token) {
        return Jwts.parser()
                .verifyWith(getSecretKey())
                .build()
                .parseSignedClaims(token)
                .getPayload();
    }

    public long getExpiration() {
        return expiration;
    }

    public long getRememberExpiration() {
        return rememberExpiration;
    }

    private SecretKey getSecretKey() {
        return Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
    }
}
