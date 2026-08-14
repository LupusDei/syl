# Beads — Everything his body says

**Root**: `syl-8ys9` · 21 beads: 1 root + 6 sub-epics + 14 tasks

| Bead | T-ID | Title |
|---|---|---|
| `syl-8ys9` | — | **Everything his body says** |
| `syl-8ys9.1` | — | **Phase 1: The seven types** |
| `syl-8ys9.1.1` | T001 | Seven more types and their units, in the contract |
| `syl-8ys9.1.2` | T002 | The matching HealthKit identifiers, converting at the seam |
| `syl-8ys9.1.3` | T003 | [P] Widen the Swift wire enum and its round-trip pin |
| `syl-8ys9.1.4` | T004 | Check the turn-context budget before it checks you |
| `syl-8ys9.1.5` | T005 | [P] **RED**: no new type can become a memory node |
| `syl-8ys9.2` | — | **Phase 2: Speed — and it gates everything after** |
| `syl-8ys9.2.1` | T006 | derive.ts reads daily aggregates, not raw rows |
| `syl-8ys9.2.2` | T007 | summarise.ts takes the fast path |
| `syl-8ys9.2.3` | T008 | **RED**: the verb answers in under a second |
| `syl-8ys9.3` | — | **Phase 3: What his body cannot say** |
| `syl-8ys9.3.1` | T009 | The `unavailable` judgement, carrying its window |
| `syl-8ys9.3.2` | T010 | [P] **RED**: a type his source does not publish is not "denied" |
| `syl-8ys9.3.3` | T011 | [P] The admin shows it, and stops giving useless advice |
| `syl-8ys9.4` | — | **Phase 4: Facts, not measurements** |
| `syl-8ys9.4.1` | T012 | Characteristics to the graph, never to health_samples |
| `syl-8ys9.4.2` | T013 | Precedence: his words outrank a sensor |
| `syl-8ys9.4.3` | T014 | [P] **RED**: a characteristic never acquires a baseline |
| `syl-8ys9.5` | — | **Phase 5: Blood pressure** — *gated on his decision* |
| `syl-8ys9.6` | — | **Phase 6: Workout routes** — *gated on his explicit yes* |

## Dependencies

```
.1 ──▶ .2 ──┬──▶ .3
            └──▶ .4

.5, .6   gated on him, not on code
```

**Phase 2 gates 3 and 4 deliberately.** It is the performance work, and every
phase after it makes the problem worse — seven more types roughly doubles an
8.7-second verb she calls mid-conversation.

Wired **sibling-to-sibling**: a blocking dependency on a parent propagates down
and removes every descendant from `bd ready`. Verified by running `bd ready`
after wiring rather than assuming — all five Phase 1 tasks appear and nothing
downstream does.

## The two gated phases

`.5` and `.6` carry no tasks on purpose. Writing tasks for them would make them
look ready and invite someone to start.

- **Blood pressure** needs a shape decision that is cheap for him and expensive
  for me: two rows that must be read together is a join nobody enforces, and the
  first caller to forget it reports a systolic as a blood pressure.
- **Workout routes is GPS.** He sent a screenshot of health types and said get
  all of it. That is a reasonable sentence about health types and it is not
  consent to location history, because nobody reading that list thinks of it as
  one.
