package com.zhiqu.controller;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Result;
import com.zhiqu.entity.HarnessUsage;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.HarnessUsageMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.security.ClientIpResolver;
import com.zhiqu.security.JwtAuthenticationFilter;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.AiService;
import com.zhiqu.service.harness.DeviceLoginService;
import com.zhiqu.service.harness.HarnessContext;
import com.zhiqu.service.harness.HarnessModelGateway;
import com.zhiqu.service.harness.HarnessRemoteTools;
import com.zhiqu.service.harness.HarnessSessionService;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 命令行 zhiqu（harness）用的接口。循环与本地工具都在用户电脑上，这里只有：登录（设备码）、
 * 模型网关、会话存档、远程工具、用量。
 *
 * <p>这下面的接口接受个人访问令牌（{@code zqp_…}），也接受网页的登录态。令牌<b>只</b>在这下面有效 ——
 * 见 {@link com.zhiqu.service.harness.HarnessPaths}；管理令牌的接口在 {@link AccessTokenController}，令牌够不着。
 */
@RestController
@RequestMapping("/api/harness")
public class HarnessController {
    private static final Logger log = LoggerFactory.getLogger(HarnessController.class);
    /** 一次模型调用最长 10 分钟（写一个大文件、推理模型想很久）。 */
    static final long STREAM_TIMEOUT_MS = 600_000L;

    private final HarnessModelGateway gateway;
    private final HarnessRemoteTools remoteTools;
    private final HarnessSessionService sessions;
    private final DeviceLoginService deviceLogin;
    private final AiService aiService;
    private final SysUserMapper userMapper;
    private final HarnessUsageMapper usageMapper;
    private final ClientIpResolver ipResolver;
    private final BusinessClock clock;
    private final String cliLatest;
    private final String cliMinimum;
    private final ThreadPoolExecutor streams;
    private final com.zhiqu.service.support.SseHeartbeats heartbeats;

