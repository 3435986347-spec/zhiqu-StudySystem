package com.zhiqu.fuzz;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.security.JwtUtils;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.core.MethodParameter;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 暴力测试之一：<b>全接口的坏输入</b>（第十一轮，用户要的「暴力的测试…不同输入」）。
 *
 * <p>接口不手写名单 —— 从 Spring 的映射表里枚举全部 {@code /api/**}，新加的接口自动纳入。每个接口喂一组坏输入：
 * 空体、{@code null}、错类型、畸形 JSON、10 万字、emoji / 零宽 / RTL、{@code <script>}、SQL 片段、负数、溢出的数、
 * 非法日期、路径参数给字母……管理员与普通用户各跑一遍。
 *
 * <p>判据只有一条：<b>坏输入不许变成「服务器出错」</b>。怎么认：{@code GlobalExceptionHandler} 的兜底分支会把异常记进
 * {@code runtime_issue}（管理员后台「运行问题」看的就是它）—— 每个请求前后比一次这张表；外加 HTTP 500 与超时。
 * 坏输入该得到的是「说清哪里不对」，不是一条运行问题和一段 Java 异常原文。
 */
@Testcontainers
@AutoConfigureMockMvc
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class EndpointFuzzIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_fuzz")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private MockMvc mvc;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private JwtUtils jwt;
    @Autowired private ObjectMapper json;
    @Autowired @Qualifier("requestMappingHandlerMapping") private RequestMappingHandlerMapping mapping;

    /** 限流是按来源 IP 的：每个请求换一个来源，测的是输入，不是限流。 */
    private static final AtomicInteger PEER = new AtomicInteger(1);

    static final String HUGE = "长".repeat(100_000);
    static final String WEIRD = "😀\u200b\u202eRTL\u0000<script>alert(1)</script>' OR 1=1; DROP TABLE sys_user; --";
    static final List<String> PATH_VALUES = List.of("abc", "-1", "0", "99999999999999999999", "1.5", "999999");
    static final List<String> PARAM_VALUES = List.of("", "abc", "-1", "99999999999999999999", "2026-02-30", "not-a-date", WEIRD, HUGE);
    static final List<String> RAW_BODIES = List.of("", "null", "[]", "{}", "\"text\"", "{\"a\":", "{\"id\":", "123", "[{}]");

    /** 这几个不在这里测，理由各写一句（范围要小，每加一个都要有理由）。 */
    static final Map<String, String> SKIP = Map.of(
            "/api/ai/chat/stream", "SSE 流式：异常在异步线程里走 SSE error，不经过 GlobalExceptionHandler —— 另有专门的暴力测试",
            "/api/harness/model/stream", "同上（命令行的模型网关，SSE）");

    private Long adminId;
    private Long userId;

    private record Actor(String name, Long id) {
    }

    private record Finding(String endpoint, String variant, String what) {
    }

    @Test
    @DisplayName("全部 /api 接口喂坏输入：不许出现未处理异常（运行问题）、HTTP 500 或超时")
    void 坏输入不许变成服务器出错() throws Exception {
        adminId = seedUser("fuzz_admin", "ADMIN");
        userId = seedUser("fuzz_user", "USER");
        List<Finding> findings = new ArrayList<>();
        Set<String> covered = new TreeSet<>();
        int requests = 0;
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            for (Map.Entry<RequestMappingInfo, HandlerMethod> e : mapping.getHandlerMethods().entrySet()) {
                RequestMappingInfo info = e.getKey();
                HandlerMethod handler = e.getValue();
                if (info.getPathPatternsCondition() == null) {
                    continue;
                }
                Set<RequestMethod> methods = info.getMethodsCondition().getMethods();
                for (String pattern : info.getPathPatternsCondition().getPatternValues()) {
                    if (!pattern.startsWith("/api/") || SKIP.containsKey(pattern)) {
                        continue;
                    }
                    for (RequestMethod method : methods.isEmpty() ? Set.of(RequestMethod.GET) : methods) {
                        covered.add(method + " " + pattern);
                        for (Actor actor : List.of(new Actor("admin", adminId), new Actor("user", userId))) {
                            for (Variant v : variants(pattern, handler)) {
                                requests++;
                                String what = fire(pool, HttpMethod.valueOf(method.name()), v, actor);
                                if (what != null) {
                                    findings.add(new Finding(method + " " + pattern, actor.name() + " · " + v.label(), what));
                                }
                            }
                        }
                    }
                }
            }
        } finally {
            pool.shutdownNow();
        }
        assertTrue(covered.size() >= 150, "只枚举到 " + covered.size() + " 个接口 —— 映射表扫空了，下面的「没问题」不作数");
        // 同一个接口同一种问题只报一次（附一个触发它的输入），不然一屏都是重复
        Map<String, Finding> distinct = new LinkedHashMap<>();
        for (Finding f : findings) {
            distinct.putIfAbsent(f.endpoint() + " | " + f.what(), f);
        }
        StringBuilder report = new StringBuilder();
        for (Finding f : distinct.values()) {
            report.append(f.endpoint()).append("  ←  ").append(f.variant()).append("\n      ").append(f.what()).append('\n');
        }
        assertTrue(distinct.isEmpty(), "跑了 " + covered.size() + " 个接口、" + requests + " 个请求，坏输入变成了服务器出错（"
                + distinct.size() + " 处）：\n" + report);
    }

    // ── 输入 ─────────────────────────────────────────────────────────────

    record Variant(String label, String path, Map<String, String> params, Map<String, String> headers, String body) {
    }

    private List<Variant> variants(String pattern, HandlerMethod handler) throws Exception {
        List<Variant> out = new ArrayList<>();
        List<String> pathVars = new ArrayList<>();
        Matcher m = Pattern.compile("\\{([^}/]+)}").matcher(pattern);
        while (m.find()) {
            pathVars.add(m.group(1));
        }
        String base = pathVars.isEmpty() ? pattern : fill(pattern, "1");
        List<String> params = new ArrayList<>();
        List<String> headers = new ArrayList<>();
        Class<?> bodyType = null;
        for (MethodParameter p : handler.getMethodParameters()) {
            // 注解里没写名字的，名字来自编译时保留的参数名 —— 要先挂上名字发现器，不然拿到 null
            p.initParameterNameDiscovery(new org.springframework.core.DefaultParameterNameDiscoverer());
            RequestParam rp = p.getParameterAnnotation(RequestParam.class);
            if (rp != null) {
                params.add(!rp.name().isEmpty() ? rp.name() : !rp.value().isEmpty() ? rp.value() : p.getParameterName());
            }
            RequestHeader rh = p.getParameterAnnotation(RequestHeader.class);
            if (rh != null) {
                headers.add(!rh.name().isEmpty() ? rh.name() : !rh.value().isEmpty() ? rh.value() : p.getParameterName());
            }
            if (p.hasParameterAnnotation(RequestBody.class)) {
                bodyType = p.getParameterType();
            }
        }
        // 路径参数：每个取一组坏值
        for (String bad : PATH_VALUES) {
            if (!pathVars.isEmpty()) {
                out.add(new Variant("路径=" + bad, fill(pattern, bad), Map.of(), Map.of(), null));
            }
        }
        // 查询参数：逐个给坏值，也试一次全都不给
        if (!params.isEmpty()) {
            out.add(new Variant("不带参数", base, Map.of(), Map.of(), null));
            for (String bad : PARAM_VALUES) {
                Map<String, String> ps = new LinkedHashMap<>();
                for (String name : params) {
                    ps.put(name, bad);
                }
                out.add(new Variant("参数=" + label(bad), base, ps, Map.of(), null));
            }
        }
        // 请求头
        for (String h : headers) {
            out.add(new Variant("头 " + h + "=超长", base, Map.of(), Map.of(h, "k".repeat(5000)), bodyType == null ? null : "{}"));
        }
        // 请求体：原样的坏体 + 按类型造的坏字段
        for (String raw : RAW_BODIES) {
            out.add(new Variant("体=" + label(raw), base, Map.of(), Map.of(), raw));
        }
        for (Map.Entry<String, String> typed : typedBodies(bodyType).entrySet()) {
            out.add(new Variant("体:" + typed.getKey(), base, Map.of(), Map.of(), typed.getValue()));
        }
        if (out.isEmpty()) {
            out.add(new Variant("原样", base, Map.of(), Map.of(), null));
        }
        return out;
    }

    private static String fill(String pattern, String value) {
        return pattern.replaceAll("\\{[^}/]+}", java.util.regex.Matcher.quoteReplacement(value));
    }

    private static String label(String v) {
        if (v.length() > 40) {
            return "超长(" + v.length() + ")";
        }
        return v.isEmpty() ? "空" : v.replace("\u0000", "\\0");
    }

    /** 按请求体的类型造坏字段：DTO 按字段类型，Map 用一组常见的键。每种坏法一个变体。 */
    private Map<String, String> typedBodies(Class<?> type) throws Exception {
        Set<String> keys = new LinkedHashSet<>();
        if (type != null && !Map.class.isAssignableFrom(type) && !type.getName().startsWith("java.")) {
            for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
                for (Field f : c.getDeclaredFields()) {
                    if (!java.lang.reflect.Modifier.isStatic(f.getModifiers())) {
                        keys.add(f.getName());
                    }
                }
            }
        }
        if (keys.isEmpty()) {
            keys.addAll(List.of("id", "title", "content", "name", "message", "startDate", "endDate", "date", "status",
                    "quadrant", "tasks", "routines", "version", "parentId", "modelConfigId", "notebookId", "items", "type"));
        }
        Map<String, Object> strings = new LinkedHashMap<>();
        Map<String, Object> wrongTypes = new LinkedHashMap<>();
        Map<String, Object> numbers = new LinkedHashMap<>();
        Map<String, Object> nulls = new LinkedHashMap<>();
        Map<String, Object> dates = new LinkedHashMap<>();
        for (String k : keys) {
            strings.put(k, WEIRD + HUGE);
            wrongTypes.put(k, Map.of("nested", List.of(1, "x", Map.of())));
            numbers.put(k, -99999999999L);
            nulls.put(k, null);
            dates.put(k, "2026-02-30T25:61:00");
        }
        Map<String, String> out = new LinkedHashMap<>();
        out.put("字段全是超长怪字符", json.writeValueAsString(strings));
        out.put("字段全是嵌套对象", json.writeValueAsString(wrongTypes));
        out.put("字段全是负的大数", json.writeValueAsString(numbers));
        out.put("字段全是 null", json.writeValueAsString(nulls));
        out.put("字段全是非法日期", json.writeValueAsString(dates));
        return out;
    }

    // ── 发请求、看有没有出事 ─────────────────────────────────────────────

    /** 发一次；出事返回一句说明（未处理异常 / HTTP 500 / 超时），没事返回 null。 */
    private String fire(ExecutorService pool, HttpMethod method, Variant v, Actor actor) throws Exception {
        ensureAlive(actor.id());
        Long before = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM runtime_issue", Long.class);
        int n = PEER.incrementAndGet();
        MockHttpServletRequestBuilder req = MockMvcRequestBuilders.request(method, java.net.URI.create(encode(v.path())))
                .header("Authorization", "Bearer " + token(actor.id()))
                .with(r -> {
                    r.setRemoteAddr("198.18." + (n / 250 % 250) + "." + (n % 250 + 1));
                    return r;
                });
        v.params().forEach(req::param);
        v.headers().forEach(req::header);
        if (v.body() != null) {
            req.contentType(MediaType.APPLICATION_JSON).content(v.body().getBytes(StandardCharsets.UTF_8));
        }
        Future<MockHttpServletResponse> f = pool.submit(() -> mvc.perform(req).andReturn().getResponse());
        MockHttpServletResponse res;
        try {
            res = f.get(20, TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException te) {
            f.cancel(true);
            return "超过 20 秒没有回应";
        } catch (java.util.concurrent.ExecutionException ee) {
            Throwable c = ee.getCause() != null && ee.getCause().getCause() != null ? ee.getCause().getCause() : ee.getCause();
            return "请求抛到了框架外面：" + c.getClass().getSimpleName() + "：" + firstLine(c.getMessage());
        }
        List<Map<String, Object>> issues = jdbc.queryForList(
                "SELECT category, message FROM runtime_issue WHERE id > ? AND source = 'SERVER' ORDER BY id", before);
        if (!issues.isEmpty()) {
            Map<String, Object> first = issues.get(0);
            return "未处理异常 " + first.get("category") + "：" + firstLine(String.valueOf(first.get("message")));
        }
        if (res.getStatus() >= 500) {
            return "HTTP " + res.getStatus();
        }
        return null;
    }

    private static String firstLine(String s) {
        if (s == null) {
            return "(无信息)";
        }
        String line = s.split("\n")[0];
        return line.length() > 160 ? line.substring(0, 160) + "…" : line;
    }

    /** 路径里的怪字符编码一下，MockMvc 才收；百分号本身不再编码。 */
    private static String encode(String path) {
        StringBuilder sb = new StringBuilder();
        for (char c : path.toCharArray()) {
            if (c <= 0x20 || c >= 0x7f || c == '"' || c == '<' || c == '>' || c == '`' || c == '{' || c == '}' || c == '|' || c == '\\' || c == '^') {
                for (byte b : String.valueOf(c).getBytes(StandardCharsets.UTF_8)) {
                    sb.append('%').append(String.format("%02X", b));
                }
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    // ── 账号：坏输入里有「禁用 / 删除 / 改密码 id=1」，每个请求之前把两个账号恢复原样、按当前纪元签令牌 ──

    private Long seedUser(String name, String role) {
        jdbc.update("INSERT INTO sys_user(username, password, nickname, role, status, deleted) VALUES (?, ?, ?, ?, 1, 0)",
                name, "$2a$10$abcdefghijklmnopqrstuuJ1b3Yv4yQj8ZtR0T0x5xY3m7G7l1y0e", name, role);
        return jdbc.queryForObject("SELECT id FROM sys_user WHERE username = ?", Long.class, name);
    }

    private void ensureAlive(Long id) {
        jdbc.update("UPDATE sys_user SET status = 1, deleted = 0 WHERE id = ?", id);
    }

    private String token(Long id) {
        Map<String, Object> row = jdbc.queryForMap("SELECT username, token_epoch FROM sys_user WHERE id = ?", id);
        return jwt.generateToken(id, String.valueOf(row.get("username")), ((Number) row.get("token_epoch")).intValue(), 3_600_000L);
    }
}
