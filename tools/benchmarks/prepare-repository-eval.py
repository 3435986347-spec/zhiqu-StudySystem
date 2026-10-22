#!/usr/bin/env python3
"""Trusted controller preparation for a pinned SWE-bench repository evaluation.

Never imports or executes candidate code. Only prepare-data decodes private
dataset fields, writes them to controller-only files, and never prints them.
Docker images and models are not invoked by preparation or collection.
"""

import argparse
import fnmatch
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

DATASET_REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a"
DATASET_SHA256 = "a45b1fe4e2f0c8390b2b2938ac83e92ed5979000856808f3679c07812e9e6dcd"
DATASET_BYTES = 2096679
HARNESS_COMMIT = "3f01bd622c0a22c00406139f69a234ef08225f22"
PUBLIC_FIELDS = ("repo", "instance_id", "base_commit", "problem_statement")
SESSION_EXCLUDES = (".zhiqu/.gitignore", ".zhiqu/setup.json", ".zhiqu/sessions/**", ".zhiqu/trash/**")
MAX_CHANGED_FILE_BYTES = 8 * 1024 * 1024
MAX_PATCH_BYTES = 4 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value, private=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Controller paths only, never candidate writable paths or fixed .tmp names.
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     prefix=".controller-", delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    temporary.chmod(0o600 if private else 0o644)
    temporary.replace(path)


def write_lines(path, rows):
    path = Path(path)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    path.chmod(0o600)


def selection_at(control):
    selection = load(Path(control) / "selection.json")
    require(selection["revision"] == DATASET_REVISION and selection["dataset_rows"] == 500,
            "Unexpected dataset revision or size")
    require(len(selection["tasks"]) == 10 and len({row["instance_id"] for row in selection["tasks"]}) == 10,
            "Selection must contain ten unique tasks")
    return selection


def task_at(control, instance_id):
    matches = [task for task in selection_at(control)["tasks"] if task["instance_id"] == instance_id]
    require(len(matches) == 1, "Instance is not in the fixed selection")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+-[0-9]+", instance_id), "Unsafe instance_id")
    return matches[0]


def expected_tests(row, name):
    value = row[name]
    if isinstance(value, str):
        value = json.loads(value)
    require(isinstance(value, list) and all(isinstance(item, str) for item in value), "Invalid private test metadata")
    return value


def prepare_rows(rows, selection, protocol, control):
    """Accept decoded pinned records; outputs are private except four-field tasks."""
    control = Path(control).resolve()
    require(len(rows) == 500 and len({row["instance_id"] for row in rows}) == 500, "Expected 500 unique dataset records")
    require(protocol["dataset"]["revision"] == selection["revision"] == DATASET_REVISION, "Revision mismatch")
    require(protocol["harness"]["commit"] == HARNESS_COMMIT, "Harness revision mismatch")
    require(protocol["dataset"]["size"] == 10 and len(selection["tasks"]) == 10, "Expected ten selected tasks")
    require(len({task["instance_id"] for task in selection["tasks"]}) == 10, "Duplicate selected task")
    by_id = {row["instance_id"]: row for row in rows}
    chosen = []
    for task in selection["tasks"]:
        require(task["instance_id"] in by_id, "Selected task missing from fixed dataset")
        row = by_id[task["instance_id"]]
        require(row["repo"] == task["repo"] and row["base_commit"] == task["base_commit"], "Selected task base differs")
        require(sha(row["problem_statement"].encode("utf-8")) == task["problem_statement_sha256"], "Public issue hash differs")
        require(isinstance(row.get("patch"), str) and isinstance(row.get("test_patch"), str), "Private grading fields missing")
        require(expected_tests(row, "FAIL_TO_PASS"), "Selected task has no fail-to-pass tests")
        expected_tests(row, "PASS_TO_PASS")
        chosen.append(row)
    private = control / "private"
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    private.chmod(0o700)
    write_json(control / "selection.json", selection)
    write_json(control / "protocol.json", protocol)
    # A local JSON path prevents upstream load_dataset from fetching latest.
    write_json(private / "dataset.json", chosen, private=True)
    noop = ("diff --git a/.zhiqu-baseline-control.txt b/.zhiqu-baseline-control.txt\n"
            "new file mode 100644\n--- /dev/null\n+++ b/.zhiqu-baseline-control.txt\n"
            "@@ -0,0 +1 @@\n+Baseline test execution control; no runtime behavior change.\n")
    for kind in ("gold", "empty", "noop"):
        predictions = [{"instance_id": row["instance_id"], "model_name_or_path": "zhiqu-control-" + kind,
                        "model_patch": row["patch"] if kind == "gold" else noop if kind == "noop" else ""}
                       for row in chosen]
        write_lines(private / (kind + "-predictions.jsonl"), predictions)
    for row in chosen:
        directory = control / "tasks" / row["instance_id"]
        directory.mkdir(parents=True, exist_ok=True)
        write_json(directory / "public-task.json", {key: row[key] for key in PUBLIC_FIELDS})
    write_json(control / "data-manifest.json", {"dataset_revision": DATASET_REVISION,
               "dataset_parquet_sha256": DATASET_SHA256, "harness_commit": HARNESS_COMMIT,
               "selection_sha256": sha(json.dumps(selection, sort_keys=True).encode()),
               "protocol_sha256": sha(json.dumps(protocol, sort_keys=True).encode()),
               "private_dataset_sha256": sha((private / "dataset.json").read_bytes()),
               "task_ids": [row["instance_id"] for row in chosen], "model_calls": 0})
    return {"tasks": len(chosen), "control_dir": str(control), "model_calls": 0}


