package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.harness.AccessTokenService;
import com.zhiqu.service.harness.DeviceLoginService;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 管理个人访问令牌 —— 只能用网页的登录态。
 *
 * <p>这里<b>故意</b>不在 {@code /api/harness/} 下面：令牌只在那下面被认（{@link com.zhiqu.service.harness.HarnessPaths}），
 * 所以一张泄露的令牌够不着这里 —— 不能给自己签新令牌、不能批准别的设备、不能撤销别人的撤销。
 * {@code AccessTokenScopeTest} 钉着这一点。
 */
@RestController
@RequestMapping("/api/access-tokens")
public class AccessTokenController {

    private final AccessTokenService tokens;
    private final DeviceLoginService deviceLogin;

    public AccessTokenController(AccessTokenService tokens, DeviceLoginService deviceLogin) {
        this.tokens = tokens;
        this.deviceLogin = deviceLogin;
    }

    @GetMapping
    public Result<List<Map<String, Object>>> list() {
        return Result.success(tokens.list(SecurityUtils.getCurrentUserId()));
    }

    /** 手动签一张（给没法开浏览器的机器用）。明文只在这次响应里出现一次。 */
    @PostMapping
    public Result<Map<String, Object>> create(@RequestBody(required = false) Map<String, Object> body) {
        Long userId = SecurityUtils.getCurrentUserId();
        Object name = body == null ? null : body.get("name");
        AccessTokenService.Issued issued = tokens.issue(userId, name == null ? null : String.valueOf(name));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", issued.row().getId());
        out.put("name", issued.row().getName());
        out.put("token", issued.token());
        return Result.success(out);
    }

    @DeleteMapping("/{id}")
    public Result<Void> revoke(@PathVariable Long id) {
        tokens.revoke(SecurityUtils.getCurrentUserId(), id);
        return Result.success();
    }

    @GetMapping("/device/{userCode}")
    public Result<Map<String, Object>> describeDevice(@PathVariable String userCode) {
        SecurityUtils.getCurrentUserId();
        return Result.success(deviceLogin.describe(userCode));
    }

    @PostMapping("/device/{userCode}/approve")
    public Result<Void> approve(@PathVariable String userCode) {
        deviceLogin.approve(SecurityUtils.getCurrentUserId(), userCode);
        return Result.success();
    }

    @PostMapping("/device/{userCode}/deny")
    public Result<Void> deny(@PathVariable String userCode) {
        deviceLogin.deny(SecurityUtils.getCurrentUserId(), userCode);
        return Result.success();
    }
}
