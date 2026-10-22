package com.zhiqu.service.workspace;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 工作区访问级别：默认必须关闭，且四档<b>严格递进</b>。
 *
 * <h2>为什么「默认值」本身值得一条判据</h2>
 *
 * <p>这个能力让一个监听端口的服务读你硬盘上的文件。它的安全边界不在某个 if 里，
 * 而在<b>配置项的默认值</b>：没人配的时候它必须是关的。把默认值从 OFF 改成 READ
 * 不会让任何功能判据变红 —— 只会让所有现存部署突然多出一个读文件的接口。
 */
class WorkspaceModeTest {

    @Test
    void 默认必须是关闭的() {
        assertEquals(WorkspaceMode.OFF, new WorkspaceProperties().resolvedMode(),
                "不配 app.workspace.mode 时必须是 OFF —— 这个默认值本身就是安全边界");
        assertFalse(new WorkspaceProperties().resolvedMode().allowsRead(),
                "OFF 必须连读都不允许");
    }

    /**
     * 配错值必须回落到 OFF，而不是抛异常、也不是回落到某个「常用档」。
     *
     * <p>拼错一个字母就把能力打开，是这类开关最典型的出事方式。
     */
    @Test
    void 无法识别的配置值回落到关闭() {
        for (String bad : new String[]{"", "   ", "ON", "TRUE", "readonly", "read-write", "EXECUTE", "垃圾"}) {
            assertEquals(WorkspaceMode.OFF, WorkspaceMode.parse(bad),
                    "「" + bad + "」不是合法级别，必须回落到 OFF 而不是误开");
        }
        assertEquals(WorkspaceMode.OFF, WorkspaceMode.parse(null));
    }

    @Test
    void 合法值必须被识别() {
        // 上一条的反例：没有它，「一律返回 OFF」也能让它绿，而这个功能永远开不起来
        assertEquals(WorkspaceMode.READ, WorkspaceMode.parse("READ"));
        assertEquals(WorkspaceMode.WRITE, WorkspaceMode.parse(" write "));
        assertEquals(WorkspaceMode.EXEC, WorkspaceMode.parse("exec"));
    }

    /**
     * 四档必须严格递进 —— 后一档包含前一档的全部能力。
     *
     * <p>做成有序级别的全部意义就在这里：「能执行必然也能读」是类型上成立的，
     * 不靠每个调用点记得同时检查。少了这条，把 EXEC 写成「只能执行不能读」
     * 也不会有任何东西红。
     */
    @Test
    void 四档必须严格递进() {
        assertFalse(WorkspaceMode.OFF.allowsRead());
        assertFalse(WorkspaceMode.OFF.allowsWrite());
        assertFalse(WorkspaceMode.OFF.allowsExec());

        assertTrue(WorkspaceMode.READ.allowsRead());
        assertFalse(WorkspaceMode.READ.allowsWrite(), "只读档不得能写");
        assertFalse(WorkspaceMode.READ.allowsExec(), "只读档不得能执行");

        assertTrue(WorkspaceMode.WRITE.allowsRead(), "能写必然能读");
        assertTrue(WorkspaceMode.WRITE.allowsWrite());
        assertFalse(WorkspaceMode.WRITE.allowsExec(), "写档不得能执行 —— 执行是单独一档");

        assertTrue(WorkspaceMode.EXEC.allowsRead(), "能执行必然能读");
        assertTrue(WorkspaceMode.EXEC.allowsWrite(), "能执行必然能写");
        assertTrue(WorkspaceMode.EXEC.allowsExec());
    }

    /** 其余默认值也都是边界，不是随手填的。 */
    @Test
    void 其余默认值必须是收紧的一侧() {
        WorkspaceProperties props = new WorkspaceProperties();
        assertEquals("", props.getRoot(), "默认没有工作区根目录 —— 不指定就等于关闭");
        assertTrue(props.getMaxFileBytes() <= 1024 * 1024,
                "单文件上限不该大到能把一个 bundle 整个塞进模型上下文，实际 " + props.getMaxFileBytes());
        assertTrue(props.getMaxEntries() <= 2000,
                "列目录上限不该大到一个 node_modules 就能打满内存，实际 " + props.getMaxEntries());
        assertTrue(props.getExecTimeoutMs() <= 60_000,
                "执行超时不该长到一个死循环能占住机器，实际 " + props.getExecTimeoutMs() + "ms");
        assertFalse(props.getAllowedCommands().contains("sh"),
                "命令白名单里不得有 shell —— 有了它，白名单就等于没有");
        assertFalse(props.getAllowedCommands().contains("bash"));
        assertFalse(props.getAllowedExtensions().contains("env"),
                "扩展名白名单里不得有 env / pem / key 这类");
        assertFalse(props.getAllowedExtensions().contains("pem"));
        assertFalse(props.getAllowedExtensions().contains("key"));
    }
}
