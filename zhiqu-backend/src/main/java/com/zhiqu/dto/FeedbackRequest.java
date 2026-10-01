package com.zhiqu.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
public class FeedbackRequest {
    @NotBlank(message = "反馈内容不能为空")
    @Size(max = 1000, message = "反馈内容不能超过 1000 字")
    private String content;
}
