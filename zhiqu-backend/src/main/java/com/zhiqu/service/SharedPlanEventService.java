package com.zhiqu.service;

import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

@Service
public class SharedPlanEventService {
    private static final long TIMEOUT_MS = 30 * 60 * 1000L;

    private final CopyOnWriteArrayList<SseEmitter> publicEmitters = new CopyOnWriteArrayList<>();
    private final CopyOnWriteArrayList<SseEmitter> adminEmitters = new CopyOnWriteArrayList<>();

    public SseEmitter subscribePublic() {
        return subscribe(publicEmitters, "shared-plan-ready");
    }

    public SseEmitter subscribeAdmin() {
        return subscribe(adminEmitters, "admin-ready");
    }

    public void broadcastSharedPlanChanged(String action, Long templateId) {
        Map<String, Object> payload = Map.of(
                "type", "SHARED_PLAN_CHANGED",
                "action", action,
                "templateId", templateId == null ? "" : templateId,
                "timestamp", System.currentTimeMillis()
        );
        send(publicEmitters, "shared-plan", payload);
        send(adminEmitters, "shared-plan", payload);
    }

    public void broadcastAdminChanged(String action) {
        Map<String, Object> payload = Map.of(
                "type", "ADMIN_CHANGED",
                "action", action,
                "timestamp", System.currentTimeMillis()
        );
        send(adminEmitters, "admin", payload);
    }

    private SseEmitter subscribe(CopyOnWriteArrayList<SseEmitter> emitters, String eventName) {
        SseEmitter emitter = new SseEmitter(TIMEOUT_MS);
        emitters.add(emitter);
        emitter.onCompletion(() -> emitters.remove(emitter));
        emitter.onTimeout(() -> emitters.remove(emitter));
        emitter.onError((ignored) -> emitters.remove(emitter));
        try {
            emitter.send(SseEmitter.event().name(eventName).data(Map.of("timestamp", System.currentTimeMillis())));
        } catch (IOException e) {
            emitters.remove(emitter);
        }
        return emitter;
    }

    private void send(CopyOnWriteArrayList<SseEmitter> emitters, String eventName, Map<String, Object> payload) {
        for (SseEmitter emitter : emitters) {
            try {
                emitter.send(SseEmitter.event().name(eventName).data(payload));
            } catch (IOException | IllegalStateException e) {
                emitters.remove(emitter);
            }
        }
    }
}
