#!/usr/bin/env python3
"""Run the pinned official SWE-bench harness with the official x86_64 images on Apple Silicon.

The harness picks arm64 images on an arm64 host (and then has to build them locally, which the
SWE-bench docs still call experimental). The user chose (2026-10-16) to grade with the official
prebuilt `swebench/sweb.eval.x86_64.*` images under Docker Desktop's Rosetta emulation instead.

This wrapper changes exactly one thing, in this process only: `platform.machine()` reports
`x86_64`, so `make_test_spec` selects arch x86_64 and the official remote image keys. The pinned
harness source is not edited; every other argument and behaviour is the upstream `run_evaluation`.

Usage: the same arguments as `python -m swebench.harness.run_evaluation`, with PYTHONPATH pointing
at the pinned harness checkout (prepare-repository-eval.py harness-command gives both).
"""

import platform
import runpy
import sys


def force_x86_64():
    platform.machine = lambda: "x86_64"


def main(argv):
    force_x86_64()
    sys.argv = ["swebench.harness.run_evaluation", *argv]
    runpy.run_module("swebench.harness.run_evaluation", run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main(sys.argv[1:])
