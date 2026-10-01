package com.zhiqu.rag;

/**
 * Sidecar 以 HTTP 409 拒绝了一次「陈旧写入」——目标已被更新的删除/写入（墓碑）取代。
 *
 * <p>这不是故障：重试只会拿到同样的 409。调用方必须把作业置为终态（SUPERSEDED），
 * 而不是走失败重试链路，否则一次正常的「被删除操作覆盖」会被放大成
 * RETRY → DEAD → 整个索引代次 FAILED。
 *
 * <p>注意与 sidecar 的另一种 409（INDEX_VERSION_MISMATCH，索引版本不匹配）区分：
 * 那是配置错配，必须继续按普通错误上报，不能当成陈旧写入吞掉。
 */
public class StaleMutationException extends RuntimeException {
    public StaleMutationException(String message) {
        super(message);
    }
}
