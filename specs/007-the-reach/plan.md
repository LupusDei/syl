# Plan — The Reach (`syl-013`)

**Feature**: `007-the-reach` | **Date**: 2026-08-10, revised 2026-08-11
**Epic**: `syl-013` | **Priority**: P0
**Depends on**: `syl-009` (complete)

## Summary

Give Syl a browser she drives, at hosts the Commander allowed, with her own
profile and her own per-site credentials, so she can act on sites that have no
API. She states a goal once through `reach_do` and a **delegate** — a sub-agent
that reads and clicks — runs the loop. Every action comes back as facts —
reversible?, whose?, what does it cost? — and lands in a ledger with its
`because`. Nothing in the epic refuses on her behalf except the host allowlist,
which bounds *where* and never *what*.

## The architectural decision, and why

**The browser runs in the service, and she drives it over loopback through her
existing MCP surface. It does not run in her turn.**

This is `syl-009`'s "one door" argument, unchanged. Her tools call Syl's own HTTP
API (`backend/src/tools/client.ts`, which refuses a non-loopback base URL), and
the API is where validation, the allowlist, the ledger and the credential
boundary live. Putting a browser driver *in her turn* — a third-party MCP server,
or built-in tools re-enabled — would give her a second path to the outside with
none of those, and it would put credentials in a turn's context. It also breaks
constraint 3's neighbourhood: `tools: ""` is the property that makes every other
containment claim in this project checkable, and re-opening it for this would
cost more than it buys.

So the shape is:

```
her turn --MCP--> tools/server.ts  [HER SURFACE: 10 verbs + reach_do + the granular 6]
                       |
                   reach_do(goal, host, because)
                       |
                  loopback HTTP, agent scope
                       |
              routes/reach.ts  POST /reach/do
                       |
              reach/delegate.ts ── spawns ──> claude -p   [THE DELEGATE]
                       ^                          |         no soul, no memory,
                       |                          |         no turn context
                  outcome: done | blocked         |
                  | question  (validated,         |  MCP
                   capped, fenced)                v
                       |            tools/server.ts  [DELEGATE SURFACE: reach_* ONLY]
                       |                          |
                       |                     loopback HTTP, agent scope
                       |                          |
                       +--------------------- routes/reach.ts
                                                  |
                                       reach/session.ts     <-- the ONE door
                                    |        |         |          |
                            browser.ts  consequence  ledger   read.ts
                                    |                             |
                        allowlist.ts (the chokepoint)      runReaderTurn
                                                          (sealed: --tools "")
```

`backend/src/reach/session.ts` is the single function that performs a page
action, computes its consequence, and writes the ledger row — in that order, in
one place. Not three collaborating modules that a caller must remember to call in
sequence. `docs/CONTEXT.md`: *a guarantee that depends on somebody calling a hook
is a behavioural instruction wearing a mechanism's clothes.*

**Note what the diagram makes visible.** There is still exactly one door onto a
page, and both callers — her, steering, and the delegate, looping — go through
it. The delegate is not a second path to the outside; it is a second *caller* of
the same one, with a strictly smaller verb set. If it were a second path it would
need its own allowlist and its own ledger, and that is the design this project
rejected in `syl-009`.

## The delegate

**Added 2026-08-11.** The first draft had her drive the page turn by turn
from her main conversation. The Commander called that clunky. It also put a full
page snapshot into the context holding his memory, his goals and ten verbs over
his data, once per look — so the fix for the ergonomics and the fix for the
containment turn out to be the same change. `spec.md` § *The residual* states
precisely what that recovers and what it does not.

### How it is spawned

`backend/src/reach/delegate.ts`, and it is **`runReaderTurn`'s construction with
a different surface** — that similarity is the point, and the file should say so.

