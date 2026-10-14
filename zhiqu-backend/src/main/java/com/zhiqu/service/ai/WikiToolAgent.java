package com.zhiqu.service.ai;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.KnowledgePageSnapshot;
import com.zhiqu.service.KnowledgeService;
import com.zhiqu.service.agent.AgentPlanDecision;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 知识 Wiki 的工具循环 —— 拆 {@code AiServiceImpl} 的第二刀。
 *
 * <h2>为什么它该独立成一个类</h2>
 *
 * <p>它是一个<b>完整的小系统</b>：自己的工具声明、自己的执行器、自己的循环状态
 * （读过哪些页、快照、本轮已提过哪些草稿），以及一整套只对它有意义的防护。
 * 这些东西和「聊天怎么流式输出」「计划怎么解析」放在同一个文件里，
 * 唯一的后果就是谁都不敢单独改其中一块。
 *
 * <h2>这里面的防护不是装饰，每一条都挡着一种真实的丢数据</h2>
 *
 * <ul>
 *   <li><b>未完整读取不许整页覆盖</b> —— 写工具只能整页 UPSERT。没读全就写，
 *       等于拿模型脑子里的版本覆盖用户积累的那一页。薄弱点页尤其致命，它是累积的。</li>
 *   <li><b>保留页不许改</b> —— index / log / Wiki 维护规则是系统页。</li>
 *   <li><b>本轮幂等</b> —— 同一标题在一个循环里只生成一份草稿。</li>
 *   <li><b>按「用户+标题」分桶加锁</b> —— 锁内「查已存在 PENDING → 创建」，
 *       防两个并发请求各查不到、各插一条。注意这是<b>进程内</b>条带锁：
 *       横向扩容之后它不再成立，要改成 DB 唯一约束或分布式锁。</li>
 *   <li><b>可信快照</b> —— 基线不走公共请求体，杜绝伪造。</li>
 * </ul>
 *
 * <p>草稿只进「待合入变更」队列，用户确认后才落库 —— 与计划、记忆、代码改动同一条纪律。
 */
@Component
public class WikiToolAgent {
    private static final Logger log = LoggerFactory.getLogger(WikiToolAgent.class);

    private final KnowledgeService knowledgeService;
    private final ModelProviderClient provider;
    private final ObjectMapper objectMapper;

    public WikiToolAgent(KnowledgeService knowledgeService, ModelProviderClient provider, ObjectMapper objectMapper) {
        this.knowledgeService = knowledgeService;
        this.provider = provider;
        this.objectMapper = objectMapper;
    }

    private static boolean hasText(String value) {
        return org.springframework.util.StringUtils.hasText(value);
    }

    /** read_wiki_page 可完整返回的正文上限；超过则视为“未完整读取”，该页禁止整页覆盖。 */
    static final int WIKI_READ_FULL_LIMIT = 16000;

    /** 注入最终回答的 Wiki 上下文上限：留出单页完整正文 + 检索结果/包装文本的余量。 */
    static final int WIKI_CONTEXT_LIMIT = 20000;

    /**
     * 覆盖写安全判定（代码级根治，不依赖提示词）：对“已存在的页”，只有本轮【完整读取过】才允许整页覆盖；
     * 未读取、或读取被截断（未进入 fullyReadTitles）一律拒绝，避免模型据不全/凭空内容覆盖导致确认后丢失。
     * 新建页（调用方 existing==null）不走此判定。
     */
    static boolean refuseExistingPageOverwrite(java.util.Set<String> fullyReadTitles, String normTitle) {
        return fullyReadTitles == null || !fullyReadTitles.contains(normTitle);
    }

