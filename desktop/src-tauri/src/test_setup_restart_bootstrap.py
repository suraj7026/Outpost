"""Local-only bootstrap contract tests: no SSH, sudo, host inspection, or cleanup.

Run with python3 -B -m unittest -v test_setup_restart_bootstrap from this directory.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest

import setup_restart_bootstrap as bootstrap
import setup_restart_helper as helper

BOOTSTRAP = Path(bootstrap.__file__).read_bytes()
CANARY = "bootstrap-private-body-canary"
ECHO = '''import signal, sys
assert __name__ == "__main__"
assert sys.argv == ["-c"]
assert sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode
assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)
label = "π — 鍵 🔒"
assert label.encode("utf-8") != label.encode("ascii", "ignore")
sys.stdout.buffer.write(sys.stdin.buffer.read())'''.encode("utf-8")


def arguments(source: bytes, metadata: list[str] | None = None) -> list[str]:
    """Use the exact native -c wrapper; source and request never enter argv."""
    encoded = base64.b64encode(BOOTSTRAP).decode("ascii")
    code = ('import base64;exec(compile(base64.b64decode("' + encoded
            + '"),"<outpost-restart-bootstrap>","exec"))')
    if metadata is None:
        metadata = [str(len(source)), hashlib.sha256(source).hexdigest()]
    return [sys.executable, "-I", "-B", "-S", "-c", code, *metadata]


def execute(source: bytes, frame: bytes | None = None,
            metadata: list[str] | None = None) -> subprocess.CompletedProcess[bytes]:
    """Run only a synthetic in-memory helper through the real production bootstrap."""
    return subprocess.run(arguments(source, metadata), input=source if frame is None else frame,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False)


class TestBootstrap(unittest.TestCase):
    """Prove framing and authentication before any helper code is executed."""

    def assert_refused(self, result: subprocess.CompletedProcess[bytes]) -> None:
        """All loader failures have one fixed diagnostic and no traceback or source body."""
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, bootstrap.FAILURE.encode("ascii"))
        self.assertNotIn(CANARY.encode(), result.stderr)

    def test_unicode_prefix_and_packet_preserved_without_a_delimiter(self) -> None:
        """Byte length, not character count; JSON may already be in Python's input buffer."""
        self.assertGreater(len(ECHO), len(ECHO.decode("utf-8")))
        for packet in [b'{"mode":"status"}\n', b'{}' + b' ' * 16382, b'{}' + b' ' * 16383]:
            with self.subTest(size=len(packet)):
                result = execute(ECHO, ECHO + packet)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout, packet)
                self.assertEqual(result.stderr, b"")

    def test_same_buffer_survives_password_line_and_prefetched_packet(self) -> None:
        """Model sudo's line consumption without credentials or a sudo process."""
        packet = b'{"mode":"status","canary":"packet-only"}\n'
        stream = io.BufferedReader(io.BytesIO(b"synthetic-password\n" + ECHO + packet))
        self.assertEqual(stream.readline(), b"synthetic-password\n")
        source = bootstrap.read_verified_source(stream, len(ECHO), hashlib.sha256(ECHO).hexdigest())
        self.assertEqual(source, ECHO)
        self.assertEqual(stream.read(), packet)

    def test_wrong_hash_truncated_source_and_shifted_boundaries_do_not_execute(self) -> None:
        """Even an executable unverified prefix must not reach its first statement."""
        source = ('print("' + CANARY + '")\n').encode()
        for frame, metadata in [
            (source, [str(len(source)), "0" * 64]),
            (source[:-1], None),
            (source[:-1] + b'{}', None),
            (b"X" + source[1:] + b'{}', None),
            (source + b'{}', [str(len(source) - 1), hashlib.sha256(source).hexdigest()]),
            (source + b'{}', [str(len(source.decode()) - 1), hashlib.sha256(source).hexdigest()]),
        ]:
            with self.subTest(metadata=metadata):
                self.assert_refused(execute(source, frame, metadata))

    def test_metadata_is_bounded_and_exact(self) -> None:
        """Reject invalid lengths and hashes before reading or allocating a source body."""
        digest = hashlib.sha256(ECHO).hexdigest()
        for metadata in [
            [], [str(len(ECHO))], [str(len(ECHO)), digest, "extra"],
            ["0", digest], ["-1", digest], ["+1", digest], ["01", digest],
            ["١", digest], ["9" * 1000, digest], [str(bootstrap.MAX_HELPER_BYTES + 1), digest],
            [str(len(ECHO)), digest.upper()], [str(len(ECHO)), "z" * 64],
            [str(len(ECHO)), "a" * 63], [str(len(ECHO)), "a" * 65],
        ]:
            with self.subTest(metadata=metadata):
                self.assert_refused(execute(ECHO, b"", metadata))
        result = subprocess.run([sys.executable, "-B", "-S", *arguments(ECHO)[4:]],
                                input=ECHO, capture_output=True, timeout=5, check=False)
        self.assert_refused(result)

    def test_compile_and_runtime_exception_bodies_are_not_disclosed(self) -> None:
        """No raw SyntaxError source line, exception text, or string SystemExit escapes."""
        for source in [
            ('print("' + CANARY + '")\ninvalid syntax ???').encode(),
            ('raise ValueError("' + CANARY + '")').encode(),
            ('raise SystemExit("' + CANARY + '")').encode(),
            b"\xff\xfe" + CANARY.encode(),
        ]:
            self.assert_refused(execute(source))
        for code in [0, 1, 7]:
            result = execute(f"raise SystemExit({code})".encode())
            self.assertEqual(result.returncode, code)
            self.assertEqual(result.stderr, b"")

    def test_real_read_deadline_with_open_stdin_does_not_execute(self) -> None:
        """Use the unchanged ten-second production timer, not a shortened test loader."""
        self.assertEqual(bootstrap.READ_SECONDS, 10)
        source = ('print("' + CANARY + '")\n').encode()
        started = time.monotonic()
        with subprocess.Popen(arguments(source), stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
            try:
                assert process.stdin is not None
                process.stdin.write(source[:-1])
                process.stdin.flush()
                process.wait(timeout=13)
                assert process.stdout is not None and process.stderr is not None
                result = subprocess.CompletedProcess(process.args, process.returncode,
                                                     process.stdout.read(), process.stderr.read())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=2)
        self.assert_refused(result)
        self.assertGreaterEqual(time.monotonic() - started, 9)
        self.assertLess(time.monotonic() - started, 13)

    def test_growth_does_not_put_source_or_packet_in_arguments(self) -> None:
        """Exercise the upper source bound with a multi-byte source still below 8 KiB argv."""
        source = ECHO + b"\n#" + b"x" * (bootstrap.MAX_HELPER_BYTES - len(ECHO) - 2)
        packet = ('{"secret":"' + CANARY + '"}\n').encode()
        args = arguments(source)
        self.assertLess(len(" ".join(args).encode()), 8192)
        self.assertNotIn(CANARY, " ".join(args))
        self.assertNotIn("π", " ".join(args))
        result = execute(source, source + packet)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, packet)
        self.assertEqual(result.stderr, b"")

    def test_included_helper_metadata_frame_and_packet_limit(self) -> None:
        """Derive metadata from the current bundle; never enter its host-facing main."""
        source = Path(helper.__file__).read_bytes()
        source_length = len(source)
        source_digest = hashlib.sha256(source).hexdigest()
        args = arguments(source)
        self.assertEqual(args[-2:], [str(source_length), source_digest])
        self.assertGreater(source_length, 0)
        self.assertLessEqual(source_length, bootstrap.MAX_HELPER_BYTES)
        self.assertLess(len(" ".join(args).encode()), 8192)
        compile(source, "<included-helper-compile-only>", "exec")
        self.assertEqual(helper.MAX_INPUT, 16 * 1024)
        request = {"mode": "status", "resetId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                   "expected": {"operationId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                                "environmentId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                                "deviceId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                                "releaseId": "host-" + "a" * 20, "sha256": "a" * 64,
                                "size": 1, "publicKey": base64.b64encode(b"x" * 32).decode()}}
        packet = json.dumps(request).encode()
        packet += b" " * (helper.MAX_INPUT - len(packet))
        stream = io.BufferedReader(io.BytesIO(source + packet))
        verified = bootstrap.read_verified_source(stream, int(args[-2]), args[-1])
        self.assertEqual(verified, source)
        self.assertEqual(hashlib.sha256(verified).hexdigest(), args[-1])
        remaining = stream.read()
        self.assertEqual(remaining, packet)
        self.assertEqual(helper.read_request(io.BytesIO(remaining)), request)
        with self.assertRaisesRegex(helper.Refused, "input budget"):
            helper.read_request(io.BytesIO(packet + b" "))


if __name__ == "__main__":
    unittest.main()