```ts
// Options built FROM SCRATCH. Nothing is spread in from a caller.
runTurn({
  systemPrompt: DELEGATE_SYSTEM_PROMPT,   // the operating loop. NOT SOUL.md
  tools: "",                              // no built-ins. Its verbs are MCP
  mcpConfig: delegateToolConfigPath(home),// the reach-only declaration
  strictMcpConfig: true,
  settingSources: "",                     // no hooks, no ambient skills
  permissionMode: "bypassPermissions",    // nobody can approve; see below
  cwd: sylHome,
  model, claudeBin, onEvent,
})
```

Whitelisted, not spread. `reader.ts` says why in as many words: *"there is no
path in, and no path a caller can open without editing that whitelist."* The
delegate needs the same protection for the same reason — it is one careless
`...options` away from inheriting her soul.

**`bypassPermissions` here is uncomfortable and it is correct.** `CLAUDE.md` says
it is *"actively dangerous the moment untrusted text enters a prompt"*, and
untrusted text is exactly what a delegate reads. The resolution is the sentence
after it: constrain the tool surface, because that is what bounds what
`bypassPermissions` can reach. With `--tools ""` and a reach-only MCP config,
what it can reach is six verbs at one host. That, not the permission mode, is the
boundary.

### What it is handed

| handed | why |
|---|---|
| the **goal**, verbatim from `reach_do` | it is the whole instruction |
| the **host** | its chokepoint predicate is `assertAllowed(url, [host])` — that host alone, not the allowlist |
| a **reach session id** | so `session.ts` knows which browser context, and so every ledger row carries it |
| the **operating loop** as standing orders | below |
| a **step budget** | and running out returns `blocked`, never silence |

Not handed: `SOUL.md`, the working-memory projection, a composed turn context,
his name, his goals, any credential. The credential is never handed to any turn —
it is read by `keychain.ts` and injected into a page by `browser.ts`, which is
Phase 2's property and is unchanged by this.

### Its loop

Taken from OpenClaw's `browser-automation` skill rather than derived, and cited
in `spec.md` § *The delegate*:

> *"check status/tabs first, label task tabs, snapshot before acting, resnapshot
> after UI changes, recover stale refs once, and report login/2FA/captcha or
> camera/microphone blockers as manual action instead of guessing."*

With one addition of our own, which is the whole reason `reach_read` exists:

> **Ask the page before you snapshot it.** `reach_read(question)` for anything
> you need to *know*; `reach_look` only when you need a ref to *click*.

Two reasons, and the second is the one that matters. It is cheaper — a sentence
instead of a page. And it moves that reading into a turn with an empty tool
surface: `reach_read` answers through `runReaderTurn`, so the page's text is
processed by something structurally incapable of clicking, and only a validated
sentence crosses into the context that can.

`report ... as manual action instead of guessing` is constraint 4's shape wearing
different clothes, and it should be implemented as such: a blocker is an
**outcome**, not a failure, and it comes back with everything done so far.

### What it returns

```ts
type DelegateOutcome =
  | { status: "done";     summary: string; actions: LedgerRef[] }
  | { status: "blocked";  summary: string; blocker: Blocker; actions: LedgerRef[] }
  | { status: "question"; summary: string; question: string;  actions: LedgerRef[] }
```

Three outcomes and **no fourth**, the same rule as `frame-gate.ts`'s
`withinFrame | atEdge` with no third answer meaning "stopped". A crash, a timeout
or an exhausted budget is a `blocked`, carrying what it had done — it is never an
empty return.

`actions[]` are the ledger rows the delegate produced. She is told what happened
*and* handed the record of it, so the two can be compared instead of the summary
being trusted. Same move as `urgentBecauseHeSaid`: a conclusion can only be
trusted, evidence can be checked.

**On the way back it is validated or discarded, capped, and fenced.** The
delegate has read hostile text and is now writing a summary that lands in her
main conversation, which is the one path this design does not close.
`backend/src/agents/fencing.ts` already exists for precisely this and is reused
rather than reinvented — its own header says why an agent's answer is more
dangerous than an article: it is *plausible*, in the right register, from a
source she trusts, and it arrives because she asked for it.

### Its tool surface, and why that is a file rather than a policy

