package com.zhiqu;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

class WikiLinkInteractionTest {
    @Test
    void wikiIsReadOnlyUntilTheUserExplicitlyChoosesToEdit() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/wiki-readonly-check.js"),
                Path.of("src/main/resources/static/assets/pages/knowledge-wiki.js"),
                "src/main/resources/static/knowledge-wiki.html"));
    }

    @Test
    void plainUrlsAreLinkedWithoutChangingTheAuthoredMarkdown() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/wiki-autolink-check.js"), NodeRunner.API_JS));
    }

    @Test
    void externalLinksOpenWithoutLosingTheCurrentEditorOrAttachmentHandlers() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/wiki-external-link-check.js"),
                Path.of("src/main/resources/static/assets/pages/knowledge-wiki.js")));
    }
}
