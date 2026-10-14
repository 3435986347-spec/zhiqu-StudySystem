package com.zhiqu;

import org.junit.jupiter.api.Test;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WikiEmbedPreviewTest {
    @Test
    void allHeadingLevelsAndTypedEmbedsPreserveAuthoredMarkdown() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/wiki-embed-check.js"), NodeRunner.API_JS));
    }

    @Test
    void previewsEscapeSourceAndCannotCrossAuthenticationOrRecursionBoundaries() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/wiki-preview-security-check.js"), NodeRunner.API_JS));
    }

    @Test
    void editorKeepsViewportAndPendingSaveCannotDiscardNewerEdits() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/wiki-editor-stability-check.js"),
                Path.of("src/main/resources/static/assets/pages/knowledge-wiki.js")));
    }
}
