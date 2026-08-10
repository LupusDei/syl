# Bead Import — Chat, Alive

**Feature**: 004-chat-alive · **Root epic**: `syl-008` · **Created**: 2026-08-10
**Total**: 1 root + 7 sub-epics + 40 tasks = 48 beads

## Hierarchy

```
syl-008                    Syl 8: chat, alive — markdown, beauty, content-rich messages   P1
├── syl-008.1              Foundation: a tested markdown engine, and the link allowlist    P1
├── syl-008.2              US1: her words arrive as she wrote them                         P1
├── syl-008.3              US2: chat belongs to the same world                             P1
├── syl-008.4              US3: she is present in the conversation                         P2
├── syl-008.5              US4a: the contract and the backend carry attachments            P2
├── syl-008.6              US4b: images and video in the conversation                      P2
└── syl-008.7              Polish: the transcript at scale                                 P3
```

## Tasks

| T-ID | Bead | Title | P | Type |
|---|---|---|---|---|
| T001 | `syl-008.1.1` | Port the markdown model | 1 | task |
| T002 | `syl-008.1.2` | Write the parser tests first, including the three inherited defects | 1 | task |
| T003 | `syl-008.1.3` | Port the block scanner, dropping parseInline | 1 | task |
| T004 | `syl-008.1.4` | Fix the blockquote and ordered-list defects | 1 | task |
| T005 | `syl-008.1.5` | Inline rendering via AttributedString | 1 | task |
| T006 | `syl-008.1.6` | **SECURITY: the link scheme allowlist** | **0** | **bug** |
| T007 | `syl-008.1.7` | Robustness: malformed and hostile input | 1 | task |
| T008 | `syl-008.2.1` | The SwiftUI block renderer | 1 | task |
| T009 | `syl-008.2.2` | Fenced code blocks that do not break the bubble | 1 | task |
| T010 | `syl-008.2.3` | **Parse in the snapshot loader, off the main actor, per message** | **0** | task |
| T011 | `syl-008.2.4` | Replace Text(message.text) with MarkdownView | 1 | task |
| T012 | `syl-008.2.5` | DECISION: nested lists — fix or accept | 1 | task |
| T013 | `syl-008.2.6` | Accessibility for rendered messages | 1 | task |
| T014 | `syl-008.3.1` | The veil and motes behind the transcript | 1 | task |
| T015 | `syl-008.3.2` | Restyle the bubbles, and move the timestamp out | 1 | task |
| T016 | `syl-008.3.3` | Restyle the composer | 1 | task |
| T017 | `syl-008.3.4` | Restyle the connection banner and empty state | 1 | task |
| T018 | `syl-008.3.5` | Copy and retry affordances | 1 | task |
| T019 | `syl-008.3.6` | Screenshot chat beside home | 1 | task |
| T020 | `syl-008.4.1` | **BUG: chat presence never decays** | **0** | **bug** |
| T021 | `syl-008.4.2` | The ribbon in the conversation | 2 | task |
| T022 | `syl-008.4.3` | Reduce Motion path for thinking | 2 | task |
| T023 | `syl-008.5.1` | Contract: Message carries attachments | 2 | task |
| T024 | `syl-008.5.2` | The attachments table | 2 | task |
| T025 | `syl-008.5.3` | The blob store, with server-side type sniffing | 2 | task |
| T026 | `syl-008.5.4` | The routes | 2 | task |
| T027 | `syl-008.5.5` | DECISION: thumbnails, or the cellular cost stated out loud | 2 | task |
| T028 | `syl-008.5.6` | Anti-divergence: route every new operation both ways | 2 | task |
| T029 | `syl-008.6.1` | Regenerate SylKit Message and its fixtures | 2 | task |
| T030 | `syl-008.6.2` | Authenticated, cached attachment loading | 2 | task |
| T031 | `syl-008.6.3` | **SECURITY: attachments come from Syl's origin only** | **0** | **bug** |
| T032 | `syl-008.6.4` | Inline thumbnails with no layout jump | 2 | task |
| T033 | `syl-008.6.5` | Full-screen viewer | 2 | task |
| T034 | `syl-008.6.6` | Video: poster frame, tap to play, never autoplay | 2 | task |
| T035 | `syl-008.6.7` | Offline behaviour | 2 | task |
| T036 | `syl-008.6.8` | Disk-first send for staged attachments | 2 | task |
| T037 | `syl-008.7.1` | Scroll anchoring that does not race | 3 | task |
| T038 | `syl-008.7.2` | Do not yank the view out from under him | 3 | task |
| T039 | `syl-008.7.3` | Pagination | 3 | task |
| T040 | `syl-008.7.4` | Performance at 500 messages | 3 | task |

## Dependencies wired

**Across phases**
- `syl-008.2` ← `syl-008.1` (nothing renders before the engine exists)
- `syl-008.6` ← `syl-008.5` (do not build a client for an endpoint that does not exist)
- `syl-008.4.2` ← `syl-8l7` — at *task* level, because bd will not let an epic depend on a
  task. Deliberately narrow: **T020 does not depend on it.** The presence-decay bug is real
  whether or not the service ever announces anything, and can be fixed today.

**Within phases**
- 1: `.3 ← .1, .2` (tests before the port) · `.4 ← .3` · `.7 ← .3`
- 2: `.1 ← 1.5, 1.6` · `.2 ← .1` · `.4 ← .1, .3` · `.5 ← 1.2` · `.6 ← .4`
- 3: `.6 ← .1, .2` (screenshot after the restyle it documents)
- 4: `.2 ← .1` (decay fixed before anything renders from presence)
- 5: `.2 ← .1` · `.3 ← .2` · `.4 ← .3` · `.6 ← .4` (contract → table → store → route → guard)
- 6: `.1 ← 5.1` · `.2 ← .1` · `.3,.4,.7,.8 ← .2` · `.5,.6 ← .4`
- 7: `.4 ← .3`

## Ready now

`syl-008.1.1`, `syl-008.1.2`, `syl-008.1.5`, `syl-008.1.6`, and all of `syl-008.3`
(`.1`–`.5`) — the restyle needs no engine, so it parallelises with the parser work from
day one.

Two P0s are unblocked immediately and are the highest-value first moves:
`syl-008.1.6` (the link allowlist) and `syl-008.4.1` (the presence-decay bug).

## Notes for whoever picks this up

- **`syl-008.2.3` is the load-bearing one.** Parse in `ChatSnapshotLoader`, off the main
  actor, per message. Getting it wrong undoes the jank fix that loader exists for, and it
  will not be obvious until the transcript is long.
- **`syl-008.1.2` before `syl-008.1.3`.** The ported parser arrives with zero tests and
  three known defects; asserting current behaviour first is what makes the port honest.
- **The two `DECISION` beads (`2.5`, `5.5`) must be answered in writing**, not silently
  implemented one way. Nested lists and thumbnails both have a real cost either way.
