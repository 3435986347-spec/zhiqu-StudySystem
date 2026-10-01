package com.zhiqu.service.agent;

/** 一条待发的 SSE 事件。COMMIT 相位缓冲的就是它，事务提交后按序补发。 */
public record AgentSseEvent(String name, Object payload) {
}
