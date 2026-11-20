"""Read-only host evidence for recovering a pre-activation failed update from the desktop."""
from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

PRE_ACTIVATION_FAILURE_CODES: dict[str, frozenset[str]] = {
    'preflight': frozenset({
        'preflight_failed',
        'installation_changed',
        'target_already_exists',
        'release_paths_changed',
        'unsupported_manifest',
        'runtime_pins_mismatch',
        'missing_service_files',
    }),
    'staging': frozenset({'staging_failed'}),
    'waiting_for_idle': frozenset({'waiting_for_idle_failed'}),
}


def inspect_failed_update(environment: str, operation: str, expected: str, digest: str) -> dict[str, object]:
    """Refuse recovery unless a stopped, bound pre-activation failure kept the previous release."""
    import uuid
    for value in (environment, operation):
        if str(uuid.UUID(value)) != value:
            raise ValueError('Invalid identity')
    if not re.fullmatch(r'host-[a-f0-9]{20}', expected) or not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('Invalid release binding')
    base = Path('/var/lib/outpost-setup')
    with (base / 'install.lock').open('r') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        folder = base / 'operations' / operation
        if folder.resolve(strict=True) != folder:
            raise ValueError('Operation path changed')
        receipt = json.loads((folder / 'status.json').read_text())
        request = json.loads((folder / 'request.json').read_text())
        failure_stage = receipt.get('failureStage')
        failure_code = receipt.get('failureCode')
        allowed_codes = PRE_ACTIVATION_FAILURE_CODES.get(failure_stage) if isinstance(failure_stage, str) else None
        if (receipt.get('environmentId'), receipt.get('operationId'), receipt.get('state')) != (environment, operation, 'failed') or allowed_codes is None or failure_code not in allowed_codes:
            raise ValueError('Not a recoverable pre-activation failure')
        if (request.get('environmentId'), request.get('operationId'), request.get('expectedRelease'), request.get('sha256')) != (environment, operation, expected, digest):
            raise ValueError('Request binding changed')
        if receipt.get('releaseId') != request.get('releaseId'):
            raise ValueError('Target binding changed')
        state = subprocess.run(['/usr/bin/systemctl', 'show', 'outpost-update-' + operation + '.service', '--property=ActiveState', '--value'], capture_output=True, text=True, check=True, timeout=10).stdout.strip()
        if state not in ('inactive', 'failed'):
            raise ValueError('Updater may still be running')
        installation = json.loads(Path('/etc/outpost-native/installation.json').read_text())
        current = Path('/opt/outpost-native/current').resolve(strict=True)
        if installation.get('environmentId') != environment or installation.get('release') != expected or current != Path('/opt/outpost-native/releases') / expected:
            raise ValueError('Previous release is not confirmed active')
        return {'environmentId': environment, 'operationId': operation, 'expectedRelease': expected, 'sha256': digest, 'failureStage': failure_stage, 'state': 'safe_to_recheck', 'updaterState': state}


def main() -> None:
    """Print bounded evidence only; never clear maintenance or restart services."""
    try:
        if os.geteuid() != 0 or len(sys.argv) != 5:
            raise ValueError('Root inspection with four bound arguments required')
        print(json.dumps(inspect_failed_update(*sys.argv[1:])))
    except Exception:
        print('Recovery inspection refused; retain the operation for manual inspection.', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
