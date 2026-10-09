package com.zhiqu.common;

/**
 * 密文无法解密（主密钥不匹配、密文被截断或损坏）。
 *
 * <p>之所以单独立一个类型而不是复用 {@link BusinessException}：RAG 索引、记忆迁移、
 * 摘要压缩这几条批处理路径都需要「单行解密失败不拖垮整批」的隔离语义——它们必须能把
 * 这一类失败与普通业务异常区分开，逐条标记后继续处理下一行。靠比对异常消息字符串来做
 * 这件事既脆弱又容易误吞（任何以「敏感数据解密失败」开头的业务异常都会被当成解密失败）。
 *
 * <p>继承 {@link BusinessException} 是为了让既有调用方与 GlobalExceptionHandler 的行为
 * 完全不变：不关心解密失败的地方照旧按业务异常处理，用户看到的提示也一字未改。
 */
public class DecryptFailedException extends BusinessException {
    public DecryptFailedException(String message) {
        super(message);
    }
}
