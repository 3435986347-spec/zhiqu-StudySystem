package com.zhiqu.util;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.Base64;

public class FileParseUtil {

    /** 判断文件是否为图片 */
    public static boolean isImage(String contentType) {
        return contentType != null && (
                contentType.startsWith("image/png") ||
                contentType.startsWith("image/jpeg") ||
                contentType.startsWith("image/jpg") ||
                contentType.startsWith("image/gif") ||
                contentType.startsWith("image/webp") ||
                contentType.startsWith("image/bmp")
        );
    }

    /** 判断文件是否为 PDF */
    public static boolean isPdf(String contentType) {
        return "application/pdf".equals(contentType);
    }

    /** 判断文件是否为文本类 */
    public static boolean isText(String contentType, String fileName) {
        if (contentType != null && (
                contentType.startsWith("text/") ||
                contentType.contains("json") ||
                contentType.contains("csv") ||
                contentType.contains("xml")
        )) return true;

        if (fileName == null) return false;
        String lower = fileName.toLowerCase();
        return lower.endsWith(".txt") || lower.endsWith(".md") ||
               lower.endsWith(".csv") || lower.endsWith(".json") ||
               lower.endsWith(".xml") || lower.endsWith(".log") ||
               lower.endsWith(".yaml") || lower.endsWith(".yml");
    }

    /**
     * 提取 PDF 文本内容（最多 15000 字符）
     */
    public static String extractPdfText(MultipartFile file) throws IOException {
        try (PDDocument doc = Loader.loadPDF(file.getBytes())) {
            PDFTextStripper stripper = new PDFTextStripper();
            String text = stripper.getText(doc);
            if (text.length() > 15000) {
                text = text.substring(0, 15000) + "\n...(内容过长已截断)";
            }
            return text;
        }
    }

    /** 将图片文件转为 Base64 字符串 */
    public static String imageToBase64(MultipartFile file) throws IOException {
        return Base64.getEncoder().encodeToString(file.getBytes());
    }

    /** 获取图片的标准 MIME 类型 */
    public static String getImageMediaType(String contentType) {
        if (contentType == null) return "image/png";
        if (contentType.contains("jpeg") || contentType.contains("jpg")) return "image/jpeg";
        if (contentType.contains("gif"))  return "image/gif";
        if (contentType.contains("webp")) return "image/webp";
        return "image/png";
    }
}
