package com.zhiqu.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class UpdateProfileRequest {
    @NotBlank(message = "昵称不能为空")
    private String nickname;

    private String school;

    private String major;

    private String email;
}
