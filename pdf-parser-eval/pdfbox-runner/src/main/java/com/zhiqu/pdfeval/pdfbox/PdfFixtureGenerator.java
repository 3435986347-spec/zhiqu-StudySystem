package com.zhiqu.pdfeval.pdfbox;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.encryption.AccessPermission;
import org.apache.pdfbox.pdmodel.encryption.StandardProtectionPolicy;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;

import java.nio.file.Path;

public final class PdfFixtureGenerator {
    private PdfFixtureGenerator() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("usage: PdfFixtureGenerator TYPE OUTPUT");
        String type = args[0];
        Path output = Path.of(args[1]).toAbsolutePath();
        try (PDDocument document = new PDDocument()) {
            int pages = "two-page".equals(type) ? 2 : 1;
            for (int page = 1; page <= pages; page++) {
                PDPage pdfPage = new PDPage();
                document.addPage(pdfPage);
                if (!"blank".equals(type)) {
                    String text = "long".equals(type) ? "Zhiqu ".repeat(200) : "Zhiqu fixture page " + page;
                    try (PDPageContentStream content = new PDPageContentStream(document, pdfPage)) {
                        content.beginText();
                        content.setFont(new PDType1Font(Standard14Fonts.FontName.HELVETICA), 12);
                        content.newLineAtOffset(72, 720);
                        content.showText(text);
                        content.endText();
                    }
                }
            }
            if ("encrypted".equals(type)) {
                AccessPermission permission = new AccessPermission();
                StandardProtectionPolicy policy = new StandardProtectionPolicy("owner-secret", "user-secret", permission);
                policy.setEncryptionKeyLength(128);
                document.protect(policy);
            }
            document.save(output.toFile());
        }
    }
}
