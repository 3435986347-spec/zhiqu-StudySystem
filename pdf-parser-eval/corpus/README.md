# PDF A/B corpus

The full quality gate requires 24 valid PDFs: six each in `LECTURE`, `TWO_COLUMN`, `TABLE`, and `SCAN`.
Each category must contain at least three representative local documents and three reproducible public documents.

## Private documents

1. Copy `manifest.template.jsonl` to `manifest.private.jsonl`.
2. Put private PDFs under `corpus/private/`.
3. Replace every placeholder path and SHA-256.
4. Add human gold annotations. For digital PDFs, annotate at least three representative pages. For table PDFs, annotate every target table page.

`manifest.private.jsonl`, private PDFs, parser outputs, and private annotations are ignored by Git.

## Public documents

`public-sources.example.jsonl` contains a small, hash-pinned smoke set copied from the OpenDataLoader repository. The repository license does not automatically license third-party PDFs: every row records its own license, attribution, and pinned source commit. Rows marked `REVIEW_REQUIRED` are smoke-only and cannot satisfy the full decision gate. Download it with:

```powershell
python benchmark/download_public_corpus.py
```

The downloader requires `http/https`, a license declaration, attribution, a 40-character source commit, a plain `.pdf` target name, and a pinned SHA-256. A confirmed license also requires `licenseUrl`. It writes a runnable manifest to `corpus/downloads/manifest.public.jsonl`.

The smoke set is not the 24-document acceptance corpus and has no human gold annotations. It can validate protocol, failure isolation, deterministic hashing, and report privacy only.

## Gold annotation fields

```json
{
  "representativePages": [1, 2, 3],
  "referenceText": "Human-corrected text from exactly those pages",
  "orderedAnchors": ["first passage", "second passage"],
  "headings": [{"page": 1, "text": "Chapter 1", "level": 1}],
  "tables": [{"page": 2, "rows": [["Header A", "Header B"], ["A", "B"]]}]
}
```

For `SCAN`, use a structurally valid image-based PDF and `{"scan": true}`. A zero-byte, corrupt, or encrypted file is an error fixture, not a scan fixture.

The formal gate also rejects duplicate PDF hashes, fewer than three PUBLIC and three PRIVATE files in any category, incomplete digital text/order gold, fewer than three heading annotations per digital category, empty TABLE gold, and unconfirmed public licenses. These gaps produce `NEEDS_MORE_DATA`; malformed IDs, paths, hashes, or files stop the run.
