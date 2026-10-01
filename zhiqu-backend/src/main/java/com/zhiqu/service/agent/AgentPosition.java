package com.zhiqu.service.agent;

/**
 * 一个动作在流水线上的位置：<b>相位 + 相位内次序</b>，不可分。
 *
 * <p><b>为什么做成值对象而不是两个标量方法</b>：runner 要声明三个位置
 * （宣告 / 工作 / 落库），若写成 {@code announcePhase()} + {@code announceOrder()} 六个散方法，
 * 就可以「只覆盖一半」—— 改了相位忘了次序，宣告落在半路，而没有任何判据会红。
 * 位置整体返回则覆盖不了一半。
 */
public record AgentPosition(AgentPhase phase, int order) implements Comparable<AgentPosition> {

    public static AgentPosition at(AgentPhase phase, int order) {
        return new AgentPosition(phase, order);
    }

    @Override
    public int compareTo(AgentPosition other) {
        int byPhase = phase.compareTo(other.phase);
        return byPhase != 0 ? byPhase : Integer.compare(order, other.order);
    }

    @Override
    public String toString() {
        return phase + "#" + order;
    }
}
