from __future__ import annotations

import argparse
import collections
import ctypes
import difflib
import hashlib
import json
import math
import os
import platform
import queue
import re
import statistics
import subprocess
import sys
import threading
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any


CATEGORIES = ("LECTURE", "TWO_COLUMN", "TABLE", "SCAN")
DIGITAL_CATEGORIES = CATEGORIES[:-1]
ENGINES = ("PDFBOX", "OPENDATALOADER")
DEFAULT_TIMEOUT_SECONDS = 120
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_PAGES = 200
MAX_OUTPUT_CHARS = 500_000
SAFE_CASE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
VISIBILITIES = ("PUBLIC", "PRIVATE")
APPROVED_LICENSES = {
    "APACHE-2.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC0-1.0", "PUBLIC-DOMAIN",
}


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in value.splitlines()).strip()


def compact(value: str) -> str:
    return re.sub(r"\s+", "", normalize(value)).lower()


def safe_mean(values: list[float]) -> float | None:
    return statistics.mean(values) if values else None


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * quantile) - 1))
    return ordered[index]


def multiset_prf(reference: str, actual: str) -> dict[str, float]:
    expected = collections.Counter(compact(reference))
    returned = collections.Counter(compact(actual))
    matched = sum((expected & returned).values())
    expected_count = sum(expected.values())
    returned_count = sum(returned.values())
    precision = matched / returned_count if returned_count else 0.0
    recall = matched / expected_count if expected_count else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": precision, "recall": recall, "f1": f1}


def ordered_anchor_score(anchors: list[str], actual: str) -> float | None:
    anchors = [compact(item) for item in anchors if compact(item)]
    if not anchors:
        return None
    haystack = compact(actual)
    cursor = 0
    found = 0
    for anchor in anchors:
        position = haystack.find(anchor, cursor)
        if position >= 0:
            found += 1
            cursor = position + len(anchor)
    return found / len(anchors)


def edit_similarity(reference: str, actual: str) -> float | None:
    left, right = compact(reference), compact(actual)
    if not left:
        return None
    return difflib.SequenceMatcher(None, left, right, autojunk=False).ratio()


def page_text(result: dict[str, Any], pages: list[int]) -> str:
    if not pages:
        return result.get("text") or ""
    selected = [item.get("content") or "" for item in result.get("elements") or []
                if int(item.get("page") or 0) in pages]
    return "\n\n".join(selected) if selected else result.get("text") or ""


def match_text(expected: str, actual: str, threshold: float = 0.85) -> bool:
    left, right = compact(expected), compact(actual)
    return bool(left and right and difflib.SequenceMatcher(None, left, right, autojunk=False).ratio() >= threshold)


def heading_metrics(expected: list[dict[str, Any]], result: dict[str, Any]) -> dict[str, float] | None:
    if not expected:
        return None
    actual = [item for item in result.get("elements") or [] if str(item.get("type", "")).lower() == "heading"]
    used: set[int] = set()
    matches = 0
    level_matches = 0
    for target in expected:
        target_page = positive_int(target.get("page"))
        for index, candidate in enumerate(actual):
            candidate_page = positive_int(candidate.get("page"))
            if index in used or target_page is None or candidate_page != target_page \
                    or not match_text(str(target.get("text", "")), str(candidate.get("content", ""))):
                continue
            used.add(index)
            matches += 1
            if int(target.get("level") or 0) == int(candidate.get("headingLevel") or 0):
                level_matches += 1
            break
    precision = matches / len(actual) if actual else 0.0
    recall = matches / len(expected)
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": precision, "recall": recall, "f1": f1,
            "levelAccuracy": level_matches / matches if matches else 0.0}


def parse_markdown_table(content: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in normalize(content).splitlines():
        if "|" not in line:
            continue
        cells = [cell.strip().replace("\\|", "|") for cell in line.strip().strip("|").split("|")]
        if cells and all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells):
            continue
        rows.append(cells)
    return rows


def flatten_table(table: list[list[Any]]) -> list[str]:
    return [compact(str(cell)) for row in table for cell in row if compact(str(cell))]


