# Plan — Syl: The Organs

**Feature**: 002-syl-organs

## Two epics, and why they are separate

`syl-005` (memory) and `syl-006` (life model + rhythm) share a database and almost nothing else. Memory is a graph with a nightly job; the life model is a small set of tables with a strict schema. They are owned by different squads and touch different files.

The seam between them was settled by the child-B proposal and it is worth restating, because it is the rule that keeps them from colliding:

> **A row is the record, a node is the handle.**
> If getting it wrong would be a **bug**, it is a column. If getting it wrong would be a **bad suggestion**, it is an edge.
> The scheduler never runs a similarity search. The dream never writes a due date.

Every life-model row projects into the graph as a node carrying `{id, type, label, ref}` and nothing more.

## Dependencies

Both epics need `syl-002` — storage, migrations, the job runner, and delivery. Neither can start until the service is real.

```
syl-002 (the service) ──┬──► syl-005  memory        ┐ parallel,
                        └──► syl-006  life + rhythm ┘ different files
```

Within the wave, `syl-006`'s rhythm jobs want memory to compose a good agenda — but not to compose *an* agenda. They degrade gracefully, so the epics do not serialise.

## File ownership

| Epic | Owns |
|---|---|
| `syl-005` | `backend/src/memory/**`, `backend/migrations/01*-memory-*.sql`, `frontend/src/features/memory/**` |
| `syl-006` | `backend/src/life/**`, `backend/src/jobs/rhythm/**`, `backend/migrations/02*-life-*.sql`, `frontend/src/features/life/**` |

Migration numbering is split by range deliberately — two squads adding sequential migrations to one directory is a guaranteed collision.

## Architecture decisions

### AD1 — Start from Claude Code's own memory, do not build a store from scratch

Claude Code ships an auto-memory system that is subscription-billed because it runs inside the binary we already drive, and it is **relocatable** via `autoMemoryDirectory`. Point it at a Syl-owned path and we have a working episodic and semantic store immediately.

It has exactly three gaps — no semantic retrieval, no consolidation on the CLI path, no structured cross-session recall. **Those three gaps are the scope of `syl-005`**, not "a memory system".

### AD2 — Two-tier dreaming: free association, then paid judgment

Tier 1 is holographic algebra ported from Hermes: roughly 200 lines, **zero model calls**, and it finds structural links with no keyword or semantic overlap. It sweeps the whole graph nightly for nothing.

Tier 2 is one subscription-billed turn that **judges** the small candidate set Tier 1 surfaced and writes the reasoning.

The alternative is instructive: the published LLM-driven approach costs about twelve model calls per memory written and fifteen hours to build a corpus.

Because the atoms derive from SHA-256, the TypeScript port is **bit-for-bit verifiable** against the Python original — the same testable-seam discipline the codec already follows.

### AD3 — Nodes are superseded. Edges fade.

Facts are retired with a validity interval on a `(subject, relation)` ledger — deterministic, no model at read time. Embedding similarity **cannot** tell stale from current; contradictions are on average *more* similar to the original than genuine duplicates are.

Inferred edges carry a weight that decays asymptotically toward zero and never reaches it. A dormant edge that becomes relevant again is boosted back.

Three forces, and the asymmetry is deliberate: **decay** when unused, **boost** when used, **suppress** when explicitly rejected.

### AD4 — Retrieval is local, and the stack is measured on this machine

Transformers.js with the ONNX runtime **pinned to 1.23.0** (1.24 dropped `darwin-x64`), EmbeddingGemma-300M quantised on WebGPU, 768 dims truncated to 256, in sqlite-vec alongside `node:sqlite`'s FTS5.

Measured on this iMac: 2,000 chunks in 45.8s, search ~1ms, and WebGPU gives a 5.3× speedup on the AMD Radeon that Ollama cannot use at all.

### AD5 — The heartbeat is mostly deterministic

A pre-check answers "does anything need attention?" before the model is ever spawned. Asking sixteen times a day costs sixteen turns to usually answer no, and gives sixteen chances to decide something is worth mentioning when it is not.

The Commander has removed the speaking cap — she interrupts freely and dials back on evidence — which makes engagement tracking **load-bearing** rather than a nicety. It is the only thing standing between "interrupt freely" and "muted permanently", and muting tends to be permanent.

## Risks

**Astrology.** A graph that fills with plausible connections is worse than no graph, because retrieval drowns. The pruning discipline and engagement measurement are the defences.

**Sophistication has an unpaid bill.** Measured in the literature: one system needs 15 hours of offline construction, another burns 7M tokens indexing where a baseline uses 1.3M, a third adds 32 seconds of user-facing latency. Error rates on memory operations rose 18%→30% with a weaker model, and **graph architectures were the most vulnerable**. We are building a graph knowingly.

**Extraction, not storage, is the weak link.** The supersession mechanism is near-perfect on clean structured facts and drops to roughly 44% on messy natural-language contradictions. That is precisely why extraction deserves a subscription turn rather than a regex.

**The homeschool state question blocks part of `syl-006`.** Record-keeping requirements vary from nothing to logged hours plus a portfolio and an evaluation record. Build the hours log regardless — it is cheap now and impossible to backfill.

## Bead Map

See `beads-import.md`.