    /** 一次工具循环内的可变状态：本轮【完整读取过】的页标题、已生成草稿的页标题（用于防丢与幂等）。 */
    public static final class WikiLoopState {
        final java.util.Set<String> fullyReadTitles = new java.util.HashSet<>();
        final java.util.Set<String> patchedTitles = new java.util.HashSet<>();
        final java.util.Map<String, Long> pendingPatchIdsByTitle = new LinkedHashMap<>();
        // 完整读取时捕获同一查询返回的规范化正文、哈希和页面版本，后续创建草稿不再二次查询。
        final java.util.Map<String, KnowledgePageSnapshot> readSnapshots = new java.util.HashMap<>();
    }

    // create_wiki_patch 幂等的进程内条带锁：按 用户+标题 哈希分桶，锁内“查已存在 PENDING → 创建”避免并发双插。
    private static final int WIKI_PATCH_STRIPES = 64;

    private final Object[] wikiPatchLocks = java.util.stream.IntStream.range(0, WIKI_PATCH_STRIPES)
            .mapToObj(i -> new Object()).toArray();

    private Object wikiPatchLock(Long userId, String normTitle) {
        return wikiPatchLocks[Math.floorMod(java.util.Objects.hash(userId, normTitle), WIKI_PATCH_STRIPES)];
    }

    private String normWikiTitle(String t) {
        return t == null ? "" : t.trim().toLowerCase(Locale.ROOT);
    }

    /** 工具循环的产出：注入最终回答的上下文 + 是否已生成待合入草稿（用于对 WIKI_DRAFT 工件去重）。 */
    public static final class WikiAgentResult {
        public final String context;
        public final boolean wrotePatch;
        public final boolean writeRequested;
        public final List<Long> pendingPatchIds;
        WikiAgentResult(String context, boolean writeRequested, List<Long> pendingPatchIds) {
            this.context = context;
            this.writeRequested = writeRequested;
            this.pendingPatchIds = List.copyOf(pendingPatchIds);
            this.wrotePatch = !this.pendingPatchIds.isEmpty();
        }
        static final WikiAgentResult EMPTY = new WikiAgentResult("", false, List.of());
    }

    /** 单个 Wiki 工具的执行结果：回给模型的文本 + 是否已落「待合入变更」草稿。 */
    public static final class WikiToolExecution {
        public final String result;
        public final boolean wrotePatch;
        public final Long patchSetId;
        private WikiToolExecution(String result, Long patchSetId) {
            this.result = result;
            this.patchSetId = patchSetId;
            this.wrotePatch = patchSetId != null;
        }
        static WikiToolExecution read(String result) {
            return new WikiToolExecution(result, null);
        }
        static WikiToolExecution wrote(String result, Long patchSetId) {
            return new WikiToolExecution(result, patchSetId);
        }
    }

    public WikiAgentResult runWikiToolAgent(AiModelConfig config, Long userId, String userMessage) {
        return runWikiToolAgent(config, userId, userMessage, WIKI_CONTEXT_LIMIT);
    }

