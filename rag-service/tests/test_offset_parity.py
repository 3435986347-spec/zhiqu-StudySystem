"""code point 偏移的跨语言平价（Python 侧）。

与 zhiqu-backend 的 OffsetParityTest 共读同一份 fixture，断言同一批数字。
平价是跨语言性质：任一侧单独跟自己的期望值比对，两边同时漂了也会全绿。

Python 的 str 本身就是 code point 序列，len() 与切片天然是 code point 语义，
所以本文件里的断言近乎恒等——真正的风险全在 Java 侧的 UTF-16 转换。
把它写下来的意义是：fixture 一旦被改，两侧会同时红，而不是只有一侧。
"""

import json
from pathlib import Path

FIXTURE = Path(__file__).parent / "fixtures" / "offset_parity.json"


def load_cases():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


def test_code_point_counts_match_fixture():
    cases = load_cases()
    assert len(cases) >= 7, "fixture 用例被删减了？平价覆盖面会跟着缩水"
    for case in cases:
        assert len(case["text"]) == case["codePointCount"], case["name"]


def test_slices_match_fixture():
    for case in load_cases():
        text = case["text"]
        for slice_spec in case["slices"]:
            actual = text[slice_spec["start"]:slice_spec["end"]]
            assert actual == slice_spec["expected"], f"{case['name']} {slice_spec}"


def test_fixture_actually_contains_astral_characters():
    """守住 fixture 的覆盖面：全是 BMP 字符的话，这套平价测试等于没测。

    Java 侧的 length() 与 codePointCount() 只在星平面字符上才会分叉——
    fixture 里若一个都没有，两边永远一致，测试变成摆设。
    """
    astral = [c for case in load_cases() for c in case["text"] if ord(c) > 0xFFFF]
    assert astral, "fixture 里必须含至少一个非 BMP 字符（emoji / 扩展 CJK）"


def test_segment_text_hands_the_tokenizer_the_untransformed_text():
    """加法合成的前提：偏移相对于**我们传进去的那个串**，中间没有归一化。

    这条曾经写成 `parent[seg.char_start:seg.char_end] == seg.text`，那是同义反复——
    segmenter.py:33 就是 `Segment(..., text[cs:ce], cs, ce)`，`text` 字段由该切片
    构造，断言永假不了（tests/test_segmenter.py:14 是同一形状的另一份）。

    真正能红的断言是「tokenizer 收到的串必须与我们传入的逐字相同」：偏移由 tokenizer
    在它看到的那个串上算出，若 segment_text 在调用前做了归一化，参照系就换了人，
    而 Java 侧仍按原串做 absolute = chunk.charStart + segment.charStart——错位且不报错。

    样本刻意用分解式 é（e + U+0301）：NFC 会把它压成 1 个 code point，参照系一换本条立刻红。
    """
    import unicodedata

    from app.segmenter import segment_text

    seen = []

    class RecordingTokenizer:
        def __call__(self, text, **_):
            seen.append(text)
            return {"offset_mapping": [(i, i + 1) for i in range(len(text))]}

    parent = "研究计划é" + "内容" * 400
    # 构造前提：样本必须是「归一化会改变的形状」，否则本条测不出归一化，等于白写
    # （同 OffsetParityTest 里 filler=1198 的教训：恒真的构造让扰动验证虚假通过）。
    assert unicodedata.normalize("NFC", parent) != parent

    segments = segment_text(parent, RecordingTokenizer(), max_tokens=100, overlap=20)

    assert seen, "tokenizer 没被调用，本条什么都没验证"
    assert seen[0] == parent, "segment_text 在调用 tokenizer 前变换了文本，偏移参照系已不是传入串"
    # 第二个独立探测点：末段的 char_end 按**传入串**的长度计。
    # 有人若「修好」上一条却仍在归一化后的串上算偏移，这里会红。
    assert segments[-1].char_end == len(parent)
