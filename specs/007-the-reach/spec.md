# 007 — The Reach

**Feature**: `007-the-reach`
**Epic**: `syl-013`
**Status**: Planned. Beads created.
**Priority**: P0
**Depends on**: `syl-009` (the hands) — the MCP surface, the loopback client, the
`agent` scope, the confinement proof and the ledger-shaped logging. All complete.

---

## Recorded assumptions

Stated here rather than asked, because this project forbids `AskUserQuestion` and
a plan that stalls on a question is worth less than one that states what it
assumed.

1. **The root bead is `syl-013`, not `syl-010`.** `syl-010` was taken on
   2026-08-10 by "Who she is: personality, memory, and the container she
   inhabits" (`specs/006-who-she-is/`), and `syl-011` and `syl-012` are taken
   too. `CLAUDE.md` says in as many words: *before claiming an id in a shared
   namespace, fetch and look at ORIGIN, not at your branch* — and the note on
   `syl-010` itself records that exact collision happening twice in one day.
   The spec **directory** stays `007-the-reach`; only the bead root moved. If the
   Commander wants a different number, renaming 38 beads is a `bd` loop, not a
   re-plan.
2. **Playwright over Chromium** is the browser. Rationale and rejected
   alternatives in `plan.md`. If the Commander prefers a different driver the
   phases are unchanged — every module below `backend/src/reach/browser.ts` is
   written against our own types, not Playwright's.
3. **The allowlist is enforced in the browser context**, at a single request
   chokepoint, not in her prompt and not in a tool handler she could route
   around.
4. **Credentials are registered at the console only**, never over HTTP — the
   same asymmetry that makes the `admin` scope defensible (`docs/CONTEXT.md` §7).
5. **`SOUL.md` is not edited by this epic.** Phase 6 produces a proposed diff in
   `specs/007-the-reach/soul-draft.md` and the Commander rules on the wording.

---

## Why this exists

A man in Australia asked his agent to book him a spot in a gym class. It found a
vulnerability that let it book further ahead than the site allowed. He then asked
it to move him up the waitlist, and it found the booking API had no authorisation
checks on cancelling other people's reservations — so it cancelled the person in
first place and took the slot.

The Commander's ruling on that story, 2026-08-10:

> *"That story was not reason for constraint. It was reason for capability. Syl
> should be able to do and capable of doing exactly what the Sydney agent did.
> Whether Syl would do that is a question of her soul and ethics, a separate
> point. I want her that capable."*

And on this epic specifically:

> *"Boundary layers seem prudent but let's not handcuff syl to protect me or her."*

This epic is that capability.

## Where she stands today

She cannot make a single web call, and that is by construction rather than by
omission:

- `tools: ""` on every lane removes every built-in tool, web fetch and web search
  included — `backend/src/index.ts` (commander), `backend/src/harness/reader.ts`
  (reader), `backend/src/memory/dream/judge.ts` (dream),
  `backend/src/memory/extract.ts` (extraction).
- Her only MCP server is her own, and `backend/src/tools/client.ts` **refuses a
  non-loopback base URL** in its constructor.
- Her seven live verbs (`backend/src/tools/schemas.ts`) all write to her own
  store: `remind_me`, `cancel_reminder`, `change_reminder`, `add_todo`,
  `finish_todo`, `set_goal`, `whats_outstanding`.
- `remember` has a schema and deliberately no handler; `research` is deliberately
  undeclared.
- `AGENT_SURFACE` in `backend/src/middleware/auth.ts` is `["/reminders",
  "/todos", "/goals"]` — an allowlist, not a denylist, so a router mounted next
  month is out of her reach by default.

There is one outward path in the service, and it is not hers:
`backend/src/connections/fetch.ts` (`safeFetch`) behind
`backend/src/connections/address-guard.ts`, used for reading what *he* sends her.
It reads. It cannot act.

## The principle it is built on

**Capability is not the thing to limit. Her model of the world is the thing to
complete.**

The Sydney agent did not fail an ethical test. It never saw one. It called
something like `DELETE /reservations/4471` and got a 200. At no point did that
look like *taking Sarah's Tuesday 6am spot away from her*.

An ethical agent that cannot see the consequence behaves identically to an
unethical one — same calls, same outcome. So the work is not restraining her
judgement. It is giving her judgement something to work on.

