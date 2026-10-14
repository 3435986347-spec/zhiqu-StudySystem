package com.zhiqu.service.knowledge;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.KnowledgeAttachment;
import com.zhiqu.mapper.KnowledgeAttachmentMapper;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/** Durable private Wiki attachments, shared by manual image insertion and vault ZIP import/export. */
@Service
public class KnowledgeImageService {
    public static final int MAX_IMAGE_BYTES = KnowledgeImageValidator.MAX_BYTES;
    public static final long MAX_IMAGE_PIXELS = KnowledgeImageValidator.MAX_PIXELS;
    private final KnowledgeAttachmentMapper attachments;
    private final SensitiveCryptoService crypto;

    public KnowledgeImageService(KnowledgeAttachmentMapper attachments, SensitiveCryptoService crypto) {
        this.attachments = attachments;
        this.crypto = crypto;
    }

    public record ImageRecord(Long id, String name, String mimeType, long byteSize, int width, int height, String url) {
        public Map<String, Object> asMap() {
            String alt = name.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]");
            return Map.of("id", id, "name", name, "mimeType", mimeType, "byteSize", byteSize,
                    "width", width, "height", height, "url", url, "markdown", "![" + alt + "](" + url + ")");
        }
    }

    public record ImageData(ImageRecord image, byte[] bytes) {
        public ImageData { bytes = bytes.clone(); }
        @Override public byte[] bytes() { return bytes.clone(); }
    }

    public record AttachmentRecord(Long id, String name, String kind, String mimeType, long byteSize,
                                   Integer width, Integer height, String url, String originalPath) { }

    public record AttachmentData(AttachmentRecord attachment, byte[] bytes) {
        public AttachmentData { bytes = bytes.clone(); }
        @Override public byte[] bytes() { return bytes.clone(); }
    }

    /** Reads at most the image limit, even when a multipart implementation reports the wrong size. */
    public ImageRecord uploadOwnedImage(Long userId, MultipartFile file) {
        requireUser(userId);
        if (file == null || file.isEmpty()) throw new BusinessException("请选择图片");
        if (file.getSize() > MAX_IMAGE_BYTES) throw new BusinessException("图片不能超过 8 MB");
        try (InputStream stream = file.getInputStream()) {
            return storeOwnedImage(userId, file.getOriginalFilename(), stream.readNBytes(MAX_IMAGE_BYTES + 1));
        } catch (IOException e) {
            throw new BusinessException("图片读取失败，请重新选择");
        }
    }

    /** Joins the vault-confirmation transaction; failed imports leave no attachment outside that transaction. */
    @Transactional
    public ImageRecord storeOwnedImage(Long userId, String name, byte[] bytes) {
        requireUser(userId);
        KnowledgeImageValidator.Dimensions dimensions = KnowledgeImageValidator.validate(bytes);
        KnowledgeAttachment image = new KnowledgeAttachment();
        image.setUserId(userId);
        image.setKind("IMAGE");
        image.setName(imageName(name, dimensions.mimeType()));
        image.setMimeType(dimensions.mimeType());
        image.setByteSize((long) bytes.length);
        image.setWidth(dimensions.width());
        image.setHeight(dimensions.height());
        image.setEncryptedData(crypto.encrypt("base64:" + Base64.getEncoder().encodeToString(bytes)));
        image.setDeleted(0);
        if (attachments.insert(image) != 1 || image.getId() == null || image.getId() <= 0) {
            throw new BusinessException("图片没有保存成功，请重试");
        }
        return metadata(image);
    }

    public ImageData readOwnedImage(Long userId, Long id) {
        AttachmentData data = readOwnedAttachment(userId, id);
        if (!data.attachment().kind().equals("IMAGE")) throw unavailable();
        AttachmentRecord attachment = data.attachment();
        return new ImageData(new ImageRecord(attachment.id(), attachment.name(), attachment.mimeType(),
                attachment.byteSize(), attachment.width(), attachment.height(), attachment.url()), data.bytes());
    }

    /** Vault files that are not known raster images stay opaque and are served only as downloads. */
    @Transactional
    public AttachmentRecord storeOwnedAttachment(Long userId, String name, byte[] bytes, String originalPath) {
        requireUser(userId);
        if (bytes == null || bytes.length > MAX_IMAGE_BYTES) throw new BusinessException("附件不能超过 8 MB");
        String safePath = relativePath(originalPath);
        String safeName = fileName(name);
        boolean isImage = isRasterName(safeName);
        KnowledgeAttachment attachment = new KnowledgeAttachment();
        attachment.setUserId(userId);
        attachment.setOriginalPath(safePath);
        attachment.setName(safeName);
        attachment.setKind(isImage ? "IMAGE" : "FILE");
        attachment.setMimeType("application/octet-stream");
        if (isImage) {
            KnowledgeImageValidator.Dimensions dimensions = KnowledgeImageValidator.validate(bytes);
            attachment.setMimeType(dimensions.mimeType());
            attachment.setWidth(dimensions.width());
            attachment.setHeight(dimensions.height());
        }
        attachment.setByteSize((long) bytes.length);
        attachment.setEncryptedData(crypto.encrypt("base64:" + Base64.getEncoder().encodeToString(bytes)));
        attachment.setDeleted(0);
        if (attachments.insert(attachment) != 1 || attachment.getId() == null || attachment.getId() <= 0) {
            throw new BusinessException("附件没有保存成功，请重试");
        }
        return attachmentMetadata(attachment);
    }

    public AttachmentData readOwnedAttachment(Long userId, Long id) {
        requireUser(userId);
        if (id == null || id <= 0) throw unavailable();
        KnowledgeAttachment image = attachments.selectOne(new LambdaQueryWrapper<KnowledgeAttachment>()
                .eq(KnowledgeAttachment::getUserId, userId).eq(KnowledgeAttachment::getId, id));
        if (image == null || !Objects.equals(image.getUserId(), userId) || !Objects.equals(image.getId(), id)) {
            throw unavailable();
        }
        byte[] bytes;
        try {
            String plain = crypto.decrypt(image.getEncryptedData());
            if (plain == null || !plain.startsWith("base64:")) throw new IllegalArgumentException();
            bytes = Base64.getDecoder().decode(plain.substring(7));
        } catch (IllegalArgumentException e) {
            throw new BusinessException("附件数据损坏，请重新上传");
        }
        if (bytes.length > MAX_IMAGE_BYTES || !Objects.equals(image.getByteSize(), (long) bytes.length)) {
            throw new BusinessException("附件数据损坏，请重新上传");
        }
        return new AttachmentData(attachmentMetadata(image), bytes);
    }

    /** Metadata only: listing attachments never loads/decrypts the binary columns. */
    public List<ImageRecord> listOwnedImages(Long userId) {
        requireUser(userId);
        return attachments.selectList(metadataQuery(userId).eq(KnowledgeAttachment::getKind, "IMAGE"))
                .stream().map(KnowledgeImageService::metadata).toList();
    }

    public List<AttachmentRecord> listOwnedAttachments(Long userId) {
        requireUser(userId);
        return attachments.selectList(metadataQuery(userId)).stream()
                .map(KnowledgeImageService::attachmentMetadata).toList();
    }

    private static LambdaQueryWrapper<KnowledgeAttachment> metadataQuery(Long userId) {
        return new LambdaQueryWrapper<KnowledgeAttachment>()
                .select(KnowledgeAttachment::getId, KnowledgeAttachment::getName, KnowledgeAttachment::getKind,
                        KnowledgeAttachment::getOriginalPath, KnowledgeAttachment::getMimeType,
                        KnowledgeAttachment::getByteSize, KnowledgeAttachment::getWidth, KnowledgeAttachment::getHeight)
                .eq(KnowledgeAttachment::getUserId, userId).orderByDesc(KnowledgeAttachment::getId);
    }

    private static ImageRecord metadata(KnowledgeAttachment image) {
        return new ImageRecord(image.getId(), image.getName(), image.getMimeType(), image.getByteSize(),
                image.getWidth(), image.getHeight(), "/api/knowledge/images/" + image.getId());
    }

    private static AttachmentRecord attachmentMetadata(KnowledgeAttachment attachment) {
        String prefix = "IMAGE".equals(attachment.getKind()) ? "/api/knowledge/images/" : "/api/knowledge/attachments/";
        return new AttachmentRecord(attachment.getId(), attachment.getName(), attachment.getKind(),
                attachment.getMimeType(), attachment.getByteSize(), attachment.getWidth(), attachment.getHeight(),
                prefix + attachment.getId(), attachment.getOriginalPath());
    }

    private static String relativePath(String path) {
        if (path == null || path.isBlank()) return null;
        String relative = path.replace('\\', '/');
        if (relative.length() > 1024 || relative.startsWith("/") || relative.contains(":")) throw new BusinessException("附件路径不合法");
        for (String part : relative.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..") || part.chars().anyMatch(Character::isISOControl)) {
                throw new BusinessException("附件路径不合法");
            }
        }
        return relative;
    }

    private static String fileName(String original) {
        String name = original == null ? "" : original.replace('\\', '/');
        name = name.substring(name.lastIndexOf('/') + 1).replaceAll("[\\p{Cntrl}]", "").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "attachment";
        if (name.codePointCount(0, name.length()) > 180) {
            int dot = name.lastIndexOf('.');
            String suffix = dot > 0 && name.codePointCount(dot, name.length()) <= 16 ? name.substring(dot) : "";
            int kept = 180 - suffix.codePointCount(0, suffix.length());
            name = name.substring(0, name.offsetByCodePoints(0, kept)) + suffix;
        }
        return name;
    }

    private static String imageName(String original, String mimeType) {
        String name = fileName(original);
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "image";
        int dot = name.lastIndexOf('.');
        if (dot > 0) name = name.substring(0, dot);
        String extension = switch (mimeType) {
            case "image/jpeg" -> ".jpg";
            case "image/gif" -> ".gif";
            case "image/webp" -> ".webp";
            default -> ".png";
        };
        if (name.length() > 170) name = name.substring(0, name.offsetByCodePoints(0, Math.min(165, name.codePointCount(0, name.length()))));
        return name + extension;
    }

    static boolean isRasterName(String name) {
        return fileName(name).toLowerCase(Locale.ROOT).matches(".*\\.(png|jpe?g|gif|webp)$");
    }

    private static void requireUser(Long userId) {
        if (userId == null || userId <= 0) throw new BusinessException("未登录或登录状态已过期");
    }

    private static BusinessException unavailable() {
        return new BusinessException("图片不存在或无权访问");
    }
}
