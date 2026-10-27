# Shared protocol, data and execution contracts

Status: **proposed Outpost contracts**, 27 October 2026. No endpoint, tool, table or event name here should be mistaken for a shipped API or upstream Pi method. Finalize versioned schemas and migrations before implementing clients independently.

## Ownership

All durable business records live on Ubuntu. Swift clients store device credentials and rebuildable projections, plus device-local presentation preferences. Pi’s finalized session data remains behind a pinned adapter; Outpost owns the product ledger and mapping. Protected broker/audit/vault storage may be separate from the task database; it is still on the same physical server and outside guest root where enforcement is claimed.

Logical entities below are not a finalized SQL schema. Choose foreign keys, indexes, constraints, retention and transaction boundaries during storage implementation.

| Record family | Essential fields and invariant |
|---|---|
| Owner/devices | Owner ID, device ID/public key, capabilities, paired/revoked time; no command from a revoked device is accepted. |
| Tasks/runs | Task ID, project/profile, requested outcome, run ID, state/revision, selected identity and policy binding; one accountable executor per mutable run. |
| Instructions/messages | Immutable ID, task sequence, author/provenance, accepted time, content/artifact refs and revision; draft tokens do not become another final message. |
| Pi session mapping | Task/run, Pi session/branch, adapter/schema version, last finalized mapping/checkpoint; explicit reconciliation if stores diverge. |
| Action proposals | Operation/action ID, canonical tool arguments, target, identity, effects, scope, digest, expiry and expected policy version. |
| Policies/reviews | Workspace/task binding, mode, version, issuer, constraints; reviewer role/model/qualification, action hash, allow/ask and concise rationale. |
| Approvals/decisions | Request ID, immutable action/workflow digest, nonce, expiry, state, valid signed resolution and device; first valid resolution wins. |
| Grants/identities | Agent-versus-owner classification, provider identity, scope, origin/profile, issuer/expiry/revocation and opaque secret ref. |
| Browser state | Session/profile/task/identity, tab IDs, observation revision, process health and one current input lease. |
| Artifacts | Opaque ID/version/hash, producer run/step, MIME/size, source lineage, verification, storage ref and retention. |
| Payment workflows | Workflow/mandate ID, cart/items hash, merchant/account, total limit/currency, recurrence, included steps, expiry, status and signature. |
| Payment execution | Budget reservation, operation key, provider attempt/order ID, auth/unknown/confirmed/settled state, receipts and adjustments. |
| Automations | Recipe/version, schedule/timezone, occurrence key, task scope/identity/mode, budget and notification intent; no duplicate occurrence claim. |
| Inbox/push | Server notice ID/revision, related record, resolved state, per-device delivery/read status, outbox/attempt ID and APNs response. |
| Memory/indexes | Source/owner/account/project, confirmed/inferred status, revision, supersession/tombstone; derived indexes do not create authority. |
| Audit/backup | Intent, authority, decision, dispatch, observed result, evidence refs; protected record plus verified backup manifest. |

## Command envelope

Use a versioned authenticated command format. Example field names and UUIDs are illustrative:

```json
{
  "protocolVersion": 1,
  "commandId": "cmd-demo-001",
  "idempotencyKey": "device-A:request-42",
  "deviceId": "device-A",
  "type": "task.steer",
  "taskId": "task-demo-001",
  "expectedRevision": 18,
  "payload": { "text": "Include the invoice sources in the report." }
}
```

The server authenticates device and owner, validates schema and expected revision, records command acceptance and an outbox/event atomically, then acknowledges with command/operation IDs and resulting revision. Acknowledged means accepted, not done. Repeating the same idempotency key with the same payload returns the same command result; a changed payload under the key is a conflict. The server, not client clocks, controls acceptance and expiry.

Proposed command families:

- Tasks: create, steer, pause, cancel, resume, fork and inspect.
- Policy: inspect/change workspace default or explicit task binding, with expected version.
- Approvals/workflows: request details/challenge, submit signed approve/deny, revoke a workflow/grant.
- Browser: request takeover, input under lease and return control.
- Artifacts: begin/complete upload, inspect/download/share/export.
- Accounts/devices: connect/request scope, revoke, pair and register/replace push tokens.
- Automations/memory: create/edit/pause/run or confirm/correct/forget, each versioned.

A client may show a locally queued intent but must not execute or mark it complete until the server accepts and emits an outcome. Do not queue offline payment approval as a still-current signature.

## Durable event envelope

```json
{
  "protocolVersion": 1,
  "eventId": "evt-demo-901",
  "feedCursor": "cursor-demo-901",
  "taskId": "task-demo-001",
  "taskSequence": 19,
  "aggregateRevision": 19,
  "type": "instruction.accepted",
  "operationId": "op-demo-002",
  "occurredAt": "2026-10-27T17:00:00Z",
  "payload": { "instructionId": "instruction-demo-004" }
}
```

Provide task-local ordering plus an owner/inbox feed cursor. Clients subscribe to active feeds and fetch missed records after foreground/reconnect, including tasks they had not opened. Commit order and aggregate revision determine projection; wall-clock display time does not resolve races.

Snapshots include schema/protocol version, represented cursor and record revisions. Replay events after that cursor, deduplicate by event ID and resnapshot if the cursor is expired or a gap cannot be repaired. Define cursor retention and pagination explicitly; never silently skip a gap.

Keep ephemeral model tokens, progress samples and browser frames separate from durable facts. Backpressure may drop superseded transient updates; it cannot silently drop accepted instructions, approvals, payment state or artifact publication. A committed final message replaces its identified draft stream rather than creating a second copy.

## Action envelope and mode evaluation

Every actual work action, including reads and nested tools, enters a normalized proposal:

