# Zhiqu PDF parser A/B evaluation

This isolated tool compares the production baseline PDFBox `3.0.1` with OpenDataLoader PDF `2.4.7` local deterministic mode. It does not change the Notebook upload path, database, API, RAG feature flag, or production JAR.

## Architecture

```text
manifest + gold annotations
        |
        v
Python benchmark supervisor
   |                    |
   v                    v
PDFBox runner       OpenDataLoader runner
(own classpath)     (own classpath)
   |                    |
   +---- ParseResult ---+
             |
             v
ignored raw output + sanitized JSON/Markdown report
```

Both runners are persistent JSONL processes. They use separate classpaths so OpenDataLoader's PDF/veraPDF dependencies cannot alter the PDFBox baseline. The supervisor applies a 120-second timeout, starts each JVM with `-Xmx1024m`, samples process RSS, and restarts a failed runner.

OpenDataLoader runs with Hybrid and image output disabled, one processing thread, XY-Cut reading order, and JSON/Markdown/Text output. No OCR, formula recognition, image description, or network service is used.

## Build

Java 17 is required. The repository includes an evaluation-only Maven settings file because OpenDataLoader depends on veraPDF artifacts from the repository listed in its official Java setup.

```powershell
cd pdf-parser-eval
mvn -s maven-settings.xml clean package -DskipTests
python -m unittest discover -s benchmark/tests -v
```

Generated executables:

```text
pdfbox-runner/target/pdfbox-runner-all.jar
opendataloader-runner/target/opendataloader-runner-all.jar
```

## Smoke run

```powershell
python benchmark/download_public_corpus.py
python benchmark/benchmark.py `
  --manifest corpus/downloads/manifest.public.jsonl `
  --output output/smoke `
  --allow-incomplete
```

`--allow-incomplete` always returns `NEEDS_MORE_DATA`; it can never promote a parser.

## Full gate

```powershell
python benchmark/benchmark.py `
  --manifest corpus/downloads/manifest.public.jsonl `
  --manifest corpus/manifest.private.jsonl `
  --output output/full
```

Malformed manifests are rejected before parsing: IDs must match `[A-Za-z0-9][A-Za-z0-9._-]{0,99}`, files and pinned hashes must match, and the complete report directory must stay below this project's Git-ignored `output/` root. `--output` cannot redirect raw attempts elsewhere in the repository.

The formal decision gate requires at least 24 unique PDF hashes, six documents per category, and at least three PUBLIC plus three PRIVATE documents in every category. All digital PDFs need three representative pages, human reference text, and ordered anchors; every digital category needs heading gold for at least three documents; TABLE documents need non-empty table gold; SCAN documents must declare `scan=true`. A public file must declare `licenseReviewStatus=APPROVED` and use an allowlisted redistributable license; arbitrary license strings, arXiv distribution terms, incomplete provenance, and `REVIEW_REQUIRED` samples remain smoke-only. Any coverage gap forces `NEEDS_MORE_DATA` and is listed in the report.

Each parser runs every document three times. Determinism hashes engine/version/file identity, page count, OCR/truncation flags, normalized text, Markdown, and the full ordered element structure, including pages, heading levels, tables, and bounding boxes. Timing and RSS remain performance measurements rather than deterministic content. All three ignored raw attempts are retained for diagnosis. The public report contains metrics, hashes, timings, diagnostic counts, and safe error codes only; it never includes request IDs, stderr, paths, source text, Markdown, or elements. The final decision is restricted to:

- `KEEP_PDFBOX`
- `OPENDATALOADER_CANDIDATE`
- `CATEGORY_ROUTING_CANDIDATE`
- `NEEDS_MORE_DATA`

Passing this experiment does not switch production parsing. A separate reviewed change is required to introduce a parser abstraction, quality fallback, and old-source reparse/reindex workflow.

`CATEGORY_ROUTING_CANDIDATE` is subject to the same global determinism, memory, latency, scan detection, and success gates as the full candidate. Heading matches require the annotated page, and heading level accuracy participates in document quality, aggregation, minimum thresholds, and regression checks. Its selected category must also pass category-level success/performance checks and cannot regress text or heading quality; two-column and table routes must pass their respective structure thresholds.

## ParseResult protocol

Request, one JSON object per line:

```json
{"requestId":"case-1","input":"C:/corpus/file.pdf","maxPages":200,"maxOutputChars":500000,"maxFileBytes":20971520}
```

Response fields:

```text
requestId/engine/version/fileHash/pageCount/text/markdown/elements
elapsedMs/peakRssBytes/warnings/error/truncated/needsOcr
```

Every element uses `type/page/boundingBox/headingLevel/tableRows/tableColumns/content`.
