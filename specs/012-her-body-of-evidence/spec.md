# Her Body of Evidence — health data, and the line between what she has and what she knows

**Feature**: 012-her-body-of-evidence
**Status**: Planned, from proposal `ff3f839e` (revision 2)
**Priority**: P1
**Depends on**: the memory graph (`syl-005`), the consolidation lane, the device pairing surface

## The one sentence

Syl reads the Commander's health data, keeps it, reviews it, concludes things from
it, and **tells him when she finds something interesting** — without the raw
measurements becoming memories the way his wife and children are memories.

---

## The separation, which is the whole architecture

He asked for this explicitly: *"I don't think that these should be memories in the
same way that she remembers my family or things about my life, but it is still
something she knows about me — so think about how to separate the data from the
memories."*

The instinct is right and the reason is arithmetic rather than taste.

> The live memory graph holds **30 nodes**. One week of HealthKit samples is **tens
> of thousands**. Salience ranks over incident edge weight and node kind, so
> dropping 50,000 measurements into it destroys every ranking the working-memory
> projection depends on. **His wife would be evicted by his step count.**

That is `syl-ulf` exactly — the bug that dropped his own name, his wife, his son and
his daughter out of the document she reads every turn — arriving again through a
door nobody guarded.

### Three layers, three lifetimes

| | **Observations** | **Derivations** | **Conclusions** |
|---|---|---|---|
| Example | HR 54 at 03:12; 8,431 steps on 11 Aug | "6.2h mean sleep last week, 1.1h under baseline" | "His resting heart rate has been up for nine days" |
| Volume | tens of thousands/week | tens | as many as she finds worth keeping |
| Origin | his phone | computed | judged |
| Lives in | its own store | a regenerated view | **the memory graph** |
| Lifetime | 60 days at full resolution, then daily aggregates | thrown away and rebuilt | decays in confidence, never deleted |
| In a prompt? | never | only while reviewing | yes, as memory |

**The observation boundary is enforced by schema, not by discipline.** A health
sample must be *unable* to become a node. A rule someone has to remember is a rule
that gets missed on the pull request that looks unrelated.

---

## Decisions already taken

### By the Commander, 2026-08-12

**She self-initiates.** *"As she gets an update about my health data and finds
something interesting, she should send me a message about it."*

**She may interrupt often.** *"She can interrupt often when it comes to health
data."* This is a deliberate exception to the ordinary "notice, do not nag"
calibration — health is the one class where he wants the volume up.

**No bar at the door.** He overruled an earlier threshold rule with:
*"I can decide whether or not to act on it and tell her if I want her to stop
drawing such conclusions, but I don't want [her coded] in such a way that is
impossible for her to draw connections."*

So she decides what is worth keeping — a single elevated reading may qualify — and
the lifecycle prunes afterwards: confidence decays, and he can kill a conclusion
outright through the feedback route that already exists. **Every other inference in
Syl is judged after it is made, not gated before.** Health will not be the
exception.

**Retention: 60 days** at full resolution.

**The admin shows the raw data**, not only what she made of it.

### Types, at the start

Four he named — **heart rate, HRV, sleep, steps** — plus two this spec adds and
flags for his veto:

- **Resting heart rate**, kept distinct from raw heart rate. It is the baseline
  signal almost every conclusion will lean on, and raw HR is the highest-volume
  type HealthKit offers. Storing the raw series and deriving a daily resting figure
  is the difference between ~1,400 samples a day and one.
- **Weight**, because `Get back to 185 pounds` **is already a goal in his memory
  graph.** It is the one health type that lands directly on something she already
  knows he wants, which makes the conclusion layer useful on day one rather than
  after a month of baseline-building.

Workouts are deliberately deferred. Adding a type later is cheap; removing one is
not.

---

## User stories

### US1 — She can see his health at all (P0)

The app is authorised, reads the curated types, and uploads them. The server keeps
them.

**Acceptance**
- The entitlement, the App ID capability, the usage string and runtime
  authorisation all exist, and a build missing any of them fails loudly rather than
  reading empty.
