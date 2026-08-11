# Bead map — The Hands (`syl-009`)

26 beads: 1 root, 7 sub-epics, 18 tasks. Dependencies are wired at TASK level —
`bd` does not cascade an epic-level dependency to its children, which has bitten
this project twice.

| T-ID | Bead | Title |
|---|---|---|
| T001 | `syl-009.1.1` | Add the agent scope, with a migration |
| T002 | `syl-009.1.2` | Mint the agent key at boot, unreachable from the network |
| T003 | `syl-009.1.3` | Deny the agent everything but writes |
| T004 | `syl-009.2.1` | A loopback HTTP client for her own API |
| T005 | `syl-009.2.2` | Human time to stored time, or a question |
| T006 | `syl-009.3.1` | The reminder tools and their schemas |
| T007 | `syl-009.3.2` | The MCP server over stdio |
| T008 | `syl-009.3.3` | Wire it to the commander lane |
| T009 | `syl-009.3.4` | Confirm creation from the store, not from her intention |
| T010 | `syl-009.3.5` | A tool failure reaches the conversation |
| T011 | `syl-009.4.1` | To-do tools |
| T012 | `syl-009.4.2` | Goal tools |
| T013 | `syl-009.5.1` | Log the tool arguments, not just the name |
| T014 | `syl-009.5.2` | Revoking her stops her, and leaves the phone working |
| T015 | `syl-009.6.1` | The reader turn's tool surface stays provably empty |
| T016 | `syl-009.6.2` | One reference to the MCP config, statically enforced |
| T017 | `syl-009.7.1` | Acceptance: she can act |
| T018 | `syl-009.7.2` | The live proof, by hand |

## Ready at the start — four independent tracks

- `syl-009.1.1` — the scope, and the chain behind it
- `syl-009.2.2` — the human-time resolver, pure and isolated
- `syl-009.6.1`, `syl-009.6.2` — containment tests, which must pass NOW and keep passing
- `syl-009.7.1` — the acceptance test, written RED first and declared

`syl-009.6.*` deserve to go first. They are the tests that say untrusted text can
never reach a tool that acts, and they should be green before anything gains the
ability to act.
