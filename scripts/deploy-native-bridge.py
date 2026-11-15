"""Authorize one qualified native bridge over a pre-existing SSH host pin; never store a password."""
from __future__ import annotations
import argparse
import base64
import hashlib
import io
import tarfile
import json
import os
import subprocess
import time
import uuid
from pathlib import Path


def save_receipt(path: Path, value: dict) -> None:
    """Publish nonsecret recovery metadata durably before any remote launch."""
    temporary = path.with_suffix('.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write(json.dumps(value, indent=2))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def main() -> None:
    """Require explicit target bindings, a reviewed artifact and native root authorization."""
    parser = argparse.ArgumentParser()
    for name in ('package', 'qualified-sha256', 'host', 'user', 'identity', 'known-hosts', 'host-alias', 'environment', 'device', 'receipt'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--port', type=int, default=22)
    parser.add_argument('--approved', action='store_true', required=True)
    args = parser.parse_args()
    for value in (args.environment, args.device):
        if str(uuid.UUID(value)) != value:
            raise ValueError('Invalid identity')
    if not 0 < args.port < 65536 or args.host.startswith('-') or args.user.startswith('-'):
        raise ValueError('Invalid SSH target')
    package = Path(args.package).resolve()
    artifact = json.loads((package / 'bridge.json').read_text())
    payload = (package / 'bridge.tar.gz').read_bytes()
    if artifact['sha256'] != args.qualified_sha256 or hashlib.sha256(payload).hexdigest() != artifact['sha256'] or len(payload) != artifact['size']:
        raise ValueError('Artifact changed')
    ssh = ['/usr/bin/ssh', '-F', '/dev/null', '-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oGlobalKnownHostsFile=/dev/null',
           '-oUpdateHostKeys=no', '-oForwardAgent=no', '-oForwardX11=no', '-oPermitLocalCommand=no', '-oControlMaster=no', '-oConnectTimeout=10',
           '-oServerAliveInterval=10', '-oServerAliveCountMax=3', '-oUserKnownHostsFile=' + json.dumps(str(Path(args.known_hosts).resolve())),
           '-oHostKeyAlias=' + args.host_alias, '-oIdentitiesOnly=yes', '-i', str(Path(args.identity).resolve()), '-p', str(args.port), '-l', args.user, '--', args.host]
    subprocess.run([*ssh, '/usr/bin/true'], check=True, timeout=20)
    request = {'operationId': str(uuid.uuid4()), 'environmentId': args.environment, 'deviceId': args.device,
               'releaseId': artifact['manifest']['id'], 'expectedRelease': artifact['expectedRelease'],
               'sha256': artifact['sha256'], 'size': artifact['size'], 'target': artifact['manifest']}
    receipt = Path(args.receipt).resolve()
    receipt.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with receipt.open('x') as output:
        output.write(json.dumps(dict(request=request, state='authorizing'), indent=2))
    receipt.chmod(0o600)
    # Load only code already covered by the artifact hash, not a mutable working tree.
    with tarfile.open(fileobj=io.BytesIO(payload)) as archive:
        code = {name: archive.extractfile('./deploy/environment/' + name + '.py').read() for name in ('host_install', 'host_update', 'native_bridge')}
    modules = []
    for name in ('host_install', 'host_update'):
        encoded = base64.b64encode(code[name]).decode()
        modules.append(f"m=types.ModuleType('{name}');sys.modules['{name}']=m;exec(base64.b64decode('{encoded}'),m.__dict__)")
    bridge = base64.b64encode(code['native_bridge']).decode()
    bootstrap = 'import base64,types,sys\n' + '\n'.join(modules) + f"\nexec(base64.b64decode('{bridge}'))"
    remote = "sudo -k -S -p '' -- /usr/bin/python3 -c 'import base64;exec(base64.b64decode(\"" + base64.b64encode(bootstrap.encode()).decode() + "\"))' --bootstrap"
    prompt = (f'Authorize the tested one-time Outpost native bridge on {args.user}@{args.host}. '
              f'Move {request["expectedRelease"]} to {request["releaseId"]} for installation {args.environment}. '
              'It waits for idle task work, cancels unfinished provider sign-ins, and briefly restarts only native Outpost services. '
              'Credentials, browser implementation, device enrollment and history are retained. Other servers and Kubernetes are untouched. '
              'Enter the remote sudo password; it is not saved.')
    script = 'text returned of (display dialog ' + json.dumps(prompt) + ' default answer "" with hidden answer buttons {"Cancel", "Deploy native bridge"} default button "Deploy native bridge" with title "Outpost maintenance")'
    result = subprocess.run(['/usr/bin/osascript', '-e', script], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=180)
    if result.returncode:
        raise SystemExit('Authorization cancelled; no server changes were made.')
    secret = bytearray(result.stdout.rstrip(b'\r\n'))
    del result
    if not secret or len(secret) > 1024 or b'\n' in secret:
        raise SystemExit('Invalid authorization; no server changes were made.')
    secret.extend(b'\n')
    save_receipt(receipt, dict(request=request, state='unknown'))
    print(json.dumps({'operationId': request['operationId'], 'environmentId': args.environment, 'releaseId': request['releaseId']}), flush=True)
    try:
        process = subprocess.Popen([*ssh, remote], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        process.stdin.write(secret)
        secret[:] = b'\0' * len(secret)
        process.stdin.write(json.dumps(request).encode() + b'\n')
        process.stdin.write(payload)
        process.stdin.close()
        process.stdin = None
        try:
            reply, _ = process.communicate(timeout=90)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise RuntimeError('Launch outcome unknown; inspect its retained receipt') from None
        if process.returncode != 0 or len(reply) > 32768:
            raise RuntimeError('Launch not confirmed; inspect the retained operation before retrying')
        status = json.loads(reply)
        if status.get('operationId') != request['operationId'] or status.get('environmentId') != args.environment:
            raise ValueError('Receipt binding mismatch')
        save_receipt(receipt, dict(request=request, status=status))
        print(json.dumps(status), flush=True)
    finally:
        secret[:] = b'\0' * len(secret)
    for _ in range(600):
        command = "python3 -c 'from pathlib import Path;print(Path(\"/var/lib/outpost-setup/operations/" + request['operationId'] + "/status.json\").read_text())'"
        try:
            status = json.loads(subprocess.check_output([*ssh, command], timeout=20))
            if status.get('operationId') != request['operationId']:
                raise ValueError('Receipt changed')
            save_receipt(receipt, dict(request=request, status=status))
            if status['state'] in ('complete', 'failed', 'rolled_back', 'needs_attention'):
                print(json.dumps(status), flush=True)
                if status['state'] != 'complete':
                    raise SystemExit('Bridge did not complete; retained receipt requires inspection')
                return
        except (OSError, subprocess.SubprocessError):
            pass  # Status only. Never repeat authorization or the launch.
        time.sleep(2)
    raise SystemExit('Status deadline exceeded. The operation is retained; no retry was made.')


if __name__ == '__main__':
    main()