    /** 同上；{@code contextLimit} 由模型的上下文窗口决定（见 ContextBudget）。 */
    public WikiAgentResult runWikiToolAgent(AiModelConfig config, Long userId, String userMessage, int contextLimit) {
        boolean canWrite = AgentPlanDecision.wikiWriteIntent(userMessage);
        if (!AgentPlanDecision.wikiToolIntent(userMessage) || !provider.supportsToolCalling(config)) {
            return canWrite ? new WikiAgentResult("", true, List.of()) : WikiAgentResult.EMPTY;
        }
        if (provider.isAnthropicProvider(config)) {
            return runWikiToolAgentAnthropic(config, userId, userMessage, contextLimit);
        }
        StringBuilder context = new StringBuilder();
        boolean wrotePatch = false;
        WikiLoopState state = new WikiLoopState();
        try {
            // 最小权限：只有明确写意图才提供写工具，纯查询请求拿不到 create_wiki_patch，避免误写。
            boolean reminded = false;
            List<Map<String, Object>> messages = new ArrayList<>();
            messages.add(Map.of("role", "system", "content", getWikiToolSystemPrompt()));
            messages.add(Map.of("role", "user", "content", userMessage));
            List<Map<String, Object>> tools = buildWikiTools(canWrite);
            long loopStart = System.currentTimeMillis();
            for (int round = 0; round < 4; round++) {
                // 墙钟预算（软限）：每轮开始前检查，累计超 30s 不再发起新一轮。末轮可能在第 ~30s 才启动，
                // 叠加单轮 连接10s+读取25s（toolTurnRestTemplate）后最坏约 65s（另加 DNS/本地执行）；仍远小于 300s SSE 总超时。
                if (System.currentTimeMillis() - loopStart > 30_000L) {
                    log.warn("Wiki 工具循环超时预算，提前结束 userId={} round={}", userId, round);
                    break;
                }
                JsonNode message = provider.callOpenAiToolTurn(config, messages, tools);
                if (message == null) {
                    break;
                }
                // 原样回填助手轮（含 tool_calls），作为下一轮上下文
                messages.add(objectMapper.convertValue(message, new TypeReference<Map<String, Object>>() {}));
                JsonNode toolCalls = message.path("tool_calls");
                if (!toolCalls.isArray() || toolCalls.isEmpty()) {
                    if (canWrite && !wrotePatch && !reminded && round < 3) {
                        messages.add(Map.of("role", "user", "content", missingWikiWriteReminder()));
                        reminded = true;
                        continue;
                    }
                    break; // 模型给出最终答复，结束工具循环
                }
                for (JsonNode call : toolCalls) {
                    String name = call.at("/function/name").asText("");
                    JsonNode argsNode = call.at("/function/arguments");
                    String argsRaw = argsNode.isTextual() ? argsNode.asText("") : (argsNode.isMissingNode() ? "{}" : argsNode.toString());
                    WikiToolExecution exec = !canWrite && "create_wiki_patch".equals(name)
                            ? WikiToolExecution.read("本轮是只读查询，未授权创建 Wiki 待合入变更。")
                            : executeWikiTool(userId, name, argsRaw, state);
                    if (exec.wrotePatch) {
                        wrotePatch = true;
                    }
                    if (hasText(exec.result)) {
                        context.append("【Wiki ").append(name).append("】\n").append(exec.result).append("\n\n");
                    }
                    Map<String, Object> toolMsg = new LinkedHashMap<>();
                    toolMsg.put("role", "tool");
                    toolMsg.put("tool_call_id", call.path("id").asText(""));
                    toolMsg.put("name", name);
                    toolMsg.put("content", exec.result);
                    messages.add(toolMsg);
                }
            }
        } catch (Exception e) {
            log.warn("Wiki 工具循环失败（不影响主回答） userId={} err={}", userId, e.getMessage());
        }
        return new WikiAgentResult(com.zhiqu.common.Texts.limitRaw(context.toString(), contextLimit), canWrite,
                new ArrayList<>(state.pendingPatchIdsByTitle.values()));
    }

