import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from benchmark import RunnerProcess


ROOT = Path(__file__).resolve().parents[2]


def make_pdf(path: Path, text: str = "Zhiqu PDF parser evaluation") -> None:
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, body in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii") + body + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii"))
    path.write_bytes(output)


class RunnerContractTest(unittest.TestCase):
    def generate_fixture(self, kind: str, path: Path):
        jar = ROOT / "pdfbox-runner/target/pdfbox-runner-all.jar"
        completed = subprocess.run(["java", "-cp", str(jar),
                                    "com.zhiqu.pdfeval.pdfbox.PdfFixtureGenerator", kind, str(path)],
                                   capture_output=True, timeout=30)
        self.assertEqual(0, completed.returncode, completed.stderr.decode("utf-8", errors="replace"))

    def invoke(self, jar: Path, requests: list[dict]) -> list[dict]:
        process = subprocess.Popen(["java", "-Xmx1024m", "-Dfile.encoding=UTF-8",
                                    "-Dsun.stdout.encoding=UTF-8", "-Dsun.stderr.encoding=UTF-8", "-jar", str(jar)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=False)
        payload = "".join(json.dumps(request) + "\n" for request in requests).encode("utf-8")
        stdout, stderr = process.communicate(payload, timeout=90)
        self.assertEqual(0, process.returncode, stderr[-2000:].decode("utf-8", errors="replace"))
        return [json.loads(line) for line in stdout.decode("utf-8").splitlines() if line.strip()]

    def check_runner(self, jar: Path, expected_engine: str):
        if not jar.is_file():
            self.skipTest(f"runner not built: {jar}")
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / "sample.pdf"
            make_pdf(pdf)
            request = {"requestId": "contract", "input": str(pdf), "maxPages": 200,
                       "maxOutputChars": 500000, "maxFileBytes": 20 * 1024 * 1024}
            result = self.invoke(jar, [request])[0]
            self.assertEqual(expected_engine, result["engine"])
            self.assertIsNone(result["error"])
            self.assertEqual(1, result["pageCount"])
            self.assertIn("Zhiqu", result["text"] or result["markdown"])
            self.assertEqual(64, len(result["fileHash"]))

    def test_pdfbox_runner(self):
        self.check_runner(ROOT / "pdfbox-runner/target/pdfbox-runner-all.jar", "PDFBOX")

    def test_opendataloader_runner(self):
        self.check_runner(ROOT / "opendataloader-runner/target/opendataloader-runner-all.jar", "OPENDATALOADER")

    def test_safety_contract_for_both_runners(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixtures = {kind: root / f"{kind}.pdf" for kind in ("blank", "two-page", "encrypted", "long")}
            for kind, path in fixtures.items():
                self.generate_fixture(kind, path)
            malformed = root / "malformed.pdf"
            malformed.write_bytes(b"not a PDF")
            oversized = root / "oversized.pdf"
            with oversized.open("wb") as stream:
                stream.seek(20 * 1024 * 1024)
                stream.write(b"x")
            requests = [
                {"requestId": "blank", "input": str(fixtures["blank"]), "maxPages": 200,
                 "maxOutputChars": 500000, "maxFileBytes": 20 * 1024 * 1024},
                {"requestId": "pages", "input": str(fixtures["two-page"]), "maxPages": 1,
                 "maxOutputChars": 500000, "maxFileBytes": 20 * 1024 * 1024},
                {"requestId": "encrypted", "input": str(fixtures["encrypted"]), "maxPages": 200,
                 "maxOutputChars": 500000, "maxFileBytes": 20 * 1024 * 1024},
                {"requestId": "malformed", "input": str(malformed), "maxPages": 200,
                 "maxOutputChars": 500000, "maxFileBytes": 20 * 1024 * 1024},
                {"requestId": "oversized", "input": str(oversized), "maxPages": 200,
                 "maxOutputChars": 500000, "maxFileBytes": 20 * 1024 * 1024},
                {"requestId": "truncated", "input": str(fixtures["long"]), "maxPages": 200,
                 "maxOutputChars": 10, "maxFileBytes": 20 * 1024 * 1024},
            ]
            for jar in (ROOT / "pdfbox-runner/target/pdfbox-runner-all.jar",
                        ROOT / "opendataloader-runner/target/opendataloader-runner-all.jar"):
                with self.subTest(jar=jar.name):
                    results = {row["requestId"]: row for row in self.invoke(jar, requests)}
                    self.assertTrue(results["blank"]["needsOcr"])
                    self.assertIsNotNone(results["pages"]["error"])
                    self.assertIsNotNone(results["encrypted"]["error"])
                    self.assertIsNotNone(results["malformed"]["error"])
                    self.assertIn("maxFileBytes", results["oversized"]["error"])
                    self.assertTrue(results["truncated"]["truncated"])

    def test_supervisor_timeout_terminates_runner(self):
        jar = ROOT / "pdfbox-runner/target/pdfbox-runner-all.jar"
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / "sample.pdf"
            make_pdf(pdf)
            runner = RunnerProcess(jar)
            try:
                with self.assertRaises(TimeoutError):
                    runner.run({"requestId": "timeout", "input": str(pdf), "maxPages": 200,
                                "maxOutputChars": 500000, "maxFileBytes": 20 * 1024 * 1024}, 0)
            finally:
                runner.close()


if __name__ == "__main__":
    unittest.main()
