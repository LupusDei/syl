# Everything his body says — widening what she can read

**Feature**: 014-everything-his-body-says
**Status**: Planned
**Priority**: P1
**Depends on**: `syl-t9tj` (the health epic), which shipped and works

## The one sentence

She reads everything Oura publishes about him, not the seven types I picked.

## What he asked for

A screenshot of Oura's Apple Health permissions — every type it writes:

> Active Energy · Blood Pressure · Body Fat Percentage · Cardio Fitness ·
> Date of Birth · Heart Rate · Height · Lean Body Mass · Respiratory Rate ·
> Resting Energy · Sex · Sleep · Steps · Weight · Workout Routes · Workouts

Today she reads seven. Five of those overlap his list. **Two of them can never
arrive.**

---

## The finding that reframes the existing epic

Read that list alphabetically and two absences are load-bearing:

- **Heart Rate Variability** would sit between *Heart Rate* and *Height*. It is
  not there.
- **Resting Heart Rate** would sit between *Respiratory Rate* and *Resting
  Energy*. It is not there.

**Oura does not publish either to Apple Health.** No permission grant will ever
make them arrive from his ring.

Two consequences, and both correct something already shipped:

**1. The estimated resting heart rate is not a workaround.** `derive.ts` computes
it as the 5th percentile of raw heart rate — a "quiet floor". That was built as a
convenience and is in fact **the only way he will ever have that number.** The
spec should say so, and it is sound: his hour histogram is flat (25.2% of samples
fall between 00:00 and 05:59, against 25% for uniform), so the ring is worn
continuously and the floor is a genuine overnight low.

**2. Our labels blamed the wrong thing.** `restingHeartRate` and
`heartRateVariability` report `denied`/`undisclosed`, which reads as *he refused*
or *we could not confirm*. The truth is **his source does not publish it** —
which is `unavailable`, a state the contract already has. The phone cannot detect
this (`isHealthDataAvailable` is device-wide), so it has to be a **server-side
judgement**: a type authorised for months with zero samples is a source that does
not carry it, and saying so is more honest than either label it has now.

---

## Three things in his list that are not samples

Each is a decision, not an implementation, and each is filed for him rather than
guessed at.

### Date of Birth and Sex are characteristics, not measurements

Different API (`dateOfBirthComponents()`, `biologicalSex()`), no time series, no
watermark, no baseline. **They are facts, and facts belong in the memory graph.**
Pushing them through the sample pipeline would give each a fabricated
`startedAt` and a baseline computed from one row.

He has **already told her his birthday in conversation** and it is in her graph.
So the interesting question is not how to store it but what to do when Health and
his own words disagree — and the answer the rest of the system already gives is
that what he said outranks what a sensor reported.

### Blood Pressure is paired

Systolic and diastolic arrive as a correlation. `HealthSampleInput` carries one
`value`, so today's contract cannot express it without either two rows that must
be read together — a join nobody enforces — or a shape change.

### Workout Routes is GPS

**This is where he has been, not how his body is.** It is a different category of
thing about a man than everything else here, and it deserves an explicit yes
rather than arriving inside a list of body metrics. Gated on his word.

---

## User stories

### US1 — She reads the rest of his numbers (P0)

The seven straightforward quantity types: active energy, resting energy, body fat
percentage, VO₂ max, height, lean body mass, respiratory rate.

**Acceptance**
- Each arrives, is stored idempotently, and appears in the admin.
- Each carries an authorisation state, and an empty one is distinguishable from a
  denied one.
- No new type can become a memory node.

### US2 — Asking her stays fast (P0)

**Acceptance**
- `how_has_he_been` answers in under a second on his real corpus, with all types.
- Measured against the live store, not a fixture.

### US3 — She knows what his body cannot tell her (P1)

**Acceptance**
- A type authorised for a long window with zero samples is reported as
  `unavailable` rather than as denied or undisclosed.
- She can say *"your ring does not publish HRV"* rather than *"you have no HRV"*.

### US4 — Facts go where facts live (P1)

**Acceptance**
- Date of birth, sex and height reach the memory graph, not `health_samples`.
- Where Health and his own words disagree, **his words win**, and she can say
  which she is using.

---

## Requirements

**R1** — A health sample cannot become a memory node. Unchanged, and it now has
seven more chances to be violated.

**R2** — Only `authorised` licenses a conclusion drawn from silence.

**R3** — Every new route is authenticated by being in `AUTHENTICATED_HEALTH_ROUTES`,
and the router sweep proves it. `/health/summary` shipped answering with no
credential at all; that must not recur.

**R4** — Constraint 6 does not bind measurements. Sixty days at full resolution,
then daily aggregates.

**R5** — Adding types widens the tool schema, which is a turn-context contributor.
Check the budget rather than discovering it.

**R6** — Subscription rails only.

---

## Non-goals

- Diagnosis, or asserting a cause she cannot know.
- Workout routes, until he says so specifically.
- Any second device.

---

## Risks

**Performance is the one that bites, and it is already real.** `how_has_he_been`
takes **8.7 seconds** over 61,030 samples because a per-type cap was chosen
without measuring. Seven more types makes that unignorable, and it is a verb she
calls mid-conversation — nine seconds of silence is her appearing to hang. The
fix (derive from daily aggregates) belongs *in* this epic, not after it.

**Seven more types is seven more chances to say something true and useless.** The
existing defence is structural — the review sees only comparisons against his own
baseline, never absolute levels — and it must survive the widening.

**Height and sex barely change.** A "baseline" over a constant is noise with a
mean. They should be treated as facts, which is US4, rather than fed to a
deviation detector.
