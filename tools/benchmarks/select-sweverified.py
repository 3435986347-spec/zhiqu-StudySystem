#!/usr/bin/env python3
"""Select a deterministic, public-only 10-task SWE-bench Verified pilot.

No network calls, models, candidate execution or Docker. The caller downloads
the pinned official parquet and metadata. Only four public parquet columns are
decoded; hidden patches, test patches and F2P/P2P fields are never projected.
"""

import argparse
import collections
import hashlib
import json
from pathlib import Path
import re
import sys

DATASET = "princeton-nlp/SWE-bench_Verified"
REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a"
FILE = "data/test-00000-of-00001.parquet"
PARQUET_SHA256 = "a45b1fe4e2f0c8390b2b2938ac83e92ed5979000856808f3679c07812e9e6dcd"
PARQUET_BYTES = 2096679
PUBLIC_FIELDS = ["repo", "instance_id", "base_commit", "problem_statement"]
REPOS = ["django/django", "sympy/sympy", "pytest-dev/pytest", "psf/requests", "scikit-learn/scikit-learn"]
SALT = "zhiqu-sweverified-v1\n"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def select_rows(rows):
    require(len(rows) == 500, "Expected exactly 500 SWE-bench Verified test rows")
    ids = set()
    groups = collections.defaultdict(list)
    for row in rows:
        require(set(row) == set(PUBLIC_FIELDS), "Projection must contain exactly the four public fields")
        require(all(isinstance(row[field], str) for field in PUBLIC_FIELDS), "All public fields must be strings")
        repo = row["repo"]
        require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) is not None, "Invalid repository format")
        instance_id = row["instance_id"]
        require(re.fullmatch(re.escape(repo.replace("/", "__")) + r"-[0-9]+", instance_id) is not None,
                "Invalid instance_id format: " + instance_id)
        require(instance_id not in ids, "Duplicate instance_id: " + instance_id)
        ids.add(instance_id)
        require(re.fullmatch(r"[0-9a-f]{40}", row["base_commit"]) is not None,
                "Invalid base_commit format: " + instance_id)
        require(row["problem_statement"].strip(), "Empty problem_statement: " + instance_id)
        groups[repo].append(row)
    selected = []
    for repo in REPOS:
        require(len(groups[repo]) >= 2, "Fewer than two available tasks for " + repo)
        selected.extend(sorted(groups[repo], key=lambda row: (sha((SALT + row["instance_id"]).encode("utf-8")),
                                                             row["instance_id"]))[:2])
    require(len(selected) == 10 and len({row["instance_id"] for row in selected}) == 10, "Invalid pilot selection")
    return selected, dict(sorted((repo, len(group)) for repo, group in groups.items()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parquet", type=Path, required=True)
    parser.add_argument("--dataset-meta", type=Path, required=True)
    parser.add_argument("--data-tree", type=Path, required=True, help="Official HF tree response for the pinned revision/data directory")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--pyarrow-path", type=Path, help="Optional isolated temporary pip --target directory")
    args = parser.parse_args()
    if args.pyarrow_path:
        sys.path.insert(0, str(args.pyarrow_path.resolve()))
    import pyarrow
    import pyarrow.parquet as pq
    require(pyarrow.__version__ == "20.0.0", "Parser must be pinned pyarrow 20.0.0")
    meta = load(args.dataset_meta)
    require(meta.get("id") == DATASET and meta.get("sha") == REVISION, "Dataset identity or revision mismatch")
    split = meta["cardData"]["dataset_info"]["splits"]
    require(len(split) == 1 and split[0]["name"] == "test" and split[0]["num_examples"] == 500,
            "Official metadata must declare one 500-row test split")
    entries = [entry for entry in load(args.data_tree) if entry.get("path") == FILE]
    require(len(entries) == 1, "Official file-tree entry missing or duplicated")
    entry = entries[0]
    parquet_bytes = args.parquet.read_bytes()
    parquet_sha = sha(parquet_bytes)
    require(entry["size"] == len(parquet_bytes) == entry["lfs"]["size"] == PARQUET_BYTES,
            "Parquet byte count differs from pinned official metadata")
    require(entry["lfs"]["oid"] == parquet_sha == PARQUET_SHA256,
            "Parquet SHA-256 differs from pinned official LFS OID")
    require(pq.ParquetFile(args.parquet).metadata.num_rows == 500, "Parquet row count is not 500")
    # Security contract: no read without columns, no table/schema dump, and no
    # projection of patch, test_patch, FAIL_TO_PASS or PASS_TO_PASS values.
    table = pq.read_table(args.parquet, columns=PUBLIC_FIELDS)
    require(table.column_names == PUBLIC_FIELDS, "Unexpected decoded columns")
    rows = table.to_pylist()
    selected, counts = select_rows(rows)
    public_index = "".join(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
                           for row in sorted(rows, key=lambda row: row["instance_id"]))
    tasks = [{"repo": row["repo"], "instance_id": row["instance_id"], "base_commit": row["base_commit"],
              "problem_statement_sha256": sha(row["problem_statement"].encode("utf-8")),
              "selection_sha256": sha((SALT + row["instance_id"]).encode("utf-8"))} for row in selected]
    projection = "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in selected)
    metadata = {"dataset": DATASET, "revision": REVISION, "split": "test", "dataset_rows": 500,
                "repository_counts": counts, "selection": {"version": "zhiqu-sweverified-v1", "tasks": 10,
                    "per_repository": 2, "repositories_in_order": REPOS, "hash_input_prefix": SALT,
                    "encoding": "UTF-8", "sort": "SHA256(hash_input_prefix + instance_id) ascending within each repository; instance_id breaks ties"},
                "source": {"url": "https://huggingface.co/datasets/" + DATASET + "/resolve/" + REVISION + "/" + FILE,
                    "parquet_sha256": parquet_sha, "parquet_bytes": len(parquet_bytes), "official_lfs_oid": entry["lfs"]["oid"],
                    "dataset_metadata_sha256": sha(args.dataset_meta.read_bytes()), "official_data_tree_sha256": sha(args.data_tree.read_bytes())},
                "parser": {"name": "pyarrow", "version": pyarrow.__version__,
                    "dependency_install": "isolated temporary target; no global installation" if args.pyarrow_path else "existing installation",
                    "decoded_columns": PUBLIC_FIELDS}, "public_projection_sha256": sha(projection.encode("utf-8")),
                "public_index_sha256": sha(public_index.encode("utf-8")),
                "public_index_hash_format": "500 public rows sorted by instance_id; compact sorted-key UTF-8 JSON + LF per row",
                "selector_sha256": sha(Path(__file__).read_bytes()),
                "tasks": tasks, "model_calls": 0, "docker_used": False}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "selection-metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (args.output_dir / "public-tasks.jsonl").write_text(projection, encoding="utf-8")
    print(json.dumps({"dataset_rows": 500, "repository_counts": counts, "selected_ids": [row["instance_id"] for row in selected],
                      "parquet_sha256": parquet_sha, "output_dir": str(args.output_dir.resolve())}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, ImportError) as exc:
        print("Selection refused: " + str(exc), file=sys.stderr)
        sys.exit(2)