def prepare_data(parquet, pyarrow_path, selection_file, protocol_file, control):
    data = Path(parquet).read_bytes()
    require(len(data) == DATASET_BYTES and sha(data) == DATASET_SHA256, "Parquet differs from pinned official bytes")
    if pyarrow_path:
        sys.path.insert(0, str(Path(pyarrow_path).resolve()))
    import pyarrow
    import pyarrow.parquet as pq
    require(pyarrow.__version__ == "20.0.0", "Preparation requires pinned pyarrow 20.0.0")
    # This is a trusted controller operation. Private fields are written only to
    # the private snapshot; neither values nor hidden field contents are printed.
    protocol = load(protocol_file)
    repository = Path(__file__).resolve().parents[2]
    require(protocol.get("agent", {}).get("file_sha256"), "Missing agent source fingerprints")
    for relative, expected in protocol["agent"]["file_sha256"].items():
        path = (repository / relative).resolve()
        require(repository in path.parents and sha(path.read_bytes()) == expected, "Agent source fingerprint differs")
    return prepare_rows(pq.read_table(parquet).to_pylist(), load(selection_file), protocol, control)


def safe_archive(data, destination):
    destination = Path(destination)
    require(not destination.exists(), "Archive destination already exists")
    entries = []
    roots = set()
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and ".." not in path.parts, "Archive path escapes destination")
            require(path.parts, "Empty archive path")
            roots.add(path.parts[0])
            if len(path.parts) == 1:
                require(member.isdir(), "Archive root must be a directory")
                continue
            relative = PurePosixPath(*path.parts[1:]).as_posix()
            require(relative not in seen, "Duplicate archive path")
            require(".git" not in {part.casefold() for part in path.parts[1:]}, "Archive contains Git metadata")
            require(member.isdir() or member.isfile() or member.issym(), "Archive contains unsupported special or hardlinked entry")
            seen.add(relative)
            body = archive.extractfile(member).read() if member.isfile() else None
            if member.issym():
                target = PurePosixPath(member.linkname)
                require(not target.is_absolute(), "Archive symlink is absolute")
                normalized = os.path.normpath(str(PurePosixPath(relative).parent / target))
                require(normalized != ".." and not normalized.startswith("../"), "Archive symlink escapes source")
            entries.append((relative, member, body))
    require(len(roots) == 1 and entries, "Expected one nonempty GitHub archive root")
    # Stage in a new trusted directory and create links last; never extract
    # files through links supplied by an archive.
    links = {relative for relative, member, _body in entries if member.issym()}
    for relative, member, _body in entries:
        for parent in PurePosixPath(relative).parents:
            if str(parent) != ".":
                require(str(parent) not in links, "Archive member traverses a symlink")
    destination.mkdir(parents=True)
    try:
        for relative, member, body in entries:
            if member.issym():
                continue
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(exist_ok=True)
            else:
                target.write_bytes(body)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
        for relative, member, _body in entries:
            if member.issym():
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(member.linkname)
        scan_tree(destination)
    except Exception:
        shutil.rmtree(destination)
        raise