`backend/src/tools/server.ts` today derives `advertisedTools()` from
`TOOLS ∩ HANDLERS`. It gains a **surface** — `"commander"` or `"delegate"` —
read from its environment, which the declaration file sets. The delegate's
declaration lives at `~/.syl/tools/delegate-hands.json`, written by
`tools/config.ts` at boot beside `hands.json`, `0600`, with its own agent
credential.

Two properties, and the second is the one a test has to pin:

1. `tools/list` on the delegate surface returns the reach verbs only.
2. `tools/call` naming `remind_me` on the delegate surface is **refused**.
   Filtering the list is not confinement; a model that has seen the name once can
   call it. The handler lookup itself is scoped by surface.

**This is deliberately unlike OpenClaw's arrangement**, which reaches a sub-agent
capability through two config layers whose interaction its own documentation has
to warn about (*"`tools.subagents.tools.allow: ["browser"]` alone is not enough
because sub-agent policy is applied after profile filtering"*). A capability
that depends on evaluation order is a capability nobody can state. Ours is one
file, handed to one process, with no layer above it that can widen it.

### Page question-answering

`backend/src/reach/read.ts` — `answerFromPage(question, sessionId)`:

1. `session.ts` extracts the page's **readable text** (not the accessibility
   tree, not HTML — the OpenClaw phrasing is *"readable page text"* and the
   distinction is exactly what keeps element refs and script content out).
2. That text goes to `runReaderTurn` as untrusted content, with the question.
3. The answer comes back schema-validated or discarded, bounded, and says *"not
   on this page"* when it is not on the page.

**The point is that step 2 is the existing sealed shape, unmodified.** If this
becomes a bespoke prompt on a tool-bearing turn during implementation, the
central claim of the rewritten residual section quietly becomes false and nothing
fails — which is this project's named failure mode. `syl-013.1.10` carries a test
that the reader path is the one taken.

### Why Playwright

| Option | Why not |
|---|---|
| **Puppeteer** | Chromium-only in practice, weaker request-interception story for redirect chains, and no first-class persistent-context API of the shape we need for a profile that is hers. |
| **CDP by hand** | We would write the interception layer ourselves. The allowlist is the one thing that must not have a bug in it. |
| **Claude Code's own browser/computer-use tools** | Requires re-enabling built-in tools in her turn. Violates settled decision 3 and puts the allowlist above her instead of below her. |
| **A hosted browser API** | Third party in the credential path. Also carries her session off the machine. |
| **Playwright** ✅ | `launchPersistentContext(userDataDir)` gives her a profile that is hers by construction; `context.route("**")` is one chokepoint that sees navigations, subresources, XHR and each redirect hop; `serviceWorkers: "block"` closes the obvious hole. |

**Pin it exact**, with a root `overrides` mirror, the same shape
`onnxruntime-node@1.23.0` already uses in `backend/package.json`. Browser binaries
install to `~/.syl/browser/runtime` (`PLAYWRIGHT_BROWSERS_PATH`), never into the
repo — `scripts/check-no-secrets.mjs` and the repo's size are both reasons, and a
downloaded browser in `node_modules` is a supply-chain surface nobody reviews.

**Everything below `browser.ts` is written against our own types.** If the driver
is ever replaced, one file changes. That is what survives from the rejected
Option C: its real insight was never "HTTP first", it was "the hard parts are
independent of the transport".

### Why the allowlist is enforced at the request chokepoint

Three weaker places it could have gone, and why none of them:

- **In her prompt.** A behavioural instruction. `docs/CONTEXT.md` has three
  instances of an instruction drifting from the capability it assumed, and every
  failure was a fluent sentence rather than an error.
- **In the tool handler**, checking the URL she passed. She navigates by clicking,
  not by passing URLs. The second navigation is not one she named.
- **At the OS/proxy layer only.** Right in spirit, and it cannot see which
  *context* made the request, so the reach profile and the rest of the machine
  become the same subject.

