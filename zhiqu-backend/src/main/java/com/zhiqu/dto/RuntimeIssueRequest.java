package com.zhiqu.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
public class RuntimeIssueRequest {
    @NotBlank(message = "错误信息不能为空")
    @Size(max = 1000, message = "错误信息不能超过 1000 字")
    private String message;

    @Size(max = 80, message = "错误类型不能超过 80 字")
    private String category;

    @Size(max = 20, message = "严重级别不能超过 20 字")
    private String severity;

    @Size(max = 8000, message = "错误详情不能超过 8000 字")
    private String detail;

    @Size(max = 1000, message = "页面地址不能超过 1000 字")
    private String pageUrl;

    @Size(max = 500, message = "接口路径不能超过 500 字")
    private String apiPath;
}
