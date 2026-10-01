from sentence_transformers import SentenceTransformer
from transformers import AutoTokenizer

from .settings import Settings


QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章："


class EmbeddingService:
    def __init__(self, settings: Settings):
        path = str(settings.model_path)
        self.tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True)
        self.model = SentenceTransformer(path, device=settings.device, local_files_only=True)
        self.model.max_seq_length = min(int(self.model.max_seq_length), 512)
        self.dimension = int(self.model.get_sentence_embedding_dimension())

    def encode_passages(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        values = self.model.encode(texts, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
        return values.tolist()

    def encode_query(self, question: str) -> list[float]:
        value = self.model.encode(
            [QUERY_INSTRUCTION + question], normalize_embeddings=True,
            convert_to_numpy=True, show_progress_bar=False
        )
        return value[0].tolist()
