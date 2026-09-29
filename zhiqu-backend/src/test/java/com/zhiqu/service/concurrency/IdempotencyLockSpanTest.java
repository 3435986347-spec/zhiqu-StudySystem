package com.zhiqu.service.concurrency;

import com.zhiqu.NodeRunner;
import com.zhiqu.service.AiWorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 幂等锁要比「那一次」可能还在执行的时间长（第二十二轮）。
 *
 * <p>页面在超时（30 秒）之后用同一个键自动重来。锁原来也是 30 秒 —— 一次做了 31 秒的写，超时后重来的那一下正好碰上锁到期，
 * 和还没做完的那一次同时执行，写两遍。锁只在进程没了时靠 TTL 过期（正常都在 finally 里放掉），所以长一点只有那一种代价。
 * 结果留多久同理，见 {@code 结果留得够久}。
 */
class IdempotencyLockSpanTest {

    private static long number(String js, String regex) {
        Matcher m = Pattern.compile(regex).matcher(js);
        assertTrue(m.find(), "zhiqu-api.js 里找不到 " + regex);
        return Long.parseLong(m.group(1));
    }

    @Test
    @DisplayName("锁比页面一整轮自动重来（每次都等满超时）长，也比服务器上最长的一次写（代码工作区一整轮）长")
    void 锁够长() throws Exception {
        String js = Files.readString(NodeRunner.API_JS);
        long timeout = number(js, "var REQUEST_TIMEOUT_MS = (\\d+);");
        Matcher w = Pattern.compile("var RETRY_WAITS_MS = \\[([\\d, ]+)\\];").matcher(js);
        assertTrue(w.find(), "zhiqu-api.js 里找不到 RETRY_WAITS_MS");
        long[] waits = Arrays.stream(w.group(1).split(",")).mapToLong(s -> Long.parseLong(s.trim())).toArray();
        long pageSpan = timeout * (waits.length + 1) + Arrays.stream(waits).sum();
        long lock = IdempotencyService.LOCK_TTL.toMillis();
        assertTrue(lock > pageSpan, "锁 " + lock + "ms 不比页面自动重来的一整轮 " + pageSpan + "ms 长");
        assertTrue(lock > AiWorkspaceService.STREAM_TIMEOUT_MS, "锁 " + lock + "ms 不比最长的一次写 " + AiWorkspaceService.STREAM_TIMEOUT_MS + "ms 长");
    }

    /** 「10 * 60 * 1000」「60_000」这样写的常量。 */
    private static long constant(String text, String regex) {
        Matcher m = Pattern.compile(regex).matcher(text);
        assertTrue(m.find(), "找不到 " + regex);
        long v = 1;
        for (String part : m.group(1).split("\\*")) {
            v *= Long.parseLong(part.trim().replace("_", ""));
        }
        return v;
    }

    private static long[] list(String text, String regex) {
        Matcher m = Pattern.compile(regex).matcher(text);
        assertTrue(m.find(), "找不到 " + regex);
        return Arrays.stream(m.group(1).split(",")).mapToLong(s -> Long.parseLong(s.trim().replace("_", ""))).toArray();
    }

    @Test
    @DisplayName("结果留得比客户端「没弄清就沿用这个键」的窗口加上放弃之前自动重来的那几轮还长 —— 页面、命令行各比一次")
    void 结果留得够久() throws Exception {
        // 第一下做完（服务器从这一刻开始记）、回应丢了；客户端重来几轮、每一轮都等满超时才放弃；放弃之后还要沿用这个键一个窗口。
        // 服务器先忘的话，窗口的最后一截里照着「再点一次不会重复保存」再点，就又做一遍。原来两边都是 10 分钟
        long ttl = IdempotencyService.RESULT_TTL.toMillis();

        String js = Files.readString(NodeRunner.API_JS);
        long pageTimeout = constant(js, "var REQUEST_TIMEOUT_MS = ([\\d_ *]+);");
        long[] pageWaits = list(js, "var RETRY_WAITS_MS = \\[([\\d, ]+)\\];");
        long pageSpan = pageTimeout * (pageWaits.length + 1) + Arrays.stream(pageWaits).sum();
        long pageWindow = constant(js, "var UNCERTAIN_KEY_MS = ([\\d_ *]+);");
        assertTrue(ttl > pageWindow + pageSpan, "结果留 " + ttl + "ms，页面沿用键 " + pageWindow + "ms + 重来的一整轮 " + pageSpan + "ms");

        Path cliSrc = Path.of("../zhiqu-cli/src");
        String api = Files.readString(cliSrc.resolve("api.js"));
        long cliWindow = constant(api, "const UNCERTAIN_KEY_MS = ([\\d_ *]+);");
        long[] backoff = list(api, "const GET_BACKOFF = \\[([\\d_, ]+)\\];");
        long cliTimeout = 0;
        int seen = 0;
        try (Stream<Path> files = Files.list(cliSrc)) {
            for (Path f : files.filter(p -> p.toString().endsWith(".js")).toList()) {
                Matcher m = Pattern.compile("timeoutMs(?:: | = )([\\d_]+)").matcher(Files.readString(f));
                while (m.find()) {
                    cliTimeout = Math.max(cliTimeout, Long.parseLong(m.group(1).replace("_", "")));
                    seen++;
                }
            }
        }
        assertTrue(seen >= 3, "命令行源码里只找到 " + seen + " 处 timeoutMs —— 扫空了？");
        long cliSpan = cliTimeout * (backoff.length + 1) + Arrays.stream(backoff).sum();
        assertTrue(ttl > cliWindow + cliSpan, "结果留 " + ttl + "ms，命令行沿用键 " + cliWindow + "ms + 重来的一整轮 " + cliSpan + "ms");
    }
}
