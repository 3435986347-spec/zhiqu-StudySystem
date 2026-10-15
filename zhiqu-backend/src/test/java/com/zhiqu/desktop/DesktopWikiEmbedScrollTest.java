package com.zhiqu.desktop;

import com.zhiqu.NodeRunner;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** JSON's visible pre owns both scroll axes, including inside the contenteditable Wiki. */
class DesktopWikiEmbedScrollTest {
    @TempDir
    Path tmp;

    @Test
    void jsonSourceHasOneBoundedScrollableSurfaceInWebKit() throws Exception {
        Assumptions.assumeTrue(System.getProperty("os.name", "").toLowerCase().contains("mac"), "WKWebView requires macOS");
        Assumptions.assumeFalse(Boolean.getBoolean("zhiqu.skipSwiftTests"), "Explicit -Dzhiqu.skipSwiftTests=true");
        assertTrue(Files.isExecutable(Path.of("/usr/bin/swiftc")), "swiftc is required; explicitly skip Swift tests if unavailable");
        Files.copy(Path.of("src/main/resources/static/assets/zhiqu-ui.css"), tmp.resolve("zhiqu-ui.css"));
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/wiki-scroll-markup.js"), NodeRunner.API_JS,
                tmp.resolve("preview.html").toString()));
        Path main = tmp.resolve("main.swift");
        Files.copy(Path.of("src/test/resources/swift/wiki-embed-scroll-check.swift"), main);
        Path bin = tmp.resolve("check");
        DesktopPageViewTest.run(600, "/usr/bin/swiftc", "-O", "-framework", "AppKit", "-framework", "WebKit",
                "-o", bin.toString(), main.toString());
        String output = DesktopPageViewTest.run(90, bin.toString(), tmp.toString());
        Map<String, String> result = new HashMap<>();
        for (String line : output.split("\n")) {
            int separator = line.indexOf('=');
            if (separator > 0) result.put(line.substring(0, separator), line.substring(separator + 1));
        }
        assertEquals("true", result.get("done"), output);
        assertEquals("4", result.get("cases"), output);
        for (String mode : new String[]{"read", "edit"}) {
            for (int width : new int[]{880, 320}) {
                String key = mode + "." + width;
                assertTrue(Double.parseDouble(result.get(key + ".height")) <= 460, key + " JSON must be bounded");
                assertTrue(Double.parseDouble(result.get(key + ".vertical")) > 0, key + " pre cannot scroll vertically");
                assertTrue(Double.parseDouble(result.get(key + ".horizontal")) > 0, key + " pre cannot scroll horizontally");
                assertEquals("0", result.get(key + ".outer"), key + " scrolling JSON moved the page");
                assertEquals("visible", result.get(key + ".wrapperOverflow"), key + " wrapper created a second scroll surface");
                assertTrue(Double.parseDouble(result.get(key + ".documentOverflow")) <= 0.5, key + " JSON widened the page");
                assertEquals("1", result.get(key + ".sourceIntact"), key + " JSON changed when scrolling");
            }
        }
    }
}
