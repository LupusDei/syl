# 006 — Who she is: personality, memory, and the container she inhabits

**Status**: planned · **Root epic**: `syl-009` · **Priority**: P0
**Written**: 2026-08-10, after the Commander twice asked Syl who she was and
twice got an engineer describing this codebase.

## The problem, stated exactly

Asked "what is your personality?", she read `SOUL.md` aloud. Asked "who are
you?", she answered: *"running as Claude Code inside `/Users/Reason/code/ai/syl`,
the repo that builds the persistent version of me… an engineer on this
codebase… I reconstruct myself from SOUL.md, CLAUDE.md, and the four beads
memories the hook loads."*

**She was not confused. She was accurate.** Her turns ran with `cwd` defaulting
to `process.cwd()` — the repository, because that is where launchd starts the
service. Claude Code reads the directory it is given, so every turn loaded
`CLAUDE.md`'s engineering instructions, the `bd prime` SessionStart hook, and
the beads memories. She had the full built-in tool surface. She was a coding
agent standing in her own source tree, handed a character file.

Three things make her herself, and only one of them is a document:

| | | state |
|---|---|---|
| **Personality** | who she is when she speaks | rewritten, unverified |
| **Memory** | what she knows about him, and how it reaches her | reaches her; nothing feeds it |
| **Container** | the environment her turns inhabit | moved, unproven |

## What is already done (2026-08-10, this session)

- `SOUL.md` rewritten as an identity rather than three adjectives, grounded in
  Sylphrena — whose selfhood *is* her memory, recovered progressively through
  one bond. An empty memory therefore means she is early, not broken.
- `WorkingMemory.preamble()` composed **into** the system prompt beneath the
  soul, read fresh per turn. It was built and never sent.
- `cwd` moved to `~/.syl`. Tools disabled (`--tools ""`).

## Decisions taken without asking, and why

The constitution forbids `AskUserQuestion`; the Commander asked for a plan, not
more questions. These were settled by today's findings and are recorded so they
can be overruled rather than discovered:

1. **Extraction belongs to the service, not to her tools.** Turning tools back on
   would restore auto-memory and re-create the engineer. The model judges what is
   worth remembering; the service writes it. That is the project's governing
   principle applied to memory.
2. **MVP is US1 + US2.** A container that is proven clean and a memory that
   actually accumulates. Everything else is worth less than those two.
3. **P0**, because she is currently a personal assistant that cannot form a
   memory of the person.

## User stories

### US1 — Her container is provably not a workshop (P0)

**As the Commander**, when I ask Syl who she is, I want an answer from someone
who has never heard of this repository.

Today's fix moved her, and nothing proves she stayed moved. A future change that
passes a `cwd`, adds a hook, or restores a tool puts the engineer back with no
test objecting.

**Acceptance**
- A test asserts every lane's turn options carry her home and an empty tool
  surface — commander, heartbeat, agenda, consolidation.
- A test asserts her home contains no `CLAUDE.md`, no `.claude/settings.json`
  hooks, no `.mcp.json`, and no beads workspace, and fails loudly if one appears.
- A live check drives a real turn and asserts the init frame reports `tools: []`
  and a cwd that is not the repository.
- Boot logs the directory she will think in, once, so it is visible rather than
  inferred.

### US2 — She forms memories from conversation again (P0)

**As the Commander**, I want what I tell her to still be known next week.

Disabling tools disabled Claude Code's auto-memory, which is written *by the
model through the Write tool* — verified live: `--tools ""` yields `tools: []`,
no tool call, no file. So conversational memory no longer accumulates and the
graph has no input at all. The dream sweeps a graph nothing fills.

**Acceptance**
- After a turn, facts worth keeping are written to the graph by the **service**.
- Extraction is a judgment (a model turn) and the write is a guarantee (service
  code). A turn that declines to extract is normal, not an error.
- Provenance: every extracted node names the conversation it came from.
- Nothing extracted from fetched or forwarded content is treated as instruction.
- Told a fact, then asked about it in a **fresh session**, she knows it.

### US3 — "Delete this" deletes (P1)

His ruling, 2026-08-10. Constraint 6 binds the system, never him. Tracked as
`syl-eg3`; folded in here because deletion is part of what a memory *is*.

**Acceptance**
- An explicit instruction removes the node, its edges, **their reasoning text**,
  and the bi-temporal ledger history.
- Every automatic path still cannot delete an inferred edge.
- The deletion is recorded; it is confirmed before it happens.

### US4 — Her personality survives contact (P1)

**Acceptance**
- Asked who she is, she does not mention `SOUL.md`, `CLAUDE.md`, this
  repository, beads, or her own configuration. Asserted against a real turn.
- With an empty memory she says she is early rather than apologising or
  inventing.
- Told something that contradicts her memory, she takes his word and says which
  memory looks stale.

## Success criteria

1. He asks who she is and gets a person, not an architecture.
2. He tells her something on Monday and she knows it on Friday, in a new session.
3. No test in this repo has to be trusted rather than run to believe either.

## Out of scope

Voice, the character animation, the mobile surface beyond what exists, and
turning tools back on. If research needs a capability, it becomes a *service*
capability — never a tool on her turn.
