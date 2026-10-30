package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;

/**
 * 知识 Wiki 的自动保存（第八十三轮，docs/rounds/round-83.md）：像 Obsidian，打字停下就存、一直打最多隔一会儿存一次，
 * 版本对不上停下、断网自己再试、回应丢了先原样重发、改名和保存排一队、换页和焦点离开马上存。node 里跑发布的 knowledge-wiki.js。
 */
class WikiAutosaveTest {

    @Test
    @DisplayName("自动保存的行为（停下就存、最多隔 MAX 存一次、412 停下、断网重试而业务拒绝不重试、uncertain 先原样重发、改名排队、换页 / 失焦马上存、空正文不发）")
    void 自动保存() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/wiki-autosave-check.js"), Path.of("src/main/resources/static/assets/pages/knowledge-wiki.js"));
    }
}
