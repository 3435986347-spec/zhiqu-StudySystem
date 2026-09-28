package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 网页请求的超时与重试、聊天流的心跳帧与空闲超时 —— 行为判据跑在 node 上，直接加载发布的 zhiqu-api.js。
 * 判据本体：src/test/resources/js/request-check.js。
 */
class RequestResilienceTest {

    @Test
    @DisplayName("请求：GET 安全重试、写操作只在 429 重试、超时、非 JSON 说人话；SSE 心跳帧与空闲超时")
    void 请求与流() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/request-check.js"), NodeRunner.API_JS);
    }

    @Test
    @DisplayName("写操作都经过 request()：「同一个写请求没回来前不重发」住在那里，直接 fetch 的写操作会绕开它（只许聊天流，它有自己的发送中保护）")
    void 写操作不绕过request() throws Exception {
        Path root = Path.of("src/main/resources/static");
        List<Path> files = new ArrayList<>(List.of(root.resolve("assets/zhiqu-api.js"), root.resolve("assets/zhiqu-ui.js")));
        try (Stream<Path> html = Files.list(root)) {
            html.filter(p -> p.toString().endsWith(".html")).forEach(files::add);
        }
        Pattern call = Pattern.compile("fetch\\(([^;]{0,400})");
        Pattern write = Pattern.compile("method\\s*:\\s*['\"](POST|PUT|DELETE|PATCH)['\"]");
        int seen = 0;
        List<String> bypass = new ArrayList<>();
        for (Path f : files) {
            String code = com.zhiqu.SourceText.stripComments(Files.readString(f));
            Matcher m = call.matcher(code);
            while (m.find()) {
                seen++;
                String args = m.group(1);
                if (write.matcher(args).find() && !args.contains("'/ai/chat/stream'")) {
                    bypass.add(f.getFileName() + "：fetch(" + args.substring(0, Math.min(120, args.length())));
                }
            }
        }
        assertTrue(seen >= 4, "只扫到 " + seen + " 处 fetch —— 扫空了？（request 自己、导出、下载、聊天流至少 4 处）");
        assertTrue(bypass.isEmpty(), "这些写操作直接调 fetch，绕开了 request() 的「同一个写请求没回来前不重发」：\n" + String.join("\n", bypass));
    }
}
