"""Fixed, read-only SSH diagnostic protocol. No installer imports or remote writes."""
from __future__ import annotations

import errno
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid

MAX_REPLY = 48 * 1024
METADATA_LIMIT = 64 * 1024
PARTS = ("var", "lib", "outpost-setup", "operations")
SOURCES = ("status.json", "launch.json", "command.log", "launch.log", "diagnostics.json", "failed-command.log", "service")
SIDECAR_LIMIT = 32 * 1024
SIDECAR_REPLY_LIMIT = 8 * 1024
COMMAND_STAGES = {
    "accounts.workspace-group": "service-accounts",
    **{f"accounts.create-{user}": "service-accounts" for user in ("outpost-coord", "outpost-pi", "outpost-build")},
    **{f"accounts.workspace-{user}": "service-accounts" for user in ("outpost-coord", "outpost-pi")},
    "dependencies.build-ownership": "server-dependencies",
    "dependencies.npm-ci": "server-dependencies",
    "dependencies.typescript-version": "server-dependencies",
    "browser.system-dependencies": "browser-runtime",
    "browser.python-sync": "browser-runtime",
    "browser.validate-launcher": "browser-runtime",
    "configuration.release-ownership": "protected-configuration",
    "configuration.release-permissions": "protected-configuration",
    "enrollment.initialize": "device-enrollment",
    "services.verify-units": "persistent-services",
    "services.daemon-reload": "persistent-services",
    "services.enable": "persistent-services",
    "health.services-active": "health-verification",
}
PROPERTIES = ("LoadState", "ActiveState", "SubState", "Result", "ExecMainCode", "ExecMainStatus")
# Legacy operation directories are 0711: traversal must not require listing them.
DIRECTORY_FLAGS = getattr(os, "O_PATH", os.O_RDONLY) | os.O_DIRECTORY | os.O_NOFOLLOW


class UnsafeFile(Exception):
    """A path, file, or identity is outside the fixed protocol."""


class ReadDeadline(BaseException):
    """The overall deadline must not be swallowed by per-source error handling."""


class SnapshotChanged(Exception):
    """A sidecar changed while its selected evidence was being read."""


READ_ERRORS = (UnsafeFile, SnapshotChanged, OSError, ValueError, TypeError, KeyError, RecursionError)


def validate_request(value: dict) -> dict:
    """Accept only native-bound IDs and an explicit private-read choice."""
    if set(value) != {"operationId", "environmentId", "releaseId", "protectedLogs"}:
        raise UnsafeFile()
    for key in ("operationId", "environmentId"):
        if not isinstance(value[key], str) or str(uuid.UUID(value[key])) != value[key]:
            raise UnsafeFile()
    if not isinstance(value["releaseId"], str) or not re.fullmatch(r"host-[0-9a-fA-F]{20}", value["releaseId"]):
        raise UnsafeFile()
    if type(value["protectedLogs"]) is not bool:
        raise UnsafeFile()
    return value


def check_metadata(info: os.stat_result, directory: bool, owner: int, private: bool = False) -> None:
    """Reject wrong owners, writable shared paths, links and non-regular files."""
    correct_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not correct_type or info.st_uid != owner or info.st_mode & (0o077 if private else 0o022):
        raise UnsafeFile()
    if not directory and info.st_nlink != 1:
        raise UnsafeFile()


