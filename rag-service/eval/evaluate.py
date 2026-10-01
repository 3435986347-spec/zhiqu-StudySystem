import argparse
import json
import statistics
import time
import urllib.request
from pathlib import Path


def post_json(url: str, token: str, body: dict) -> dict:
    request = urllib.request.Request(
        url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Zhiqu RAG Recall@8, citation precision and latency.")
    parser.add_argument("dataset", type=Path, help="JSONL with query payload plus expectedSourceIds")
    parser.add_argument("--url", default="http://127.0.0.1:8001/v1/query")
    parser.add_argument("--token", required=True)
    args = parser.parse_args()
    cases = [json.loads(line) for line in args.dataset.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(cases) < 60:
        raise SystemExit("Quality gate requires at least 60 questions")
    recalls, precisions, latencies = [], [], []
    document_ids = set()
    for case in cases:
        expected = {int(item) for item in case.pop("expectedSourceIds")}
        document_ids.update(expected)
        started = time.perf_counter()
        result = post_json(args.url, args.token, case)
        latencies.append((time.perf_counter() - started) * 1000)
        returned = [int(item["sourceId"]) for item in (result.get("candidates") or [])[:8]]
        matched = sum(1 for item in returned if item in expected)
        recalls.append(1.0 if expected.intersection(returned) else 0.0)
        precisions.append(matched / len(returned) if returned else 0.0)
    if len(document_ids) < 20:
        raise SystemExit("Quality gate requires questions covering at least 20 sources")
    p95 = sorted(latencies)[max(0, int(len(latencies) * 0.95 + 0.9999) - 1)]
    summary = {
        "questions": len(cases), "sources": len(document_ids),
        "recallAt8": statistics.mean(recalls),
        "citationPrecision": statistics.mean(precisions), "queryP95Ms": p95,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if summary["recallAt8"] < 0.85 or summary["citationPrecision"] < 0.90 or p95 > 1500:
        raise SystemExit("RAG quality gate failed")


if __name__ == "__main__":
    main()
