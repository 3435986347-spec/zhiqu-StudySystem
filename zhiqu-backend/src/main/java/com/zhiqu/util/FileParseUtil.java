package com.zhiqu.util;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.ss.usermodel.WorkbookFactory;
import org.springframework.web.multipart.MultipartFile;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

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

    /** 判断文件是否为 Excel 表格 */
    public static boolean isExcel(String contentType, String fileName) {
        if (contentType != null && (
                contentType.contains("spreadsheet") ||
                contentType.contains("excel") ||
                contentType.contains("ms-excel")
        )) return true;

        if (fileName == null) return false;
        String lower = fileName.toLowerCase();
        return lower.endsWith(".xlsx") || lower.endsWith(".xls");
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

    /** 将 PDF 前几页渲染为图片，供视觉模型识别扫描版 PDF */
    public static List<PdfPageImage> extractPdfPageImages(MultipartFile file, int maxPages) throws IOException {
        List<PdfPageImage> images = new ArrayList<>();
        try (PDDocument doc = Loader.loadPDF(file.getBytes())) {
            PDFRenderer renderer = new PDFRenderer(doc);
            int pageCount = Math.min(Math.max(maxPages, 1), doc.getNumberOfPages());
            for (int i = 0; i < pageCount; i++) {
                BufferedImage image = renderer.renderImageWithDPI(i, 144, ImageType.RGB);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                ImageIO.write(image, "png", out);
                images.add(new PdfPageImage(i + 1, Base64.getEncoder().encodeToString(out.toByteArray()), "image/png"));
            }
        }
        return images;
    }

    /** 提取 Excel 表格为模型可读文本 */
    public static String extractExcelText(MultipartFile file) throws IOException {
        StringBuilder sb = new StringBuilder();
        DataFormatter formatter = new DataFormatter();
        try (Workbook workbook = WorkbookFactory.create(file.getInputStream())) {
            int sheetLimit = Math.min(workbook.getNumberOfSheets(), 8);
            for (int s = 0; s < sheetLimit; s++) {
                Sheet sheet = workbook.getSheetAt(s);
                sb.append("Sheet: ").append(sheet.getSheetName()).append('\n');
                int rowCount = 0;
                for (Row row : sheet) {
                    if (rowCount++ >= 300) {
                        sb.append("...(sheet rows truncated)\n");
                        break;
                    }
                    List<String> cells = new ArrayList<>();
                    short lastCell = row.getLastCellNum();
                    for (int c = 0; c < Math.max(lastCell, 0); c++) {
                        cells.add(formatter.formatCellValue(row.getCell(c)).trim());
                    }
                    sb.append(String.join(" | ", cells)).append('\n');
                    if (sb.length() > 15000) {
                        return sb.substring(0, 15000) + "\n...(内容过长已截断)";
                    }
                }
                sb.append('\n');
            }
        }
        return sb.toString();
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

    public record PdfPageImage(int pageNumber, String base64, String mediaType) {
    }
}