`context.route("**")` sees every request the context makes including each hop of
a redirect chain, and calls one pure function. The purity matters: `allowlist.ts`
is where the tests live, and it is testable without a browser.

**And it reuses `classifyAddress` from
`backend/src/connections/address-guard.ts`.** An allowed hostname that resolves
to a private address must still be refused, and the service already has exactly
one answer to that question for `safeFetch`. Two answers to one question is how
they drift.

### Why her own profile, and never his

Stated as a settled decision, and the reasoning is worth having in the plan
because it constrains the code: if the browser inherits his sessions, **the
allowlist becomes the only boundary** between Syl and his bank. An allowlist is a
good boundary and a bad only-boundary — a one-line config change should not be
able to hand her his bank with a live session attached.

So `userDataDir` is `~/.syl/browser/profile`, mode `0700`, and there is a test
that no source file under `backend/src/` names a path under
`~/Library/Application Support/Google/Chrome` or `~/Library/Safari`. A negative
test on a path is cheap and it is the kind of thing that gets added "later"
otherwise.

### Why credentials are console-only

`docs/CONTEXT.md` §7 already made this argument for the `admin` scope and it is
the same one: **what makes a boundary defensible is not the column, it is where a
value can be created.** `POST /auth/pair` cannot mint `admin` because `pair()`
takes no scope argument at all, so no future route is one refactor away from
accepting one.

Reach credentials get the strongest version of that: they are not in `syl.db` at
all. They live in the OS keychain under `syl.reach.<host>`, are written by
`npm run reach -- --add-credential <host>` which needs console access, and the
only code that reads them hands them to a page — never to a response, never to a
turn. `backend/tests/integration/reach-credential.test.ts` asserts it three ways,
copying `agent-credential.test.ts`: from the contract, from the running service,
and from the source.

### Why the consequence layer must be provably toothless

This is the part most likely to rot during implementation. "Report a missing
authorisation check" is one small edit away from "block on a missing
authorisation check", the edit looks like a safety improvement, and nothing
fails.

So it is guarded by shape, not by intention:
`backend/tests/unit/reach-consequence-has-no-veto.test.ts` uses
`backend/tests/helpers/source-scan.ts` to assert `consequence.ts` and
`authorization-probe.ts` contain no refusal path, and an acceptance test drives a
real action carrying `missingAuthorizationCheck: true` all the way through.
**Put the guard in before the handler** — a guard added after is shaped by the
code it finds.

The one thing that does refuse is the allowlist, and it refuses *where*, never
*what*. That asymmetry is the whole design and it should be legible from the test
names.

## Technical Context

**Stack**: Node 22, TypeScript strict + `noUncheckedIndexedAccess`, Express 5,
`node:sqlite`, Vitest. Frontend: Vite + React. New: Playwright (pinned exact).
**Storage**: `syl.db` for the allowlist, the ledger and the frame. The OS
keychain for credentials. `~/.syl/browser/profile` for her session state.
**Testing**: Vitest. Acceptance tests under `backend/tests/acceptance/`, red-first
and declared in `tests/expected-failures.json`.
**Constraints**: all seven non-negotiables. Constraint 4's *shape* binds hardest
here — an action that dies quietly at the frame's edge is the same broken promise
as a vanished reminder.

## Files Changed

