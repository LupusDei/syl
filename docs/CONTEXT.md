# Syl — exploration record and decision log

Written 2026-08-08 by artanis, at the end of the exploration phase, as a handoff
into full-time work on Syl.

Its job is to stop a fresh session from re-litigating settled questions or
re-discovering things that cost real time to learn. Read it once before starting;
the short operating rules live in `CLAUDE.md`.

---

## 1. What Syl is

A personal assistant for the Commander. Named for Sylphrena, the honorspren.

It owns his to-dos, goals, and objectives; a daily rhythm (morning agenda,
evening review); proactive reminders that arrive at the right wall-clock time;
and research on request, returned as a brief.

### Naming — read this or the beads will confuse you

The initiative changed names as it narrowed. In chronological order:

| Name | What it was | Status |
|---|---|---|
| **Horner** | The assistant agent, when it was going to live *inside* Adjutant | superseded |
| **Hyperion** | The standalone app, with Horner as the agent aboard it | superseded |
| **Syl** | The project, as named by the Commander | **current** |

Bead `adj-mzsbi` is still titled "Hyperion" and its proposal still says "Horner".
Those are the same initiative as Syl. Do not create anything new called Hyperion
or Horner.

### How it started

Eight directives arrived in quick succession over The Bridge: a personal
assistant; schedule reminders; daily updates on regular patterns; a persistent
agent; a persistent agent *separate from the coordinator* that coordinates the
fleet; to-dos and proactive reminders; tell-it-my-priorities-and-it-plans; and
research on the Commander's behalf.

They are not eight initiatives. They are eight faces of one, and treating them
separately would have produced five overlapping systems. That framing is the
initiative.

---

## 2. Settled decisions — do not re-open without the Commander

| Decision | Outcome | Where it came from |
|---|---|---|
| Where it lives | **Its own app**, not a feature inside Adjutant | Commander, after I raised the data-boundary risk |
| To-do storage | **Its own store**, not beads | Commander approved; beads are project-scoped engineering artifacts and personal errands would pollute `bd ready` |
| Payment rails | **Subscription only.** Never the metered API | Commander, non-negotiable |
| Transport to the model | **stdio**, not tmux | Commander preference, independently confirmed as better |
| Quiet hours | **23:00–08:00**, configurable | Commander |
| Timezone | **US Central**, configurable. Store IANA `America/Chicago`, never a fixed offset | Commander; offset choice is mine, for DST correctness |
| Quiet-hours behavior | Defer, never drop. Per-reminder urgent override | My recommendation; Commander has not objected |

**The payment-rails constraint is the strongest one and it selects the
architecture on its own.** When in doubt about a design question, check what it
implies for subscription billing first — that has decided every major call so far.

---

## 3. The architecture, and why

**Syl drives the official `claude` binary over its native `stream-json` stdio
protocol.**

```
claude -p --input-format stream-json --output-format stream-json --verbose
```

The official CLI is what talks to Anthropic, using the existing claude.ai login.
Our code never touches credentials.

### Why not the alternatives

Each of these was seriously considered and rejected for a specific reason. Do not
revisit without new information.

| Option | Why rejected |
|---|---|
| **Direct API** (Anthropic SDK) | Metered API billing. Fails the payment-rails constraint outright. |
| **OpenClaw** | Third-party product. As of 2026-04-04 subscription quotas no longer cover third-party tools; Pro/Max apply only to official tools (Claude Code CLI, claude.ai, Desktop). Its embedded runtime needs an API key; even its `claude-cli` mode is a third-party tool orchestrating the CLI, which is squarely what that change addressed. Also carries a substantial CVE record. |
| **Hermes** (Nous Research) | Deliberately endpoint-agnostic — point it at any compatible HTTP endpoint. Direct-API with a key, no CLI in the path. Same disqualifier. |
| **Isaac** (slagyr) | Clojure/Babashka/Java against our TypeScript, eleven repos pinned by SHA, and its LLM layer is direct-API. See §5 — its *design* is worth stealing even though its base layer is not. |
| **ACP adapters** | A translation layer buying nothing. ACP exists so any editor can drive any agent; we are not an editor and target one agent. Every adapter found ultimately spawns this same binary or the Agent SDK. |

### One process per turn — a measured constraint, not a choice

In `-p` mode with `--input-format stream-json`, **a turn does not complete until
stdin reaches EOF.** Verified by holding stdin open for 25 seconds: elapsed time
was 26 seconds, and the result arrived only on close.

So the CLI is one-shot, not a persistent conversation. A turn is: spawn, send one
prompt, close stdin, read to completion. Continuity comes from
`--resume <sessionId>` against Claude Code's own session store.

**This is better for an assistant, not a limitation being worked around.** There
is no daemon to supervise, a crash costs at most the turn in flight, and a
scheduled heartbeat is simply another turn. It deletes a whole category of
supervision work that the tmux approach forces on Adjutant.

### What stdio buys over tmux

Adjutant drives Claude Code by typing into a terminal (`set-buffer` →
`paste-buffer` → `send-keys`, with 150ms delays) and reading by capturing pane
text. Over stdio instead:

