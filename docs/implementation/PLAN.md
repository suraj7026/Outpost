# Implementation programme

> **Historical record — superseded for current desktop setup.** Swift Mac application/build/UI-test references below describe the earlier implementation, not a supported build path. T0a retires that app while retaining iPhone/shared code and data. Use the [Tauri desktop guide](../../desktop/README.md) and [adoption status](ADOPTION-STATUS.md) for current direction and open T0b management/recovery gaps. Evidence and original decisions below are preserved.

The owner requested all specifications, Soft Studio, autonomous decisions, and a commit/push after each spec increment. All 31 numbered specifications and the 270-feature map were read before implementation. The pre-existing plan, design exports, specs and mock are preserved.

## Design and decisions

- Modular TypeScript server; SQLite WAL transactions for commands, versioned records, durable events and outboxes. No hosted orchestration.
- Versioned JSON wire contracts; shared Swift wire vocabulary and generated feature catalogue; signed device commands, expected revisions, idempotency and ordered replay. Full generated typed protocol bindings remain future work.
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

## Implementation handoff

Scoped increments were committed and pushed for all numbered spec areas, followed by integration hardening. This is not completion of all specified behavior: see [ACCEPTANCE.md](ACCEPTANCE.md) for the module-by-module gaps and failed/unperformed release gates. [README](../../README.md) provides startup, [RUNBOOK.md](RUNBOOK.md) covers recovery, and [DECISIONS.md](DECISIONS.md) / [QUALIFICATION.json](QUALIFICATION.json) record actual pins and outstanding inputs.

Final local verification: 33 backend tests, 3 native projection/catalogue tests, Mac release build, and a passing iPhone simulator signed-HTTP UI smoke flow. Mac UI automation was blocked enabling automation mode. Live provider, Ubuntu, physical-device and release qualification remain unperformed.

## External qualification limits

No owner Ubuntu host, virtualization topology, Cloud role inventory, APNs signing/topic, account scopes, eligible payment provider or distribution identity has been supplied. Do not provision accounts, charge money, run host sudo or expose a public endpoint to compensate. Live release gates require separate recorded evidence.
