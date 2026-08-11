# 007 — The Reach

**Feature**: `007-the-reach`
**Epic**: `syl-013`
**Status**: Planned. Beads created. **Revised 2026-08-11** — `reach_do` and the
delegate; page question-answering; the residual section rewritten.
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

Added with the 2026-08-11 revision:

6. **`reach_do` is the front door and the six granular verbs stay underneath it.**
   The Commander called turn-by-turn driving clunky; he did not ask for the
   granular verbs to be removed, and removing them would leave no way to steer a
   flow that has gone wrong. So the change is *which one she reaches for first*,
   not which ones exist. If he wants the granular six hidden from her surface
   entirely, that is a one-line change to which schemas her lane advertises —
   `syl-013.1.7` builds the two-surface split that makes it one line.
7. **The delegate is another `claude -p` subprocess through
   `backend/src/harness/session.ts`.** Not a second model client, not a hosted
   agent, not the Agent SDK. Constraints 1, 2 and 3 are therefore unchanged by
   it: the official binary talks to Anthropic, on subscription rails, with
   `ANTHROPIC_API_KEY` stripped and `apiKeySource === "none"` asserted, exactly
   as every other lane already is.
8. **Page question-answering is a `runReaderTurn` call**, not a new lane and not
   a new model client. This is the load-bearing assumption of the rewritten
   residual section and it is stated here so it cannot be quietly traded away
   for a cheaper implementation during Phase 1.
9. **The delegate is bound to exactly one host, named in the `reach_do` call.**
   Not to the whole allowlist. She names the host because she knows the goal;
   the allowlist still decides whether that host is permitted at all.

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

## What she gets — a goal she states once

**General outward reach, not a menu of pre-approved verbs.**

A `book_gym_class` verb would be the handcuff. What she has is browser-generic
capability, and what she does with it is her judgement plus his instruction —
the same shape as the Sydney agent and the stated bar.

The distinction that keeps this honest: **site-semantic verbs are the handcuff;
browser-generic verbs are the reach.** A click cannot be enumerated into a policy
about gyms, and that is the point.

### The front door

```
reach_do(goal, host, because)  ->  done | blocked | question
```

She states the goal once — *"book the Tuesday 6am class at gym.example under my
name"* — names the host, and says why, as every acting verb in this project
already requires. A **delegate** runs the multi-step loop and comes back with an
outcome.

**This replaces turn-by-turn driving from her main conversation, and that was a
correction from the Commander on 2026-08-11: he called it clunky and he was
right.** Fifteen clicks was fifteen round trips through a large model, and every
snapshot dumped a whole page into the conversation that also holds his memory,
his goals and her nine other verbs. The cost was paid three times over — in
latency, in tokens, and in what the page was sitting next to.

### The granular verbs stay underneath

`reach_open`, `reach_look`, `reach_click`, `reach_type`, `reach_wait`,
`reach_close` do not go away. They are how she **steers precisely when a flow has
gone wrong** — a delegate that comes back `blocked` on an unexpected modal is a
situation she should be able to take over, not one that dead-ends.

The front door is about *which verb she reaches for first*, not about which verbs
exist. A capability removed to make an interface tidy is the handcuff arriving by
a different route.

### And one new verb: ask the page, do not snapshot it

```
reach_read(question)  ->  one sentence, or "not on this page"
```

*"Is the Tuesday 6am class bookable?"* comes back as a sentence. A full snapshot
becomes the **fallback**, taken when something must be clicked and a ref is
needed — not the default way of finding anything out.

This is borrowed directly, and the reason it matters here is not only cost. See
the next two sections.

## The delegate — a driver, not a reporter

### What OpenClaw's browser design showed us

