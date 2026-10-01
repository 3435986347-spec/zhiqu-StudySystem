package com.zhiqu.common;

/**
 * 同一个 {@code Idempotency-Key} 的上一次还在处理（第二十二轮）。和别的业务错误分开，回 code 409：
 * 页面据此知道「那一次还没做完，等一下用同一个键再来」，而不是「失败了」—— 回应丢了、超时之后自动重来时正好会撞上它。
 */
public class RequestInProgressException extends BusinessException {
    public RequestInProgressException(String message) {
        super(message);
    }
}
