package com.zhiqu.service.concurrency;

import com.zhiqu.NodeRunner;
import com.zhiqu.service.AiWorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.util.Arrays;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 幂等锁要比「那一次」可能还在执行的时间长（第二十二轮）。
 *
 * <p>页面在超时（30 秒）之后用同一个键自动重来。锁原来也是 30 秒 —— 一次做了 31 秒的写，超时后重来的那一下正好碰上锁到期，
 * 和还没做完的那一次同时执行，写两遍。锁只在进程没了时靠 TTL 过期（正常都在 finally 里放掉），所以长一点只有那一种代价。
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
}