    public HarnessController(HarnessModelGateway gateway, HarnessRemoteTools remoteTools, HarnessSessionService sessions,
                             DeviceLoginService deviceLogin, AiService aiService, SysUserMapper userMapper,
                             HarnessUsageMapper usageMapper, ClientIpResolver ipResolver, BusinessClock clock,
                             @Value("${app.harness.cli-latest:0.1.0}") String cliLatest,
                             @Value("${app.harness.cli-minimum:0.1.0}") String cliMinimum,
                             com.zhiqu.service.support.SseHeartbeats heartbeats) {
        this.gateway = gateway;
        this.remoteTools = remoteTools;
        this.sessions = sessions;
        this.deviceLogin = deviceLogin;
        this.aiService = aiService;
        this.userMapper = userMapper;
        this.usageMapper = usageMapper;
        this.ipResolver = ipResolver;
        this.clock = clock;
        this.cliLatest = cliLatest;
        this.cliMinimum = cliMinimum;
        this.heartbeats = heartbeats;
        AtomicInteger n = new AtomicInteger();
        // 有界：同时最多 64 路模型调用，满了直接拒（而不是排队排到超时）
        this.streams = new ThreadPoolExecutor(0, 64, 60, TimeUnit.SECONDS, new SynchronousQueue<>(), r -> {
            Thread t = new Thread(r, "harness-stream-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        });
    }

    // ── 无需登录 ─────────────────────────────────────────────────────────────

    @GetMapping("/meta")
    public Result<Map<String, Object>> meta() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("cliLatest", cliLatest);
        out.put("cliMinimum", cliMinimum);
        out.put("deviceLogin", true);
        return Result.success(out);
    }

    @PostMapping("/device/start")
    public Result<Map<String, Object>> deviceStart(@RequestBody(required = false) Map<String, Object> body,
                                                   HttpServletRequest request) {
        Object name = body == null ? null : body.get("clientName");
        return Result.success(deviceLogin.start(name == null ? null : String.valueOf(name), ipResolver.resolve(request)));
    }

    @PostMapping("/device/poll")
    public Result<Map<String, Object>> devicePoll(@RequestBody Map<String, Object> body) {
        Object code = body == null ? null : body.get("deviceCode");
        return Result.success(deviceLogin.poll(code == null ? null : String.valueOf(code)));
    }

    // ── 需要登录（令牌或网页登录态） ────────────────────────────────────────

    @GetMapping("/me")
    public Result<Map<String, Object>> me() {
        Long userId = SecurityUtils.getCurrentUserId();
        SysUser user = userMapper.selectById(userId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("userId", userId);
        out.put("username", user == null ? null : user.getUsername());
        out.put("nickname", user == null ? null : user.getNickname());
        out.put("auth", viaAccessToken() ? "token" : "session");
        return Result.success(out);
    }

    static boolean viaAccessToken() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth != null && auth.getAuthorities().stream()
                .anyMatch(a -> JwtAuthenticationFilter.ACCESS_TOKEN_AUTHORITY.equals(a.getAuthority()));
    }

    /** 这个用户能用的模型，拍平成一个列表；只列启用的。 */
    @GetMapping("/models")
    public Result<Map<String, Object>> models() {
        Long userId = SecurityUtils.getCurrentUserId();
        Map<String, Object> raw = aiService.listModels(userId);
        Object defaultId = raw.get("defaultModelId");
        List<Map<String, Object>> rows = new ArrayList<>();
        for (String key : new String[]{"userModels", "systemModels"}) {
            if (!(raw.get(key) instanceof List<?> list)) continue;
            for (Object o : list) {
                if (!(o instanceof Map<?, ?> m) || Boolean.FALSE.equals(m.get("enabled"))) continue;
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", m.get("id"));
                row.put("label", m.get("label"));
                row.put("modelName", m.get("modelName"));
                row.put("providerType", m.get("providerType"));
                row.put("toolCalling", m.get("toolCalling"));
                Integer window = m.get("contextWindowTokens") instanceof Number n ? n.intValue() : null;
                row.put("contextWindowTokens", window);
                row.put("effectiveContextWindow", HarnessContext.effectiveWindow(window));
                row.put("isDefault", defaultId != null && defaultId.equals(m.get("id")));
                rows.add(row);
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("models", rows);
        out.put("defaultModelId", defaultId);
        return Result.success(out);
    }


    @PostMapping(value = "/model/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter modelStream(@RequestBody Map<String, Object> body) {
        Long userId = SecurityUtils.getCurrentUserId();
        SseEmitter emitter = new SseEmitter(STREAM_TIMEOUT_MS);
        // 心跳：推理模型在第一个字之前可能要想一两分钟，这段时间连接上一个字节都没有 ——
        // 反向代理会当它死了掐掉，命令行的空闲计时也会误判。见 SseHeartbeats。
        com.zhiqu.service.support.SseHeartbeats.Beat beat = heartbeats.start(emitter);
        try {
            streams.execute(() -> {
                try {
                    gateway.stream(userId, body, (name, data) -> emitter.send(SseEmitter.event().name(name).data(data)));
                    beat.close();
                    emitter.complete();
                } catch (HarnessModelGateway.ClientGone e) {
                    beat.close();
                    emitter.complete();   // 命令行那边断开了（Ctrl+C），不用再说什么，上游也随之停读
                } catch (HarnessModelGateway.ModelCallException e) {
                    beat.close();
                    sendError(emitter, e.getMessage(), e.retryable());
                } catch (BusinessException e) {
                    beat.close();
                    sendError(emitter, e.getMessage(), false);
                } catch (RuntimeException e) {
                    beat.close();
                    log.error("命令行模型调用异常终止 userId={}：{}", userId, e.getMessage(), e);
                    sendError(emitter, e.getMessage() == null ? "模型调用失败" : e.getMessage(), false);
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            beat.close();
            sendError(emitter, "服务器上同时进行的模型调用太多了，请稍后再试", true);
        }
        return emitter;
    }

    static void sendError(SseEmitter emitter, String message, boolean retryable) {
        try {
            emitter.send(SseEmitter.event().name("error").data(Map.of(
                    "message", message == null ? "模型调用失败" : message, "retryable", retryable)));
        } catch (Exception ignored) {
            // 对方已经断开
        }
        emitter.complete();
    }

    @GetMapping("/tools")
    public Result<List<Map<String, Object>>> tools() {
        SecurityUtils.getCurrentUserId();
        return Result.success(remoteTools.tools());
    }

    @PostMapping("/tools/call")
    public Result<Map<String, Object>> callTool(@RequestBody Map<String, Object> body) {
        Long userId = SecurityUtils.getCurrentUserId();
        return Result.success(remoteTools.call(userId, str(body.get("sessionId")), str(body.get("name")), body.get("arguments")));
    }

    @PostMapping("/sessions")
    public Result<Map<String, Object>> openSession(@RequestBody Map<String, Object> body) {
        Long userId = SecurityUtils.getCurrentUserId();
        var s = sessions.open(userId, str(body.get("sessionId")), str(body.get("title")), str(body.get("workspace")));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", s.getClientSessionId());
        out.put("notebookId", s.getNotebookId());
        return Result.success(out);
    }

    @GetMapping("/sessions")
    public Result<List<Map<String, Object>>> listSessions() {
        return Result.success(sessions.list(SecurityUtils.getCurrentUserId()));
    }

    @PostMapping("/sessions/{sessionId}/messages")
    public Result<Map<String, Object>> appendMessages(@PathVariable String sessionId, @RequestBody Map<String, Object> body) {
        Long userId = SecurityUtils.getCurrentUserId();
        List<Map<String, Object>> messages = new ArrayList<>();
        if (body.get("messages") instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> m) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("role", m.get("role"));
                    row.put("content", m.get("content"));
                    messages.add(row);
                }
            }
        }
        if (messages.size() > 50) {
            throw new BusinessException("一次最多存档 50 条");
        }
        // 可以顺带给标题和工作区名：会话不存在时就用它们建 —— 命令行一轮只需要一个请求（原来先开会话再写，两个）
        return Result.success(sessions.append(userId, sessionId, str(body.get("title")), str(body.get("workspace")), messages));
    }

    @GetMapping("/usage")
    public Result<Map<String, Object>> usage() {
        Long userId = SecurityUtils.getCurrentUserId();
        Map<String, Object> out = new LinkedHashMap<>();
        // 「今天」只由 BusinessClock 决定（BusinessClockTest 盯着裸的 LocalDate.now()）
        LocalDate today = clock.today();
        out.put("today", usageSince(userId, today.atStartOfDay()));
        out.put("last30Days", usageSince(userId, today.minusDays(30).atStartOfDay()));
        return Result.success(out);
    }

    private Map<String, Object> usageSince(Long userId, java.time.LocalDateTime since) {
        List<Map<String, Object>> rows = usageMapper.selectMaps(new QueryWrapper<HarnessUsage>()
                .select("COUNT(*) AS calls", "COALESCE(SUM(prompt_tokens),0) AS promptTokens",
                        "COALESCE(SUM(completion_tokens),0) AS completionTokens")
                .eq("user_id", userId)
                .ge("created_at", since));
        Map<String, Object> row = rows.isEmpty() || rows.get(0) == null ? Map.of() : rows.get(0);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("calls", num(row.get("calls")));
        out.put("promptTokens", num(row.get("promptTokens")));
        out.put("completionTokens", num(row.get("completionTokens")));
        return out;
    }

    private static long num(Object o) {
        return o instanceof Number n ? n.longValue() : 0L;
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }
}
