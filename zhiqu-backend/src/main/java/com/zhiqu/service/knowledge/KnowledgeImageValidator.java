package com.zhiqu.service.knowledge;

import com.zhiqu.common.BusinessException;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;

/** Validate actual image content before accepting a private attachment. No filename/MIME trust. */
final class KnowledgeImageValidator {
    static final int MAX_BYTES = 8 * 1024 * 1024;
    static final long MAX_PIXELS = 24_000_000L;

    record Dimensions(String mimeType, int width, int height) { }

    static Dimensions validate(byte[] bytes) {
        if (bytes == null || bytes.length == 0) throw new BusinessException("请选择图片");
        if (bytes.length > MAX_BYTES) throw new BusinessException("图片不能超过 8 MB");
        if (bytes.length >= 12 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
            return webp(bytes);
        }
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            if (input == null) throw invalid();
            Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) throw invalid();
            ImageReader reader = readers.next();
            try {
                String format = reader.getFormatName().toLowerCase(Locale.ROOT);
                String mime = switch (format) {
                    case "png" -> "image/png";
                    case "jpeg", "jpg" -> "image/jpeg";
                    case "gif" -> "image/gif";
                    default -> throw invalid();
                };
                reader.setInput(input, true, true);
                int width = reader.getWidth(0), height = reader.getHeight(0);
                dimensions(width, height);
                BufferedImage decoded = reader.read(0);
                if (decoded == null || decoded.getWidth() != width || decoded.getHeight() != height) throw invalid();
                decoded.flush();
                return new Dimensions(mime, width, height);
            } finally {
                reader.dispose();
            }
        } catch (IOException | IllegalArgumentException e) {
            throw invalid();
        }
    }

    /** JDK has no WebP decoder: validate the complete RIFF structure and every VP8/VP8L frame header. */
    private static Dimensions webp(byte[] bytes) {
        if (uint32(bytes, 4) != bytes.length - 8L) throw invalid();
        int width = 0, height = 0, frames = 0;
        boolean extended = false, animated = false, animationHeader = false;
        int position = 12;
        while (position < bytes.length) {
            Chunk chunk = chunk(bytes, position, bytes.length);
            switch (chunk.type) {
                case "VP8X" -> {
                    if (position != 12 || chunk.size != 10) throw invalid();
                    extended = true;
                    int flags = bytes[chunk.data] & 0xff;
                    if ((flags & 0xc1) != 0 || bytes[chunk.data + 1] != 0 || bytes[chunk.data + 2] != 0 || bytes[chunk.data + 3] != 0) throw invalid();
                    animated = (flags & 2) != 0;
                    width = uint24(bytes, chunk.data + 4) + 1;
                    height = uint24(bytes, chunk.data + 7) + 1;
                    dimensions(width, height);
                }
                case "VP8 ", "VP8L" -> {
                    if (animated || frames != 0 || (!extended && position != 12)) throw invalid();
                    int[] actual = frame(bytes, chunk);
                    if (extended && (width != actual[0] || height != actual[1])) throw invalid();
                    width = actual[0]; height = actual[1]; frames++;
                }
                case "ANIM" -> {
                    if (!animated || animationHeader || chunk.size != 6 || frames != 0) throw invalid();
                    animationHeader = true;
                }
                case "ANMF" -> {
                    if (!animated || !animationHeader || chunk.size < 24) throw invalid();
                    int x = uint24(bytes, chunk.data) * 2, y = uint24(bytes, chunk.data + 3) * 2;
                    int frameWidth = uint24(bytes, chunk.data + 6) + 1, frameHeight = uint24(bytes, chunk.data + 9) + 1;
                    dimensions(frameWidth, frameHeight);
                    if ((long) x + frameWidth > width || (long) y + frameHeight > height
                            || (bytes[chunk.data + 15] & 0xfc) != 0) throw invalid();
                    int nested = chunk.data + 16, nestedFrames = 0;
                    while (nested < chunk.end) {
                        Chunk inner = chunk(bytes, nested, chunk.end);
                        if (inner.type.equals("VP8 ") || inner.type.equals("VP8L")) {
                            if (++nestedFrames != 1) throw invalid();
                            int[] actual = frame(bytes, inner);
                            if (actual[0] != frameWidth || actual[1] != frameHeight) throw invalid();
                        } else if (!inner.type.equals("ALPH") || nestedFrames != 0) throw invalid();
                        nested = inner.next;
                    }
                    if (nestedFrames != 1 || nested != chunk.end) throw invalid();
                    frames++;
                }
                case "ALPH", "ICCP", "EXIF", "XMP " -> {
                    if (!extended || chunk.size == 0 || (animated && chunk.type.equals("ALPH"))) throw invalid();
                }
                default -> { if (!extended) throw invalid(); }
            }
            position = chunk.next;
        }
        if (frames == 0 || position != bytes.length || (animated && !animationHeader)) throw invalid();
        return new Dimensions("image/webp", width, height);
    }

    private record Chunk(String type, int data, int size, int end, int next) { }

    private static Chunk chunk(byte[] bytes, int position, int limit) {
        if (position + 8 > limit) throw invalid();
        long size = uint32(bytes, position + 4);
        long end = position + 8L + size;
        long next = end + (size & 1L);
        if (size > Integer.MAX_VALUE || next > limit || (next != end && bytes[(int) end] != 0)) throw invalid();
        return new Chunk(new String(bytes, position, 4, StandardCharsets.US_ASCII), position + 8, (int) size, (int) end, (int) next);
    }

    private static int[] frame(byte[] bytes, Chunk chunk) {
        int width, height, start = chunk.data;
        if (chunk.type.equals("VP8 ")) {
            if (chunk.size <= 10 || (bytes[start] & 1) != 0 || (bytes[start] & 0x10) == 0
                    || bytes[start + 3] != (byte) 0x9d || bytes[start + 4] != 1 || bytes[start + 5] != 0x2a) throw invalid();
            int partition = ((bytes[start] & 0xff) | (bytes[start + 1] & 0xff) << 8 | (bytes[start + 2] & 0xff) << 16) >>> 5;
            if (partition == 0 || partition > chunk.size - 10) throw invalid();
            width = ((bytes[start + 6] & 0xff) | (bytes[start + 7] & 0xff) << 8) & 0x3fff;
            height = ((bytes[start + 8] & 0xff) | (bytes[start + 9] & 0xff) << 8) & 0x3fff;
        } else {
            if (chunk.size <= 5 || bytes[start] != 0x2f || (bytes[start + 4] & 0xe0) != 0) throw invalid();
            long bits = uint32(bytes, start + 1);
            width = (int) (bits & 0x3fff) + 1;
            height = (int) ((bits >>> 14) & 0x3fff) + 1;
        }
        dimensions(width, height);
        return new int[] { width, height };
    }

    private static long uint32(byte[] bytes, int offset) {
        return (bytes[offset] & 0xffL) | (bytes[offset + 1] & 0xffL) << 8 | (bytes[offset + 2] & 0xffL) << 16 | (bytes[offset + 3] & 0xffL) << 24;
    }

    private static int uint24(byte[] bytes, int offset) {
        return (bytes[offset] & 0xff) | (bytes[offset + 1] & 0xff) << 8 | (bytes[offset + 2] & 0xff) << 16;
    }

    private static boolean ascii(byte[] bytes, int offset, String text) {
        return new String(bytes, offset, text.length(), StandardCharsets.US_ASCII).equals(text);
    }

    private static void dimensions(int width, int height) {
        if (width <= 0 || height <= 0 || (long) width * height > MAX_PIXELS) {
            throw new BusinessException("图片尺寸不能超过 2400 万像素");
        }
    }

    private static BusinessException invalid() {
        return new BusinessException("图片内容无效，仅支持 PNG、JPG、GIF、WebP");
    }
}
