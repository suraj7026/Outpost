# Native desktop environments (A2)

This is the native IPC contract consumed by the implemented [desktop environment selection and unified history](DESKTOP-ENVIRONMENTS.md). Existing legacy commands remain installed. Local implementation/review does not imply a live server rollout. All new operational IPC takes an explicit canonical lowercase installation UUID; selection metadata never routes requests.

## IPC

Tauri arguments use **camelCase**. All failures reject with a string. `Json` means the existing server JSON payload/record/snapshot format; record and SSE payload protocol remains **1**, while signed transport envelopes use **2**.

```ts
type SavedEnvironment = {
  environmentId: string;
  label: string;
  routes: string[];        // authenticated, verified endpoint URLs
  activeRoute: string;
};
type RegistryMetadata = {
  version: 1;
  legacyMutationsRetired: boolean;
  selectedEnvironmentId: string | null;
  environments: Record<string, SavedEnvironment>; // keyed by installation UUID
};
type EnvironmentConnectionInfo = {
  environmentId: string;
  endpoint: string;
  deviceId: string;
  publicKey: string;       // public Ed25519 pairing key, base64
  pending: boolean;
  pendingError: string | null; // fail closed even if pending is false
  nativeSidebar: false;
};
```

| Command | Arguments | Result |
| --- | --- | --- |
| `environment_list` | none | `{ registry: RegistryMetadata, legacy: { endpoint: string \| null, pending: boolean } }` |
| `environment_discover` | `{ endpoint }` | Exact A1 environment descriptor (`server/environment/contracts.ts`); untrusted discovery, **not** registration |
| `environment_register` | `{ environmentId, endpoint, label, bootstrapToken?: string \| null, retireLegacyMutations?: boolean }` | `RegistryMetadata` after discovery and authenticated descriptor confirmation; adds a route or explicitly makes a verified route active |
| `environment_select` | `{ environmentId: string \| null }` | `RegistryMetadata`; only saves selection, does not disconnect or reroute anything |
| `environment_rename` | `{ environmentId, label }` | `RegistryMetadata` |
| `environment_disconnect` | `{ environmentId }` | `void`; cancels this environment's current/pending SSE connection only |
| `environment_remove` | `{ environmentId }` | `RegistryMetadata`; blocks on unresolved/corrupt pending state, cancels stream, retains private directory, does not revoke devices or stop/delete the server |
| `environment_connection_info` | `{ environmentId }` | `EnvironmentConnectionInfo` |
| `environment_query` | `{ environmentId, kind, payload }` | Existing server query result (e.g. snapshot, device list, descriptor) |
| `environment_agent_request` | `{ environmentId, payload }` | Existing provider result; ephemeral, never queued or persisted |
| `environment_send_command` | `{ environmentId, kind, id, revision, payload }` | Existing server command result/record; allocates and durably saves command IDs before sending |
| `environment_retry_command` | `{ environmentId }` | Existing result for the **same** saved commandId, idempotencyKey, aggregateId, expectedRevision and payload |
| `environment_enroll_device` | `{ environmentId, deviceId, name, publicKey }` | Existing device record; distinct signer and target device; not automatically retried |
| `environment_stream_events` | `{ environmentId, channel: Channel<Json> }` | Promise resolves when stream ends/cancels; channel contains unchanged decoded SSE frames |
| `environment_artifact` | `{ environmentId, id, hash }` | Base64 bytes after SHA-256/64-MiB integrity check |
| `environment_save_artifact` | `{ environmentId, id, hash, name }` | Saved absolute path under `Downloads/Outpost/<environmentId>/<artifactId>/<name>` |

Artifact uploads use `environment_send_command` for `artifact.begin`, `artifact.chunk`, and `artifact.complete`, carrying the same environmentId for every chunk. Existing `open_url` and OAuth callback IPC are unchanged; A3 must bind OAuth session callbacks to the initiating environment in frontend state and send their provider operations only with that environmentId.

Starting another stream for the **same** environment cancels its predecessor, including an in-flight HTTP handshake. Other environments' streams are unaffected. A3 must also retain environment/generation guards for callbacks already delivered to JavaScript. `environment_disconnect` is stream teardown, not a persistent disabled flag; a later explicit stream call reconnects. Registering an alternate active route cancels the old stream; A3 restarts it explicitly. There is no automatic route failover.

## Registration and pairing

- Discover first, display the identity, then supply that expected UUID to registration. Labels and URLs are never identities.
- Omit `bootstrapToken` to adopt an already-enrolled device with its existing Keychain key. Authentication must succeed before the route is saved. Unknown IDs and wrong response identity/version never fall back to v1.
- Supply a bootstrap token only for explicit first-device pairing of a **new** installation. It is never saved. The durable non-secret `pairing-attempt` marker is written before contacting `/v2/pair`. Any ambiguous/failed attempt blocks another bootstrap attempt, including after restart. Try adoption with the same identity; never automatically reenroll. A definitively rejected token also remains conservatively blocked for bootstrap; operator inspection is required rather than silently deleting the marker.
- All HTTP responses, including errors and artifact/stream headers, must match the expected installation and protocol 2 before their payloads are consumed. Provider errors are generic and never reflect provider response bodies into diagnostics.
- HTTPS certificate verification remains enabled; loopback HTTP is permitted for trusted SSH tunnels. Remote HTTP, redirects and embedded credentials/query strings/fragments are rejected. Application UUID equality is not transport trust.

## Legacy migration and unresolved work

The original Keychain service/account remains `dev.outpost.identity` / `device`. Initialization is process-serialized across all environments. No identity is reset/copied into metadata; existing enrollment can be adopted without pairing. The original `endpoint` and encrypted `pending.enc` remain untouched until ordinary legacy recovery clears a settled command.

