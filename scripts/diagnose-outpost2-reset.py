"""Read-only snapshot diagnostics; expects verified helper source and request on stdin."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import signal
import sys
import types

HELPER_SHA256 = "b47fca46be69ab592314a69b24c96b51e467a8def0ecb2d2e5db8d9aa794fc8d"
RESET_ID = "5e5f59b9-ccaa-4402-ac8d-10fd315978d4"
OPERATION_ID = "645f62a9-37c8-413e-b31e-9372bc2ed774"


def main() -> None:
    """Observe digests without invoking review preparation, cleanup or installed code."""
    if os.geteuid() != 0 or not sys.flags.isolated or not sys.flags.no_site:
        raise RuntimeError("Isolated privileged diagnostic required")
    packet = json.loads(sys.stdin.buffer.read(1024 * 1024))
    source = base64.b64decode(packet["helper"], validate=True)
    if hashlib.sha256(source).hexdigest() != HELPER_SHA256:
        raise RuntimeError("Qualified helper changed")
    helper = types.ModuleType("verified_reset_diagnostic")
    sys.modules[helper.__name__] = helper
    exec(compile(source, "<verified-reset-diagnostic>", "exec"), helper.__dict__)
    request = helper.validate(packet["request"])
    if (request["mode"] != "recover_review" or request["resetId"] != RESET_ID
            or request["expected"]["operationId"] != OPERATION_ID):
        raise RuntimeError("Exact held reset diagnostic required")
    report: dict[str, object] = {"readOnly": True, "resetId": RESET_ID}
    real_digest = helper.digest

    def observe(value: object) -> str:
        """Collect fingerprints and configuration metadata, not private file contents."""
        if isinstance(value, dict) and set(value) == {
            "expected", "resetId", "request", "receipt", "layout", "units", "accounts",
            "setup", "history", "configuration", "mounts",
        }:
            report["components"] = {key: real_digest(item) for key, item in value.items()}
            config = value["configuration"]
            report["configuration"] = {key: real_digest(item) for key, item in config.items()}
            report["linkedDeclarations"] = config["linkedDeclarations"]
            report["activationReferences"] = config["activationReferences"]
            report["unitContexts"] = config["unitContexts"]
            report["loadedInstances"] = config["loadedInstances"]
            report["mounts"] = value["mounts"]
            report["layout"] = {key: real_digest(item) for key, item in value["layout"].items()}
        return real_digest(value)

    def forbid_write(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("Diagnostic refuses filesystem mutation")

    class ReadOnlyRunner(helper.SystemRunner):
        """Allow only the bundled inspector's fixed systemd query verbs."""
        def run(self, argv: list[str], *args: object, **kwargs: object) -> bytes:
            if len(argv) < 2 or argv[0] != "/usr/bin/systemctl" or argv[1] not in ("show", "list-units"):
                raise RuntimeError("Diagnostic refuses non-query host commands")
            return super().run(argv, *args, **kwargs)

    helper.digest = observe
    for method in ("mkdir", "atomic", "unlink", "remove_tree"):
        setattr(helper.Files, method, forbid_write)
    report["recognizedScope"] = helper.linux_login_scope()
    chain = []
    pid = os.getpid()
    for _ in range(12):
        try:
            with open(f"/proc/{pid}/stat") as stream:
                status = stream.read(8192)
            end = status.rfind(")")
            ppid = int(status[end + 2:].split()[1])
            with open(f"/proc/{pid}/cgroup") as stream:
                cgroup = stream.read(16384)
            chain.append({"pid": pid, "ppid": ppid, "comm": status[status.find("(") + 1:end], "cgroup": cgroup})
        except FileNotFoundError:
            break
        if pid == 1 or ppid == pid:
            break
        pid = ppid
    report["processChain"] = chain
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError("Diagnostic budget expired")))
    signal.alarm(120)
    root = os.open("/", helper.TRAVERSE_FLAGS)
    try:
        files = helper.Files(root)
        engine = helper.Helper(files, ReadOnlyRunner(), helper.SystemAccounts(), True)
        with files.lock():
            review, _ = engine.inspect(request)
        report["snapshotDigest"] = review["snapshotDigest"]
        report["canReset"] = review["canReset"]
    except helper.SAFE_ERRORS as error:
        report["refusal"] = helper.public_error(error)
    finally:
        signal.alarm(0)
        os.close(root)
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
