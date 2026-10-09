package com.zhiqu.harness;

import com.zhiqu.NodeRunner;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * npm 版 zhiqu（{@code zhiqu-cli/}）的判据接进 Maven 全量。
 *
 * <p>计划里写的「Java 与 JS 共用一份一致性用例，两边的测试都跑它」—— Java 那一侧是
 * {@code WorkspaceRulesConformanceTest}，JS 那一侧是 {@code zhiqu-cli/test/conformance.test.js}；
 * 只有两边都在同一个「全量测试」里跑，「全量绿」才包括「两份实现没有分叉」。
 */
class HarnessCliNodeSuiteTest {

    @Test
    @DisplayName("zhiqu-cli 的 node 测试全部通过（含与 Java 共用的一致性用例）")
    void 全部通过() throws Exception {
        Path cli = Path.of("../zhiqu-cli").toAbsolutePath().normalize();
        List<String> files;
        try (Stream<Path> s = Files.list(cli.resolve("test"))) {
            files = s.map(p -> "test/" + p.getFileName()).filter(f -> f.endsWith(".test.js")).sorted().toList();
        }
        assertTrue(files.contains("test/conformance.test.js"), "一致性用例那一侧不见了：" + files);
        assertTrue(files.size() >= 8, "测试文件少得不正常：" + files);
        NodeRunner.runTestSuite(cli, files, 40);
    }
}
