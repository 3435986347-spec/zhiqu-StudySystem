#!/usr/bin/env python3
"""Score one zhiqu agent episode per HumanEval task with the official checker.

The private dataset (including tests and reference solutions) belongs outside
agent workspaces. This program never sends it to a model. The generator must
extract a completion only after solution.py has the byte-exact original prompt
prefix, and supply its solution_sha256 for independent reconstruction checking.

Aggregation is local passed / expected, not a claim to have invoked the official
numpy-based evaluate_functional_correctness command. reliability_guard in the
upstream checker is not an operating-system sandbox.
"""

import argparse
import ast
import collections
import datetime
import gzip
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import sysconfig
import tempfile
import time


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def dataset_at(path, expected):
    raw = Path(path).read_bytes()
    payload = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
    problems = {}
    for line in payload.decode("utf-8").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        task_id = item["task_id"]
        if task_id in problems:
            raise ValueError("Duplicate dataset task: " + task_id)
        for key in ("prompt", "test", "entry_point", "canonical_solution"):
            if not isinstance(item.get(key), str):
                raise ValueError("Invalid dataset field %s for %s" % (key, task_id))
        problems[task_id] = item
    if len(problems) != expected:
        raise ValueError("Expected %d dataset tasks, found %d" % (expected, len(problems)))
    if expected == 164 and set(problems) != {"HumanEval/%d" % i for i in range(164)}:
        raise ValueError("Full HumanEval must contain exactly HumanEval/0 through HumanEval/163")
    return problems, digest(raw)


def dependency_metadata():
    result = {}
    for name in ("numpy", "tqdm", "fire"):
        try:
            spec = importlib.util.find_spec(name)
            result[name] = {"available": spec is not None}
        except (ImportError, ValueError) as exc:
            result[name] = {"available": False, "error": str(exc)}
    return result


def source_metadata(repo):
    execution = repo / "human_eval" / "execution.py"
    source = execution.read_bytes()
    tree = ast.parse(source)
    enabled = any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                  and node.func.id == "exec" and node.args and isinstance(node.args[0], ast.Name)
                  and node.args[0].id == "check_program" for node in ast.walk(tree))
    if not enabled:
        raise ValueError("Official execution.py has execution disabled; checks would give a false green")
    commit = None
    dirty = None
    try:
        commit = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"],
                                         stderr=subprocess.DEVNULL, text=True).strip()
        dirty = bool(subprocess.check_output(["git", "-C", str(repo), "status", "--porcelain"],
                                            stderr=subprocess.DEVNULL, text=True).strip())
    except (OSError, subprocess.CalledProcessError):
        pass
    return {"repository": "https://github.com/openai/human-eval", "commit": commit,
            "dirty": dirty, "executionSha256": digest(source)}


def sb_quote(value):
    return json.dumps(str(value))


def profile_for(repo, scratch):
    # Read only Python runtime directories, this script, upstream checker code,
    # and the private per-check scratch directory. IP networking remains denied.
    roots = {"/System", "/usr", str(Path(sys.prefix).resolve()), str(Path(sys.base_prefix).resolve())}
    for key in ("stdlib", "platstdlib", "purelib", "platlib"):
        roots.add(str(Path(sysconfig.get_path(key)).resolve()))
    roots.add(str((repo / "human_eval").resolve()))
    roots.add(str(scratch))
    clauses = ["(version 1)", "(deny default)", '(import "dyld-support.sb")',
               "(allow process-fork)",
               "(allow process-exec (literal %s) (literal %s))" % (sb_quote(sys.executable), sb_quote(Path(sys.executable).resolve())),
               "(allow signal (target same-sandbox))", "(allow file-read-metadata)",
               "(allow sysctl-read)", "(allow mach-lookup)", "(allow ipc-posix-sem)",
               "(allow file-read* (literal %s))" % sb_quote(repo),
               "(allow file-read* (literal %s))" % sb_quote(Path(__file__).resolve()),
               "(allow file-read* file-write* (literal \"/dev/null\"))",
               "(allow file-read* (literal \"/dev/random\") (literal \"/dev/urandom\"))",
               "(allow file-write* (subpath %s))" % sb_quote(scratch),
               # multiprocessing.Manager uses Unix-domain sockets under TMPDIR.
               "(allow network* (subpath %s))" % sb_quote(scratch)]
    clauses.extend("(allow file-read* file-map-executable (subpath %s))" % sb_quote(root) for root in sorted(roots))
    return "\n".join(clauses) + "\n"