def open_operation(root_fd: int, operation: str, owner: int = 0, parts: tuple[str, ...] = PARTS) -> int:
    """Traverse anchored directory descriptors; never follow symlinks."""
    descriptor = os.dup(root_fd)
    try:
        check_metadata(os.fstat(descriptor), True, owner)
        for part in (*parts, operation):
            if not part or part in (".", "..") or "/" in part:
                raise UnsafeFile()
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
            check_metadata(os.fstat(descriptor), True, owner)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def read_file(directory: int, name: str, limit: int, owner: int = 0, tail: bool = False, private: bool = False) -> tuple[bytes, bool]:
    """Read at most the fixed byte budget after validating a nonblocking descriptor."""
    if name not in SOURCES[:-1]:
        raise UnsafeFile()
    # lstat before open avoids even opening a device/FIFO; fstat closes replacement races.
    before = os.stat(name, dir_fd=directory, follow_symlinks=False)
    check_metadata(before, False, owner, private)
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        info = os.fstat(descriptor)
        check_metadata(info, False, owner, private)
        if (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino):
            raise UnsafeFile()
        truncated = info.st_size > limit
        if truncated and not tail:
            raise UnsafeFile()
        if tail:
            os.lseek(descriptor, max(0, info.st_size - limit), os.SEEK_SET)
        chunks = bytearray()
        while len(chunks) < limit:
            chunk = os.read(descriptor, min(4096, limit - len(chunks)))
            if not chunk:
                break
            chunks.extend(chunk)
        after = os.fstat(descriptor)
        check_metadata(after, False, owner, private)
        if tail and truncated:
            # A secret assignment cut in half must not lose its redaction key.
            cut = chunks.find(b"\n")
            chunks = chunks[cut + 1:] if cut >= 0 else bytearray()
        return bytes(chunks), truncated
    finally:
        os.close(descriptor)


def receipt(directory: int, request: dict, owner: int) -> dict:
    """Validate operation/environment/release binding without reading request.json."""
    raw, _ = read_file(directory, "status.json", METADATA_LIMIT, owner)
    value = json.loads(raw)
    if not isinstance(value, dict) or any(value.get(key) != request[key] for key in ("operationId", "environmentId", "releaseId")):
        raise UnsafeFile()
    if value.get("state") not in ("queued", "running", "unknown", "ready", "failed", "cancelled", "interrupted"):
        raise UnsafeFile()
    if type(value.get("completedSteps")) is not int or not 0 <= value["completedSteps"] <= 10 or value.get("totalSteps") != 12:
        raise UnsafeFile()
    if value["state"] == "ready" and value["completedSteps"] != 10:
        raise UnsafeFile()
    if not isinstance(value.get("stage"), str) or len(value["stage"].encode("utf-8")) > 100:
        raise UnsafeFile()
    if type(value.get("updatedAt")) is not int or not 0 <= value["updatedAt"] <= 2**53 - 1:
        raise UnsafeFile()
    return {key: value[key] for key in ("operationId", "environmentId", "releaseId", "state", "stage", "completedSteps", "totalSteps", "updatedAt")} | {
        "error": value.get("error") if isinstance(value.get("error"), str) else None
    }


def integer(value: object, maximum: int = 2**53 - 1, minimum: int = 0) -> int:
    """Reject booleans, coercion, negatives and unbounded metadata numbers."""
    if type(value) is not int or not minimum <= value <= maximum:
        raise UnsafeFile()
    return value


