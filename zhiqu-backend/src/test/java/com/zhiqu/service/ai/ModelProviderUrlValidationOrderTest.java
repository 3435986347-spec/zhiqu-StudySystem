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
 * 每条发给模型供应商的出站请求都先校验 HTTP(S) 地址格式。
 * 本机和内网模型允许使用；地址的非空、协议和主机名检查仍要在请求前执行。
 *
 * <p>所以这条判据钉的不是某一处调用，而是<b>一个不变量</b>：
 * 凡是发出站请求的方法，方法体里必须出现校验调用，且校验在请求之前。
 */
class ModelProviderUrlValidationOrderTest {

    private static final List<Path> OUTBOUND_FILES = List.of(
            Path.of("src/main/java/com/zhiqu/service/ai/ModelProviderClient.java"),
            Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java"));

    /** 发出站请求的写法。两种都要认，否则换一种写法就绕过了判据。 */
    private static final List<String> OUTBOUND_CALLS = List.of("postForEntity(", ".exchange(");

    @Test
    void 每个出站请求之前都要先过地址格式校验() throws IOException {
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
                "这些出站请求之前没有 validateProviderRequestUrl，缺失或格式错误的模型地址必须先被拒绝");
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
