# Syl — The Organs

**Feature**: 002-syl-organs
**Status**: Planned
**Priority**: P0
**Follows**: 001-syl-bones

## Summary

The skeleton delivers a reminder. The organs make Syl worth talking to.

Two epics, and they are the two the Commander named when he said to get the bones in first and then start on the memory and the life model:

- **`syl-005` — Memory and the second brain.** The graph that dreams.
- **`syl-006` — The life model and the daily rhythm.** What she keeps track of, and when she speaks.

## Why these two, in this order

Memory is the differentiator. Every assistant has a to-do list; almost none has a memory that compounds. It is also the piece with the most design already settled — the four stores, the two-tier dreaming engine, the edge weights that fade but never die.

The life model is what the rhythm has to talk *about*. A morning agenda with no goals behind it is a calendar readout. The two are separable but not independently useful, which is why the rhythm jobs live with the life model rather than in their own epic.

Both depend on `syl-002` — they need storage, the job runner, and delivery to exist.

---

## `syl-005` — Memory and the second brain

### US1 — She remembers him (P0)

**As** the Commander, **I want** Syl to know things about me without being told twice, **so that** she is a colleague rather than a form.

- Facts survive across sessions and are recalled unprompted where relevant
- Working memory is loaded into every turn, so she arrives already knowing who he is
- A fact that changes is superseded, not duplicated — and the old value remains answerable ("what did I believe in March?")

### US2 — She reads what he cannot (P0)

**As** the Commander, **I want** to send Syl an article, a thread or a book and have the knowledge become mine, **so that** I stop accumulating things I will never read.

- Ingested content lands in memory with provenance and a retention class
- A book becomes memory through a resumable ladder, not one enormous turn
- Recall works as if he had read it — not "here is a summary" but "you know this"

### US3 — She dreams (P0)

**As** the Commander, **I want** Syl to form connections between memories while I am not talking to her, **so that** she notices things I would not.

- A nightly pass seeds from the day and searches the whole graph for resonance
- Connections carry their reasoning, so "why do you think that?" is always answerable
- Unused connections fade toward zero without ever reaching it; a dormant one that becomes relevant again is boosted back to prominence
- **Nothing in the graph is ever destroyed**

### US4 — We can see inside it (P1)

**As** whoever is tuning her, **I want** to inspect the graph, **so that** the memory can be corrected rather than merely trusted.

---

## `syl-006` — The life model and the daily rhythm

### US5 — She keeps him on track (P0)

**As** the Commander, **I want** Syl to hold my goals, objectives and commitments, **so that** I stop holding them myself.

- Goals decompose into objectives and to-dos; progress is **evidenced, not estimated**
- A goal at risk is escalated once, early, and plainly — not nagged daily
- A goal can be **abandoned honourably**, and reactivating it restores its history

### US6 — She has a daily rhythm (P0)

**As** the Commander, **I want** a morning agenda and an evening review, **so that** the day has a shape.

- The agenda is composed fresh, in her voice, from the life model and memory
- The heartbeat notices things between the fixed points
- **Most heartbeats never reach the model** — a deterministic pre-check answers "does anything need attention?" first
- Silence is a valid outcome and must read as success, not as failure

### US7 — She helps him teach his children (P1)

**As** a homeschooling father, **I want** Syl to track what my children are learning and what comes next, **so that** I teach rather than administrate.

- Objectives form a prerequisite graph; mastery is tracked per learner
- Review is scheduled by decay, on the same mental model as memory
- **An hours log exists regardless of what the state requires** — cheap now, impossible to backfill

---

## Explicitly out of scope

The character and voice (`syl-00F`, later), calendar and email integrations beyond what `syl-002.4` built, research briefs with graphics, and any second user.

## Success criteria

- Syl recalls something the Commander told her weeks earlier, unprompted and correctly
- A book he sends becomes answerable knowledge within a day
- At least once a week the nightly pass surfaces a connection he had forgotten and values
- A quiet day is genuinely quiet, and reads as success
- Nothing in memory is ever destroyed — only superseded or faded

## Constraints inherited

The five non-negotiables, plus two that these epics test hardest:

**Subscription rails.** The nightly consolidation is expensive by nature and free at the margin only because of this. It is the strongest example in the project of that constraint buying something.

**The service holds the guarantees; the model holds the judgment.** Memory retrieval, supersession and decay are deterministic. What a connection *means* is the model's.