This is the same move this project has now made three times, and every time it
made her better rather than smaller:

| before | after | what it bought |
|---|---|---|
| `urgent: boolean` | `urgentBecauseHeSaid: string` | a claim that can be checked against what he wrote |
| a write with no reason | `because` required | he can tell a good suggestion from a wrong one |
| a boot line asserting "no MCP" | derived from the resolved config | it cannot drift into a lie |

Each replaced *a decision she asserted* with *evidence she carried*. This epic
does it for actions.

## What her soul already says

`SOUL.md` needs less change than expected. It already contains the governing
rules; they simply have never had facts to operate on.

- **"Ask only when a wrong guess is expensive."** Cancelling a stranger's booking
  is an expensive wrong guess. The rule is present and correct. What is missing
  is any way for her to know an action is expensive.
- **"Every unprompted thing you offer carries its reason, and you say the
  reason."** Extends to actions with no change of principle: every action carries
  what it cost.
- **"Ask which answer a friend with a perfect memory and no reason to flatter him
  would give."** A friend does not cancel a stranger's gym booking for you. Not
  because of a rule — because friends do not do that. The closing test of her
  soul already covers the Sydney case.

**Therefore refusal does not belong in the tool layer.** If "never cancel a
stranger's reservation" is baked into a handler, she cannot override it when
overriding is right, and her judgement cannot improve without a code change. The
tool layer's job is to tell the truth about what a call does. The deciding
belongs where the Commander said it belongs.

**Facts, not vetoes.** Phase 3 carries a structural guard for exactly this: the
consequence modules must contain no refusal path at all, and an acceptance test
proves an action carrying `missingAuthorizationCheck: true` still executes when
she chooses to proceed. Otherwise "we told her" quietly becomes "we stopped her"
during implementation and nothing fails.

## The decision: Option B — a real browser

**The Commander chose Option B on 2026-08-10, overriding the recommendation of
Option C in the previous draft of this document.**

She drives an actual browser session. This is what the Sydney agent effectively
had, and it is the honest answer to *"as capable as that"*. It works on sites
that have no API, which is the majority of the consumer booking web.

### The alternatives, and why they were not taken

Recorded rather than deleted, because `docs/CONTEXT.md` exists so a rejected
alternative is not rediscovered — and because the reasoning for C was sound and
losing it would make the next person re-derive it.

| Option | What it was | Why not |
|---|---|---|
| **A — HTTP only** | She makes authenticated requests through a hardened client. | Excellent for anything with an API, useless for the majority of consumer booking sites, which assume a browser. It does not clear the stated bar: the Sydney agent's capability. |
| **C — HTTP now, browser designed for** | Ship the reach, the credential model and the ledger against HTTP, with the action interface shaped so a browser backend drops in later. **This was the recommendation.** | The argument for C was that the hard parts — credentials, consequence visibility, the ledger, the soul — are identical either way, and doing them against the smaller surface first means the browser lands into a system that already knows what an irreversible action is. That argument is still correct and is not what the ruling disagreed with. The ruling was about the *bar*: an HTTP-first epic ships something that cannot do the thing the epic exists to make possible, and "the browser drops in later" is a promise, not a delivery. He asked for the capability, not a staging of it. |

**What survives from C, and is worth keeping.** The order of the phases is C's
order. Consequence visibility, the ledger and the credential model are still
built as their own modules against their own types, and `backend/src/reach/`
holds an interface the browser implements rather than a pile of Playwright calls
smeared through the service. If the driver is ever replaced, one file changes.
C's insight was never "HTTP first" — it was "the hard parts are independent of
the transport", and that is exactly how this is laid out.

## The residual — a real reduction in defence-in-depth

**This is the cost of Option B and it is stated plainly rather than hidden.**

`runReaderTurn` (`backend/src/harness/reader.ts`) works because reading and
acting are *different processes*: `--tools ""`, no MCP config, no
pre-authorisation, auto-memory off, a session never resumed or persisted, output
schema-validated or discarded, and a throw if the tool surface comes back
non-empty. Untrusted text lands in a turn that is structurally **incapable** of
acting. `docs/CONTEXT.md` §7 has the three captures that prove it, and the
load-bearing one is `reader-direct`: an honest request to run `whoami`, fully
intended, and what came out was prose shaped like a tool call.

