package com.zhiqu;

import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.service.impl.AdminGuardImpl;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 监管后台的 API 授权 —— <b>此前零覆盖</b>。
 *
 * <h2>已有的后台判据钉的是别的东西</h2>
 *
 * <p>{@link AdminPageWiringTest} 钉的是后台<b>页面</b>：前端路由问没问
 * {@code ZQUI.isAdminPage}、页面在不在 SecurityConfig 白名单里。那两件都是 UX 与静态资源 ——
 * 白名单本身是 {@code permitAll}，页面谁都能下载。真正拦住非管理员去调
 * {@code POST /api/admin/users/{id}/reset-password} 的，<b>只有每个方法体里那一行
 * {@code requireAdmin()}</b>。
 *
 * <h2>为什么这个形状必须有判据看着</h2>
 *
 * <p>SecurityConfig 里<b>没有</b>任何 {@code hasRole("ADMIN")} 规则，只有
 * {@code anyRequest().authenticated()}。也就是说授权不是声明式的、不是一条规则管一片，
 * 而是 29 个方法各写一行。新加第 30 个接口时忘写那一行，就是一个洞 ——
 * 而且没有任何东西会红，功能还照常工作（对管理员而言）。
 *
 * <p>这正是本仓库反复在消灭的那种形状：保护存在，但它的存在依赖每次都记得手写。
 */
class AdminAuthorizationTest {
    private static final Path ADMIN_CONTROLLER =
            Path.of("src/main/java/com/zhiqu/controller/AdminController.java");
    private static final Path AI_CONTROLLER =
            Path.of("src/main/java/com/zhiqu/controller/AiController.java");

    /** 后台接口数量的下界 —— 防止正则失配后留下空名单，让下面的断言全部空过。 */
    private static final int MIN_ADMIN_ENDPOINTS = 25;

    private static final Pattern MAPPING =
            Pattern.compile("@(Get|Post|Put|Delete|Patch)Mapping\\(?\\s*(?:value\\s*=\\s*)?\"?([^\")\\n]*)\"?");
    private static final Pattern METHOD_NAME =
            Pattern.compile("public\\s+[\\w<>,\\s\\[\\].]+\\s+(\\w+)\\s*\\(");

    private record Endpoint(String verb, String path, String method, boolean guarded) {
    }

    /**
     * 按 {@code @XxxMapping} 切块，逐块看有没有 {@code requireAdmin}。
     *
     * <p><b>必须先剥注释</b>：本类与被测源码里都写着 {@code requireAdmin} 这个词，
     * 不剥的话一句解释性注释就能满足「这个方法有守卫」。本仓库已经被注释骗过两次。
     */
    private static List<Endpoint> endpointsOf(Path file, String guardToken) throws IOException {
        String code = SourceText.stripComments(Files.readString(file, StandardCharsets.UTF_8));
        List<Integer> starts = new ArrayList<>();
        Matcher heads = MAPPING.matcher(code);
        while (heads.find()) {
            starts.add(heads.start());
        }
        List<Endpoint> found = new ArrayList<>();
        for (int i = 0; i < starts.size(); i++) {
            String chunk = code.substring(starts.get(i),
                    i + 1 < starts.size() ? starts.get(i + 1) : code.length());
            Matcher head = MAPPING.matcher(chunk);
            if (!head.find()) {
                continue;
            }
            Matcher name = METHOD_NAME.matcher(chunk);
            found.add(new Endpoint(head.group(1).toUpperCase(), head.group(2),
                    name.find() ? name.group(1) : "?", chunk.contains(guardToken)));
        }
        return found;
    }

    /**
     * 后台控制器里<b>每一个</b>接口都必须调 {@code requireAdmin()}。
     *
     * <p>扰动：从任意一个方法里删掉那一行 → 本条红，并点名是哪个方法。
     */
    @Test
    void 每个后台接口都必须调用requireAdmin() throws IOException {
        List<Endpoint> endpoints = endpointsOf(ADMIN_CONTROLLER, "requireAdmin()");
        assertTrue(endpoints.size() >= MIN_ADMIN_ENDPOINTS,
                "只解析出 " + endpoints.size() + " 个后台接口 —— 空扫和干净的扫形状一样，"
                        + "这个下界就是用来区分它们的。多半是 AdminController 的写法变了");

        List<String> unguarded = endpoints.stream()
                .filter(item -> !item.guarded())
                .map(item -> item.verb() + " " + item.path() + " (" + item.method() + ")")
                .toList();
        assertEquals(List.of(), unguarded,
                "这些后台接口没有调用 requireAdmin()，任何已登录用户都能调到它们。"
                        + "SecurityConfig 里没有 hasRole(\"ADMIN\") 规则，这一行是唯一的拦阻");
    }

    /**
     * 抓任意 URL 的那个接口也必须是管理员限定 —— 它不在 {@code /api/admin} 路径下。
     *
     * <p>{@code POST /api/ai/web-fetch/test} 让服务器去抓请求里给的地址。SSRF 防护挡的是
     * 内网目标（见 {@code WebPageFetchSsrfGuardTest}），但「让服务器替你发出站请求」这件事
     * 本身就不该对普通用户开放。它路径里没有 admin，所以上面那条判据覆盖不到它。
     */
    @Test
    void 抓任意URL的接口必须是管理员限定() throws IOException {
        List<Endpoint> endpoints = endpointsOf(AI_CONTROLLER, "adminGuard.requireAdmin(");
        Endpoint fetchTest = endpoints.stream()
                .filter(item -> "/web-fetch/test".equals(item.path()))
                .findFirst()
                .orElseThrow(() -> new AssertionError(
                        "找不到 /web-fetch/test 接口 —— 判据的锚点没了，改名了就要跟着改这里"));
        assertTrue(fetchTest.guarded(),
                "让服务器去抓任意 URL 的接口必须管理员限定；SSRF 防护挡的是目标地址，不是调用者");
    }

    private static AdminGuardImpl guardFor(SysUser user) {
        SysUserMapper mapper = mock(SysUserMapper.class);
        when(mapper.selectById(any())).thenReturn(user);
        return new AdminGuardImpl(mapper);
    }

    private static SysUser userWithRole(String role) {
        SysUser user = new SysUser();
        user.setId(1L);
        user.setRole(role);
        return user;
    }

    @Test
    void 普通用户必须被拒() {
        BusinessException thrown = assertThrows(BusinessException.class,
                () -> guardFor(userWithRole("USER")).requireAdmin(1L));
        assertTrue(String.valueOf(thrown.getMessage()).contains("无权"),
                "拒绝理由要说清是权限问题，实际：" + thrown.getMessage());
    }

    @Test
    void 用户不存在时必须被拒() {
        assertThrows(BusinessException.class, () -> guardFor(null).requireAdmin(999L),
                "查不到用户时必须拒绝 —— 放行等于把「token 里的 id 已不存在」当成了管理员");
    }

    /**
     * 管理员必须放行 —— 上面两条的反例。
     *
     * <p>没有它，把守卫写成「一律抛」也能让上面全绿，而整个后台对谁都不可用。
     */
    @Test
    void 管理员必须放行() {
        assertDoesNotThrow(() -> guardFor(userWithRole("ADMIN")).requireAdmin(1L));
        // 大小写不敏感是实现的既有行为（equalsIgnoreCase），一并钉住：
        // 收紧成大小写敏感会把库里存成 "Admin" 的账号挡在门外，而那种数据是存在的
        assertDoesNotThrow(() -> guardFor(userWithRole("admin")).requireAdmin(1L));
    }
}