def command_record(value: dict) -> dict:
    """Select reviewed identifiers and scalar coverage only; never argv, labels or env."""
    if not isinstance(value, dict) or not isinstance(value.get("commandId"), str):
        raise UnsafeFile()
    command = value["commandId"]
    if command not in COMMAND_STAGES or value.get("stageId") != COMMAND_STAGES[command] or value.get("substageId") != command.split(".", 1)[1]:
        raise UnsafeFile()
    outcome = value.get("outcome")
    if outcome not in ("running", "succeeded", "failed", "timed_out", "cancelled", "start_failed", "capture_failed"):
        raise UnsafeFile()
    started = integer(value.get("startedAt"))
    finished = None if value.get("finishedAt") is None else integer(value["finishedAt"], minimum=started)
    if (outcome == "running") != (finished is None):
        raise UnsafeFile()
    exit_code = None if value.get("exitCode") is None else integer(value["exitCode"], 255, -255)
    output = value.get("output")
    if not isinstance(output, dict) or output.get("retention") != "tail":
        raise UnsafeFile()
    coverage = {key: integer(output.get(key)) for key in ("limitBytes", "bytesSeen", "bytesRetained", "bytesDropped")}
    if not 1 <= coverage["limitBytes"] <= 256 * 1024 or coverage["bytesRetained"] > min(coverage["limitBytes"], coverage["bytesSeen"]) or coverage["bytesDropped"] != coverage["bytesSeen"] - coverage["bytesRetained"]:
        raise UnsafeFile()
    if type(output.get("truncated")) is not bool or type(output.get("streamComplete")) is not bool or output["truncated"] != (coverage["bytesDropped"] > 0 or not output["streamComplete"]):
        raise UnsafeFile()
    return {"commandId": command, "stageId": COMMAND_STAGES[command], "substageId": command.split(".", 1)[1],
            "sequence": integer(value.get("sequence"), minimum=1), "completedSteps": integer(value.get("completedSteps"), 10),
            "startedAt": started, "finishedAt": finished, "outcome": outcome, "exitCode": exit_code,
            "output": {"retention": "tail", **coverage, "truncated": output["truncated"], "streamComplete": output["streamComplete"]}}


def sidecar(directory: int, request: dict, owner: int) -> dict:
    """Validate private optional provenance; unknown fields cannot select paths or text."""
    raw, _ = read_file(directory, "diagnostics.json", SIDECAR_LIMIT, owner, private=True)
    value = json.loads(raw)
    if not isinstance(value, dict) or type(value.get("schema")) is not int or value["schema"] != 1 or any(value.get(key) != request[key] for key in ("operationId", "environmentId", "releaseId")):
        raise UnsafeFile()
    records = value.get("commands")
    if not isinstance(records, list) or len(records) > 32:
        raise UnsafeFile()
    count = integer(value.get("commandCount"))
    omitted = integer(value.get("omittedCommandCount"))
    if omitted + len(records) != count:
        raise UnsafeFile()
    commands = [command_record(record) for record in records]
    if any(record["sequence"] != omitted + index + 1 for index, record in enumerate(commands)):
        raise UnsafeFile()
    failed = None if value.get("failedCommand") is None else command_record(value["failedCommand"])
    logs = value.get("logs")
    if not isinstance(logs, dict) or logs.get("command.log") != (count or None) or logs.get("failed-command.log") != (failed["sequence"] if failed else None):
        raise UnsafeFile()
    if any(type(logs.get(key)) is not int for key in ("command.log", "failed-command.log") if logs.get(key) is not None):
        raise UnsafeFile()
    if failed and (failed["outcome"] in ("running", "succeeded") or failed["sequence"] > count or any(record != failed for record in commands if record["sequence"] == failed["sequence"])):
        raise UnsafeFile()
    return {"schema": 1, **{key: request[key] for key in ("operationId", "environmentId", "releaseId")},
            "startedAt": integer(value.get("startedAt")), "updatedAt": integer(value.get("updatedAt")),
            "commandCount": count, "omittedCommandCount": omitted, "commands": commands, "failedCommand": failed,
            "logs": {"command.log": count or None, "failed-command.log": failed["sequence"] if failed else None}}


def sidecar_source(value: dict) -> dict:
    """Retain failure metadata and recent records within a structured JSON budget."""
    result = {**value, "commands": value["commands"][-8:]}
    while True:
        result["omittedCommandCount"] = result["commandCount"] - len(result["commands"])
        text = json.dumps(result, separators=(",", ":"), ensure_ascii=True)
        if len(text.encode("ascii")) <= SIDECAR_REPLY_LIMIT:
            return source("diagnostics.json", "available", text, len(result["commands"]) < len(value["commands"]))
        if not result["commands"]:
            raise UnsafeFile()
        result["commands"] = result["commands"][1:]


