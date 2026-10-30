# Development operations and recovery

This runbook is for the local development coordinator. It is not a qualified Ubuntu/root-capable deployment procedure.

## Before using personal data

1. Read [acceptance and security limits](ACCEPTANCE.md).
2. Keep the coordinator bound to loopback. A physical device needs a separately configured authenticated HTTPS/private-network ingress; no TLS proxy is installed here.
3. Use a private `OUTPOST_DATA` directory and OS disk encryption. Back up encryption keys separately, not beside encrypted archives.
4. Do not enroll general-purpose shells/interpreters under the assumption that the command tool confines their network/filesystem access. It does not.
5. Keep provider keys and APNs keys out of source, screenshots, model context and fixture logs. Secret-redaction coverage is not qualified.

## Start, stop and inspect

- `npm start` runs the coordinator. It creates the SQLite WAL ledger and domain directories below `OUTPOST_DATA` (default `.outpost`).
- Stop the foreground process with Ctrl-C. Do not use broad process-kill commands on a shared host.
- `/health` is a process/HTTP check, not proof that Cloud, notifications or every connector works.
- The clients show server acceptance separately from execution. An authorized action must still execute and produce evidence.
- `waiting_for_capacity` without Cloud configuration is expected. Do not mark it completed to make a demo appear successful.
- On worker restart, running tasks become interrupted. Claimed external work and in-flight actions become unknown and are not blindly retried.
- Failed queued action operations appear in task evidence. Inspect the exact operation/action before re-proposing it.
- Notification delivery is advisory. Unresolved inbox records survive missing or invalid pushes; pull sync remains authoritative.

## Back up the ledger and published artifacts

Stop the development server first for this simple offline procedure. The library uses SQLite's online backup API, but this runbook does not claim a concurrent full-system snapshot.

Prepare a random **32-byte** key in a password manager or equivalent secure store and supply it as `OUTPOST_BACKUP_KEY` containing 64 hexadecimal characters. Preserve it separately; losing it means losing the archive. Do not paste it into chat or commit it. Set `OUTPOST_BACKUP_DEST` to a new private archive filename.

```sh
# OUTPOST_BACKUP_KEY and OUTPOST_BACKUP_DEST must already be set securely.
node --import tsx --input-type=module <<'JS'
import { resolve, join } from 'node:path';
import { Ledger } from './server/core/ledger.ts';
import { Artifacts } from './server/artifacts/files.ts';
import { createBackup } from './server/reliability/backup.ts';
if (!/^[a-fA-F0-9]{64}$/.test(process.env.OUTPOST_BACKUP_KEY ?? '')) throw Error('A 32-byte backup key is required');
if (!process.env.OUTPOST_BACKUP_DEST) throw Error('Set a new private archive destination');
const root = resolve(process.env.OUTPOST_DATA ?? '.outpost');
const db = new Ledger(join(root, 'ledger.sqlite'));
try {
  console.log(await createBackup(db, new Artifacts(db, join(root, 'artifacts')), Buffer.from(process.env.OUTPOST_BACKUP_KEY, 'hex'), process.env.OUTPOST_BACKUP_DEST));
} finally { db.close(); }
JS
```

The archive is authenticated AES-256-GCM and contains the ledger plus published artifact bytes/hashes. The implementation deliberately caps its in-memory payload; it is **not** a scalable streaming backup service.

**Not included:** task workspaces/repositories, Pi session files, active browser sessions/profiles, partial uploads, external provider state, separately held credential-vault master keys, APNs key or Cloud API key. Make separately encrypted copies of required workspaces/sessions and retain key references before attempting full recovery. Original files, permissions, software versions and provider evidence must be reconciled, not assumed recovered.

## Restore safely

Use an empty directory and leave the ordinary server stopped. Set `OUTPOST_BACKUP_SOURCE`, `OUTPOST_RESTORE_DIR` and the original `OUTPOST_BACKUP_KEY`.

```sh
node --import tsx --input-type=module <<'JS'
import { restoreBackup } from './server/reliability/backup.ts';
if (!/^[a-fA-F0-9]{64}$/.test(process.env.OUTPOST_BACKUP_KEY ?? '')) throw Error('Original backup key required');
if (!process.env.OUTPOST_BACKUP_SOURCE || !process.env.OUTPOST_RESTORE_DIR) throw Error('Set source and empty destination');
console.log(restoreBackup(process.env.OUTPOST_BACKUP_SOURCE, Buffer.from(process.env.OUTPOST_BACKUP_KEY, 'hex'), process.env.OUTPOST_RESTORE_DIR));
JS
```

Restore validates archive authentication, ledger/artifact hashes and SQLite integrity. It records a durable **Recovery Hold**: the coordinator's scheduler, action outbox and notification drain remain stopped on startup. Reads, pairing with already trusted devices, revocation and review are still available.

Use an already trusted Tauri Mac or retained iPhone for steps 3 and 6. Tauri exposes **Connection → Trusted devices / Recovery Hold**; it requires current device authority, a connected server and no unknown pending command. Its controls use signed requests, not per-operation biometric confirmation. Do not delete identities/server data or bypass the hold. The retired Swift Mac app is not a supported recovery path. Local synthetic UI/transport tests are not a live restored-server rehearsal.

1. Start against the restored directory using `OUTPOST_DATA`.
2. Reconnect a trusted device and review the recovered history/artifacts.
3. Revoke lost devices in **Connection → Trusted Devices**. Revocations already in the backup remain effective. Revocations made *after* the backup must be re-applied.
4. Restore/verify separately retained workspace/session files and keys where needed. If absent, leave affected tasks blocked rather than fabricate continuity.
5. Inspect queued schedules, approved actions and unknown external effects against authoritative providers. A local receipt is not proof that a provider never charged/sent/deployed.
6. Only when reviewed, use **Connection → Recovery Hold**, acknowledge the displayed held revision, then choose **Confirm and resume dispatch** in Tauri (**Authenticate & Enable Dispatch** on iPhone). This signed, revision-checked action can start previously accepted work. A conflict requires reviewing the refreshed state and confirming again; an unknown pending outcome requires **Retry same command**, not a new command. This does not automatically reconcile unknown effects.
7. Reopen the other client to rebuild its server projection. Cache history is a convenience, not a source of truth.

This was tested in temporary directories on the development Mac. Replacement-Ubuntu-server recovery, destroyed-host scenarios and complete operational RTO/RPO remain unqualified.

## Upgrade/requalification

- Preserve `package-lock.json`, exact pins and a recovery copy before updating dependencies.
- Stage upgrades separately. Run `npm ci`, browser installation, `npm run check`, shared Swift tests, Tauri builds and isolated iPhone UI tests and `npm run qualify`.
- Rerun Cloud conformance and held-out reviewer evaluation whenever provider model IDs/versions or transport behavior change. Pinning an ID is not proof its weights stayed unchanged.
- Do not reuse a qualification report from another account, model, browser or security topology.
- Keep the prior compatible binary/source and data snapshot. Database migrations currently have only the initial schema; forward/backward migration rehearsal is still required before a schema-changing release.
