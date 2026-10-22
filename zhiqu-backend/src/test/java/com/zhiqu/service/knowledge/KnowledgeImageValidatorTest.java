package com.zhiqu.service.knowledge;

import com.zhiqu.common.BusinessException;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.*;

class KnowledgeImageValidatorTest {
    private static final String LOSSY = "UklGRjIAAABXRUJQVlA4ICYAAABwAQCdASoDAAIAAUAmJaACdAFAAAD+9L5Uy/8lP/vK/13bMAAAAA==";
    private static final String LOSSLESS = "UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAfQlu51qP+BiOh/AAA=";
    private static final String ANIMATED = "UklGRrYAAABXRUJQVlA4WAoAAAACAAAAAgAAAQAAQU5JTQYAAAAAAAAAAABBTk1GPAAAAAAAAAAAAAIAAAEAAMgAAAJWUDggJAAAADABAJ0BKgMAAgABQCYloAADcAD+9L7t6v//+Sn/3lf67tmAAEFOTUZGAAAAAAAAAAAAAgAAAQAAyAAAAFZQOCAuAAAANAEAnQEqAwACAAAAJiWgAANwAP7wUx//+A/sD/sDvH//9jN//z0f/+ej/UMAAA==";
    private static final String EXTENDED = "UklGRl4AAABXRUJQVlA4WAoAAAAgAAAAAgAAAQAASUNDUBEAAABmYWtlLXRlc3QtcHJvZmlsZQBWUDggJgAAAHABAJ0BKgMAAgABQCYloAJ0AUAAAP70vlTL/yU/+8r/XdswAAAA";

    @Test
    void readsActualRasterDimensionsAndMime() throws Exception {
        for (String type : new String[] { "png", "jpeg", "gif" }) {
            var result = KnowledgeImageValidator.validate(KnowledgeImageServiceTest.raster(type));
            assertEquals("image/" + type, result.mimeType());
            assertEquals(3, result.width());
            assertEquals(2, result.height());
        }
    }

    @Test
    void validatesRealLossyLosslessExtendedAndAnimatedWebpContainers() {
        for (String encoded : new String[] { LOSSY, LOSSLESS, EXTENDED, ANIMATED }) {
            var result = KnowledgeImageValidator.validate(Base64.getDecoder().decode(encoded));
            assertEquals("image/webp", result.mimeType());
            assertEquals(3, result.width());
            assertEquals(2, result.height());
        }
    }

    @Test
    void rejectsEveryTruncatedWebpPrefixAndInvalidFrameHeader() {
        byte[] valid = Base64.getDecoder().decode(LOSSY);
        for (int i = 0; i < valid.length; i++) {
            byte[] prefix = Arrays.copyOf(valid, i);
            assertThrows(BusinessException.class, () -> KnowledgeImageValidator.validate(prefix), "prefix=" + i);
        }
        valid[23] = 0;
        assertThrows(BusinessException.class, () -> KnowledgeImageValidator.validate(valid));
    }

    @Test
    void refusesExtendedCanvasMismatchAndPixelBombBeforeImageDecode() throws Exception {
        byte[] extended = Base64.getDecoder().decode(EXTENDED);
        extended[24] = 5;
        assertThrows(BusinessException.class, () -> KnowledgeImageValidator.validate(extended));
        byte[] png = KnowledgeImageServiceTest.raster("png");
        png[16] = 0; png[17] = 0; png[18] = 0x7f; png[19] = (byte) 0xff;
        png[20] = 0; png[21] = 0; png[22] = 0x7f; png[23] = (byte) 0xff;
        BusinessException limit = assertThrows(BusinessException.class, () -> KnowledgeImageValidator.validate(png));
        assertTrue(limit.getMessage().contains("2400 万像素"));
    }

    @Test
    void refusesOversizeNullFakeImageAndTruncatedRaster() throws Exception {
        BusinessException limit = assertThrows(BusinessException.class,
                () -> KnowledgeImageValidator.validate(new byte[KnowledgeImageValidator.MAX_BYTES + 1]));
        assertTrue(limit.getMessage().contains("8 MB"));
        assertThrows(BusinessException.class, () -> KnowledgeImageValidator.validate(null));
        assertThrows(BusinessException.class, () -> KnowledgeImageValidator.validate("<svg/>".getBytes()));
        assertThrows(BusinessException.class,
                () -> KnowledgeImageValidator.validate(Arrays.copyOf(KnowledgeImageServiceTest.raster("png"), 12)));
    }
}
