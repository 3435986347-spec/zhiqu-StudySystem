from app.segmenter import segment_text, vector_id


class CharacterTokenizer:
    def __call__(self, text, **_):
        return {"offset_mapping": [(index, index + 1) for index in range(len(text))]}


def test_segments_respect_limit_and_offsets():
    text = "0123456789" * 120
    segments = segment_text(text, CharacterTokenizer(), max_tokens=448, overlap=64)
    assert len(segments) == 3
    assert all(len(item.text) <= 448 for item in segments)
    assert all(text[item.char_start:item.char_end] == item.text for item in segments)
    assert segments[1].char_start == 384


def test_vector_id_is_deterministic():
    assert vector_id("v1", 3, 8, 2) == "v1:3:8:2"
    assert vector_id("v1", 3, 8, 2) == vector_id("v1", 3, 8, 2)