    /** Anthropic 原生工具循环版：读工具→tool_result 回填→最终答复，与 OpenAI 版等价但用 Anthropic 协议。 */
    private WikiAgentResult runWikiToolAgentAnthropic(AiModelConfig config, Long userId, String userMessage, int contextLimit) {
        StringBuilder context = new StringBuilder();
        boolean wrotePatch = false;
        boolean canWrite = AgentPlanDecision.wikiWriteIntent(userMessage);
        WikiLoopState state = new WikiLoopState();
        try {
            boolean reminded = false;
            List<Map<String, Object>> messages = new ArrayList<>();
            messages.add(Map.of("role", "user", "content", userMessage));
            List<Map<String, Object>> tools = provider.toAnthropicTools(buildWikiTools(canWrite));
            String system = getWikiToolSystemPrompt();
            long loopStart = System.currentTimeMillis();
            for (int round = 0; round < 4; round++) {
                if (System.currentTimeMillis() - loopStart > 30_000L) {
                    log.warn("Wiki 工具循环(Anthropic)超时预算，提前结束 userId={} round={}", userId, round);
                    break;
                }
                JsonNode content = provider.callAnthropicToolTurn(config, system, messages, tools);
                if (content == null || !content.isArray()) {
                    break;
                }
                List<Object> assistantBlocks = new ArrayList<>();
                List<JsonNode> toolUses = new ArrayList<>();
                for (JsonNode block : content) {
                    assistantBlocks.add(objectMapper.convertValue(block, new TypeReference<Map<String, Object>>() {}));
                    if ("tool_use".equals(block.path("type").asText(""))) {
                        toolUses.add(block);
                    }
                }
                messages.add(Map.of("role", "assistant", "content", assistantBlocks));
                if (toolUses.isEmpty()) {
                    if (canWrite && !wrotePatch && !reminded && round < 3) {
                        messages.add(Map.of("role", "user", "content", missingWikiWriteReminder()));
                        reminded = true;
                        continue;
                    }
                    break; // 模型给出最终答复，结束工具循环
                }
                List<Object> toolResults = new ArrayList<>();
                for (JsonNode call : toolUses) {
                    String name = call.path("name").asText("");
                    JsonNode input = call.path("input");
                    String argsRaw = input.isMissingNode() ? "{}" : input.toString();
                    WikiToolExecution exec = !canWrite && "create_wiki_patch".equals(name)
                            ? WikiToolExecution.read("本轮是只读查询，未授权创建 Wiki 待合入变更。")
                            : executeWikiTool(userId, name, argsRaw, state);
                    if (exec.wrotePatch) {
                        wrotePatch = true;
                    }
                    if (hasText(exec.result)) {
                        context.append("【Wiki ").append(name).append("】\n").append(exec.result).append("\n\n");
                    }
                    Map<String, Object> toolResult = new LinkedHashMap<>();
                    toolResult.put("type", "tool_result");
                    toolResult.put("tool_use_id", call.path("id").asText(""));
                    toolResult.put("content", exec.result == null ? "" : exec.result);
                    toolResults.add(toolResult);
                }
                messages.add(Map.of("role", "user", "content", toolResults));
            }
        } catch (Exception e) {
            log.warn("Wiki 工具循环(Anthropic)失败（不影响主回答） userId={} err={}", userId, e.getMessage());
        }
        return new WikiAgentResult(com.zhiqu.common.Texts.limitRaw(context.toString(), contextLimit), canWrite,
                new ArrayList<>(state.pendingPatchIdsByTitle.values()));
    }

    private String missingWikiWriteReminder() {
        return "用户要求实际生成 Wiki 待合入变更，但本轮尚未收到真实 PatchSet 回执。聊天中贴出草稿或声称完成不算提交。"
                + "若已有用户提供的必要内容，请实际调用 create_wiki_patch；修改已有页仍须先完整读取。"
                + "信息不足时说明需要补充什么，不要编造内容；系统页 index/log 不可直接修改。"
                + "若工具失败或没有 PENDING 编号，请如实说明未创建，不得声称保存或更新成功。";
    }

    /**
     * Wiki 这一套工具的名字 —— <b>唯一定义</b>。
     *
     * <p>code agent 要把这几个名字的调用原样转交给 {@link #executeWikiTool}。它原来自己手写了一份
     * 名单，旁边注释「与 buildWikiTools 的声明保持一致」—— 靠注释维持的一致就是第二份真相。
     * {@code WikiToolAgentNamesTest} 拿 {@link #buildWikiTools} 真实声明出来的名字和它比。
     */
    public static final java.util.Set<String> TOOL_NAMES = java.util.Set.of("search_wiki", "read_wiki_page", "create_wiki_patch");

    public static boolean isWikiTool(String name) {
        return TOOL_NAMES.contains(name);
    }