def source(name: str, status: str, text: str = "", truncated: bool = False) -> dict:
    """Use fixed source identifiers; filesystem errors never become remote text."""
    return {"id": name, "status": status, "text": text, "truncated": truncated}


def failure_status(error: Exception) -> str:
    """Classify failures without exposing arbitrary exception strings."""
    if isinstance(error, FileNotFoundError):
        return "missing"
    if isinstance(error, PermissionError):
        return "permission_denied"
    if isinstance(error, (UnsafeFile, ValueError, TypeError)) or isinstance(error, OSError) and error.errno in (errno.ELOOP, errno.ENOTDIR):
        return "unsafe"
    return "unavailable"


def service_status(operation: str) -> dict:
    """Read only bounded, allowlisted scalar systemd properties, never a journal."""
    command = ["/usr/bin/systemctl", "show", "--no-pager", "--property=" + ",".join(PROPERTIES), "--", "outpost-setup-" + operation + ".service"]
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "SYSTEMD_PAGER": "cat"})
    output = process.stdout
    try:
        if output is None:
            return source("service", "unavailable")
        # Neither a flooded pipe nor a silent subprocess may exceed the read deadline.
        raw = bytearray()
        expires = time.monotonic() + 3
        with selectors.DefaultSelector() as selector:
            selector.register(output, selectors.EVENT_READ)
            while len(raw) <= 4096:
                remaining = expires - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    return source("service", "unavailable")
                chunk = os.read(output.fileno(), 4097 - len(raw))
                if not chunk:
                    break
                raw.extend(chunk)
        code = process.wait(timeout=max(0.001, expires - time.monotonic()))
        if code or len(raw) > 4096:
            return source("service", "unavailable", truncated=len(raw) > 4096)
        lines = raw.decode("utf-8", "replace").splitlines()
        if any("=" not in line or line.split("=", 1)[0] not in PROPERTIES for line in lines):
            return source("service", "unsafe")
        return source("service", "missing" if "LoadState=not-found" in lines else "available", "\n".join(lines))
    finally:
        try:
            if process.poll() is None:
                process.kill()
            process.wait()
        finally:
            if output is not None:
                output.close()