1. Read `environment_list`. A null legacy endpoint means no explicitly saved endpoint; the existing legacy default is `http://127.0.0.1:4318`.
2. If legacy pending work exists, keep the old connection available. Use existing `connection_info`, `query`, and **legacy `retry_command`** against its original endpoint to resolve the original command/receipt. Pre-upgrade endpoint spellings are compared using validated URL normalization on both sides (for example `HTTP://LOCALHOST:80` and `http://localhost`), without treating different hostnames, ports or paths as aliases. The original encrypted envelope and v1 command are not rewritten or rebound. Do not convert it to a v2 envelope, guess its installation, delete it, or offer a fresh command as retry. Unreadable/corrupt legacy storage requires inspection and remains blocked.
3. While such work exists, adoption of **any additional unknown enrolled environment** is blocked, even via a different URL: it might be an alias of the legacy installation. Already-registered environments remain usable. Explicit first-device bootstrap of a different genuinely new server remains available.
4. With legacy pending resolved, adoption of the exact saved legacy endpoint atomically retires the legacy mutation slot when authenticated registration succeeds. For an unknown enrolled environment at another URL, native IPC returns an error prefixed `needs_legacy_retirement:` unless `retireLegacyMutations: true` is explicitly supplied. **A3 must explain and obtain confirmation that the old connection becomes read-only before sending this flag.** Declining changes nothing. Discovery is allowed before this decision.
5. Retirement is persisted with the registry. Legacy command creation/retry, pairing/enrollment, endpoint changes and **all legacy provider requests** are then rejected; reads/history/streams/artifact downloads remain available. Use bound operations for mutations. This conservative explicit choice prevents an unknown alternate URL from creating a second mutation/pending slot for the legacy owner. The legacy mutation gate is held during adoption and pending storage is checked again before registration commits.
6. Explicit bootstrap at a different new installation does not retire legacy by itself. Before local commit, it briefly checks the shared legacy mutation gate and rechecks the current legacy endpoint/pending state (no network await under this commit gate). If concurrent legacy work prevents safe commit after pairing, the error says **“Paired, registration not completed; verify/adopt the enrolled device, do not bootstrap again.”** The original pending work remains intact.
7. Once any environment is registered, legacy `set_endpoint` accepts only a normalized no-op on the unchanged, non-retired endpoint. Actual URL changes (including aliases) must go through verified bound registration. This closes the second unbound mutation-slot bypass while preserving ordinary legacy operations on their unchanged endpoint. Neither selecting nor removing an environment restores a retired legacy mutation slot.

A3 should show `pendingError` as a blocker, not interpret `pending: false` alone as safe. Queries and ephemeral provider operations on a bound environment do not require decrypting its pending storage. Pending mutations in A never block operations in B. Concurrent submissions/retries in one environment reject as already in progress; they never clear a newer command.

## Storage and validation

- `environments/registry.json`: strict, versioned, secret-free metadata. Directory existence is the initialization marker. Corruption or missing metadata in an initialized registry fails startup closed rather than replacing saved servers.
- `environments/<canonical-installation-UUID>/pending.enc`: AES-GCM encrypted with the unchanged device-derived cipher; the authenticated clear envelope and command both contain the environmentId. A same-installation route change retains pending work; cross-installation copies fail validation.
- Metadata and pending writes use private unique temporary files, file sync, atomic rename and parent-directory sync. Creation of the registry root and each UUID recovery directory also synchronizes its parent before any recovery file or pairing dispatch relies on that link; existing links are synchronized on reopen as well. The app-data directory's parent is synchronized during startup. App/environment directories use 0700 and files 0600 on Unix. Removal preserves recovery directories.
- This slice does not add replication, encrypted history caches, SSH management, failover, host installation or task handoff. It does not alter iPhone/v1 server compatibility.

## Validation boundary

Native tests use temporary directories, fixture identities and loopback HTTP fixtures that verify actual Ed25519 signatures. Coverage includes pre-upgrade legacy envelope recovery (uppercase scheme/host and default port), filesystem sync failure injection and barriers before pairing, concurrent first-use identity initialization through an injected store (including read/corruption failures), verified registry route replacement with pending work followed by restart/retry, and barrier-controlled ongoing SSE connections through replacement/disconnect/route changes/removal while another environment continues. Route cancellation and new-stream endpoint capture share one lifecycle lock; a deterministic concurrent-start test exercises the boundary between cancellation and endpoint replacement.

A Tauri mock-runtime smoke test dispatches generated native command handlers, checking camelCase decoding, omitted optional registration flags, metadata shapes, unknown-environment rejection and actual channel dispatch through the runtime interceptor. This is not a real WebView/JavaScript integration test. The existing synthetic browser administration test is a legacy compatibility check.

These HTTP services remain wire fixtures, **not actual coordinator processes**: they do not qualify server validation, real effect receipt deduplication or history isolation end to end. A1 separately tests real coordinators. The injected identity store exercises the actual initialization lock/read/create helper without accessing the OS Keychain; filesystem failure injection verifies ordering and fail-closed control flow, not a physical power-loss experiment. No owner's Keychain, live provider, SSH or production server is used. The existing live native test remains ignored.

## Legacy live-stream lifecycle

The original `stream_events({channel})` IPC now uses the same cancellable State stream implementation as `environment_stream_events`. Request preparation still chooses signed v1 for the legacy State and signed, environment-bound v2 for registered States. The new `disconnect({}) -> void` command cancels only the legacy State's current/in-flight stream; it does not affect any registered environment, pending recovery, identity or remote resource. Existing `environment_disconnect({environmentId})` semantics are unchanged. Both protocols support replacement/reconnect, cancellation while connecting and termination of established SSE sockets. JavaScript must still fence already-delivered callbacks by owner/lifecycle.
