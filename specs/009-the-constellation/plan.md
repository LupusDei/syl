# Implementation Plan — The Constellation

**Feature**: 009-the-constellation
**Epic**: `syl-cst`
**Spec**: [spec.md](./spec.md)

## What the survey changed

**1. ~~The phone cannot read the memory graph at all.~~ — WRONG WHEN WRITTEN.**

> **Corrected 2026-08-11.** This plan claimed `GET /memory/graph` returned `403` to the
> phone. It did not, and had not for over an hour before the plan was committed: `d7b15bb`
> *"feat: no second key for the admin panel"* had already replaced the gate with
> `anyAuthenticatedDevice`, and three tests already asserted a paired device gets `200`.
>
> **The mistake is worth keeping rather than deleting.** I read the route's mount line and
> its doc comment — which was literally headed *"Why it is admin-scoped"* — and did not
> read the call site, which was the only place telling the truth. The code was internally
> consistent and wrong: this project's own named pattern, caught by a planner instead of a
> test. The option is now called `authorize`, named for its position rather than for a
> policy that has already changed under it once.
>
> The phase's real work — a payload shaped for a sky, stored on the device, read from
> disk — was unaffected.

**2. And the brief's instinct to re-tighten the tuning surface was also wrong.**
I said `metrics` and `edges/{id}/feedback` should stay admin because they shape the engine
rather than describe him. The squad refused, correctly: **the Commander opened that
surface deliberately**, because the thing he asked for — judging how good the inferred
engine is — was unreachable from the device he actually carries, and *giving feedback is
how he judges it*. Re-gating would have restored the exact friction he removed, on the
endpoint he named.

The reasoning about `/logs` still holds and is still worth stating: logs are admin because
they record *what a program did on his machine*, and the memory graph is facts about him.
It simply did not lead where I pointed it.

**3. The phone wants a different payload anyway.** `buildGraphView` is built for the
admin — seeds, edge budgets, dream nights. The constellation wants nodes with kind, tier,
confidence and provenance, and edges with species and confidence. A second, smaller read
is honest rather than duplicative.

**4. Every drawing primitive this needs already exists.** `MoteField` is a `Canvas`
drawing dozens of soft points on coprime periods at 24fps. `SylRibbon` is a `Canvas`
drawing a filament with a hand-rolled feather glow and a `plusLighter` core. `Scatter`
already provides deterministic hashing for seeded placement. The constellation is those
three techniques pointed at real data — not new rendering work.

## Architecture decisions

### D1 — Position is a pure function of the node. Motion is a pure function of time.

The Commander asked for both and they must not be confused:

```
position(node)                  → fixed, seeded, identical every launch
offset(node, t)                 → small, slow, coprime, never accumulating
drawn = position(node) + offset(node, t)
```

**A star may drift *around* its anchor and must never travel *to* a new one.** The test
for this is not visual: `position` is pure and asserted, and `offset` is bounded — its
magnitude has a hard ceiling, so no combination of time can carry a star anywhere.

Seeded from the node id via `Scatter.hash`, which already exists and is already
deterministic across launches.

### D2 — One `Canvas`, not a view per star

`MoteField` draws forty particles in a single `Canvas` at 24fps, and `SylRibbon` draws a
240-point filament the same way. A `View` per node would put hundreds of SwiftUI identities
on screen for something that is fundamentally a drawing, and `syl-008` already paid for
treating a drawing problem as a view problem.

Hit-testing is therefore ours: nearest-star-within-a-radius against the *anchor*
positions, not the drifting ones, so a tap lands on what he aimed at rather than on where
a star happened to have wandered.

### D3 — Confidence is brightness and tier is depth, and both are the data unmodified

No thresholds, no buckets, no legend. `confidence` maps to alpha and core size directly;
`tier` maps to a depth scale. A cold, low-confidence node is faint because it *is* faint —
that is the whole idea, and quantising it into three visual classes would throw away the
one property that makes this dataset worth drawing.

### D4 — The prepared sky is built off the main actor

Same pattern as `ChatSnapshotLoader` and for the same reason. Positions, brightness and
the filament list are computed once into a finished value; the `Canvas` only draws it.
`syl-008` shipped a quadratic comparison into a transcript and it cost the Commander two
crashes — a graph is the easiest place in this app to repeat that.

### D5 — Reduce Motion pins the sky, and it still reads

Motion is life, not information: every star keeps its anchor position, brightness and
depth. With motion removed the constellation is a still photograph of the same sky, not a
degraded one. That is the test — a still that looks broken means the motion was carrying
meaning it should not have been.

### D6 — Forget is real deletion, and it is the only one

His explicit order deletes (his ruling, 2026-08-10, the one exception to constraint 6).
Whether a delete route exists is an open question for Phase 1; if it does not, it is
contract work and belongs there, not bolted onto a view.

## Phases

| Phase | Sub-epic | What becomes true | Ships alone |
|---|---|---|---|
| 1 | `.1` | The phone can read the graph, at device scope | no UI |
| 2 | `.2` | A sky exists: deterministic, drawn, dark and beautiful | **yes** |
| 3 | `.3` | It lives — hover, drift, breath, and Reduce Motion | **yes** |
| 4 | `.4` | He can touch a star and learn where it came from | **yes** |
| 5 | `.5` | He can forget one | yes |
| 6 | `.6` | Polish: scale, accessibility, and the screenshots | yes |

**Phase 2 is the one that matters.** If the sky is not beautiful, nothing after it helps.

## Risks

**R1 — The hairball.** Even anchored, a few hundred stars at once is noise. The view shows
a *region*: anchors and what orbits them, with depth culling. If it ever needs a legend, it
has failed.

**R2 — Beauty judged by assertion.** This is the one feature in the project whose
acceptance is aesthetic. It cannot be settled by a green suite, so the render harness is
not optional here — it is the primary check, and the Commander is the final one.

**R3 — Motion that accumulates.** An offset built from an integrating term wanders. Bound
it and assert the bound.

**R4 — A `Canvas` that recomputes.** See D4.

**R5 — Treating "not useful" as a defect.** The Commander decided this explicitly. A
reviewer who adds a filter bar, a search field or a node count to make it *useful* has
broken the thing he asked for.
