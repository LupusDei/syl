# Plan — Syl: The Bones

**Feature**: 001-syl-bones

## Architecture decisions

### AD1 — Monorepo, mirroring Adjutant

We are borrowing heavily from Adjutant, and matching its shape makes every port a copy rather than a translation.

```
syl/
  backend/          Node 22 + TypeScript service
    src/harness/    the existing protocol/session/agent/schedule code, moved
    src/services/   stores, APNs, websocket, jobs
    src/routes/     HTTP surface
    migrations/     .sql files
  frontend/         web admin — Vite + React
  ios/              SylKit (SPM, zero deps) + the app target
  shared/           THE CONTRACT — OpenAPI spec, generated TS types, fixtures
  specs/            these documents
```

The existing `src/` moves wholesale into `backend/src/harness/`. It is proven code with 49 tests; it should move, not be rewritten.

### AD2 — The contract is an artifact, not a convention

`shared/openapi.yaml` is the source of truth. From it:

- **TypeScript types** are generated, consumed by both `backend/` and `frontend/`
- **Swift types** are hand-written in `SylKit` and pinned by contract tests — there is no trustworthy generator worth the dependency for a surface this size
- **Shared JSON fixtures** in `shared/fixtures/` are decoded by *both* the TS and Swift test suites

That last point is the one that actually prevents drift. A spec both sides ignore is decoration; a fixture both sides must decode is a gate.

### AD3 — A mock server is a first-class deliverable

`shared/mock/` serves the contract with realistic fixtures. Web and mobile develop against it from day one and never wait for the backend.

This is what converts "three tracks in principle" into "three tracks in fact."

### AD4 — Harness hardening runs in parallel from the start

Four defects and gaps in existing code — no turn timeout, one session file shared by every job, session id learned rather than assigned, and `bypassPermissions` as a default — depend on nothing. They are the ideal work to run while the contract is being written.

### AD5 — Local-first on the client, authoritative on the server

The device renders from disk and syncs. The server owns truth. Reconciliation is by client-generated idempotency key. This is the one genuinely new build in the mobile track — Adjutant has no local database to copy.

### AD6 — Delivery never touches the model

Reminder delivery is: read the due row, write the outbox row, push. No subprocess. Composition happens at creation time, in Syl's voice; delivery is mechanical.

## Phases and parallelism

```
  P1 Setup ──────┐
                 ├──► P3 Harness hardening ─────────────────┐
                 │                                          │
                 └──► P2 Contract ──┬──► P4 Backend ────────┼──► P8 Integration
                                    ├──► P5 Web admin ──────┤
                                    ├──► P6 Mobile app ─────┤
                                    └──► P7 Connections ────┘
```

**Serial, and genuinely blocking:** P1 then P2. Everything downstream is parallel.

- **P1 Setup** — one agent. Restructuring directories concurrently is a merge disaster.
- **P2 Contract** — one agent, and it should be the most careful one. Everything is measured against this.
- **P3 Harness** — can start immediately alongside P2; touches only existing `backend/src/harness/`.
- **P4 / P5 / P6 / P7** — four agents, four directories, no shared files.

### Worktree isolation

Per the constitution, every concurrent agent that edits files uses `isolation: "worktree"`. The tracks touch disjoint directories, so merges should be clean; the contract in `shared/` is read-only to P4–P7 once published.

## Task-to-file map

| Phase | Owns these paths |
|---|---|
| P1 | repo root, `package.json`, `tsconfig.base.json`, `.github/workflows/` |
| P2 | `shared/**` |
| P3 | `backend/src/harness/**` |
| P4 | `backend/src/{services,routes,migrations}/**` |
| P5 | `frontend/**` |
| P6 | `ios/**` |
| P7 | `backend/src/connections/**` |

No two phases write the same file. That is the property that makes the parallelism safe, and it should be preserved as tasks are refined.

## Risks

**The contract is wrong.** Most likely failure. Mitigated by writing it against the six child proposals rather than inventing it, and by building the mock first — a contract you can call is a contract whose gaps you notice.

**Node 22 breaks something.** The upgrade is a prerequisite for both memory and the job system, and Node 20 is end-of-life. Doing it in P1, before three tracks are in flight, is the cheap moment.

**Mobile outruns the backend.** Likely, since the mock removes the dependency. Acceptable — contract tests catch divergence, and the app being ahead is a better problem than the app being blocked.

**Scope creep into the organs.** The temptation will be to build "just enough" memory or life model. Resist. The skeleton has to hold weight first.

## Bead Map

**Four root epics, not one.** The original plan put everything under a single epic; the Commander corrected it, on operational grounds I had missed: a squad owns an epic, so one epic means nothing can be handed off cleanly.

```
syl-001  Bones and the API contract       18 beads   serial, blocks everything
   ├──►  syl-002  The service             21 beads   ┐
   ├──►  syl-003  The mobile app          12 beads   ├─ parallel behind the mock
   └──►  syl-004  The web admin            8 beads   ┘
```

**59 beads.** Full map in `beads-import.md`.

The handoff point is `syl-001.2.5`, the mock server. Before it, one squad. After it, four.

### One thing worth knowing about `bd`

Sub-epic dependencies **do not cascade to their children**. Wiring `syl-002` to depend on `syl-001` looks right and does nothing for `syl-002.1.4` — `bd ready` was offering the local-first store before the contract existed. Blocking has to be wired at task level.

Verified after the fix: exactly one task is ready, `syl-001.1.1`.
