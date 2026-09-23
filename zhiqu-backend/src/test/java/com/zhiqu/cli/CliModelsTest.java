package com.zhiqu.cli;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.SourceText;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * zhiqu 怎么选模型。
 *
 * <p>由来（2026-09-23）：用户问「CLI 的模型怎么配置」，查的时候发现 {@code /model} 是坏的 ——
 * {@code GET /api/ai/models} 返回的是对象，第一版把它当数组遍历，列出来是几行空白。
 * 顺带查出一个会静默失效的坑：选了不支持工具调用的模型，coding agent 根本不会运行，CLI 一个字不提。
 */
class CliModelsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** 与 AiServiceImpl.listModels 同形：对象，不是数组。 */
    private static JsonNode response() throws Exception {
        return JSON.readTree("""
                {"systemModels":[{"id":-1,"displayName":"系统模型","modelName":"sys-1","enabled":true,"toolCalling":true}],
                 "userModels":[
                   {"id":1,"displayName":"DeepseekV4pro","modelName":"deepseek-v4-pro","enabled":true,"isDefault":true,"toolCalling":true},
                   {"id":2,"displayName":"","modelName":"qwen2.5:7b","enabled":true,"toolCalling":false},
                   {"id":3,"displayName":"停用的","modelName":"x","enabled":false,"toolCalling":true}],
                 "defaultModelId":1,"webSearchAvailable":true}
                """);
    }

    @Test
    @DisplayName("拍平 {systemModels, userModels}：系统在前、停用的不列、没显示名用模型名")
    void 拍平模型列表() throws Exception {
        List<CliModels.Model> models = CliModels.parse(response());
        assertEquals(List.of(-1L, 1L, 2L), models.stream().map(CliModels.Model::id).toList(),
                "拍平结果不对 —— 当成数组遍历的话这里会是几个 0（第一版就是这样）");
        assertTrue(models.get(0).system());
        assertEquals("qwen2.5:7b", models.get(2).label(), "没有显示名时应当用模型名，而不是空白");
        assertTrue(models.get(2).knownNoToolCalling());
    }

    /**
     * 版本对不上时不许误报。2026-09-23 真遇到了这个场景：用户的后端是更早由 zhiqu 拉起的旧版，
     * 装上新 CLI 之后，模型信息里还没有 toolCalling 字段 —— 当成「不支持」就会对 DeepSeek 报警。
     */
    @Test
    @DisplayName("后端没给 toolCalling（旧版本）时算「不知道」，不报「不支持」")
    void 旧后端不误报() throws Exception {
        JsonNode old = JSON.readTree("{\"userModels\":[{\"id\":1,\"displayName\":\"DeepseekV4pro\",\"enabled\":true}],\"defaultModelId\":1}");
        CliModels.Model m = CliModels.effective(CliModels.parse(old), null);
        assertNull(m.toolCalling(), "没给的字段应当是 null（不知道），而不是 false");
        assertFalse(m.knownNoToolCalling(), "旧后端没说，却被当成了「不支持」—— 会对一个能用的模型报警");
    }

    @Test
    @DisplayName("没指定就用 defaultModelId 那一个；指定了不存在的 id 返回 null（调用方要拒绝）")
    void 实际用哪个模型() throws Exception {
        List<CliModels.Model> models = CliModels.parse(response());
        assertEquals(1L, CliModels.effective(models, null).id(), "默认模型认错了");
        assertEquals(2L, CliModels.effective(models, 2L).id());
        assertNull(CliModels.effective(models, 99L), "不存在的 id 应当返回 null —— 否则会发出一个后端必拒的请求");
        assertNull(CliModels.effective(models, 3L), "停用的模型不该被选中");
    }

    /**
     * 「支不支持工具调用」只在后端判一次（{@code ModelProviderClient.supportsToolCalling}），
     * 经模型信息的 {@code toolCalling} 字段交给客户端。CLI 按 providerType 自己再猜一遍就是第二份真相 ——
     * 后端哪天让 Gemini 支持了工具调用，CLI 还在警告「不支持」。
     */
    @Test
    @DisplayName("toolCalling 由后端 supportsToolCalling 给出；CLI 不按 providerType 自己猜")
    void 工具调用判定只有一处() throws Exception {
        String service = SourceText.stripComments(Files.readString(
                Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java"), StandardCharsets.UTF_8));
        assertTrue(service.contains("row.put(\"toolCalling\", provider.supportsToolCalling(model));"),
                "模型信息里没有带上 toolCalling，或者不是由 supportsToolCalling 给出的");
        for (String f : List.of("CliModels.java", "ZhiquCli.java")) {
            String cli = SourceText.stripComments(Files.readString(
                    Path.of("src/main/java/com/zhiqu/cli", f), StandardCharsets.UTF_8));
            assertTrue(cli.length() > 500, f + " 读空了");
            assertFalse(cli.contains("OLLAMA") || cli.contains("GEMINI") || cli.contains("providerType"),
                    f + " 在按 providerType 自己判断能力 —— 应当只读后端给的 toolCalling");
        }
    }
}
