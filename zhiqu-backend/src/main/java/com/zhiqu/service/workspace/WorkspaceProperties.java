package com.zhiqu.service.workspace;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 工作区配置。<b>每一个默认值都是安全边界，不是「先随便填一个」。</b>
 *
 * <p>整体默认是关闭的（{@code mode = OFF}），所以不配这一段的部署与现在完全一样。
 */
@Component
@ConfigurationProperties(prefix = "app.workspace")
public class WorkspaceProperties {

    /** 访问级别，见 {@link WorkspaceMode}。配错一个字母会回落到 OFF，不会误开。 */
    private String mode = WorkspaceMode.OFF.name();

    /** 工作区根目录的绝对路径。为空时无论 mode 填什么都等于关闭。 */
    private String root = "";

    /**
     * 单个文件的读取上限。
     *
     * <p>不是为了省内存 —— 是为了别把一个 20MB 的 minified bundle 整个塞进模型上下文，
     * 那既没用又贵。256KB 对源码文件足够宽松。
     */
    private long maxFileBytes = 256 * 1024L;

    /**
     * 一次列目录最多返回多少条。
     *
     * <p>一个带 {@code node_modules} 的目录轻易上十万个文件；没有这个上限，
     * 一次「列一下文件」就能把内存打满。
     */
    private int maxEntries = 500;

    /**
     * 允许读取的扩展名 —— <b>白名单，不是黑名单</b>。
     *
     * <p>黑名单是失败开放的：漏掉一个 {@code .pem} 就泄漏一把私钥。白名单失败封闭，
     * 代价只是偶尔要添一个扩展名。这里挡的不是攻击者，是「顺手把 .env 喂进模型上下文」。
     */
    private List<String> allowedExtensions = List.of(
            "java", "kt", "py", "js", "ts", "jsx", "tsx", "go", "rs", "rb", "php",
            "c", "h", "cpp", "hpp", "cc", "cs", "swift", "m", "scala",
            "sql", "sh", "bat", "ps1",
            "html", "css", "scss", "less", "vue", "svelte",
            "json", "yml", "yaml", "toml", "xml", "properties",
            "md", "txt", "csv", "gradle", "makefile", "dockerfile");

    /** 执行超时。到点 destroyForcibly —— 一个死循环不该把这台机器占住。 */

    /**
     * 搜索时最多访问多少个文件。
     *
     * <p>搜索是唯一一个会递归整棵目录树的入口。跳过 {@code node_modules} 一类之后仍然可能
     * 很大，所以再加一道硬上限：够用（一个中等项目几千个源文件），但保证不会因为指错了
     * 根目录（比如指到了家目录）而把进程拖死。
     */
    private int maxSearchFiles = 3000;

    /** 一次搜索最多返回多少条命中 —— 再多也塞不进模型上下文，只会挤掉真正有用的部分。 */
    private int maxSearchHits = 80;

    /** 命中行超过这个长度就截断。压缩过的 .js/.css 一行可能有几十万字符。 */
    private int maxSearchLineChars = 400;

    private long execTimeoutMs = 10_000L;

    /** stdout + stderr 合计上限。超出截断并明确标注，而不是悄悄少给几行。 */
    private int execOutputLimitBytes = 64 * 1024;

    /**
     * 可执行的命令白名单。<b>只接受命令名，不接受任意 shell 字符串</b> ——
     * 接受 shell 字符串等于把整台机器交出去，管道、重定向、{@code rm -rf} 全都能写。
     */
    private List<String> allowedCommands = List.of(
            "java", "javac", "python3", "python", "node", "npm", "go", "gcc", "g++", "cargo", "mvn");

    public WorkspaceMode resolvedMode() {
        return WorkspaceMode.parse(mode);
    }

    public String getMode() { return mode; }
    public void setMode(String mode) { this.mode = mode; }
    public String getRoot() { return root; }
    public void setRoot(String root) { this.root = root; }
    public long getMaxFileBytes() { return maxFileBytes; }
    public void setMaxFileBytes(long maxFileBytes) { this.maxFileBytes = maxFileBytes; }
    public int getMaxEntries() { return maxEntries; }
    public void setMaxSearchFiles(int maxSearchFiles) { this.maxSearchFiles = maxSearchFiles; }

    public void setMaxSearchHits(int maxSearchHits) { this.maxSearchHits = maxSearchHits; }

    public void setMaxSearchLineChars(int maxSearchLineChars) { this.maxSearchLineChars = maxSearchLineChars; }

    public void setMaxEntries(int maxEntries) { this.maxEntries = maxEntries; }
    public List<String> getAllowedExtensions() { return allowedExtensions; }
    public void setAllowedExtensions(List<String> allowedExtensions) { this.allowedExtensions = allowedExtensions; }
    public int getMaxSearchFiles() { return maxSearchFiles; }

    public int getMaxSearchHits() { return maxSearchHits; }

    public int getMaxSearchLineChars() { return maxSearchLineChars; }

    public long getExecTimeoutMs() { return execTimeoutMs; }
    public void setExecTimeoutMs(long execTimeoutMs) { this.execTimeoutMs = execTimeoutMs; }
    public int getExecOutputLimitBytes() { return execOutputLimitBytes; }
    public void setExecOutputLimitBytes(int execOutputLimitBytes) { this.execOutputLimitBytes = execOutputLimitBytes; }
    public List<String> getAllowedCommands() { return allowedCommands; }
    public void setAllowedCommands(List<String> allowedCommands) { this.allowedCommands = allowedCommands; }
}