def fetch_base(control, instance_id, archive_path=None):
    task = task_at(control, instance_id)
    directory = Path(control).resolve() / "tasks" / instance_id
    require(re.fullmatch(r"[0-9a-f]{40}", task["base_commit"]), "Invalid base commit")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", task["repo"]), "Invalid repository")
    url = "https://codeload.github.com/" + task["repo"] + "/tar.gz/" + task["base_commit"]
    data = Path(archive_path).read_bytes() if archive_path else urllib.request.urlopen(url, timeout=120).read()
    destination = directory / "base_repo"
    safe_archive(data, destination)
    manifest = tree_manifest(scan_tree(destination))
    metadata = {"instance_id": instance_id, "repo": task["repo"], "base_commit": task["base_commit"],
                "url": url, "archive_sha256": sha(data), "archive_bytes": len(data),
                "base_tree_sha256": sha(json.dumps(manifest, sort_keys=True).encode()),
                "base_manifest": manifest, "model_calls": 0}
    write_json(directory / "source.json", metadata)
    return {key: metadata[key] for key in ("instance_id", "base_commit", "archive_sha256", "base_tree_sha256")}


def scan_tree(root, trusted_git=False):
    root = Path(root).resolve()
    entries = {}
    def walk(directory):
        with os.scandir(directory) as iterator:
            items = sorted(iterator, key=lambda item: item.name)
        for item in items:
            path = Path(item.path)
            relative = path.relative_to(root).as_posix()
            parts = path.relative_to(root).parts
            if ".git" in {part.casefold() for part in parts}:
                require(trusted_git and relative == ".git", "Candidate or base contains protected .git metadata")
                continue
            require(parts[0].casefold() != ".zhiqu" or parts[0] == ".zhiqu",
                    "Candidate or base contains protected CLI metadata alias")
            info = item.stat(follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                walk(path)
            elif stat.S_ISLNK(info.st_mode):
                target = os.readlink(path)
                require(not os.path.isabs(target), "Absolute symlink refused: " + relative)
                resolved = Path(os.path.realpath(path))
                require(resolved == root or root in resolved.parents, "Escaping symlink refused: " + relative)
                protected = resolved.relative_to(root).parts
                require(not {part.casefold() for part in protected}.intersection((".git", ".zhiqu")),
                        "Symlink targets protected metadata")
                entries[relative] = ("symlink", target.encode("utf-8"), False)
            elif stat.S_ISREG(info.st_mode):
                require(info.st_nlink == 1, "Hardlinked file refused: " + relative)
                entries[relative] = ("file", path.read_bytes(), bool(info.st_mode & 0o111))
            else:
                raise ValueError("Special filesystem entry refused: " + relative)
    walk(root)
    return entries


def tree_manifest(entries):
    return {name: {"kind": value[0], "sha256": sha(value[1]), "executable": value[2]}
            for name, value in sorted(entries.items())}


def materialize(entries, root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    for name, (kind, body, executable) in entries.items():
        if kind != "file":
            continue
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        path.chmod(0o755 if executable else 0o644)
    for name, (kind, body, _executable) in entries.items():
        if kind == "symlink":
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(body.decode("utf-8"))


def git_command(root, arguments, input_bytes=None):
    binary = shutil.which("git")
    require(binary is not None, "Trusted Git executable is unavailable")
    command = [binary, "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
               "-c", "core.autocrlf=false", "-c", "core.attributesFile=/dev/null"] + list(arguments)
    env = {"PATH": str(Path(binary).parent) + ":/usr/bin:/bin", "HOME": str(root), "LANG": "C",
           "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"}
    result = subprocess.run(command, cwd=root, env=env, input=input_bytes, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=120, check=False)
    require(result.returncode == 0, "Trusted Git operation failed: " + result.stderr.decode("utf-8", "replace")[-1000:])
    return result.stdout


def collect_patch(control, instance_id, final_workspace, output, stopped=False, excludes=()):
    require(stopped, "Stop and freeze the candidate workspace before collection")
    task_at(control, instance_id)
    directory = Path(control).resolve() / "tasks" / instance_id
    base = scan_tree(directory / "base_repo")
    source = load(directory / "source.json")
    require(sha(json.dumps(tree_manifest(base), sort_keys=True).encode()) == source["base_tree_sha256"],
            "Trusted base tree was modified")
    final = scan_tree(final_workspace)
    ignored = []
    permitted_excludes = tuple(SESSION_EXCLUDES) + tuple(excludes)
    for name in sorted(set(base) | set(final)):
        if base.get(name) == final.get(name):
            continue
        if name.startswith(".zhiqu/"):
            require(any(fnmatch.fnmatchcase(name, pattern) for pattern in SESSION_EXCLUDES),
                    "Protected CLI metadata change refused: " + name)
        if any(fnmatch.fnmatchcase(name, pattern) for pattern in permitted_excludes):
            require(name not in base, "Cannot exclude a change to a baseline file: " + name)
            ignored.append({"path": name, **tree_manifest({name: final[name]})[name]})
            del final[name]
            continue
        require(not name.startswith(".zhiqu/"), "Protected CLI metadata change refused: " + name)
        for entry in (base.get(name), final.get(name)):
            if entry is not None and entry[0] == "file":
                require(len(entry[1]) <= MAX_CHANGED_FILE_BYTES, "Changed file exceeds limit: " + name)
                try:
                    entry[1].decode("utf-8")
                except UnicodeDecodeError:
                    raise ValueError("Changed binary/non-UTF-8 file refused: " + name)
                require(b"\0" not in entry[1], "Changed binary file refused: " + name)
    with tempfile.TemporaryDirectory(prefix="zq-patch-") as temporary:
        work = Path(temporary) / "repo"
        materialize(base, work)
        git_command(work, ["init", "--quiet"])
        git_command(work, ["add", "--all", "--", "."])
        for item in list(work.iterdir()):
            if item.name == ".git":
                continue
            if item.is_symlink() or item.is_file():
                item.unlink()
            else:
                shutil.rmtree(item)
        materialize(final, work)
        added = sorted(set(final) - set(base))
        for offset in range(0, len(added), 128):
            git_command(work, ["add", "--intent-to-add", "--", *added[offset:offset + 128]])
        patch = git_command(work, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--", "."])
        require(len(patch) <= MAX_PATCH_BYTES, "Patch exceeds limit")
        require(b"GIT binary patch" not in patch and b"Binary files " not in patch, "Binary patch refused")
        # Independently apply the patch and compare bytes/modes/link targets;
        # candidate attributes cannot silently hide or transform submitted edits.
        applied = Path(temporary) / "applied"
        materialize(base, applied)
        if patch:
            git_command(applied, ["apply", "--whitespace=nowarn", "-"], patch)
        require(scan_tree(applied) == final, "Collected patch does not reproduce the final source tree")
    output = Path(output).resolve()
    candidate_root = Path(final_workspace).resolve()
    require(output != candidate_root and candidate_root not in output.parents, "Output must be outside candidate workspace")
    output.mkdir(parents=True, exist_ok=True)
    (output / "patch.diff").write_bytes(patch)
    prediction = {"instance_id": instance_id, "model_name_or_path": "zhiqu-cli-deepseek-v4-pro", "model_patch": patch.decode("utf-8")}
    write_json(output / "prediction.json", prediction)
    metadata = {"instance_id": instance_id, "base_tree_sha256": source["base_tree_sha256"],
                "patch_sha256": sha(patch), "patch_bytes": len(patch), "excluded_artifacts": ignored,
                "exclusion_patterns": permitted_excludes, "workspace_stopped": True,
                "final_submitted_tree_sha256": sha(json.dumps(tree_manifest(final), sort_keys=True).encode()),
                "integrity": "passed", "model_calls": 0}
    write_json(output / "collection.json", metadata)
    return {key: metadata[key] for key in ("instance_id", "patch_sha256", "patch_bytes", "integrity")}


def predictions_at(path, ids):
    rows = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    require(len(rows) == len(ids) and {row["instance_id"] for row in rows} == set(ids), "Predictions must contain exactly the fixed task IDs")
    require(all(isinstance(row.get("model_patch"), str) and isinstance(row.get("model_name_or_path"), str) for row in rows),
            "Invalid predictions format")
    return rows


def interpreter(python=None):
    """The harness interpreter as given. Round 69: Path.resolve() turned harness-venv/bin/python into the Homebrew base
    interpreter, which lacks the venv's unidiff/docker, so every official log parse failed and every control and candidate
    integrity read "unverified" -- indistinguishable from a real failure."""
    return os.path.abspath(python or sys.executable)


def harness_command(control, predictions, protocol_file, kind="candidate", python=None):
    control = Path(control).resolve()
    selection = selection_at(control)
    ids = [task["instance_id"] for task in selection["tasks"]]
    predictions_at(predictions, ids)
    protocol = load(protocol_file)
    manifest = load(control / "data-manifest.json")
    require(protocol["dataset"]["revision"] == DATASET_REVISION and protocol["harness"]["commit"] == HARNESS_COMMIT,
            "Protocol source differs from pinned controller assets")
    snapshot = control / "private/dataset.json"
    require(sha(snapshot.read_bytes()) == manifest["private_dataset_sha256"], "Private dataset snapshot changed")
    harness = control / ("SWE-bench-" + HARNESS_COMMIT)
    source_manifest = load(control / "harness-source.json")
    require(source_manifest["commit"] == HARNESS_COMMIT and (harness / "swebench/harness/run_evaluation.py").is_file(),
            "Pinned harness source is not prepared")
    protocol_hash = sha(Path(protocol_file).read_bytes())
    prediction_hash = sha(Path(predictions).read_bytes())
    # Every invocation gets a unique suffix, even a re-grade of identical bytes,
    # because upstream caches by run_id rather than by patch content.
    nonce = os.urandom(5).hex()
    run_id = "zhiqu-" + kind + "-" + protocol_hash[:12] + "-" + prediction_hash[:12] + "-" + nonce
    # Absolute but NOT resolved: a venv interpreter is a symlink, and resolving it runs the base Python without the venv's packages.
    command = [interpreter(python), "-m", "swebench.harness.run_evaluation",
               "--dataset_name", str(snapshot), "--split", "test", "--predictions_path", str(Path(predictions).resolve()),
               "--instance_ids", *ids, "--max_workers", str(protocol["limits"]["grading_concurrency"]),
               "--timeout", str(protocol["limits"]["official_grader_seconds"]), "--run_id", run_id]
    return {"argv": command, "cwd": str(control), "env_overrides": {"PYTHONPATH": str(harness)},
            "run_id": run_id, "dataset_sha256": manifest["private_dataset_sha256"],
            "protocol_sha256": protocol_hash, "predictions_sha256": prediction_hash,
            "executes_model": False, "requires_working_docker": True,
            "requires_container_isolation_adapter": True,
            "safe_to_execute_unwrapped": False}


def parse_observed_status(control, row, log_path, python=None):
    harness = Path(control).resolve() / ("SWE-bench-" + HARNESS_COMMIT)
    command = [interpreter(python), str(Path(__file__).resolve()),
               "parse-log", "--harness-root", str(harness), "--log", str(Path(log_path).resolve())]
    result = subprocess.run(command, input=json.dumps(row).encode("utf-8"), stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=120, check=False)
    require(result.returncode == 0, "Official log parser could not run; fix its pinned Python dependencies")
    parsed = json.loads(result.stdout)
    require(parsed.get("found") is True and isinstance(parsed.get("statuses"), dict), "Actual test execution markers missing")
    return parsed["statuses"]


def validate_reports(control, reports_dir, kind="candidate", status_reader=None, python=None):
    selection = selection_at(control)
    dataset = load(Path(control) / "private/dataset.json")
    by_id = {row["instance_id"]: row for row in dataset}
    reports = {}
    for path in Path(reports_dir).rglob("report.json"):
        data = load(path)
        for instance_id, report in data.items():
            if instance_id in by_id:
                require(instance_id not in reports, "Duplicate official report for task")
                reports[instance_id] = (report, path)
    results = []
    for task in selection["tasks"]:
        instance_id = task["instance_id"]
        entry = reports.get(instance_id)
        if entry is None:
            results.append({"instance_id": instance_id, "official_resolved": None, "status": "missing_official_report", "integrity": "unverified"})
            continue
        report, path = entry
        require(isinstance(report.get("resolved"), bool), "Official resolved must be boolean")
        statuses = report.get("tests_status", {})
        f2p = statuses.get("FAIL_TO_PASS", {})
        p2p = statuses.get("PASS_TO_PASS", {})
        successes = set(f2p.get("success", [])) | set(p2p.get("success", []))
        failures = set(f2p.get("failure", [])) | set(p2p.get("failure", []))
        expected = set(expected_tests(by_id[instance_id], "FAIL_TO_PASS")) | set(expected_tests(by_id[instance_id], "PASS_TO_PASS"))
        try:
            actual = (status_reader(by_id[instance_id], path.parent / "test_output.txt") if status_reader
                      else parse_observed_status(control, by_id[instance_id], path.parent / "test_output.txt", python))
            observed = set(actual)
            integrity = "passed" if expected <= observed else "expected_tests_unobserved"
        except (OSError, ValueError, subprocess.SubprocessError):
            actual = {}
            integrity = "actual_test_execution_unverified"
        if kind == "gold":
            require(report["resolved"] and expected <= successes and not (expected & failures)
                    and integrity == "passed" and all(actual[name] in ("PASSED", "XFAIL") for name in expected),
                    "Gold control failed or its actual tests were not observed passing")
        elif kind == "baseline":
            required_failures = {name for name in expected_tests(by_id[instance_id], "FAIL_TO_PASS")
                                 if actual.get(name) == "FAILED"}
            p2p_passed = all(actual.get(name) in ("PASSED", "XFAIL")
                             for name in expected_tests(by_id[instance_id], "PASS_TO_PASS"))
            require(not report["resolved"] and required_failures and integrity == "passed" and p2p_passed,
                    "Baseline control did not execute expected failing tests with regressions intact")
        results.append({"instance_id": instance_id, "official_resolved": report["resolved"], "status": "graded",
                        "integrity": integrity})
    complete = all(row["official_resolved"] is not None for row in results)
    valid_ability_report = complete and all(row["integrity"] == "passed" for row in results)
    require(kind == "candidate" or complete, "Control missing official reports")
    rate = sum(row["official_resolved"] is True for row in results) / 10
    return {"kind": kind, "denominator": 10, "resolved": sum(row["official_resolved"] is True for row in results),
            "official_rate": rate if complete else None, "ability_rate": rate if valid_ability_report else None,
            "valid_ability_report": valid_ability_report,
            "status": "graded" if valid_ability_report else "integrity_unverified" if complete else "infrastructure_incomplete", "results": results,
            "integrity_separate_from_official_resolved": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    data = sub.add_parser("prepare-data")
    data.add_argument("--parquet", required=True)
    data.add_argument("--pyarrow-path")
    data.add_argument("--selection", required=True)
    data.add_argument("--protocol", required=True)
    source = sub.add_parser("fetch-base")
    source.add_argument("--instance-id", required=True)
    source.add_argument("--archive")
    collect = sub.add_parser("collect-patch")
    collect.add_argument("--instance-id", required=True)
    collect.add_argument("--final-workspace", required=True)
    collect.add_argument("--workspace-stopped", action="store_true")
    collect.add_argument("--output-dir", required=True)
    collect.add_argument("--exclude", action="append", default=[])
    harness = sub.add_parser("harness-command")
    harness.add_argument("--predictions", required=True)
    harness.add_argument("--protocol", required=True)
    harness.add_argument("--kind", choices=("candidate", "gold", "baseline"), default="candidate")
    harness.add_argument("--python")
    validate = sub.add_parser("validate-reports")
    validate.add_argument("--reports-dir", required=True)
    validate.add_argument("--kind", choices=("candidate", "gold", "baseline"), default="candidate")
    validate.add_argument("--python", help="Pinned harness interpreter with installed parser dependencies")
    parsed_log = sub.add_parser("parse-log", help=argparse.SUPPRESS)
    parsed_log.add_argument("--harness-root", required=True)
    parsed_log.add_argument("--log", required=True)
    for command in (data, source, collect, harness, validate):
        command.add_argument("--control-dir", required=True)
    args = parser.parse_args()
    if args.operation == "prepare-data":
        result = prepare_data(args.parquet, args.pyarrow_path, args.selection, args.protocol, args.control_dir)
    elif args.operation == "fetch-base":
        result = fetch_base(args.control_dir, args.instance_id, args.archive)
    elif args.operation == "collect-patch":
        result = collect_patch(args.control_dir, args.instance_id, args.final_workspace, args.output_dir,
                               args.workspace_stopped, args.exclude)
    elif args.operation == "harness-command":
        result = harness_command(args.control_dir, args.predictions, args.protocol, args.kind, args.python)
    elif args.operation == "validate-reports":
        result = validate_reports(args.control_dir, args.reports_dir, args.kind, python=args.python)
    else:
        sys.path.insert(0, str(Path(args.harness_root).resolve()))
        from swebench.harness.grading import get_logs_eval
        from swebench.harness.test_spec.test_spec import make_test_spec
        row = json.loads(sys.stdin.buffer.read())
        statuses, found = get_logs_eval(make_test_spec(row), args.log)
        result = {"statuses": statuses, "found": found}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, ImportError, subprocess.SubprocessError) as exc:
        # No hidden fields or candidate stdout are printed in success summaries.
        print("Repository controller refused: " + str(exc), file=sys.stderr)
        sys.exit(2)