| File | Change |
|---|---|
| `backend/src/reach/allowlist.ts` | **new** — pure. `assertAllowed(url, hosts)`; reuses `classifyAddress` |
| `backend/src/reach/browser.ts` | **new** — persistent context, her profile, the `route("**")` chokepoint, headless default, `signIn(host)` |
| `backend/src/reach/session.ts` | **new** — the one door: act, describe, record; also extracts readable page text for `read.ts` |
| `backend/src/reach/delegate.ts` | **new** — the delegate: spawn, standing orders, loop, outcome. `runReaderTurn`'s construction with a different surface |
| `backend/src/reach/read.ts` | **new** — `answerFromPage()`; the page's readable text through `runReaderTurn`, sealed |
| `backend/src/reach/outcome.ts` | **new** — pure. The `DelegateOutcome` codec: validate or discard, cap, fence via `agents/fencing.ts` |
| `backend/src/reach/consequence.ts` | **new** — pure. Facts only; no refusal path |
| `backend/src/reach/authorization-probe.ts` | **new** — the Sydney tell |
| `backend/src/reach/keychain.ts` | **new** — `/usr/bin/security` via `execFile`, never a shell |
| `backend/src/reach/frame-gate.ts` | **new** — inside the frame / at its edge; never a silent stop |
| `backend/src/routes/reach.ts` | **new** — `/reach/*`; `POST /reach/do` is agent-scoped; `hosts`, `frame` and `ledger` are admin-scoped |
| `backend/src/services/reach-allowlist-service.ts` | **new** |
| `backend/src/services/reach-ledger-service.ts` | **new** |
| `backend/src/services/reach-frame-service.ts` | **new** |
| `backend/src/ops/cli/reach.ts` | **new** — console-only credential registration and revocation |
| `backend/src/migrations/00NN_reach.sql` | **new** — allowlist, ledger, frame. **Check the highest existing number first** (0021 today) |
| `backend/src/middleware/auth.ts` | `AGENT_SURFACE` gains `/reach`; `/reach/hosts`, `/reach/frame`, `/reach/ledger` stay admin |
| `backend/src/tools/schemas.ts` | `reach_do`, `reach_read`, and the granular six; `surfaceBytes()` ceiling reasserted |
| `backend/src/tools/server.ts` | their handlers, thin, over the loopback client; `advertisedTools()` and the handler lookup gain a **surface** (`commander` \| `delegate`) |
| `backend/src/tools/config.ts` | `delegateToolConfigPath(home)` — `~/.syl/tools/delegate-hands.json`, `0600`, written at boot beside `hands.json` |
| `backend/src/index.ts` | mount `/reach`; wire the reach session to the service lifecycle |
| `backend/package.json` | Playwright, pinned exact (mirror in the root `overrides`) |
| `frontend/src/features/reach/LedgerView.tsx` | **new** — the ledger, modelled on `features/logs/LogsView.tsx` |
| `frontend/src/features/reach/reach-ledger-model.ts` | **new** — the pure model, modelled on `logs/log-model.ts` |
| `frontend/src/features/reach/FrameView.tsx` | **new** — he sets the frame once |
| `frontend/src/app/nav.ts` | two `NAV_ITEMS` entries |
| `frontend/src/app/App.tsx` | two `VIEWS` entries |
| `docs/RUNBOOK.md` | installing the browser runtime; registering a credential; watching a run |
| `specs/007-the-reach/soul-draft.md` | **new** — proposed wording. `SOUL.md` is NOT edited |

**Migration numbering**: `readMigrations` refuses a gap, so the lowest free
number goes to whoever is *certain* to need one. This epic is certain, but three
collisions in one day came from claiming a number early — check the highest at
the moment you write the file, do not trust `0022` because this document says so.

## Phase 1: The reach

The browser she drives, her profile, the allowlist below her, and the front door
she states a goal at. This is the phase that decides whether the rest is safe, so
its tests are the ones to write first: `allowlist.ts` is pure and can be fully
tested before a browser exists.

Land the enforcement tests (redirect, subresource, XHR, `window.open`) before the
verbs. A guard added before shapes the code that meets it — and the same rule
puts the delegate-confinement sweep (`syl-013.1.11`) **before** `delegate.ts`,
not after it. A confinement test written against a delegate that already exists
is a test shaped by the surface it found.

Order within the phase: the predicate, the chokepoint, the one door, the verbs
and the two surfaces, page question-answering, the confinement sweep, then the
delegate.

## Phase 2: Credentials

Per-host, keychain, console-only, individually revocable. The revocation test is
the load-bearing one and it has two halves: the revoked host stops, and a
different host keeps working. Half of that test is the half that always gets
written.

## Phase 3: Consequence visibility

