package com.zhiqu;

import org.junit.jupiter.api.Test;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PageStartupTest {
    @Test
    void ordinaryPageCodeLoadsDuringAuthWithoutStartingBeforeAuthOrPrefetchingAdminCode() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/page-start-check.js"), NodeRunner.API_JS));
    }
}