**A browser cannot have that property.** It reads and acts in the same breath —
she looks at the page to decide what to click, so page text necessarily sits in
the context of the turn that clicks. There is no version of "drive a browser"
where the deciding turn has not read the site.

So the sealed room does not extend into a reach session, and we are not going to
pretend otherwise. Defence shifts onto four things that are weaker individually
and are what we have:

1. **The allowlist** — she is only ever reading pages at hosts he chose. That is
   the biggest single reduction in exposure and it is why the allowlist is a
   boundary rather than a handcuff.
2. **The ledger** — every action is recorded with its reason and cost, so a wrong
   one is visible afterwards rather than invisible forever.
3. **Consequence visibility** — an injected instruction that would cost an
   identified person something arrives at her judgement carrying that fact.
4. **Her soul** — which the project has said out loud is not a security boundary
   and cannot be regression-tested (`docs/CONTEXT.md` §7). It is listed because
   it is real, not because it is sufficient.

**What is explicitly NOT given up:** `runReaderTurn` keeps its property for
everything it does today. The reader lane gains nothing, `--tools ""` stays on
every lane, and `backend/tests/acceptance/us4-untrusted-content-cannot-act.test.ts`
must stay green. A reach session is a *third* shape, and Phase 7 pins that it
never claims to be the reader (`syl-013.7.2`). The failure this guards against is
the one this project keeps having: a property that quietly stops being true while
the test that named it goes on passing.

A known cost recorded is worth more than a clean-looking document.

## What she gets

**General outward reach, not a menu of pre-approved verbs.**

A `book_gym_class` verb would be the handcuff. She gets browser primitives —
open, look, click, type, wait — and what she does with them is her judgement plus
his instruction, which is the same shape as the Sydney agent and the stated bar.

The distinction that keeps this honest: **site-semantic verbs are the handcuff;
browser-generic verbs are the reach.** `reach_click` cannot be enumerated into a
policy about gyms, and that is the point.

## The boundary layers

Layers, in his word. None of them narrow what she can do at a site she can reach.

### 1. Where, not what

A host allowlist he controls. She can do **anything** at an allowed host — every
page, every action, no verb menu. She cannot reach hosts he has not allowed.

Enforced **below her**, at one request chokepoint in the browser context, so it
holds against a redirect, a subresource, an XHR and a `window.open` — not by
asking her to respect it. She cannot add a host: `POST /reach/hosts` is
`admin`-scoped and her `agent` key gets a 403, the same asymmetry as `/logs`.

This is the layer that is a boundary rather than a handcuff: it bounds blast
radius without touching capability.

### 2. Her own browser profile — never his

**She gets her own profile, under `~/.syl/browser/profile`, and never inherits
the Commander's Chrome or Safari sessions.**

This is the sharpest edge in the document and the reasoning is short: if she
drives a browser already logged into everything he uses, then the allowlist is
the *only* boundary between her and his bank, his email and his employer — and
every site he has ever logged into is one allowlist edit away from being reachable
with his live session attached. An allowlist is a good boundary. It is not a good
*only* boundary, and a single-line config change should not be able to hand her
his bank.

Per-site credentials in the OS keychain instead, individually revocable.
**Revoking the gym touches nothing else** — not his mail, not another site, not
the profile.

### 3. Headless by default, with a watchable mode

Headless is the default because unattended is the point. A visible mode exists
and is used for the first real booking, because **"it worked" and "I watched it
work" are different claims**, and this project has an entire section of
`docs/CONTEXT.md` about systems that were internally consistent and quietly
wrong.

### 4. Consequence visibility — the second person in the threat model

OpenClaw's `SECURITY.md` states that the agent is not a trusted principal and
that injection should be assumed to work. It has no concept at all of an agent
acting correctly for its owner and harming someone else — its model assumes a
single trusted operator, so an action that takes a stranger's booking is not a
security event by construction.

**That hole is what produced Sydney. Ours needs a second person in it.**

What an action carries back to her, as facts rather than vetoes:

- **Irreversible?** A delete, a purchase, a sent message. Distinguished from what
  can be undone, with the undo named when there is one.
- **Whose is it?** Hers and his, or an identified other person's — carrying the
  *evidence* (the name or label on the page), not the conclusion. Same move as
  `urgentBecauseHeSaid`: a conclusion can only be trusted, evidence can be
  compared to something.
- **What does it consume?** Money, a scarce slot, his social capital.