- **The app reports what it was AUTHORISED FOR alongside what it read**, and the
  server refuses to interpret silence it cannot attribute.
- A re-upload, a retry, or a second device cannot double-count a sample.
- Uploading 60 days of history from cold does not require a special path.

### US2 — He can see what she has (P1)

An admin view of the raw data, per his ruling.

**Acceptance**
- Every stored type is visible, over a chosen window, with its source.
- The view distinguishes *no data* from *not authorised* — the same distinction
  US1 makes on the wire, made visible.

### US3 — She reviews it and reaches conclusions (P0)

The nightly consolidation lane reads the derivations and writes what she judges
worth keeping.

**Acceptance**
- Conclusions land as `kind: "memory"`, **never** `kind: "fact"`.
- Every conclusion carries reasoning naming the window it came from.
- Confidence decays; he can kill one; nothing is deleted.
- No raw sample is ever written as a node, asserted by a test on the live shape.

### US4 — She tells him (P0)

**Acceptance**
- A conclusion she judges worth raising reaches him without being asked for.
- Every surfaced conclusion carries its `because`.
- Engagement is recorded, so a class he ignores is a class she can stop generating.

---

## Requirements

**R1 — A health sample cannot become a memory node.** Schema-enforced.

**R2 — Empty and denied are different facts, everywhere.** On the wire, in the
store, in the admin, and in anything she says.

**R3 — Conclusions use the reflection path, not `memory_provenance`.** That table
requires a `digest REFERENCES memory_extractions`, a `said_in GLOB
'syl:message:*'`, and a quote **copied from that message**. A conclusion drawn from
fourteen nights of sleep has none of the three, and inventing them is the
fabricated provenance that table exists to make impossible. `remember.ts` already
hit this wall and documented the answer.

**R4 — Constraint 6 does not bind measurements.** "Nothing is destroyed" protects
what *he told her*. A heart-rate sample is not that. Downsampling a year of
per-minute samples to daily aggregates forgets nothing that was ever known. **This
is written down because the never-delete rule is stated everywhere else in this
codebase**, and the next reader will otherwise apply it to a table growing 50,000
rows a week.

**R5 — Idempotent by sample identity** `(type, start, end, source)`.

**R6 — Raw measurements never ride in working memory.** Only conclusions do.

**R7 — Subscription rails only.** Review is a turn on a lane that already exists.
No metered call anywhere in this feature.

**R8 — Health never reaches `runReaderTurn`.** The sealed reader stays sealed.

---

## Non-goals

- Diagnosis, or asserting a **cause** she cannot know. *"Your resting heart rate has
  been higher than usual for nine days"* is an observation and saying it is her job.
  *"You are fighting something off"* is a mechanism she has no access to. This is not
  a health rule — it is Proposal A's astrology rule, already in force everywhere.
- Background delivery, at first. *"A capability we do not rely on is one we should
  not ask for."*
- Workouts, weight-trend prediction, or any second device.

---

## Risks

**Volume swamping the graph.** The reason for the whole structure. Enforced by
schema.

**The empty/denied ambiguity.** Presents as *"the feature works, there is just no
data"* and would waste a week. `syl-kqc` is the precedent and the entitlements file
already documents the identical trap for Time Sensitive Notifications: *"a correct
build with that toggle off is indistinguishable from the bug."*

**Hedging into uselessness.** The Commander named this directly, and it is the
quieter failure because nothing ever looks broken. An assistant so carefully
bounded she cannot say what she noticed reads as a life with nothing going on in
it.

**Conclusions that are true and uninteresting.** "He walks more at weekends." The
answer is the generic one: he sees them, he can kill them, and a class he ignores
is a class she stops generating.

---

## Success

- She says something about his health that he did not know and is glad to have.
- He can answer *"why does she think that?"* about any conclusion, in two taps.
- His wife is still in working memory after a month of health data.
- No conclusion is ever attributed to him as something he said.
