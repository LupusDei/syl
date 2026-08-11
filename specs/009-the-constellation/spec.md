# The Constellation — seeing what she remembers

**Feature**: 009-the-constellation
**Status**: Draft, for the Commander
**Priority**: P2
**Depends on**: the memory graph (`syl-010` and proposal A), which exists

## The trap, first

The obvious build is a force-directed node-link graph: circles, springs, everything
drifting into a ball. It looks impressive in a screenshot and answers no question anyone
has. Every node is equidistant from meaning, the layout changes every time you open it so
nothing is where you left it, and past a few hundred nodes it is a grey hairball with a
search box.

**A graph is not a picture of data. It is an answer to a question about relationships.**
So this spec starts from the questions, and only then draws.

## Two surfaces, two audiences — and conflating them is the mistake

The Commander's settled decision was *"graph visualisation — yes, build it, in the web
admin, during development, so he can watch the memory evolve and judge how relevant the
inferred engine actually is."* He has now also asked for something beautiful behind the
phone's **Memory** orb.

Those are different products and must not be the same screen.

| | **The admin graph** | **The phone constellation** |
|---|---|---|
| Question | *Is the inference engine any good?* | *What do you know about me?* |
| Audience | Him, judging a machine | Him, living with a companion |
| Density | Everything at once, thousands of nodes | A dozen things at a time |
| Interaction | Filter, inspect, give feedback, tune | Wander, remember, correct, forget |
| Failure | Too slow, too coarse to judge by | Too clever to read |

Building one for both produces a debugging tool on his phone, or a toy in the admin.

## What the graph actually contains

Seven node kinds — `fact`, `memory`, `person`, `source`, `event`, `goal`, `decision`.
Two edge species — **`observed`** (he said it) and **`inferred`** (she concluded it).
Three tiers — `hot`, `cold`, `suppressed`. Edges carry **confidence**, which decays
asymptotically toward zero and never arrives.

That last property is the whole design opportunity, and it is already in the data:

> **Nodes are superseded, edges are demoted, nothing is destroyed.**

A memory system where nothing is deleted but things fade is not a database diagram. It is
a night sky.

---

## The phone: a constellation, not a graph

**Nodes are stars. Edges are filaments. Confidence is brightness. Tier is depth.**

This is not decoration chosen to match the app — it is the honest rendering of the model,
and it happens to be the app's existing visual language. `SylTheme` already has a veil, a
starfield, motes, `luminance`, and a `plusLighter` bloom. The memory graph is the one
dataset in this system whose semantics *are* light.

- **A `hot`, high-confidence, observed fact** is a bright star with a hard core.
- **A `cold` inferred edge** is a faint filament you can see only when you look at it.
- **`suppressed`** is not gone. It is the dimmest thing on the field — present if he goes
  looking, invisible when he is not. That is exactly what constraint 6 means, drawn.
- **Decay is legible over time.** Open it after a month away and the sky has changed
  without anything having been thrown out. No other visualisation of this data tells that
  truth as directly.

### It is anchored, not simulated

No force simulation. Layout is **deterministic from the data**, so the same memory is in
the same place every time he opens it — a thing you cannot learn to navigate if it
rearranges itself on every launch.

- **People and goals are anchors** — the few nodes he actually thinks in terms of. They
  hold fixed positions, seeded from their id so they never move between sessions.
- **Facts and memories orbit their anchor**, at a radius set by confidence: what she is
  sure of sits close in.
- **Time is the third axis, expressed as depth** — older memories sit further back, dimmer
  and smaller, so a year of history reads as distance rather than as clutter.

### What he can do

Three things, and deliberately only three:

1. **Wander.** Pinch and drag a sky. No filter panel, no legend, no controls to learn.
2. **Touch a star** — it brightens, its filaments light, and one card rises with the thing
   in her words, when she learned it, and **from what**. Provenance is not an advanced
   feature; it is the answer to the only question that matters about a memory.
3. **Forget this.** The Commander's explicit order deletes — his ruling, 2026-08-10, the
   one exception to constraint 6. Reachable in two taps and confirmed once, because it is
   the only destructive act in the app.

### What it must never be

- **Never a search box with a graph behind it.** If the answer is "type what you want",
  the picture was decoration.
- **Never a hairball.** If more than a few dozen stars are on screen, the view has failed
  and should be showing a region instead.
- **Never real-time physics.** Motion is drift and breath, on coprime periods, as
  everywhere else. A layout that settles while he watches is a layout that moved.
- **Never a count of nodes.** It is a dashboard statistic about the machine, and the orbs
  are already documented as *doors, not statistics*.

---

## The admin: the instrument

Same data, opposite priorities. This one is for judging the engine, and it should look
like an instrument rather than a night sky.

- **Everything at once**, with real filters: kind, tier, species, confidence band, date.
- **The inferred engine on trial.** Inferred edges shown *against* the observed ones they
  were drawn from, so he can see what she concluded and from what. This is the question
  the Commander actually asked for: *how relevant is the inferred engine?*
- **Feedback in place.** `POST /memory/edges/{id}/feedback` already exists; the whole
  point of watching is being able to say "that one is wrong" without leaving the view.
- **Decay over time**, as a curve rather than a vibe — a scrubber that shows the same
  region a month ago.
- **Dream sessions as events on that timeline**, since the dream log already records every
  session permanently and is the record of *why* the graph changed.

## DECIDED by the Commander, 2026-08-10

> *"No, I want the constellation. Just as you described it. Nodes are stars, edges are
> filaments, confidence is the brightness, tiers the depth. I like it and I want to see
> it. It's possible it won't be super useful, but I'll have useful things in the admin
> tools. What I want for the app is beauty."*

So both open questions below are answered, and answered against my recommendation:

1. **The phone constellation is built, and built first.** Not the admin instrument, and
   not a list as an MVP.
2. **Usefulness is explicitly not the bar.** The admin gets the instruments; the app gets
   beauty. A feature whose purpose is to be beautiful is judged on whether it is
   beautiful, and "but is it useful" is not a defect report against it.

And one addition to the design, his:

> *"I know you want the placement to be deterministic and I agree with that, but once
> everything is placed, make it lifelike — have it hover and move around subtly."*

**Deterministic placement, living motion.** Position is fixed and seeded from the data, so
the sky is learnable and the same star is always in the same place. What moves is
*around* that anchor: a slow hover on the app's existing vocabulary — coprime periods,
sub-pixel drift, a breath — so nothing ever resynchronises into a visible loop and nothing
is ever where the eye expects a rigid grid. The anchor is truth; the motion is life.

The distinction matters and is easy to lose: a star may **drift around** its position and
must never **travel to** a new one.

## Open questions, now closed

1. **Which comes first?** The admin instrument answers the question he originally asked
   for (is this engine any good). The phone constellation is the beautiful one. My
   recommendation is **admin first** — until the engine is worth trusting, a beautiful
   view of it is a beautiful view of noise, and the admin is where that gets judged.
2. **Does the phone surface need the graph at all, at first?** A calm, browsable list of
   what she knows — grouped by person and goal, each with provenance and a forget — would
   answer *"what do you know about me?"* completely, and could ship in a fraction of the
   time. The constellation is the better thing to look at; the list is the better thing to
   use. They are not exclusive, and the list is the honest MVP.
3. **How much history?** Depth-as-time is lovely and unbounded. A year? Everything?

## Success

- He opens it because he wants to, not to debug something.
- He can answer *"why does she think that?"* about any single memory, in two taps.
- He can tell, from looking, which parts of what she knows are things he told her and
  which are things she worked out.
- Nothing on either surface implies a memory was destroyed, unless he destroyed it.
