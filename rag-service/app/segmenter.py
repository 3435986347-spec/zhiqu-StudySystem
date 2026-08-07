from dataclasses import dataclass
from typing import Protocol


class OffsetTokenizer(Protocol):
    def __call__(self, text: str, **kwargs): ...


@dataclass(frozen=True)
class Segment:
    index: int
    text: str
    char_start: int
    char_end: int


def segment_text(text: str, tokenizer: OffsetTokenizer, max_tokens: int = 448, overlap: int = 64) -> list[Segment]:
    if not text:
        return []
    encoded = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True, truncation=False)
    offsets = encoded.get("offset_mapping") or []
    if not offsets:
        return [Segment(0, text, 0, len(text))]
    step = max_tokens - overlap
    result: list[Segment] = []
    token_start = 0
    segment_index = 0
    while token_start < len(offsets):
        token_end = min(len(offsets), token_start + max_tokens)
        char_start = int(offsets[token_start][0])
        char_end = int(offsets[token_end - 1][1])
        if char_end > char_start:
            result.append(Segment(segment_index, text[char_start:char_end], char_start, char_end))
            segment_index += 1
        if token_end >= len(offsets):
            break
        token_start += step
    return result


def vector_id(index_version: str, unit_id: int, chunk_id: int, segment_index: int) -> str:
    """向量 id。第二段从 sourceId 换成 unitId（1B-2）。

    不带 namespace 是刻意的：`rag_indexable_unit.id` 是 V29 引入的代理主键，
    跨命名空间全局唯一 —— 这正是它存在的理由（「资料 7 与 Wiki 页 7 在向量库里
    必须是两个东西」）。多带一段 namespace 只会多一个两侧可能写不一致的地方，
    而 id 不一致的后果是 `_finalize_source` 的 keep 集合对不上 → 刚写进去的向量
    被当成 stale 立刻删掉。
    """
    return f"{index_version}:{unit_id}:{chunk_id}:{segment_index}"
