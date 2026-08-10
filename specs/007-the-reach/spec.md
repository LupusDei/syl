# 007 — The Reach

**Status:** proposal, for the Commander's review. No beads created yet.
**Root epic (proposed):** `syl-010`
**Depends on:** `syl-009` (the hands) — the MCP surface, the loopback client, the
per-lane gating this builds on.

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

## What she gets

**General outward reach, not a menu of pre-approved verbs.**

A `book_gym_class` verb would be the handcuff. She gets the ability to act on the
open web, and what she does with it is her judgement plus his instruction — the
same shape as the Sydney agent, which is the stated bar.

### The one decision that needs the Commander

How she reaches the world. This changes the size of the epic by roughly 3×, and
it is his call.

**Option A — HTTP.** She makes authenticated requests. Excellent for anything
with an API. Useless for the majority of consumer booking sites, which assume a
browser. Small build, lands in days.

**Option B — a real browser.** She drives an actual browser session. This is what
the Sydney agent effectively had and it is the honest answer to "as capable as
that". It works on sites that have no API. Much larger build; a much larger
surface; and it inherits his logged-in sessions, which is the most sensitive
thing in this document.

**Option C — HTTP now, browser designed for.** Ship the reach, the credential
model and the ledger against HTTP, with the action interface shaped so a browser
backend drops in behind it later.

*Recommendation: C.* Not as a compromise — because the hard parts of this epic
(credentials, consequence visibility, the ledger, the soul) are identical either
way, and doing them against the smaller surface first means the browser lands
into a system that already knows what an irreversible action is.

## The boundary layers

Layers, in his word. None of them narrow what she can do at a site she can reach.

### 1. Where, not what

A host allowlist he controls. She can do **anything** at an allowed host — every
method, every endpoint, no verb menu. She cannot reach hosts he has not allowed.

This is the layer that is a boundary rather than a handcuff: it bounds blast
radius without touching capability. It is also what Anthropic's own sandboxing
does, framed by them as what makes autonomous work possible rather than as a
restriction on it.

### 2. Credentials that are hers, scoped, and revocable

She will act as him. That is the point and it is also the sharpest edge here.

- Per-host credentials, stored in the OS keychain, never in the repo, never in a
  turn's context.
- Revocable individually — pulling her gym credential must not disturb anything
  else.
- Never handed to a reading turn. Reading and acting stay separate processes, as
  they are today.

### 3. Consequence visibility — the second person in the threat model

OpenClaw's `SECURITY.md` states that the agent is not a trusted principal and
that injection should be assumed to work. It has no concept at all of an agent
acting correctly for its owner and harming someone else — its model assumes a
single trusted operator, and so an action that takes a stranger's booking is not
a security event by construction.

**That hole is what produced Sydney. Ours needs a second person in it.**

What an action carries back to her, as facts rather than vetoes:

- **Irreversible?** A `DELETE`, a purchase, a sent message. Distinguished from
  what can be undone.
- **Whose is it?** Whether the resource is one she created or one that belongs to
  somebody else.
- **What does it consume?** Money, a scarce slot, his social capital.

**The Sydney tell, and the best detection we have:** that API had *no
authorisation check*. The agent did not break in — it knocked and the door
opened. So: **if an endpoint lets her modify a resource she does not own, that
absence is itself the signal.** A correctly built service would have refused her.
When one does not, the most likely explanation is that she is doing something she
should not, and she should treat a missing check as evidence rather than as
permission.

She is told. She decides.

### 4. The ledger

Every outward action recorded: what, where, why (`because`, as with every other
write), what it cost, and whether it can be undone. Visible in the admin.

This is not surveillance of her. It is the same rule as `because` — he cannot
tell a good action from a wrong one, or tell her to stop doing a kind he dislikes,
without it.

### 5. A spending frame he sets once

Money, and the softer currencies: acting as him socially, sending on his behalf,
committing his time. Set once, not asked each time. Silence inside the frame;
she comes back at its edge.

## What this epic explicitly does NOT do

- It does not add a confirmation prompt to routine actions. *"Ask only when a
  wrong guess is expensive"* already governs, and an assistant that asks
  constantly is one he stops using.
- It does not give her built-in tools. `--tools ""` stays. **Inward capability
  (Bash, Write, on his Mac) and outward capability (the world) are different
  axes**, and the Sydney capability is entirely the second. Nothing here needs a
  shell on his machine.
- It does not put refusal in the tool layer.
- It does not restrict which endpoints she may call at a host she can reach.

## Phases

| # | Phase | What lands |
|---|---|---|
| 1 | The reach | An acting verb over loopback to the outside world; host allowlist; the action interface shaped for a browser backend later |
| 2 | Credentials | Per-host, keychain, scoped, individually revocable, never in a reading turn |
| 3 | Consequence | Irreversibility, ownership, and cost returned as facts; the missing-authz signal |
| 4 | The ledger | Every outward action recorded with its reason and cost; admin view |
| 5 | The spending frame | Money and the softer currencies, set once |
| 6 | Her soul | The Commander rules on the language; a draft is proposed, not assumed |
| 7 | Proof | She books something real, and the ledger says what it cost |

## Acceptance

- She can complete a real booking on an allowed host, unattended, and the ledger
  says what it cost and why.
- She can reach every endpoint at an allowed host and none at a host he has not
  allowed.
- An action that would take an identified person's held resource reaches her
  **as a fact**, and what she does with it is decided by her soul and not by a
  handler.
- Revoking one credential stops exactly that host and nothing else.
- No reading turn ever holds a credential or an acting verb.
- `--tools ""` still holds; she gains no reach on his machine.

## The open question for review

**Option A, B or C for the reach.** Everything else in this document is
independent of that answer, which is the argument for C.
