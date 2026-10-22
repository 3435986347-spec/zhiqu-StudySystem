#!/usr/bin/env python3
"""Per-task view of a gold / baseline control run (round 69).

`prepare-repository-eval.py validate-reports` is the gate: for gold and baseline it stops at the first task that
fails, which is right for a gate but hides the other nine. This prints every task with the same rules
(same expected tests, same parse of the actual test log) and, for each unmet task, which tests went wrong
and whether the log shows the known local-network symptom (HTTP 502 from the Docker Desktop proxy hop).

    python3 tools/benchmarks/summarize-controls.py --control-dir DIR --reports-dir DIR --kind gold|baseline --python HARNESS_PYTHON
"""

import argparse
import importlib.util
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("preparer", HERE / "prepare-repository-eval.py")
preparer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preparer)

NETWORK_SYMPTOM = re.compile(r"<Response \[50[234]\]>|50[234] == |== 50[234]\b|Bad Gateway|ConnectionError|Max retries exceeded")


def summarize(control, reports_dir, kind, python):
    dataset = {row["instance_id"]: row for row in preparer.load(Path(control) / "private/dataset.json")}
    reports = {}
    for path in Path(reports_dir).rglob("report.json"):
        for instance_id, report in preparer.load(path).items():
            reports[instance_id] = (report, path)
    rows = []
    for task in preparer.selection_at(control)["tasks"]:
        instance_id = task["instance_id"]
        row = dataset[instance_id]
        if instance_id not in reports:
            rows.append({"instance_id": instance_id, "ok": False, "reason": "missing_official_report"})
            continue
        report, path = reports[instance_id]
        f2p = preparer.expected_tests(row, "FAIL_TO_PASS")
        p2p = preparer.expected_tests(row, "PASS_TO_PASS")
        log = path.parent / "test_output.txt"
        try:
            actual = preparer.parse_observed_status(control, row, log, python)
        except ValueError as error:
            rows.append({"instance_id": instance_id, "ok": False, "official_resolved": report.get("resolved"), "reason": str(error)})
            continue
        passed = lambda name: actual.get(name) in ("PASSED", "XFAIL")
        unobserved = [name for name in f2p + p2p if name not in actual]
        if kind == "gold":
            wrong = [name for name in f2p + p2p if not passed(name)]
            ok = bool(report.get("resolved")) and not wrong and not unobserved
        else:
            failing = [name for name in f2p if actual.get(name) == "FAILED"]
            wrong = [name for name in p2p if not passed(name)]
            ok = not report.get("resolved") and bool(failing) and not wrong and not unobserved
        text = log.read_text(encoding="utf-8", errors="replace") if log.exists() else ""
        rows.append({"instance_id": instance_id, "ok": ok, "official_resolved": report.get("resolved"),
                     "wrong_tests": wrong, "unobserved_tests": unobserved,
                     "network_symptom_in_log": bool(NETWORK_SYMPTOM.search(text))})
    return {"kind": kind, "passed": sum(row["ok"] for row in rows), "denominator": len(rows), "tasks": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--control-dir", required=True)
    parser.add_argument("--reports-dir", required=True)
    parser.add_argument("--kind", choices=("gold", "baseline"), required=True)
    parser.add_argument("--python", required=True)
    args = parser.parse_args()
    print(json.dumps(summarize(args.control_dir, args.reports_dir, args.kind, args.python), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
