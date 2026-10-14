package com.zhiqu;

import org.junit.jupiter.api.Test;
import java.nio.file.Path;

class WikiSourceFlowTest {
    @Test
    void savedSourceMustBeVisibleAndDraftStillRequiresConfirmation() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/wiki-sources-check.js"),
                Path.of("src/main/resources/static/assets/pages/knowledge-wiki.js"));
    }
}
