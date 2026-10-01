package com.zhiqu.service.ai;

/**
 * 用户这一条消息放进对话的样子：<b>换行、缩进原样保留</b>；超过这个模型一次能处理的量时，
 * 保留开头和结尾、截掉中间，并且把截了多少写进正文。
 *
 * <p>由来（2026-09-27，第九轮：用户要「长上下文输入时的分析能力」）。原来是
 * {@code limitText(message, 12000)}，而那个函数<b>先把所有空白压成一个空格</b>：
 * 粘贴的代码、日志、表格在模型眼里变成一整行（Python 连缩进都没了，语义直接变了），
 * 存进库的也是压平的那一份 —— 刷新之后，聊天记录里自己发过的代码也成了一行。
 * 超过 12000 字则从后面截掉，一个字都不说；而问题常常写在最后（「……以上是日志，哪里出错了？」）。
 *
 * <p>上限跟着模型走：没填上下文窗口就是原来的 12000 字（和 {@link ContextBudget#DEFAULT} 同一个道理 ——
 * 没填就一个字都不变）；填了按窗口的 40% 算（1 字 ≈ 1 token 的保守估计，剩下的留给历史、资料和回答）。
 */
public record UserMessageFit(String text, int originalChars, int limitChars) {

    public static final int DEFAULT_CHARS = 12_000;
    public static final int MAX_CHARS = 400_000;
    static final int TAIL_CHARS = 2_000;

    public static int limitFor(Integer windowTokens) {
        if (windowTokens == null) {
            return DEFAULT_CHARS;
        }
        return Math.max(DEFAULT_CHARS, Math.min(MAX_CHARS, (int) (windowTokens * 0.4)));
    }

    public static UserMessageFit of(String message, int limitChars) {
        String raw = message == null ? "" : message.strip();
        if (raw.length() <= limitChars) {
            return new UserMessageFit(raw, raw.length(), limitChars);
        }
        int tail = Math.min(TAIL_CHARS, limitChars / 5);
        int head = limitChars - tail - 120;
        // 不把一个增补平面字符（emoji、生僻字）劈成两半
        if (Character.isHighSurrogate(raw.charAt(head - 1))) {
            head--;
        }
        int tailFrom = raw.length() - tail;
        if (Character.isLowSurrogate(raw.charAt(tailFrom))) {
            tailFrom++;
        }
        int omitted = tailFrom - head;
        String text = raw.substring(0, head)
                + "\n\n…（这条消息有 " + raw.length() + " 字，超过当前模型一次能处理的 " + limitChars
                + " 字：保留了开头和结尾，中间略去 " + omitted + " 字）…\n\n"
                + raw.substring(tailFrom);
        return new UserMessageFit(text, raw.length(), limitChars);
    }

    public boolean truncated() {
        return originalChars > limitChars;
    }

    /** 告诉用户的那句话（页面上弹出来）。 */
    public String notice() {
        return "这条消息有 " + originalChars + " 字，超过当前模型一次能处理的 " + limitChars
                + " 字：只用了开头和结尾，中间的略去了。可以在模型设置里填上下文窗口，或者分几次发。";
    }
}
