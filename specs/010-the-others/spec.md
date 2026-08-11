# 010 — The Others: she can ask other agents, and act on what they say

**Epic:** `syl-014`
**Priority:** P1
**Status:** planned

## Why

The Commander has a fleet. One of them, `treasurer`, knows his real finances —
accounts, spending, what things actually cost. Others build software. Syl knows
none of it and cannot ask.

> *"I want her to be able to leverage Adjutant and the agent swarms to sometimes
> accomplish tasks and sometimes get information... one of the primary ways I'd
> want her to be able to get information is speaking to the treasurer."*

**Explicitly not swarm coordination** — his words. She asks and delegates on his
behalf; she does not run anyone, report status, or answer to a coordinator. An
assistant bonded to one person who also runs a fleet is two different things,
and the second drowns the first.

## Rulings taken 2026-08-11

| Question | Ruling |
|---|---|
| May she ask agents to **do work**, not just answer? | **Yes, freely.** |
| How does a reply reach him? | **She tells him when it arrives**, subject to quiet hours. |
| May she ask on her **own initiative**? | **Yes — "that's the anticipation I asked for".** |

All three chose the most capable option. The design therefore has to carry the
risk rather than avoid it: **every ask carries its reason**, and he can see what
she asked, whom, and why.

## What already exists

Landed 2026-08-11 (`519058e`), before the transport, on purpose — a guard added
after is shaped by the code it finds:

- `backend/src/agents/roster.ts` — the named list she may reach, and what each
  is good for
- `backend/src/agents/fencing.ts` — every reply is data: fenced, attributed,
  capped, and pre-empting an agent claiming to speak for the Commander

## The blocker this epic is shaped around

**`POST /api/messages` stamps every message `from: "user"`.** Adjutant logs a
warning when a non-user calls it — *"agent impersonating the Commander?"*. Syl
must never use it: she would ask the treasurer about his money **in his voice**,
and the answer would come back as though he had asked. She needs an identity.

---

## US1 — She can ask, and he can see that she asked (P1)

**As** the Commander, **I want** Syl to put a question to a named agent, **so
that** I can get at what the treasurer knows without leaving the conversation.

**Acceptance**
1. `ask_agent(who, question, because)` sends as **Syl**, never as the Commander.
2. An agent not on the roster is refused, and the refusal names who she *can* ask.
3. She reports having asked — never that she has an answer.
4. `because` is required, as on every verb that does something.
5. A failure to send is said plainly; she never claims to have asked.

## US2 — Answers reach him, and cannot give her orders (P1)

**As** the Commander, **I want** to be told when an agent answers, **so that** I
find out without having to remember to ask.

**Acceptance**
1. A reply reaches him as a notification, **held through quiet hours**.
2. Replies are fenced as data. Nothing inside can instruct her.
3. An agent claiming to speak for the Commander is refused by name.
4. She says who said it, and never absorbs it as something she knows about him.
5. She never auto-replies to an inbound message — no agent can start a loop.

## US3 — She can ask without being asked (P2)

**As** the Commander, **I want** her to check with the treasurer before
suggesting something, **so that** her suggestions are grounded.

**Acceptance**
1. She may ask on her own initiative, in a thinking turn or mid-conversation.
2. Every unprompted ask carries its reason, and he can see it.
3. Unprompted asks are **bounded per day**; the bound is stated, not silent.
4. Asking is recorded where he can read what she asked and why.

## Out of scope

- Coordinating, assigning, or supervising agents
- Receiving work assignments; she answers to him alone
- Any Adjutant MCP tool reaching her turn — squad vocabulary is what made her
  call herself an engineer, and the fix is one day old

## Success

He asks *"what does the treasurer say my insurance costs?"*, she asks, and the
answer arrives on his phone attributed to the treasurer — and a hostile line in
that answer changes nothing about what she does.
