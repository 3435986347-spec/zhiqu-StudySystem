package com.zhiqu;

import org.junit.jupiter.api.Test;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WikiVaultUiTest {
    @Test
    void publishedZipDialogDoesNotReviveStalePreviews() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/wiki-vault-ui-check.js"),
                Path.of("src/main/resources/static/assets/pages/knowledge-wiki.js")));
    }
}
