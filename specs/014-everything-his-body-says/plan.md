# Plan — Everything his body says

**Feature**: 014 · **Spec**: `spec.md` · **Extends**: `syl-t9tj`

## Architecture

Nothing structural changes. The three layers stand: observations in their own
store, derivations as a projection, conclusions in the memory graph. This epic
widens the first and makes the second affordable.

```
  HEALTH_TYPES        7  ->  14 quantity types
  derive.ts           reads DAILY AGGREGATES, not raw rows   <- the real work
  characteristics     DOB / sex / height  ->  memory graph, never health_samples
  unavailable         a server-side judgement, not a phone report
```

### The performance change is the load-bearing one

`how_has_he_been` takes 8.7s over 61,030 samples. Doubling the types roughly
doubles that, and it is a verb she calls **mid-conversation**.

The fix is already half-built: the 60-day downsample produces exactly the shape
`derive()` wants. So the summary path should read **daily aggregates** and touch
raw samples only when a caller genuinely needs within-day resolution — which the
summary never does. That turns two 20,000-row scans into two ~60-row reads.

This is not an optimisation bolted on. It makes the fast path the normal path.

### `unavailable` becomes a server-side judgement

The phone cannot tell "no sensor" from "no permission" per type
(`isHealthDataAvailable` is device-wide). But the **server can see something the
phone cannot**: a type authorised for sixty days with zero samples is a source
that does not publish it. That is a different claim from either label it wears
today, and it is the true one for HRV and resting heart rate.

Rule: `authorised` + zero samples + a long authorised window ⇒ report
`unavailable` in the summary, with the window that justifies it. It is an
inference, so it says what it is drawn from — the same discipline every other
inference in this system carries.

### Characteristics are facts

`dateOfBirthComponents()` and `biologicalSex()` are not samples and must not be
made to look like them. They go to the graph through the existing write path.

**Where Health and his own words disagree, his words win.** That is not a new
rule; it is `SOUL.md`'s ladder applied to a new input, and the graph already
distinguishes what he asserted (`fact`) from what she concluded (`memory`).

## Key files

| Path | What |
|---|---|
| `backend/src/health/contract.ts` | seven more types, seven more units |
| `ios/Syl/Core/Health/HealthReader.swift` | the new quantity identifiers |
| `backend/src/health/derive.ts` | read aggregates rather than samples |
| `backend/src/health/summarise.ts` | the fast path, and the `unavailable` judgement |
| `backend/src/health/characteristics.ts` | *new* — DOB/sex/height to the graph |
| `backend/src/tools/schemas.ts` | the widened `types` enum, against the budget |

**Migration**: only if the aggregate read needs an index. Claim the number from
**ORIGIN**.

## Phases

1. **The seven types** — contract, reader, units, end to end.
2. **Speed** — derive from aggregates. Gated in front of everything downstream
   because seven more types makes 8.7s intolerable.
3. **What his body cannot say** — the `unavailable` judgement.
4. **Facts, not measurements** — characteristics into the graph.
5. **Blood pressure** — the paired type, on his decision.
6. **Workout routes** — GPS, on his explicit yes.

Phases 5 and 6 are gated on him and do not block 1–4.

## Testing strategy

Every acceptance test describes correct behaviour; anything unbuilt stays RED in
`tests/expected-failures.json` with a bead.

Three that carry this epic:

1. **The verb answers in under a second** on a corpus his size. Measured, not
   asserted about a fixture.
2. **A type his source does not publish reads as `unavailable`**, not denied.
3. **No new type can become a memory node** — the existing sweep, now with
   fourteen chances to fail rather than seven.

## Bead Map

Root `syl-8ys9` — 21 beads. Full table in `beads-import.md`.

- `syl-8ys9.1` — The seven types *(5 tasks — the only phase ready)*
- `syl-8ys9.2` — Speed *(3)* · `.3` — What his body cannot say *(3)* · `.4` — Facts *(3)*
- `syl-8ys9.5`, `.6` — gated on him, and deliberately carrying no tasks so they
  cannot look ready.
