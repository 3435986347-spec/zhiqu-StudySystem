package com.zhiqu.controller;

import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Result;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.AdminGuard;
import com.zhiqu.service.workspace.WorkspaceService;
import com.zhiqu.service.workspace.WorkspaceSettingsStore;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 代码工作区的只读接口。
 *
 * <h2>为什么是管理员限定</h2>
 *
 * <p>工作区是<b>机器级</b>资源，不像 Notebook 那样属于某个用户 —— 它是这台电脑上的一个文件夹。
 * 多用户实例上，一个人开的工作区会被所有登录用户读到。
 *
 * <p>绑回环那条把可达范围限制在本机，但「本机上的哪个账号」仍然是个问题。
 * 开启工作区本来就要在那台机器上改 {@code application.yml}（配根目录<b>且</b>绑回环），
 * 能做这件事的就是机器主人 —— 所以这里不加「要不要限管理员」的开关，
 * 少一个开关就少一种配错的方式。单机自用时把自己提成管理员是一次性动作。
 *
 * <p>注意 {@code AdminAuthorizationTest} 会扫 {@code AdminController} 里的每个映射，
 * 这个控制器不在那个范围内 —— 所以本文件的三个映射由 {@code WorkspaceControllerGuardTest} 单独盯。
 */
@RestController
@RequestMapping("/api/workspace")
public class WorkspaceController {

    private final WorkspaceService workspaceService;
    private final AdminGuard adminGuard;

    public WorkspaceController(WorkspaceService workspaceService, AdminGuard adminGuard) {
        this.workspaceService = workspaceService;
        this.adminGuard = adminGuard;
    }

    private void requireAdmin() {
        adminGuard.requireAdmin(SecurityUtils.getCurrentUserId());
    }

    /**
     * 工作区当前是什么状态 —— 前端据此决定显不显示这一块。
     *
     * <p>没开的时候<b>也要如实说明原因</b>：用户在配置里写了 mode 却看不到工作区时，
     * 必须能知道是哪一条前置没满足，而不是以为功能坏了。
     */
    @GetMapping("/status")
    public Result<Map<String, Object>> status() {
        requireAdmin();
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("enabled", workspaceService.access().enabled());
        row.put("mode", workspaceService.access().effectiveMode().name());
        row.put("configuredMode", workspaceService.access().configuredMode().name());
        row.put("root", workspaceService.access().root() == null ? "" : workspaceService.access().root().toString());
        row.put("reason", workspaceService.access().refusalReason());
        return Result.success(row);
    }

    /**
     * 当前的选择与实际状态 —— 界面的工作区设置面板据此渲染。
     *
     * <p>{@code selectedMode/selectedRoot} 是用户<b>选的</b>（持久化的那份），
     * {@code effectiveMode} 是<b>实际生效的</b>。二者可能不同：选了 EXEC 但没绑回环时，
     * effective 是 OFF，{@code reason} 说明为什么。前端把这个差异显示出来，用户才不会
     * 以为「我明明开了却没用」。
     */
    @GetMapping("/settings")
    public Result<Map<String, Object>> settings() {
        requireAdmin();
        WorkspaceSettingsStore.Settings sel = workspaceService.currentSelection();
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("selectedMode", sel.mode());
        row.put("selectedRoot", sel.root() == null ? "" : sel.root());
        row.put("effectiveMode", workspaceService.access().effectiveMode().name());
        row.put("enabled", workspaceService.access().enabled());
        row.put("root", workspaceService.access().root() == null ? "" : workspaceService.access().root().toString());
        row.put("reason", workspaceService.access().refusalReason());
        row.put("loopback", workspaceService.loopbackBound());
        row.put("modes", List.of("OFF", "READ", "WRITE", "EXEC"));
        return Result.success(row);
    }

    /**
     * 切换档位 / 根目录，并持久化。切换本身限管理员 + 回环 —— 公网上一律拒绝，
     * 免得有人以为在服务器上点一下就把本机文件读取接口打开了（实际打不开，但不该给这个入口）。
     */
    @PutMapping("/settings")
    public Result<Map<String, Object>> updateSettings(@RequestBody Map<String, Object> body) throws java.io.IOException {
        requireAdmin();
        if (!workspaceService.loopbackBound()) {
            throw new BusinessException("工作区只能在绑定回环地址的本机实例上开启（当前不是回环）");
        }
        String mode = body.get("mode") == null ? "OFF" : String.valueOf(body.get("mode"));
        String root = body.get("root") == null ? "" : String.valueOf(body.get("root"));
        workspaceService.applySettings(mode, root);
        return settings();
    }

    /**
     * 文件夹浏览器：列一个目录下的子目录，供选择根目录用。管理员 + 回环。
     *
     * <p>只列目录名、不碰文件内容。它独立于工作区根（你正是要用它挑那个根），
     * 所以能浏览工作区之外 —— 正因如此才把它锁在回环 + 管理员后面。
     */
    @GetMapping("/browse")
    public Result<Map<String, Object>> browse(@RequestParam(required = false) String path) {
        requireAdmin();
        if (!workspaceService.loopbackBound()) {
            throw new BusinessException("文件夹浏览只在绑定回环地址的本机实例上可用");
        }
        WorkspaceService.Browse browse = workspaceService.browseDirectories(path);
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("path", browse.path());
        row.put("parent", browse.parent());
        row.put("truncated", browse.truncated());
        row.put("dirs", browse.dirs().stream().map(d -> {
            Map<String, Object> one = new LinkedHashMap<>();
            one.put("name", d.name());
            one.put("path", d.path());
            return one;
        }).toList());
        return Result.success(row);
    }

    /** 列目录。{@code truncated} 要透传 —— 500 条和「至少 500 条」是两回事。 */
    @GetMapping("/files")
    public Result<Map<String, Object>> files(@RequestParam(required = false) String path) {
        requireAdmin();
        WorkspaceService.Listing listing = workspaceService.listing(path == null ? "" : path);
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("truncated", listing.truncated());
        row.put("entries", listing.entries().stream().map(e -> {
            Map<String, Object> one = new LinkedHashMap<>();
            one.put("path", e.path());
            one.put("directory", e.directory());
            one.put("size", e.size());
            one.put("readable", e.readable());
            return one;
        }).toList());
        return Result.success(row);
    }

    @GetMapping("/file")
    public Result<Map<String, Object>> file(@RequestParam String path) {
        requireAdmin();
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("path", path);
        row.put("content", workspaceService.read(path));
        return Result.success(row);
    }

    /** 关键词搜索。{@code truncated} 一定要透传到前端 —— 「80 条」和「至少 80 条」是两回事。 */
    @GetMapping("/search")
    public Result<Map<String, Object>> search(@RequestParam String query,
                                              @RequestParam(required = false) String path) {
        requireAdmin();
        WorkspaceService.SearchResult result = workspaceService.search(query, path == null ? "" : path);
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("truncated", result.truncated());
        row.put("filesScanned", result.filesScanned());
        row.put("hits", result.hits().stream().map(h -> {
            Map<String, Object> hit = new LinkedHashMap<>();
            hit.put("path", h.path());
            hit.put("line", h.line());
            hit.put("text", h.text());
            return hit;
        }).toList());
        return Result.success(row);
    }
}
