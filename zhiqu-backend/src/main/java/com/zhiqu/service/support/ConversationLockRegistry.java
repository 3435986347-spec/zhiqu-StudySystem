package com.zhiqu.service.support;

import org.springframework.stereotype.Component;

import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * 用户级会话互斥锁：串行化同一用户的「会话解析+消息落库 / 清空记忆 / 删除 Notebook」临界区，
 * 防止慢模型请求返回后向已被清空/删除的会话补写消息（复活会话时旧写入会诡异重现）。
 *
 * 实现为固定数量的条带锁（striped locks）：内存占用恒定，不随用户数增长；
 * 不同用户按 userId 取模可能共享同一条带，只带来偶发的无害串行，不影响正确性。
 *
 * 约定：先取锁、再开事务（TransactionTemplate），临界区内只做短 DB 操作，绝不在持锁期间等待模型。
 * 注意：JVM 内锁，适用于当前单实例部署；若未来多实例部署需替换为数据库行锁（SELECT ... FOR UPDATE）。
 */
@Component
public class ConversationLockRegistry {

    private static final int STRIPE_COUNT = 64;

    private final ReentrantLock[] stripes;

    public ConversationLockRegistry() {
        stripes = new ReentrantLock[STRIPE_COUNT];
        for (int i = 0; i < STRIPE_COUNT; i++) {
            stripes[i] = new ReentrantLock();
        }
    }

    private ReentrantLock lockFor(Long userId) {
        long id = userId == null ? 0L : userId;
        return stripes[(int) Math.floorMod(id, STRIPE_COUNT)];
    }

    public <T> T withUserLock(Long userId, Supplier<T> action) {
        ReentrantLock lock = lockFor(userId);
        lock.lock();
        try {
            return action.get();
        } finally {
            lock.unlock();
        }
    }

    public void runWithUserLock(Long userId, Runnable action) {
        withUserLock(userId, () -> {
            action.run();
            return null;
        });
    }
}
