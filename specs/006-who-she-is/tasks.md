# 006 — Tasks

## Phase 1 — Container

- **T001** [P] `backend/src/ops/container.ts` — `assertContainer(home)`: refuse
  to boot if her home contains `CLAUDE.md`, `.claude/settings.json` with hooks,
  `.mcp.json`, or a beads workspace. Refuse, do not warn: a warning at boot is
  read once and never again.
- **T002** [P] `backend/src/index.ts` — call it at boot; log the directory she
  will think in, once.
- **T003** [P] `backend/tests/unit/container.test.ts` — each forbidden artefact
  refuses; a clean home passes; the message names the file and why it matters.
- **T004** `backend/tests/unit/agent.test.ts` — every lane carries her home and
  an empty tool surface. Parameterised over `LANES` so a NEW lane fails until
  someone decides, rather than inheriting silence.

## Phase 2 — Extraction

- **T005** `backend/src/memory/extract.ts` — the extraction turn: transcript in,
  schema-validated candidate facts out. Its own lane, in `MEMORYLESS_LANES`.
  Malformed output is discarded whole.
- **T006** `backend/src/memory/extract-apply.ts` — service-side write into the
  graph. Provenance on every node: the conversation it came from. Idempotent —
  re-running over the same turn writes nothing new.
- **T007** `backend/src/index.ts` — run extraction after a conversational turn
  settles, off the reply path. A failed extraction never fails his answer.
- **T008** `backend/tests/unit/memory-extract.test.ts` — happy path, malformed
  output discarded whole, declining to extract is normal, idempotence.
- **T009** `backend/tests/integration/remembers.test.ts` — the story: tell her a
  fact, run extraction, ask in a FRESH session, she knows it. This is the one
  test that proves the whole epic.

## Phase 3 — Deletion (`syl-eg3`)

- **T010** `backend/src/memory/forget.ts` — explicit deletion: node, edges,
  **reasoning text**, and the bi-temporal ledger history. Reachable only from an
  explicit instruction.
- **T011** Audit record of what was deleted, when, on whose instruction. A
  deletion nobody can audit is indistinguishable from data loss.
- **T012** `backend/tests/unit/memory-forget.test.ts` — the delete reaches the
  reasoning text and the closed ledger rows; every automatic path still cannot
  delete an inferred edge (the trigger test stays green).

## Phase 4 — Personality

- **T013** `backend/tests/acceptance/who-she-is.test.ts` — against a REAL turn:
  asked who she is, she does not mention SOUL.md, CLAUDE.md, this repository,
  beads, or her own configuration.
- **T014** Empty memory reads as early, not broken or invented.
- **T015** Contradicted by him, she takes his word and names the stale memory.
