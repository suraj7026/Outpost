# Implementation programme

The owner requested all specifications, Soft Studio, autonomous decisions, and a commit/push after each spec increment. All 31 numbered specifications and the 270-feature map were read before implementation. The pre-existing plan, design exports, specs and mock are preserved.

## Design and decisions

- Modular TypeScript server; SQLite WAL transactions for commands, versioned records, durable events and outboxes. No hosted orchestration.
- Versioned JSON wire contracts; generated Swift wire vocabulary; signed device commands, expected revisions, idempotency and ordered replay.
- One server authority. Native Swift macOS/iOS clients use the same transport and projection. Soft Studio: Geist, Ink semantic colors, 22-point panels, 12-point controls, quiet sidebar, conversation beside evidence. Compact layouts use navigation rather than squeezed columns.
- Start in Ask permission as a conservative development choice, not an owner-approved production default. Fail closed on unqualified integrations. Never infer payment or owner identity grants from a mode.
- Separate coordinator from the worker in production. Local development is cooperative, not a claimed VM/root security boundary.
- Use Pi's pinned integration rather than another model loop. Provider credentials stay server-side. Live model IDs require qualification.
- Keep incomplete capabilities visible as unavailable with actionable reasons. A passing fixture does not mean a module or production gate is complete.

## Execution order

1. 00 architecture/setup; 28 protocol/ledger; 26 trust; 01 tasks.
2. 02 files; 03 commands; 04 admin; 05 installation; 06 browser; 07 identities; 08 assistance.
3. 09 code; 10 Git delivery; 11 operations; 12 sources; 13 documents; 14 data; 15 communication; 16 workflows; 17 payment boundaries.
4. 18 scheduling; 19 memory; 20 workers; 21 capabilities; 22 models; 23 media.
5. 24 macOS and 25 iPhone/sync; 27 recovery; 29 acceptance; 30 qualification register.

Each increment receives a scoped commit and push after checks. Feature-level status and evidence distinguish implementation, fixture verification and blocked live acceptance.

## Verification

Use deterministic Node tests for transactional/idempotency/replay invariants, revision races, policy tightening, signed requests, revoked devices, leases, budgets, path escapes, cancellation and uncertain external effects. Build shared Swift and macOS locally. Build iOS for simulator when the SDK is available. Do not call a spec complete from UI/catalogue coverage.

## External qualification limits

No owner Ubuntu host, virtualization topology, Cloud role inventory, APNs signing/topic, account scopes, eligible payment provider or distribution identity has been supplied. Do not provision accounts, charge money, run host sudo or expose a public endpoint to compensate. Live release gates require separate recorded evidence.
