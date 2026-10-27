# 07. Agent and owner identities

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **ID-01 through ID-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Give the operator its own accounts by default and carefully scoped access to the owner’s accounts when a task requires them.

## What the owner sees

Every task/browser/action identifies agent versus owner identity. The owner creates the dedicated accounts; the product connects them and can connect selected owner sessions or credentials. There is no silent escalation to an owner account.

## Responsibility and boundary

Identity inventory; OAuth/device flows; protected secret references; selected Chrome bridge/import; session leases; MFA/user-presence handoff and revocation.

Dependencies: [06 Headless browser and live takeover](06-headless-browser.md), [08 Verification challenges and human assistance](08-verification-and-human-assistance.md), [24 Swift macOS client](24-swift-macos-client.md), [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| ID-01 | Account inventory | Show connected services, account identity, scopes, profile location, last use, expiry, and whether an identity is broker-protected or delegated to the machine. | C |
| ID-02 | OAuth and delegated access | Prefer official OAuth/device flows and narrow service credentials where supported; separate read, draft, send, admin, and billing privileges. | C |
| ID-03 | Fresh server login | Open a selected account in the protected server browser and let the owner sign in; persist only the state required for the delegated workflow. | C |
| ID-04 | Local Chrome companion | Consent-based Mac bridge for selected local tabs or an approved browser session; visible connection indicator, short lease, revocation, and no open public debugging port. | E |
| ID-05 | Selected credential migration | Preview and approve chosen account credentials, transfer them encrypted to a protected vault, and report exactly what was imported; avoid an automatic whole-password-store export. | E |
| ID-06 | Selected session transfer | Copy supported origin-scoped session state only after explicit review; record expiry and source; detect reauthentication requirements rather than promise transparent cross-OS login. | E |
| ID-07 | Secret-use requests | Resolve opaque secret references for an approved origin/purpose; keep plaintext out of Pi prompts, ordinary logs, task files, screenshots, and shell history wherever the broker controls them. | C |
| ID-08 | MFA, OTP, and passkeys | Hand off user presence, hardware key, passkey and financial challenges; support narrow one-time code input without storing authenticator recovery material in the agent home. | C |
| ID-09 | Account lifecycle | Refresh scoped tokens, detect logout/expiry, revoke grants, disconnect accounts, rotate exposed credentials, and show affected tasks. | C |
| ID-10 | Agent-first identity separation | Default to dedicated agent-owned accounts created by the owner; support separately scoped owner identities, explicit selection per task and no silent fallback to a more privileged owner account. | C |

## How to build it

1. Model ownership separately from provider: an agent-owned GitHub identity and an owner GitHub identity are different resources, even at the same origin. Bind the chosen identity to each task operation and browser profile.

2. Prefer supported scoped OAuth/device authorization or a fresh server-browser login. Store credentials encrypted under protected host services and hand Pi opaque action handles rather than plaintext secrets.

3. Add explicit selected-session Chrome attachment and selected credential import through the trusted Mac client. Inventory origins, expiry, passkey limitations and logout behavior; make revoke/rotate visible on both clients.

## Data and integration contracts

**Server-owned records:** identities; account_connections; secret_refs; account_grants; origin_profiles; credential_imports.

**Proposed Pi/tool or client command surface:** `identity.list; identity.request; account.connect; account.revoke; credential.import_selected; chrome.attach_selected`.

**Proposed durable events:** `identity.connected; scope.requested; scope.granted; login.required; identity.expired; identity.revoked`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Connecting/expanding an owner identity requires the owner’s scope decision; Auto cannot decide to substitute it for an agent account.
- Treat cookie, password, OAuth and passkey transfer as separate capabilities; do not assume Chrome profile portability or arbitrary private-key export.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Expired credentials pause only the dependent work and create a durable login request. Revocation invalidates future broker use and browser leases, then records any already completed effects that cannot be undone.

## Acceptance and proof

- Complete a task as the agent identity; switch to a selected owner account only after a visible scoped grant.
- Create no real accounts automatically during the connection mock/spike; test credential intake with fixtures first.
- Revoke on iPhone, verify Mac state updates, and prove subsequent protected use fails without leaking secrets into logs, frames or model context.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [OAuth security best current practice](https://www.rfc-editor.org/rfc/rfc9700.html)
- [Chrome DevTools connection](https://developer.chrome.com/docs/devtools/agents/get-started/configuration)
- [Chrome debugging profile changes](https://developer.chrome.com/blog/remote-debugging-port)
- [Local t3code browser import reference](../../t3code/docs/user/browser-import.md)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
