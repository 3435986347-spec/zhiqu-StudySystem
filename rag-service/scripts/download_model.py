import argparse
from pathlib import Path

from huggingface_hub import snapshot_download


def main() -> None:
    parser = argparse.ArgumentParser(description="Download a pinned BGE model for offline production use.")
    parser.add_argument("--revision", required=True, help="Immutable Hugging Face commit SHA")
    parser.add_argument("--target", required=True, type=Path)
    args = parser.parse_args()
    revision = args.revision.strip()
    if len(revision) != 40 or any(char not in "0123456789abcdefABCDEF" for char in revision):
        raise SystemExit("--revision must be an immutable 40-character commit SHA")
    args.target.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id="BAAI/bge-small-zh-v1.5",
        revision=revision,
        local_dir=str(args.target),
        local_dir_use_symlinks=False,
    )
    (args.target / "ZHIQU_MODEL_REVISION").write_text(revision + "\n", encoding="utf-8")
    print(f"Downloaded BAAI/bge-small-zh-v1.5@{revision} to {args.target}")


if __name__ == "__main__":
    main()
