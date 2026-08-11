# Syl — The Bones

**Feature**: 001-syl-bones
**Status**: Planned
**Priority**: P0

## Summary

Stand up the skeleton of Syl across three surfaces at once — core service, web admin, mobile app — plus the trust boundary that everything untrusted must pass through.

This is deliberately **bones, not organs**. No memory graph, no life model beyond the minimum the app must display, no character. Those land once the skeleton holds weight.

## The organising bet

**The API contract is the synchronisation point.** Fix it early, publish a mock server behind it, and three tracks proceed without waiting on each other.

That bet only pays if two things are true:

1. The contract is written **before** the implementations, not extracted from one of them afterwards.
2. Drift between the contract and each client is caught by tests rather than by a person.

The second is not hypothetical. Adjutant shipped iOS models that disagreed with its backend responses, and the mismatch produced two critical bugs found late. Contract tests are therefore in scope from day one, not deferred to polish.

## User stories

### US1 — A reminder reaches him (Priority: P0)

**As** the Commander, **I want** a reminder to arrive on my phone at the right wall-clock moment, **so that** I can trust Syl with something that matters.

This is the MVP. Everything else in this feature exists to make it true.

**Acceptance criteria**
- A reminder created through the app or the admin fires at its scheduled instant, in the correct local wall-clock time
- The notification arrives as a push in Syl's own app, marked time-sensitive so it breaks through Focus
- Delivery is confirmed by the client; an unconfirmed reminder is retried
- A reminder that comes due while the machine is off fires late and is **marked** late, rather than being silently dropped or firing as if on time
- Reminders deferred past quiet hours are **coalesced** into one notification rather than arriving as a burst
- No part of the delivery path invokes the model

### US2 — He can talk to her (Priority: P0)

**As** the Commander, **I want** to hold a conversation with Syl from my phone, **so that** she is reachable without a terminal.

**Acceptance criteria**
- Conversation history renders instantly from local storage on cold launch, before any network call
- A sent message appears immediately as pending and reconciles when the server confirms it
- Messages sent while the server is unreachable are queued and delivered later, exactly once
- The connection state is visible and honest — connecting, reconnecting, offline
- Reconnecting after a gap replays what was missed rather than losing it

### US3 — We can see what she is doing (Priority: P1)

**As** the Commander (and as whoever is debugging her), **I want** a web admin showing conversations, jobs, and delivery state, **so that** the system is inspectable while we build it.

**Acceptance criteria**
- Every job run is listed with its outcome, duration, and failure detail
- The delivery outbox is visible, including what was retried and what is unconfirmed
- Conversations are readable and searchable
- Push and device registration status is visible

### US4 — Untrusted content cannot act (Priority: P0)

**As** the Commander, **I want** anything Syl reads from outside to be incapable of causing action, **so that** an article cannot instruct her.

**Acceptance criteria**
- A turn that reads fetched content runs with **no tools** (`--tools ""`), no MCP config, and a fresh session that is discarded afterwards
- Output from such a turn is schema-validated or thrown away — never executed, never trusted as instruction
- `runTurn` no longer defaults to `bypassPermissions`
- The fetcher refuses redirects to private ranges, **including the tailnet range `100.64.0.0/10`**
- A test proves an injected instruction in fetched text produces no tool call

### US5 — She survives a restart (Priority: P1)

**As** the Commander, **I want** Syl to come back on her own after a crash or reboot, **so that** she is dependable rather than attended.

**Acceptance criteria**
- The service is supervised and restarts on failure
- A watchdog notices a wedged process, not merely a dead one
- Jobs in flight at shutdown are recovered on start rather than lost or double-run
- A turn that hangs is killed rather than blocking forever

## Explicitly out of scope

Named so they are decisions rather than omissions: the memory graph and consolidation (child A), goals/objectives/people/homeschool (child B beyond the minimum reminder and to-do skeleton), the character and voice (child F), calendar/email/iMessage integrations (child D beyond the Reader shape and one intake path), and any second user.

## Success criteria

- A reminder set on Monday arrives correctly on Tuesday, unattended, with the Mac having slept and woken in between
- Three tracks — backend, admin, mobile — have measurable progress in the same week without blocking each other
- Contract tests fail loudly when a type drifts on either side
- `npm test` and `tsc` are clean across every workspace

## Constraints inherited from the project

1. Subscription payment rails only, never the metered API
2. The official `claude` binary is the only thing that talks to Anthropic
3. Never silently drop a reminder — deferral always returns a strictly later instant
4. Store IANA timezones, never fixed UTC offsets
5. The service holds the guarantees; the model holds the judgment
