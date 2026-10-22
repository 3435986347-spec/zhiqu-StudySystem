package com.zhiqu.service.ai;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 私有上传目录的读取守卫：只允许读<b>本用户目录内</b>的普通文件。
 *
 * <h2>为什么这一层不能省</h2>
 *
 * <p>调用方已经按 {@code userId} 查到了 source 行，看起来路径也就可信了。但 {@code file_path}
 * 是<b>库里的一个字符串</b>，不是代码算出来的：任何一次写入缺陷（落盘时文件名没消毒、
 * 将来某个导入功能直接写外部路径、或一次数据迁移把路径改错）都会让它指向目录之外。
 * 那时读文件的这一步就成了任意文件读取，而上面那层「行归属检查」<b>完全看不出问题</b> ——
 * 行确实是这个用户的，只是它指向了别人的（或系统的）文件。
 *
 * <h2>三个条件各挡一种逃逸</h2>
 *
 * <ul>
 *   <li>{@code normalize() + startsWith(userRoot)} —— 挡 {@code ../} 往上跳。
 *       必须先 normalize 再比，否则 {@code /root/a/../../etc/passwd} 的字符串前缀是匹配的。</li>
 *   <li>拒绝符号链接 —— 目录内放一个指向外面的软链，前缀检查一样会通过。</li>
 *   <li>要求普通文件 —— 目录、设备文件、命名管道都不是可下载的原件；
 *       读一个管道会把线程挂死。</li>
 * </ul>
 *
 * <p>三者<b>缺一不可</b>，而删掉任意一个都不会让下载功能坏掉 —— 这正是它需要判据看着的理由。
 *
 * <p>从 {@code AiWorkspaceServiceImpl.validatedSourceFile} 提出来，就是为了让这三条能被直接钉住。
 * 留在私有方法里时它零覆盖。
 */
public final class PrivateUploadPathGuard {
    /** 私有上传根目录下装 AI 资料原件的那一层。 */
    public static final String SOURCES_DIR = "ai-sources";

    private final Path uploadRoot;

    public PrivateUploadPathGuard(Path uploadRoot) {
        this.uploadRoot = uploadRoot;
    }

    /** 这个用户的原件目录。 */
    public Path userRoot(Long userId) {
        return uploadRoot.resolve(SOURCES_DIR).resolve(String.valueOf(userId)).normalize();
    }

    /**
     * 校验并返回可读的真实路径。
     *
     * @return 通过校验的绝对路径；<b>任何一条不满足都返回 {@code null}</b>，不抛异常 ——
     *         调用方据此回落到「导出解析文本」，而不是把一次路径异常变成整个下载失败
     */
    public Path resolveOwnedFile(Long userId, String filePath) {
        if (filePath == null || filePath.isBlank()) {
            return null;
        }
        try {
            Path root = userRoot(userId);
            Path candidate = Paths.get(filePath).toAbsolutePath().normalize();
            if (!candidate.startsWith(root)
                    || Files.isSymbolicLink(candidate)
                    || !Files.isRegularFile(candidate)) {
                return null;
            }
            return candidate;
        } catch (Exception e) {
            return null;
        }
    }
}