def table_metrics(expected: list[dict[str, Any]], result: dict[str, Any]) -> dict[str, float] | None:
    if not expected:
        return None
    actual_elements = [item for item in result.get("elements") or [] if str(item.get("type", "")).lower() == "table"]
    cell_scores: list[float] = []
    shape_scores: list[float] = []
    for target in expected:
        expected_rows = target.get("rows") or []
        expected_cells = flatten_table(expected_rows)
        best_cell = 0.0
        best_shape = 0.0
        for candidate in actual_elements:
            if target.get("page") and int(target["page"]) != int(candidate.get("page") or 0):
                continue
            actual_rows = parse_markdown_table(str(candidate.get("content") or ""))
            actual_cells = flatten_table(actual_rows)
            expected_counter, actual_counter = collections.Counter(expected_cells), collections.Counter(actual_cells)
            matched = sum((expected_counter & actual_counter).values())
            precision = matched / len(actual_cells) if actual_cells else 0.0
            recall = matched / len(expected_cells) if expected_cells else 0.0
            score = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
            expected_shape = (len(expected_rows), max((len(row) for row in expected_rows), default=0))
            actual_shape = (len(actual_rows), max((len(row) for row in actual_rows), default=0))
            shape = 1.0 if expected_shape == actual_shape else 0.0
            if score > best_cell:
                best_cell, best_shape = score, shape
        cell_scores.append(best_cell)
        shape_scores.append(best_shape)
    return {"cellF1": statistics.mean(cell_scores), "shapeAccuracy": statistics.mean(shape_scores)}


def diagnostics(result: dict[str, Any]) -> dict[str, Any]:
    text = normalize(result.get("text") or "")
    lines = [line for line in text.splitlines() if len(line) >= 3]
    duplicate = len(lines) - len(set(lines))
    suspicious = len(re.findall(r"\ufffd|(?:Ã.|Â.|â€)", text))
    visible = len(compact(text))
    pages = max(1, int(result.get("pageCount") or 0))
    element_counts = collections.Counter(str(item.get("type") or "unknown") for item in result.get("elements") or [])
    pages_with_content = {int(item.get("page") or 0) for item in result.get("elements") or []
                          if compact(str(item.get("content") or ""))}
    return {
        "visibleCharsPerPage": visible / pages,
        "mojibakeRatio": suspicious / max(1, len(text)),
        "duplicateLineRatio": duplicate / len(lines) if lines else 0.0,
        "emptyPageRate": max(0, pages - len(pages_with_content)) / pages,
        "elementCounts": dict(element_counts),
    }