Pure modules, no I/O, no refusal path. The Sydney tell is here. The structural
guard (`no veto`) lands with the modules, not after.

## Phase 4: The ledger

The migration, the service, the route, the admin view — and the static test that
exactly one function acts and it is the one that records.

## Phase 5: The spending frame

Money and the softer currencies, set once. `frame-gate.ts` returns
`withinFrame | atEdge(question)` and there is no third answer that means
"stopped".

## Phase 6: Her soul

A draft, proposed not assumed, in `specs/007-the-reach/soul-draft.md`. It must
say out loud that `SOUL.md` already carries the governing rules — *"Ask only when
a wrong guess is expensive"* and the friend test — and that what was missing was
never the rule, it was facts for it to operate on. Then his ruling, recorded
verbatim in `docs/CONTEXT.md` §2 before anything is edited.

## Phase 7: Proof

A red-first acceptance test against a local fixture site — driven through **one**
`reach_do` call, not fifteen — the residual pinned so neither a reach session nor
a delegate can be mistaken for a reader turn, and the live booking — watched, in
the visible mode, because "it worked" and "I watched it work" are different
claims.

`syl-013.7.2` grew a second half with the delegate: alongside *a reach session is
not a reader turn*, it now also pins *her main conversation ingests no page
text*, by inspecting the turn's events rather than by assertion. That is the one
property the revision actually recovered, and an unpinned recovered property is
the next thing to quietly stop being true.

## Parallel Execution

Seven beads are ready at the start, confirmed against `bd ready` rather than
asserted — `syl-013.1.1` (the pure allowlist predicate), `.1.2` (its store),
`.1.3` (Playwright), `.3.1` (the pure consequence module, buildable against
captured page observations before a browser exists), `.4.1` (the ledger
migration), `.5.1` (the frame's store) and `.6.1` (the soul draft, which is prose
and blocks nothing).

**Ordering lives at task level only.** Epic-level dependencies were wired and
then removed: on this version of `bd` a blocker on an epic propagates down and
removes every task beneath it from `bd ready`, which hid four genuinely
independent starting tracks. `specs/007-the-reach/beads-import.md` records that
and the `--id`/`--parent` mechanic beside it.

Everything in Phase 2 needs `browser.ts` (`syl-013.1.4`). Phase 4's service needs
its migration. Phase 7 needs everything.

The three beads added on 2026-08-11 are all downstream of `.1.7`, so the ready
set at the start is unchanged — re-verified against `bd ready`, not assumed.

`syl-013.1.5` (the enforcement tests), `syl-013.3.5` (the no-veto guard) and
`syl-013.1.11` (the delegate-confinement sweep) deserve to go early for the same
reason `syl-009.6.*` did: they are the tests that say what this system must never
do, and they should be green before anything gains the ability to do it. `.1.11`
is wired **as a blocker on `.1.9`** for exactly that reason — the delegate is
written to meet a confinement test that already exists, not the other way round.

## Risks

- **The allowlist has a hole and nothing fails.** The whole boundary. Mitigated
  by one chokepoint, a pure testable predicate, `serviceWorkers: "block"`, and
  four named bypass tests. Mutation-test them: break each on purpose, watch it go
  red, put it back. A correspondence check that cannot fail is a consistency
  check in costume.
- **Consequence visibility quietly becomes a veto.** Mitigated by the structural
  test and by an acceptance test that proceeds *through* a flagged action.
- **A credential leaks into a turn's context.** Mitigated by the three-way
  containment test and by the secret never being an HTTP response field.
- **The residual is forgotten.** Someone reads "she has a browser" and assumes
  the reader turn's property covers it. Mitigated by `syl-013.7.2` and by the
  spec saying it in its own section.
- **Playwright's browser download in CI.** It is large and it is a network
  dependency. Keep it out of the default test path; the browser-driving tests are
  their own suite and the pure ones are not.
- **Scope creep into a verb menu.** The first `book_gym_class` is the moment this
  epic became the thing it was written against.
