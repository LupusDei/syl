# Beads — Syl: The Organs

Two root epics, 42 beads. Both depend on `syl-002` (the service) and run in parallel with each other.

```
syl-002 (the service) ──┬──► syl-005  memory and the second brain    21 beads
                        └──► syl-006  the life model and the rhythm  21 beads
```

---

## `syl-005` — Memory and the second brain

| Bead | Title |
|---|---|
| `syl-005.1` | **Foundation: the stores** |
| `syl-005.1.1` | Memory schema, node ids, partition key |
| `syl-005.1.2` | Point auto-memory at a Syl-owned path |
| `syl-005.1.3` | Source store with provenance and retention class |
| `syl-005.2` | **Retrieval** |
| `syl-005.2.1` | Local embeddings |
| `syl-005.2.2` | Hybrid store: sqlite-vec plus FTS5 |
| `syl-005.2.3` | Fusion scoring with trust and decay |
| `syl-005.3` | **The graph** |
| `syl-005.3.1` | Nodes and the two species of edge |
| `syl-005.3.2` | Edge weights: decay, floor reactivation, suppression |
| `syl-005.3.3` | Supersession ledger |
| `syl-005.4` | **Dreaming** |
| `syl-005.4.1` | Holographic engine port |
| `syl-005.4.2` | Tier 1: the nightly sweep |
| `syl-005.4.3` | Tier 2: the judgment turn |
| `syl-005.5` | **Working memory** |
| `syl-005.5.1` | Working memory projection |
| `syl-005.6` | **Inspection** |
| `syl-005.6.1` | Memory viewer in the admin |

## `syl-006` — The life model and the daily rhythm

| Bead | Title |
|---|---|
| `syl-006.1` | **Core domain** |
| `syl-006.1.1` | Goal and objective schema |
| `syl-006.1.2` | To-dos, distinct from reminders |
| `syl-006.1.3` | People and events |
| `syl-006.2` | **Progress and risk** |
| `syl-006.2.1` | Evidenced progress |
| `syl-006.2.2` | Risk signals and escalate-once |
| `syl-006.3` | **Homeschooling** |
| `syl-006.3.1` | Learners and the objective DAG |
| `syl-006.3.2` | Mastery and review scheduling |
| `syl-006.3.3` | Hours log |
| `syl-006.4` | **The daily rhythm** |
| `syl-006.4.1` | Heartbeat with a deterministic pre-check |
| `syl-006.4.2` | Morning agenda |
| `syl-006.4.3` | Evening review |
| `syl-006.5` | **Engagement** |
| `syl-006.5.1` | Engagement tracking and automatic demotion |
| `syl-006.6` | **Surfaces** |
| `syl-006.6.1` | App views over the life model |
| `syl-006.6.2` | Admin views over the life model |

---

## Cross-epic gates

```
syl-005.1.*, syl-006.1.*   ←  syl-002.1.2   (storage and migrations)
syl-006.4.1                ←  syl-002.3.1   (the job runner)
syl-006.5.1                ←  syl-002.2.2   (the delivery outbox — engagement is recorded against it)
```

The morning agenda is deliberately **not** hard-dependent on memory. It is better with it and must not be broken without it — an agenda from the life model alone is worse, not absent. Recorded in the bead rather than wired, because a dependency that only improves quality is not a blocker.

## File ownership

| Epic | Owns |
|---|---|
| `syl-005` | `backend/src/memory/**`, `backend/migrations/01*-memory-*.sql`, `frontend/src/features/memory/**` |
| `syl-006` | `backend/src/life/**`, `backend/src/jobs/rhythm/**`, `backend/migrations/02*-life-*.sql`, `frontend/src/features/life/**`, `ios/Syl/Features/Life/**` |

**Migration numbering is split by range on purpose.** Two squads appending sequential migrations to one directory is a guaranteed collision, and it is the kind that only shows up at merge time.

## Blocked on the Commander

`syl-006.3.1` cannot be built without knowing **how many children, what ages, and which curriculum**. The prerequisite graph cannot be constructed without knowing what it is a graph of, and a model's guess at a generic curriculum is not good enough for his children's education.

Filed separately; `syl-006.3.3` (the hours log) proceeds regardless, because it is cheap now and impossible to backfill.