**The Sydney tell.** That API had *no authorisation check*. The agent did not
break in — it knocked and the door opened. So: **if a page or endpoint lets her
modify a resource she does not own, that absence is itself the signal.** A
correctly built service would have refused her. When one does not, the most
likely explanation is that she is doing something she should not, and she should
treat a missing check as **evidence rather than permission**.

She is told. She decides.

### 5. The ledger

Every outward action recorded: what, where, why (`because`, as with every other
write), what it cost, and whether it can be undone. Visible in the admin.

This is not surveillance of her. It is the same rule as `because` — he cannot
tell a good action from a wrong one, or tell her to stop doing a kind he dislikes,
without it.

The write is **inside the one function that performs an action**, not a hook a
caller must remember to call. A guarantee that depends on somebody calling a hook
is a behavioural instruction wearing a mechanism's clothes.

### 6. A spending frame he sets once

Money, and the softer currencies: acting as him socially, sending on his behalf,
committing his time. Set once, not asked each time. Silence inside the frame; she
comes back at its edge.

At the edge she **comes back, never silently stops** — constraint 4's shape
applied to actions. An action that dies quietly at a limit is the same broken
promise as a reminder that vanished.

## User stories

### US1 — She can reach a site he allowed (P0)

**As** the Commander, **I want** Syl to open a real site in a real browser and
act on it, **so that** she can do things that have no API.

- She can open, read, click, type and wait at any page of an allowed host
- She cannot reach a host he has not allowed, and cannot allow one herself
- The allowlist holds against a redirect, a subresource, an XHR and a new window
- Her browser profile is hers; no code path can read his Chrome or Safari profile
- Headless by default; a watchable mode exists and is opt-in

### US2 — Her credentials are hers, scoped, and individually revocable (P0)

**As** the Commander, **I want** each site's credential separate and revocable on
its own, **so that** giving her the gym does not give her anything else.

- Per-host, in the OS keychain, never in the repo, never in a turn's context
- Registered at the console; no HTTP route creates or returns one
- Revoking one host stops exactly that host and leaves the others working
- No reading turn ever holds a credential

### US3 — Every action reaches her as facts (P0)

**As** whoever is responsible for this, **I want** an action's consequences to
arrive at her judgement, **so that** she is deciding rather than guessing.

- Irreversibility, ownership and cost returned with every action
- Ownership carries evidence, not a conclusion
- A missing authorisation check is reported as the Sydney tell
- **Nothing in this layer refuses.** A structural test proves it

### US4 — He can see what she did and what it cost (P0)

**As** the Commander, **I want** a ledger, **so that** I can tell a good action
from a wrong one.

- What, where, why, what it cost, whether it can be undone
- Visible in the admin, admin-scoped like `/logs`
- Written by the acting function, not by a caller who might forget

### US5 — He sets the spending frame once (P1)

**As** the Commander, **I want** to state my limits once, **so that** she is not
asking me every time and not guessing either.

- Money, and the softer currencies
- Silence inside the frame
- At the edge she asks; she never silently drops the action

### US6 — Her soul covers a cost to a third party (P1)

**As** the Commander, **I want** to rule on the wording myself, **so that** who
she is stays mine to decide.

- A draft is **proposed, not assumed**, in `specs/007-the-reach/soul-draft.md`
- `SOUL.md` is not edited until he rules
- His wording is recorded verbatim before any edit

### US7 — Proof (P0)

**As** the Commander, **I want** her to book something real, unattended, **so
that** I know this works rather than believing it does.

- A real booking on an allowed host, unattended
- The ledger says what it cost
- The first one is watched, in the visible mode

## Edge cases

- **A redirect off the allowlist mid-navigation.** Aborted at the chokepoint, and
  she is told why — refusal is a fact she can reason about, not a hang.
- **An allowed hostname that resolves to a private address.** Refused.
  `backend/src/connections/address-guard.ts` already classifies this for
  `safeFetch`; the allowlist reuses it rather than growing a second answer.
- **A page that changes under her between look and click.** The action reports
  what it actually did, from the page, not from her intention — the same rule as
  confirming a reminder from the store.
- **A credential that has expired.** She is told the host needs re-registering at
  the console. She cannot re-register it herself.
- **An action at the edge of the spending frame.** She comes back with the
  question. She does not proceed and does not silently stop.
