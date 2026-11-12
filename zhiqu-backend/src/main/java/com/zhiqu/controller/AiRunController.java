package com.zhiqu.controller;

import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Result;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.AiWorkspaceService;
import com.zhiqu.service.support.ChatRunHub;
import com.zhiqu.service.support.SseHeartbeats;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.Map;

/**
 * 一轮回答的重连与补充（第一百三十三轮）。
 *
 * <h2>为什么另开一个控制器</h2>
 *
 * <p>这两个端点操作的是「已经在跑的那一轮」，不是「发一条新消息」。放在这里，{@code /api/ai/chat/stream}
 * 那边一个字都不用动，读代码的人也能一眼看出这是另一件事。
 *
 * <h2>重连</h2>
 *
 * <p>页面发完一条消息、切去别处、再回来时，用发送时拿到的 {@code agentRunId} 调
 * {@code GET /api/ai/runs/stream?runId=…&after=0}：服务端把这一轮已经发生过的事件按序重放一遍，
 * 然后接着直播。<b>生成从来没有停过</b> —— 停的只是那条浏览器连接。
 *
 * <p>{@code after} 是页面已经收到的最大序号；第一次接（页面刚回来）传 0，全量重放。
 *
 * <h2>补充</h2>
 *
 * <p>{@code POST /api/ai/runs/{id}/say} 把一句话补进这一轮的上下文 —— 用户按「立即」时走这里，
 * <b>不打断正在生成的回答</b>。回 {@code delivered=current} 表示模型下一次调用能看到；
 * {@code next} 表示这一轮已经在写最终回答、接不进去了，页面应当把它留在队列里等这一轮结束。
 */
@RestController
@RequestMapping("/api/ai/runs")
public class AiRunController {

    /** 补一句话的长度上限：这是给模型的补充信息，不是再发一篇文章。 */
    private static final int SAY_MAX_LENGTH = 4000;

    private final ChatRunHub chatRunHub;
    private final AiWorkspaceService aiWorkspaceService;
    private final SseHeartbeats heartbeats;

    public AiRunController(ChatRunHub chatRunHub, AiWorkspaceService aiWorkspaceService, SseHeartbeats heartbeats) {
        this.chatRunHub = chatRunHub;
        this.aiWorkspaceService = aiWorkspaceService;
        this.heartbeats = heartbeats;
    }

    @GetMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter reattach(@RequestParam Long runId, @RequestParam(defaultValue = "0") long after) {
        // 归属校验放在最前面：runId 是自增的，不查的话谁都能接上别人的回答
        aiWorkspaceService.getRun(SecurityUtils.getCurrentUserId(), runId);
        SseEmitter emitter = new SseEmitter(AiWorkspaceService.STREAM_TIMEOUT_MS);
        SseHeartbeats.Beat beat = heartbeats.start(emitter);
        emitter.onCompletion(beat::close);
        emitter.onTimeout(beat::close);
        emitter.onError(e -> beat.close());
        ChatRunHub.Attach attached = chatRunHub.attach(runId, emitter, Math.max(0, after));
        if (attached == ChatRunHub.Attach.GONE) {
            // 内存里没有这一轮了（服务重启过，或者早就跑完并清理了）：让页面回去读消息列表，
            // 不要在这儿挂着等一个永远不来的事件
            beat.close();
            try {
                emitter.send(SseEmitter.event().name("stream.gone")
                        .data("{\"reason\":\"expired\"}", MediaType.APPLICATION_JSON));
                emitter.complete();
            } catch (Exception ignored) {
                // 对面已经断了
            }
        }
        return emitter;
    }

    @PostMapping("/{runId}/say")
    public Result<Map<String, Object>> say(@PathVariable Long runId, @RequestBody Map<String, Object> body) {
        aiWorkspaceService.getRun(SecurityUtils.getCurrentUserId(), runId);
        String text = body == null || body.get("text") == null ? "" : String.valueOf(body.get("text")).trim();
        if (text.isEmpty()) {
            throw new BusinessException("不能发空消息");
        }
        if (text.length() > SAY_MAX_LENGTH) {
            text = text.substring(0, SAY_MAX_LENGTH);
        }
        return Result.success(Map.of("delivered", chatRunHub.say(runId, text)));
    }
}
