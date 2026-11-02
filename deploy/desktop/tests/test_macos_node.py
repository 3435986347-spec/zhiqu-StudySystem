#!/usr/bin/env python3
"""Exercise the actual macOS Node preflight with real Mach-O executables.

Run from any directory:
    python3 deploy/desktop/tests/test_macos_node.py -v

The official-runtime case reuses the archive downloaded by the packaging helper;
the tests never download anything or launch the desktop application. Set
ZHIQU_NODE_HELPER to test a mutation copy outside the source tree.
"""

import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
HELPER = Path(os.environ.get(
    "ZHIQU_NODE_HELPER", str(ROOT / "deploy/desktop/prepare-macos-node.sh")
)).resolve()
ARCHIVE_NAME = "node-v22.23.2-darwin-arm64.tar.gz"
OFFICIAL_ARCHIVE = Path(os.environ.get(
    "ZHIQU_NODE_ARCHIVE", str(ROOT / "build/node-runtime" / ARCHIVE_NAME)
)).resolve()


@unittest.skipUnless(platform.system() == "Darwin", "requires real macOS Mach-O tools")
class MacosNodePreflightTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture_temp = tempfile.TemporaryDirectory(prefix="zhiqu-node-fixtures-")
        cls.addClassCleanup(cls.fixture_temp.cleanup)
        cls.fixtures = Path(cls.fixture_temp.name)
        cls.valid = cls.compile_node("正常 node 路径", "arm64", "13.0")
        cls.new_os = cls.compile_node("new-os", "arm64", "14.0")
        cls.new_minor_os = cls.compile_node("new-minor-os", "arm64", "13.1")
        cls.intel = cls.compile_node("intel", "x86_64", "13.0")
        cls.old_node = cls.compile_node("old-node", "arm64", "13.0", "v18.16.1")
        cls.external = cls.compile_node("external", "arm64", "13.0", external=True)

    @classmethod
    def compile_node(cls, name, arch, min_os, version="v22.23.2", external=False):
        directory = cls.fixtures / name
        (directory / "bin").mkdir(parents=True)
        (directory / "LICENSE").write_text("synthetic test fixture\n")
        source = directory / "node.c"
        source.write_text(
            '#include <stdio.h>\n'
            + ('extern const char *fixture_version(void);\n' if external else '')
            + 'int main(void) { puts('
            + ('fixture_version()' if external else '"' + version + '"')
            + '); return 0; }\n'
        )
        compiler = ["/usr/bin/xcrun", "clang", "-target", f"{arch}-apple-macos{min_os}"]
        extra = []
        if external:
            library_source = directory / "library.c"
            library_source.write_text(
                'const char *fixture_version(void) { return "' + version + '"; }\n'
            )
            subprocess.run(
                compiler + ["-dynamiclib", str(library_source),
                            "-Wl,-install_name,@rpath/libfixture.dylib",
                            "-o", str(directory / "libfixture.dylib")],
                check=True, capture_output=True, text=True,
            )
            extra = ["-L", str(directory), "-lfixture", f"-Wl,-rpath,{directory}"]
        binary = directory / "bin/node"
        subprocess.run(compiler + [str(source), "-o", str(binary)] + extra,
                       check=True, capture_output=True, text=True)
        return binary

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="zhiqu-node-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.cache = self.directory / "cache"
        self.stubs = self.directory / "commands"
        self.stubs.mkdir()
        self.curl_log = self.directory / "curl-called"
        self.path_node_log = self.directory / "path-node-called"
        self.write_command("curl", 'printf called > "$TEST_CURL_LOG"\nexit 22\n')
        self.write_command("node", 'printf called > "$TEST_PATH_NODE_LOG"\nprintf "v22.23.2\\n"\n')

    def write_command(self, name, body):
        script = self.stubs / name
        script.write_text("#!/bin/bash\nset -eu\n" + body)
        script.chmod(0o755)

    def run_helper(self, node=None):
        environment = os.environ.copy()
        for name in ("NODE_BIN", "NODE_OPTIONS", "DYLD_LIBRARY_PATH",
                     "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES"):
            environment.pop(name, None)
        environment.update({
            "PATH": str(self.stubs) + os.pathsep + environment.get("PATH", ""),
            "TEST_CURL_LOG": str(self.curl_log),
            "TEST_PATH_NODE_LOG": str(self.path_node_log),
            "TEST_DOWNLOAD_ARCHIVE": str(self.directory / "fake-node.tar.gz"),
        })
        if node is not None:
            environment["NODE_BIN"] = str(node)
        return subprocess.run(["/bin/bash", str(HELPER), str(self.cache)],
                              env=environment, text=True, capture_output=True, timeout=30)

    def assert_rejected(self, result, reason):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(reason, result.stderr, "must reject for the intended reason")

    def make_wrong_checksum_archive(self, destination):
        # Keep the tar layout and Mach-O runtime valid: bypassing SHA256 must
        # actually accept this archive, rather than fail later while extracting.
        distribution = ARCHIVE_NAME.removesuffix(".tar.gz")
        with tarfile.open(destination, "w:gz") as archive:
            archive.add(self.valid, arcname=f"{distribution}/bin/node")
            archive.add(self.valid.parent.parent / "LICENSE",
                        arcname=f"{distribution}/LICENSE")

    def test_explicit_portable_node_with_spaces_and_chinese_is_accepted(self):
        result = self.run_helper(self.valid)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.strip(), str(self.valid.resolve()))
        self.assertFalse(self.curl_log.exists(), "explicit NODE_BIN must not download anything")

    def test_missing_explicit_node_does_not_fall_back_to_path(self):
        result = self.run_helper(self.directory / "missing/bin/node")
        self.assert_rejected(result, "NODE_BIN")
        self.assertFalse(self.path_node_log.exists(), "bad NODE_BIN must not fall back to PATH")
        self.assertFalse(self.curl_log.exists(), "bad NODE_BIN must not trigger a download")

    def test_runnable_node_with_external_library_is_rejected(self):
        # This binary runs on its build machine, exactly like Homebrew Node,
        # while its @rpath dependency would be absent after copying just node.
        original = subprocess.run([str(self.external), "--version"], check=True,
                                  capture_output=True, text=True)
        self.assertEqual(original.stdout.strip(), "v22.23.2")
        self.assert_rejected(self.run_helper(self.external), "@rpath/libfixture.dylib")

    def test_node_requiring_newer_macos_is_rejected(self):
        self.assert_rejected(self.run_helper(self.new_os), "macOS 14.0")

    def test_node_requiring_newer_minor_macos_is_rejected(self):
        self.assert_rejected(self.run_helper(self.new_minor_os), "macOS 13.1")

    def test_intel_only_node_is_rejected(self):
        self.assert_rejected(self.run_helper(self.intel), "ARM64")

    def test_node_older_than_18_17_is_rejected(self):
        self.assert_rejected(self.run_helper(self.old_node), "18.17")

    def test_corrupt_cache_and_failed_download_do_not_fall_back_to_path(self):
        self.cache.mkdir()
        self.make_wrong_checksum_archive(self.cache / ARCHIVE_NAME)
        result = self.run_helper()
        self.assert_rejected(result, "下载失败")
        self.assertTrue(self.curl_log.exists(), "damaged archive must be replaced by a verified download")
        self.assertFalse(self.path_node_log.exists(), "must not silently bundle PATH node")
        self.assertFalse(list(self.cache.glob("*/bin/node")), "failed download left a usable-looking runtime")

    def test_downloaded_bytes_with_wrong_checksum_are_rejected(self):
        self.make_wrong_checksum_archive(self.directory / "fake-node.tar.gz")
        self.write_command("curl", '''printf called > "$TEST_CURL_LOG"
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) shift; output="$1" ;;
  esac
  shift
done
[ -n "$output" ]
cp "$TEST_DOWNLOAD_ARCHIVE" "$output"
''')
        result = self.run_helper()
        self.assert_rejected(result, "SHA256")
        self.assertTrue(self.curl_log.exists())
        self.assertFalse((self.cache / ARCHIVE_NAME).exists(), "unverified archive entered the cache")
        self.assertFalse(list(self.cache.glob("*/bin/node")))

    @unittest.skipUnless(OFFICIAL_ARCHIVE.is_file(), "run the packaging helper once to cache the official archive")
    def test_verified_official_cache_is_offline_and_runtime_is_relocatable(self):
        self.cache.mkdir()
        shutil.copyfile(OFFICIAL_ARCHIVE, self.cache / ARCHIVE_NAME)
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.curl_log.exists(), "verified cache must support offline packaging")
        chosen = Path(result.stdout.strip())
        self.assertTrue(chosen.is_file(), "helper stdout must be the chosen Node executable")
        self.assertTrue((chosen.parent.parent / "LICENSE").is_file(), "official runtime must carry its license")
        relocated = self.directory / "搬移后的应用 有空格/bin/node"
        relocated.parent.mkdir(parents=True)
        shutil.copy2(chosen, relocated)
        smoke = subprocess.run([
            str(relocated), "--input-type=module", "-e",
            'import {spawnSync} from "node:child_process"; '
            'import {createHash} from "node:crypto"; '
            'const child=spawnSync(process.execPath,["-p","6*7"],{encoding:"utf8"}); '
            'if(child.status!==0||child.stdout.trim()!=="42")process.exit(3); '
            'console.log(process.version+" "+createHash("sha256").update("ok").digest("hex"));'
        ], text=True, capture_output=True, timeout=30)
        self.assertEqual(smoke.returncode, 0, smoke.stdout + smoke.stderr)
        self.assertTrue(smoke.stdout.startswith("v22.23.2 "), smoke.stdout)


if __name__ == "__main__":
    unittest.main()
