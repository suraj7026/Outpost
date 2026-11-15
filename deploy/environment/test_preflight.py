"""Synthetic preflight checks; never contact the owner's machines."""
from __future__ import annotations

import importlib.util
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("outpost_inspect", Path(__file__).with_name("preflight.py"))
assert SPEC and SPEC.loader
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


class InspectionTests(unittest.TestCase):
    """Exercise conservative inventory and bounded loopback discovery."""

    def test_os_metadata_is_read_not_executed(self) -> None:
        """Shell content in os-release must remain inert text."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "etc").mkdir()
            marker = root / "must-not-exist"
            (root / "etc/os-release").write_text(f'ID="ubuntu"\nVERSION_ID="$(touch {marker})"\n')
            self.assertEqual(preflight.os_release(root / "etc/os-release")["ID"], "ubuntu")
            self.assertFalse(marker.exists())

    def test_existing_paths_and_container_markers_are_never_hidden(self) -> None:
        """Known deployment/data paths force review at the native planning layer."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("etc/rancher/k3s", "var/lib/outpost", "srv/remotejobs/pi-workspace", "proc"):
                (root / name).mkdir(parents=True)
            (root / "opt").mkdir()
            (root / "opt/outpost").symlink_to(root / "missing-release")
            (root / ".dockerenv").touch()
            (root / "proc/meminfo").write_text("MemTotal: 4194304 kB\n")
            result = preflight.inspect(root)
            self.assertEqual(len(result["markers"]), 4)
            self.assertTrue(result["container"])
            self.assertEqual(result["memoryBytes"], 4 * 1024 ** 3)
            self.assertEqual(result["api"], "not_probed")
            self.assertEqual(result["sudo"], "not_available")

    def test_loopback_response_is_bounded_and_redirects_are_not_followed(self) -> None:
        """An occupied port is not treated as absence, even for malformed APIs."""
        for status, body, expected in (
            (200, json.dumps({"protocolVersion": 2, "environmentId": "fixture", "runtime": {"release": "test"}}).encode(), "environment"),
            (200, b"x" * 40000, "ambiguous"),
            (200, b"not-json", "legacy_or_other"),
            (302, b"", "legacy_or_other"),
            (404, b"{}", "legacy_or_other"),
        ):
            class Handler(BaseHTTPRequestHandler):
                """Serve only a disposable loopback response."""
                def do_GET(self, status: int = status, body: bytes = body) -> None:
                    self.send_response(status)
                    if status == 302:
                        self.send_header("Location", "http://192.0.2.1/never-contact")
                    self.end_headers()
                    self.wfile.write(body)

                def log_message(self, *args) -> None:
                    """Do not print fixture request logs."""
            server = HTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                self.assertEqual(preflight.descriptor(server.server_port)[0], expected)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