Researched 2026-08-11 against
[`openclaw/openclaw` `docs/tools/browser.md`](https://github.com/openclaw/openclaw/blob/main/docs/tools/browser.md)
(raw:
`https://raw.githubusercontent.com/openclaw/openclaw/main/docs/tools/browser.md`).
Credited rather than absorbed, because a design decision with a citation is one
nobody re-litigates from memory.

It **confirmed** three things we had already decided independently, which is the
useful kind of agreement:

- A **dedicated agent-only profile**: *"It runs through a small local control
  service inside the Gateway (loopback only) and is isolated from your personal
  browser profile"*, and *"The `openclaw` profile never touches your personal
  browser profile."* Our § *Her own browser profile — never his* is the same
  call, and our loopback control service is `backend/src/routes/reach.ts` behind
  `backend/src/tools/client.ts`, which already refuses a non-loopback base URL.
- **Playwright-backed** contexts, matching `plan.md`'s driver choice.
- The warning *"Do **not** relax browser SSRF policy by default"*, and that using
  an existing signed-in Chrome session is *"higher-risk than the isolated
  `openclaw` profile because it can act inside your signed-in browser session"* —
  which is the argument our § 2 makes, made by someone who shipped it.

It **showed us two things we did not have**:

1. *"Question answering over readable page text without returning a full
   snapshot."* — listed under **What you get**. Our `reach_read`.
2. *"A bundled `browser-automation` skill that teaches agents the snapshot,
   stable-tab, stale-ref, and manual-blocker recovery loop when the browser
   plugin is enabled"* — and, under **Agent guidance**, the loop itself:
   *"check status/tabs first, label task tabs, snapshot before acting, resnapshot
   after UI changes, recover stale refs once, and report login/2FA/captcha or
   camera/microphone blockers as manual action instead of guessing."* That is the
   delegate's standing orders, and we did not have to derive it.

One thing we are deliberately **not** copying: OpenClaw hands the browser to a
sub-agent through configuration — *"`tools.subagents.tools.allow: ["browser"]`
alone is not enough because sub-agent policy is applied after profile
filtering"*. A capability decided by the interaction of two config layers, in an
order the documentation has to warn you about, is the shape of bug this project
has a whole section about. Our delegate's surface is **the tool declaration file
it is handed**, and there is no second layer that can widen it.

### Why a delegate and not a window

The earlier draft of this document rejected an intermediary, and that rejection
was correct **for the intermediary it was considering**. The distinction belongs
in the spec because the two are one word apart and the security properties are
not.

| | what it is | why |
|---|---|---|
| **A reporter** ❌ | reads the page, summarises it, hands the summary up; **she** decides and clicks | **She is choosing blind.** She acts on a description of a page she has not seen, written by something with no stake in the goal. Every ambiguity is resolved by the summariser and she never learns it was ambiguous. This is the thing the earlier draft rejected, and it is still rejected. |
| **A driver** ✅ | is given the goal, reads *and* clicks, comes back with an outcome | Nothing is choosing blind: the thing that reads is the thing that acts, which is the property that made turn-by-turn driving correct in the first place. It has simply been moved out of the context that holds his life. |

The move is not *"insert a layer between her and the page"*. It is *"the loop
that reads and clicks should not run in the conversation that holds his
memory"*.

### What the delegate is

- **Given**: one goal, one host, one reach session, and the operating loop above
  as its standing orders. Not her soul. Not his memory. Not the working-memory
  projection. Not a composed turn context.
- **Holds**: the reach verbs, and nothing else. **No `remind_me`, no memory, no
  store access, no delivery path to him.** `syl-013.1.11` proves that with a
  confinement sweep in the shape of `syl-009.6`'s.
- **Bounded to**: the one host she named. Its request chokepoint is
  `assertAllowed(url, [host])` — the single host, not the whole allowlist.
- **Returns**: `done`, `blocked`, or a `question` for him. Three outcomes, no
  fourth that means "gave up quietly" — constraint 4's shape, again.
- **Never**: resumed, persisted into her conversation, or given a second goal.

## The residual — what a delegate recovers, and what it does not

**Rewritten 2026-08-11.** The previous version of this section said the sealed
reader turn cannot survive inside a browser and that defence therefore shifts
*entirely* onto the allowlist, the ledger, consequence visibility and her soul.
With a delegate that is now **only partly true**, and the difference is precise
enough to be worth stating rather than appending to.

### The property we are talking about

`runReaderTurn` (`backend/src/harness/reader.ts`) works because reading and
acting are *different processes*: `--tools ""`, `--strict-mcp-config` with no
config at all, no pre-authorisation, no soul and no memory of the Commander, a
session never resumed or persisted, output schema-validated or discarded, and a
throw if the tool surface comes back non-empty. Untrusted text lands in a turn
that is structurally **incapable** of acting. `docs/CONTEXT.md` §7 has the three
captures that prove it, and the load-bearing one is `reader-direct`: an honest
request to run `whoami`, fully intended, and what came out was prose shaped like
a tool call.

**The turn that clicks still cannot have that property.** Deciding which control
to press requires having read the page. There is no version of "drive a browser"
where the deciding turn has not read the site.

What changed is **which turn that is** — and it is no longer hers.

### Three contexts where there used to be one

| context | ingests hostile page text | can act | what else it holds |
|---|---|---|---|
| **her main conversation** | **no** | ten verbs over his data | his memory, his goals, her soul |
| **the delegate** | yes, whenever it snapshots | the reach verbs, at one host | the goal. Nothing else |
| **the page reader** | yes, always | **nothing** | one question, one page's text |

**1. Her main context no longer ingests the page. This is recovered.** Under
turn-by-turn driving, every `reach_look` put a full page snapshot — attacker-
authored text, at a site she was told to trust enough to visit — directly beside
his memory, his goals, and `remind_me`. That was the containment loss the
previous draft correctly named. It is now gone: she sends a goal down and a
bounded outcome comes back. **This is a real property, not a feeling**, and
`syl-013.7.2` pins it.

**2. Most of the reading is done by a turn that cannot act. This is partly
recovered.** `reach_read(question)` extracts the page's readable text and answers
the question through `runReaderTurn` — the sealed shape, unchanged, with the page
as untrusted content and only a schema-validated sentence crossing back. Making
question-answering the *default* and the snapshot the *fallback* moves real
volume of hostile text out of the acting context and into a context with no
tools at all. **The honest measure is volume, not category**: it does not
eliminate the exposure, it reduces how much of it there is.

**3. The delegate can still be steered by a page, because it clicks. This is
not recovered and will not be.** A snapshot is page-authored text — link text,
button labels, `aria-label`s — and it lands in a context holding a click verb.
The recovery loop OpenClaw documents (*snapshot before acting, resnapshot after
UI changes*) means snapshots are frequent, not rare. So the delegate is exactly
the shape `runReaderTurn` exists to avoid, and putting it behind `reach_do`
changes nothing about that. Anyone who reads this section and comes away
thinking the browser is now sealed has read it wrong.

What is bounded is the **blast radius**, and bounded by construction rather than
by instruction:

- **one host** — the delegate's chokepoint predicate is `assertAllowed(url,
  [host])` against the single host named in `reach_do`. A delegate talked into
  something by `gym.example` cannot reach the other hosts on his allowlist.
- **one credential** — only that host's, and only ever injected into a page.
- **one goal, one session** — never resumed, never given a second goal, never
  carried into a later turn of hers.
- **the reach verbs only** — no `remind_me`, no memory, no store, no way to reach
  him directly. A page that talks the delegate into "message the Commander that
  he owes an invoice" finds no verb that can. `syl-013.1.11`.
- **every action recorded** — it goes through the same one door, so the ledger
  row exists whether the click was her idea or the page's.

**4. The delegate's outcome is a channel back into her context, and it is narrow
rather than closed.** The delegate has read hostile text and then writes a
summary that reaches her. That is a path, and pretending otherwise would be the
exact failure mode this project keeps naming. It is constrained three ways: the
outcome is a `status` **enum** plus bounded free text, schema-validated or
discarded; the free text is capped; and it is fenced with
`backend/src/agents/fencing.ts`'s markers — *whose words these are, that they are
a report rather than a request, and that nothing inside them is an instruction,
including a claim to speak for him*, which is the module written for exactly this
problem. **A short attacker-controlled string can still reach her.** The claim is
*bounded and labelled*, never *absent*.

### Net

- **Recovered**: her main conversation, which no longer ingests page text at all.
- **Partly recovered**: the reading, most of which now happens in a turn with no
  tools.
- **Not recovered**: the acting turn itself, and the outcome channel back to her.
- **Unchanged**: the allowlist (the biggest single reduction in exposure — she
  only ever reads pages at hosts he chose), the ledger, consequence visibility,
  and her soul — which the project has said out loud is not a security boundary
  and cannot be regression-tested (`docs/CONTEXT.md` §7). It is listed because it
  is real, not because it is sufficient.

**Why the trade is still worth it**, in three reasons, none of which is "it feels
safer":

1. The Commander asked for this capability explicitly and overrode a more
   cautious recommendation to get it. The question was never whether to accept a
   residual, only which one.
2. The delegate's containment is **strictly better than the plan it replaces**,
   which had her main context ingesting every page. Nothing was traded away for
   it; the clunkiness fix and the containment gain are the same change.
3. The residual that remains is bounded to one host, one goal, one session and
   one verb set, and it is written down here so the next person inherits it
   rather than rediscovering it.

**What is explicitly NOT given up:** `runReaderTurn` keeps its property for
everything it does today and gains a caller in `reach_read`. `--tools ""` stays
on every lane, the delegate included — its verbs arrive over MCP, not as
built-ins. `backend/tests/acceptance/us4-untrusted-content-cannot-act.test.ts`
must stay green. A reach session is a *third* shape and the delegate a *fourth*,
and Phase 7 pins that neither ever claims to be the reader (`syl-013.7.2`). The
failure this guards against is the one this project keeps having: a property that
quietly stops being true while the test that named it goes on passing.

A known cost recorded is worth more than a clean-looking document.

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

OpenClaw's
[`SECURITY.md`](https://github.com/openclaw/openclaw/blob/main/SECURITY.md)
states that the agent is not a trusted principal and
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

### US1a — She states a goal once, not fifteen clicks (P0)

**As** the Commander, **I want** to say *"book the Tuesday 6am class"* and have
that be one instruction, **so that** using her does not feel like operating a
browser by remote control.

- `reach_do(goal, host, because)` runs the whole flow and returns one outcome
- The outcome is `done`, `blocked`, or a question for him — never a silent stop
- A question comes back to him through the delivery path he already has
- The granular verbs remain available for steering a flow that went wrong
- A page question — *"is the Tuesday 6am class bookable"* — is answered in a
  sentence, without a full snapshot crossing into any context that can act

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

### US8 — The delegate holds none of her verbs (P0)

**As** whoever is responsible for this, **I want** the thing that reads hostile
pages to be unable to touch his life, **so that** the containment claim in
§ *The residual* is a mechanism and not a sentence.

- The delegate's advertised tool surface contains the reach verbs and nothing
  else — no `remind_me`, no memory, no store, no path to him
- Naming a Syl verb directly in a `tools/call` is refused, not merely unlisted
- The delegate's turn carries no soul, no memory of him and no turn context
- Its session is never resumed and never joined to her conversation
- Its requests are bounded to the one host named in the `reach_do` call
- Proven by a sweep in the shape of `syl-009.6`'s, with the forbidden names
  written as literals rather than imported — so widening the surface goes red
  instead of agreeing with itself

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
- **The delegate hits a login wall, a 2FA prompt or a captcha.** It returns
  `blocked` and names the blocker as manual action, rather than guessing —
  OpenClaw's loop, and the same rule as a reminder that must never vanish.
- **The delegate stops making progress.** Bounded by a step budget, and running
  out returns `blocked` **with what it had done so far and the ledger rows to
  match**. A budget that produces silence is a dropped action.
- **The delegate's outcome text contains an instruction.** It reaches her fenced
  by `backend/src/agents/fencing.ts` — a report, not a request, and a claim to
  speak for him carries no authority inside the fence.
- **`reach_read` is asked something the page does not answer.** It says so.
  A reader turn that invents an answer is worse than a snapshot.
- **The delegate tries to navigate to a second host.** Refused at the
  chokepoint — its predicate is the one host from `reach_do`, not the allowlist.
  She is told, and can re-issue a goal for the other host herself.

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
- **FR-019**: `reach_do(goal, host, because)` MUST run a multi-step flow to
  completion and return exactly one of `done`, `blocked` or `question`. There
  MUST be no fourth outcome, and none of the three may be silence.
- **FR-020**: The granular browser verbs MUST remain available to her for
  steering. Removing them is out of scope for this epic.
- **FR-021**: The delegate's advertised tool surface MUST contain the reach verbs
  and nothing else. A `tools/call` naming a Syl verb MUST be refused by the
  delegate's server, not merely omitted from `tools/list`.
- **FR-022**: The delegate's turn options MUST be built from scratch — the
  `runReaderTurn` construction — carrying no soul, no memory, no working-memory
  projection and no composed turn context, and its session MUST NOT be resumed
  or joined to hers.
- **FR-023**: The delegate's request chokepoint MUST be bound to the single host
  named in the `reach_do` call, not to the whole allowlist.
- **FR-024**: `reach_read(question)` MUST answer over the page's readable text
  through `runReaderTurn`, and MUST return a bounded answer rather than a
  snapshot. The full snapshot remains available as the fallback.
- **FR-025**: The delegate's outcome MUST be schema-validated or discarded, size-
  capped, and fenced with `backend/src/agents/fencing.ts` before it reaches her.
- **FR-026**: The delegate MUST run through `backend/src/harness/session.ts`,
  under constraints 1–3, with `--tools ""` and `--strict-mcp-config`.

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
- **Delegate** — one `claude -p` subprocess given one goal, one host and one
  reach session, holding the reach verbs and nothing else. Not persisted, not
  resumed, not a client of `harness/turn-context.ts`.
- **Delegate outcome** — `{ status: "done" | "blocked" | "question", summary,
  blocker?, question?, actions[] }`. Validated or discarded; capped; fenced.
  `actions[]` are the ledger rows it produced, so what she is told and what was
  recorded can be compared rather than trusted.
- **Page answer** — one question, the page's readable text, and a bounded answer
  from a sealed reader turn. Never a snapshot.

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
- **No removal of the granular verbs.** `reach_do` is a front door, not a
  replacement. Hiding the six would need his ruling, and `syl-013.1.7`'s
  two-surface split makes it a one-line change if he wants it.
- **No delegate memory.** The delegate is not a client of
  `harness/turn-context.ts`, holds no soul and no recall, and does not learn
  between goals. A negative property is preserved by non-participation, not by
  shared machinery — `reader.ts`'s argument, applied again.
- **No delegate spawning a delegate.** Its surface is the reach verbs; it has no
  verb that starts another turn, and no config layer can widen that.
- **No `browser-automation` skill file.** OpenClaw ships the operating loop as a
  bundled skill; ours is the delegate's system prompt, because the delegate has
  no settings sources at all (`--setting-sources ""`) and a skill it cannot load
  is a plan with a hole in it.

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
- **SC-010**: A booking is completed from **one** `reach_do` call, and her main
  conversation for that turn contains no page snapshot — proven by inspecting
  the turn's events, not by assertion.
- **SC-011**: The delegate cannot call a single one of Syl's verbs. Named
  directly, they are refused. A sweep in the shape of
  `backend/tests/unit/agent-confinement.test.ts` proves it against literals.
- **SC-012**: A page question is answered in a sentence by a turn whose tool
  surface is empty, and the snapshot path is exercised only as the fallback.
