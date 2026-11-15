"""Bundled stdin loader: python3 -I -B -S -c <loader> <byte-length> <sha256>.

Stdin is exactly the trusted number of UTF-8 helper source bytes, then the helper's
JSON packet through EOF. Any sudo password line has already been consumed by sudo.
No temporary files, installed imports, packet decoding, or stdin replacement.
"""
from __future__ import annotations

import hashlib
import signal
import sys
from typing import BinaryIO

MAX_HELPER_BYTES = 1024 * 1024
READ_SECONDS = 10
FAILURE = "Setup restart bootstrap refused the frame; no verified completion was returned.\n"


class Refused(Exception):
    """Reject a frame without exposing source, packet, or exception text."""


def expired(_signum: int, _frame: object) -> None:
    """Interrupt a stalled source read or compilation before executing the helper."""
    raise Refused()


def read_verified_source(stream: BinaryIO, length: int, digest: str) -> bytes:
    """Read only the bounded source prefix, preserving buffered packet bytes."""
    if (type(length) is not int or not 0 < length <= MAX_HELPER_BYTES
            or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest)):
        raise Refused()
    source = stream.read(length)
    if len(source) != length or hashlib.sha256(source).hexdigest() != digest:
        raise Refused()
    return source


def main() -> None:
    """Authenticate source before compilation; leave all request policy to the helper."""
    try:
        if (len(sys.argv) != 3 or not sys.flags.isolated or not sys.flags.no_site
                or not sys.flags.dont_write_bytecode):
            raise Refused()
        size = sys.argv[1]
        if not 1 <= len(size) <= 7 or any(c not in "0123456789" for c in size):
            raise Refused()
        length = int(size)
        if str(length) != size:
            raise Refused()
        previous = signal.signal(signal.SIGALRM, expired)
        try:
            signal.setitimer(signal.ITIMER_REAL, READ_SECONDS)
            source = read_verified_source(sys.stdin.buffer, length, sys.argv[2])
            code = compile(source, "<outpost-restart-helper>", "exec")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
        sys.argv = sys.argv[:1]
        exec(code, {"__name__": "__main__"})
    except SystemExit as error:
        # The qualified helper uses numeric exit codes and its own static diagnostics.
        # Never let Python print a string-valued SystemExit containing source/input.
        if error.code is None or type(error.code) is int:
            raise
        sys.stderr.write(FAILURE)
        raise SystemExit(1) from None
    except BaseException:
        sys.stderr.write(FAILURE)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
