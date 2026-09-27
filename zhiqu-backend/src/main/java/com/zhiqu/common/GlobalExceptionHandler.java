package com.zhiqu.common;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.exc.InvalidFormatException;
import com.fasterxml.jackson.databind.exc.MismatchedInputException;
import com.zhiqu.service.RuntimeIssueService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.BindException;
import org.springframework.validation.FieldError;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.time.format.DateTimeParseException;
import java.util.stream.Collectors;

/**
 * 异常 → 回包。
 *
 * <p><b>请求本身有问题</b>（不是合法 JSON、字段类型不对、路径里的 id 给了字母、缺参数、日期写错、没按上传的格式发）
 * 回 400 并说清哪里不对，<b>不</b>记成运行问题。第十一轮的全接口暴力测试（{@code EndpointFuzzIntegrationTest}）之前，
 * 这些全都落进最后那个兜底分支：记成一条「服务器异常」（156 个接口里查出 499 处），管理员后台的运行问题被坏输入刷屏，
 * 用户看到的是一段 Java 异常原文（{@code Failed to convert value of type 'java.lang.String' to required type 'java.lang.Long'…}）。
 *
 * <p><b>真正的意外</b>照旧记成运行问题，但<b>不再把异常原文回给用户</b>：原文里有 SQL、表名、类名
 * （{@code ### Error updating database. Cause: com.mysql…Data too long for column 'username'}）。用户拿到的是一句话和一个编号，
 * 管理员按编号在运行问题里找得到全部细节。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {
    private final RuntimeIssueService runtimeIssueService;

    public GlobalExceptionHandler(RuntimeIssueService runtimeIssueService) {
        this.runtimeIssueService = runtimeIssueService;
    }

    @ExceptionHandler(BusinessException.class)
    public Result<Void> handleBusiness(BusinessException e) {
        return Result.fail(e.getMessage());
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, BindException.class})
    public Result<Void> handleInvalid(BindException e) {
        // 校验注解上写的就是给人看的话（「用户名最长 50 个字符」）；Spring 自己的那句是「Validation failed for argument [0]…」
        String message = e.getFieldErrors().stream().map(FieldError::getDefaultMessage)
                .filter(m -> m != null && !m.isBlank()).distinct().collect(Collectors.joining("；"));
        return bad(message.isEmpty() ? "提交的内容不符合要求" : message);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public Result<Void> handleIllegalArgument(IllegalArgumentException e) {
        return bad(e.getMessage() == null ? "参数不对" : e.getMessage());
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public Result<Void> handleUnreadable(HttpMessageNotReadableException e) {
        Throwable cause = e.getMostSpecificCause();
        if (cause instanceof InvalidFormatException f) {
            return bad("字段 " + path(f) + " 的值「" + shorten(String.valueOf(f.getValue())) + "」不对，应当是" + typeName(f.getTargetType()));
        }
        if (cause instanceof MismatchedInputException m && !m.getPath().isEmpty()) {
            return bad("字段 " + path(m) + " 的类型不对" + (m.getTargetType() == null ? "" : "，应当是" + typeName(m.getTargetType())));
        }
        if (cause instanceof JsonProcessingException) {
            return bad("请求内容不是合法的 JSON");
        }
        return bad("缺少请求内容，或者请求内容读不懂");
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public Result<Void> handleTypeMismatch(MethodArgumentTypeMismatchException e) {
        return bad("参数 " + e.getName() + " 的值「" + shorten(String.valueOf(e.getValue())) + "」不对，应当是"
                + typeName(e.getRequiredType()));
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    public Result<Void> handleMissingParam(MissingServletRequestParameterException e) {
        return bad("缺少参数 " + e.getParameterName());
    }

    @ExceptionHandler(MissingRequestHeaderException.class)
    public Result<Void> handleMissingHeader(MissingRequestHeaderException e) {
        return bad("缺少请求头 " + e.getHeaderName());
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public Result<Void> handleTooLarge(MaxUploadSizeExceededException e) {
        return bad("文件太大了，超过了上传上限");
    }

    @ExceptionHandler({MultipartException.class, HttpMediaTypeNotSupportedException.class})
    public Result<Void> handleWrongContentType(Exception e) {
        return bad("这个接口要用文件上传的方式提交（multipart/form-data），或者提交的内容类型不对");
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public Result<Void> handleMethod(HttpRequestMethodNotSupportedException e) {
        return new Result<>(405, "这个地址不支持 " + e.getMethod() + " 请求", null);
    }

    /** 日期几乎总是从请求里来的（?date=2026-02-30）：说清楚格式，不当成服务器坏了。 */
    @ExceptionHandler(DateTimeParseException.class)
    public Result<Void> handleDate(DateTimeParseException e) {
        return bad("日期 / 时间「" + shorten(e.getParsedString()) + "」格式不对，应当像 2026-09-28（时间像 2026-09-28T08:00:00）");
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public Result<Void> handleMissingStaticResource(NoResourceFoundException e) {
        return new Result<>(404, "Resource not found", null);
    }

    @ExceptionHandler(Exception.class)
    public Result<Void> handleOther(Exception e, HttpServletRequest request) {
        Long id = runtimeIssueService.reportServerIssue(e, request);
        return Result.fail("服务器出错了，已经记录下来" + (id == null ? "" : "（编号 " + id + "）") + "，请稍后再试");
    }

    private static Result<Void> bad(String message) {
        return new Result<>(400, message, null);
    }

    private static String path(JsonMappingException e) {
        String p = e.getPath().stream()
                .map(r -> r.getFieldName() != null ? r.getFieldName() : "[" + r.getIndex() + "]")
                .collect(Collectors.joining("."));
        return p.isEmpty() ? "(整体)" : p;
    }

    private static String shorten(String s) {
        if (s == null) {
            return "";
        }
        return s.length() > 40 ? s.substring(0, 40) + "…" : s;
    }

    static String typeName(Class<?> type) {
        if (type == null) {
            return "别的类型";
        }
        if (Number.class.isAssignableFrom(type) || (type.isPrimitive() && type != boolean.class && type != char.class)) {
            return "数字";
        }
        if (type == Boolean.class || type == boolean.class) {
            return " true 或 false";
        }
        if (type == String.class) {
            return "文字";
        }
        if (java.time.temporal.Temporal.class.isAssignableFrom(type)) {
            return "日期（像 2026-09-28）";
        }
        if (java.util.Collection.class.isAssignableFrom(type) || type.isArray()) {
            return "一个列表";
        }
        if (type.isEnum()) {
            return "其中之一：" + java.util.Arrays.stream(type.getEnumConstants()).map(String::valueOf).collect(Collectors.joining(" / "));
        }
        return "一个对象";
    }
}
