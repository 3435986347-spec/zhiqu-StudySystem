package com.zhiqu.common;

/**
 * 乐观锁对不上：带来的版本号不是这一行现在的版本（别的窗口、别的设备先存了）。和别的业务错误分开，回 code 412（第八十三轮）：
 * 知识 Wiki 改成打字就自动保存以后，页面要分得清「别处改过这一页」（停下自动保存、照实说，不能拿旧版本盖掉）
 * 和「这一次没存上」（断网、服务器忙，过一会儿自己再试）。不用 409：那是「同一个幂等键还在处理」，页面会等一下原样重发。
 */
public class VersionConflictException extends BusinessException {
    public VersionConflictException(String message) {
        super(message);
    }
}
