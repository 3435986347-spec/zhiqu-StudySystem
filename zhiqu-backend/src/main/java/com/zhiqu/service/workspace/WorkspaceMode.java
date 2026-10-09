package com.zhiqu.service.workspace;

/**
 * 工作区的访问级别 —— 四档，<b>严格递进</b>：后一档包含前一档的全部能力。
 *
 * <h2>为什么是级别而不是几个独立开关</h2>
 *
 * <p>独立开关（{@code canRead} / {@code canWrite} / {@code canExec}）可以配出
 * 「能执行但不能读」这种讲不通的组合，而且每加一个能力就要在每个调用点多判一次。
 * 做成有序的级别之后，「能不能执行」只有一个答案，而且「执行必然也能读」是类型上成立的，
 * 不是靠调用方记得同时检查。
 *
 * <h2>默认必须是 OFF</h2>
 *
 * <p>这个能力让一个监听端口的服务读你硬盘上的文件。默认值本身就是安全边界 ——
 * 与 {@code app.rag.enabled} 同理，而这里的后果比检索降级严重得多。
 * {@code WorkspaceModeTest} 钉住「默认是 OFF」这一条。
 */
public enum WorkspaceMode {
    /** 完全关闭。所有工作区接口与工具都不存在。 */
    OFF,
    /** 只读：列目录、读文件。<b>一个字节都不会写你的磁盘。</b> */
    READ,
    /** 读 + 写。写仍然要走「草稿 → 用户确认 → 落盘」，模型不直接碰磁盘。 */
    WRITE,
    /** 读 + 写 + 执行。只应在本机开发时开启。 */
    EXEC;

    public boolean allowsRead() {
        return this != OFF;
    }

    public boolean allowsWrite() {
        return this == WRITE || this == EXEC;
    }

    public boolean allowsExec() {
        return this == EXEC;
    }

    /**
     * 解析配置值。<b>无法识别的值一律回落到 OFF</b>，不是抛异常也不是回落到某个「常用档」——
     * 配错一个字母就把能力打开，是这类开关最典型的出事方式。
     */
    public static WorkspaceMode parse(String raw) {
        if (raw == null || raw.isBlank()) {
            return OFF;
        }
        try {
            return valueOf(raw.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return OFF;
        }
    }
}
