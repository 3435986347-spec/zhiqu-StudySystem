import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from benchmark import (annotation_coverage, corpus_gate_reasons, decision,
                       edit_similarity, heading_metrics, multiset_prf,
                       ordered_anchor_score, parse_markdown_table, private_output_dir,
                       quality_score, safe_raw_path, sanitized_result,
                       structured_output_hash, table_metrics)


class MetricsTest(unittest.TestCase):
    def test_text_and_order_metrics(self):
        score = multiset_prf("数据结构 操作系统", "数据结构 操作系统")
        self.assertEqual(1.0, score["f1"])
        self.assertEqual(1.0, ordered_anchor_score(["数据结构", "操作系统"], "数据结构，然后学习操作系统"))
        self.assertLess(ordered_anchor_score(["数据结构", "操作系统"], "操作系统、数据结构"), 1.0)
        self.assertEqual(1.0, edit_similarity("第一章", "第一章"))

    def test_heading_and_table_metrics(self):
        result = {"elements": [
            {"type": "heading", "page": 1, "headingLevel": 2, "content": "复习计划"},
            {"type": "table", "page": 1, "content": "| 科目 | 时间 |\n| --- | --- |\n| 数学 | 2h |"},
        ]}
        heading = heading_metrics([{"text": "复习计划", "page": 1, "level": 2}], result)
        self.assertEqual(1.0, heading["f1"])
        self.assertEqual(1.0, heading["levelAccuracy"])
        table = table_metrics([{"page": 1, "rows": [["科目", "时间"], ["数学", "2h"]]}], result)
        self.assertEqual(1.0, table["cellF1"])
        self.assertEqual(1.0, table["shapeAccuracy"])
        self.assertEqual(2, len(parse_markdown_table(result["elements"][1]["content"])))

    def test_heading_page_and_level_affect_quality(self):
        expected = [{"text": "复习计划", "page": 1, "level": 1}]
        wrong_page = {"elements": [
            {"type": "heading", "page": 99, "headingLevel": 1, "content": "复习计划"},
        ]}
        wrong_level = {"elements": [
            {"type": "heading", "page": 1, "headingLevel": 9, "content": "复习计划"},
        ]}

        page_metrics = heading_metrics(expected, wrong_page)
        level_metrics = heading_metrics(expected, wrong_level)
        self.assertEqual(0.0, page_metrics["f1"])
        self.assertEqual(1.0, level_metrics["f1"])
        self.assertEqual(0.0, level_metrics["levelAccuracy"])
        self.assertEqual(0.5, quality_score({"headings": level_metrics}))

    def test_incomplete_corpus_cannot_promote_parser(self):
        summary = {
            "engines": {
                "PDFBOX": {"qualityScore": 0.5, "digitalSuccessRate": 1.0, "elapsedPerPageP95Ms": 10,
                           "peakRssBytes": 1, "deterministic": True, "scanDetectionRate": 1.0},
                "OPENDATALOADER": {"qualityScore": 1.0, "digitalSuccessRate": 1.0, "elapsedPerPageP95Ms": 10,
                                   "peakRssBytes": 1, "deterministic": True, "scanDetectionRate": 1.0},
            },
            "categories": {},
        }
        selected, _ = decision(summary, [{"id": "one"}], True)
        self.assertEqual("NEEDS_MORE_DATA", selected)

    def test_full_gate_requires_unique_mixed_annotated_corpus(self):
        cases = self.full_cases()
        coverage = annotation_coverage(cases)
        self.assertEqual([], corpus_gate_reasons(cases, coverage, False))

        cases[1]["sha256"] = cases[0]["sha256"]
        cases[2]["gold"]["referenceText"] = ""
        reasons = corpus_gate_reasons(cases, annotation_coverage(cases), False)

        self.assertTrue(any("globally unique" in reason for reason in reasons))
        self.assertTrue(any(cases[2]["id"] in reason and "referenceText" in reason for reason in reasons))
        selected, _ = decision(self.decision_summary(), cases, False, reasons)
        self.assertEqual("NEEDS_MORE_DATA", selected)

    def test_category_routing_requires_global_runtime_safety(self):
        summary = self.decision_summary()
        summary["engines"]["OPENDATALOADER"]["deterministic"] = False
        selected, reasons = decision(summary, self.full_cases(), False, [])
        self.assertEqual("KEEP_PDFBOX", selected)
        self.assertTrue(any("CATEGORY FAIL LECTURE" in reason for reason in reasons))

    def test_heading_level_regression_blocks_candidate(self):
        summary = self.decision_summary()
        for category in ("LECTURE", "TWO_COLUMN", "TABLE"):
            summary["categories"][category]["OPENDATALOADER"]["headingLevelAccuracy"] = 0.1
        selected, reasons = decision(summary, self.full_cases(), False, [])
        self.assertEqual("KEEP_PDFBOX", selected)
        self.assertTrue(any("heading level accuracy" in reason and "FAIL" in reason for reason in reasons))
        self.assertTrue(any("heading level regression" in reason for reason in reasons))

    def test_public_license_needs_approval_and_allowlist(self):
        cases = self.full_cases()
        public_case = next(case for case in cases if case["visibility"] == "PUBLIC")
        public_case["license"] = "ARXIV-NONEXCLUSIVE-1.0"
        reasons = corpus_gate_reasons(cases, annotation_coverage(cases), False)
        self.assertTrue(any(public_case["id"] in reason and "license" in reason for reason in reasons))

        public_case["license"] = "CC-BY-4.0"
        public_case["licenseReviewStatus"] = "REVIEW_REQUIRED"
        reasons = corpus_gate_reasons(cases, annotation_coverage(cases), False)
        self.assertTrue(any(public_case["id"] in reason and "license" in reason for reason in reasons))

    def test_structured_hash_includes_elements_and_coordinates(self):
        base = {"engine": "PDFBOX", "version": "3.0.1", "fileHash": "a" * 64,
                "pageCount": 1, "needsOcr": False, "truncated": False,
                "text": "same", "markdown": "same", "elements": [
            {"type": "heading", "page": 1, "headingLevel": 1,
             "boundingBox": [1.0, 2.0, 3.0, 4.0], "content": "Title"}
        ]}
        changed = {**base, "elements": [{**base["elements"][0], "headingLevel": 2}]}
        moved = {**base, "elements": [{**base["elements"][0], "boundingBox": [9.0, 2.0, 3.0, 4.0]}]}
        self.assertNotEqual(structured_output_hash(base), structured_output_hash(changed))
        self.assertNotEqual(structured_output_hash(base), structured_output_hash(moved))
        for field, changed_value in (("pageCount", 2), ("needsOcr", True), ("truncated", True)):
            with self.subTest(field=field):
                self.assertNotEqual(structured_output_hash(base),
                                    structured_output_hash({**base, field: changed_value}))

    def test_raw_output_path_and_report_diagnostics_are_private(self):
        with self.assertRaises(ValueError):
            safe_raw_path(Path("output/raw"), "../../private-result")
        private_path = r"C:\private\student-name\secret.pdf"
        result = sanitized_result({
            "requestId": "secret-case-PDFBOX-0", "engine": "PDFBOX", "version": "3.0.1",
            "error": f"cannot parse {private_path}", "warnings": [f"failed at {private_path}"],
            "pageCount": 0, "elapsedMs": 1, "peakRssBytes": 2,
        })
        serialized = str(result)
        self.assertNotIn("student-name", serialized)
        self.assertNotIn("secret-case", serialized)
        self.assertNotIn("requestId", result)
        self.assertEqual("PARSER_ERROR", result["errorCode"])
        self.assertEqual(1, result["warningCount"])
        project_root = Path(__file__).resolve().parents[2]
        self.assertEqual((project_root / "output" / "allowed").resolve(),
                         private_output_dir(project_root / "output" / "allowed"))
        with self.assertRaises(ValueError):
            private_output_dir(project_root / "review-results")

    def full_cases(self):
        cases = []
        index = 1
        for category in ("LECTURE", "TWO_COLUMN", "TABLE", "SCAN"):
            for offset in range(6):
                public = offset >= 3
                if category == "SCAN":
                    gold = {"scan": True}
                else:
                    gold = {
                        "representativePages": [1, 2, 3],
                        "referenceText": f"reference {category} {offset}",
                        "orderedAnchors": ["first", "second"],
                        "headings": [{"page": 1, "text": "Heading", "level": 1}],
                        "tables": ([{"page": 1, "rows": [["A", "B"], ["1", "2"]]}]
                                   if category == "TABLE" else []),
                    }
                case = {
                    "id": f"case-{index:02d}", "category": category,
                    "visibility": "PUBLIC" if public else "PRIVATE",
                    "sha256": f"{index:064x}", "gold": gold,
                }
                if public:
                    case.update({
                        "sourceUrl": f"https://example.test/{index}.pdf",
                        "license": "CC-BY-4.0",
                        "licenseReviewStatus": "APPROVED",
                        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
                        "attribution": f"Public fixture {index}",
                        "sourceCommit": f"{index:040x}",
                    })
                cases.append(case)
                index += 1
        return cases

    def decision_summary(self):
        engine = lambda quality, deterministic=True: {
            "qualityScore": quality, "digitalSuccessRate": 1.0,
            "elapsedPerPageP95Ms": 10, "peakRssBytes": 1,
            "deterministic": deterministic, "scanDetectionRate": 1.0,
        }
        category = lambda quality: {
            "successRate": 1.0, "elapsedPerPageP95Ms": 10, "peakRssBytes": 1,
            "deterministic": True, "qualityScore": quality, "textF1": 0.9,
            "readingOrder": 0.95, "headingF1": 0.9,
            "headingLevelAccuracy": 0.9, "tableScore": 0.9,
        }
        return {
            "engines": {"PDFBOX": engine(0.5), "OPENDATALOADER": engine(0.7)},
            "categories": {
                name: {"PDFBOX": category(0.5), "OPENDATALOADER": category(0.7)}
                for name in ("LECTURE", "TWO_COLUMN", "TABLE", "SCAN")
            },
        }


if __name__ == "__main__":
    unittest.main()
