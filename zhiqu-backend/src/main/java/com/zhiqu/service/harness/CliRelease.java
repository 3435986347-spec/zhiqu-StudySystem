package com.zhiqu.service.harness;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.InputStream;

/**
 * 命令行的版本号只有一个出处：{@code zhiqu-cli/package.json}（打进 JAR 的那一份，pom 的 bundle-zhiqu-cli）。
 *
 * <p>第一百二十六轮：{@code /api/harness/meta} 的 cliLatest 原来写死在 {@code @Value} 的默认值里（0.1.0）。
 * 第一百二十三轮加了子 agent、没有发 npm 新版，也没人记得改服务器上的这个数 —— 用户装的 0.1.0 里根本没有
 * {@code subagents.js}，问它「能起子 agent 吗」只会说不能，而且永远收不到「有新版本」的提示。
 * 现在服务器说的最新版本就是它打包时带着的那份命令行的版本：发版改 package.json，部署就跟上。
 * 版本号只在发布到 npm 时改（先发 npm、再部署），不然旧版会被提示去装一个 npm 上还没有的版本。
 */
public final class CliRelease {

    private static final String RESOURCE = "zhiqu-cli/package.json";
    private static volatile String cached;

    private CliRelease() {
    }

    /** 打进来的那份命令行的版本；读不到（不该发生：pom 每次都打进去）就是 null，meta 里不说最新版本，不误导。 */
    public static String bundledVersion() {
        String v = cached;
        if (v != null) return v.isEmpty() ? null : v;
        String read = read();
        cached = read == null ? "" : read;
        return read;
    }

    private static String read() {
        ClassLoader loader = CliRelease.class.getClassLoader();
        try (InputStream in = loader.getResourceAsStream(RESOURCE)) {
            if (in == null) return null;
            JsonNode version = new ObjectMapper().readTree(in).get("version");
            return version == null || !version.isTextual() || version.asText().isBlank() ? null : version.asText().trim();
        } catch (Exception e) {
            return null;
        }
    }
}