def evaluate_document(case: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    gold = case.get("gold") or {}
    pages = [int(item) for item in gold.get("representativePages") or []]
    actual = page_text(result, pages)
    reference = str(gold.get("referenceText") or "")
    metrics: dict[str, Any] = {
        "success": not bool(result.get("error")),
        "needsOcr": bool(result.get("needsOcr")),
        "elapsedMs": int(result.get("elapsedMs") or 0),
        "peakRssBytes": int(result.get("peakRssBytes") or 0),
        "pageCount": int(result.get("pageCount") or 0),
        "truncated": bool(result.get("truncated")),
        "diagnostics": diagnostics(result),
    }
    if case.get("category") != "SCAN" and reference and not result.get("error"):
        metrics["text"] = multiset_prf(reference, actual)
        metrics["readingOrder"] = {
            "anchorAccuracy": ordered_anchor_score(gold.get("orderedAnchors") or [], actual),
            "editSimilarity": edit_similarity(reference, actual),
        }
        metrics["headings"] = heading_metrics(gold.get("headings") or [], result)
        metrics["tables"] = table_metrics(gold.get("tables") or [], result)
    return metrics


def quality_score(metrics: dict[str, Any]) -> float | None:
    weighted: list[tuple[float, float]] = []
    if metrics.get("text"):
        weighted.append((0.35, float(metrics["text"]["f1"])))
    reading = metrics.get("readingOrder") or {}
    reading_values = [value for value in (reading.get("anchorAccuracy"), reading.get("editSimilarity")) if value is not None]
    if reading_values:
        weighted.append((0.25, statistics.mean(reading_values)))
    if metrics.get("headings"):
        weighted.append((0.20, statistics.mean([
            float(metrics["headings"]["f1"]), float(metrics["headings"]["levelAccuracy"]),
        ])))
    if metrics.get("tables"):
        weighted.append((0.20, statistics.mean([metrics["tables"]["cellF1"], metrics["tables"]["shapeAccuracy"]])))
    total = sum(weight for weight, _ in weighted)
    return sum(weight * value for weight, value in weighted) / total if total else None


@dataclass
class RunnerProcess:
    jar: Path
    java: str = "java"

    def __post_init__(self) -> None:
        self.process: subprocess.Popen[str] | None = None
        self.output_queue: queue.Queue[str] = queue.Queue()
        self.stderr_lines: collections.deque[str] = collections.deque(maxlen=30)
        self._monitoring = False
        self._peak_rss = 0

    def start(self) -> None:
        if self.process and self.process.poll() is None:
            return
        self.output_queue = queue.Queue()
        self.stderr_lines.clear()
        self.process = subprocess.Popen(
            [self.java, "-Xmx1024m", "-Dfile.encoding=UTF-8", "-Dsun.stdout.encoding=UTF-8",
             "-Dsun.stderr.encoding=UTF-8", "-jar", str(self.jar.resolve())],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        process = self.process
        threading.Thread(target=self._read_stdout, args=(process,), daemon=True).start()
        threading.Thread(target=self._read_stderr, args=(process,), daemon=True).start()
        threading.Thread(target=self._monitor_memory, args=(process,), daemon=True).start()

    def run(self, request: dict[str, Any], timeout: int) -> dict[str, Any]:
        self.start()
        assert self.process and self.process.stdin
        self._peak_rss = 0
        self._monitoring = True
        self.process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        try:
            line = self.output_queue.get(timeout=timeout)
        except queue.Empty as error:
            self.close()
            raise TimeoutError(f"runner timeout after {timeout}s") from error
        finally:
            self._monitoring = False
        result = json.loads(line)
        result["peakRssBytes"] = self._peak_rss
        return result

    def close(self) -> None:
        process = self.process
        self.process = None
        self._monitoring = False
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if process:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream:
                    stream.close()

    def _read_stdout(self, process: subprocess.Popen[str]) -> None:
        assert process.stdout
        for line in process.stdout:
            if line.strip(): self.output_queue.put(line)

    def _read_stderr(self, process: subprocess.Popen[str]) -> None:
        assert process.stderr
        for line in process.stderr:
            if line.strip(): self.stderr_lines.append(line.strip())

    def _monitor_memory(self, process: subprocess.Popen[str]) -> None:
        pid = process.pid
        while process.poll() is None:
            if self._monitoring:
                self._peak_rss = max(self._peak_rss, process_rss_bytes(pid))
            time.sleep(0.03)


def process_rss_bytes(pid: int) -> int:
    try:
        if os.name == "nt":
            class Counters(ctypes.Structure):
                _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                            ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                            ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
                            ("PrivateUsage", ctypes.c_size_t)]
            handle = ctypes.windll.kernel32.OpenProcess(0x1000 | 0x0010, False, pid)
            if not handle: return 0
            counters = Counters()
            counters.cb = ctypes.sizeof(counters)
            ok = ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
            ctypes.windll.kernel32.CloseHandle(handle)
            return int(counters.WorkingSetSize) if ok else 0
        status = Path(f"/proc/{pid}/status")
        if status.exists():
            match = re.search(r"^VmRSS:\s+(\d+)\s+kB", status.read_text(), re.MULTILINE)
            return int(match.group(1)) * 1024 if match else 0
    except Exception:
        return 0
    return 0


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_jsonl(paths: list[Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        if not path.exists():
            continue
        rows.extend(json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip())
    return rows


def annotation_coverage(cases: list[dict[str, Any]]) -> dict[str, Any]:
    by_category: dict[str, dict[str, int]] = {}
    for category in CATEGORIES:
        rows = [case for case in cases if case.get("category") == category]
        by_category[category] = {
            "total": len(rows),
            "public": sum(case.get("visibility") == "PUBLIC" for case in rows),
            "private": sum(case.get("visibility") == "PRIVATE" for case in rows),
            "representativePages": sum(len(valid_positive_pages((case.get("gold") or {}).get("representativePages"))) >= 3
                                       for case in rows),
            "referenceText": sum(bool(str((case.get("gold") or {}).get("referenceText") or "").strip()) for case in rows),
            "readingOrder": sum(len(nonblank_strings((case.get("gold") or {}).get("orderedAnchors"))) >= 2 for case in rows),
            "headings": sum(valid_headings((case.get("gold") or {}).get("headings")) for case in rows),
            "tables": sum(valid_tables((case.get("gold") or {}).get("tables")) for case in rows),
            "scan": sum((case.get("gold") or {}).get("scan") is True for case in rows),
        }
    return {
        "byCategory": by_category,
        "metrics": {
            "text": sum(row["referenceText"] for category, row in by_category.items() if category in DIGITAL_CATEGORIES),
            "representativePages": sum(row["representativePages"] for category, row in by_category.items()
                                       if category in DIGITAL_CATEGORIES),
            "readingOrder": sum(row["readingOrder"] for category, row in by_category.items() if category in DIGITAL_CATEGORIES),
            "headings": sum(row["headings"] for category, row in by_category.items() if category in DIGITAL_CATEGORIES),
            "tables": by_category["TABLE"]["tables"],
            "scanDetection": by_category["SCAN"]["scan"],
        },
    }


def nonblank_strings(value: Any) -> list[str]:
    return [str(item).strip() for item in (value or []) if str(item).strip()]


def positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None


def valid_positive_pages(value: Any) -> set[int]:
    pages = value if isinstance(value, list) else []
    return {parsed for item in pages if (parsed := positive_int(item)) is not None}


def valid_headings(value: Any) -> bool:
    rows = value if isinstance(value, list) else []
    return bool(rows) and all(str(row.get("text") or "").strip()
                              and positive_int(row.get("page")) is not None
                              and positive_int(row.get("level")) is not None
                              for row in rows if isinstance(row, dict)) and all(isinstance(row, dict) for row in rows)


def valid_tables(value: Any) -> bool:
    tables = value if isinstance(value, list) else []
    if not tables or not all(isinstance(table, dict) for table in tables):
        return False
    for table in tables:
        rows = table.get("rows")
        if positive_int(table.get("page")) is None or not isinstance(rows, list) or not rows:
            return False
        if not any(str(cell).strip() for row in rows if isinstance(row, list) for cell in row):
            return False
    return True


def corpus_gate_reasons(cases: list[dict[str, Any]], coverage: dict[str, Any],
                        allow_incomplete: bool) -> list[str]:
    reasons: list[str] = []
    if allow_incomplete:
        reasons.append("benchmark was run with --allow-incomplete")
    counts = collections.Counter(str(case.get("category")) for case in cases)
    if len(cases) < 24 or any(counts[category] < 6 for category in CATEGORIES):
        reasons.append("full gate requires at least 24 PDFs and 6 in each category")
    hashes = [str(case.get("sha256") or "").lower() for case in cases]
    if len(set(hashes)) != len(hashes):
        reasons.append("PDF sha256 values must be globally unique")
    for category in CATEGORIES:
        row = coverage["byCategory"][category]
        if row["public"] < 3 or row["private"] < 3:
            reasons.append(f"{category} requires at least 3 PUBLIC and 3 PRIVATE PDFs")
    for case in cases:
        category = case["category"]
        gold = case.get("gold") or {}
        if category in DIGITAL_CATEGORIES:
            valid_pages = valid_positive_pages(gold.get("representativePages"))
            if len(valid_pages) < 3 or not str(gold.get("referenceText") or "").strip() \
                    or len(nonblank_strings(gold.get("orderedAnchors"))) < 2:
                reasons.append(f"{case['id']} needs 3 representative pages, referenceText and 2 ordered anchors")
        elif gold.get("scan") is not True:
            reasons.append(f"{case['id']} must declare gold.scan=true")
        if category == "TABLE" and not valid_tables(gold.get("tables")):
            reasons.append(f"{case['id']} needs non-empty table gold")
    for category in DIGITAL_CATEGORIES:
        if coverage["byCategory"][category]["headings"] < 3:
            reasons.append(f"{category} needs heading gold for at least 3 PDFs")
    for case in cases:
        if case.get("visibility") != "PUBLIC":
            continue
        license_id = str(case.get("license") or "").upper()
        review_status = str(case.get("licenseReviewStatus") or "").upper()
        if review_status != "APPROVED" or license_id not in APPROVED_LICENSES:
            reasons.append(f"{case['id']} public license requires review")
            continue
        required = ("sourceUrl", "licenseUrl", "attribution")
        if any(not str(case.get(field) or "").strip() for field in required):
            reasons.append(f"{case['id']} public provenance metadata is incomplete")
        source_commit = str(case.get("sourceCommit") or "")
        if not re.fullmatch(r"[0-9a-fA-F]{40}", source_commit):
            reasons.append(f"{case['id']} sourceCommit is not pinned")
    return list(dict.fromkeys(reasons))


def validate_corpus(cases: list[dict[str, Any]], allow_incomplete: bool) -> tuple[dict[str, Any], list[str]]:
    if not cases:
        raise ValueError("corpus manifest is empty")
    ids = [str(case.get("id") or "") for case in cases]
    if not all(ids) or len(set(ids)) != len(ids):
        raise ValueError("every corpus row needs a unique id")
    invalid_ids = [case_id for case_id in ids if not SAFE_CASE_ID.fullmatch(case_id)]
    if invalid_ids:
        raise ValueError("unsafe corpus id: " + ", ".join(invalid_ids))
    counts = collections.Counter(str(case.get("category")) for case in cases)
    if any(category not in CATEGORIES for category in counts):
        raise ValueError("category must be one of " + ", ".join(CATEGORIES))
    for case in cases:
        if case.get("visibility") not in VISIBILITIES:
            raise ValueError(f"visibility must be PUBLIC or PRIVATE for {case['id']}")
        path = Path(case["path"]).expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"missing corpus file for {case['id']}: {path}")
        expected_hash = str(case.get("sha256") or "")
        if not expected_hash or expected_hash == "PIN_BEFORE_USE":
            raise ValueError(f"sha256 must be pinned for {case['id']}")
        if sha256_file(path) != expected_hash.lower():
            raise ValueError(f"sha256 mismatch for {case['id']}")
    coverage = annotation_coverage(cases)
    return coverage, corpus_gate_reasons(cases, coverage, allow_incomplete)


def sanitized_result(result: dict[str, Any]) -> dict[str, Any]:
    error = str(result.get("error") or "")
    lowered = error.lower()
    if not error:
        error_code = None
    elif "timeout" in lowered:
        error_code = "TIMEOUT"
    elif "password" in lowered or "encrypt" in lowered:
        error_code = "ENCRYPTED_PDF"
    elif "maxfilebytes" in lowered or "too large" in lowered:
        error_code = "FILE_TOO_LARGE"
    elif "page" in lowered and ("limit" in lowered or "maximum" in lowered):
        error_code = "PAGE_LIMIT_EXCEEDED"
    else:
        error_code = "PARSER_ERROR"
    return {
        "engine": result.get("engine"),
        "version": result.get("version"),
        "fileHash": result.get("fileHash"),
        "pageCount": result.get("pageCount"),
        "elapsedMs": result.get("elapsedMs"),
        "peakRssBytes": result.get("peakRssBytes"),
        "errorCode": error_code,
        "warningCount": len(result.get("warnings") or []),
        "truncated": bool(result.get("truncated")),
        "needsOcr": bool(result.get("needsOcr")),
    }


def aggregate(records: list[dict[str, Any]]) -> dict[str, Any]:
    summary: dict[str, Any] = {"engines": {}, "categories": {}}
    for engine in ENGINES:
        rows = [row for row in records if row["engine"] == engine]
        digital = [row for row in rows if row["category"] in DIGITAL_CATEGORIES]
        summary["engines"][engine] = {
            "digitalSuccessRate": sum(1 for row in digital if row["metrics"]["success"]) / max(1, len(digital)),
            "qualityScore": safe_mean([row["qualityScore"] for row in digital if row["qualityScore"] is not None]),
            "elapsedPerPageP50Ms": percentile([row["metrics"]["elapsedMs"] / max(1, row["metrics"]["pageCount"])
                                                for row in rows if row["metrics"]["success"]], 0.50),
            "elapsedPerPageP95Ms": percentile([row["metrics"]["elapsedMs"] / max(1, row["metrics"]["pageCount"])
                                                for row in rows if row["metrics"]["success"]], 0.95),
            "peakRssBytes": max((row["metrics"]["peakRssBytes"] for row in rows), default=0),
            "deterministic": all(row["deterministic"] for row in rows),
            "scanDetectionRate": safe_mean([1.0 if row["metrics"]["needsOcr"] else 0.0
                                             for row in rows if row["category"] == "SCAN"]),
            "metricCoverage": metric_coverage(digital),
        }
    for category in CATEGORIES:
        summary["categories"][category] = {}
        for engine in ENGINES:
            rows = [row for row in records if row["engine"] == engine and row["category"] == category]
            summary["categories"][category][engine] = {
                "successRate": sum(1 for row in rows if row["metrics"]["success"]) / max(1, len(rows)),
                "elapsedPerPageP95Ms": percentile([row["metrics"]["elapsedMs"] / max(1, row["metrics"]["pageCount"])
                                                    for row in rows if row["metrics"]["success"]], 0.95),
                "peakRssBytes": max((row["metrics"]["peakRssBytes"] for row in rows), default=0),
                "deterministic": bool(rows) and all(row["deterministic"] for row in rows),
                "qualityScore": safe_mean([row["qualityScore"] for row in rows if row["qualityScore"] is not None]),
                "textF1": safe_mean([row["metrics"]["text"]["f1"] for row in rows if row["metrics"].get("text")]),
                "readingOrder": safe_mean([row["metrics"]["readingOrder"]["anchorAccuracy"] for row in rows
                                            if row["metrics"].get("readingOrder")
                                            and row["metrics"]["readingOrder"].get("anchorAccuracy") is not None]),
                "headingF1": safe_mean([row["metrics"]["headings"]["f1"] for row in rows
                                        if row["metrics"].get("headings")]),
                "headingLevelAccuracy": safe_mean([
                    row["metrics"]["headings"]["levelAccuracy"] for row in rows
                    if row["metrics"].get("headings")
                ]),
                "tableScore": safe_mean([statistics.mean([row["metrics"]["tables"]["cellF1"],
                                                           row["metrics"]["tables"]["shapeAccuracy"]]) for row in rows
                                         if row["metrics"].get("tables")]),
                "metricCoverage": metric_coverage(rows),
            }
    return summary


def metric_coverage(rows: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "documents": len(rows),
        "quality": sum(row.get("qualityScore") is not None for row in rows),
        "text": sum(bool(row["metrics"].get("text")) for row in rows),
        "readingOrder": sum(bool(row["metrics"].get("readingOrder")) for row in rows),
        "headings": sum(bool(row["metrics"].get("headings")) for row in rows),
        "tables": sum(bool(row["metrics"].get("tables")) for row in rows),
    }


def no_regression(candidate: Any, baseline: Any, tolerance: float = 0.02) -> bool:
    return candidate is not None and baseline is not None and float(candidate) >= float(baseline) - tolerance


def decision(summary: dict[str, Any], cases: list[dict[str, Any]], allow_incomplete: bool,
             gate_reasons: list[str] | None = None) -> tuple[str, list[str]]:
    reasons: list[str] = []
    if gate_reasons:
        return "NEEDS_MORE_DATA", gate_reasons
    if allow_incomplete or len(cases) < 24:
        return "NEEDS_MORE_DATA", ["corpus does not satisfy the full gate"]
    pdfbox = summary["engines"]["PDFBOX"]
    odl = summary["engines"]["OPENDATALOADER"]
    runtime_checks = {
        "digital success rate >= 95%": odl["digitalSuccessRate"] >= 0.95,
        "P95 <= 2 seconds/page": value(odl["elapsedPerPageP95Ms"], 1e12) <= 2000,
        "peak RSS <= 1 GiB": value(odl["peakRssBytes"], 1e12) <= 1024 ** 3,
        "deterministic outputs": bool(odl["deterministic"]),
        "all scans marked as OCR-required": value(odl["scanDetectionRate"]) == 1.0,
    }
    checks = dict(runtime_checks)
    checks["overall quality improves by >= 0.08"] = (
        odl["qualityScore"] is not None and pdfbox["qualityScore"] is not None
        and float(odl["qualityScore"]) - float(pdfbox["qualityScore"]) >= 0.08)
    for category in DIGITAL_CATEGORIES:
        base = summary["categories"][category]["PDFBOX"]["textF1"]
        candidate = summary["categories"][category]["OPENDATALOADER"]["textF1"]
        checks[f"{category} text regression <= 0.02"] = candidate is not None and base is not None and candidate >= base - 0.02
    two_base = summary["categories"]["TWO_COLUMN"]["PDFBOX"]["readingOrder"]
    two_odl = summary["categories"]["TWO_COLUMN"]["OPENDATALOADER"]["readingOrder"]
    checks["two-column order >= 0.90 or improves >= 0.10"] = two_odl is not None and (
        two_odl >= 0.90 or (two_base is not None and two_odl - two_base >= 0.10))
    heading_base = safe_mean([summary["categories"][category]["PDFBOX"]["headingF1"]
                              for category in DIGITAL_CATEGORIES
                              if summary["categories"][category]["PDFBOX"]["headingF1"] is not None])
    heading_odl = safe_mean([summary["categories"][category]["OPENDATALOADER"]["headingF1"]
                             for category in DIGITAL_CATEGORIES
                             if summary["categories"][category]["OPENDATALOADER"]["headingF1"] is not None])
    checks["heading F1 >= 0.75 or improves >= 0.10"] = heading_odl is not None and (
        heading_odl >= 0.75 or (heading_base is not None and heading_odl - heading_base >= 0.10))
    heading_level_base = safe_mean([
        summary["categories"][category]["PDFBOX"]["headingLevelAccuracy"]
        for category in DIGITAL_CATEGORIES
        if summary["categories"][category]["PDFBOX"]["headingLevelAccuracy"] is not None
    ])
    heading_level_odl = safe_mean([
        summary["categories"][category]["OPENDATALOADER"]["headingLevelAccuracy"]
        for category in DIGITAL_CATEGORIES
        if summary["categories"][category]["OPENDATALOADER"]["headingLevelAccuracy"] is not None
    ])
    checks["heading level accuracy >= 0.75 or improves >= 0.10"] = heading_level_odl is not None and (
        heading_level_odl >= 0.75
        or (heading_level_base is not None and heading_level_odl - heading_level_base >= 0.10))
    table_base = summary["categories"]["TABLE"]["PDFBOX"]["tableScore"]
    table_odl = summary["categories"]["TABLE"]["OPENDATALOADER"]["tableScore"]
    checks["table structure improves >= 0.10"] = table_odl is not None and table_base is not None and table_odl - table_base >= 0.10
    reasons.extend(("PASS " if passed else "FAIL ") + label for label, passed in checks.items())
    if all(checks.values()):
        return "OPENDATALOADER_CANDIDATE", reasons
    category_wins: list[str] = []
    for category in DIGITAL_CATEGORIES:
        base = summary["categories"][category]["PDFBOX"]
        candidate = summary["categories"][category]["OPENDATALOADER"]
        category_checks = {
            "global runtime safety": all(runtime_checks.values()),
            "category success rate >= 95%": candidate["successRate"] >= 0.95,
            "category P95 <= 2 seconds/page": value(candidate["elapsedPerPageP95Ms"], 1e12) <= 2000,
            "category peak RSS <= 1 GiB": value(candidate["peakRssBytes"], 1e12) <= 1024 ** 3,
            "category deterministic": bool(candidate["deterministic"]),
            "category quality improves by >= 0.08": candidate["qualityScore"] is not None
                and base["qualityScore"] is not None
                and float(candidate["qualityScore"]) - float(base["qualityScore"]) >= 0.08,
            "text regression <= 0.02": no_regression(candidate["textF1"], base["textF1"]),
            "heading regression <= 0.02": no_regression(candidate["headingF1"], base["headingF1"]),
            "heading level regression <= 0.02": no_regression(
                candidate["headingLevelAccuracy"], base["headingLevelAccuracy"]),
        }
        if category == "TWO_COLUMN":
            category_checks["reading order qualifies"] = candidate["readingOrder"] is not None and (
                float(candidate["readingOrder"]) >= 0.90
                or (base["readingOrder"] is not None
                    and float(candidate["readingOrder"]) - float(base["readingOrder"]) >= 0.10))
        if category == "TABLE":
            category_checks["table structure improves by >= 0.10"] = candidate["tableScore"] is not None \
                and base["tableScore"] is not None \
                and float(candidate["tableScore"]) - float(base["tableScore"]) >= 0.10
        passed = all(category_checks.values())
        reasons.append(("CATEGORY PASS " if passed else "CATEGORY FAIL ") + category + ": "
                       + ", ".join(label for label, result in category_checks.items() if not result))
        if passed:
            category_wins.append(category)
    return ("CATEGORY_ROUTING_CANDIDATE" if category_wins else "KEEP_PDFBOX"), reasons


def value(number: Any, default: float = 0.0) -> float:
    return default if number is None else float(number)


def markdown_summary(report: dict[str, Any]) -> str:
    lines = ["# PDF Parser A/B Summary", "", f"Decision: `{report['decision']}`", "",
             "## Environment", "", f"- OS: {report['environment']['os']}",
             f"- Java: {report['environment']['java']}", f"- Documents: {report['corpusSize']}", "",
             "## Engine Summary", "", "| Engine | Success | Quality | P95 ms/page | Peak RSS MiB | Deterministic |",
             "| --- | ---: | ---: | ---: | ---: | --- |"]
    for engine, row in report["summary"]["engines"].items():
        lines.append(f"| {engine} | {row['digitalSuccessRate']:.3f} | {fmt(row['qualityScore'])} | "
                     f"{fmt(row['elapsedPerPageP95Ms'])} | {row['peakRssBytes'] / 1024 / 1024:.1f} | {row['deterministic']} |")
    lines.extend(["", "## Gate", ""] + [f"- {reason}" for reason in report["decisionReasons"]])
    coverage = report.get("annotationCoverage") or {}
    if coverage:
        lines.extend(["", "## Annotation Coverage", "",
                      "| Metric | Documents |", "| --- | ---: |"])
        for metric, count in (coverage.get("metrics") or {}).items():
            lines.append(f"| {metric} | {count} |")
    lines.extend(["", "## Privacy", "", "This report contains metrics and hashes only. Raw parser output and private annotations remain in ignored local directories.", ""])
    return "\n".join(lines)


def fmt(number: Any) -> str:
    return "n/a" if number is None else f"{float(number):.3f}"


def run_benchmark(args: argparse.Namespace) -> dict[str, Any]:
    cases = load_jsonl(args.manifest)
    coverage, gate_reasons = validate_corpus(cases, args.allow_incomplete)
    output = private_output_dir(args.output)
    raw_dir = output / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    runners = {
        "PDFBOX": RunnerProcess(args.pdfbox_jar, args.java),
        "OPENDATALOADER": RunnerProcess(args.odl_jar, args.java),
    }
    records: list[dict[str, Any]] = []
    try:
        warmup = next((case for case in cases if case["category"] != "SCAN"), cases[0])
        for engine, runner in runners.items():
            runner.run(request_for(warmup, f"warmup-{engine}"), args.timeout)
        for case in cases:
            source = Path(case["path"]).expanduser().resolve()
            for engine, runner in runners.items():
                attempts: list[dict[str, Any]] = []
                for repeat in range(3):
                    request = request_for(case, f"{case['id']}-{engine}-{repeat}")
                    try:
                        result = runner.run(request, args.timeout)
                    except Exception as error:
                        result = {"requestId": request["requestId"], "engine": engine, "version": None,
                                  "fileHash": sha256_file(source), "pageCount": 0, "text": "", "markdown": "",
                                  "elements": [], "elapsedMs": args.timeout * 1000, "peakRssBytes": 0,
                                  "warnings": list(runner.stderr_lines), "error": str(error),
                                  "truncated": False, "needsOcr": False}
                        runner.start()
                    attempts.append(result)
                raw_path = safe_raw_path(raw_dir, str(case["id"]))
                raw_path.mkdir(parents=True, exist_ok=True)
                (raw_path / f"{engine.lower()}-attempts.json").write_text(
                    json.dumps(attempts, ensure_ascii=False, indent=2), encoding="utf-8")
                hashes = [structured_output_hash(attempt)
                          for attempt in attempts if not attempt.get("error")]
                representative = attempts[0]
                representative["elapsedMs"] = int(statistics.median([attempt["elapsedMs"] for attempt in attempts]))
                representative["peakRssBytes"] = max(attempt.get("peakRssBytes", 0) for attempt in attempts)
                metrics = evaluate_document(case, representative)
                records.append({
                    "caseId": case["id"], "category": case["category"], "visibility": case.get("visibility"),
                    "fileHash": representative.get("fileHash"), "engine": engine,
                    "deterministic": len(hashes) == 3 and len(set(hashes)) == 1,
                    "outputHashes": hashes, "qualityScore": quality_score(metrics), "metrics": metrics,
                    "result": sanitized_result(representative),
                })
    finally:
        for runner in runners.values(): runner.close()
    summary = aggregate(records)
    selected, reasons = decision(summary, cases, args.allow_incomplete, gate_reasons)
    return {
        "schemaVersion": 1,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "environment": {"os": platform.platform(), "python": platform.python_version(),
                        "java": java_version(args.java)},
        "corpusSize": len(cases), "annotationCoverage": coverage,
        "decision": selected, "decisionReasons": reasons,
        "summary": summary, "documents": records,
    }


def safe_raw_path(raw_dir: Path, case_id: str) -> Path:
    if not SAFE_CASE_ID.fullmatch(case_id):
        raise ValueError(f"unsafe corpus id: {case_id}")
    root = raw_dir.resolve()
    target = (root / case_id).resolve()
    if not target.is_relative_to(root):
        raise ValueError(f"raw output escaped its private directory: {case_id}")
    return target


def structured_output_hash(result: dict[str, Any]) -> str:
    projection = {
        "engine": str(result.get("engine") or ""),
        "version": str(result.get("version") or ""),
        "fileHash": str(result.get("fileHash") or ""),
        "pageCount": int(result.get("pageCount") or 0),
        "needsOcr": bool(result.get("needsOcr")),
        "truncated": bool(result.get("truncated")),
        "text": normalize(str(result.get("text") or "")),
        "markdown": normalize(str(result.get("markdown") or "")),
        "elements": canonical_structure(result.get("elements") or []),
    }
    encoded = json.dumps(projection, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def canonical_structure(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): canonical_structure(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        return [canonical_structure(item) for item in value]
    if isinstance(value, str):
        return normalize(value)
    if isinstance(value, float):
        return round(value, 6)
    return value


def private_output_dir(requested: Path) -> Path:
    private_root = (Path(__file__).resolve().parents[1] / "output").resolve()
    target = requested.expanduser().resolve()
    if not target.is_relative_to(private_root):
        raise ValueError(f"output must stay inside ignored directory: {private_root}")
    return target


def request_for(case: dict[str, Any], request_id: str) -> dict[str, Any]:
    return {"requestId": request_id, "input": str(Path(case["path"]).expanduser().resolve()),
            "maxPages": MAX_PAGES, "maxOutputChars": MAX_OUTPUT_CHARS, "maxFileBytes": MAX_FILE_BYTES}


def java_version(java: str) -> str:
    completed = subprocess.run([java, "-version"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return (completed.stderr or completed.stdout).splitlines()[0] if (completed.stderr or completed.stdout) else "unknown"


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="OpenDataLoader/PDFBox structured PDF A/B benchmark")
    parser.add_argument("--manifest", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, default=root / "output")
    parser.add_argument("--pdfbox-jar", type=Path, default=root / "pdfbox-runner/target/pdfbox-runner-all.jar")
    parser.add_argument("--odl-jar", type=Path, default=root / "opendataloader-runner/target/opendataloader-runner-all.jar")
    parser.add_argument("--java", default="java")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--allow-incomplete", action="store_true")
    args = parser.parse_args()
    try:
        args.output = private_output_dir(args.output)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    for jar in (args.pdfbox_jar, args.odl_jar):
        if not jar.is_file(): raise SystemExit(f"runner JAR not found: {jar}")
    report = run_benchmark(args)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "pdf-parser-ab-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (args.output / "pdf-parser-ab-summary.md").write_text(markdown_summary(report), encoding="utf-8")
    print(json.dumps({"decision": report["decision"], "report": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