- **The delegate inherits her soul or her memory by a stray spread.** The whole
  containment claim, gone in one `...options`. Mitigated by building its turn
  options from scratch (`reader.ts`'s pattern) and by `syl-013.1.11` asserting
  the system prompt by **equality**, as `tests/unit/reader.test.ts` already does
  for the reader — so the test does not have to enumerate everything it must not
  contain.
- **The delegate's surface widens because someone adds a verb to `TOOLS`.** The
  confinement sweep names the forbidden verbs as **literals**, not imported from
  a constant. `syl-009.6` learned this the expensive way: a test that imports
  `AGENT_SURFACE` agrees with a widened `AGENT_SURFACE` and stays green.
- **`reach_read` stops being a reader turn.** It is one refactor from "just ask
  the delegate to summarise the page it already has", the refactor looks like a
  simplification, and it silently deletes the residual section's main claim.
  Mitigated by `syl-013.1.10`'s test on which path is taken, and by the claim
  being written down where a reviewer will see it.
- **The outcome channel is treated as safe because it is "just a summary".** It
  is text written after reading a hostile page. Mitigated by reusing
  `agents/fencing.ts` rather than formatting a string at the call site, and by
  the spec refusing to claim the channel is closed.
- **A delegate that never terminates.** A step budget, and exhausting it returns
  `blocked` with the work so far — never an empty return and never a hang.

## Verification Steps

- [ ] `npm run verify` green from the worktree, not the main checkout
- [ ] A redirect from an allowed host to a disallowed one is aborted
- [ ] `~/.syl/browser/profile` exists at `0700`; no source names his Chrome profile
- [ ] An `agent` token gets 403 from `POST /reach/hosts`
- [ ] `npm run reach -- --revoke gym.example` stops that host and leaves another working
- [ ] An action with `missingAuthorizationCheck: true` still executes when she proceeds
- [ ] The ledger row exists with its `because` and its cost
- [ ] `us4-untrusted-content-cannot-act.test.ts` still green
- [ ] One `reach_do` call books the fixture site end to end
- [ ] Her main conversation for that turn contains no page snapshot
- [ ] The delegate's `tools/list` has no Syl verb, and `remind_me` named directly
      is refused rather than absent
- [ ] `reach_read` answers a page question through `runReaderTurn`, tool surface
      empty
- [ ] A delegate that runs out of steps returns `blocked` carrying its ledger rows
- [ ] The live booking, watched, in the visible mode

## Bead Map

41 beads: 1 root, 7 sub-epics, 33 tasks. **Phase numbering is unchanged and no
existing bead was renumbered** — the 2026-08-11 revision rewrote `.1.6` and
`.1.7` in place and appended `.1.9`, `.1.10` and `.1.11` to Phase 1.

- `syl-013` — Syl 13: the reach — a browser she drives, at hosts he allowed
  - `syl-013.1` Phase 1: the reach — `.1.1` `.1.2` `.1.3` `.1.4` `.1.5` `.1.6` `.1.7` `.1.8` `.1.9` `.1.10` `.1.11`
  - `syl-013.2` Phase 2: credentials — `.2.1` `.2.2` `.2.3` `.2.4`
  - `syl-013.3` Phase 3: consequence visibility — `.3.1` `.3.2` `.3.3` `.3.4` `.3.5`
  - `syl-013.4` Phase 4: the ledger — `.4.1` `.4.2` `.4.3` `.4.4` `.4.5`
  - `syl-013.5` Phase 5: the spending frame — `.5.1` `.5.2` `.5.3`
  - `syl-013.6` Phase 6: her soul — `.6.1` `.6.2`
  - `syl-013.7` Phase 7: proof — `.7.1` `.7.2` `.7.3`

**The root is `syl-013`, not `syl-010`.** `syl-010` was taken on 2026-08-10 by
"Who she is" (`specs/006-who-she-is/`), and `syl-011` and `syl-012` are taken too.
See `spec.md` § *Recorded assumptions*.
