# 004 — Plan

## Architecture decisions

### D1 — Extraction is a service capability, never a tool on her turn

The model **judges** what is worth remembering; the service **writes** it. This
is the project's governing principle ("the service holds the guarantees, the
model holds the judgment") applied to memory, and it is the same shape as the
delivery guarantee: a model can decline to call a tool, so delivery is persisted
and retried rather than trusted to a turn.

Rejected: turning tools back on so Claude Code's auto-memory works. It would
restore the engineer — the tools are a large part of how a model infers what it
is for — and it puts a write path inside a turn that also reads untrusted text.

### D2 — Extraction is its own turn, on its own lane

Not folded into the conversational turn. Three reasons: the conversational turn
must stay fast and must not spend tokens deciding what to file; a failed
extraction must not fail his answer; and the extraction turn can be given a
narrow, schema-validated output contract while the conversational one cannot.

New lane `extraction`, added to `MEMORYLESS_LANES` — it must not write Claude
Code's own memory any more than the dream does.

### D3 — Extraction output is schema-validated or discarded

Same discipline as `runReaderTurn`. A malformed extraction is dropped with a log
line, never partially applied. Partial application is how a graph acquires facts
nobody said.

### D4 — The container is asserted at boot, not documented

`assertContainer(home)` runs at startup and refuses to boot on a container that
would re-create the engineer. A comment saying "do not put a CLAUDE.md here" is
not a mechanism.

## Phases

| Phase | Sub-epic | Delivers |
|---|---|---|
| 1 | Container | Her home is provably clean, and stays clean |
| 2 | Extraction | Conversation becomes graph, through the service |
| 3 | Deletion | His explicit order removes a memory outright |
| 4 | Personality | Verified against real turns, not asserted |

Phase 1 and Phase 2 are independent and run in parallel. Phase 3 depends on
nothing here. Phase 4 depends on 1 and 2 — verifying a personality before the
container is clean and memory accumulates would test the wrong thing.

## Files

- `backend/src/ops/container.ts` — new. `assertContainer`, `describeContainer`.
- `backend/src/index.ts` — boot assertion, extraction wiring.
- `backend/src/memory/extract.ts` — new. The extraction turn and its schema.
- `backend/src/memory/extract-apply.ts` — new. Service-side write.
- `backend/src/harness/agent.ts` — the `extraction` lane.
- `backend/src/memory/forget.ts` — new. Explicit deletion (`syl-eg3`).
- `backend/src/migrations/0018_*.sql` — only if deletion needs an audit table.
- `backend/tests/acceptance/who-she-is.test.ts` — new. US4, against real turns.

## Bead Map

Root is `syl-010`, not `syl-009`. `syl-009` was taken by "Syl 9: the hands",
being built concurrently — our `bd create` calls interleaved and beads assigned
IDs from their root. Three of mine landed inside their epic and were closed and
recreated here; their structure was not otherwise touched. **Do not create into
a root another agent is actively building.**

- `syl-010` — Who she is: personality, memory, and the container
  - `syl-010.1` — Container
    - `.1.1` assertContainer · `.1.2` assert at boot · `.1.3` every lane
  - `syl-010.2` — Extraction
    - `.2.1` the turn · `.2.2` service-side write · `.2.3` after the reply · `.2.4` Monday→Friday
  - `syl-010.3` — Deletion (`syl-eg3`)
    - `.3.1` reaches reasoning + ledger · `.3.2` audit and confirm
  - `syl-010.4` — Personality *(depends on .1 and .2)*
    - `.4.1` answers as herself · `.4.2` empty reads as early · `.4.3` takes his word

## Sibling epic

`syl-009` — "the hands" — gives her the ability to ACT: create a reminder rather
than only discuss one. **This epic is who she IS; that one is what she can DO.**
They meet at the commander lane and must not collide: nothing here adds a tool to
her turn, and that epic adds a narrow, named MCP surface rather than restoring
the built-ins.
