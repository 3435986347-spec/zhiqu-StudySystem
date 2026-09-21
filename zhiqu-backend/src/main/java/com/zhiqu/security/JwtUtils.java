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

    public String generateToken(Long userId, String username) {
        return generateToken(userId, username, expiration);
    }

    public String generateToken(Long userId, String username, long ttlMillis) {
        Date now = new Date();
        Date exp = new Date(now.getTime() + ttlMillis);
        return Jwts.builder()
                .subject(String.valueOf(userId))
                .claim("username", username)
                .issuedAt(now)
                .expiration(exp)
                .signWith(getSecretKey())
                .compact();
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
