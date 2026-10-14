"""Offline controller tests. Fixture source is never executed; no Docker/model."""

import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import tarfile
import tempfile
import unittest

SOURCE = Path(os.environ.get("ZHIQU_REPO_PREPARER_TEST_SOURCE", Path(__file__).with_name("prepare-repository-eval.py")))
SPEC = importlib.util.spec_from_file_location("repository_preparer", SOURCE)
controller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(controller)


class PreparationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="zq-controller-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.control = self.root / "control"
        self.rows = [{"instance_id": "demo__repo-" + str(i), "repo": "demo/repo", "base_commit": "a" * 40,
                      "problem_statement": "Public fixture issue " + str(i), "patch": "PRIVATE FIXTURE GOLD",
                      "test_patch": "PRIVATE FIXTURE TEST", "FAIL_TO_PASS": json.dumps(["test_fix_" + str(i)]),
                      "PASS_TO_PASS": json.dumps(["test_existing_" + str(i)])} for i in range(500)]
        self.selection = {"revision": controller.DATASET_REVISION, "dataset_rows": 500,
                          "tasks": [{"instance_id": row["instance_id"], "repo": row["repo"], "base_commit": row["base_commit"],
                                     "problem_statement_sha256": controller.sha(row["problem_statement"].encode())}
                                    for row in self.rows[:10]]}
        self.protocol = {"dataset": {"revision": controller.DATASET_REVISION, "size": 10},
                         "harness": {"commit": controller.HARNESS_COMMIT},
                         "limits": {"grading_concurrency": 1, "official_grader_seconds": 1800}}
        controller.prepare_rows(self.rows, self.selection, self.protocol, self.control)
        self.instance_id = self.rows[0]["instance_id"]
        self.base = self.control / "tasks" / self.instance_id / "base_repo"
        controller.materialize({"code.py": ("file", b"def answer():\n    return 1\n", False),
                                "removed.txt": ("file", b"baseline\n", False)}, self.base)
        manifest = controller.tree_manifest(controller.scan_tree(self.base))
        controller.write_json(self.base.parent / "source.json", {"base_tree_sha256": controller.sha(json.dumps(manifest, sort_keys=True).encode())})
        self.final = self.root / "final"
        shutil.copytree(self.base, self.final, symlinks=True)
        self.output = self.root / "output"

    def collect(self, **kwargs):
        return controller.collect_patch(self.control, self.instance_id, self.final, self.output, stopped=True, **kwargs)

    def test_private_snapshot_and_public_projection_are_separate(self):
        public = controller.load(self.base.parent / "public-task.json")
        self.assertEqual(set(public), set(controller.PUBLIC_FIELDS))
        self.assertNotIn("PRIVATE FIXTURE", json.dumps(public))
        private = self.control / "private/dataset.json"
        self.assertEqual(len(controller.load(private)), 10)
        self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(private.parent.stat().st_mode), 0o700)
        self.assertEqual(controller.load(private)[0]["patch"], "PRIVATE FIXTURE GOLD")
        noop = (self.control / "private/noop-predictions.jsonl").read_text()
        self.assertIn(".zhiqu-baseline-control.txt", noop)
        self.assertNotIn("PRIVATE FIXTURE GOLD", noop)

    def test_issue_mismatch_fails_before_writing_private_data(self):
        bad = json.loads(json.dumps(self.selection))
        bad["tasks"][0]["problem_statement_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "issue hash"):
            controller.prepare_rows(self.rows, bad, self.protocol, self.root / "bad")
        self.assertFalse((self.root / "bad/private").exists())

    def test_text_add_delete_modify_patch_reconstructs_source(self):
        (self.final / "code.py").write_text("def answer():\n    return 2\n")
        (self.final / "removed.txt").unlink()
        (self.final / "new.txt").write_text("new public source\n")
        result = self.collect()
        patch = (self.output / "patch.diff").read_text()
        self.assertIn("return 2", patch)
        self.assertIn("deleted file mode", patch)
        self.assertIn("new file mode", patch)
        self.assertEqual(result["integrity"], "passed")
        self.assertEqual(result["patch_sha256"], controller.sha(patch.encode()))

    def test_workspace_must_be_stopped(self):
        with self.assertRaisesRegex(ValueError, "Stop and freeze"):
            controller.collect_patch(self.control, self.instance_id, self.final, self.output)

    def test_case_alias_git_metadata_is_rejected_before_trusted_git(self):
        alias = self.final / ".GIT"
        alias.mkdir()
        (alias / "config").write_text("[core]\n\thooksPath = fixture-only\n")
        with self.assertRaisesRegex(ValueError, "protected.*metadata"):
            controller.scan_tree(self.final)

    def test_case_alias_cli_metadata_is_not_treated_as_source(self):
        alias = self.final / ".ZHIQU"
        alias.mkdir()
        (alias / "settings.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "protected.*metadata"):
            controller.scan_tree(self.final)

    def test_source_base_drift_is_refused(self):
        (self.base / "code.py").write_text("modified controller base\n")
        with self.assertRaisesRegex(ValueError, "base tree was modified"):
            self.collect()

    def test_protected_metadata_cannot_be_excluded(self):
        (self.final / ".zhiqu").mkdir()
        (self.final / ".zhiqu/settings.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "Protected CLI metadata"):
            self.collect(excludes=[".zhiqu/**"])

    def test_generated_sessions_are_excluded_with_audit_record(self):
        session = self.final / ".zhiqu/sessions/session.jsonl"
        session.parent.mkdir(parents=True)
        session.write_text("{}\n")
        self.collect()
        self.assertEqual((self.output / "patch.diff").read_bytes(), b"")
        self.assertEqual(controller.load(self.output / "collection.json")["excluded_artifacts"][0]["path"], ".zhiqu/sessions/session.jsonl")

    def test_excluding_a_modified_baseline_file_is_refused(self):
        (self.final / "code.py").write_text("different public code\n")
        with self.assertRaisesRegex(ValueError, "baseline file"):
            self.collect(excludes=["*.py"])

    def test_changed_binary_and_git_metadata_are_refused(self):
        (self.final / "binary.bin").write_bytes(b"\x00new binary")
        with self.assertRaisesRegex(ValueError, "binary"):
            self.collect()
        (self.final / "binary.bin").unlink()
        (self.final / ".git").write_text("untrusted metadata")
        with self.assertRaisesRegex(ValueError, "protected .git"):
            self.collect()

    def test_escaping_links_and_hardlinks_are_refused_without_following(self):
        (self.root / "outside.txt").write_text("outside fixture")
        (self.final / "escape").symlink_to("../outside.txt")
        with self.assertRaisesRegex(ValueError, "Escaping symlink"):
            self.collect()
        (self.final / "escape").unlink()
        os.link(self.root / "outside.txt", self.final / "hardlink")
        with self.assertRaisesRegex(ValueError, "Hardlinked"):
            self.collect()
        self.assertEqual((self.root / "outside.txt").read_text(), "outside fixture")

    def test_internal_symlink_patch_is_preserved(self):
        (self.final / "internal").symlink_to("code.py")
        self.collect()
        self.assertIn("120000", (self.output / "patch.diff").read_text())

    def test_archive_path_escape_is_refused_before_extraction(self):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            item = tarfile.TarInfo("root/../outside.txt")
            item.size = 1
            archive.addfile(item, io.BytesIO(b"x"))
        with self.assertRaisesRegex(ValueError, "escapes"):
            controller.safe_archive(stream.getvalue(), self.root / "archive")
        self.assertFalse((self.root / "archive").exists())

    def test_harness_uses_local_snapshot_unique_run_and_requires_outer_isolation(self):
        harness = self.control / ("SWE-bench-" + controller.HARNESS_COMMIT)
        (harness / "swebench/harness").mkdir(parents=True)
        (harness / "swebench/harness/run_evaluation.py").write_text("# trusted fixture only\n")
        controller.write_json(self.control / "harness-source.json", {"commit": controller.HARNESS_COMMIT})
        predictions = self.control / "private/noop-predictions.jsonl"
        first = controller.harness_command(self.control, predictions, self.control / "protocol.json", "baseline")
        second = controller.harness_command(self.control, predictions, self.control / "protocol.json", "baseline")
        self.assertIn(str(self.control / "private/dataset.json"), first["argv"])
        self.assertNotEqual(first["run_id"], second["run_id"])
        self.assertFalse(first["safe_to_execute_unwrapped"])
        self.assertTrue(first["requires_container_isolation_adapter"])

    def write_reports(self, resolved):
        directory = self.root / "reports"
        for row in self.rows[:10]:
            f2p = controller.expected_tests(row, "FAIL_TO_PASS")
            p2p = controller.expected_tests(row, "PASS_TO_PASS")
            report = {row["instance_id"]: {"resolved": resolved, "tests_status": {
                "FAIL_TO_PASS": {"success": f2p if resolved else [], "failure": [] if resolved else f2p},
                "PASS_TO_PASS": {"success": p2p, "failure": []}}}}
            controller.write_json(directory / row["instance_id"] / "report.json", report)
        return directory

    def test_missing_reports_never_produce_a_rate(self):
        result = controller.validate_reports(self.control, self.root / "missing")
        self.assertEqual(result["status"], "infrastructure_incomplete")
        self.assertIsNone(result["official_rate"])
        with self.assertRaisesRegex(ValueError, "missing official"):
            controller.validate_reports(self.control, self.root / "missing", "gold")

    def test_official_resolved_and_nonofficial_integrity_remain_separate(self):
        reports = self.write_reports(True)
        result = controller.validate_reports(self.control, reports, status_reader=lambda row, path: {})
        self.assertEqual(result["resolved"], 10)
        self.assertEqual(result["official_rate"], 1.0)
        self.assertEqual(result["results"][0]["integrity"], "expected_tests_unobserved")
        self.assertEqual(result["status"], "integrity_unverified")
        self.assertIsNone(result["ability_rate"])

    def test_gold_report_cannot_override_actual_failed_test(self):
        reports = self.write_reports(True)
        def failed(row, path):
            return {name: "FAILED" for name in controller.expected_tests(row, "FAIL_TO_PASS")
                    + controller.expected_tests(row, "PASS_TO_PASS")}
        with self.assertRaisesRegex(ValueError, "Gold control"):
            controller.validate_reports(self.control, reports, "gold", status_reader=failed)

    def test_baseline_missing_tests_cannot_be_a_red_control(self):
        reports = self.write_reports(False)
        with self.assertRaisesRegex(ValueError, "did not execute"):
            controller.validate_reports(self.control, reports, "baseline", status_reader=lambda row, path: {})
        def observed(row, path):
            return {**{name: "FAILED" for name in controller.expected_tests(row, "FAIL_TO_PASS")},
                    **{name: "PASSED" for name in controller.expected_tests(row, "PASS_TO_PASS")}}
        result = controller.validate_reports(self.control, reports, "baseline", status_reader=observed)
        self.assertEqual(result["resolved"], 0)
        self.assertEqual(result["status"], "graded")


if __name__ == "__main__":
    unittest.main()
