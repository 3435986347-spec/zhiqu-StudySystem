package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.DecryptFailedException;
import com.zhiqu.entity.RagIndexableUnit;
import com.zhiqu.entity.UserKnowledgePage;
import com.zhiqu.mapper.UserKnowledgePageMapper;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.springframework.stereotype.Component;

@Component
public class WikiPageContentProvider implements UnitContentProvider {

    private final UserKnowledgePageMapper pageMapper;
    private final SensitiveCryptoService cryptoService;

    public WikiPageContentProvider(UserKnowledgePageMapper pageMapper, SensitiveCryptoService cryptoService) {
        this.pageMapper = pageMapper;
        this.cryptoService = cryptoService;
    }

    @Override
    public String namespace() {
        return RagNamespace.WIKI_PAGE;
    }

    @Override
    public UnitContent load(RagIndexableUnit unit) {
        // 双条件：ref_id + user_id。只按 id 取的话，任何一次写错归属的注册都会变成
        // 「把别人的 Wiki 正文喂进模型上下文」，而且没有任何一层会拦住它。
        UserKnowledgePage page = pageMapper.selectOne(new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getId, unit.getRefId())
                .eq(UserKnowledgePage::getUserId, unit.getUserId()));

        // 软删的页在这里返回 null（@TableLogic 自动加 deleted=0），于是走 GONE 分支转 RETIRED。
        // 这正是「页面被删除」与「页面读不出来」必须分开的地方：混成 SKIPPED 的话，
        // 软删页的向量永远不会被清理。
        if (page == null) return UnitContent.gone("PAGE_NOT_FOUND_OR_NOT_OWNED");

        // 类型与标题都要看：只看 page_type 会漏掉「标题为 index、page_type 被改成 NOTE」的页，
        // 那种页知识库当系统页保护、RAG 却照常索引，而 index 是全站标题目录、几乎命中任何查询。
        if (RagNamespace.isExcludedWikiPage(page.getPageType(), page.getTitle())) {
            return UnitContent.gone("EXCLUDED_SYSTEM_PAGE:" + page.getPageType());
        }

        String body;
        try {
            body = cryptoService.decrypt(page.getEncryptedContent());
        } catch (DecryptFailedException e) {
            // 唯一的 catch，且精确到解密失败。写成 catch (Exception) 会把 NPE、mapper 报错
            // 一并记成 SKIPPED，而 max-skipped-ratio=0.05 意味着每 20 个单元可以静默失败 1 个
            // 而不触发告警 —— 门禁就从数据质量信号变成了 bug 藏身处。
            return UnitContent.unusable("DECRYPT_FAILED");
        }

        String canonical = CanonicalText.wiki(page.getTitle(), body);
        if (canonical.isBlank()) return UnitContent.unusable("EMPTY_CONTENT");
        return UnitContent.ok(page.getTitle(), canonical);
    }
}
