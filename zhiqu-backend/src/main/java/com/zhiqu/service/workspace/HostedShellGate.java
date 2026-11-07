package com.zhiqu.service.workspace;

import com.zhiqu.common.BusinessException;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * 服务器上同时跑几条命令（第一百一十七轮）。服务器只有 2 核 1.9G，后端和 MySQL 还要活：全站有个总数，一个账号一次一条。
 * 等一小会儿，还轮不到就直说，不让模型的一轮一直挂着。
 */
public final class HostedShellGate {

    private final Semaphore all;
    private final long waitMillis;
    private final ConcurrentHashMap<Long, Semaphore> accounts = new ConcurrentHashMap<>();

    public HostedShellGate(int slots, long waitMillis) {
        this.all = new Semaphore(Math.max(1, slots), true);
        this.waitMillis = waitMillis;
    }

    /** 轮到了返回一个要关上的句柄；轮不到抛 BusinessException，这条命令就没有运行 */
    public AutoCloseable enter(Long userId) {
        Semaphore mine = accounts.computeIfAbsent(userId, id -> new Semaphore(1, true));
        try {
            if (!mine.tryAcquire(waitMillis, TimeUnit.MILLISECONDS)) {
                throw new BusinessException("你还有一条命令在跑，这条没有运行，等它跑完再试");
            }
            boolean entered = false;
            try {
                if (!all.tryAcquire(waitMillis, TimeUnit.MILLISECONDS)) {
                    throw new BusinessException("服务器上同时跑的命令太多，这条没有运行，等一会儿再试");
                }
                entered = true;
            } finally {
                if (!entered) {
                    mine.release();
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BusinessException("执行被中断");
        }
        return () -> {
            all.release();
            mine.release();
        };
    }
}
