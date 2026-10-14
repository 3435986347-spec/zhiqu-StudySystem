package com.zhiqu;

import org.junit.jupiter.api.Test;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WikiPrivateMediaTest {
    @Test
    void publishedMarkdownPreservesPrivateImagesAndAttachments() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/wiki-media-check.js"), NodeRunner.API_JS));
    }

    @Test
    void lateImageUploadDoesNotCrossWikiEditSessions() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/wiki-image-flow-check.js"),
                Path.of("src/main/resources/static/assets/pages/knowledge-wiki.js")));
    }
}
