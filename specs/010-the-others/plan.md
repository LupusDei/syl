# 010 — The Others: plan

## Architecture, and the one decision everything follows from

**The service talks to Adjutant. Her turn never does.**

The tempting design is to attach Adjutant's MCP server to her turn. It is wrong
for a reason we paid for on 2026-08-10: **a model infers what it is from its
verbs.** Adjutant's surface is `set_status`, `report_progress`, `create_bead`,
`spawn_worker` — squad vocabulary, landing in the same context as her identity.
That is precisely how she came to describe herself as "an engineer on this
codebase". Thirty coordination verbs would bring it straight back, and would not
fit the budget either (5,132 bytes free against a 30-tool surface).

So: two narrow verbs of her own, and the service does the talking. Same shape as
extraction and as every verb that works — **the model proposes, the service
acts.**

## Identity — the blocker

`POST /api/messages` stamps `from: "user"`. Syl must not use it. Options
considered:

| Option | Verdict |
|---|---|
| POST as the dashboard does | **No.** She impersonates him and poisons his history. |
| Ask Adjutant for an agent-authenticated REST send | Possible, but a cross-project dependency that blocks us. |
| **Service speaks MCP to Adjutant, as `syl`** | **Chosen.** Sessions carry a real identity; her turn still sees none of it. |

`backend/tests/helpers/mcp-client.ts` already speaks MCP over stdio for the tool
server tests. The Adjutant server is MCP over HTTP with a session header, so the
client is new code, but the protocol is understood and the fixtures exist.

## Reading replies

`GET /api/messages?agentId=syl` returns everything addressed to her, newest
first, in the `{success, data:{items:[…]}}` envelope. Reading needs no identity,
so the client is asymmetric: **MCP to send, REST to read.** Stated here because
it looks like an inconsistency and is not.

A cursor (last seen message id) lives in the store, so a reply is delivered once.

## Delivery

Reuse what exists rather than building a second path: an arriving reply becomes a
delivery through the same outbox that carries reminders, which already honours
quiet hours and already never silently drops. **Nothing new is invented for
"tell him when it arrives" — that machinery is the reason to reuse it.**

## Phases

### Phase 1 — Foundational: the client and the identity
`backend/src/agents/adjutant-client.ts`. Send as `syl` over MCP; read over REST.
Every seam injected, no ambient fetch, no credentials in our code.

### Phase 2 — US1: she can ask
`ask_agent` in `tools/schemas.ts` + `tools/server.ts`. Roster-checked, `because`
required, reports having asked and never having an answer.

### Phase 3 — US2: answers reach him, as data
The poller, the cursor, the fenced contributor, and delivery through the outbox.
No auto-reply, ever.

### Phase 4 — US3: initiative, bounded
A stated daily bound on unprompted asks, and a record he can read.

### Phase 5 — Polish
The admin view of what she asked and what came back. Observability is a first
principle here for the same reason it is in memory: a thing that acts on his
behalf must be inspectable.

## Parallel opportunities

Phase 2 and Phase 3 both depend on Phase 1 and on nothing else, so they run
concurrently. Phase 4 depends on 2. Phase 5 depends on 3.

## Risks

**She can spend the fleet.** He chose "both, freely" knowingly. The guard is not
a permission prompt — it is that every ask carries its reason and is written
down where he can read it. A bound on unprompted asks is a backstop, not the
control.

**A reply is plausible in a way an article is not.** It is about his life, in the
right register, from a source he trusts. `fencing.ts` carries the argument.

**Loops.** She never auto-replies to an inbound message. An agent cannot start a
conversation that costs him money.
