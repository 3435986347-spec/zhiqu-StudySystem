package com.zhiqu.service.concurrency;

import com.zhiqu.common.Result;
import com.zhiqu.security.SecurityUtils;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.reflect.MethodSignature;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.lang.annotation.Annotation;
import java.lang.reflect.Method;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 每一个登录后的写接口都认 {@code Idempotency-Key}（第二十二轮）。
 *
 * <p>原来只有新建任务、套用参考计划、AI 批量建任务自己接了这个头。真浏览器里把回应掐在回来的路上（服务器已经做完了）：
 * 页面说「网络连接失败，请检查网络后重试」，学生照着再点一次 —— 例行计划、Notebook、Wiki 页、反馈、番茄钟记录、快速添加的任务
 * 全都变成两份；删除的第二下说「任务不存在或无权访问」，其实删掉了。页面不敢自动重来也是这个原因：重来可能写两遍。
 *
 * <p>这里给所有 {@code @PostMapping / @PutMapping / @DeleteMapping / @PatchMapping} 统一接上：带着这个头来的，按
 * 「用户 + 这个接口 + 这个地址 + 键」只执行一次，同键再来拿回上一次的结果（成功的留 10 分钟，见 {@link IdempotencyService}）。
 * 页面那边（{@code zhiqu-api.js} 的 {@code request()}）给每个写请求带一个键，回应丢了就用同一个键自动重来、学生再点也用同一个键。
 *
 * <p>不接的：
 * <ul>
 *   <li>自己已经在参数里接了这个头的 —— 它们有自己的 scope，接两层会拿同一个键锁两次；</li>
 *   <li>参数里有 {@link HttpServletResponse} 的（登录、退出、改密码 —— 回应里带着 Cookie，缓存的结果重放不出 Cookie）；</li>
 *   <li>不是回 {@link Result} 的（流式回答回的是 SseEmitter，没法缓存）；</li>
 *   <li>没登录的（没有用户可以分开各人的键）。</li>
 * </ul>
 */
@Aspect
@Component
public class IdempotentWriteAspect {
    static final String HEADER = "Idempotency-Key";

    private static final Map<Method, Boolean> COVERED = new ConcurrentHashMap<>();

    private final IdempotencyService idempotency;

    public IdempotentWriteAspect(IdempotencyService idempotency) {
        this.idempotency = idempotency;
    }

    @Around("within(com.zhiqu.controller..*) && ("
            + "@annotation(org.springframework.web.bind.annotation.PostMapping)"
            + " || @annotation(org.springframework.web.bind.annotation.PutMapping)"
            + " || @annotation(org.springframework.web.bind.annotation.DeleteMapping)"
            + " || @annotation(org.springframework.web.bind.annotation.PatchMapping))")
    @SuppressWarnings("unchecked")
    public Object once(ProceedingJoinPoint pjp) throws Throwable {
        Method method = ((MethodSignature) pjp.getSignature()).getMethod();
        if (!COVERED.computeIfAbsent(method, IdempotentWriteAspect::covers)) {
            return pjp.proceed();
        }
        HttpServletRequest request = currentRequest();
        String key = request == null ? null : request.getHeader(HEADER);
        Long userId = SecurityUtils.getCurrentUserIdOrNull();
        if (key == null || key.isBlank() || userId == null) {
            return pjp.proceed();
        }
        String scope = method.getDeclaringClass().getSimpleName() + "." + method.getName() + " " + request.getMethod() + " "
                + request.getRequestURI() + (request.getQueryString() == null ? "" : "?" + request.getQueryString());
        return idempotency.execute(userId, scope, key, () -> {
            try {
                return (Result<Object>) pjp.proceed();
            } catch (Throwable e) {
                throw IdempotentWriteAspect.<RuntimeException>rethrow(e);
            }
        });
    }

    /** 这个写接口接不接幂等键（请求带着头、用户登录着时）。不接的见类注释；有哪些由 IdempotentWriteIntegrationTest 列清楚。 */
    static boolean covers(Method method) {
        if (!Result.class.isAssignableFrom(method.getReturnType())) {
            return false;
        }
        for (Class<?> type : method.getParameterTypes()) {
            if (HttpServletResponse.class.isAssignableFrom(type)) {
                return false;
            }
        }
        for (Annotation[] annotations : method.getParameterAnnotations()) {
            for (Annotation a : annotations) {
                if (a instanceof RequestHeader h && (HEADER.equalsIgnoreCase(h.value()) || HEADER.equalsIgnoreCase(h.name()))) {
                    return false;
                }
            }
        }
        return true;
    }

    private static HttpServletRequest currentRequest() {
        return RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attrs ? attrs.getRequest() : null;
    }

    /** 业务抛什么就原样往外抛（受检的也一样），交给 GlobalExceptionHandler —— 和不带键时一模一样。 */
    @SuppressWarnings("unchecked")
    private static <E extends Throwable> E rethrow(Throwable e) throws E {
        throw (E) e;
    }
}
