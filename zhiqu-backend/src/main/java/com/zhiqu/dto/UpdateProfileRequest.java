package com.zhiqu.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

/** 长度上限就是 sys_user 里各列的长度（V1 / V20）：超了原来是数据库报「Data too long」、把 SQL 原文回给用户。 */
@Data
public class UpdateProfileRequest {
    @NotBlank(message = "昵称不能为空")
    @Size(max = 50, message = "昵称最长 50 个字")
    private String nickname;

    @Size(max = 100, message = "学校最长 100 个字")
    private String school;

    @Size(max = 100, message = "专业最长 100 个字")
    private String major;

    @Size(max = 120, message = "邮箱最长 120 个字")
    private String email;
}