    public List<Map<String, Object>> buildWikiTools(boolean includeWrite) {
        List<Map<String, Object>> tools = new ArrayList<>();
        Map<String, Object> searchProps = new LinkedHashMap<>();
        searchProps.put("query", ToolSchemas.schemaProp("string", "检索关键词，匹配标题、摘要、正文和页面类型；空格分开的几个词都要中。可以留空"));
        searchProps.put("type", ToolSchemas.schemaProp("string", "只看这一类页面：" + com.zhiqu.common.WikiPageTypes.choices() + "，代码或中文名都行。可以不填"));
        tools.add(ToolSchemas.functionTool("search_wiki",
                "在用户自己的知识 Wiki 里检索页面，返回匹配到的页面标题、类型与摘要，以及一共匹配了几页。涉及用户已有笔记/计划/目标/偏好时先检索。"
                        + "要看某一类的全部页面（比如用户问「我有哪些目标 / 计划」）：type 填那一类、query 留空 —— 目标页的标题和正文里不一定写着「目标」两个字。",
                searchProps, List.of()));

        Map<String, Object> readProps = new LinkedHashMap<>();
        readProps.put("title", ToolSchemas.schemaProp("string", "要读取的页面标题（需与检索结果中的标题一致）"));
        tools.add(ToolSchemas.functionTool("read_wiki_page",
                "读取指定标题页面的完整正文，用于在编辑前了解现有内容或引用细节。",
                readProps, List.of("title")));

        // 最小权限：仅在明确写意图时提供写工具，纯查询请求不暴露 create_wiki_patch。
        if (includeWrite) {
            Map<String, Object> patchProps = new LinkedHashMap<>();
            patchProps.put("title", ToolSchemas.schemaProp("string", "目标页面标题；标题已存在则视为更新该页，否则新建"));
            patchProps.put("content", ToolSchemas.schemaProp("string", "页面的完整 Markdown 正文（会整页覆盖，不要只给片段）"));
            patchProps.put("pageType", ToolSchemas.schemaProp("string", "GOAL/PROJECT/PREFERENCE/WEAKNESS/RESOURCE/MEMORY/NOTE，默认 NOTE"));
            tools.add(ToolSchemas.functionTool("create_wiki_patch",
                    "把对知识 Wiki 的新增或修改生成为“待合入变更”草稿，交用户在审核面板确认后才落库（不会直接改库）。系统页 index/log/维护规则不可修改。",
                    patchProps, List.of("title", "content")));
        }
        return tools;
    }

    /** search_wiki 一次最多列出的页数；没列全时结果里照实说一共几页 */
    static final int SEARCH_LIMIT = 20;

