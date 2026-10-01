from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path


ALLOWED_SCHEMES = {"http", "https"}
APPROVED_LICENSES = {
    "APACHE-2.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC0-1.0", "PUBLIC-DOMAIN",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def safe_target(name: str) -> str:
    target = Path(name)
    if target.name != name or target.suffix.lower() != ".pdf":
        raise ValueError(f"target must be a plain PDF filename: {name}")
    return name


def download(row: dict, output: Path) -> Path:
    parsed = urllib.parse.urlparse(str(row.get("url") or ""))
    if parsed.scheme not in ALLOWED_SCHEMES or not parsed.hostname:
        raise ValueError(f"invalid public URL for {row.get('id')}")
    expected = str(row.get("sha256") or "").lower()
    if len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected):
        raise ValueError(f"sha256 must be pinned before downloading {row.get('id')}")
    if not row.get("license"):
        raise ValueError(f"license is required for {row.get('id')}")
    review_status = str(row.get("licenseReviewStatus") or "").upper()
    if review_status not in {"APPROVED", "REVIEW_REQUIRED"}:
        raise ValueError(f"licenseReviewStatus must be APPROVED or REVIEW_REQUIRED for {row.get('id')}")
    license_id = str(row.get("license") or "").upper()
    if review_status == "APPROVED" and license_id not in APPROVED_LICENSES:
        raise ValueError(f"approved license is not allowlisted for {row.get('id')}: {license_id}")
    if not row.get("attribution"):
        raise ValueError(f"attribution is required for {row.get('id')}")
    source_commit = str(row.get("sourceCommit") or "").lower()
    if len(source_commit) != 40 or any(character not in "0123456789abcdef" for character in source_commit):
        raise ValueError(f"sourceCommit must be a pinned git commit for {row.get('id')}")
    if review_status == "APPROVED" and not row.get("licenseUrl"):
        raise ValueError(f"licenseUrl is required for {row.get('id')}")
    target = output / safe_target(str(row.get("target") or f"{row['id']}.pdf"))
    if target.exists() and sha256(target) == expected:
        return target
    request = urllib.request.Request(row["url"], headers={"User-Agent": "zhiqu-pdf-eval/1.0"})
    with tempfile.NamedTemporaryFile(dir=output, suffix=".part", delete=False) as temporary:
        temporary_path = Path(temporary.name)
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status != 200:
                raise RuntimeError(f"download failed with HTTP {response.status}")
            while block := response.read(1024 * 1024):
                temporary.write(block)
    try:
        actual = sha256(temporary_path)
        if actual != expected:
            raise ValueError(f"sha256 mismatch for {row['id']}: expected {expected}, got {actual}")
        os.replace(temporary_path, target)
        return target
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Download hash-pinned public PDF evaluation fixtures")
    parser.add_argument("--sources", type=Path, default=root / "corpus/public-sources.example.jsonl")
    parser.add_argument("--output", type=Path, default=root / "corpus/downloads")
    parser.add_argument("--manifest-output", type=Path, default=root / "corpus/downloads/manifest.public.jsonl")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = []
    for row in load_jsonl(args.sources):
        path = download(row, args.output)
        manifest.append({
            "id": row["id"], "path": str(path.resolve()), "category": row["category"],
            "visibility": "PUBLIC", "sha256": row["sha256"].lower(), "sourceUrl": row["url"],
            "license": row["license"], "licenseUrl": row.get("licenseUrl"),
            "licenseReviewStatus": row["licenseReviewStatus"],
            "attribution": row["attribution"], "sourceCommit": row["sourceCommit"],
            "gold": row.get("gold") or {},
        })
    args.manifest_output.parent.mkdir(parents=True, exist_ok=True)
    args.manifest_output.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in manifest) + "\n", encoding="utf-8")
    print(json.dumps({"downloaded": len(manifest), "manifest": str(args.manifest_output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
