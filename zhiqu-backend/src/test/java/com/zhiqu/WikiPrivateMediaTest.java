package com.zhiqu;

import org.junit.jupiter.api.Test;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WikiPrivateMediaTest {
    @Test
    void publishedMarkdownPreservesPrivateImagesAndAttachments() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/wiki-media-check.js"), NodeRunner.API_JS));
    }

    /** 第七十四轮 review：新编辑器里图片滚出可视区再滚回来，原来每次都重新下载 */
    @Test
    void privateImageBytesAreReusedWithinOneLogin() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/private-image-cache-check.js"), NodeRunner.API_JS));
    }

    @Test
    void lateImageUploadDoesNotCrossWikiEditSessions() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/wiki-image-flow-check.js"),
                Path.of("src/main/resources/static/assets/pages/knowledge-wiki.js")));
    }
}
