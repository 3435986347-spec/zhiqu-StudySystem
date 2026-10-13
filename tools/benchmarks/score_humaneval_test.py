"""Offline scorer boundary tests: no model calls or generated solutions execute."""

import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


SOURCE = Path(os.environ.get("ZHIQU_SCORER_TEST_SOURCE", Path(__file__).with_name("score_humaneval.py")))
SPEC = importlib.util.spec_from_file_location("zhiqu_score_humaneval", SOURCE)
scorer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scorer)

PROBLEM = {"task_id": "HumanEval/0", "prompt": "def identity(x):\n", "entry_point": "identity",
           "test": "def check(candidate):\n    assert candidate(2) == 2\n",
           "canonical_solution": "    return x\n"}
COMPLETION = "    return x\n"
VERDICT = {"task_id": PROBLEM["task_id"], "passed": True, "result": "passed", "status": "passed"}


class ScorerBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="zq-score-test-", dir="/private/tmp")
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        self.checker = scorer.Checker(self.repo, 3.0, "parent")
        self.addCleanup(self.checker.close)
        patcher = mock.patch.object(scorer.os, "killpg")
        self.kill = patcher.start()
        self.addCleanup(patcher.stop)
        self.launches = []

    def fake_process(self, command, **kwargs):
        process = mock.Mock(pid=123456, returncode=0)
        process.communicate.return_value = (json.dumps(VERDICT).encode(), b"")
        self.launches.append((command, kwargs, process))
        return process

    def test_request_is_only_on_stdin_and_excludes_reference_solution(self):
        with mock.patch.object(scorer.subprocess, "Popen", side_effect=self.fake_process):
            result = self.checker.check(PROBLEM, COMPLETION)
        self.assertTrue(result["passed"])
        command, options, process = self.launches[0]
        self.assertEqual(options["stdin"], subprocess.PIPE)
        self.assertNotIn("request.json", " ".join(command))
        self.assertEqual(command[-3:], ["--_worker", "--human-eval-repo", str(self.repo)])
        payload = json.loads(process.communicate.call_args.kwargs["input"])
        self.assertEqual(payload, {"problem": {key: PROBLEM[key] for key in
                                             ("task_id", "prompt", "test", "entry_point")},
                                   "completion": COMPLETION, "timeout": 3.0})
        self.assertNotIn("canonical_solution", payload["problem"])
        self.assertFalse(any(self.checker.base.rglob("request.json*")))

    def test_each_check_has_a_fresh_removed_scratch_and_minimal_environment(self):
        seen = []

        def launch(command, **options):
            scratch = Path(options["cwd"])
            self.assertFalse((scratch / "previous-task.txt").exists())
            (scratch / "previous-task.txt").write_text("task-local data")
            seen.append(scratch)
            self.assertEqual(options["env"]["TMPDIR"], str(scratch))
            self.assertNotIn("ZHIQU_TEST_SECRET", options["env"])
            return self.fake_process(command, **options)

        with mock.patch.dict(os.environ, {"ZHIQU_TEST_SECRET": "fixture-only"}), \
                mock.patch.object(scorer.subprocess, "Popen", side_effect=launch):
            self.checker.check(PROBLEM, COMPLETION)
            self.checker.check(PROBLEM, COMPLETION)
        self.assertEqual(len(seen), 2)
        self.assertNotEqual(seen[0], seen[1])
        self.assertTrue(all(not directory.exists() for directory in seen))

    def test_success_still_terminates_descendant_process_group(self):
        with mock.patch.object(scorer.subprocess, "Popen", side_effect=self.fake_process):
            self.checker.check(PROBLEM, COMPLETION)
        self.kill.assert_called_once_with(123456, signal.SIGKILL)

    def test_error_and_invalid_json_also_terminate_group(self):
        for returncode, stdout in ((2, b""), (0, b"invalid JSON")):
            with self.subTest(returncode=returncode, stdout=stdout):
                process = mock.Mock(pid=123456, returncode=returncode)
                process.communicate.return_value = (stdout, b"fixture stderr")
                self.kill.reset_mock()
                with mock.patch.object(scorer.subprocess, "Popen", return_value=process):
                    result = self.checker.check(PROBLEM, COMPLETION)
                self.assertEqual(result["status"], "verifier_error")
                self.assertFalse(result["passed"])
                self.kill.assert_called_once_with(123456, signal.SIGKILL)

    def test_timeout_kills_group_before_draining_and_removes_scratch(self):
        process = mock.Mock(pid=123456, returncode=-9)
        process.communicate.side_effect = [subprocess.TimeoutExpired(["fixture"], 15), (b"", b"")]
        with mock.patch.object(scorer.subprocess, "Popen", return_value=process) as launch:
            result = self.checker.check(PROBLEM, COMPLETION)
        self.assertEqual(result["status"], "verifier_timeout")
        self.assertFalse(result["passed"])
        self.assertEqual(process.communicate.call_count, 2)
        self.assertEqual(self.kill.call_count, 2)
        self.assertFalse(Path(launch.call_args.kwargs["cwd"]).exists())

    def test_profile_control_file_stays_outside_child_writable_scratch(self):
        self.checker.sandbox = "/usr/bin/sandbox-exec"
        seen_profiles = []

        def launch(command, **options):
            profile = Path(command[2])
            scratch = Path(options["cwd"])
            self.assertEqual(profile.parent, self.checker.base)
            self.assertNotEqual(profile.parent, scratch)
            self.assertIn('(subpath "%s")' % scratch, profile.read_text())
            seen_profiles.append(profile)
            return self.fake_process(command, **options)

        with mock.patch.object(scorer.subprocess, "Popen", side_effect=launch):
            self.checker.check(PROBLEM, COMPLETION)
            self.checker.check(PROBLEM, COMPLETION)
        self.assertNotEqual(seen_profiles[0], seen_profiles[1])
        self.assertTrue(all(not profile.exists() for profile in seen_profiles))

    def test_worker_reads_control_json_from_stdin(self):
        request = {"problem": {key: PROBLEM[key] for key in ("task_id", "prompt", "test", "entry_point")},
                   "completion": COMPLETION, "timeout": 3.0}
        check = mock.Mock(return_value={"task_id": PROBLEM["task_id"], "passed": True,
                                       "result": "passed", "completion_id": 0})
        execution = types.ModuleType("human_eval.execution")
        execution.check_correctness = check
        output = io.StringIO()
        legacy_request = self.repo / "legacy-request.json"
        legacy_request.write_text(json.dumps(dict(request, completion="    return None\n")))
        with mock.patch.dict(sys.modules, {"human_eval": types.ModuleType("human_eval"),
                                           "human_eval.execution": execution}), \
                mock.patch.object(sys, "path", list(sys.path)), \
                mock.patch.object(scorer, "apply_limits"), \
                mock.patch.object(sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode()))), \
                mock.patch.object(sys, "stdout", output):
            # The obsolete filename argument deliberately points at different
            # bytes, so the baseline fails an assertion rather than setup.
            scorer.worker(types.SimpleNamespace(human_eval_repo=str(self.repo), _worker=str(legacy_request)))
        check.assert_called_once_with(request["problem"], COMPLETION, 3.0, 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "passed")


if __name__ == "__main__":
    unittest.main()
