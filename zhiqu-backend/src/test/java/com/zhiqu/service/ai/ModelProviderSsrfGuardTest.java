package com.zhiqu.service.ai;

import com.zhiqu.SourceText;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 每一条打给模型供应商的出站请求，之前都必须先过 SSRF 校验。
 *
 * <h2>它挡的是什么</h2>
 *
 * <p>模型的 API URL 是<b>用户自己填的</b>。不校验的话，他可以填
 * {@code http://169.254.169.254/latest/meta-data/} —— 那是云厂商的元数据地址，
 * 服务器替他请求一次就能把实例凭证读出来，而返回内容会原样显示在「测试连接」的结果里。
 * 内网的任何 HTTP 服务同理。{@code validateProviderRequestUrl} 就是拦这个的，
 * 只有显式打开 {@code app.ai.allow-private-provider-url}（本地接假模型时）才放行。
 *
 * <h2>为什么这条判据是在重构之后补的</h2>
 *
 * <p>2026-09-21 把「怎么跟模型供应商说话」那一层从 {@code AiServiceImpl} 抽成
 * {@code ModelProviderClient}，搬走了 18 个成员、改了 60 多个调用点。
 * 这种机械搬运最容易悄悄弄丢的就是这类<b>前置校验</b>：少一行 {@code validate...}，
 * 功能完全正常，只是多了一个 SSRF 口子，而且没有任何症状。
 *
 * <p>所以这条判据钉的不是某一处调用，而是<b>一个不变量</b>：
 * 凡是发出站请求的方法，方法体里必须出现校验调用，且校验在请求之前。
 */
class ModelProviderSsrfGuardTest {

    private static final List<Path> OUTBOUND_FILES = List.of(
            Path.of("src/main/java/com/zhiqu/service/ai/ModelProviderClient.java"),
            Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java"));

    /** 发出站请求的写法。两种都要认，否则换一种写法就绕过了判据。 */
    private static final List<String> OUTBOUND_CALLS = List.of("postForEntity(", ".exchange(");

    @Test
    void 每个出站请求之前都要先过SSRF校验() throws IOException {
        List<String> offenders = new ArrayList<>();
        int checked = 0;

        for (Path file : OUTBOUND_FILES) {
            String code = SourceText.stripComments(Files.readString(file, StandardCharsets.UTF_8));
            for (String call : OUTBOUND_CALLS) {
                int from = 0;
                while (true) {
                    int at = code.indexOf(call, from);
                    if (at < 0) {
                        break;
                    }
                    from = at + call.length();
                    checked++;
                    // 往上找到这个方法的开头，再看这一段里有没有校验
                    int methodStart = methodStartBefore(code, at);
                    String before = code.substring(methodStart, at);
                    if (!before.contains("validateProviderRequestUrl(")) {
                        // 报方法名而不是行号：这里的 code 已经剥过注释，行号映射不回源文件，
                        // 报出来只会让人去看错的地方。方法名是稳定的，也更好找。
                        offenders.add(file.getFileName() + " → " + methodNameAt(code, methodStartBefore(code, at)));
                    }
                }
            }
        }

        // 下限：一条出站请求都没扫到的话，上面那个循环是空转，而空转和干净长得一样
        assertTrue(checked >= 6,
                "只扫到 " + checked + " 处出站请求 —— 少于预期，多半是写法变了而判据没跟上，"
                        + "这时候的绿是「什么都没看到」");

        assertEquals(List.of(), offenders,
                "这些出站请求之前没有 validateProviderRequestUrl。模型 API URL 是用户填的，"
                        + "不校验就等于让服务器替他请求任意内网地址（例如云元数据），"
                        + "而返回内容会显示在「测试连接」的结果里。少一行校验没有任何症状");
    }

    /** 方法签名里的方法名，用于报错定位。 */
    private static String methodNameAt(String code, int methodStart) {
        int paren = code.indexOf('(', methodStart);
        if (paren < 0) {
            return "(未知方法)";
        }
        String signature = code.substring(methodStart, paren);
        int space = signature.lastIndexOf(' ');
        return space < 0 ? signature.trim() : signature.substring(space + 1).trim();
    }

    /** 从 {@code at} 往上找最近一个方法签名的起点。找不到就退回文件开头。 */
    private static int methodStartBefore(String code, int at) {
        int best = 0;
        for (String marker : new String[]{"    private ", "    public ", "    protected "}) {
            int found = code.lastIndexOf(marker, at);
            if (found > best) {
                best = found;
            }
        }
        return best;
    }
}