    /**
     * search_wiki：关键词（按空格拆开，每个都要中）匹配标题、摘要、正文和页面类型（代码与中文名）；type 只看那一类。
     * 第四十五轮之前只拿整串关键词匹配标题、摘要、正文：页面类型不在里面，按「目标」「GOAL」搜不到一页叫「27考研」的目标页，
     * 也没有「列出某一类全部页面」的办法 —— 用户问「我有哪些计划」，模型搜了三次，回答「Wiki 里没有目标或项目类的页面」。
     */
    Map<String, Object> searchWiki(Long userId, Map<String, Object> args) {
        String query = String.valueOf(com.zhiqu.common.Texts.orDefault(args.get("query"), "")).trim().toLowerCase(Locale.ROOT);
        String typeArg = String.valueOf(com.zhiqu.common.Texts.orDefault(args.get("type"), "")).trim();
        String wantLabel = null;
        if (!typeArg.isEmpty()) {
            wantLabel = com.zhiqu.common.WikiPageTypes.parse(typeArg);
            if (wantLabel == null) {
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("error", "不认识的页面类型「" + typeArg + "」。可用的：" + com.zhiqu.common.WikiPageTypes.choices());
                return err;
            }
        }
        // 按 [\s\u3000] 拆：中文输入法打出来的全角空格（U+3000）不在 \s 里 —— 「27　考研」会被当成一个词，又搜不到（第四十七轮 review）。
        // 两头的全角空格不用另外去：拆出来的空串哪一页都「中」
        String[] words = query.isEmpty() ? new String[0] : query.split("[\\s\\u3000]+");
        List<Map<String, Object>> hits = new ArrayList<>();
        int total = 0;
        for (Map<String, Object> p : knowledgeService.listPages(userId)) {
            String type = String.valueOf(com.zhiqu.common.Texts.orDefault(p.get("pageType"), "NOTE"));
            String label = com.zhiqu.common.WikiPageTypes.label(type);
            if (wantLabel != null && !wantLabel.equals(label)) continue;
            String title = String.valueOf(com.zhiqu.common.Texts.orDefault(p.get("title"), ""));
            String summary = String.valueOf(com.zhiqu.common.Texts.orDefault(p.get("summary"), ""));
            String content = String.valueOf(com.zhiqu.common.Texts.orDefault(p.get("content"), ""));
            String hay = (title + " " + summary + " " + content + " " + type + " " + label).toLowerCase(Locale.ROOT);
            boolean all = true;
            for (String w : words) {
                if (!hay.contains(w)) { all = false; break; }
            }
            if (!all) continue;
            total++;
            if (hits.size() < SEARCH_LIMIT) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("title", title);
                row.put("type", type);
                row.put("typeLabel", label);
                row.put("summary", com.zhiqu.common.Texts.limitCollapsed(summary, 120));
                hits.add(row);
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("count", hits.size());
        out.put("total", total);
        out.put("pages", hits);
        if (total > hits.size()) {
            out.put("note", "一共 " + total + " 页匹配，只列出了前 " + hits.size() + " 页；要找具体的一页请换更具体的关键词或加上 type");
        }
        return out;
    }

    /** 执行一个 Wiki 工具，返回给模型的文本结果 + 是否落草稿。所有读写都按显式 userId 隔离。 */
    public WikiToolExecution executeWikiTool(Long userId, String name, String argsJson, WikiLoopState state) {
        Map<String, Object> args;
        try {
            args = objectMapper.readValue(hasText(argsJson) ? argsJson : "{}", new TypeReference<Map<String, Object>>() {});
        } catch (Exception e) {
            return WikiToolExecution.read("参数解析失败：" + e.getMessage());
        }
        try {
            switch (name == null ? "" : name) {
                case "search_wiki": {
                    return WikiToolExecution.read(objectMapper.writeValueAsString(searchWiki(userId, args)));
                }
                case "read_wiki_page": {
                    String title = String.valueOf(com.zhiqu.common.Texts.orDefault(args.get("title"), "")).trim();
                    KnowledgePageSnapshot snapshot = knowledgeService.findPageSnapshotByTitle(userId, title);
                    if (snapshot == null) {
                        return WikiToolExecution.read("未找到标题为「" + title + "」的页面，可先用 search_wiki 确认标题。");
                    }
                    // 放宽截断上限，覆盖绝大多数真实页面；仅在“完整读取（未截断）”时记录该页，
                    // 作为 create_wiki_patch 允许整页覆盖的必要前提（未读/截断读都不会进入该集合）。
                    String pageTitle = snapshot.title();
                    String full = snapshot.content();
                    boolean truncated = full.length() > WIKI_READ_FULL_LIMIT;
                    if (!truncated) {
                        String normRead = normWikiTitle(pageTitle);
                        state.fullyReadTitles.add(normRead);
                        state.readSnapshots.put(normRead, snapshot);
                    }
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("title", snapshot.title());
                    row.put("type", com.zhiqu.common.Texts.orDefault(snapshot.pageType(), "NOTE"));
                    row.put("content", truncated ? full.substring(0, WIKI_READ_FULL_LIMIT) : full);
                    row.put("truncated", truncated);
                    return WikiToolExecution.read(objectMapper.writeValueAsString(row));
                }
                case "create_wiki_patch": {
                    String title = String.valueOf(com.zhiqu.common.Texts.orDefault(args.get("title"), "")).trim();
                    String content = String.valueOf(com.zhiqu.common.Texts.orDefault(args.get("content"), "")).trim();
                    if (title.isEmpty() || content.isEmpty()) {
                        return WikiToolExecution.read("title 和 content 不能为空。");
                    }
                    if (isReservedWikiTitle(title)) {
                        return WikiToolExecution.read("系统页（index / log / Wiki 维护规则）不允许通过工具修改。");
                    }
                    String requestedNorm = normWikiTitle(title);
                    KnowledgePageSnapshot readSnapshot = state.readSnapshots.get(requestedNorm);
                    KnowledgePageSnapshot existing = readSnapshot != null
                            ? readSnapshot
                            : knowledgeService.findPageSnapshotByTitle(userId, title);
                    String norm = existing != null ? normWikiTitle(existing.title()) : requestedNorm;
                    // P1 防丢：已存在的页只有本轮【完整读取过】才允许整页覆盖（未读/截断读都拒绝），杜绝跳过 read 直接覆盖。
                    if (existing != null && refuseExistingPageOverwrite(state.fullyReadTitles, norm)) {
                        return WikiToolExecution.read("目标页「" + title + "」本轮未完整读取，为避免整页覆盖丢失内容，未生成草稿；"
                                + "请先用 read_wiki_page 读取全文再修改，或让用户手动编辑该页。");
                    }
                    // P1 幂等（本轮）：同一循环内已为该标题生成过草稿，不重复创建。
                    if (state.patchedTitles.contains(norm)) {
                        Long confirmedId = state.pendingPatchIdsByTitle.get(norm);
                        return confirmedId == null ? WikiToolExecution.read("本轮同名草稿状态未确认，请到待合入面板核实。")
                                : WikiToolExecution.wrote("本轮已确认「" + title + "」的待合入草稿（#" + confirmedId + "，PENDING），未重复创建。", confirmedId);
                    }
                    // P1 幂等 + 并发安全：按 用户+标题 加锁，锁内“查已存在 PENDING → 创建”，防两个并发请求同时查不到各自插入。
                    // 注：进程内条带锁，适用于当前单实例部署；横向扩容需改 DB 唯一约束 / 分布式锁 / Idempotency-Key。
                    synchronized (wikiPatchLock(userId, norm)) {
                        for (Map<String, Object> ps : knowledgeService.listPatchSets(userId, "PENDING")) {
                            if (norm.equals(normWikiTitle(String.valueOf(com.zhiqu.common.Texts.orDefault(ps.get("title"), ""))))) {
                                Long confirmedId = pendingPatchId(ps);
                                if (confirmedId == null) return WikiToolExecution.read("已存在同名变更，但其 PENDING 编号未确认；未重复创建，请到待合入面板核实。");
                                state.patchedTitles.add(norm);
                                state.pendingPatchIdsByTitle.put(norm, confirmedId);
                                return WikiToolExecution.wrote("已存在同名「待合入变更」草稿（#" + confirmedId
                                        + "，PENDING），未重复创建；请先到审核面板处理。", confirmedId);
                            }
                        }
                        Map<String, Object> item = new LinkedHashMap<>();
                        item.put("actionType", "UPSERT");
                        item.put("title", title);
                        item.put("content", content);
                        item.put("pageType", String.valueOf(com.zhiqu.common.Texts.orDefault(args.get("pageType"), "NOTE")).toUpperCase(Locale.ROOT));
                        // 读取快照基准通过服务端内部 3 参方法可信传入（不进公共请求体，杜绝伪造），
                        // 键为目标 pageId；已有页必须在本轮完整读取过，可信快照来自 readSnapshots。
                        Map<Long, KnowledgePageSnapshot> trustedSnapshots = new java.util.HashMap<>();
                        if (existing != null) {
                            item.put("pageId", existing.pageId());
                            KnowledgePageSnapshot trusted = state.readSnapshots.get(norm);
                            if (trusted != null) trustedSnapshots.put(trusted.pageId(), trusted);
                        }
                        Map<String, Object> patchBody = new LinkedHashMap<>();
                        patchBody.put("title", title);
                        patchBody.put("summary", "AI 工具建议的 Wiki 变更：" + title);
                        patchBody.put("triggerType", "AGENT");
                        patchBody.put("items", List.of(item));
                        Map<String, Object> receipt = knowledgeService.createPatchSet(userId, patchBody, trustedSnapshots);
                        Long confirmedId = pendingPatchId(receipt);
                        if (confirmedId == null) return WikiToolExecution.read("创建结果未确认：服务未返回真实的 PENDING 变更编号；请到待合入面板核实，不能声称已保存。");
                        state.patchedTitles.add(norm);
                        state.pendingPatchIdsByTitle.put(norm, confirmedId);
                        return WikiToolExecution.wrote("已生成「待合入变更」草稿（#" + confirmedId + "，PENDING）：" + title
                                + (existing != null ? "（更新现有页）" : "（新建页）")
                                + "。请到知识 Wiki 的“待合入变更”面板确认后落库；index/log 会在用户合入后由系统自动维护。", confirmedId);
                    }
                }
                default:
                    return WikiToolExecution.read("未知工具：" + name);
            }
        } catch (Exception e) {
            return WikiToolExecution.read("工具执行失败：" + e.getMessage());
        }
    }

    private boolean isReservedWikiTitle(String title) {
        String t = title == null ? "" : title.trim();
        return "index".equalsIgnoreCase(t) || "log".equalsIgnoreCase(t) || "Wiki 维护规则".equals(t);
    }

    /** Service receipts, never model claims, establish that a reviewable draft exists. */
    private Long pendingPatchId(Map<String, Object> receipt) {
        if (receipt == null || !"PENDING".equals(receipt.get("status")) || receipt.get("id") == null) return null;
        try {
            long id = new java.math.BigDecimal(String.valueOf(receipt.get("id"))).longValueExact();
            return id > 0 ? id : null;
        } catch (RuntimeException invalidId) { return null; }
    }

    private String getWikiToolSystemPrompt() {
        return """
                你是「知趣·象限」的知识 Wiki 助理。你可以调用工具读取和修改用户自己的知识 Wiki：
                - search_wiki(query, type)：按关键词和 / 或页面类型检索用户的 Wiki 页面；要看某一类的全部页面（目标、计划……）就只给 type、query 留空。
                - read_wiki_page(title)：读取某页完整正文。
                - create_wiki_patch(title, content, pageType?)：把新增/修改生成为“待合入变更”草稿，用户确认后才落库。

                要求：
                - 需要引用或修改用户已有内容时，先 search_wiki，再按需 read_wiki_page，最后才 create_wiki_patch，避免凭空覆盖。
                - 修改页面时 content 必须是整页的完整 Markdown（工具会整页覆盖），不要只给片段。
                - 若 read_wiki_page 返回 truncated=true，说明页面过长未完整给出，请勿整页覆盖，改为提示用户手动编辑该页。
                - 系统页 index / log / Wiki 维护规则 不可修改；index/log 由系统在用户确认合入后自动维护。
                - 只有用户明确想记录/整理/更新到 Wiki 时才写；只是提问或闲聊则只读或不调用工具。
                - 用户要求生成/创建 Wiki 内容时，要实际调用 create_wiki_patch。只有工具返回真实 PENDING 编号才算有待合入草稿；聊天里贴文本不等于保存。
                - 完成后用一两句中文说明你查到了什么、生成了哪些待确认草稿。
                """;
    }
}
