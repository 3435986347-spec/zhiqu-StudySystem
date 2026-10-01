package com.zhiqu.rag;

import com.zhiqu.entity.RagIndexableUnit;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 按 {@code namespace} 把回读请求分派给对应的 {@link UnitContentProvider}。
 *
 * <p>构造函数收 {@code List<UnitContentProvider>}（Spring 注入全部实现）而不是硬编码分支，
 * 这样加第四个命名空间时本类零改动；测试也能用桩 provider 组装出一个受控的 resolver。
 */
@Service
public class UnitContentResolver {

    private final Map<String, UnitContentProvider> byNamespace;

    public UnitContentResolver(List<UnitContentProvider> providers) {
        Map<String, UnitContentProvider> registry = new LinkedHashMap<>();
        for (UnitContentProvider provider : providers) {
            UnitContentProvider previous = registry.put(provider.namespace(), provider);
            if (previous != null) {
                throw new IllegalStateException("命名空间 " + provider.namespace() + " 注册了两个 provider："
                        + previous.getClass().getName() + " 与 " + provider.getClass().getName()
                        + "。哪个生效取决于 bean 顺序，两者对同一份内容算出的 canonical_hash 一旦不同，"
                        + "就会表现为该命名空间被无限重建");
            }
        }
        this.byNamespace = Map.copyOf(registry);
    }

    public UnitContent load(RagIndexableUnit unit) {
        UnitContentProvider provider = byNamespace.get(unit.getNamespace());
        if (provider == null) {
            // 刻意抛出而不是返回 GONE：没有 provider 是「这版代码还不支持它」，
            // 当成 GONE 会把一批完好的单元退役掉并删掉它们的向量。
            throw new IllegalStateException("命名空间 " + unit.getNamespace() + " 没有 UnitContentProvider"
                    + "（unitId=" + unit.getId() + "）");
        }
        return provider.load(unit);
    }

    public Set<String> supportedNamespaces() {
        return byNamespace.keySet();
    }
}
