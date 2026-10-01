package com.zhiqu.cli;

/**
 * 命令行发出的 User-Agent。个人中心「登录设备」靠它认出「命令行」（zhiqu-api.js 的 shortUA）。
 *
 * <p>单独成一个纯函数：判据要用确定的系统名去喂前端，而 {@link #current()} 读的是本机的
 * {@code os.name} —— 那会让判据的期望值随跑它的机器变。
 */
public final class CliUserAgent {

    private CliUserAgent() {
    }

    public static String of(String osName, String osVersion) {
        return "ZhiquCLI/" + ZhiquCli.VERSION + " (" + osName + " " + osVersion + ")";
    }

    public static String current() {
        return of(System.getProperty("os.name", ""), System.getProperty("os.version", ""));
    }
}