- typed events rather than text scraped from ANSI escapes
- deterministic turn boundaries from the `result` message, rather than inferring
  completion from a pane going quiet (which is the entire reason Adjutant needs a
  soft-stall-detector)
- real error fields — a billing failure arrives as `error: "billing_error"`
  rather than as pixels
- per-turn usage and cost accounting
- no timing races around paste delays

### What it costs — know these before someone "discovers" them

- **No attachable terminal.** You cannot `tmux attach` and take over a stuck
  session. Human takeover has to be built on the transcript.
- **We are the harness.** Session lifecycle, retry, backpressure are ours.
- **Restart survival differs.** Adjutant re-adopts orphaned tmux sessions after a
  backend restart; we replace that with persisted session ids and `--resume`.

---

## 4. The delivery channel question — currently NOT blocking

The open product question is which comm channel to build first (WhatsApp,
Telegram, Signal, iMessage, own app). It has been open for a while.

**It does not block anything.** Adjutant's MCP server is already connected in
headless mode — verified, `adjutant=connected` in the init handshake — and
`send_message` to `"user"` already pushes APNS to the Commander's phone.

So **Adjutant is a working first comm channel today.** The channel decision only
determines *additional* surfaces. Do not stall waiting for it.

---

## 5. Steal these four ideas from Isaac

Isaac's base layer is wrong for us, but its design maps almost one-to-one onto
the ask and is worth borrowing wholesale:

- **Souls** — a crew member's standing orders, as a markdown companion file.
  Already adopted: `SOUL.md`.
- **Append-only transcripts with compaction** — a JSONL record per session,
  compressed when the token budget tightens.
- **Cron + heartbeat** — scheduled prompt jobs, and a periodic wake that reads a
  checklist and decides whether anything needs action.
- **Hail** — out-of-band cross-session interrupt delivery. This is exactly the
  "a reminder needs to reach you mid-task" problem, and it is the one we would
  otherwise invent badly.

Also worth knowing from Isaac's vocabulary: *quarters* (a writable filesystem
area per crew member), and a comm-channel abstraction where CLI, Discord, and
iMessage are peers rather than one being privileged.

---

## 6. What exists today

Commits `600d73e` (walking skeleton) and `d302519` (scheduling). 41 tests, `tsc`
clean under strict mode with `noUncheckedIndexedAccess`.

```
src/protocol.ts   pure codec — JSON lines <-> typed events. Zero I/O. 16 tests.
src/session.ts    runTurn(): one subprocess per turn
src/agent.ts      SylAgent: continuity via --resume, stale-session recovery. 7 tests.
src/schedule.ts   wall-clock scheduling + quiet hours. 18 tests.
src/cli/ping.ts   end-to-end smoke test
SOUL.md           standing orders
```

### Verified live, not assumed

```
apiKeySource=none              subscription rails, not an API key
adjutant=connected             MCP bridge attaches automatically
PONG round trip                stdio protocol works
Windrunners -> Windrunners     context survives across separate processes
```

That last line is the real proof: a fact stated in one process, recalled
correctly in a completely separate one.

### The scheduling property that matters

07:00 `America/Chicago` resolves to `12:00Z` in summer and `13:00Z` in winter.
Same wall clock, different instants. Adjutant gets this wrong today — its
`cronToIntervalMs` collapses cron to a flat interval, so "07:00 daily" means
"every 24 hours from whenever you created it," which never lands on 07:00 and
drifts an hour twice a year.

DST edges are handled deliberately: a wall time that does not exist on
spring-forward night fires at the first instant that does (rather than skipping a
day), and a wall time that occurs twice on fall-back night fires once, on the
earlier pass.

---

## 7. Landmines — each of these cost real time

**`ANTHROPIC_API_KEY` silently overrides the subscription login.** Anthropic's
credential precedence puts a set key ahead of the claude.ai login
unconditionally. A stale key in the environment reroutes billing to the metered
API and, if it has no credit, fails with "Credit balance is too low" — which
arrives shaped like a normal assistant reply. `runTurn` strips it and asserts
`apiKeySource === "none"`. Filed as `adj-t64m9`. **Do not remove that guard.**

**API errors are disguised as assistant messages.** They carry ordinary text
blocks and are distinguishable only by an `error` field. A naive parser relays a
billing failure to the user as though Syl had answered. There is a regression
test pinning this; keep it.

**stdout chunks do not align to newlines.** A naive `chunk.split("\n")` corrupts
long payloads (the init frame especially) intermittently — the kind of bug that
only shows up under load. `createLineDecoder` buffers; there is a test for the
split-mid-object case.

**Headless sessions must be pre-authorised, and their tool surface constrained.**
Two separate problems, both seen on the Commander's first real prompt: 44 turns,
$0.39, ~45 consecutive `ToolSearch` calls, and no useful answer — just "these
tools need your permission to access."

*Permissions:* the CLI's default permission mode asks for interactive approval.
In `-p` mode there is nobody to ask, so every MCP call is denied. The assistant
then spends its turns discovering it cannot act. `runTurn` now defaults to
`--permission-mode bypassPermissions`. Unattended means pre-authorised; there is
no third option.

