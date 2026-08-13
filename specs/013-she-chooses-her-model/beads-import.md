# 013 — Bead import map

**Root**: `syl-023` — *She chooses her model, and can tell when one is not her*
**Prefix**: `syl-` · **Spec**: `specs/013-she-chooses-her-model/`

## Hierarchy

| bead | type | title | priority |
|---|---|---|---|
| `syl-023` | epic | She chooses her model, and can tell when one is not her | P1 |
| `syl-023.1` | epic | Phase 1: Discovery — measured, and it must be written down | P0 |
| `syl-023.2` | epic | Phase 2: Foundational — the model registry | P0 |
| `syl-023.3` | epic | Phase 3: US1 — model choice, with the likeness consequence up front | P0 |
| `syl-023.4` | epic | Phase 4: US2 — clips to 30 seconds where the model allows | P1 |
| `syl-023.5` | epic | Phase 5: US3 — a candidate likeness she can render (`syl-ate.1`) | P0 |
| `syl-023.6` | epic | Phase 6: Polish — the ledger, the docs, and the proof | P2 |
| `syl-023.7` | task | The Replicate question — the Commander's alone | P3 |

## Tasks

| T-id | bead | title | type | deps |
|---|---|---|---|---|
| T001 | `syl-023.1.1` | The Phase 1 measurements into `docs/VIDEO.md`, with two corrections | task | — |
| T002a/b | `syl-023.1.2` | The probe harness, and the guard that keeps a probe free | task | — |
| T010a/b | `syl-023.2.1` | `models.ts` — the measured table | task | — |
| T011a/b | `syl-023.2.2` | `canAnchorLikeness`, derived from keyframe slots | task | `syl-023.2.1` |
| T012 | `syl-023.2.3` | `credits.ts` — measured rates for four unpriced models | task | — |
| T020a/b | `syl-023.3.1` | `SubmitSpec` as a geometry-shape union | task | `syl-023.2.1` |
| T021a/b | `syl-023.3.2` | `holdsLikeness` takes the model's slots | task | `syl-023.2.2` |
| T022a/b | `syl-023.3.3` | `model` flows into the submission and the sidecar | task | `syl-023.3.1` |
| T023a/b | `syl-023.3.4` | The likeness consequence, before the spend | task | `syl-023.3.2`, `syl-023.3.3` |
| T024 | `syl-023.3.5` | `render_me` exposes `model` — budget measured first | task | `syl-023.3.4` |
| T030 | `syl-023.4.1` | Duration range from the registry | task | `syl-023.2.1` |
| T031 | `syl-023.4.2` | Join arithmetic stops assuming 15 | task | `syl-023.4.1` |
| T040a/b | `syl-023.5.1` | `text_to_image` with `referenceImages` | task | — |
| T041a/b | `syl-023.5.2` | Candidates are sightable and adoptable | task | `syl-023.5.1` |
| T042 | `syl-023.5.3` | The candidate-render verb — budget measured first | task | `syl-023.5.2` |
| T050 | `syl-023.6.1` | Per-model spend in the ledger | task | `syl-023.2.3` |
| T051 | `syl-023.6.2` | `docs/VIDEO.md` rewritten around the registry | task | `syl-023.3.5` |
| T052 | `syl-023.6.3` | The proof render | task | `syl-023.4.1` |
| T060 | `syl-023.7` | The Replicate question | task | — (blocked on a ruling) |

## Dependency notes

- `syl-023.2.1` is the gate. Phases 3, 4 and 6 all sit behind it.
- **`syl-023.5.*` is independent of Phases 3 and 4** — it touches
  `text_to_image`, the studio and the wardrobe, not the video request path. A
  second agent can take the whole of Phase 5 in parallel.
- `syl-023.1.*` and `syl-023.2.3` depend on nothing and are immediately ready.
- `syl-023.7` is deliberately dependency-free and deliberately unclaimed. It is
  not blocked by engineering; it is blocked by a decision that is not ours.

## Expected `bd ready` after creation

`syl-023.1.1`, `syl-023.1.2`, `syl-023.2.1`, `syl-023.2.3`, `syl-023.5.1`,
`syl-023.7`
