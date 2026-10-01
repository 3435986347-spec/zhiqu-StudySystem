package com.zhiqu.service.impl;

import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.UpdateProfileRequest;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.LoginLogMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.security.JwtUtils;
import com.zhiqu.util.UploadPathResolver;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 用户这一行的写入：资料、头像只动自己那几列（清空能清空、没存上会说）；换了头像旧文件删掉，但只删自己的。
 */
class UserRecordWritesTest {

    private static final byte[] PNG = {(byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 'I', 'H', 'D', 'R'};

    @TempDir Path uploads;
    private final SysUserMapper users = mock(SysUserMapper.class);

    private UserServiceImpl service() {
        UploadPathResolver resolver = new UploadPathResolver();
        ReflectionTestUtils.setField(resolver, "uploadDir", uploads.toString());
        return new UserServiceImpl(users, new BCryptPasswordEncoder(4), resolver, mock(LoginLogMapper.class), new JwtUtils());
    }

    private SysUser user(long id, String avatar) {
        SysUser u = new SysUser();
        u.setId(id);
        u.setUsername("u" + id);
        u.setNickname("n" + id);
        u.setSchool("旧学校");
        u.setAvatar(avatar);
        when(users.selectById(id)).thenReturn(u);
        return u;
    }

    @Test
    @DisplayName("清空学校 / 专业 / 邮箱：真的写成空（原来 updateById 跳过 null，清不掉）；不走整行写回")
    void 清空资料能清空() {
        user(7, null);
        when(users.updateProfile(anyLong(), anyString(), any(), any(), any())).thenReturn(1);
        UpdateProfileRequest request = new UpdateProfileRequest();
        request.setNickname("新昵称");
        request.setSchool("");
        request.setMajor("   ");
        request.setEmail("");
        service().updateProfile(7L, request);
        verify(users).updateProfile(eq(7L), eq("新昵称"), isNull(), isNull(), isNull());
        verify(users, never()).updateById(any(SysUser.class));
    }

    @Test
    @DisplayName("资料没写进去（0 行）：说出来，不回「已保存」")
    void 没存上要说() {
        user(7, null);
        when(users.updateProfile(anyLong(), anyString(), any(), any(), any())).thenReturn(0);
        UpdateProfileRequest request = new UpdateProfileRequest();
        request.setNickname("新昵称");
        assertThrows(BusinessException.class, () -> service().updateProfile(7L, request));
    }

    private List<String> avatarFiles() throws Exception {
        Path dir = uploads.resolve("avatars");
        if (!Files.exists(dir)) {
            return List.of();
        }
        try (Stream<Path> files = Files.list(dir)) {
            return files.map(p -> p.getFileName().toString()).sorted().toList();
        }
    }

    @Test
    @DisplayName("换头像：新的存上、旧的删掉 —— 反复上传不会越堆越多")
    void 换头像删旧的() throws Exception {
        Files.createDirectories(uploads.resolve("avatars"));
        Files.write(uploads.resolve("avatars/7-old.png"), PNG);
        user(7, "/uploads/avatars/7-old.png");
        when(users.updateAvatar(anyLong(), anyString())).thenReturn(1);

        String url = (String) service().uploadAvatar(7L, new MockMultipartFile("file", "a.png", "image/png", PNG)).get("avatar");

        List<String> files = avatarFiles();
        assertEquals(1, files.size(), "旧头像没删：" + files);
        assertEquals("/uploads/avatars/" + files.get(0), url);
        verify(users).updateAvatar(7L, url);
        verify(users, never()).updateById(any(SysUser.class));
    }

    @Test
    @DisplayName("只删自己的：库里的 avatar 指向别人的文件或目录外面时，一个都不动")
    void 只删自己的() throws Exception {
        Files.createDirectories(uploads.resolve("avatars"));
        Files.write(uploads.resolve("avatars/70-someone-else.png"), PNG);
        Files.write(uploads.resolve("7-outside.png"), PNG);
        when(users.updateAvatar(anyLong(), anyString())).thenReturn(1);

        user(7, "/uploads/avatars/70-someone-else.png");
        service().uploadAvatar(7L, new MockMultipartFile("file", "a.png", "image/png", PNG));
        user(7, "/uploads/avatars/7-x/../../7-outside.png");   // 前缀对得上「自己的」，但解析出来在头像目录外面
        service().uploadAvatar(7L, new MockMultipartFile("file", "b.png", "image/png", PNG));

        assertTrue(Files.exists(uploads.resolve("avatars/70-someone-else.png")), "删了别人的头像");
        assertTrue(Files.exists(uploads.resolve("7-outside.png")), "删了头像目录外面的文件");
    }

    @Test
    @DisplayName("头像写库失败：刚存的文件也删掉，并且说出来")
    void 写库失败不留文件() throws Exception {
        user(7, null);
        when(users.updateAvatar(anyLong(), anyString())).thenReturn(0);
        assertThrows(BusinessException.class,
                () -> service().uploadAvatar(7L, new MockMultipartFile("file", "a.png", "image/png", PNG)));
        assertFalse(avatarFiles().stream().anyMatch(n -> n.startsWith("7-")), "没记进库的头像文件留在了盘上");
    }
}