*Tool surface:* without `--strict-mcp-config` the session inherits every MCP
server the user happens to have configured — Vercel, Google Drive, Calendar,
Gmail — plus their tools. With deferred loading the model burns turn after turn
searching a surface it does not need. `runTurn` now passes `--strict-mcp-config`
whenever `mcpConfig` is set, so Syl sees only its own server.

Measured, same question, before and after:

| | turns | cost | outcome |
|---|---|---|---|
| default | 44 | $0.392 | denied, no answer |
| pre-authorised + strict | 3 | $0.051 | correct answer |

Roughly 13x fewer turns and 8x cheaper. **Still worth doing:** the surface is
89 tools even with strict config, so one `ToolSearch` still fires. Constraining
`--allowedTools` to what Syl actually needs is the remaining win, and it also
bounds what `bypassPermissions` can reach — handing a personal assistant
unrestricted Bash to silence a permission prompt is not a good trade, so treat
the allowlist as the real fix rather than an optimisation.

**`--verbose` is mandatory** with `--output-format stream-json` in `-p` mode. The
CLI errors out without it, and the message is easy to miss.

**The shell has `noclobber` set.** A plain `>` redirect fails if the file exists.
Use `>|` or remove first.

**`adjutant init` does not register the project with the backend.** It writes all
local files, prints green CREATED lines, reports success, and skips registration
— so the project is invisible to the dashboard. Syl had to be registered by hand
as project `3ba5667d`. Filed as `adj-125`, assigned to abathur.

---

## 8. Design principles to hold

**Never silently drop a reminder.** A late reminder is a nuisance; a vanished one
destroys trust. Deferral always returns a strictly later instant, and there is a
test whose only job is to assert that.

**Notice, do not nag.** On a scheduled check, if nothing needs attention, say so
briefly and stop. Silence is a valid answer. An assistant that talks constantly
gets muted, and a muted assistant is worth nothing.

**Keep the codec pure.** The subtle bugs in the base layer are wire-format bugs.
Keeping them testable without spawning a process is worth the seam.

**Build fixtures from real captured output, never from our own type definitions.**
The point is to catch drift between our types and the actual CLI. This is
Constitution Rule 1 and it has already paid for itself.

**Fail loudly on auth and billing.** These are the failures that would quietly
change what the Commander is paying, or quietly stop the assistant working.

---

## 9. Open questions

1. **Which comm channel first?** Not blocking (see §4), but it decides the next
   surface. Needs the Commander.
2. **Does syl get its own beads?** Currently tracked under Adjutant's
   `adj-itvob`. Giving it its own means a launchd-supervised Dolt server on a
   pinned port in 17000–17010 — real fleet plumbing, not a directory. My
   recommendation: wait until Syl stops being a spike.
3. **Fleet coordination scope.** Directive five asked for an agent that
   coordinates the fleet. Adjutant's MCP is attached, so it is possible — but how
   much of that Syl should own versus leaving to the coordinator is unsettled.
4. **Rate-limit contention.** On subscription rails there is no cheap tier to
   escape to; Syl's heartbeat competes with the Commander's own work and the
   whole fleet for one pool. Run a longer heartbeat interval than OpenClaw's
   30-minute default, keep the checklist small, and decide whether Syl backs off
   when the fleet is busy.

---

## 10. Where I was wrong

Recorded so a fresh session trusts the conclusions above at the right level, and
knows which claims were hard-won versus assumed.

**I said Isaac's base layer was an ACP stdio agent that does not call model APIs
directly.** Backwards. `isaac-acp` is an *inbound* surface — Isaac exposes itself
as an ACP agent so editors can drive it. Its outbound path is direct API. I
repeated a docs summary as fact without checking the direction.

**I said subscription rails were flatly impossible.** Too blunt. The prohibition
targets third-party developers routing *other users'* credentials; the Claude
Code CLI is an official tool covered by the subscription. The distinction is what
made this whole architecture viable.

**My recommendation moved twice** — port Adjutant's plumbing, then run OpenClaw
with an MCP bridge, then back to a harness we own. Each move came from a new hard
constraint (first the runtime evidence, then the payment rails), not from
changing taste. The payment rails outrank everything else, which is why the final
answer is stable.

**I trusted `adjutant init`'s success output** instead of verifying the end state,
and the Commander found the missing project registration before I did.

---

## 11. Reference

| Bead | What |
|---|---|
| `adj-mzsbi` | Parent initiative (titled "Hyperion" — same thing as Syl) |
| `adj-itvob` | This spike; all Syl work is tracked here for now |
| `adj-t64m9` | ANTHROPIC_API_KEY shadows the subscription login |
| `adj-125` | `adjutant init` does not register projects (assigned to abathur) |
| `adj-204` | Committed node_modules symlink — FIXED by abathur, commit 891811c3 |

Proposals: `d738e7bb` is the standalone-app proposal and carries the full
decision history in its comments. `98952c6d` is the earlier in-Adjutant proposal,
superseded.

Adjutant project id for syl: `3ba5667d`. Backend runs on port **4201** — read it
from `.mcp.json`, never assume 3001.
