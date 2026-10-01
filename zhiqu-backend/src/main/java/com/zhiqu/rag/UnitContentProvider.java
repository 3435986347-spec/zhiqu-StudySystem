package com.zhiqu.rag;

import com.zhiqu.entity.RagIndexableUnit;

/**
 * 按命名空间回读单元正文。每个命名空间恰好一个实现，由 {@link UnitContentResolver} 分派。
 *
 * <p><b>实现约定（两条都不是可选的）：</b>
 * <ol>
 *   <li><b>按 {@code ref_id} 与 {@code unit.userId} 双条件回读</b> —— 权限二次校验。
 *       投影行是异步写进去的，与当前请求的登录态无关；只按 ref_id 取，一旦某个注册路径
 *       写错了归属，这里就会把别人的内容喂进模型上下文。</li>
 *   <li><b>只捕获 {@link com.zhiqu.common.DecryptFailedException}，转成
 *       {@link UnitContent#unusable}。</b>其余异常一律让它抛出去 —— 见
 *       {@link RagUnitRegistry#reconcileAll} 的说明。</li>
 * </ol>
 */
public interface UnitContentProvider {

    /** 本实现负责的命名空间，取值见 {@link RagNamespace}。 */
    String namespace();

    UnitContent load(RagIndexableUnit unit);
}
