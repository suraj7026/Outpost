"""Local-only filesystem fixtures; never SSH, sudo or mutate a server."""
from __future__ import annotations

import copy
import io
import json
import os
import stat
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

import setup_diagnostic_collector as collector


class CollectorTests(unittest.TestCase):
    """Exercise the legacy protocol on isolated owned directories."""

    def setUp(self) -> None:
        """Build a private operation fixture and an already-open trusted root."""
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.owner = os.getuid()
        self.request = {"operationId": str(uuid.uuid4()), "environmentId": str(uuid.uuid4()), "releaseId": "host-" + "a" * 20, "protectedLogs": True}
        self.operation = self.root / self.request["operationId"]
        self.operation.mkdir(mode=0o711)
        self.status = {key: value for key, value in self.request.items() if key != "protectedLogs"} | {
            "state": "failed", "stage": "Browser runtime", "completedSteps": 4, "totalSteps": 12, "updatedAt": 100, "error": "Command exited with code 1"}
        self.write("status.json", json.dumps(self.status).encode(), 0o644)
        self.write("launch.json", b'{"returnCode":0}', 0o644)
        self.write("command.log", b"unknown command failure\n", 0o600)
        self.write("launch.log", b"service launched\n", 0o600)
        self.root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)

    def tearDown(self) -> None:
        """Release local fixtures only."""
        os.close(self.root_fd)
        self.temporary.cleanup()

    def write(self, name: str, content: bytes, mode: int) -> None:
        """Write a test artifact with explicit permissions."""
        path = self.operation / name
        path.write_bytes(content)
        path.chmod(mode)

    def collect(self, service_reader=None) -> dict:
        """Inject a no-process service reader; production roots always require UID zero."""
        return collector.collect(self.request, self.root_fd, self.owner, (), service_reader or (lambda _: collector.source("service", "missing")))

    def source(self, report: dict, name: str) -> dict:
        """Find an exact stable evidence identifier."""
        return next(source for source in report["sources"] if source["id"] == name)

    def future_sidecar(self) -> dict:
        """Mirror the helper's private v1 schema without importing/executing it."""
        record = {"commandId": "browser.python-sync", "stageId": "browser-runtime", "substageId": "python-sync",
                  "sequence": 1, "completedSteps": 4, "startedAt": 10, "finishedAt": 90, "outcome": "failed", "exitCode": 1,
                  "output": {"retention": "tail", "limitBytes": 262144, "bytesSeen": 12, "bytesRetained": 12,
                             "bytesDropped": 0, "truncated": False, "streamComplete": True}}
        return {"schema": 1, **{key: self.request[key] for key in ("operationId", "environmentId", "releaseId")},
                "startedAt": 1, "updatedAt": 95, "commandCount": 1, "omittedCommandCount": 0,
                "commands": [record], "failedCommand": copy.deepcopy(record), "logs": {"command.log": 1, "failed-command.log": 1}}

    def write_sidecar(self, value: dict) -> None:
        """Publish a test sidecar with the helper's private mode."""
        self.write("diagnostics.json", json.dumps(value).encode(), 0o600)

    def test_missing_service_pipe_is_unavailable_and_process_is_reaped(self) -> None:
        """A missing Popen pipe is a checked runtime failure, not a type assertion."""
        process = Mock(stdout=None)
        process.poll.return_value = None
        with patch.object(collector.subprocess, "Popen", return_value=process):
            self.assertEqual(collector.service_status(self.request["operationId"])["status"], "unavailable")
        process.kill.assert_called_once_with()
        process.wait.assert_called_once_with()

    def test_service_pipe_is_closed_after_bounded_read(self) -> None:
        """Exercise the narrowed real pipe without launching systemctl or a child."""
        reader, writer = os.pipe()
        with os.fdopen(writer, "wb") as sink:
            sink.write(b"LoadState=not-found\n")
        with os.fdopen(reader, "rb") as output:
            process = Mock(stdout=output)
            process.poll.return_value = 0
            process.wait.return_value = 0
            with patch.object(collector.subprocess, "Popen", return_value=process):
                self.assertEqual(collector.service_status(self.request["operationId"])["status"], "missing")
            self.assertTrue(output.closed)
        process.kill.assert_not_called()

    def test_expected_service_errors_are_safe_per_source_failures(self) -> None:
        """Expected file/process errors never echo their exception text."""
        for error in (OSError("secret-canary"), ValueError("secret-canary"), subprocess.TimeoutExpired("secret-canary", 3)):
            report = self.collect(Mock(side_effect=error))
            self.assertEqual(self.source(report, "service")["status"], "unavailable")
            self.assertNotIn("secret-canary", json.dumps(report))

    def test_expected_boundary_errors_and_deadlines_exit_without_output(self) -> None:
        """The outer boundary still fails closed without leaking exception messages."""
        for error in (collector.UnsafeFile("secret-canary"), RecursionError("secret-canary"), OSError("secret-canary"), collector.ReadDeadline()):
            output = io.BytesIO()
            with (
                patch.object(collector.signal, "signal"),
                patch.object(collector.signal, "alarm"),
                patch.object(collector.sys, "stdin", Mock(buffer=io.BytesIO(json.dumps(self.request).encode() + b"\n"))),
                patch.object(collector.sys, "stdout", Mock(buffer=output)),
                patch.object(collector, "collect", side_effect=error),
                self.assertRaises(SystemExit) as raised,
            ):
                collector.main()
            self.assertEqual(raised.exception.code, 1)
            self.assertEqual(output.getvalue(), b"")

    def test_legacy_receipts_and_only_allowlisted_files_are_read(self) -> None:
        """Legacy operations need no helper import or sidecar upgrade."""
        self.write("request.json", b"request-secret-canary", 0o600)
        self.write(".env", b"env-secret-canary", 0o600)
        report = self.collect()
        self.assertEqual(report["state"], "failed")
        self.assertEqual(report["completedSteps"], 4)
        self.assertEqual({v["id"] for v in report["sources"]}, set(collector.SOURCES))
        self.assertNotIn("secret-canary", json.dumps(report))
        self.assertEqual(self.source(report, "command.log")["status"], "available")
        self.assertEqual(self.source(report, "diagnostics.json")["status"], "missing")
        self.assertEqual(self.source(report, "failed-command.log")["status"], "missing")

    def test_declined_consent_never_opens_private_logs_even_as_root(self) -> None:
        """Consent is not inferred from UID or file readability."""
        self.request["protectedLogs"] = False
        original = collector.read_file

        def reader(directory, name, *args, **kwargs):
            """Fail if the private artifacts are even opened."""
            self.assertNotIn(name, ("command.log", "launch.log", "diagnostics.json", "failed-command.log"))
            return original(directory, name, *args, **kwargs)

        with patch.object(collector, "read_file", side_effect=reader):
            report = self.collect()
        self.assertEqual(self.source(report, "command.log")["status"], "permission_denied")
        self.assertEqual(self.source(report, "command.log")["text"], "")
        for name in ("diagnostics.json", "failed-command.log"):
            self.assertEqual(self.source(report, name)["status"], "permission_denied")
            self.assertEqual(self.source(report, name)["text"], "")

    def test_preserved_failure_is_preferred_and_metadata_contains_only_reviewed_fields(self) -> None:
        """Cleanup output never replaces preserved failure evidence; labels/argv are excluded."""
        metadata = self.future_sidecar()
        metadata.update(label="top-label-canary", argv=["argv-canary"], environment={"x": "env-canary"})
        for record in (metadata["commands"][0], metadata["failedCommand"]):
            record.update(label="label-canary", title="title-canary", argv=["raw-argv-canary"], env={"x": "env-canary"})
            record["output"]["text"] = "output-canary"
        metadata["logs"]["../../.env"] = "path-canary"
        self.write_sidecar(metadata)
        self.write("failed-command.log", b"preserved error\n", 0o600)
        self.write("command.log", b"later cleanup output\n", 0o600)
        original = collector.read_file

        def reader(directory, name, *args, **kwargs):
            """The 12 KiB command-output budget is spent on one file only."""
            self.assertNotEqual(name, "command.log")
            return original(directory, name, *args, **kwargs)

        with patch.object(collector, "read_file", side_effect=reader):
            report = self.collect()
        text = self.source(report, "diagnostics.json")["text"]
        self.assertNotIn("canary", text)
        self.assertEqual(json.loads(text)["failedCommand"]["commandId"], "browser.python-sync")
        self.assertEqual(self.source(report, "failed-command.log")["text"], "preserved error\n")
        self.assertEqual(self.source(report, "command.log")["status"], "unavailable")
        self.assertNotIn("later cleanup", json.dumps(report))

    def test_foreign_sidecar_identity_or_command_labels_refuse_attribution_and_preserved_log(self) -> None:
        """A foreign or unreviewed sidecar cannot authorize a precise failure claim."""
        self.write("failed-command.log", b"wrong-evidence-canary", 0o600)
        for key in ("operationId", "environmentId", "releaseId"):
            metadata = self.future_sidecar()
            metadata[key] = "foreign-canary"
            self.write_sidecar(metadata)
            report = self.collect()
            self.assertEqual(self.source(report, "diagnostics.json")["status"], "unsafe")
            self.assertEqual(self.source(report, "failed-command.log")["status"], "unsafe")
            self.assertNotIn("canary", json.dumps(report))
            self.assertEqual(self.source(report, "command.log")["status"], "available")
        for key in ("commandId", "stageId", "substageId"):
            metadata = self.future_sidecar()
            metadata["failedCommand"][key] = "malicious-label-canary; curl evil"
            self.write_sidecar(metadata)
            report = self.collect()
            self.assertEqual(self.source(report, "diagnostics.json")["status"], "unsafe")
            self.assertNotIn("canary", json.dumps(report))

    def test_sidecar_is_revalidated_after_log_read(self) -> None:
        """Late replacement cannot attach a selected log to another operation or command."""
        self.write("failed-command.log", b"stale-log-canary", 0o600)
        for foreign in (False, True):
            metadata = self.future_sidecar()
            self.write_sidecar(metadata)

            def replace(_operation: str, foreign: bool = foreign, metadata: dict = metadata) -> dict:
                """Simulate a sidecar change between the two identity checks."""
                if foreign:
                    metadata["environmentId"] = str(uuid.uuid4())
                else:
                    metadata["updatedAt"] += 1
                self.write_sidecar(metadata)
                return collector.source("service", "missing")

            report = self.collect(replace)
            self.assertEqual(self.source(report, "diagnostics.json")["status"], "unsafe" if foreign else "unavailable")
            self.assertNotIn("stale-log-canary", json.dumps(report))

    def test_new_foreign_sidecar_during_legacy_read_invalidates_preserved_evidence(self) -> None:
        """An absent-to-foreign transition is checked as well as replacements."""
        self.write("failed-command.log", b"late-foreign-canary", 0o600)

        def publish(_operation: str) -> dict:
            """Introduce a mismatched sidecar after log collection."""
            metadata = self.future_sidecar()
            metadata["operationId"] = str(uuid.uuid4())
            self.write_sidecar(metadata)
            return collector.source("service", "missing")

        report = self.collect(publish)
        self.assertEqual(self.source(report, "diagnostics.json")["status"], "unsafe")
        self.assertEqual(self.source(report, "failed-command.log")["status"], "unsafe")
        self.assertNotIn("canary", json.dumps(report))

    def test_optional_sidecar_and_preserved_log_refuse_unsafe_files(self) -> None:
        """The new allowlist has the same owner/type/no-link/private-mode checks."""
        for name in ("diagnostics.json", "failed-command.log"):
            path = self.operation / name
            path.symlink_to(self.operation / "status.json")
            self.assertEqual(self.source(self.collect(), name)["status"], "unsafe")
            path.unlink()
            os.mkfifo(path, 0o600)
            self.assertEqual(self.source(self.collect(), name)["status"], "unsafe")
            path.unlink()
            self.write(name, b"unprotected-canary", 0o644)
            self.assertEqual(self.source(self.collect(), name)["status"], "unsafe")
            path.unlink()

    def test_missing_sidecar_keeps_preserved_output_without_inventing_provenance(self) -> None:
        """A crash may leave a preserved file but no sidecar; receipt binding still applies."""
        self.write("failed-command.log", b"preserved only\n", 0o600)
        report = self.collect()
        self.assertEqual(self.source(report, "diagnostics.json")["status"], "missing")
        self.assertEqual(self.source(report, "failed-command.log")["status"], "available")
        self.assertEqual(self.source(report, "command.log")["status"], "unavailable")

    def test_sidecar_selection_and_unicode_logs_share_the_encoded_budget(self) -> None:
        """Failure metadata stays valid JSON even when evidence must be shortened."""
        metadata = self.future_sidecar()
        metadata["commands"] = []
        for sequence in range(1, 33):
            record = copy.deepcopy(metadata["failedCommand"])
            record["sequence"] = sequence
            metadata["commands"].append(record)
        metadata["commandCount"] = 32
        metadata["logs"]["command.log"] = 32
        self.write_sidecar(metadata)
        self.write("failed-command.log", ("🙂\"\\\n" * 20000).encode(), 0o600)
        self.write("launch.log", ("🙂\"\\\n" * 20000).encode(), 0o600)
        report = self.collect()
        encoded = collector.encode_bounded(report)
        self.assertLessEqual(len(encoded), 48 * 1024)
        selected = self.source(json.loads(encoded), "diagnostics.json")
        self.assertTrue(selected["truncated"])
        parsed = json.loads(selected["text"])
        self.assertEqual(len(parsed["commands"]), 8)
        self.assertEqual(parsed["omittedCommandCount"], 24)
        self.assertEqual(parsed["failedCommand"]["sequence"], 1)
        self.assertLessEqual(len(self.source(report, "failed-command.log")["text"].encode()), 12288)
        self.assertLessEqual(len(self.source(report, "launch.log")["text"].encode()), 4096)
        self.write("diagnostics.json", b"x" * (collector.SIDECAR_LIMIT + 1), 0o600)
        self.assertEqual(self.source(self.collect(), "diagnostics.json")["status"], "unsafe")

    def test_encoded_log_budget_preserves_final_error_and_valid_sidecar(self) -> None:
        """JSON escaping must not turn a bounded tail into its oldest prefix."""
        final_error = "\nNo space left on device"
        padding = 12265 - len(final_error.encode())
        command = "🙂" * (padding // 4) + "x" * (padding % 4) + final_error
        self.assertEqual(len(command.encode()), 12265)
        self.write("launch.log", ("🙂" * 1024).encode(), 0o600)
        for name in ("command.log", "failed-command.log"):
            with self.subTest(source=name):
                if name == "failed-command.log":
                    self.write_sidecar(self.future_sidecar())
                self.write(name, command.encode(), 0o600)
                report = self.collect()
                original_metadata = self.source(report, "diagnostics.json")["text"]
                self.assertGreater(len(json.dumps(report, ensure_ascii=True, separators=(",", ":")).encode()), collector.MAX_REPLY)
                encoded = collector.encode_bounded(report)
                self.assertLessEqual(len(encoded), collector.MAX_REPLY)
                bounded = json.loads(encoded)
                evidence = self.source(bounded, name)
                self.assertTrue(evidence["truncated"])
                self.assertTrue(evidence["text"].endswith("No space left on device"))
                self.assertEqual(self.source(bounded, "diagnostics.json")["text"], original_metadata)
                if original_metadata:
                    self.assertEqual(json.loads(original_metadata)["schema"], 1)

    def test_budget_suffix_drops_new_partial_leading_lines(self) -> None:
        """A credential value cannot survive without its key at a new truncation boundary."""
        for text, limit, expected in (
            ("old\nnew", 3, "new"),
            ("old\npassword=canary\nfinal", 12, "final"),
            ("old\n🙂🙂\nfinal", 7, "final"),
            ("password=canary", 6, ""),
            ("🙂", 0, ""),
        ):
            with self.subTest(text=text, limit=limit):
                self.assertEqual(collector.newest_lines(text, limit), expected)

    def test_sidecar_log_mapping_and_output_coverage_are_validated(self) -> None:
        """Counters and sequence IDs cannot misattribute or overstate log coverage."""
        metadata = self.future_sidecar()
        metadata["logs"]["failed-command.log"] = 2
        self.write_sidecar(metadata)
        self.assertEqual(self.source(self.collect(), "diagnostics.json")["status"], "unsafe")
        metadata = self.future_sidecar()
        for record in (metadata["commands"][0], metadata["failedCommand"]):
            record["output"].update(bytesSeen=100, bytesDropped=88, truncated=True)
        self.write_sidecar(metadata)
        self.write("failed-command.log", b"short tail\n", 0o600)
        self.assertTrue(self.source(self.collect(), "failed-command.log")["truncated"])

    def test_foreign_and_stale_identity_rejected_before_and_after_read(self) -> None:
        """No evidence from another operation/environment/release can be returned."""
        for key in ("operationId", "environmentId", "releaseId"):
            original = self.status[key]
            self.status[key] = "foreign"
            self.write("status.json", json.dumps(self.status).encode(), 0o644)
            with self.assertRaises(collector.UnsafeFile):
                self.collect()
            self.status[key] = original
        self.write("status.json", json.dumps(self.status).encode(), 0o644)

        def replace_identity(_operation: str) -> dict:
            """Simulate replacement during the read, not a legitimate current binding."""
            self.status["environmentId"] = str(uuid.uuid4())
            self.write("status.json", json.dumps(self.status).encode(), 0o644)
            return collector.source("service", "missing")

        with self.assertRaises(collector.UnsafeFile):
            self.collect(replace_identity)

    def test_symlink_fifo_shared_permissions_and_wrong_owner_are_unsafe(self) -> None:
        """Never follow a link, open a device/FIFO or trust a writable log."""
        log = self.operation / "command.log"
        log.unlink()
        log.symlink_to(self.operation / "status.json")
        self.assertEqual(self.source(self.collect(), "command.log")["status"], "unsafe")
        log.unlink()
        os.mkfifo(log, 0o600)
        self.assertEqual(self.source(self.collect(), "command.log")["status"], "unsafe")
        log.unlink()
        self.write("command.log", b"data", 0o666)
        self.assertEqual(self.source(self.collect(), "command.log")["status"], "unsafe")
        info = os.stat(self.operation / "status.json")
        with self.assertRaises(collector.UnsafeFile):
            collector.check_metadata(info, False, self.owner + 1)
        with self.assertRaises(collector.UnsafeFile):
            collector.check_metadata(os.stat("/dev/null"), False, os.stat("/dev/null").st_uid)

    def test_symlink_directory_and_writable_parent_are_rejected(self) -> None:
        """Root-to-operation traversal is descriptor anchored."""
        renamed = self.root / "other"
        self.operation.rename(renamed)
        self.operation.symlink_to(renamed, target_is_directory=True)
        with self.assertRaises(OSError):
            self.collect()
        self.operation.unlink()
        renamed.rename(self.operation)
        self.operation.chmod(0o777)
        with self.assertRaises(collector.UnsafeFile):
            self.collect()

    def test_hardlink_missing_permission_and_oversized_metadata(self) -> None:
        """All failure classes are fixed strings with no exception payload."""
        log = self.operation / "command.log"
        log.unlink()
        self.assertEqual(self.source(self.collect(), "command.log")["status"], "missing")
        os.link(self.operation / "launch.log", log)
        self.assertEqual(self.source(self.collect(), "command.log")["status"], "unsafe")
        self.assertEqual(collector.failure_status(PermissionError("password=canary")), "permission_denied")
        self.assertEqual(collector.failure_status(RuntimeError("password=canary")), "unavailable")
        self.write("status.json", b"x" * (collector.METADATA_LIMIT + 1), 0o644)
        with self.assertRaises(collector.UnsafeFile):
            self.collect()

    def test_byte_bounds_unicode_json_expansion_and_tail_fragments(self) -> None:
        """Raw budgets apply before decoding and encoded budgets include escaping."""
        self.write("command.log", ("🙂\"\\\n" * 20000).encode(), 0o600)
        self.write("launch.log", b"x\n" * 10000, 0o600)
        report = self.collect()
        self.assertTrue(self.source(report, "command.log")["truncated"])
        self.assertTrue(self.source(report, "launch.log")["truncated"])
        self.assertLessEqual(len(self.source(report, "command.log")["text"].encode()), 12288)
        encoded = collector.encode_bounded(report)
        self.assertLessEqual(len(encoded), 48 * 1024)
        self.assertTrue(json.loads(encoded)["sources"][2]["truncated"])
        self.write("command.log", b"password=" + b"canary" * 5000, 0o600)
        self.assertEqual(self.source(self.collect(), "command.log")["text"], "")

    def test_protocol_rejects_arbitrary_paths_and_choices(self) -> None:
        """There is no arbitrary command, path or script protocol."""
        for key, value in (("operationId", "../../etc"), ("releaseId", "host-;id"), ("protectedLogs", "true"), ("command", "id")):
            with self.assertRaises((collector.UnsafeFile, ValueError)):
                collector.validate_request(self.request | {key: value})

    @unittest.skipUnless(hasattr(os, "O_PATH"), "Linux execute-only directory handles")
    def test_execute_only_operation_directory_does_not_require_sudo(self) -> None:
        """Public receipts remain readable without permission to list the directory."""
        self.request["protectedLogs"] = False
        self.operation.chmod(0o111)
        try:
            self.assertEqual(self.collect()["state"], "failed")
        finally:
            self.operation.chmod(0o711)

    def test_overall_deadline_is_not_swallowed_as_a_missing_source(self) -> None:
        """A whole-read deadline must terminate collection, not continue reading."""
        def deadline(_operation: str) -> dict:
            """Simulate SIGALRM while reading service properties."""
            raise collector.ReadDeadline()
        with self.assertRaises(collector.ReadDeadline):
            self.collect(deadline)

    def test_directory_replacement_and_timestamp_regression_are_rejected(self) -> None:
        """Reopen the absolute traversal, not only the old retained directory fd."""
        def regress(_operation: str) -> dict:
            """Replace a fresh receipt with stale evidence."""
            self.status["updatedAt"] = 99
            self.write("status.json", json.dumps(self.status).encode(), 0o644)
            return collector.source("service", "missing")
        with self.assertRaises(collector.UnsafeFile):
            self.collect(regress)
        self.status["updatedAt"] = 100
        self.write("status.json", json.dumps(self.status).encode(), 0o644)

        def replace(_operation: str) -> dict:
            """Swap directories using a valid identical receipt to exercise inode checks."""
            self.operation.rename(self.root / "old")
            self.operation.mkdir(mode=0o711)
            self.write("status.json", json.dumps(self.status).encode(), 0o644)
            return collector.source("service", "missing")
        with self.assertRaises(collector.UnsafeFile):
            self.collect(replace)

    def test_reader_does_not_write_any_operation_artifact(self) -> None:
        """Receipts, logs and directory contents remain unchanged by collection."""
        before = {p.name: (p.read_bytes(), stat.S_IMODE(p.stat().st_mode), p.stat().st_mtime_ns) for p in self.operation.iterdir()}
        self.collect()
        after = {p.name: (p.read_bytes(), stat.S_IMODE(p.stat().st_mode), p.stat().st_mtime_ns) for p in self.operation.iterdir()}
        self.assertEqual(before, after)
        self.assertFalse((self.operation / "cancel").exists())


if __name__ == "__main__":
    unittest.main()
