"""Operator-side read-only check launcher with exclusive, private reports.

Run WITHOUT sudo using system Python -I -B. Only the fixed checker is elevated;
sudo reads the password from the terminal, never from this program or a file.
No service-start, normalization, installer, retry or report-overwrite option exists.
"""
from __future__ import annotations

import hashlib
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

DIRECTORY = Path('/home/surajadmin2/outpost-browser-repair-645f62a9/verification-v2')
CHECKER = 'continue-outpost2-setup.py'
CHECKER_SHA256 = '33728f467bedf3a8431975502e5ca649f94cc9ff41fe63354c5b4eca73f90c2b'


class Refused(RuntimeError):
    """A fixed operator-facing preparation error."""


def validate(directory: Path, expected_hash: str) -> None:
    """Check the caller-owned staging directory and the reviewed checker bytes."""
    uid = os.geteuid()
    if uid == 0:
        raise Refused('Run this launcher without sudo; it requests sudo only for the read-only check.')
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or directory.resolve(strict=True) != directory or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700:
        raise Refused('The private, caller-owned repair directory does not match expectations.')
    path = directory / CHECKER
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != uid or before.st_mode & 0o022 or before.st_size > 256 * 1024:
            raise Refused('Unsafe checker file; no check was started.')
        data = source.read(256 * 1024 + 1)
        after = os.fstat(source.fileno())
        named = path.lstat()
        fields = ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        if len(data) != before.st_size or any(getattr(before, key) != getattr(after, key) or getattr(before, key) != getattr(named, key) for key in fields):
            raise Refused('Checker changed during review; no check was started.')
    if hashlib.sha256(data).hexdigest() != expected_hash:
        raise Refused('Checker checksum differs from this reviewed version; no check was started.')


def run_check(directory: Path = DIRECTORY, expected_hash: str = CHECKER_SHA256) -> int:
    """Test seams are internal only; the CLI accepts no paths, commands or flags."""
    validate(directory, expected_hash)
    fd, filename = tempfile.mkstemp(prefix='runtime-verification-', suffix='.txt', dir=directory)
    print(f'Read-only verification report: {filename}', flush=True)
    print('Enter sudo credentials only at the terminal prompt. Existing reports are preserved.', flush=True)
    code = 1
    with os.fdopen(fd, 'wb') as report:
        try:
            result = subprocess.run(
                ['/usr/bin/sudo', '/usr/bin/python3', '-I', '-B', str(directory / CHECKER), '--check'],
                cwd=directory, stdin=subprocess.DEVNULL, stdout=report, stderr=subprocess.STDOUT,
                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'},
                timeout=1200, check=False,
            )
            code = result.returncode
        except subprocess.TimeoutExpired:
            report.write(b'\nOperator launcher timed out. The read-only checker may still be active; inspect it before any retry.\n')
            code = 124
        except KeyboardInterrupt:
            report.write(b'\nOperator interrupted this check. Review the saved output and process state before retrying.\n')
            code = 130
        except OSError:
            report.write(b'\nCould not launch or observe the fixed read-only checker. Review before retrying.\n')
        finally:
            report.flush()
            os.fsync(report.fileno())
    print('Verification passed (read-only; no services started).' if code == 0 else f'Verification stopped (exit {code}); report retained for review.', flush=True)
    print(f'Report saved: {filename}', flush=True)
    return code if 0 <= code <= 255 else 1


def main() -> int:
    """Keep both the interpreter and the privileged invocation fixed."""
    if sys.argv[1:] or not sys.flags.isolated or not sys.dont_write_bytecode:
        print('Use: /usr/bin/python3 -I -B run-outpost2-verification.py (without sudo or other arguments).', file=sys.stderr)
        return 2
    try:
        return run_check()
    except (Refused, OSError) as error:
        print(str(error) if isinstance(error, Refused) else 'Unable to prepare/save a private report; existing reports are unchanged.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