```json
{
  "actionId": "action-demo-017",
  "taskId": "task-demo-001",
  "runId": "run-demo-003",
  "tool": "command.run",
  "arguments": { "argv": ["git", "status", "--short"], "workspaceRef": "workspace-demo" },
  "target": { "machineId": "outpost-01", "resourceRef": "workspace-demo" },
  "identityRef": "agent-local",
  "effectClasses": ["workspace.read"],
  "policyVersion": 7,
  "actionDigest": "canonical-digest-placeholder",
  "expiresAt": "server-issued-expiry"
}
```

Canonical serialization/digests, executable/environment resolution, file hashes and request size limits must be specified in code/schema, not left to arbitrary JSON object order. Resolve a typed target and effect; a friendly command label is not authority. Shell/HTTP/browser adapters cannot skip this boundary because they are invoked through MCP or a specialist child.

Evaluation order:

1. Authenticate caller and validate current task/resource/identity scope, expiry and deterministic restrictions.
2. Match any required owner trust grant and payment-workflow mandate.
3. Full control dispatches ordinary scoped work; Auto requests a smaller-model classification; Ask permission creates a persistent exact action request.
4. Before actual dispatch, recheck current version/digest/expiry and atomically claim the operation.
5. Record observed execution and independent verification; reconcile uncertain external outcomes.

A mode change is a server-owned revisioned command. Tightening authority affects the next action boundary and queued operations that have not started; it does not roll back already executed effects. On reviewer uncertainty/outage/invalid response create an owner request. Do not accept another policy revision or a substituted target because the old proposal had an allow decision.

Proposed reviewer result:

```json
{
  "actionDigest": "same-canonical-action-digest",
  "policyVersion": 7,
  "decision": "ask",
  "summary": "This changes service state outside the current task scope."
}
```

Record the actual qualified reviewer role/model and request ID server-side. Output validation is local; a model’s self-declared certainty or a text mention of “approved” is not a valid decision. Deterministic scope failure blocks; it does not ask the reviewer to invent more authority.

## Approval and payment signatures

The server issues a one-use challenge bound to owner/device, request ID, canonical action or workflow digest, current scope/policy, nonce and expiry. Current device authentication protects a signing operation; the server verifies the decision/signature. A client boolean such as `biometricPassed` does not establish authorization.

Approve/deny is a compare-and-set from pending to one resolved outcome. Concurrent decisions return the recorded outcome to the losing device. Changed requests require new challenges. Separate actor decision, dispatch and result; approval does not mean a push, sudo command or payment already succeeded.

A payment workflow mandate additionally binds merchant/payee, purpose, items/account, funding alias, delivery, total limit/currency, recurrence and allowed steps. Routine included steps need no repeat prompt. Budget reservations and operation keys prevent concurrent use from exceeding the mandate; material changes require renewed owner authorization. Required bank/issuer user-presence is its own wait state. Settlement/refund/reconciliation is not inferred from a checkout click.

## Run and operation states

Proposed run states:

`queued → running → waiting_for_approval | waiting_for_login | waiting_for_human | waiting_for_payment_auth | waiting_for_capacity → running → verifying → completed`

Additional outcomes: `paused`, `cancelled`, `failed`, `interrupted`, `reconciling`. Define allowed transitions and expected versions. A task can have multiple runs; do not overwrite a prior failure history with a retry’s final text.

External operation states include `intent_recorded`, `authorized`, `dispatching`, `observed_succeeded`, `observed_failed`, `unknown`, `reconciling`, `verified`. Cancellation/revocation may prevent future dispatch without undoing already sent requests. Exactly-once delivery over arbitrary websites is not promised; operation-specific reconciliation is required.

## Browser lease and artifacts

Browser takeover uses a server lease carrying session/profile/task, device or agent owner, lease/version, expiry and allowed input. Re-observe after navigation, takeover/return or recovery. A non-owner input is rejected; expired device control does not immediately authorize blind agent continuation.

Browser frames are ephemeral and credential-masked where required. A saved screenshot becomes an artifact with source URL/session/observation and retention. Downloads, generated documents and changed-file evidence use opaque artifact IDs, hashes and authenticated range/resume support. Both clients address the same server version, never a path on the other device.

## APNs and inbox contract

Inbox creation, underlying business-event commit and notification outbox insertion are transactionally related. Delivery is asynchronous and deduplicated by notice/device/category. Store APNs topic/environment/token references separately from the approving device key; rotate tokens and stop sending to invalid/revoked registrations.

A push carries an opaque notice/deep-link reference and privacy-preserving text. On opening or foregrounding, fetch the current notice and replay from the stored cursor. A notice may already be resolved, expired or revoked. Push acknowledgement, delivery, owner read and approval are distinct states. Optional Live Activity updates do not become authoritative task state.

## Versioning and verification

Generate Swift/TypeScript schema bindings from a language-neutral contract and keep fixture envelopes in repository tests. Negotiate supported protocol versions/capabilities; reject unsafe unknown commands and resnapshot incompatible projections. Version database migrations, capability manifests and Pi event adapters independently.

Required contract checks include two-device replay convergence, idempotent command retries, stale revisions/digests/signatures, mode tightening races, reviewer fail-to-ask, browser input races, upload integrity and post-charge/provider timeout reconciliation. Tests must examine effects and server records, not just mirror reducer implementations.

Primary references: [Pi SDK](https://pi.dev/docs/latest/sdk), [SQLite transactions](https://www.sqlite.org/lang_transaction.html), [Apple LocalAuthentication](https://developer.apple.com/documentation/localauthentication), [Apple remote notifications](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server). These inform the design; the envelopes and endpoint names above are Outpost proposals.