class Checker:
    def __init__(self, repo, timeout, isolation):
        self.repo = repo.resolve()
        self.timeout = timeout
        # Darwin AF_UNIX socket paths are short; multiprocessing.Manager adds
        # its own directory/name, so the user's long default TMPDIR is unsuitable.
        self.directory = tempfile.TemporaryDirectory(prefix="zq-hev-", dir="/private/tmp" if sys.platform == "darwin" else None)
        self.base = Path(self.directory.name).resolve()
        self.command = [sys.executable, "-I", "-B", str(Path(__file__).resolve())]
        self.sandbox = None
        if isolation == "parent":
            self.isolation = {"mode": "parent", "verifiedByThisScript": False,
                              "note": "Caller supplies external OS isolation; upstream reliability_guard is not a sandbox."}
        elif sys.platform == "darwin" and shutil.which("sandbox-exec"):
            self.sandbox = shutil.which("sandbox-exec")
            # Each child gets a new scratch path. Record the policy template,
            # rather than claiming one concrete profile was reused for all tasks.
            template = profile_for(self.repo, Path("{{SCRATCH}}"))
            self.isolation = {"mode": "macos-sandbox-exec", "profileSha256": digest(template.encode("utf-8")),
                              "profileHashScope": "template; per-child scratch path normalized",
                              "verifiedByThisScript": False}
            marker = self.base / "blocked.txt"
            marker.write_text("private verifier boundary probe", encoding="utf-8")
            probe = self.run(["--_probe", str(marker)])
            if not probe.get("readDenied") or not probe.get("writeDenied") or not probe.get("ipNetworkDenied"):
                raise RuntimeError("OS isolation probe failed: " + json.dumps(probe))
            self.isolation.update({"verifiedByThisScript": True, "probe": probe})
        else:
            raise RuntimeError("OS isolation unavailable; use --isolation parent only inside a caller-provided sandbox")

    def close(self):
        self.directory.cleanup()

    @staticmethod
    def terminate_group(process):
        # A successful worker can leave descendants running after closing its
        # pipes. Reap its process group on every exit, before deleting scratch.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def run(self, args, payload=None):
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="w-", dir=str(self.base)) as directory:
            scratch = Path(directory).resolve()
            env = {"PATH": "/usr/bin:/bin",
                   "TMPDIR": str(scratch), "TMP": str(scratch), "TEMP": str(scratch),
                   "LANG": "en_US.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}
            command = list(self.command)
            profile = None
            if self.sandbox:
                # Control files stay in the parent-only directory; the child
                # may write only inside its own disposable scratch directory.
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".sb",
                                                 dir=str(self.base), delete=False) as stream:
                    profile = Path(stream.name)
                    stream.write(profile_for(self.repo, scratch))
                command = [self.sandbox, "-f", str(profile)] + command
            process = None
            try:
                process = subprocess.Popen(command + args, cwd=str(scratch), env=env,
                                           stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                try:
                    stdout, stderr = process.communicate(input=payload, timeout=self.timeout + 12)
                except subprocess.TimeoutExpired:
                    self.terminate_group(process)
                    process.communicate()
                    return {"status": "verifier_timeout", "passed": False,
                            "error": "Official checker subprocess exceeded wall-time budget"}
            finally:
                if process is not None:
                    self.terminate_group(process)
                if profile is not None:
                    profile.unlink(missing_ok=True)
        if process.returncode != 0:
            return {"status": "verifier_error", "passed": False, "exitCode": process.returncode,
                    "error": stderr.decode("utf-8", "replace")[-2000:]}
        try:
            result = json.loads(stdout)
        except (ValueError, TypeError):
            return {"status": "verifier_error", "passed": False,
                    "error": "Checker produced invalid JSON: " + stdout.decode("utf-8", "replace")[-500:]}
        result["verificationDurationMs"] = round((time.monotonic() - started) * 1000)
        return result

    def check(self, problem, completion):
        private_problem = {key: problem[key] for key in ("task_id", "prompt", "test", "entry_point")}
        request = json.dumps({"problem": private_problem, "completion": completion,
                              "timeout": self.timeout}).encode("utf-8")
        return self.run(["--_worker", "--human-eval-repo", str(self.repo)], payload=request)


def apply_limits():
    try:
        import resource
        for key, limit in ((resource.RLIMIT_CPU, 10), (resource.RLIMIT_FSIZE, 4 * 1024 * 1024),
                           (resource.RLIMIT_NOFILE, 128), (resource.RLIMIT_DATA, 768 * 1024 * 1024)):
            current = resource.getrlimit(key)
            hard = current[1]
            cap = limit if hard == resource.RLIM_INFINITY else min(limit, hard)
            resource.setrlimit(key, (cap, cap))
    except (ImportError, OSError, ValueError):
        # Parent wall-time and OS file/network policies still apply. The report
        # describes these as attempted limits, never as a stronger sandbox.
        pass


def worker(args):
    apply_limits()
    sys.path.insert(0, str(Path(args.human_eval_repo).resolve()))
    from human_eval.execution import check_correctness
    request = json.loads(sys.stdin.buffer.read())
    result = check_correctness(request["problem"], request["completion"], request["timeout"], 0)
    verdict = result["result"]
    result["status"] = "passed" if result["passed"] else ("test_timeout" if verdict == "timed out" else "test_failed")
    print(json.dumps(result, ensure_ascii=False))


def probe(path):
    import errno
    import socket
    result = {}
    for name, operation in (("readDenied", lambda: Path(path).read_bytes()),
                            ("writeDenied", lambda: Path(path + ".write").write_text("probe"))):
        try:
            operation()
            result[name] = False
        except OSError as exc:
            result[name] = exc.errno in (errno.EACCES, errno.EPERM)
    connection = socket.socket()
    connection.settimeout(1)
    try:
        connection.connect(("127.0.0.1", 9))
        result["ipNetworkDenied"] = False
    except OSError as exc:
        result["ipNetworkDenied"] = exc.errno in (errno.EACCES, errno.EPERM)
    finally:
        connection.close()
    print(json.dumps(result))


def samples_at(path, problems):
    samples = {}
    for line_number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        item = json.loads(line)
        task_id = item.get("task_id")
        if task_id not in problems:
            raise ValueError("Unknown sample task at line %d: %r" % (line_number, task_id))
        if task_id in samples:
            raise ValueError("Duplicate sample for %s; this protocol requires one episode per task" % task_id)
        samples[task_id] = item
    return samples


def sample_result(problem, sample, checker):
    task_id = problem["task_id"]
    if sample is None:
        return {"task_id": task_id, "passed": False, "status": "missing_sample", "generation_status": "missing"}
    generation_status = sample.get("generation_status", "completed")
    details = {"task_id": task_id, "generation_status": generation_status}
    for field in ("duration_ms", "solution_sha256", "error"):
        if field in sample:
            details[field] = sample[field]
    if generation_status != "completed":
        return dict(details, passed=False, status="generation_failed")
    completion = sample.get("completion")
    if not isinstance(completion, str):
        return dict(details, passed=False, status="protocol_error", error="completion must be a string")
    solution_hash = sample.get("solution_sha256")
    reconstructed_hash = digest((problem["prompt"] + completion).encode("utf-8"))
    if not isinstance(solution_hash, str) or solution_hash != reconstructed_hash:
        return dict(details, passed=False, status="protocol_error",
                    error="solution_sha256 missing or inconsistent with byte-exact prompt + completion")
    return dict(details, **checker.check(problem, completion))


def self_test(problems, checker):
    canonical_results = []
    for index, problem in enumerate(problems.values(), 1):
        canonical_results.append(checker.check(problem, problem["canonical_solution"]))
        if canonical_results[-1].get("status") in ("verifier_error", "verifier_timeout"):
            break
        if index % 16 == 0 or index == len(problems):
            print("Verifier reference checks: %d/%d" % (index, len(problems)), file=sys.stderr, flush=True)
    failures = [result for result in canonical_results if not result.get("passed")]
    first = problems.get("HumanEval/0", next(iter(problems.values())))
    empty_result = checker.check(first, "")
    bad_result = checker.check(first, "\n    raise AssertionError('deliberate incorrect implementation')\n")
    null_result = sample_result(first, {"task_id": first["task_id"], "completion": None}, checker)
    protocol_result = sample_result(first, {"task_id": first["task_id"], "completion": first["canonical_solution"],
                                           "generation_status": "gateway_error"}, checker)
    integrity_result = sample_result(first, {"task_id": first["task_id"], "completion": first["canonical_solution"],
                                            "solution_sha256": "0" * 64}, checker)
    missing_result = sample_result(first, None, checker)
    valid_sample = {"task_id": first["task_id"], "completion": first["canonical_solution"],
                    "solution_sha256": digest((first["prompt"] + first["canonical_solution"]).encode("utf-8"))}
    complete_result = sample_result(first, valid_sample, checker)
    verified = (len(canonical_results) == len(problems) and not failures
                and not empty_result.get("passed") and empty_result.get("status") == "test_failed"
                and not bad_result.get("passed") and bad_result.get("status") == "test_failed"
                and null_result["status"] == "protocol_error" and not protocol_result["passed"]
                and integrity_result["status"] == "protocol_error" and missing_result["status"] == "missing_sample"
                and complete_result.get("passed"))
    return {"verified": verified, "canonicalPassed": len(canonical_results) - len(failures),
            "canonicalAttempted": len(canonical_results),
            "canonicalTotal": len(problems), "canonicalFailures": failures,
            "emptyCompletionControl": empty_result, "incorrectImplementationControl": bad_result,
            "nullCompletionControl": null_result, "gatewayFailureControl": protocol_result,
            "integrityMismatchControl": integrity_result, "missingSampleControl": missing_result,
            "validSampleControl": complete_result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--human-eval-repo", help="Pinned external openai/human-eval checkout")
    parser.add_argument("--dataset", help="Private official HumanEval JSONL or JSONL.gz")
    parser.add_argument("--samples", help="Agent samples.jsonl, one episode per task")
    parser.add_argument("--output", help="Report JSON destination outside agent workspaces")
    parser.add_argument("--expected", type=int, default=164)
    parser.add_argument("--timeout", type=float, default=3.0)
    parser.add_argument("--isolation", choices=("auto", "parent"), default="auto")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--_worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--_probe", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args._probe:
        probe(args._probe)
        return 0
    if args._worker:
        worker(args)
        return 0
    if not args.human_eval_repo or not args.dataset or not args.output or (not args.self_test and not args.samples):
        parser.error("--human-eval-repo, --dataset, --output and either --samples or --self-test are required")
    if args.expected < 1 or not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--expected and --timeout must be positive")
    report = {"benchmark": "HumanEval", "protocol": "zhiqu file-editing agent; one episode per task; hidden final tests",
              "scorer": "official human_eval.execution.check_correctness + local single-sample aggregation",
              "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "denominator": args.expected, "testTimeoutSeconds": args.timeout,
              "officialAggregateDependencies": dependency_metadata(), "pythonVersion": sys.version,
              "resourceLimits": "Per-worker CPU, file-size, open-file and data limits attempted; parent wall-time enforced"}
    checker = None
    try:
        problems, dataset_hash = dataset_at(args.dataset, args.expected)
        report["sourceSha256"] = dataset_hash
        report["officialSource"] = source_metadata(Path(args.human_eval_repo).resolve())
        samples = None if args.self_test else samples_at(args.samples, problems)
        checker = Checker(Path(args.human_eval_repo), args.timeout, args.isolation)
        report["isolation"] = checker.isolation
        if args.self_test:
            report["selfTest"] = self_test(problems, checker)
            report["status"] = "self_test_passed" if report["selfTest"]["verified"] else "self_test_failed"
            write_json(args.output, report)
            print(json.dumps({"status": report["status"], "canonicalPassed": report["selfTest"]["canonicalPassed"],
                              "denominator": args.expected, "output": str(Path(args.output).resolve())}))
            return 0 if report["selfTest"]["verified"] else 2
        report["samplesSha256"] = digest(Path(args.samples).read_bytes())
        results = []
        for index, problem in enumerate(problems.values(), 1):
            results.append(sample_result(problem, samples.get(problem["task_id"]), checker))
            if index % 16 == 0 or index == len(problems):
                print("Scored: %d/%d" % (index, len(problems)), file=sys.stderr, flush=True)
        counts = dict(collections.Counter(result["status"] for result in results))
        generations = dict(collections.Counter(result["generation_status"] for result in results))
        passed = sum(result["passed"] for result in results)
        infrastructure_error = any(result["status"] in ("verifier_error", "verifier_timeout") for result in results)
        report.update({"status": "verifier_error" if infrastructure_error else "scored", "passed": passed,
                       "failed": args.expected - passed, "passRate": None if infrastructure_error else passed / args.expected,
                       "agentEpisodeSuccessRate": None if infrastructure_error else passed / args.expected, "counts": counts,
                       "generationCounts": generations, "results": results,
                       "comparableToPureModelLeaderboard": False})
        write_json(args.output, report)
        print(json.dumps({"status": report["status"], "passed": passed, "denominator": args.expected,
                          "passRate": report["passRate"], "output": str(Path(args.output).resolve())}))
        return 2 if infrastructure_error else 0
    except Exception as exc:
        report.update({"status": "infrastructure_error", "error": str(exc), "passRate": None})
        write_json(args.output, report)
        print(json.dumps({"status": report["status"], "error": str(exc)}), file=sys.stderr)
        return 2
    finally:
        if checker:
            checker.close()


if __name__ == "__main__":
    sys.exit(main())