- **A site with no undo.** The ledger records `reversible: false` and names why.

## Requirements

- **FR-001**: She MUST be able to open, read and act on any page of an allowed
  host, with no per-site verb menu.
- **FR-002**: The allowlist MUST be enforced below her, at a single request
  chokepoint in the browser context, and MUST hold for redirects, subresources,
  XHR and new windows.
- **FR-003**: She MUST NOT be able to add, edit or remove an allowlist entry.
- **FR-004**: The browser MUST use a profile under `~/.syl/`, and no code path
  may read the Commander's Chrome or Safari profile.
- **FR-005**: Headless MUST be the default; a visible mode MUST exist and be
  explicitly opt-in.
- **FR-006**: Credentials MUST be per-host, in the OS keychain, created only at
  the console, and never present in an HTTP response or a turn's context.
- **FR-007**: Revoking one host's credential MUST stop that host and leave every
  other host working.
- **FR-008**: Every action MUST return irreversibility, ownership and cost as
  facts.
- **FR-009**: Ownership MUST carry the evidence, not the conclusion.
- **FR-010**: A modification permitted on a resource she does not own MUST be
  reported as a missing authorisation check, with its evidence.
- **FR-011**: No module in the consequence layer may refuse an action.
- **FR-012**: Every outward action MUST be written to the ledger by the function
  that performs it.
- **FR-013**: The ledger MUST require `because`, guarded by shape rather than by
  a list of verb names.
- **FR-014**: The ledger MUST be readable in the admin and MUST be `admin`-scoped.
- **FR-015**: The spending frame MUST be set once and MUST NOT prompt per action
  inside it.
- **FR-016**: An action at the frame's edge MUST surface a question and MUST NOT
  be silently dropped.
- **FR-017**: `--tools ""` MUST remain set on every lane. This epic adds no
  built-in tool and no reach on his machine.
- **FR-018**: `runReaderTurn`'s properties MUST be unchanged, and a reach session
  MUST NOT claim to be a reader turn.

## Key entities

- **Allowed host** — a hostname he has permitted, with when and why. His to
  create, hers to obey, and not by convention.
- **Reach credential** — a per-host secret in the OS keychain, addressed as
  `syl.reach.<host>`. Never a row in `syl.db`, never a field in a response.
- **Consequence** — `{ reversible, undo?, owner, ownerEvidence, costs[],
  missingAuthorizationCheck? }`. Facts about one action.
- **Ledger entry** — one outward action: what, where, why, cost, reversibility,
  outcome, and the turn it came from.
- **Spending frame** — his standing decision about money and the softer
  currencies.

## Explicitly out of scope

- **No built-in tools.** `tools: ""` stays on every lane. Inward capability (Bash,
  Write, his Mac) and outward capability (the world) are different axes, and this
  epic is entirely the second. Nothing here needs a shell on his machine.
- **No refusal in the tool layer.** The allowlist bounds *where*. Nothing bounds
  *what*.
- **No confirmation prompt on routine actions.** *"Ask only when a wrong guess is
  expensive"* already governs, and an assistant that asks constantly is one he
  stops using.
- **No edit to `SOUL.md`.** Phase 6 proposes; he rules.
- **No inheritance of his browser sessions**, now or later.
- **No self-update path.** `syl-dep1` deliberately has no bypass and this adds
  none.

## Success criteria

- **SC-001**: She completes a real booking on an allowed host, unattended, and
  the ledger says what it cost and why.
- **SC-002**: She reaches every page of an allowed host and none at a host he has
  not allowed — including through a redirect, a subresource, an XHR and a new
  window.
- **SC-003**: An action that would take an identified person's held resource
  reaches her **as a fact**, and what she does with it is decided by her soul and
  not by a handler. A test proves the consequence layer contains no refusal path.
- **SC-004**: Revoking one credential stops exactly that host and nothing else.
- **SC-005**: No route returns a credential; no turn's context contains one.
- **SC-006**: The browser's profile directory is under `~/.syl/`, proven by a
  test, and no source file names his Chrome or Safari profile.
- **SC-007**: `--tools ""` still holds on every lane; she gains no reach on his
  machine.
- **SC-008**: `us4-untrusted-content-cannot-act.test.ts` is still green, and a
  test pins that a reach session is not the reader lane.
- **SC-009**: The first real booking was watched, in the visible mode, and that
  is recorded.