def collect(request: dict, root_fd: int, owner: int = 0, parts: tuple[str, ...] = PARTS, service_reader=service_status) -> dict:
    """Collect one operation, checking its binding and anchored directory again at completion."""
    request = validate_request(request)
    directory = open_operation(root_fd, request["operationId"], owner, parts)
    try:
        before = receipt(directory, request, owner)
        sources = {"status.json": source("status.json", "available", json.dumps(before, ensure_ascii=False))}
        metadata = None
        if request["protectedLogs"]:
            try:
                metadata = sidecar(directory, request, owner)
                sources["diagnostics.json"] = sidecar_source(metadata)
            except READ_ERRORS as error:
                sources["diagnostics.json"] = source("diagnostics.json", failure_status(error))
        else:
            sources["diagnostics.json"] = source("diagnostics.json", "permission_denied")
        for name, limit, private in (("launch.json", 4096, False), ("failed-command.log", 12288, True), ("command.log", 12288, True), ("launch.log", 4096, True)):
            if private and not request["protectedLogs"]:
                sources[name] = source(name, "permission_denied")
                continue
            if name == "failed-command.log" and sources["diagnostics.json"]["status"] == "unsafe":
                sources[name] = source(name, "unsafe")
                continue
            if name == "command.log" and sources["failed-command.log"]["status"] == "available":
                sources[name] = source(name, "unavailable", "Not collected: preserved failed-command.log was preferred within the command-output budget.")
                continue
            try:
                raw, truncated = read_file(directory, name, limit, owner, tail=private, private=private)
                if name == "launch.json":
                    launch = json.loads(raw)
                    code = launch.get("returnCode") if isinstance(launch, dict) else None
                    if type(code) is not int or not -255 <= code <= 255:
                        raise UnsafeFile()
                    text = json.dumps({"returnCode": code})
                else:
                    text = raw.decode("utf-8", "replace")
                    if metadata:
                        record = metadata["failedCommand"] if name == "failed-command.log" else next((record for record in metadata["commands"] if record["sequence"] == metadata["logs"].get(name)), None)
                        truncated = truncated or bool(record and record["output"]["truncated"])
                sources[name] = source(name, "available", text, truncated)
            except READ_ERRORS as error:
                sources[name] = source(name, failure_status(error))
        try:
            sources["service"] = service_reader(request["operationId"])
        except (OSError, ValueError, subprocess.SubprocessError):
            sources["service"] = source("service", "unavailable")
        after_fd = open_operation(root_fd, request["operationId"], owner, parts)
        try:
            a, b = os.fstat(directory), os.fstat(after_fd)
            if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
                raise UnsafeFile()
            after = receipt(after_fd, request, owner)
            if request["protectedLogs"]:
                try:
                    if sidecar(after_fd, request, owner) != metadata:
                        raise SnapshotChanged()
                except READ_ERRORS as error:
                    status = failure_status(error)
                    # A consistently absent legacy sidecar needs no attribution. A
                    # changed/new/foreign sidecar invalidates the preserved snapshot.
                    if metadata is not None or status != sources["diagnostics.json"]["status"]:
                        sources["diagnostics.json"] = source("diagnostics.json", status)
                        sources["failed-command.log"] = source("failed-command.log", status)
        finally:
            os.close(after_fd)
        if after["updatedAt"] < before["updatedAt"] or after["completedSteps"] < before["completedSteps"]:
            raise UnsafeFile()
        sources["status.json"]["text"] = json.dumps(after, ensure_ascii=False)
        return {"schemaVersion": 1, **{key: value for key, value in after.items() if key != "error"}, "sources": [sources[name] for name in SOURCES]}
    finally:
        os.close(directory)


def newest_lines(text: str, limit: int) -> str:
    """Keep the newest suffix without exposing a newly cut credential-bearing line."""
    if len(text) <= limit:
        return text
    start = len(text) - limit
    if text[start - 1] != "\n":
        newline = text.find("\n", start)
        start = newline + 1 if newline >= 0 else len(text)
    return text[start:]


def encode_bounded(value: dict) -> bytes:
    """Account for JSON escaping while preserving the newest complete log lines."""
    while True:
        encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("ascii")
        if len(encoded) <= MAX_REPLY:
            return encoded
        # Metadata must remain valid structured JSON, not a clipped provenance claim.
        largest = max((item for item in value["sources"] if item["id"] not in ("status.json", "launch.json", "diagnostics.json")), key=lambda item: len(item["text"]))
        if not largest["text"]:
            raise UnsafeFile()
        limit = len(largest["text"]) // 2
        if largest["id"] in ("command.log", "failed-command.log", "launch.log"):
            largest["text"] = newest_lines(largest["text"], limit)
        else:
            largest["text"] = largest["text"][:limit]
        largest["truncated"] = True


def deadline(_signal: int, _frame: object) -> None:
    """Terminate read-only collection even if a subprocess or filesystem stalls."""
    raise ReadDeadline()


def main() -> None:
    """Serve a single fixed stdin request; failures have no untrusted error payload."""
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(14)
    root = None
    try:
        packet = sys.stdin.buffer.readline(2049)
        if len(packet) > 2048:
            raise UnsafeFile()
        request = validate_request(json.loads(packet))
        root = os.open("/", DIRECTORY_FLAGS)
        result = collect(request, root)
        sys.stdout.buffer.write(encode_bounded(result))
    except (*READ_ERRORS, ReadDeadline, subprocess.SubprocessError):
        # Native shows a distinct collection failure and keeps the manual guide available.
        sys.exit(1)
    finally:
        if root is not None:
            os.close(root)


if __name__ == "__main__":
    main()
