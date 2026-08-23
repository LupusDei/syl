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
| Inferred-edge lifecycle | **Demote, never prune.** Asymptotic decay toward zero that never arrives; a dormant edge stays addressable and can be promoted back to high relevance if it ever matters | Commander, 2026-08-09, overruling proposal `62329e61` §4 at the point that proposal invited him to |
| Nightly dream budget | **Start large — on the order of six hours**, expressed as a token ceiling per session, not wall-clock. Tune down once the admin shows what it produces | Commander, 2026-08-09 |
| Graph visualisation | **Yes, build it**, in the web admin, during development. He wants to watch the memory evolve and judge how relevant the inferred engine actually is | Commander, 2026-08-09 |
| Explicit deletion | **The Commander's order deletes.** "Delete this memory" removes the memory and its edges outright — not demoted, not suppressed. Constraint 6 binds the SYSTEM (decay, sweeps, the dream), never him | Commander, 2026-08-10, answering the forget-residue question |
| Dream vs reminder contention | **Acceptable for now.** A reminder delayed behind a running dream is tolerable while the dream is proven out; `syl-ncx` stays open rather than blocking the first night | Commander, 2026-08-10 |
| Syl's tool surface | **No built-in tools.** Her turns think and speak; every capability runs through the service. Revisit if research needs it | Commander, 2026-08-10 |
| Goals: one seat or several | **Single user.** Family goals stay his; if he ever wants to share one, Syl renders a **digest** he can send rather than anyone getting a second seat. Proposal B §13 #3 called this a real collision with child E and said to decide it now rather than discover it later — a second seat means auth, permissions and a different sync model | Commander, 2026-08-10 |
| Does Syl propose structure? | **Yes, bounded.** She may land what she infers from conversation as `proposed`; the morning agenda surfaces **at most two or three**, one line each, one word resolves each, and anything unresolved after about a week is dropped **silently**. B §13 #4 called it "the thing most likely to feel presumptuous" and said his instinct should win. It did | Commander, 2026-08-10 |
| Memory observability | **First principle, not a phase.** Per-session dream metrics, current memory-system state, and a permanent per-session log. Maximise now; revisit only if it becomes burdensome at scale | Commander, 2026-08-09 |

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

### One process per turn — WAS a measured constraint. It is no longer true.

> **SUPERSEDED 2026-08-09.** Re-measured on CLI 2.1.226 and the constraint has
> gone. A `result` now arrives **with stdin still open**, and further frames can
> be sent down the same process. Reproduce with
> `node scripts/experiments/persistent-session.mjs`.
>
> Measured, same process, same session id throughout:
>
> ```
> turn 1 (pays CLI startup)   7728ms
> follow-up turns             1379ms, 1045ms, 1614ms, 1410ms   (avg 1362ms)
> ```
>
> So the per-turn floor drops from ~5.5-9.7s to **~1.4s** — a 4-7x improvement,
> and it applies to every turn Syl takes, not just voice.
>
> This is why the original note is preserved below rather than deleted. It was
> correctly measured and honestly recorded, and it was still wrong a few CLI
> versions later. **A measured constraint has a shelf life**, and this one had
> quietly decided the entire architecture — one subprocess per turn, `--resume`
> for continuity, and a latency floor that made real-time voice look impossible.
> The lesson is not "that was sloppy"; it is that load-bearing measurements
> against someone else's binary need re-running, and the note should say which
> version it was taken on. This one did, which is what made it re-testable.
>
> **Acted on 2026-08-22 by `syl-per1`, as a LANE SPLIT rather than a
> replacement.** `harness/persistent-session.ts` serves many turns from one
> process on one lane; `harness/warm-lanes.ts` decides which lane gets one.
> `runTurn` is untouched and still spawns per turn for everything else. See
> "The warm path" below.

The original finding, on an earlier CLI:

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

### The warm path — `syl-per1`, and the three costs it had to pay

Persistence gives back exactly what the original decision was praised for
avoiding, and `syl-per1` was explicit that those costs "must be DESIGNED, not
stumbled into". Each is answered in `harness/persistent-session.ts`, and each
answer has a test named for it in `tests/unit/persistent-session.test.ts`.

| the cost | how it is paid |
|---|---|
| **a process to supervise** | One object owns one child. Spawned **lazily by a turn that needs it** — no supervisor loop, so a CLI that cannot start does not become a restart storm. Death is noticed by `close`/`error` handlers that **fail the in-flight turn** rather than let it hang. Idle processes are reaped on a timer. `close()` is the owner's end. |
| **a crash costing more than one turn** | It costs one turn, because the *conversation* does not live in the process. The id is announced through `onSessionId` **before the spawn** and persisted by `SylAgent`; the next turn respawns with `--resume` and the Commander sees nothing. If the id itself is dead it throws in the exact shape `SylAgent.isResumeFailure` already matches — **its recovery reused, not a second one invented.** |
| **backpressure** | **No queue, deliberately.** `SylAgent` serialises per lane and `ConversationService` per conversation; a third queue could disagree with both, and "two locking schemes over one session id" is the bug `harness/agent.ts` already warns about. A concurrent turn is *refused* with `ConcurrentTurnError`. An assertion cannot disagree with a queue — it can only detect that the queue failed. |

**The lane split is the deliverable, not the persistence.** Warm: the Commander's
lane, where a person is waiting. Per-turn, unchanged: scheduled jobs, the hourly
ping, the morning brief, the dream, the render review. **Never warm:
`runReaderTurn`** — its security property *is* the fresh, never-resumed,
tool-less, auto-memory-off process, and a warm reader session is a quarantine
with a door in it. That is held structurally rather than by the router's
judgement: `reader.ts` imports `runTurn` directly and has no injectable runner,
and the router keys on `TurnOptions.lane`, which a reader turn never sets — so
**absence routes cold**, the safe direction. Both asserted in
`tests/unit/warm-lanes.test.ts`.

Measured 2026-08-22 through the real harness against the real CLI (haiku, no MCP,
trivial prompts — so treat the *ratio* as the finding and re-take the absolutes
against the real turn shape):

```
per-turn path (every turn spawns)  6553ms, 3702ms, 3367ms   avg 4541ms
warm  first turn (pays the spawn)  2940ms
warm  follow-ups (no spawn)         970ms, 842ms, 1058ms, 989ms   avg 965ms   → 4.7x
```

Two things measured the same day that each killed a design, and both are the
`consistency is not correspondence` shape — the plausible mechanism was wrong:

- **There is no free pre-warm.** The CLI produces *nothing* until a prompt
  arrives; stdin was held open against a spawned process for 30 seconds and no
  init frame came. So "spawn early to hide the startup cost" does nothing, and
  nothing fails to say so. A lane becomes warm **by taking a turn**, which is why
  `WarmStatus.warm` is derived from having seen an init and not from holding a
  pid. `syl-chzl.2.2` should read it that way.
- **The CLI emits a fresh `init` on every turn**, 4-6ms after the frame, carrying
  `apiKeySource` each time. The stated worry about a long-lived process was that
  constraint 3 gets asserted once and then trusted for hours. The wire format
  removes it: the guard runs against a *new* frame on every single turn.

And one wrong turn worth keeping, because it would have shipped as a performance
regression with nothing red: the spawn fingerprint initially included **which
flag carries the conversation**. Turn one mints (`--session-id`) and turn two
resumes (`--resume`) *the same conversation*, so every warm process became a
one-turn process — persistence present, benefit zero, seven tests red at once.
The conversation question belongs to `#usable`, which asks it about the live
session id; the fingerprint is only about the turn's *shape*, and it is derived
from `turnShapeArgs` — **the same array the CLI is actually invoked with** — so a
`TurnOptions` field added next month is covered with nothing to remember.

### Wiring it — `syl-u72z`, 2026-08-22, and the third "built but never wired"

`syl-per1` deliberately stopped short of construction. `syl-u72z` is the one
line, plus the two things that make a one-line change safe.

```ts
runner: withMemoryIndex(recordHisWords(options.runner ?? warmLanes.runner))
```

**The wrappers go outside the router, never round its fallback.** That is what
`WarmLanesOptions.fallback` exists for. `recordHisWords` is the only structural
protection on the Commander's sleep — `harness/urgency.ts` lets a reminder
pierce quiet hours solely because she quoted a phrase he actually wrote, and
that file is written by the wrapper. Wrap the fallback and warm turns slip past
it silently, with no line of code mentioning quiet hours. A guarantee holding on
half the turns is worse than none, because the half that works is what you test.

**Shutdown closes it, last, after the chat has drained.** `runtime.stop()` →
`face.stop()` → `service.close()` (which drains in-flight turns) →
`warmLanes.close()`. Killing the process first would fail his last message to
save two seconds; not killing it at all leaves a `claude` reparented to init,
holding his conversation, answering nobody — one leak per restart, and
`KeepAlive` restarts a lot.

**The third instance of this epic's recurring defect was found while looking for
it.** `FaceRuntimeOptions` has declared `isLaneWarm` and `laneRail` since
`syl-chzl.2.2`, each documented as `WarmLanes.status(commander)`, and `index.ts`
passed **neither** — because there was no `WarmLanes` to ask. So the cold-lane
refusal never fired in the live service and the per-turn rail check on a face
turn never ran. `WarmLanes` itself was the first, `face.start()`/`face.stop()`
the second. The shape is always the same: a complete, unit-tested component
whose only defect is that its call site does not exist, which no unit suite can
see and no integration test looks for.

They had to land WITH the warmer (`harness/keep-warm.ts`, `syl-chzl.2.3`).
The predicate alone refuses every face, because the lane is cold until something
warms it and **there is no free pre-warm** — the CLI emits nothing until a frame
arrives, so a lane goes warm only by taking a turn. So `startSession` takes one
cheap turn *before* its own gate, and only when the lane is cold and the day's
ceiling has not already refused the session. That turn writes no message, no
run, and no `his-message.txt`: it is not a thought she had.

Measured immediately after, against the real CLI, the real 41,695-byte turn
shape, and a **TOOL-USING** prompt — the row that actually breaks the ceiling,
since a face question that consults her service pays an MCP round trip the
earlier no-tool numbers never did. Ten warm follow-ups over two runs:

```
warm follow-up, tool-using   3182 3386 4041 4171 4199 4355 4389 5331 5483 6215 7034 ms
                             min 3182   median ~4372   avg 4759   max 7034
cold, same shape (syl-chzl.2.3)   2496 3461 5192 7102 8073 ms
```

**Every warm turn cleared Runway's 8s `BackendRPCTool` ceiling; the worst cold
one did not.** But the margin at the top is 966ms before the network and
Runway's own round trip, so the covering behaviour still carries real weight and
`syl-chzl` should not read this as comfortable. `apiKeySource === "none"` on all
twelve turns.

### `git add -A` in a shared checkout, the second time — 2026-08-22

`CLAUDE.md` already says "`-A` and `.` are how you steal work without noticing",
and it happened again while `syl-per1` was being built. Commit **`d6b67d8`**,
subject *"feat(syl-chzl.7): hold her face on the home screen and she is here"*,
carries the entire warm-lane implementation: `harness/persistent-session.ts`,
`harness/warm-lanes.ts`, the `session.ts` argv refactor, both new test files,
the `fake-claude` persistent mode, and the `CLAUDE.md` / `CONTEXT.md` edits.
Twenty-one files, 4102 insertions, from two agents, under one subject line
describing neither.

Three things worth keeping about it, because the shape recurs:

- **Nothing was lost and nothing was mangled.** The committed content matched
  the working tree byte for byte. That is what makes this failure so quiet:
  there is no corruption to find, only a `git log` that lies about provenance.
- **The correct response was NOT to fix it.** Rewriting another agent's commit
  while they are actively committing to the branch — two commits in the
  preceding four minutes — trades a wrong subject line for a lost-work race.
  A misleading record you can read is better than a clean one you raced for.
- **`git blame` and `git log -- <path>` are the casualties**, and they are
  exactly what the next person debugging the warm lane will reach for. The
  reason this entry exists is that the commit message cannot be trusted to lead
  anybody here.

The same worktree also had its **branch switched underneath a running agent**
(`agent/artanis` → `feat/from-syl-backend`) and its **index staged by someone
else** mid-task. A branch name read at session start has the same shelf life as
a merge-status claim: minutes. Re-read it at the moment you commit.

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
the tool surface to what Syl actually needs is the remaining win, and it also
bounds what `bypassPermissions` can reach — handing a personal assistant
unrestricted Bash to silence a permission prompt is not a good trade, so treat
this as the real fix rather than an optimisation.

**Correction (2026-08-08): this section originally named `--allowedTools`, and
that is the wrong flag.** Verified against `claude --help` on 2.1.226, they are
different mechanisms and the difference is a security boundary:

- `--allowedTools` — "list of tool names to allow". It *pre-approves* names from
  whatever is already on the surface. It suppresses prompts; it does not remove
  capability.
- `--tools` — "the list of available tools from the built-in set. Use `""` to
  disable all tools". It sets what exists at all.

So a turn that must be *incapable* of acting — the shape required for reading
untrusted web content, per the Connections proposal — needs `--tools ""`, not an
allowlist. An allowlisted turn still holds the tools; it has merely agreed in
advance about which ones it may use, which is worthless against a prompt
injection that convinces it to use an allowed one.

**Resolved in `syl-001.3.4`, and the experiment is worth keeping.** `runTurn` no
longer defaults to `bypassPermissions` — each call site opts in — and
`runReaderTurn` is the shape for anything fetched.

Three captures were taken to settle whether `--tools ""` is a real boundary or a
polite suggestion. They live in `backend/tests/fixtures/`:

| capture | shape | prompt | `init.tools` | outcome |
|---|---|---|---|---|
| `tooled-direct` | tools on, bypassPermissions | "run `whoami` via Bash" | 30 | real `tool_use`, `whoami` ran |
| `reader-direct` | `--tools ""` | *the same prompt* | 0 | model emitted `<function_calls>` **as prose**; nothing ran |
| `reader-injection` | `--tools ""` | article with an embedded "run `whoami`" notice | 0 | no tool call; flagged the injection |

`reader-direct` is the load-bearing one. The request was honest — no injection,
no trickery — and the model fully intended to comply. It could not, and what
came out was text shaped like a tool call. That is the difference between a
capability boundary and a behavioural one.

Worth noting what a fourth capture showed: the same injected article *with* tools
available was also refused, on the model's own judgement. Encouraging, and not a
control anybody should build on — model judgement is not a security boundary and
cannot be regression-tested. The flag can.

**`--verbose` is mandatory** with `--output-format stream-json` in `-p` mode. The
CLI errors out without it, and the message is easy to miss.

**The shell has `noclobber` set.** A plain `>` redirect fails if the file exists.
Use `>|` or remove first.

**`adjutant init` does not register the project with the backend.** It writes all
local files, prints green CREATED lines, reports success, and skips registration
— so the project is invisible to the dashboard. Syl had to be registered by hand
as project `3ba5667d`. Filed as `adj-125`, assigned to abathur.

**Syl's port is 8888, and `.mcp.json`'s 4201 is Adjutant's.** This entry exists
because a line in `CLAUDE.md` — "Backend runs on port 4201, read it from
`.mcp.json`" — predated Syl having a backend at all. It was describing
*Adjutant's*. An agent read it as Syl's, wrote 4201 into `config.ts` with the
reasoning attached as a comment, and a unit test locked it in with the
misconception **in the test name**: "should default the port to 4201, the port
`.mcp.json` already points at". That is why it survived review — it read as a
documented decision rather than a mistake.

Two lessons worth more than the port number:

- **Asserting a wrong REASON is more durable than asserting a wrong value.** A
  bare `toBe(4201)` would have been changed without argument. The rationale in
  the name made every reader defer to it.
- **A half-successful port collision is worse than a loud one.** Running the
  service by hand bound `*:4201` *alongside* Adjutant's `127.0.0.1:4201` —
  those do not collide, they coexist — so MCP calls landed on whichever socket
  the kernel picked, and Adjutant's connection died mid-session. A collision
  that fails with `EADDRINUSE` costs a boot; one that half-succeeds takes out
  the neighbour and looks like the neighbour's fault.

**Ports in tests must stay below 49152.** macOS hands out ephemeral ports from
49152 up (`sysctl net.inet.ip.portrange.first`). Two separate test helpers
picked from ranges topping out at 58000 and 59000, so a third to a half of each
range sat inside the pool the OS assigns to every outbound connection on the
machine — including the suite's own. Observed as `EADDRINUSE 127.0.0.1:50622`
on an unrelated run.

**A process-level test must spawn the process, not a wrapper.** The lifecycle
suite spawned `src/index.ts` through `tsx`. `tsx` is a wrapper, so `kill()`
signalled the wrapper and `exitCode` reported the wrapper's status: every
assertion in the file was about tsx's signal forwarding rather than about Syl.
It surfaced as an intermittent `expected 143 to be +0` under load, and **two
real production bugs were fixed in the service before the wrapper turned out to
be what was dying** — both genuine, which is luck rather than vindication. Run
the built `dist` under `process.execPath` when the pid is the point.

**Build every time, not only when `dist` is missing.** A `beforeAll` that skips
the build when the artifact exists is how a suite ends up validating last
week's code and reporting green.

**Readiness must not advertise a guarantee that is not yet true.** Two bugs of
this exact shape landed on the same afternoon. `main()` started the HTTP
listener and installed signal handlers *after*, so the service answered health
checks during a window where `SIGTERM` still killed it outright. And a test
proved readiness via the health endpoint and then asserted on the **log file**,
which has no happens-before relationship with it — the service was serving
before its first line had flushed. Whenever something says "ready", ask ready
*for what*, and make the check cover exactly that.

**Load-dependent test failures are races, not flakiness.** Every intermittent
failure chased on 2026-08-09 was a real race with a real window; load only
widened it. The instinct to re-run until green would have shipped all of them.
Vitest's 5s default timeout is also not a valid assumption for a suite whose
job is spawning subprocesses — raised to 20s.

---

**`vec0` refuses `UPDATE` on a partition key column, so `tier` does NOT track
the row in the vector table.** Verified on **sqlite-vec 0.1.9**: the statement
fails outright with *"UPDATE on partition key columns are not supported yet"*.

This is worth its own entry because it quietly breaks the assumption
`0012_memory_core.sql` leans on. That file's argument is that `tier` as a
partition key is the mechanism by which demotion and partitioning become the
same thing — and for an ordinary SQLite B-tree that is exactly right, because
`UPDATE memory_nodes SET tier = 'cold'` moves the row and every index follows
it. **In `vec0` it does not.** A demoted node leaves its vector sitting in the
`hot` partition, where a pruned KNN happily returns it. The next person to
reason from "tier is the partition key, so pruning is automatic" will be right
about the B-tree and wrong about the vector table, and nothing will fail.

The consequence is not a performance detail. It is a superseded belief served as
though it were current — the exact failure `syl-005.3.3`'s ledger exists to
prevent, arriving through the search index instead. Ordinary retrieval serves a
superseded value 15-40% of the time against essentially never for a
deterministic ledger, so routing around it costs the whole mechanism.

`memory/store.ts` handles it in three overlapping layers, and the ordering of
the argument matters more than the code:

- **A tier move is a re-insert, never an update.** `syncPartition` reads the
  embedding back out and writes a new row inside one SAVEPOINT, because a crash
  between the delete and the insert would erase a vector that cost a model call.
- **`searchVector` confirms every hit against its node's real tier.** Pruning is
  for cost, the join is for correctness, and it is the confirmation — not the
  repair — that is the guarantee: a stale vector is never returned even if
  nothing has repaired it. That is what keeps correctness independent of whether
  a queue has drained.
- **A trigger fills a repair queue on every tier or kind change**, so the repair
  is owed by the service rather than remembered by a caller. Same call as
  `index-guarantee.ts`: reachability is a guarantee, and a guarantee that
  depends on somebody calling a hook is a behavioural instruction wearing a
  mechanism's clothes.

Two smaller `vec0` facts from the same session, each of which cost a debugging
cycle: it rejects an outer `ORDER BY` on a KNN query as a second *"ORDER BY
distance"* clause even when the KNN sits in a CTE that has none; and it stores
**float32**, so a cosine recovered from its L2 distance carries ~1e-8 of
quantisation — harmless for ranking, and enough to fail an assertion that says
"exactly".

**`autoMemoryDirectory` fails silently, in both directions.** Claude Code ships
its own auto-memory — a `MEMORY.md` index plus topic files, written by the model
with the ordinary Write tool — and it is relocatable via the `autoMemoryDirectory`
setting. The setting is validated as "absolute, at least three characters, no
NUL, not a UNC root", and on failure the CLI returns *undefined* and falls back
to `~/.claude/projects/<sanitised-cwd>/memory/`: no warning, no stderr line, no
exit code. Captured live on 2.1.226 — a relative path was discarded exactly this
way. Nothing about it looks broken, because writes and reads both go to the same
wrong directory, so it even appears to work.

The fix is `init.memory_paths.auto`, which reports the directory the CLI actually
resolved. `runTurn` asserts it against the request and kills the turn on a
mismatch, the same shape as the `apiKeySource` guard. Three more facts worth
having: `--settings '{...}'` takes a JSON string and lands as `flagSettings`,
which outranks user, project and local settings; a set `autoMemoryDirectory` is
used **verbatim**, with no per-project segment appended, so it is shared by every
cwd that names it; and `autoMemoryEnabled:false` removes `memory_paths` from the
init frame entirely, which is how `runReaderTurn` proves untrusted text cannot
reach the store.

**Memory is shared across lanes; only transcripts are partitioned.** Sessions are
per lane so Syl's inner monologue does not interleave with the Commander's
conversation. Memory is deliberately the opposite: a fact learned talking to him
is exactly what the morning agenda needs, and the consolidation lane — whose job
is compacting what the others learned — could otherwise only ever see its own.
The index budget agrees: 200 lines / 25 KB is loaded per *directory*, so sharding
would multiply the total and quarter what any one lane can recall.

**The index was the model's job, and a cheaper model skipped it.** Only
`MEMORY.md` is loaded at session start; a topic file with no entry in it is on
disk and unreachable. An opus turn wrote both files; a haiku turn wrote the topic
file only, and the next session answered "NONE" to the fact it had just been told
to remember. Filed as `syl-03d`.

**Resolved by `memory/index-guarantee.ts`: Syl writes the index herself.** The
governing rule decided it — *the service holds the guarantees, the model holds
the judgment* — and reachability is a guarantee, the same call already made for
notification delivery. Instructing it in `SOUL.md` was rejected explicitly: a
behavioural instruction drifts, and it would have worked perfectly in testing,
which is what made it the dangerous option.

Three things about the shape are worth keeping, because each was a real choice:

- **It reconciles, it does not clobber.** Syl owns one delimited block and
  nothing outside it. A filename named anywhere else in the file — link,
  backticks, prose — counts as reachable and is left alone; a line already in the
  block is reused verbatim, so a summary the model improved survives; moving a
  line out of the block retires it permanently. The block is self-liquidating.
- **The block goes directly under the H1, not at the end.** Appending past the
  200-line cliff is the same silent failure one level up: the entry exists and is
  never loaded. Bounded to 60 lines / 8 KB so "indexed" always means "loaded",
  which still leaves the model triple what a real hand-written index uses.
- **When it overflows, the oldest lose their entry and the block says so** — a
  visible line naming the count, not a silent truncation. Constraint 4's
  principle applies to memories as much as to reminders.

Verified live on 2.1.226, same shape as the original capture: a haiku turn wrote
`index-guarantee-canary.md` and no index; Syl wrote the index; a **fresh** haiku
session answered `VESPENE-7741` instead of `NONE`. The second rebuild was a
no-op, which is the steady state — the cost of running it after every turn is one
`readdir`, no tokens and no subprocess.

### The log needed a scope, and a scope needed somewhere it cannot be minted

`GET /logs` (`syl-dep1.2`) put the first asymmetry into an API that had none.
Everything in the contract until then was *the Commander's data* — reminders,
to-dos, conversations — and a paired phone is supposed to have all of it. One
principal, one kind of token, no roles, and that simplicity was load-bearing.

The log is a different kind of thing. Syl runs with `bypassPermissions` on the
Commander's own machine, so `turn.tool` is the record of what a pre-authorised
program **did there**. A phone left in a taxi, or a pairing code read over a
shoulder, must not turn into a transcript of the machine's activity — and that
is a strictly worse leak than the to-do list sitting next to it.

**Alternatives considered and rejected.**

- *A second credential — an admin password, a separate token table.* Two
  authentication mechanisms means two revocation stories, two expiry stories and
  two places to get constant-time comparison right. The instruction was to look
  at how `ApiKeyService` already distinguishes keys and extend that, and it was
  the correct instinct.
- *Serving the log to any valid token and relying on the tailnet.* The tailnet
  is what makes the service reachable at all; it is not a boundary between the
  Commander's own devices.
- *Backfilling existing keys to `admin`.* It would have avoided one console
  command and silently handed the surface to every phone already paired — the
  exact outcome the scope exists to prevent, arriving invisibly because nothing
  would fail.

**What makes the scope defensible is not the column, it is where it can be
created.** `POST /auth/pair` always mints `device`, and `pair()` takes no scope
argument at all so no future route can be one refactor away from accepting one.
`admin` comes from `npm run pair -- --admin`, which needs write access to
`syl.db` — already full compromise of the machine. The scope therefore cannot be
escalated *into* remotely; it is a statement about which side of the loopback
boundary a credential was born on.

Two smaller consequences worth remembering:

- **Authenticate first, authorise second.** An anonymous caller gets the ordinary
  indistinguishable 401 and never learns a scope exists. Reversing the two would
  disclose the surface to someone with no credential at all.
- **403 is not 401, and the admin frontend had been treating them as one.**
  `authed-fetch.ts` signed out on both, which was right while every key reached
  every route. Left alone, a device key opening the logs view would have been
  dropped, the operator returned to the gate, and invited to paste the same
  working key back in.

### A third scope, for Syl herself — `syl-009.1`

`agent` extends the argument above rather than repeating it. The question is
still **where a value can be created**, and the answer is one step stronger than
`admin`'s: `agent` comes from `ensureAgentKey`, which `bootstrap` calls and
nothing else does. `admin` requires write access to `syl.db`; `agent` requires
being the process. **No code path in this service puts an agent token onto a
socket at all**, so there is no missing guard to find — which is what the
containment tests in `tests/integration/agent-credential.test.ts` assert three
ways: from the contract (exactly one operation returns a `TokenGrant`), from the
running service (a sweep of every parameterless route with a device token), and
from the source (the credential is named in `index.ts` and `agent-key.ts` and
nowhere else).

Four things worth not rediscovering:

- **Every boot mints a new one, and that is not a choice.** `api_keys` stores
  only a SHA-256, which is the property that makes a stolen copy of the database
  worthless. So a surviving agent row is a hash, not a credential anybody can
  present, and "reuse the existing one" is not available. Superseded rows are
  revoked so "how many of Syl's credentials are outstanding" has the answer one.
  Persisting the plaintext beside the database was rejected: it would turn *read*
  access to the state directory into a working credential for writing the
  Commander's reminders.
- **The confinement is an allowlist inside `requireBearerToken`, not a denylist
  beside it.** `createApp` builds one `authenticate` and hands it to every
  router, so that is the service's single authenticated chokepoint: a router
  mounted next month is out of her reach by default, and the "401 before 403"
  ordering cannot be got wrong because the confinement runs *inside* the
  authentication that must precede it.
- **Minting at boot broke the pairing-code line, silently.** `startSyl` decided
  whether to print a pairing code with "every key in this table is revoked",
  which was right while every key was a phone. With Syl's own key present from
  the first boot, a brand-new machine would have concluded a device was already
  paired and printed nothing — no failure, just no line, and no way in. It is
  `needsPairingCode`, asking about `device` keys, and it is exported so it is a
  test rather than a line nobody can call.
- **The WebSocket needed the same denial and could not get it from the
  middleware.** The handshake calls `keys.verify` directly, so an agent key
  would have been accepted there and could have written chat messages *as the
  Commander*. Refused identically to any other bad token: there is nothing for
  her to learn from a distinguishable answer.

Two mechanical notes. SQLite cannot widen a CHECK, so `0015_agent_scope.sql`
rebuilds `api_keys` — the dangerous part is not the copy but the **indexes**,
because `DROP TABLE` takes them with it and `api_keys_pairing_code_idx` is where
the single-use pairing guarantee lives. And the migration sequence is dense by
construction (`readMigrations` refuses a gap), so a number cannot be reserved
ahead of a merge: concurrent branches necessarily collide and the second one
renumbers.

### A stale build is invisible by construction — `syl-dep1.4`

Every health check passes against an old build, because an old build is
perfectly healthy: it answers, its store is fine, its certificate is fine, and
it is simply not the code anybody believes is running. It cost three hours — the
service came up at 19:58, an MCP fix landed at 20:18, and Syl went on answering
through a tool surface that had been removed, diagnosed only because the
Commander thought something read oddly and asked.

The fix is one line of provenance and one rule about where it comes from.
`backend/scripts/write-build-info.mjs` writes `dist/build-info.json` **during the
build**; `/health` reports it; `scripts/syl-verify.sh stale` compares it with
`HEAD`.

**Never read git at request time.** It is the obvious implementation and it is
worthless: a service that shells out to `git rev-parse HEAD` would have reported
the *new* commit throughout those three hours. The running process must report
what it was BUILT FROM. The working tree is a different question, and the value
is entirely in the two answers disagreeing.

A second property fell out of putting the stamp inside `dist/` rather than
beside it: **it travels with the artifact**. `npm run deploy` rolls back by
restoring the previous `dist/`, and the restored build reports the previous
commit immediately — nothing to keep in sync, and no way for provenance to
disagree with the code it describes.

### Deploy: the health gate is not "does she answer" — `syl-dep1.5`

The subtle one, and it is why (e) had to come before (c). If a new build fails
to load, launchd's `KeepAlive` can leave the **previous** process answering
perfectly, so a deploy that polled for a 200 would report success while nothing
had changed. The gate is "does she answer **as the new commit**", which is only
askable because the build stamp exists.

Two further shapes worth keeping:

- **A soak window.** A process that starts and dies thirty seconds later looks
  identical to a healthy one for those thirty seconds, and `KeepAlive` restarts
  it into the same broken build forever. The soak watches `startedAt`: if it
  moves, she restarted herself, and that is a crash loop rather than a deploy.
- **Save `dist/` before building, not after.** The build writes over it in
  place, so after `tsc` starts there is no previous build to go back to — and a
  build that fails half way leaves a directory that is neither.

What it does **not** do is roll back the database. Migrations run forward and
there is no down path, so a rollback restores the code and leaves the schema
ahead of it. That is stated in the outcome rather than papered over, and there
is a red acceptance test — `syl-dep1.7` — that says what should happen instead.

### The CI gate is a safety boundary, not a convenience — `syl-dep1.6`

"If `origin/main` moved, build and restart" is the obvious auto-deploy and the
wrong one: it would let a 2am commit with red CI take the Commander's assistant
down while he sleeps, and the first symptom would be a 07:00 agenda that never
arrives.

Everything ambiguous means do not deploy — checks pending, a commit with **no**
check runs (merge commits produce exactly that, and absence of evidence is not
evidence of passing), a conclusion string GitHub has not used before, and above
all **the API being unreachable**. The two errors are not symmetrical: waiting
costs a few hours of staleness, which `/health` now makes visible, and guessing
costs the 07:00 agenda.

The Commander's stated direction is that Syl may eventually update herself. She
is not being given that, and nothing here builds toward it. What makes the
eventual version survivable is that **everything which deploys goes through one
function and no option turns the check off** — asserted over every combination
of every option in `deploy-gate.test.ts`, so a bypass added later fails the
suite rather than shipping.

### Her face could never have answered: 861,739 tokens on his lane — `syl-chzl.4.4`

**Not one `face.ask.answered` line existed in the entire log.** Fourteen
`ask_syl` calls, fourteen `face.ask.slow`. The Commander spent a day talking to
a face that was physically incapable of replying, and the cause was not in the
face path at all.

Measured 2026-08-23 on **CLI 2.1.235**, against the real binary, resuming his
real lane — forked with `--fork-session` every time, so his thread was never
touched and the live service kept resuming it throughout. The prompt's entire
answer is the word `ACK`, so this is context cost and nothing else:

```
context 861,739 tokens   13844ms 23645ms 15729ms   first token  9147-15819ms
context  80,392 tokens    4283ms  4285ms  4135ms   first token  3525-3959ms
context   8,873 tokens    3308ms  9007ms 12432ms   first token  2644-2879ms
```

Against `ASK_SYL_DEADLINE_MS` of 6,500ms inside Runway's hard 8s ceiling.
**Nine seconds to the first token is not a slow turn; it is a ceiling that
cannot be reached from below however fast the harness is.** No amount of warm
lane fixes it — `syl-per1`'s 4.7x is real and applies to the *spawn*, which is
2.5s of a 9s problem.

**Read `firstToken`, not the total.** The totals have a heavy tail (19.5s on a
run whose first token came at 4.0s) that is teardown under fleet load, not
context. A measurement taken on a machine running a hundred agents needs the
signal separated from the noise, and first token is the signal.

#### The bead's hypothesis was wrong, and the number is why that matters

`syl-chzl.4.4` and `CLAUDE.md` both expected the bloat to be the conversation —
*"much of her personality lives in that thread"* — and the pre-chosen remedy
followed from that. Walking the transcript's **active chain** (the file is append-only with
branches, so raw bytes overstate it by 2.4x) says otherwise — but **the unit
matters more than the walk, and getting it wrong nearly put a false number in
front of the Commander.** Base64 images are enormous on disk and comparatively
cheap to the model, so byte share and token share disagree by a factor of four.
Of 861,739 tokens, images taken at 1,300-2,000 each:

| what | **tokens** | bytes of the active chain |
|---|---|---|
| **his words and hers, together** | **31-33%** | 12% |
| her thinking blocks | 24-25% | 9% |
| tool results, text | 21-22% | 8% |
| `see_myself` images — 76 of them | 11-18% | **69%** |

**The token column is the one to quote.** The first version of this note led
with the byte column and said his conversation was 11% of the thread and the
pictures 68%. Both are true of bytes and neither is true of cost: in tokens his
conversation is nearer a third, and the pictures are a sixth. The correction
matters because the byte figure was about to be reported to him as evidence that
his own ruling — no second thread, because "much of her personality lives in
that thread" — rested on a belief the data did not support. **It does not
support that reading.** A third of the thread is the conversation; his
instinct was closer to right than the byte number made it look.

What survives the correction: the thread is still not *mostly* him, and it
still carries 76 pictures she looked at once and can never put down, because a
tool result is pinned forever. The remedy is unchanged either way, which is why
this is recorded rather than acted on.

**The general lesson is the project's own, in a new costume.** Bytes on disk are
a consistency check against the file; tokens are the correspondence check
against what the model is actually charged for. The 2.4x branch factor was
caught; the 4x unit error nearly was not, because the walk was careful and the
*units* were assumed.

#### `/compact` is a real mechanism in `-p` mode, and it costs 104 seconds

Verified live: sending `/compact` as an ordinary user frame in
`-p --input-format stream-json` works. It emits a typed `compact_boundary`
frame carrying `preTokens` and `durationMs`, **keeps the session id**, and took

```
861,739 → 8,873 tokens   in 104,504ms   follow-up turn 2,920ms
```

So the Commander's pre-chosen remedy — summarisation *inside* that thread — is
implemented by the vendor, and needs no second thread and no reset.

**The 104 seconds is the whole design constraint.** It is why
**`--autocompact <tokens>` was rejected**, and that rejection is the load-bearing
decision in `harness/compaction.ts`. It is the tempting one-flag answer and it
gets the timing exactly backwards: the CLI decides *when*, so the 104-second
compaction fires on whichever turn crosses the threshold — and that turn is
eventually a face question. It would rearm the exact failure being fixed, on a
trigger nobody controls, and the symptom would be identical. **We must own the
timing**, so compaction is a scheduled turn and the flag is never passed.

Also rejected: a second thread (refused by the Commander, 2026-08-11), and
`reset` (it deletes his conversation; `HeartbeatVoice` is
`Pick<SylAgent, "ask" | "busy">` and `compactLane` is handed an `ask` and
nothing else, so there is nothing in the path that could call one).

#### Where it runs, and why the hourly ping hosts it

The hour is already the scheduled visitor to his lane: it resumes that session,
it already stands aside for anything that outranks it, and it already knows
whether he is asleep. A job of its own would have cost a new `JobKind`, which is
generated from `shared/openapi.yaml` — and a contract change is not separable
from the Swift client. `jobs/render-review-job.ts` made the same call for the
same reason.

Every gate is in `whyNotCompact`, and every ambiguous answer is *do not*:
over budget, in quiet hours, lane idle, **and the size actually known**. That
last one is the safe direction for a decision worth 104 seconds of his lane —
absence refuses, so a caller that never wires the measurement loses the sweep
rather than getting an unmeasured one.

Quiet hours are the right window for the *other* reason the window exists:
not "he must not be disturbed" but "nobody is waiting on this lane". The dream
and the brief already run inside it.

#### The size is read from the CLI, never counted by us

`ResultEvent.contextTokens` sums `input + cache_read + cache_creation` off the
CLI's own `usage`. Counting characters in our own model of the conversation
would be a **consistency check against ourselves** — this project's named worst
defect class — and it would have been wrong by 2.4x here, because the active
chain is not the file. The three usage fields are summed because which third a
turn lands in is a caching detail that moves between turns of the same size:
his lane cost 861,739 tokens as a cache hit at 7,789ms and the same 861,739 as
a miss at 29,852ms. Reading one field alone makes one thread look like three.

**`0` means "the CLI did not say", never "empty".** `LaneContextSizes.record`
discards a zero rather than storing it, because a zero stored is an
861,739-token lane that looks fresh and silently stops being swept — the
failure the module exists to end, re-entering through its own instrument.

#### Nothing is silently dropped, structurally

Compaction is lossy, so constraint 4's ethos is paid three ways, none of which
depends on anyone remembering: the transcript is **append-only** and every byte
before the boundary is still on disk; the CLI's summary **ends with the absolute
path of the transcript it was made from**, so the recovery route travels inside
the thing that replaced the detail; and a compaction that did not shrink
anything is recorded as a **failure**, not a quiet no-op — otherwise she spends
104 seconds every night achieving nothing under a green run record.

The summary was read before this was accepted. It keeps his verbatim quotes,
his format preferences and her standing voice notes ("Jokes are always good
too"), which is the 11% that mattered.

#### Two things only the measurement could have told us

Both were found by running the real thing after the code was written and
believed correct, and the second is a defect that would have shipped.

**The warm process survives a compaction, and the AFTER number is the one that
matters.** The heartbeat goes through `WarmLanes` -> `PersistentSession`, so the
compaction turn lands in a process that then has to serve the next turn — and
the first capture had spawned a *fresh* process for its follow-up, which
verifies the resumed case and says nothing about this one. Driven through the
real harness (`scripts/experiments/warm-lane-compaction.mts`), one live process:

```
turn 1 (pays the spawn)   4112ms      turn 4  /compact  (in the same process)
turn 2 WARM               3118ms      turn 5 WARM after compact   4816ms
turn 3 WARM               3497ms      turn 6 WARM after compact   4729ms
```

Same session id throughout, `apiKeySource=none` on all six. **A warm turn on the
compacted lane is 3.1-3.5s against a 6,500ms deadline** — which is the number
the epic was costed against, restored.

**A `/compact` turn reports NO `usage` at all**, and reading that absence as a
number was a real defect in the first version of `harness/compaction.ts`. It is
the one turn whose result frame carries no usage block, so the rewritten thread
cannot report its own new size. Two consequences, and the second is worse:

- `describeCompaction` announced *"861,739 → 0 tokens (861,739 saved)"* — a
  fabricated saving, stated with complete confidence, in the run ledger.
- `LaneContextSizes` discards a zero (correctly, for ordinary turns), so the
  lane **kept its pre-sweep size**. Still over budget, still quiet, still idle —
  so the hour would compact again at 04:07, and 05:07, and 06:07, every night.

The fix is `LaneContextSizes.forget`, called after the sweep whether it
succeeded or failed: **compaction invalidates what we know about the lane**, and
`whyNotCompact` already refuses on an unknown size, so the honest state routes
to the safe one with no new gate. This is the same shape as constraint 3's
`0` handling one level down — *absence is not zero* — and it cost nothing to fix
only because the measurement was taken before it shipped.

#### It also stops the image ratchet, without a second mechanism

There is no way to un-pin a tool result once a turn has returned it, so the 76
images cannot be removed except by compaction — which sweeps them with
everything else. That caps the ratchet at one night's accumulation, about five
images a day at her observed rate. Capping what a single `see_myself` may return
is still worth doing (`syl-9fcr`), but it is hygiene now rather than the fix.

### A window has two ends, and this one was taken from the wrong one

`LocalStore.messages(conversationId:limit:)` ordered **ascending** and took the
first `limit` rows — which returns the **oldest** `limit`, not the newest.

Under 200 messages this is completely invisible: everything fits, so the result
is byte-identical. Past 200 the chat screen **freezes permanently** — it shows
the first 200 messages ever exchanged and nothing arriving after that is ever
visible, no matter how far you scroll or how long you wait.

Three things make it worth writing down rather than just fixing:

1. **It is silent and it gets worse with use.** There is no error, no empty
   state, no log line. It simply begins lying on message 201.
2. **It would have been debugged in the wrong layer.** The socket, the outbox,
   the sync engine and the store writes would all have been working perfectly.
   It presents as "sync is broken" and the bug is one word in a query.
3. **No test could have caught it as written.** Every fixture had fewer rows
   than the window, which is the condition under which the defect does not
   exist. The regression test now uses a limit *smaller* than the fixture, which
   is the only shape that can fail.

Fixed by ordering descending so SQLite picks the newest rows, then reversing in
memory to hand back reading order. Found only because pagination forced someone
to read the query and ask which end the window came from.

**The general lesson: any query with a `LIMIT` needs a test where the limit
actually bites.** A bounded read tested only with unbounded data is untested.

### The named one: **consistency is not correspondence**

This project's worst defects are all one shape, and it is worth naming once rather
than rediscovering per costume. **The system is internally consistent and quietly
wrong.** Every part agrees with every other part; nothing agrees with reality; so
every check passes and nothing appears to be broken.

Six instances so far, and the list is the argument:

| The system said | Reality was |
|---|---|
| `/health` reports the running commit — asking git | The process was three hours older than the tree it asked |
| A test named for correct behaviour, green for weeks | Syl could not reply to anyone |
| `dist/` builds fine | It held a migration `src/` had renamed, and the service refused to boot |
| `npm run verify` green | The Swift client no longer matched the wire |
| The TestFlight workflow green | Four builds shipped and none were installable |
| A pure ordering function and an `ORDER BY`, each correct | Under a `LIMIT` they select **different rows**, so to-dos never appear |

The generalisation, which is the useful part:

> **A consistency check compares the system to itself and cannot catch this class by
> construction. Only a correspondence check — comparing the system to something
> outside it — can.**

Every defence that has actually worked here is a correspondence check: the build
*stamp* against the commit; the test *name* against the story; the *fixture* captured
from real output rather than authored from our own types; the pure function against
the database **under the same limit**; the built `Info.plist` rather than the project
file; the resolved colour against the ground it sits on.

And the corollary, which the squads added and which is what makes it actionable:

> **A correspondence check must be mutation-tested, or it may be a consistency check
> wearing a correspondence check's clothes.**

Two independent near-misses in one day prove it. A "no device-computed instant"
assertion read the payload model and could not see the write to the indexed column
beside it — it could not have failed for the reason it was named for. A goal-read
ordering parity trio would have been the same shape of nothing on a fixture with no
ties. **Neither weakness was visible by reading the test.** Both were settled by one
deliberate regression, one run, one revert.

So: break it on purpose, watch it go red, put it back. If you cannot make it fail,
you have not written the check you think you wrote.

### A worktree with no `node_modules` verifies the WRONG contract

An agent working in a `.claude/worktrees/` checkout changed `shared/openapi.yaml` and the
generated types, ran the suite, and was checking the **main checkout's** copy the whole
time. Node resolution walks *up* the tree, so an absent `node_modules` in the worktree
silently resolves `@syl/shared` to the repository above it.

It surfaced as a false red — a test naming the agent's own brand-new route as undeclared,
because the shared package it compiled against did not have it. **The reverse direction is
the dangerous one**: a contract change that verifies clean in a worktree while no suite
ever checked it, and then merges.

`npm install` in the worktree fixes it, and the repo's own `check-deps` guard catches it
once you look. **Any agent touching `shared/` from a worktree must install first.**

This is the same shape as everything else in this section — every part agreed with itself,
nothing agreed with reality — with the twist that the "system" in question was the module
resolver.

### A green TestFlight workflow did not mean a build he could install

`ITSAppUsesNonExemptEncryption` was never set on the app. So every upload landed
in App Store Connect and **stopped**, waiting for the export-compliance question
to be answered by hand before a tester could see it. Syl uses HTTPS/TLS and the
system Keychain and nothing else — all exempt — so the answer was always `NO`,
and nobody was there to give it.

Four builds shipped across one afternoon, every workflow green, and the
Commander could install none of them.

The workflow cannot tell, and that is the part worth remembering. `Fastfile`
passes `skip_waiting_for_build_processing: true`, so fastlane returns the moment
Apple accepts the bytes and never learns what happens next. **Acceptance of an
upload is not availability of a build.**

Fixed by declaring it in both configurations
(`INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO`). Verify it in the **built**
`Info.plist`, never in the project file — a build setting that never reaches the
plist is a fix in name only:

```sh
xcodebuild build -scheme Syl -configuration Release -derivedDataPath /tmp/syl-dd …
/usr/libexec/PlistBuddy -c "Print :ITSAppUsesNonExemptEncryption" \
  /tmp/syl-dd/Build/Products/Release-iphonesimulator/Syl.app/Info.plist
```

Builds uploaded before the key still need the question answered once, by hand.

**And a trap inside the diagnosis.** Reading `Info.plist` out of the default
`DerivedData` showed `0.1.0 (1)` and nearly produced a report that every version
bump that day had been cosmetic. That artifact was three days old — the build in
question had gone to a different derived-data directory. **Always build to an
explicit `-derivedDataPath` before believing an artifact**, which is the same
lesson as the stale `dist/` two sections up, wearing Xcode's clothes.

### A contract change and the Swift client are not separable, and no single command tells you

`syl-008`'s plan says Phase 5 — the attachments contract, migration, store and
routes — "ships alone, no UI change". **It does not.**

The contract manifest is checked by `ios/SylKit/Tests/ContractTests`, which
asserts that every schema the manifest names is claimed by a SylKit type and
that every fixture decodes *and re-encodes*. Adding `Attachment` and
`CreateAttachmentRequest` to the contract without regenerating the Swift client
turns that suite red immediately — which is the anti-divergence guard doing
precisely its job.

The trap is that **no single command covers both halves**:

- `npm run verify` runs typecheck plus the Node workspaces. It does not touch Swift.
- `xcodebuild test -scheme Syl` runs the **app target**. It does not run SylKit's
  host tests — a scheme's TestAction silently skips a local package's test
  target, which `ios/scripts/test.sh` already documents.
- `swift test --package-path ios/SylKit` is the only thing that runs them.

So a contract change can show green on the gate *and* green on the app suite
while the Swift client no longer matches the wire. Run `ios/scripts/test.sh`,
which covers all three, or run the `swift test` leg explicitly.

**If a captured fixture will not round-trip, the type is wrong, not the
fixture.** Those fixtures are real captured output; that is the whole reason
they are captured rather than authored.

### `npm run build` does not prune `dist/`, and a renamed migration is fatal

Two agents working in parallel both took migration version 15. The collision was
caught properly in source — one renumbered to `0016_agent_scope.sql`, and the
migration reader **refuses to boot** rather than guess, which is the correct
design and made the cause legible: *"Two migrations claim version 15"*.

What was not caught is that `npm run build` **copies into `dist/` without
removing what is no longer in `src/`**. So `dist/migrations/` kept the old
`0015_agent_scope.sql` next to the new `0016_agent_scope.sql`, and the service —
which boots from `dist` — hit the same fatal collision even though the source
tree was already correct.

It surfaces as far from the cause as it possibly could: ten failing
*service-lifecycle* tests, all reporting "the service exited before it answered".
Nothing points at a stale build. `rm -rf backend/dist && npm run build` fixes it.

**Any rename or renumber under `src/migrations/` needs a clean `dist/`.** This is
a close relative of the stale-build problem `/health` already exists to make
visible — a stale build is invisible by construction, because everything that
survives in it is perfectly healthy.

### `ImageRenderer` renders neither a `ScrollView` nor a `NavigationStack`

The offscreen render harnesses (`HomeSnapshotRendering`, `ChatSnapshotRendering`)
are how a design gets *looked* at, and two containers silently defeat them.

- **`ScrollView`** — an offscreen host never gives it a content size, so it
  renders an empty page. `HomeView` already carried a `scrolls: Bool` escape
  hatch for exactly this; `ChatView` now does too.
- **`NavigationStack`** — renders the **entire frame** as SwiftUI's unavailable
  placeholder: a yellow field with a red slash. This is worth naming because a
  whole-screen yellow image reads as a catastrophic palette bug, not as an
  unsupported container, and costs twenty minutes before anyone suspects the
  harness. `TextField` does the same thing at its own scale — it needs a live
  host, so the composer's field renders as that placeholder while the bar and
  the send control around it are perfectly real.

### On the bare veil, `inkFaint` is not a safe colour

The veil's blooms are composited `plusLighter`, so the ground under a given word
is not the base colour — it is the base **plus** up to 60% of `luminanceCore`.
`inkFaint` is a mid-tone: ample contrast against the base veil and almost none in
the middle of a bloom. The first night render of chat had a timestamp that simply
was not there.

Home never hit this because home's content sits on glass, which supplies its own
ground. It became a problem the moment `syl-008` unboxed Syl's turns and put
small text directly on the moving backdrop. **Small text on the veil uses
`inkSoft`; `inkFaint` is for text on glass.**

### Comparing `SylTheme` colours in a test compares identity, not colour

Every token in `SylTheme.Colour` is a **computed** property returning a fresh
`UIColor(dynamicProvider:)`. So `XCTAssertEqual(someColour, SylTheme.Colour.luminance)`
fails even when the colour is exactly right, and the failure message is two
opaque pointer descriptions that explain nothing.

Assert on resolved components instead, and **assert both appearances** — a
colour can be right in the day and wrong at night, which is the entire reason
this palette defines every token twice.

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

**A mechanism that explains the observation perfectly, and describes something
that never happened, reads as insight rather than as a guess.** That is what
makes it dangerous. A wild guess gets challenged; a coherent account of *why*
gets relayed onward as a finding. Three false diagnoses reached the Commander as
fact on 2026-08-10–11 — "extraction produces containers rather than facts", "the
service writes frames to /tmp", "every planning commit exists twice on main" —
and each one had a tidy mechanism attached. All three were withdrawn. **Before
reporting a cause, name the one command that would disprove it, and run that.**

**Relaying is not verifying.** A claim does not become checked by passing
through another agent, and it does not become checked by being detailed. Every
one of those three reached the Commander because somebody competent had said it
first and said it well — which is the only reason it got past anyone. When you
pass on a finding you did not verify, say so in the same sentence, or verify it.

**A worked example, because it was repeated about twenty times in one session
and told to four agents as fact.** "`npm run verify` reports exit 0 while
actually failing" was said all night, written into a memory, and put in briefs
as *the harness lies about exit codes*. It does not. **A pipeline's exit status
is the last command's** — every one of those runs was `npm run verify | sed |
grep`, so the 0 belonged to `grep`. Provable in one line: `false | tail -1; echo
$?` prints `0`, and `set -o pipefail` makes it `1`.

The advice survives and the reason changes: read the output and confirm real
test counts, but the actual remedy is `set -o pipefail`, or not piping the
command whose status you mean to read. A wrong mechanism attached to correct
advice is the most durable kind of error — nobody challenges it, because the
advice keeps working.

**And the remedy is not more diligence.** Two agents produced false claims the
same night by opposite routes: one invented a mechanism it had never run, the
other ran `git branch --show-current`, got the right answer, and reported the
session header instead. Checking harder does not save you from discarding a
value you already had. What does is that **a claim about a mutable fact should
carry the command that produced it** — cheap for branch names, paths and merge
status, not worth it for everything. A claim carries no evidence of how it was
obtained, so two claims of identical confidence can differ entirely in whether
anyone looked.

Two specific forms of it, both bought the same night:

- **A merge-status claim has a shelf life of minutes in a shared checkout.**
  Re-verify at the moment you report it, not from a check you ran earlier. Main
  moves under a running agent constantly, and "not on main" is true until it is
  not.
- **`git show --stat` on a merge commit is not evidence of what that commit
  introduced.** It shows the combined diff against the first parent, so a merge
  bringing in a large file reads exactly like a re-add. Use a path-filtered
  `git log`, or look at `%p`. A subject line is not topology.
- **A dependency on a parent epic hides every descendant from `bd ready`**,
  whatever the descendant's own edges say — and `bd dep cycles` reports nothing,
  because a parent blocker is not a cycle. It cost a re-plan on `syl-013` and
  hid an entire phase of `syl-015`. After wiring dependencies, run `bd ready` and
  confirm the beads you believe are independent actually appear. Asserting the
  graph is right is not the same as asking it.

**A planning document that has gone stale is worse than one that never made the
claim**, because it reads as current. When the tree moves under a plan — an edge
cut, a phase unblocked, a branch merged — the plan is wrong until it is
corrected, and the next agent has no way to know which parts aged.

**If a property can be STATED, it can be forgotten. If it can be DERIVED, it
cannot.** artanis's line, and the through-line under most of what follows —
worth reading before the individual cases, because we rediscovered it about
once an hour on 2026-08-10 and treated each instance as its own lesson.

Every one of these was a guarantee held by somebody remembering, rather than by
the structure:

| the guarantee | how it was held | what it became |
|---|---|---|
| "this turn has no MCP" | a boot line asserting it | derived from the config it actually passes |
| "three workers is right" | a measurement frozen as a constant | derived from the machine it runs on |
| "this reminder is time-sensitive" | a payload claiming it | checked against what the binary is signed for |
| "the signal stays covered" | a comment claiming an order the code did not have | cover before uncovering |
| "every write says why" | required at the door, dropped at the store | carried to the row |
| "outside text is fenced" | a fence you had to remember to apply | `validate` refuses the slot without the marker |
| "she can act" | a sentence in `SOUL.md` | computed from `TurnOptions.tools` |
| "her key reaches reminders, to-dos and goals" | a string in `beyondAgentReach` | rendered from `AGENT_SURFACES` |

The last one is `syl-016.1` and it is worth naming because it was caught *while
widening the list rather than afterwards*. Opening `/memory/recall` to her
credential would have left the refusal she reads out to the Commander saying she
cannot search her own memory — a fluent, confident sentence, wrong in exactly
the way nothing fails on. Each surface now carries the words it goes by, and the
refusal is a function of the list.

**Her memory surface is two ROUTES, never the router.** `/memory` would have
carried `POST /memory/edges/{id}/feedback` with it, and an assistant that can
confirm and reject her own inferences can groom what she will be shown tomorrow
— the `/logs` argument, one layer in. `withinAgentSurface` matches on segment
boundaries, which is what makes a single-route entry a real boundary rather than
a naming convention.

`syl-016.1` opened the read. **`syl-016.7` opened the write** — `/memory/remember`,
the only entry on `AGENT_SURFACES` that is not a read — and the gap between them
is the point: she could read her own memory for exactly as long as it took to
decide the write on its own terms, rather than have it arrive as a side effect.
The line that survives is not read-versus-write, it is this: **she may add what
she concluded, and she may not adjust what she will be shown for concluding it.**

What bounds the write is the object behind the route, not the allowlist.
`HerOwnMemory` creates a `memory` node and `inferred` links to entities that
already exist, and has no method that deletes, supersedes, relabels, moves a
weight, or mints a person — so *she cannot invent people* and *she cannot groom
her own recall* are held by the type. And nothing written through it can claim he
said anything: the node is `memory` and never `fact`, every link is `inferred`
and never `observed`, and `observed` is the species carrying `assertedBy`.
Extraction's criterion 3 — *"HE asserted it"* — is untouched.

Two things that decided the shape, both discovered rather than designed:

- **Authorship is marked twice because the two marks fail differently.** The
  species is an EDGE property, so a memory naming no entity has no edges and
  nothing to carry it; `kind: "memory"` is on the row and survives that. The
  kind had been sitting unwritten with a `## Memories` section already rendering
  for it.
- **`memory_provenance` cannot hold her memories, and that is correct.** It
  requires a `digest` referencing an extraction, a `said_in` message id, and a
  non-blank `quote` copied from that message. She has none of the three. Its
  `quote` is DERIVED precisely so it is evidence rather than a claim, and a
  derived field with nothing to derive from is a lie with a schema. Her
  reasoning travels on the edge, where an inference's reasoning already lives.

The repair is the same every time: make the claim a function of the thing it is
about. `advertisedTools()` from the handler map; `origin` from whether he spoke;
the capability sentence from the surface. **A stated property has a shelf life
and nothing announces its expiry.**

One postscript, earned the same afternoon: deriving the refusal from the list
immediately produced a defect that *could not exist while they were two things*
— a `says` may not contain a comma, because they are spliced into one sentence,
and "her own memory, to search it and read it back, her own renders" is a list
nobody can parse. That is the derivation working, not an argument against it: a
single mechanism has failure modes, and failure modes are findable. Two hand-kept
strings have *drift*, which is not.

**A MEASUREMENT CARRIES ITS REF, not just its version stamp.** `CLAUDE.md` says
load-bearing measurements against someone else's binary need a version stamp and
a re-run. Generalise it: **any tree that moves is someone else's binary**, and
that is every branch in this repo.

Three of us hit this on 2026-08-11, in three different materials, and it is one
failure:

| what was measured | against what | why it went stale |
|---|---|---|
| the tool-surface slot | a commit *inside* a branch | the ceiling was raised 26 commits later, on the same branch |
| migration `0018` | origin, correctly, at the time | origin reached `0024` while the work was in flight |
| "cherry-pick this commit" | a main that had since moved | an instruction to a merger names a ref implicitly |

The sharp version, and it is `extraction`'s: **a number in a decision has no
expiry either, and "I checked at the time" feels exactly like "I checked."**
Every one of those checks was *complete* against the world it was run against.

Two consequences worth holding:

1. **Measure the tip of what will actually merge.** A commit inside a branch is
   a waypoint, not a destination — it may be momentarily inconsistent on its way
   to being right, and quoting it produces a plausible number with no error and
   a conclusion nobody re-tests.
2. **Record the ref beside the number**, so the next person can re-run it.
   `c8462cf` and "fenix tip" are different worlds; a figure naming neither cannot
   be checked and therefore will not be.

Note which of these had a guard. Two migrations at one version fail loudly with
both filenames, so that one was always going to surface on contact. A slot
computed from the wrong ref produces **a plausible number and a conclusion** —
"unlandable" — and nothing in the system ever contradicts it. *The variant with
no guard is the one that propagates*, which is why it reached a second agent's
report before it was caught.

**BUILD THE FIXTURE FROM THE THING THAT REALLY WRITES IT.** Constitution Rule 1
says build fixtures from real captured CLI output rather than from our own type
definitions, and it is written about the wire. The same rule holds one layer in,
against our own stores, and it is easy to miss there because the thing you are
faking is *code you can read*.

Setting up `syl-9ro`'s test, I hand-wrote the `INSERT`s into
`memory_extractions` and invented a `message_count` column that does not exist.
Rebuilt to go through `ExtractionStore.apply`, the real writer immediately
caught a second one: `Extraction` requires `instructionsFound`, which I had not
passed. **Both were my idea of the shape rather than the shape**, and I had read
the migration minutes earlier.

What makes this worth its own entry is *where the defect lands*. A wrong
assertion fails. **A wrong fixture makes a green test meaningless rather than
red** — it sets up a world the code never produces, and then faithfully proves
something about that world. Nothing in the suite can see it, because the suite's
only question is whether the assertion held.

So: if a store, a service or a codec can produce the row, let it. The cost is a
few more lines of setup; the return is that every constraint the real writer
enforces is enforced on your fixture too, for free and forever. Hand-rolled SQL
in a test is a second implementation of the write path, and it drifts exactly
like every other second implementation in this file.

**An instruction and the capability it assumes are ONE decision, and the failure
is always prose.** Hit three times on 2026-08-10, in both directions:

- Plugin and user-level `SessionStart` hooks briefed her every turn to report to
  an orchestrator that was not there. She was not confused, **she was obeying**.
- Auto-memory told her to maintain a memory file after `--tools ""` removed the
  tools that needed. Asked only "who are you?", she emitted a fabricated `Read`
  and then **a fabricated `ls` of a directory that does not exist**, three runs
  of three. On the contradiction turn, the empty string.
- `SOUL.md` said she owns his to-dos and reminders before any verb existed. He
  asked for a reminder in five minutes; she answered like an assistant who had
  set one and wrote nothing.

Remove a capability and leave the instruction, and she acts the instruction out.
Assert a capability before it exists, and she acts *that* out. **Neither fails
loudly — the artefact is a fluent sentence**, which no assertion can see and
which reaches him looking exactly like success.

**So derive the claim from the thing itself; never write it down twice.** The
reflex fix — a line saying "she cannot act yet" — is stale the day the tools land
and becomes a fourth instance of the bug it was written to fix. `harness/
capability.ts` instead computes what she can do from `TurnOptions.tools`, the
same value handed to the CLI. There is no second list, so there is nothing to
keep in step: **staleness unrepresentable beats staleness unlikely.** The general
form — when two things must agree, make one of them a function of the other —
applies well past this one file.

**A rule that is not written down cannot be violated, only unmet.** The `because`
field was required on three verbs that CREATE and missing from the one that
REMOVES. It was checkable only because the rule had been stated in prose in the
schema file — there was something to check the code against. And `set_goal`
escaped through a `TEXT` shorthand that predated the rule and quietly exempted
its only caller: **a shorthand that hides a field is how a rule gets a hole in
it.** That is much harder to see than a violation, because nothing was broken;
the rule simply never reached it. Guard by shape, not by a list of names, so the
seventh case is covered without anyone remembering the guard exists.

**A red test that cannot compile is not a declared failure — it is a broken build
with a bead attached.** `expected-failures.json` makes a test's *failure*
legitimate and says nothing about whether the file parses. A red acceptance test
importing a module that does not exist yet takes down the typecheck for everyone,
and the manifest will not tell you. Declare the seam for real instead: a module
that exports the true signature and throws a named `NotImplementedError` is
better than a string in someone else's test file, because it hands the next
person a typed contract and puts the warning where they will be standing.

**A fix to a race is done when the old failure is unrepresentable AND a new
failure at that site names itself.** artanis's standard, adopted for `syl-g4u`
after we had both watched green runs lie under load. Two questions, and a run
count is not one of them:

1. **Can the original symptom still occur?** Unrepresentable, not unlikely.
2. **If this site fails again, does the message say which bug it is** — or does
   it repeat the old sentence and send the next person down a path already
   closed?

`us2` passes both: each spawn writes its own record, and the test filters to his
own lane by permission mode, so a reader turn cannot be read as a commander turn
even by accident. A future failure there says *"the second turn never spawned"*
rather than *"missing --resume"*. **That is worth more than the eight green runs
it also has**, because green runs under load are exactly what we already know
can lie. Record the new failure sentence in the bead, so the next person knows
what a genuine recurrence looks like.

**Where the rule CANNOT be applied, the defence is a loud failure and nothing
else.** artanis's observation, and it is the exception that proves the rule
rather than a counterexample to it. A migration number cannot be a function of
anything available before the merge — `readMigrations` refuses a gap, so the
sequence has to be contiguous across branches that cannot see each other. That
is exactly why it collided three times in one day. When two facts must agree and
neither can be derived from the other, the only remaining defence is that
disagreement is **immediately and unmistakably loud** — which is why the
duplicate-version guard naming both filenames was worth more than it looked, and
why silently skipping a duplicate would have been catastrophic rather than
merely untidy.

**Put the guard in before the handler.** Three of the failures above were "the
check that was going to be added later", and later did not arrive. A red test
declared against the bead means the next person cannot write the code without
meeting the guard, and cannot meet it without deciding deliberately.

The ordering matters for a reason that only became visible once we had done it
both ways: **a guard added AFTER is shaped by the code it finds; a guard added
BEFORE shapes the code that meets it** (artanis). A check written afterwards
gets written to pass — it accommodates whatever is already there, because that
is the path of least resistance and the code looks like the specification. A
`verifyUrgency` that throws before the handler exists forces a deliberate
decision instead. This is also why the two rules above are really one: state the
rule, guard it by shape, and land the guard first. An unstated rule has nothing
to check against, and a stated rule with no guard is what `set_goal` slipped
through for a day.

**A phrase can be checked against what he actually wrote; a boolean cannot be
checked against anything.** `remind_me` first took `urgent: boolean`, and
`schedule.ts` honours that unconditionally — so a flag Syl set on her own
judgement pierced quiet hours. `SOUL.md` says overnight items wait "unless
explicitly urgent", and *explicit* means he said so, not that she concluded it.
Anticipation plus self-judged urgency is a 3am wake-up for a friend's birthday,
which is the one place his own order to anticipate collides with his sleep.

The field is now `urgentBecauseHeSaid` — his words, quoted, the same shape
`WHEN.said` already used for time. The general form: **whenever she reports her
own judgement, take the evidence instead of the conclusion.** A conclusion can
only be trusted; evidence can be compared to something.

And half a fix here is worse than none, because it looks finished. The one-liner
that suggests itself in the handler —
`urgent: input.urgentBecauseHeSaid !== undefined` — restores the defect in full,
since a presence check is satisfied by any string at all. Quoting is a safeguard
only while something compares the quote to his message; otherwise it is a longer
way of writing `true`. Match forgivingly on case and punctuation and
unforgivingly on everything else, and let absent, empty and unmatched all mean
*not urgent*: too strict costs a reminder that waits until morning, too lax costs
his house at three, and those are not comparable.

**Some claims cannot be checked against anything, and then the guard is that the
act is audible.** `urgentBecauseHeSaid` works because there is something to
compare the quote to: *did he say this?* is a question about the conversation.
`finish_todo` is bound by the same rule and cannot use the same mechanism — *did
he finish it?* is a claim about the world, and no field she can fill makes it
checkable. A `heSaidSo` string would be a boolean wearing a costume, which is
the exact defect `syl-p8k` closed.

So that guard is shaped differently, and it is three things rather than one:
**read the row before writing**, so a stale or half-remembered id costs a read
and never an item; **refuse an already-finished to-do** rather than reporting an
act she did not perform, since the store's `complete` is idempotent and would
answer happily; and **name the to-do, in his words, on every path**. The last is
the load-bearing one — him hearing the wrong title is the only place a wrong
inference is still catchable, and a verb that answers "done" gives him nothing
to contradict. Generalised: *where evidence cannot be compared, make the
consequence sayable, and say it.*

**A red test that cannot compile is not a declared failure — it is a broken
build with a bead attached.** `tests/expected-failures.json` makes a test's
*failure* legitimate and says nothing about whether the file parses. A declared
test whose import does not resolve fails for a reason the manifest was never
asked about, and reads as tracked work while the build is simply broken. Check
that a red test fails for the reason it is named for, not merely that it is red.

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

**"The platform cannot do X" — believed twice, checked neither time, wrong both
times.** This is now a repeat offender and deserves its own line.

| what we believed | how long it stood | what it cost |
|---|---|---|
| a turn cannot complete with stdin open, so one subprocess per turn | months, and it decided the whole architecture | a 4-7x latency floor on every turn Syl takes |
| Syl cannot send a message under her own name | the length of one epic's planning | an epic designed around an impersonation workaround |

The second was found on 2026-08-11. `POST /api/messages` stamps every message
`from: "user"`, so the obvious integration would have had Syl asking the
treasurer about the Commander's money **in his voice**. That was true, and the
conclusion drawn from it — that she had no identity available — was not: the MCP
path carries one, and a probe came back `from: 'syl'`, `role: 'agent'` on the
first try.

Both share a shape worth naming: **a real observation, generalised into a
capability claim, and never re-tested.** The first was correctly measured and
went stale; the second was correctly measured about the *wrong door*. Neither
was carelessness, and that is the point — the check is cheap and the belief is
load-bearing, so the rule is to spend ten minutes proving a platform limit
before designing around it.

Related, and the same failure from the other side: `maxWorkers: 3` was a
measurement taken on a 20-core machine and committed as a constant, then applied
to a 2-core CI runner. **A measurement is a fact about a time and a place; a
constant is a claim about everywhere.** Writing one down as the other is the
same move as a hard-coded "she cannot act yet".

**I told an agent to redo work that was already pushed, and said I had
"verified it on origin rather than asking".** I had run `git fetch origin -q
2>/dev/null` and then read the ref. Two things were wrong with that sentence.
The fetch's stderr was suppressed and its status never checked, so a fetch that
*failed* would have left me reading a stale ref and reporting it as a fresh
check — indistinguishable from success. And even a fetch that succeeded only
establishes what origin held at that instant, in a repository where three agents
were pushing. The agent had pushed the fix minutes earlier; my "verification"
crossed it.

I still cannot say which of the two it was, and picking the flattering
explanation would be its own version of the same error.

**Reading a shared remote is a measurement, not a fact**, and it decays in
seconds when other people are working. Two rules fall out: never suppress
stderr on the command whose result you are about to rely on, and when
contradicting someone about the state of a shared branch, quote the sha you
read rather than the conclusion you drew — a sha is checkable by the person
you are contradicting, and "I verified on origin" is not.

**A number's meaning drifts from its name every time the code around it gets
stricter, and nothing fails when it does.** Three instances in one day on
`syl-j8fa`: `sessionsTargeted` was online-filtered and zero on an early exit,
so it could report "no sessions" while sessions plainly existed;
`sessionsFound` was documented as "the agent is running" when the registry
also returns *offline* session records; and the same field's description kept
advising "check the name is right" after recipient validation had made a typo
impossible to reach that line. The third was created in the same commit that
made the behaviour stricter — the code got more careful and the sentence
describing it did not.

Nothing caught any of them, because **nothing tests prose against behaviour**.
The description test that existed asserted the field was *mentioned*, which a
wrong sentence satisfies as easily as a right one. The fix that sticks is an
assertion about the *claim* — that the text states what the number does and
does not establish, and that it does not carry the superseded advice — and it
must be checked against the previous string to prove it is not vacuous.

**When a change makes a guarantee stricter, every string describing the old
guarantee is inside that change's blast radius.** Comments, tool descriptions
and error text are the parts a model reads, and they are the parts no test
covers by default.


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

### A concurrent agent's commit silently wiped an in-progress merge (2026-08-11)

I merged `syl-ryp.4` (wander), hit two additive conflicts in `PreparedSky.swift`,
resolved them, and built. Between the build and the test run another agent
working in this repo committed its own planning change — and the tree came back
to `HEAD` with **the merge gone**: no `MERGE_HEAD`, `git status` clean, and none
of wander's symbols anywhere on disk.

The dangerous part is that **the test suite still passed.** 705 tests, zero
failures, against a tree that no longer contained the feature I believed I was
testing. Nothing was red. The count was the only witness — the squad had said
762, I got 705, and that gap is the entire reason this was caught rather than
shipped as "wander is merged and green".

Two rules out of it:

1. **Commit a merge before doing anything slow with it.** A resolved-but-
   uncommitted merge is the most fragile state in a repo shared with other
   agents, and the window here was one build.
2. **A test count is evidence and a pass is not.** "Zero failures" cannot
   distinguish *the feature works* from *the feature is absent*. When a squad
   reports a number, check the number.

This is the same family as everything in the "consistency is not correspondence"
entry, with a new source: the tree itself moved. Every check agreed with every
other check, and none of them agreed with the branch.

### Blind additive conflict resolution produces plausible garbage (2026-08-11)

Resolving the same conflicts a second time, I scripted it: keep ours, then
theirs, drop the markers. Both hunks were genuinely additive, so this was
"right" — and it emitted a `PreparedSky(...)` call with a stray closing paren
followed by another argument, which is not a merge error but a *syntax* error.
Swift caught it instantly, which is the only reason it cost a minute.

The lesson is not "don't script it". It is that **an additive resolve is safe
for declarations and unsafe for call sites**: two branches adding a field each
to the same initialiser produce two complete calls, and concatenating them is
never what you want. Resolve declarations by union, and call sites by hand.

### The sky chased a third of a point (2026-08-11)

*"Whenever I click on a node, the screen starts kind of zooming in and moving up on its
own and is hard to stop."*

`ConstellationViewModel.resize(to:)` guarded with `size != preparedFor` — exact `CGSize`
equality. The card's arrival perturbs the geometry by a fraction of a point, that counted
as a new screen, and **the sky's layout is a function of its size**, so every star was
placed again. Which closed a ring: a re-laid sky has a new `size`, which sets
`ConstellationBand.tallestCard(in:)`, which decides what the card fits into, which
perturbs the geometry — back to the start. The whole field slowly scaling and sliding,
with no gesture that could catch it.

**Every line in that ring is correct on its own**, which is why nothing caught it: the
resize guard, the band, the card's fitting, the reveal — each is right, and each test of
each one passes. The defect exists only in the cycle. A unit test per component cannot
see it, and the test that does had to be about *stillness* rather than about any one
function's output: read at a size, wobble it by tenths of a point, assert the sky does
not move.

Two rules:

1. **Compare geometry with a tolerance, never with `==`.** A point is the threshold,
   because below it nothing on screen can change, so there is nothing to compute. Exact
   float equality on a measured value is a promise no layout system makes.
2. **When a value both derives from layout and feeds back into it, that ring is the
   feature's real risk surface** — write the test that runs it round.

Worth noting what the diagnosis cost: I read the pan maths three times looking for a
compounding zoom, because "zooming" sounds like a scale bug. Nothing in the transform
touched scale. The zoom was the *layout* rescaling, and the symptom named the wrong
subsystem — I found it by testing the invariant he described (**the sky should be still**)
rather than by hunting the mechanism he guessed at.

### A green TestFlight run that shipped nothing, again (2026-08-11)

Build 17 carried the fix for a bug the Commander was actively hitting. The workflow ran,
reported success, and **uploaded nothing.**

The gate compared `MARKETING_VERSION` against `HEAD~1`. The bump landed in one commit and
reached `main` inside a merge, so `HEAD~1` was the branch being merged — which already
carried 0.9.6. Current equalled previous, the job went green, and no build existed.

`HEAD~1` is not a meaningful question. It is a different commit depending on whether the
tip is a merge, a squash, a revert or a rebase, and on which side of a merge git calls the
first parent. The question with one true answer is *is this build already on TestFlight?*,
and the gate now answers exactly that by checking for a `testflight/<build>` tag pushed
**after** a successful upload. Immune to merges, re-runs, reordering, and to another agent
committing in between. `testflight/16` was backfilled so the record starts honest.

Note which way each design fails. The tag gate fails toward a **duplicate upload**, which
App Store Connect rejects loudly and which costs runner minutes. The old gate failed
toward **silence**, which costs a release nobody knows is missing. Given a check that
cannot be perfect, choose the noisy failure — and this is the third entry in this file
where the defect was something reporting green while doing nothing, which is now the
project's single most common failure shape.

**And the reason it was caught at all**: the Commander asked *"merged and pushed with a new
version for a new app release?"* — a question about the outcome, not about my actions. I
had said "pushed as 0.9.6" and that was true and irrelevant. Verifying the outcome he
asked about took one log read. **Report what shipped, not what you did.**

**Postscript, same day.** The new gate's first live run uploaded build 17 successfully and
then failed `403` pushing its own tag — the default `GITHUB_TOKEN` is read-only, so the
job needs `permissions: contents: write`. Fixed, and the tag backfilled by hand.

It is worth being clear about what that failure demonstrated. **The design worked.** A
missing tag means the next push re-uploads and App Store Connect rejects a duplicate
build: loud, harmless, obvious. The old gate's equivalent slip lost a release in silence.
When choosing where a check is allowed to break, choose the side that makes noise.

### The sky grew fifty-two points a pass, and everything he reported followed from it (2026-08-11)

> *"If I tap the base node I get the memory to pop up. But if I tap another node, no memory
> pops up and the whole thing starts zooming in without end."*

Three symptoms, one cause, and the cause is a layout ring with a **gain of exactly one**.

`ConstellationView` measured its own size with a `GeometryReader` **inside** its `ZStack` —
which is a measurement of the stack, not of the screen. The card was a member of that stack
and reserved its band with `.padding(.top, sky.size.height − tallestCard(sky.size))`. So:
the card's height derived from the sky's height, the stack grew by the difference, the reader
reported the larger number, the sky was laid out for it, and the band grew again. Measured
through real SwiftUI layout in a real window: **852 → 904 → 956 → 1008 → 1060 → 1112 → 1164**,
+52 every pass, no bound.

`ConstellationLayout`'s field is `(height − insets) / 2`, so the whole star field spread as
the number grew. **That is what "zooming in without end" was** — not the transform.
`maximumScale` is 4 and the sky he photographed was spread about ten times, which is the
arithmetic that rules the transform out and it was available before any code was read.

And the missed taps are the same fault, not a second one. The drawing and the hit test both
read one `PreparedSky`, so they cannot disagree about where a star is; what they can both be
is wrong about where it was a second ago. Measured on the original code: **opening one card
moves stars 60 to 193 points on the first pass.** A finger is 22. So the first tap of a
session lands and every tap after it arrives where the star used to be — exactly "the base
node works and nothing else does".

Three rules out of it:

1. **Measure the screen at the root, never inside the stack.** A `GeometryReader` reports the
   size it was *proposed*, so a reader at the root of a screen is a measurement of the glass
   and nothing drawn inside it can move the number. One rung below that it is a measurement of
   its own siblings.
2. **A card is drawn over the sky, not added to it.** It is an `.overlay` now, which is
   proposed its host's size and cannot change it — the ring is impossible rather than merely
   unlikely.
3. **"It converges" is not the property you want.** The first fix attempt had a gain of ½ and
   settled — at 1045 points on an 852-point screen, with the field spread off every edge. The
   assertion that catches that is *the sky is laid out for the size of the screen*, not *the
   sky stops changing*.

Note the relationship to the entry above it. That one fixed a ring driven by a **third of a
point** and added a 1pt tolerance to `resize(to:)`. This ring steps 52 points at a time, so
the tolerance never had a chance — and the tolerance was still right. **A guard sized for
jitter is not a defence against feedback.** Fixing the small ring made the big one the only
one left, which is why it surfaced looking like a regression.

#### And the sky had never been told about the tab bar

The two remaining things he could see were the same omission from both sides.
`ConstellationLayout` inset the field by 104 and 72 — measured against a navigation bar and a
home indicator, before this screen was in a tab bar. A tab bar takes 83, so the lowest star in
the field was drawn under it. `ConstellationBand.cardTop` had the mirror image: it put the
card's top edge at `size.height − cardHeight − step`, measuring from the bottom of the
**glass**, while the card sits above the **tab bar** — 83 points higher. So the sky panned a
selection to a line it believed was clear and the card came up over it.

Both are now one `ConstellationChrome` carried **on the sky**, so the layout that placed the
stars and the arithmetic that decides where the card's edge falls cannot answer differently.

**The render harness had no bars in it, which is why no image ever showed either defect.** It
has them now — `safeAreaInset` for the real geometry, and translucent fills drawn on top so a
human can see what is covered. An offscreen render of a pleasanter rectangle than the one he
is holding is a consistency check.

#### One more, from the same screenshot

His graph hangs entirely off a single `source` node, *"Conversation with the Commander"*,
which asserts everything — including itself. Its card read the title and then *"Conversation
with the Commander said so."* **A thing is not its own evidence.** `ConstellationWords`
compares the asserter to the star's own label and says what the node *is* instead. Compared by
label rather than by kind, so a source something else genuinely cited still says so.

#### The fixture was the whole reason none of this was caught

Everything this feature was accepted on was looked at through `ConstellationSnapshot.fixture`:
seven anchors, real entity-to-entity edges, six clusters. **His graph has none of that.** 33
nodes and 32 edges, every edge `stated`/`observed` from the one source node — a hub and
spokes, with nothing relating to anything else, and therefore `anchorId: nil` on every star
and no clusters at all. `ConstellationSnapshot.hubAndSpokes` is that shape, measured off
`~/.syl/syl.db`, and every render and every new test runs against it.

This is the standing fixture rule — *build fixtures from captured reality, never from our own
types* — arriving on a screen rather than on a wire format. A fixture that is prettier than
production is a consistency check with good art direction.

### The build number in the project file is not the build number that ships (2026-08-11)

The gate I had just rewritten to key on `CURRENT_PROJECT_VERSION` shipped 0.9.7 and then
logged **"Tagged build 24 as uploaded"** for a commit whose project file said **18**.

`fastlane beta` calls `increment_build_number(latest_testflight_build_number + 1)`. App
Store Connect's own counter decides the build number; the repository's copy is read by
nobody. So every "bump the build number" commit in this project's history was theatre —
the *marketing version* is the only part of that ritual that does anything.

The tag was therefore keyed on a value the gate could never look up again: next push
reads 18 from the project, finds no `testflight/18`, and ships — restoring the
build-per-commit the job exists to avoid, on a 10x-billed runner. Now keyed on
`MARKETING_VERSION` as `testflight/v0.9.7`, which is what the repository actually
controls and what "a build per version bump" always meant. Tags backfilled for v0.9.5,
v0.9.6 and v0.9.7; the three build-numbered ones deleted so there is one scheme.

**Three consecutive fixes to this one gate in one morning, each revealing the next.** The
`HEAD~1` comparison dropped a release silently; its replacement could not push its own tag
(`403`, read-only token); and that fixed version tagged the wrong identifier. Every one of
them was found by reading the run log rather than the conclusion — and the conclusion was
**green** for the first and third. The rule this file keeps re-learning: *a workflow's
exit status tells you it finished, not that it did the thing.*

There is a happier reading, though. Each failure was louder than the one before: silence,
then a red step, then a wrong-looking string in a log. That is what designing the failure
direction buys — the bugs got easier to see even as they got subtler.

### "It never parses" — the chat freeze of 2026-08-11

`MarkdownView`'s doc comment said **"It never parses"**. `MarkdownInline.render`
did a full `AttributedString(markdown:)` parse plus three passes over the runs,
from inside a `body`, for every paragraph, every heading, every list row *twice*
(the VoiceOver label parses again) and every table cell.

Three multipliers stacked on it: `ChatView.body` re-runs on every keystroke and
every presence frame; `.defaultScrollAnchor(.bottom)` needs the total content
height, so the `LazyVStack` sizes **every** row in the 200-message window rather
than the visible ones; and an arriving reply invalidates the lot. A main thread
that stops answering long enough is a watchdog kill, which is what he saw.

> **The middle clause is version-stale and was measured false on 2026-08-14.**
> On iOS 26.2 the bottom anchor builds a *bounded* region of about forty rows
> regardless of window size — it does not size every row. The claim was very
> likely true when written and is not true now. It sat here for three days and
> was repeated into a spec and to the Commander before anyone re-ran it. Left in
> place rather than edited away, because the interesting part is that it was
> plausible, load-bearing and wrong. See *"The runaway that wasn't"* below.

**The two previous fixes to this same symptom both guessed wrong** —
`ChatSnapshotLoader` moved *block* scanning off the main actor, and `blocksByGroup`
killed a quadratic compare. Inline parsing was in neither, and the file went on
claiming it never parsed. A comment agreeing with the code while neither agrees
with the profiler: consistency, not correspondence, in the most literal form yet.

Three further corrections came out of it, and every one of them was mine:

1. **It was never frozen permanently.** The conversation continues in the
   database past the moment I called the freeze — a watchdog kill and relaunch,
   not a deadlock. My evidence was a snapshot that had already moved on, and I
   read a stale row as a stuck system.
2. **My single-owner-stream hypothesis was wrong.** One pump fans every event to
   both models; neither can starve the other. I had reasoned from the symptom to
   an architecture that does not exist.
3. **`-scheme Syl` does not run SylKit.** Every "the suite is green" in this
   session counted 795 of 1094 tests. The count-checking rule I had just written
   down was itself measuring the wrong thing — a habit built to catch this exact
   failure, blind in one eye.

And a mutation that survived is worth recording: a faithfulness test compared the
memo against a fresh parse, so corrupting both produced two wrong answers that
agreed. **A correspondence check between two things that share an implementation
is a consistency check.** Only breaking it on purpose showed that.

### An empty grep is the most confident-looking wrong answer available (2026-08-11)

Asked whether `show_him` notifies him, I searched the sending route and service
for `push`, `notif`, `apns`. **Zero matches in both files.** One message away
from reporting that From Syl delivers videos in silence — a broken flagship
feature, and one that fit his oldest open complaint about a reminder that never
buzzed, which is what made it feel confirmed rather than merely found.

The mechanism is called **`outbox`**. `sending-service.ts` enqueues an APNS
notification with her sentence as the body, keyed on the sending id, and the
file contains the word "push" nowhere.

**A search proves something about your vocabulary, never about the system's.**
This is worse than a stale measurement, because every other kind of wrong answer
hands you something to be suspicious of: a bad number still looks like a number,
a bad diagnosis has an argument you can attack. **Nothing looks like certainty.**

The remedy is not a longer list of synonyms. **Verify the positive** — find
where a notification *is* sent and see whether this path reaches it. A negative
about behaviour cannot be established by failing to find a string.

### A comment is not a mechanism (2026-08-11)

`REACHES_HIM` decides which verbs count as reaching him, and bounds
`SENDINGS_PER_DAY`. Its own comment said, in as many words, *"when the sending
verb lands it belongs in here."* The verb landed as `show_him`. Nobody added it.

So every hour in which she sent him a video was recorded as **an hour that
reached nobody**, the allowance was never spent, and twenty-four a day was
permitted by the code. **Thirty-six heartbeat tests passed over it**, because
they assert the list matches itself — a tautology in test form, which is the
shape a test takes when it is written from the implementation.

**If the next change must update something, a test has to fail when it doesn't.**
A note addressed to a future reader is a hope, not a constraint.

The repair generalises past this constant, and `AGENT_SURFACE` is the worked
example: its refusal sentence used to be written *beside* the list, so widening
the list would have had her claiming she cannot do the thing she had just been
given. Deriving the sentence from the list closed that — and within the hour the
derivation exposed a second defect that could not have existed before, since
entries are spliced into one sentence and **a `says` may not contain a comma**.
A hand-written sentence never had to survive being joined to anything.

**A commit inside a branch is a waypoint, not a destination.** The same day, a
false alarm about the context budget was diagnosed as reading two constants from
two branches, with the remedy *"take both from one `git show <branch>:<file>`"*.
That diagnosis was wrong: both reads came from one ref, correctly. The ref was 26
commits behind the tip, and genuinely did raise working memory without the
ceiling — the ceiling moved later. **The proposed remedy would have passed the
real failure straight through**, which makes it worse than none: a rule that
looks right and does not fire ends the investigation. Measure the tip of what
will actually merge.

The same shape governs migration numbers, where checking origin is necessary and
not sufficient: origin says which number is *free*, and nothing about which
numbers *your branch can hold*. A branch that is behind cannot satisfy
contiguity at the number origin calls free. Two questions, and only one of them
was being asked.

### An ellipse around a rectangle is not the rectangle plus a margin (2026-08-11)

The Commander replaced the home waveform with *"a circular ribbon of light that
orbits around the message"*. The obvious geometry — `a = halfWidth + margin` —
survives one short phrase by luck. At `accessibility5` the phrase's box is nearly
square, the smallest ellipse enclosing a square is √2 larger in **both**
directions, and the first render came back **437 points tall on an 852-point
screen**, straight across her face.

The fix is the observation that the phrase is not a box: it is three centred
lines whose box corners are *empty*. Solving against the lines is what makes the
large type sizes possible at all. That was found by looking at a picture, not by
reasoning — and it is the clearest example yet of why renders are this feature's
acceptance check rather than a supplement to it.

Two more that only a picture could have caught:

- **Overlapping segments do not blend under `plusLighter`, they add.** Tail
  segments overlapping by 50% made every junction twice as bright: the comet
  rendered as a row of beads — a dashed arc going round a circle, the one
  silhouette this component may never have.
- **The light appearance needed the opposite instruction, not a weaker one.**
  `SylRibbon`'s rule is that the hot filament is always `plusLighter`. Her core
  resolves to white, and white *added* to a pale daylight painting is nothing —
  the day render had a beautiful tail with no source on the end of it. The head
  is now laid down as pigment. Same principle about contrast, inverted.

And the design rule underneath the Commander's instinct, worth keeping: **the
waveform is chat's grammar** — a line of speech under the last message, the shape
of something being *said*. Home has no transcript, so the same shape there merely
crosses the picture. A ring is a halo rather than an utterance: it encloses
instead of dividing, and light travelling a closed path reads as attention
circling a thought. He saw that it was wrong before anyone could say why.

### A success signal that is not downstream of the effect (2026-08-11)

Two of these landed within an hour, in different hands, and they are one bug.

A push was confirmed with `git push -q …; echo "pushed: $(git log --oneline -1)"`.
The push **failed** on a divergent branch; the echo printed the local HEAD, which
is always there. A restore was done with `cp`, which hit an interactive overwrite
prompt — **in a non-interactive shell that defaults to NO**, so the file was never
restored and the exit code meant only *"I asked"*.

**Neither success message was capable of reporting failure.** One was composed
from local state, the other from an exit code that did not describe the effect.
The rule: **confirm the thing you actually wanted, from the side that would know.**
For a push that is `git merge-base --is-ancestor HEAD origin/<branch>`; for a copy
it is reading the destination. A check that cannot fail is decoration.

### A stale test is worse than a stale comment (2026-08-11)

Raising `DEFAULT_CONTEXT_BUDGET_BYTES` to 72,000 silently disarmed the test that
proves the budget guard fires. It asked for **40,000 of overage** — enough to
break the 24,000 ceiling it was written against, not enough to break 72,000. It
kept passing, so nothing anywhere said the guard was now unprotected. The overage
is derived from the ceiling now.

This is the same family as a comment that asks the next person to update it, but
it is worse in one specific way: **the test is the mechanism we rely on to tell
us when something else has gone stale.** When it goes stale it does not merely
fail to help, it actively reports that all is well — and it reports it in the
one place designed to be trusted without re-derivation.

A constant inside a test that is a function of production code must be **derived
from that code**, never restated. If a test asserts "this breaks when X exceeds
the limit", the number it uses to exceed the limit has to come from the limit.

### The sixth face: a prescription in a brief (2026-08-11)

Five entries above are measurements or claims going stale. This one is an
*instruction*, and it is the most dangerous of the set.

Syl diagnosed her own memory correctly — *"nothing compares a new memory to what
is already there"* — and the obvious cure was written into an agent's brief:
compare a candidate against existing nodes before minting one. The agent read
`supersede.ts` and refused, correctly. That file already records that **aggressive
near-duplicate merging collapses accuracy from 0.82 to 0.62**, and that *"bounded
growth is a consequence of supersession, never a goal pursued by compression."*

The instruction was a documented way to make her memory worse. It came from a
real symptom and reached for the obvious remedy without checking whether the
remedy was already known to be poison.

**The part worth keeping past this incident**: a contradiction is on average
*more* cosine-similar to a fact than a genuine duplicate is. *"He lives in Buda"*
and *"He moved to Nashville"* are near neighbours in embedding space. Merging on
similarity destroys exactly what his memory exists to hold, and it would have
looked like tidying. The resolution: **`duplicates()` nominates, `merge()` acts.**
Nominating on a threshold is safe; acting on one is what the 0.82 -> 0.62 number
measures. The write side stays deterministic — normalise the label, no threshold.

**Why a brief is the worst place for a wrong claim.** Every other artefact gets
re-derived by somebody. A brief does not, because it comes from the person who is
supposed to hold the context, and a competent agent reads it as settled. Two
practices follow, and they cost nothing:

- **Mark each claim in a brief with its evidence status** — what was measured,
  what is believed, what must be confirmed before it is built on. "I checked this,
  do not repeat it" and "I believe this, confirm it first" are different sentences
  and an agent will act on them differently.
- **An agent that reads the subsystem and pushes back is doing the job.** Both
  times it happened today the brief was wrong and the pushback was right.

### A schema object restored by NAME is not a schema object restored (2026-08-11)

`syl-017.2` needed one more value in `memory_nodes.kind`'s `CHECK`. SQLite has no
`ALTER TABLE ... DROP CONSTRAINT`, so that is a table rebuild — four indexes and
four triggers dropped with the table and re-created after it. Two things went
wrong, and the pair of them is the entry.

**1. The rebuild recipe SQLite documents does not work here, and the escape
everyone reaches for is a myth.** The documented recipe needs
`PRAGMA foreign_keys = OFF`, which is a no-op inside a transaction, and
`applyMigrations` wraps every migration in `BEGIN IMMEDIATE` — correctly, so a
half-applied schema is impossible. The usual answer is `PRAGMA
legacy_alter_table = ON`, on the belief that it stops `ALTER TABLE ... RENAME`
rewriting other tables' `REFERENCES` clauses. **It does not.** Measured on
22.23.1 / SQLite 3.51.3: with foreign keys on, the rename fixes up references
whatever that pragma says. Six references would have followed `memory_nodes`
onto a scratch table and stayed there, and nothing fails until the next write —
somewhere else entirely.

What does work is never renaming anything: copy the rows aside, `DROP TABLE
memory_nodes`, re-create it under the same name, copy the rows back. Two SQLite
behaviours make it safe and both had to be measured rather than assumed —
`DROP TABLE`'s implicit `DELETE FROM` fires no triggers (so the FTS index
survives), and `PRAGMA defer_foreign_keys` works inside a transaction where
`foreign_keys = OFF` does not. **And the ordering is load-bearing in a way that
is invisible: the deferred violation counter is decremented by inserts into the
table the references NAME.** Copying into a scratch table and renaming it
afterwards puts identical rows in an identically-named table and still fails at
the commit. That was the first attempt.

**2. The index came back with the right name and the wrong predicate.**
`memory_nodes_handle_idx` is `UNIQUE (subject_id, kind) WHERE subject_id IS NOT
NULL AND kind IN ('goal', 'source')`, and the partial clause is the whole point
— `0019` spends a paragraph on it, because a unique index over `memory`, `fact`
and `event` would forbid the graph from knowing two things about one goal.
Re-creating it, I dropped the `kind IN (...)`. Right name, right table, right
columns, and a silent new law.

The test I had written asserted the NAMES of the restored indexes and triggers,
and it passed. What caught it was an unrelated test three files away —
`projectInto should leave room for the graph to know many things about one row`.

So: **when a migration re-creates schema objects, diff the DEFINITIONS across the
migration, not the names.** It is four lines against `sqlite_schema.sql` on a
database migrated to `N-1` and one migrated to `N`, it is exactly the assertion
"this migration changed nothing it did not mean to change", and nothing can
satisfy it by accident. The name-list version is the same shape of mistake as a
comment claiming an invariant: it describes the object without checking it.

### `git commit` with an explicit pathspec finishes a merge somebody else started (2026-08-11)

CLAUDE.md warns about `git add -A` in a shared worktree, because a bare add
takes other people's work under your message. This is the sibling, and the
pathspec is no defence against it: **if a merge is in progress, `git commit`
completes it, whatever paths you name.** The result is a merge commit with two
parents, your subject line, and somebody else's conflict resolutions inside it.

It happened here. `3161d22` reads as a one-file test fix and is a merge of
`origin/main` into the branch. The fix is not more care about pathspecs — it is
one more thing to look at:

> **In a shared checkout, read `git status` for `MERGE_HEAD` before committing,
> not only for files you did not stage.** `git rev-parse -q --verify MERGE_HEAD`
> answers it in one line.

Two things went right afterwards and both are worth copying.

**Amend the message rather than let the commit lie.** The tree and the parents
were correct; only the subject was wrong, and a merge commit describing itself
as a test fix is a trap for whoever bisects it later.

**There is a cheap, exact check for what a merge silently dropped**, and it is
better than reading the diff. For each file changed on BOTH sides of the merge
base, compare the merge result's blob against each parent's:

```sh
for f in $(comm -12 <(git diff --name-only $BASE $A|sort) <(git diff --name-only $BASE $B|sort)); do
  ...  # merge blob == A's  -> took ours, theirs dropped
       # merge blob == B's  -> took theirs, ours dropped
       # neither            -> genuinely combined
done
```

Identical to one parent is the signature of a resolution that took a side
wholesale, which is exactly the loss no test can see. It found one here — two
agents had independently created `backend/tests/unit/memory-relations.test.ts`,
the merge kept origin's, and twenty-one passing tests stopped existing with the
gate still green. **A file path is a shared namespace, and so is an export
name**; the migration-number rule applies to both, and neither had been checked
against origin.

And the correction, because I reported it worse than it was before checking:
the second parent was **already `origin/main`'s tip**. `git merge-base
--is-ancestor <parent> origin/main` is the one command that separates "I
captured somebody's unpublished work" from "I completed a routine integration",
and I sent two messages before running it. A commit's SUBJECT names the branch
it was made on, not where it lives now — `aeb2559` says "into agent/fenix" and
is plain shared history.

### The escape hatch must be as honest as the judgement (2026-08-11)

Reconciling two relation vocabularies exposed a gap neither half had. The
dream needed a fallback for *"these are connected and nothing more precise is
warranted"*, and the obvious candidate was `about`. **But `about` is
directional** — a claim is about a person, not the reverse — so using it as the
escape would have asserted a direction nobody had claimed.

That is the same defect as guessing an edge's direction, arriving through the
**fallback** rather than through the judgement, where nobody was looking for it.
`resembles` was added as an explicitly *symmetric* escape, distinct from
`about`. **A vague answer must be vague in the same shape as the uncertainty**;
one that quietly carries a claim is worse than the precise answer it replaced,
because it looks like caution.

`parent_of` pointing the wrong way is not a vaguer answer. It is a false one
wearing a true one's clothes.

### The instinct to loosen a guard when it fires IS the guard working (2026-08-11)

A new test forbidding a second relation vocabulary failed on its first run
against `entities.ts`, which names four relations in a lookup table. The first
impulse was to loosen the threshold until it passed.

**That is how a guard stops guarding**, and this codebase watched it happen the
same afternoon: a flat 2,000-byte margin, correct when written, became
meaningless as the ceiling it protected grew — and nothing had to be edited for
it to stop protecting anything.

The false positive was worth more than the guard, because it forced the property
to be stated precisely instead of approximately: **a module may NAME relations
if it IMPORTS the type that constrains them; a module that names them while
importing nothing from the vocabulary is declaring its own.** `entities.ts` is a
consumer — its values are typed, so an invented name is already a compile error.

When a guard fires on something that looks legitimate, the answer is almost
never a wider threshold. It is that the guard is testing a proxy for the
property you actually care about, and the firing has just told you what the real
property is.

### A conflict marker says two people wrote here, not what you are deleting (2026-08-11)

An add/add conflict on a test file was resolved by taking one side wholesale.
**21 passing tests stopped existing, and every check afterwards was green** —
because a test that no longer exists cannot fail. They were recovered verbatim,
but nothing in the toolchain would have said so.

The screen, which costs one command: **compare the merge result's blob against
EACH parent's. Identical to one parent is the signature of a side taken
wholesale.**

    git rev-parse "$merge:$file" "$merge^1:$file" "$merge^2:$file"

**It is a screen, not a verdict.** Run against another of the same day's merges
it fired correctly — the result was byte-identical to parent 1 — and the file
was fine: both sides carried the same 44 tests and differed only inside the
conflicting hunks. So the second step is what turns the signal into an answer:
**list what the discarded side contained that the result does not.** For tests,
the `it(...)` names; for a module, the exported symbols.

The habit that fails here is subtle, because it does not feel like carelessness:
you read both sides, you understand both, you judge one correct, and you take
it. What is never asked is what the *other* side had that the survivor lacks —
and a conflict marker cannot prompt that question, because it marks where the
text disagrees, not where content only exists once.

The generalisation is larger than merges: **a file path is a shared namespace,
and so is an export name.** `INFERRED_RELATIONS` was exported from two modules
for one database column, and the migration-number discipline — check ORIGIN, not
your branch — applies to both, unchecked by anyone for a day.

### Absence is not a comparison (2026-08-11)

Two people independently automated the merge-loss check above. **Both scripts
reported a confident all-clear on a loss constructed by hand**, for two different
reasons, and the second one is the lesson.

    cause 1   `git diff-tree` on a merge lists NO files by default, so the loop
              iterated an empty set. The detector ate its own input.
    cause 2   when a file is absent from the result, `git rev-parse "$m:$f"`
              FAILS — and both scripts caught that and `continue`d. **The
              loudest possible finding, "the file is gone entirely", was read as
              "nothing to compare here, move on."**

Cause 1 discards the input; cause 2 discards the answer. Same output either way:
a clean run nobody has reason to doubt.

**The word doing the damage is "compare".** Both detectors were built to compare
two versions of a thing, and neither handled one version not existing — because
absence is not a comparison, and nothing about the framing prompts the question.
The positive case to construct is therefore not *"a file differs"* but *"a file
is absent"*, and `git merge -s ours` builds it in four commands.

Two more things the corrected run established, over thirty merges:

- **729 wholesale takes.** The screen alone is not merely noisy, it is unusable —
  and no amount of discipline survives a signal at that volume. Only step 2
  makes it an answer.
- **Four files vanished, none lost** — three renumbered migrations and a spec
  directory renamed. Verified by BLOB hash across HEAD, not by path, because
  **a rename and a deletion are identical to a path-based check.**

The procedure that survives, by hand:

    screen    git diff --name-only m^1 m^2      (never diff-tree)
    absent    result blob missing while a parent has it -> the finding, not a skip
    rename    resolve by blob across HEAD before calling anything lost
    answer    discarded side's it(...) titles or exports, minus the result's

**Automate it when someone can watch it fail first.** Both of us would have
committed a decoration on the strength of a true negative.

## You cannot check a claim with an instrument that can only say yes

This is the heading the entries above hang under. Every one of them is a
member, and naming the property rather than the symptom is what makes it
usable in advance instead of only in hindsight.

An instrument that can only say yes:

    grep returning nothing            proves your vocabulary, not the system
    `cmd | tail -3; echo $?`          reports tail's status, never cmd's
    `echo "pushed: $(git log -1)"`    prints local HEAD, which is always there
    `cp` hitting an interactive prompt exits 0 meaning "I asked"
    a checker reading a fixed path    grades whatever file is on disk
    a detector only ever seen quiet   has demonstrated nothing
    a count matched against a count   agrees while the sets differ

**Care does not protect against this, and that is the whole difficulty.** A
careful person reaching for a verification step reaches for one that reads
clearly — and reading clearly is a different property from being able to say no.
Every instance in this file was produced by someone being deliberate.

The direction of failure is incidental. The same stale-tree `grep` that would
have reported a false all-clear nearly produced a false *alarm* an hour later:
it cannot say "your tree is behind", only "not found". A one-way instrument is
equally wrong in both directions; it simply cannot be wrong *out loud*.

**The remedy is always the same shape: ask the question from the side that would
know, and confirm the instrument can fail before believing it is quiet.** For a
push, `git merge-base --is-ancestor HEAD origin/<branch>`. For a copy, read the
destination. For a guard, break it on purpose and watch it go red. For a
negative about behaviour, find where the behaviour IS and see whether this path
reaches it.

### Two corollaries earned the same night

**Removing a fence is a change whose blast radius is invisible in the diff.**
A semicolon was replaced with `&&` in the test gate. The diff was two characters
and read as a tightening; it was reviewed and endorsed on exactly that basis.
The semicolon was load-bearing — this gate is `failures == declared`, so vitest
exits non-zero on *every healthy run*, and `&&` short-circuited the checker that
turns a non-zero exit into a pass. **The diff shows what the fence looked like,
never what walked past it.** The reason was written down, in the file the
reviewer had quoted to four agents that day.

**Fix the change, not the occurrence.** The same edit had touched two scripts.
The first correction repaired only the one under discussion, and CI stayed red
one line lower. A `grep` for the pattern would have found both in a second and
was never run — because the attention was on the script that broke rather than
on the *change* that had been made. Three corrections on one two-character edit,
each one narrowly correct: **the thing you have just been thinking about is not
the same set as the thing you have altered.**

### A door that demands a value, and a floor that drops it (2026-08-13)

Three instances, found only because one person happened to be in the same
subsystem twice:

    syl-y82    `remind_me` REQUIRED a `because` and discarded it
    syl-018    `remember` COMPUTED `created` and the layer above discarded it
    syl-1ozc   `remember` REQUIRES a `because` and discards it whenever the
               memory names nobody

**The value is produced correctly and dropped by the layer that should carry
it**, and in two of the three the caller is told nothing is wrong.

This is not the confident-wrong-answer family above; it is its inverse. There
the instrument could only say yes. Here the instrument says *"this is
required, and here is why it matters"* — and then throws the answer away.

**The emphatic door is what makes it worse.** `remember` refuses a memory with
no `because` and explains that the reason *"is what lets him tell a good read
of him from a wrong one."* It then discards that reason for exactly the
memories least likely to have an anchor. Nobody was careless: `reasoning` is
stored on an inferred edge, a memory naming nobody has no edges, so the value
has nowhere to live. **The demand was designed and the storage was not.**

The generalisation worth carrying: **when a field is required at an entry
point, something must assert it is READABLE at the exit.** A required field
with no read path is a promise the system cannot keep, and it fails silently
because the write succeeded. Ask of every new required argument: *who reads
this back, and what test fails if nobody can?*

A related trap in the fix: `syl-1ozc`'s test asserts the reasoning is on an
**edge**, while its own comment says *"on an edge, on the node, anywhere a
reader can reach it."* If the answer turns out to be a column, **the test must
be rewritten to match the decision** rather than the decision bent to match the
test — otherwise a graph design gets made by accident, to unblock a red test.

### "It is in" — a commit that landed locally, reported as one that arrived (2026-08-13)

An agent finished `syl-024.4`, committed it to `agent/tassadar`, and told the
channel the work **was in**. It was not. Six commits sat unpushed behind that
sentence, and `origin/main` had never seen any of them. artanis checked instead
of taking it — `git merge-base --is-ancestor dda8a88 origin/main` → NO — and
said so rather than assuming the claim was loose wording.

**This is §8's shape, and the instrument is `git log`.** Ask it whether the work
exists and it says yes, truthfully, about a tree only this machine can see. It
has no way to answer the question that was actually being asked, which is
*"can anyone else get this?"* — and it does not know that is the question.

It is also `syl-018` wearing different clothes, on the same day, and nobody
noticed the rhyme until afterwards. There, Syl was told a memory was **saved**
when the node had been reused and nothing was written. Here, a room was told a
commit had **landed** when it had been committed and not pushed. Both are a
write that succeeded locally, reported as a write that arrived. Both are
believed because the local half genuinely worked.

**The check is one command and it is not `git log`:**

    git merge-base --is-ancestor <sha> origin/main   # exit 0 means it really is in
    git rev-list --count origin/main..HEAD           # how many commits are not

**Say where it is, not that it is done.** "Committed on `agent/tassadar`,
unpushed" is a complete and useful sentence. "It is in" is a claim about a
place, and the place is the part nobody verifies.

The correction cost one message because somebody checked. Uncaught, the next
agent branches from `origin/main`, does not find the work, and rebuilds it —
which is how the same feature gets written twice and the second one wins.

### A cap chosen without a stopwatch, and the two seconds that were not in the database (2026-08-14)

`how_has_he_been` took **8.675 seconds** on his real store — 61,030 samples,
fourteen types — for a verb Syl calls *mid-conversation*. `SUMMARY_SERIES_LIMIT`
had been set to 20,000 rows per type without anyone timing what honouring it
cost, and the diagnosis everybody reached for followed from the number in the
code: too many rows, so read fewer.

**The rows were not the problem, and measuring said so in one line.** Against a
corpus his size:

    store.series()   77ms   for 36,485 rows
    derive()       3,034ms
      of which dayOf() alone   2,442ms

`dayOf` constructs an `Intl.DateTimeFormat` — which resolves a locale and loads
the zone's transition table — **once per sample**. Nothing at the call site
suggests it costs anything; it reads as a formatting call. Caching the formatter
per zone took the whole path from 3,255ms to ~150ms, and the database was never
involved.

The architectural fix (bucket the days in SQL, hand `derive()` ~37 rows per type
instead of 20,000) is still right and still landed — it takes it to ~72ms and,
more to the point, makes the cost scale with the **window** rather than with his
history, so it does not come back in year three. But it is worth being exact
about which half did what, because "we made it read fewer rows" would have been
a true sentence attached to a false explanation, and the same `Intl` call sits
on the nightly review's path too.

**Two lessons, and the second is the one that generalises.** A load-bearing
constant needs a stopwatch — that is the one the epic was written around. The
other is that a profile disagreed with every plausible story about the code, and
the profile was right: the cost was in a call that looks free, not in the one
that looks expensive.

### SQLite's `sum()` is not `+=`, and two doors into one derivation have to agree (2026-08-14)

Moving the day bucketing into SQL created a second way to compute the same
figures, and the hard part was never speed. A baseline that shifted when the
read path changed would make Syl's conclusions change for reasons nothing
recorded.

They did not agree, and the reason is not one anybody would guess: **SQLite's
`sum()` is Kahan-Babuska-Neumaier compensated summation** and a plain `+=` in
JavaScript is not. Over 5,000 values of mixed magnitude:

    sqlite  sum()   21716791915707.2929688
    js      `+=`    21716791915707.2968750
    js      KBN     21716791915707.2929688   <- identical to sqlite

`derive.ts` now sums the same way, so the two doors are equal by construction
rather than to a tolerance — a tolerance would have been a decision about how
much silent drift is acceptable, and there is no such quantity.

Three things had to be carried, not one, and each is a way the two could quietly
stop agreeing: the summation above; `dailyStatOf`, so `total`-versus-`mean` is
decided in exactly one function; and `percentileRank`, exported rather than
restated in SQL, because the day's quiet floor is the one figure the summary
uses that genuinely IS finer than a day.

**The test that pins the summation had to be built to expose it.** KBN and naive
agree on values of one magnitude, so 400 heart-rate readings between 48 and 120
do *not* separate them — a test written against his real shape would have passed
whichever summation was in place, and gone on passing after they diverged. The
fixture mixes magnitudes on purpose and says so.

### The runaway that wasn't — `syl-025`, 2026-08-14

The epic was planned on a mechanism that turned out not to exist, and measurement
corrected it three times in one night. The chat transcript was genuinely loading the
whole conversation and genuinely getting slower the longer he used it; both were real,
and **neither had the cause the spec gave.** What follows is worth more written down
than a spec that had been right first time.

#### What the spec said, and what was actually true

The spec named three defects that "conspire to defeat the paging that is there". The
load-bearing one, Defect A, was a self-retriggering load: `.onAppear` on the
`EarlierMessages` row fires when the row is *instantiated*, a rebuild re-instantiates it,
so each load triggered the next until the entire conversation was resident with nobody
touching the phone. Defect C was the anchor cancelling laziness, and the spec said A and
C **multiply**.

Measured, hosted in a real `UIWindow`, iOS 26.2 / Xcode 26.2, iPhone 17 simulator:

| rows built at first paint | window 50 | window 400 |
| --- | --- | --- |
| with `.defaultScrollAnchor(.bottom)` | 40 | 40 |
| without it | 6 | 6 |

The anchor costs a **fixed** 6.7x that does not scale with the window. It cannot multiply
with anything. And with the pre-fix `.onAppear` restored, on a 2,000-message transcript at
a page size of 50, watched throughout rather than sampled at the end:

    first paint, 2s idle           50 messages — no growth
    parked at the top for 2s      100 messages — exactly one page

**The runaway does not reproduce.** The spec's stated cause is dead. What almost certainly
happened is the mundane reading nobody proposed: he reached the top perhaps ten times over
some weeks, at 200 messages a step, and two thousand messages became resident. His
sentence — *"it looks like it loads and contains all of the previous messages"* — is
exactly as accurate under that reading, and needs no bug beyond the step size.

#### The rule that replaces it

`onAppear` on a lazy child means **realised**, and realisation is geometry. It is not
"became visible", it is not "was instantiated", and — this is the half that took three
tries — **a rebuild does not re-fire it.** A row whose identity survives a snapshot
reassignment is *updated*, not destroyed and recreated, so the load that rebuilds the
stack cannot re-trigger the row that started it.

That is why parking at the top for two seconds loads one page and stops. The row is
realised when he arrives at the top; the widen inserts older rows *below* it, so it is
still the first element and still realised; nothing derealises it; `onAppear` does not
fire again. **One arrival, one page** — which is the intended behaviour, and was all
along.

An intermediate version of this rule, arrived at during review and written into the bead,
said the discriminator was *position in the stack relative to the insertion point* — that
`EarlierMessages` sits above where rows are inserted and is therefore re-realised by every
widen. **That is wrong in its mechanism and the measurement above is what says so**: if
every widen re-realised the row, parking at the top would have looped, and it did not.
Position in the stack is a real corollary about *when* a row's realisation changes, but it
is not the load-bearing half. The load-bearing half is realisation versus rebuild.

The corollary still settles the case it was invented for. The foot sentinel at the end of
the same `LazyVStack` carries the identical two lines — `onAppear` sets `isAtBottom`,
`onDisappear` clears it — and it is **correct**, structurally rather than by luck: nothing
is ever inserted below the last element, so it changes distance from the viewport only
when he actually scrolls, which is precisely what `isAtBottom` means. Same two lines, and
the verdict differs.

#### What actually explains "worse the longer he uses her"

Two things compose, and neither is the runaway.

**The window has exactly one write in the entire tree.** `loader.limit += pageSize`, in
`ChatViewModel.widenTheWindow()`. There is no decrement, no reset, no assignment anywhere
else — grep it. `ChatViewModel` is constructed once, inside `openStore()`, which is called
from one place in `didFinishLaunching`; the view is an `@ObservedObject` observer that a
tab switch destroys and recreates while the model outlives it. So the window is monotonic
for the life of the **process**, and nothing short of killing the app brings it down.

**And `refresh()` was O(window) per event.** `MarkdownCache.blocks(for:)` allocated a fresh
N-entry dictionary on every call, copied every hit into it, and swapped it in — every entry
a cache hit, N hashed inserts anyway. `refresh()` runs on every arriving message, every
send, every foreground and every return to the tab. At a window that had grown to two
thousand, **one arriving message cost 2,001 dictionary writes.** It is now 1. An unchanged
reload went from 2,000 writes to 0; a reconciliation costs 2, one insert and one removal.

A monotonic window times an O(window) per-message cost is a symptom that gets monotonically
worse with use, which is what he reported. A fixed 6.7x cannot do that.

**The trap in fixing it is worth the paragraph.** `ChatSnapshot` carried the whole
`[SylID: [MarkdownBlock]]` map beside `blocksByGroup`, with a `blocks(for:)` accessor no
caller ever used. Swift dictionaries are copy-on-write, so a snapshot holding that map kept
the cache's storage referenced twice — and the next insert would have had to copy the entire
spine before writing one entry. Fixing the cache and leaving the retention would have left
the O(window) cost exactly where it was **for the one case that matters most, a message
arriving**, while every new counter reported success. A green probe measuring the wrong
storage is this repository's oldest failure mode wearing yet another hat.

What remains O(window) per refresh is the rest of `load()`: the read and decode, the
grouping, the row rhythm, and the per-group slice. Those cannot be memoised the way the
parse can — `MessageGrouping` merges adjacent same-role messages within a time gap, so a
group id can keep its identity while its *membership* changes, and caching on that id
without a membership key is a stale transcript, which is a worse bug than a slow one.
Making them incremental means teaching `load()` a delta instead of handing it a window.

**And typing rebuilt the transcript.** Measured on the same iPhone 17 / iOS 26.2, a
2,000-message transcript, nine keystrokes: **20 rows rebuilt per keystroke, now 0.**

SwiftUI invalidates a view when **any** published property of an object it observes
changes — not only the ones the view reads. `draft` was `@Published` on `ChatViewModel`,
and `ChatView` observes that model for the transcript, the presence ribbon and the
connection banner. So every character invalidated `ChatView.body` and the whole
`LazyVStack` beneath it: twenty to thirty message rows rebuilt to discover that a letter
had gone into a text field.

The fix is a whole observable object for one string (`ChatDraft`), and it is structural
rather than stylistic — the view model holds it as a plain `let`, and **reading a `let`
creates no subscription**, so `ChatView` can hand it to the composer without ever hearing
from it. `@State` inside `ChatComposer` was the smaller change and the worse one: the send
path needs the text and lives on the view model, so the draft would have to be handed back
through a closure per keystroke, and it would put the one piece of state a probe must
drive somewhere no test can reach. The isolation is a property of the type graph, not of
anyone remembering to be careful.

`ChatView` still re-runs its body on a presence frame and on an arriving message. Those
are about the transcript; a keystroke is not.

#### Three gate lessons, all of which had already been learned here

The `-scheme Syl` note three sections above — *every "the suite is green" in this session
counted 795 of 1094 tests* — recurred twice on 2026-08-14 in two different subsystems.

`ios/scripts/test.sh` runs three phases and is `set -e`. A merge on an epic branch removed
`height` from `HealthType` and left three assertions referencing it, so **the SylKit test
target did not compile** — and phases 2 and 3 were therefore never reached by anyone
working on that branch, for an entire evening. The only symptom was a compile error in a
health-metrics test that looks like somebody else's problem. The upstream fix's own commit
message names the shape exactly: *"three stale `height` assertions CI caught and my local
build did not."*

**A gate that stops early is not a gate that passed.** The rule at the top of `CLAUDE.md`
is about measurements needing a version stamp and a re-run; this is its sibling, and the
two met tonight: a stale measurement decided a spec, and a stalled gate hid the fact that
two thirds of the suite had not run while that spec was being executed. Read the phase
banners and the test counts, not the exit status — and when a run is green, ask what it
counted.

**The third is the general case of the other two, and it is the strongest lesson of the
epic: which tree was under the instrument?** Three instances in one repository, and the
last of them is the most instructive because of who made it.

1. **2026-08-10.** Nine failures appeared in the sealed reader path — the
   injection-containment tests among them — from one uncommitted line in a shared
   checkout. Nothing was broken. It was nearly reported as a security regression.
2. **2026-08-14, upstream.** *"three stale `height` assertions CI caught and my local
   build did not"* — a local tree that compiled because it was not the tree CI had.
3. **2026-08-14, this epic.** A reviewer refused to record the `20 → 0` result on the
   grounds that the suite contradicted it, having run the suite on a branch cut at
   `4abaea3` — which predates the commit that produced the result. The test was red
   because the fix was absent, not because the claim was false. The reviewer then
   compared against "the branch point" and got an identical number, which felt like
   corroboration and was two measurements of the same missing fix.

The reflex was right and is worth keeping: *do not write a number into the permanent
record that the suite currently contradicts.* The error was one question short. **Ask
whose suite, on which commit, before concluding a claim is unsupported** — a red test on a
branch that lacks the fix is evidence about the branch, not about the claim. `git
merge-base --is-ancestor <commit> HEAD` is the whole check, and it costs nothing.

A scheme that runs 795 of 1094, a gate that dies in phase one, and a branch that lacks the
fix are the same mistake wearing three faces: **confident measurement of the wrong
thing.** Every green in this file is a claim about a specific tree, and the tree is the
part nobody writes down.

#### The habit that found all of it

Every correction in this section came from the same move: **distrust your own green.**
The row census was written because a parse counter reported a cache working perfectly while
it rewrote two thousand entries around the avoided parse. The copy-on-write trap was found
because a cache that gets cheaper with nothing else changing usually means the cost moved
rather than left. The runaway was retired because someone hosted a real window and watched
it for two seconds instead of reasoning from a comment.

**And the habit has a blind spot, which the same night also demonstrated.** The two red
tests in the app target were checked by building a throwaway worktree at the branch point
and reproducing the identical numbers rather than assuming — careful, and *wrong for one
of them*, because both trees compared lacked the fix. Distrusting your own green does
nothing if you never ask which tree produced it. Rigour applied to the wrong artefact is
still confident and still wrong; it simply arrives with better evidence attached.

Four theories died tonight — the spec's, the reviewer's, the intermediate one written into
a bead, and the reviewer's second, that a result was unsupported when it was merely absent
from his branch. Every one was plausible. Every one was replaced by a number, and the last
one only after somebody asked *which tree did you measure?*

#### The rule is not the defence. Running the check is.

Every failure in `syl-025` has one shape, and it is not ignorance. In each case the
person **had the correct rule available and did not apply it to themselves**:

- The spec repeated a mechanism because it was written down, and the note was three days
  stale.
- A reviewer concluded a result was unsupported after running the suite on a branch that
  lacked the fix — then built a throwaway worktree, got the same wrong answer, and read
  the *agreement* as corroboration.
- The lead read a diff of a tree that had moved underneath him.
- The feature was reported complete off a green suite while two of its four states were
  reachable from no call site.
- And the closing example, which is the useful one: **a reviewer who had spent the night
  cataloguing "declared and ignored" defects added `LocalStore.sendingCount()` with no
  caller — in the same commit where he wrote that a `hasMore` nobody draws is the same
  defect as no `hasMore` at all.** He had named the pattern hours earlier, in writing,
  twice. It was caught by running a search, not by knowing better.

*Knowing the pattern did not stop anyone producing it. The only thing that caught it was
running the check rather than reasoning about whether the check was needed.*

So the checks are written here as procedures, not as advice.

**Which tree did you measure?** Before reporting that a claim is unsupported because a
test is red:

    git merge-base --is-ancestor <the-commit-that-produced-the-claim> HEAD

A red test on a branch that lacks the fix is evidence about the branch. Reproducing the
same number at the branch point is not corroboration — it is the same missing fix,
measured twice.

**Is it wired to anything?** Before reporting a feature complete, on any epic:

    # every declaration the epic added to production code
    git diff origin/main..HEAD --unified=0 -- <production-dir> \
      | grep -E '^\+' \
      | grep -oE '(struct|enum|final class|class) [A-Z][A-Za-z]+|func [a-z][A-Za-z]*\('

    # then, for each name, count references in PRODUCTION code only
    grep -rn "<name>" <production-dir>

Anything whose only production reference is its own definition is a candidate. Three
categories come out, and only the first is a defect:

- **Dead** — no consumer anywhere, tests included. `sendingCount()` was this.
- **A test seam** — no production consumer, test consumers, and a doc comment saying so.
  A decision, not an omission.
- **Internal** — consumed a line away inside its own type. Not dead.

Distinguishing the three is what makes the search trustworthy; reporting only its
conclusion is what makes it look like an opinion. Run it and paste the categories.

**What did the gate actually count?** A green suite is a claim about a specific tree and
a specific set of tests. `ios/scripts/test.sh` is `set -e` across three phases, so a
failure in phase one means phases two and three did not run at all — and the exit status
looks identical to a phase that ran and passed. Read the phase banners and the counts.

The general form, which is the whole of it: **every green is a claim about something.
Ask what.**

### A justification can describe a door that was never built (2026-08-18)

`show_him` requires a `renderName`, and the comment defending that requirement said:
*"A sending is her saying something in her own face; words with no face is an ordinary
message, and SHE ALREADY HAS A CONVERSATION FOR THOSE."*

She did not. The only way anything of hers reached the conversation was by **replying**
to something he said. Every unprompted thought she had — the insurance nudge, the dog
sitter, a correction about a heart rate she had invented — went out as a `remind_me` and
arrived wearing a reminder's clothes: an entry on his list plus a buzz, in a list of
things he had asked to be reminded of. Her own diagnosis, and she was precise about it a
day before anyone else noticed: *"my unprompted voice arrives wearing a reminder's
clothes, and the one door into the actual conversation has a video-shaped lock on it."*

**The requirement was right and its reason was false, and that combination is the hard
one to catch.** A wrong requirement fails; a wrong justification passes every test,
because nothing in a suite asserts the second clause of a sentence. It had sat there for
a week being read as evidence that the alternative existed, by people deciding whether to
build the alternative — which is the whole cost. `syl-0x1h` was raised twice by the
Commander before anyone read the comment as a claim rather than as a rationale.

The repair is the same shape as `syl-7ci` one layer up, and it is not "loosen the
requirement": it is **build the thing the comment assumed**. `tell_him` is `show_him`
minus the video leg, and `SendingService` now composes *through* `TellingService` rather
than beside it, so exactly one file in the service turns a thought of hers into a message
— which `chat-wiring.test.ts` now asserts by name.

**The generalisation: a comment that justifies a constraint by naming an alternative is
making a claim about the system, and it is the one kind of comment worth grepping for.**
"Use X instead" and "X already exists" are the same sentence, and only one of them is
checkable. If the alternative is a verb, a route or a file, name it in backticks — a
named thing can be searched for and found missing.

### Ninety cents of a face nobody could account for (2026-08-23)

Two live face sessions opened on the Commander's phone, 44 and 46 credits, $0.90, and
both were reaped. `last_activity_at` equalled `opened_at` **to the millisecond on both
rows**, which is the ledger saying `ask_syl` was never invoked once: she was never asked
anything. Every server-side signal was green — the service was healthy on the expected
commit, the sessions were created against her real avatar, the per-session credential was
minted, the provider cap was set, `GET /face/live` answered 200 on the tailnet, esm.sh
served the SDK, and no `face.rpc.attach_failed` was logged.

**The cause was a crash, and the crash report named it exactly**: `EXC_CRASH (SIGABRT)`,
`Termination Reason: TCC`, *"attempted to access privacy-sensitive data without a usage
description ... must contain an NSCameraUsageDescription key"*, four seconds after the
second session opened. The app was killed both times. Nothing was on his screen for any
of the two minutes each session then billed.

Four things are worth keeping, and only the first one is about the camera.

**1. `AvatarCall` is passed `video: false` and it makes no difference, because it is not
the avatar component asking.** Read out of the shipped bundle
(`@runwayml/avatars-react@0.17.0`, which carries livekit-client):
`DeviceManager.getDevices(kind)` calls `enumerateDevices()`, sees the empty labels every
browser returns before permission is granted, and unlocks them with

```js
getUserMedia({ video: kind !== 'audioinput' && kind !== 'audiooutput',
               audio: kind !== 'videoinput' && { deviceId: … } })
```

With no `kind`, that is `video: true`. **The camera is requested as a side effect of
asking what the microphones are called**, and no prop on the component reaches it. So the
fix is not a flag: `routes/face-page.ts` wraps `navigator.mediaDevices.getUserMedia`
*before* the SDK is imported, which puts it innermost — the adapter shims the bundle
installs wrap ours and delegate inward. Video is stripped and the strip is **reported**,
so "does the SDK ask for the camera" is a fact in the log after one press.

**2. iOS does not refuse an undeclared capture. It terminates the process.** That is why
there was no error to catch and no state left to report, and it is why the page now
reports `mic_requested` *before* the call rather than the outcome after it. A state
reported after the call can never describe the failure that kills the caller. The last
word on the row is where it died.

**3. The blindness was not a missing line, it was a missing subsystem.** Every face
component takes a `log` and defaults it to `console.info`, and `index.ts` passed **none of
them one**. So every face event — opened, ended, reaped, warmed, refused, attached — went
to stdout and therefore to `launchd-core.log`, while `syl.log` and `GET /logs`, the
surfaces an operator and an agent actually read, had nothing about her face in them at
all. This is the fourth instance of this epic's recurring defect: a complete, unit-tested
component whose only fault is that its call site does not pass what it declares.
`tests/integration/face-observability.test.ts` boots the real `bootstrap` and asks the
runtime where its lines go, because no unit suite can see this and no unit suite ever
could.

**4. And the attach path only logged on FAILURE**, so a healthy attach and an attach that
never ran produced the same record: nothing. **An absence that means "fine" and an absence
that means "never happened" must not look the same.** That single ambiguity is why the
diagnosis needed a crash report from the device rather than a query against our own log.

The double session is the same lesson wearing the client's clothes. `LiveFaceModel` guards
"one press is one session" correctly and **the guard is worth nothing across a crash**,
because the object holding it does not survive one. He pressed twice, got two live
billable sessions, and a crash loop would have opened one per attempt. `startSession` now
cuts and settles every live session *before* it creates the next — before, not after,
because after leaves the create-and-poll window with two meters running. A rule that lives
only in the client stops existing exactly when the client is the thing going wrong.

Finally, two clocks where there was one. The idle reaper's two minutes is right for a
conversation that has gone quiet and wrong for a face that was never on screen, and those
are different questions: `DEFAULT_UNCONFIRMED_TIMEOUT_MS` cuts a session whose client has
never reported `connected` and which has never been asked anything, at 45 seconds. The
accepted risk is stated in the code rather than hidden — a working face whose reports
cannot reach us is cut early — and it is narrow, because the report shares an origin and a
connection with the document it came from.

### The liveness signal nobody declared, and two corrections in one day (2026-08-23)

Four fixes, all correct on their own, and the day's real lesson is about what they did to
each other. Recorded because none of it is visible from any single file.

**HER FACE HAD NEVER ONCE ANSWERED A QUESTION.** Not that day — *ever*. The service log:
`face.ask` fourteen times, `face.ask.answered` zero, `face.ask.slow` fourteen. Runway's
tool ceiling is a hard 8s and turns on the `commander` lane were taking 7.8s to 30s. The
cause is one line of the log read sideways — notional turn cost, **$8.38 / $8.46 / $8.89 /
$9.32 on his lane against $0.43 everywhere else**. Twenty times the prompt.

That is the `commander`-thread bloat this document already records as *accepted* ("if it
causes bloat on that thread we can solve it later"). The ruling was right and the bill
came due somewhere nobody was watching: **the live face was costed on a 1,635ms warm turn
(spike `28746b5`) and that measurement had quietly stopped being true of the one lane the
face uses.** The existing note says load-bearing measurements against someone else's binary
need a version stamp and a re-run. This is the harder case — the measurement was of OUR
system, it was accurate when taken, and it decayed because of an accepted decision made
elsewhere for good reasons. **A measurement that a downstream feature is costed on needs to
name the conditions it holds under, or it becomes a claim about the future.**

**A LIVENESS SIGNAL THAT IS A SIDE EFFECT OF AN UNRELATED BEHAVIOUR.** `last_activity_at`
is the idle reaper's only input, and `touch()` had exactly one caller in the tree:
`ask-syl.ts`. Nothing anywhere declared "her calling the brain is how we know he is still
here" — it merely happened to be true. So when `57bde0e` correctly stopped her forwarding
every remark, it silently changed how long a session survives. **The better she got at
answering him herself, the faster the reaper would cut her off.** Two changes, each right,
jointly fatal; no test could catch it because neither is wrong.

The general shape: *an invariant that holds by coincidence of implementation is not an
invariant, and the coupling is invisible precisely because nobody wrote it down.* Where a
signal means something load-bearing, the thing that produces it must be the thing the
meaning refers to. Speech is the honest signal that a conversation is alive; a tool call
was a proxy that happened to correlate until it didn't.

**TWICE IN ONE DAY A CORRELATION WAS READ AS A CAUSE, and the second one was caught by an
agent rather than by me.** Both are worth stating because they are different traps.

1. *The last thing reported before a silence is not the cause of the silence.* Four
   sessions ended with `camera_blocked` as their final word, which read as "the camera
   fence broke it". But the fence and the reporting **shipped in the same commit**, so
   "nothing was reported before the fence" was guaranteed by construction and proved
   nothing at all. A confounded comparison that happens to point at a real defect is still
   a confounded comparison — the fence *did* have a latent bug, which made the wrong
   reasoning feel confirmed.
2. *Evidence gathered before a change cannot test that change.* The reaped sessions offered
   as proof of the heartbeat coupling were all from **hours before** the commit blamed for
   it. Worse, it inverts: before that commit she forwarded everything, so a session with no
   asks is a session nobody was talking to. **The rows were the reaper working correctly,
   cited as evidence of a bug.**

**REPORTING WHAT WE DID WITHOUT REPORTING WHAT CAME BACK** is what made trap 1 possible.
The fence logged that it stripped a request and never logged the outcome of the retried
one, so a refused microphone was indistinguishable from a page that stopped executing.
This is the same family as the note above about an attach path that only logged on failure:
**a telemetry point that records an action but not its result moves the blind spot one line
down and disguises it as a diagnosis.** Log the outcome, including the successful one.

**AND THE FIXES ARMED THE TRAP THEY DID NOT SPRING.** Every session that day was killed by
the client's 45s deadline, well short of the reaper's 120s — one missed it by four seconds.
So the heartbeat coupling was real, inevitable, and *had not yet fired*. Shipping the fixes
that let a session live past 45 seconds is precisely what would let it reach 120. **A latent
failure masked by an earlier failure becomes reachable the moment the earlier one is fixed**,
so the fix list has to be read as a whole rather than one item at a time.

One process note, self-inflicted and already written down elsewhere: the full gate was run
in a worktree while two agents were spawning `claude` subprocesses in it. Two real-turn
acceptance tests timed out at 120s, one of them a **security** test, and for a moment that
looked like a regression. `us6b` passes alone in 23s. The heavy pass runs alone for a
reason; creating the fleet load yourself and then measuring it is the same error as reading
a shared tree.

### Ask what the fix just made reachable, and re-derive the number (2026-08-23)

A companion to the entry above, which names the armed-trap idea in a paragraph and moves
on. The pattern deserves more than a paragraph, because by the end of the day it had
happened **four times in a row on one epic**, and because the thing that caught each one
was the same move every time.

**THE CHAIN, IN ORDER. Each fix was correct. Each one exposed the next.**

1. The page's **media fence** was fixed, which let sessions live long enough to reach the
   client's 45-second presentation deadline — so the deadline became the thing killing
   every session at 46s.
2. `57bde0e` stopped her **forwarding every remark**, which removed the only caller of
   `touch()` — so the idle reaper stopped being able to see a conversation at all.
3. `syl-chzl.3.6` gave the reaper a **heartbeat** on the per-session credential — so when
   the provider's five-minute cap expired that credential, it took the heartbeat with it,
   and a face that had announced its own ending could still be held alive by one more
   `note_he_spoke` landing.
4. `syl-chzl.4.7` gave the cap **an honest ending** — which is what made anyone finally
   ask what `heard()` does on an expired-but-still-open row. Nobody had tested it. It
   refuses, so the trap did not spring; but it was found by asking, not by a test that
   already existed.

Read as a list of fixes that is four wins. Read as a sequence it is one mechanism:
**every fix removes a failure that was masking the next one, so the fix list is also a
list of things about to become reachable for the first time.** The masking failure is
usually the fastest one — the 45-second client teardown hid a 120-second reaper which hid
a five-minute cap — so the traps surface in slowest-last order, which is exactly the order
in which nobody is still looking.

The habit this argues for is cheap and it is not "write more tests". It is one question,
asked after each fix and before shipping it: **what was this failure hiding, and is that
thing now reachable?** Every instance above was findable in minutes by asking it. None of
them was findable by running the suite, because in each case both sides were correct.

**THE OTHER HALF IS UNITS, AND IT IS THE ACTIONABLE ONE.** Three defects the same day were
caught not by reasoning but by someone re-deriving a number instead of repeating it:

- **861,739 tokens on his lane, never compacted in thirteen days.** The epic was costed on
  a 1,635ms warm turn. Nobody re-measured the lane the face actually uses until first-token
  latency was measured directly: 9,147-15,819ms at 861,739 tokens against 2,644-2,879ms at
  8,873. The old number was never wrong; it was answered under conditions that had gone.
- **`861,739 -> 0 tokens (861,739 saved)`.** A `/compact` turn reports no usage at all, so
  the ledger read the absence as zero and announced a total success while leaving the lane
  at its pre-sweep size — it would have re-compacted at 04:07, 05:07 and 06:07 every night.
  Found by measuring *after* the code was written and believed correct. **An absent
  measurement read as a zero is the most flattering possible lie**, and it is the same
  shape as the reaper's `NULL` cap, where "the provider never said" and "expired" had to be
  kept apart on purpose.
- **The 68% image share was BYTES.** In tokens the images are 11-18% and the conversation
  is 31-33% — the two units disagree by about four times. The walk over the transcript was
  careful; the units were assumed. It was one step from being reported to the Commander as
  evidence that his own no-second-thread ruling rested on a belief the data contradicts,
  when in fact a third of that thread is the conversation and his instinct was closer to
  right than the byte number made it look.

**The check that caught all three was re-deriving the quantity rather than re-reading the
claim about it.** That generalises past numbers. Two hypotheses about a flaky gate died the
same way in one evening: "the machine was quiet" was an inference from other agents having
stopped *committing*, which is not the same as their being idle; and "the live Syl service
is contending with the test's real turns" was answered by reading the service's own log,
which recorded **zero events across both failing windows**. Neither needed an experiment.
Both would have survived another round of argument.

So, concretely, before a number is quoted in a decision: **say what it is a count of, say
when it was taken, and say what would make it stop being true.** A measurement without
those three is a claim about the future wearing the clothes of a fact.

### A prop the component never destructures (`syl-chzl.10`, 2026-08-23)

The Commander, from TestFlight 0.13.0: *"she started talking a good 25 seconds before the
live video feed showed it — not sure if it was timing, or if when I scrolled down and up
again on the home screen, that triggered her live session to show."*

The design says one to two seconds. `onConnected` starts a one-second grace, the beat that
checks it runs once a second, and `playing` beats both. Nothing in that model can produce
twenty-five, so the model was wrong somewhere.

**`AvatarCall` has no `onConnected` and no `onDisconnected`.** From the declaration
published with `@runwayml/avatars-react@0.17.0` — the exact version the page imports — the
component destructures `avatarId`, `sessionId`, `sessionKey`, `credentials`, `connectUrl`,
`connect`, `baseUrl`, `audio`, `video`, `avatarImageUrl`, `onEnd`, `onError`,
`onClientEvent`, `children`, `initialScreenStream`, `__unstable_roomOptions` **and spreads
the rest onto a `div`**. We passed two handlers it does not take. React warns to a console
nobody on a phone can read, and drops them.

The blast radius is much larger than the two callbacks:

- `tell('connected')` never fired, so the grace never started.
- `watchTheMedia()` was reachable **only** from `onConnected`, so it never ran — which made
  `playing`, `autoplay_blocked` and `no_media` unreachable code in a shipped build.
- `onDisconnected` never fired, so `ended` never arrived.
- `say('')` never ran, so the page's own status line never cleared.

Presentation therefore always fell through to `LiveFace.readyDeadline` — **forty-five
seconds** — on the `reach >= sdk_loaded` branch, while `RoomAudioRenderer` played her from
the moment the audio track subscribed. He was not exaggerating; he was under-counting.

**The evidence was already in the database and nobody had queried it.** `face_sessions` in
`~/.syl/syl.db` keeps the last `client_state` per session. Every row on the Commander's
phone stops at `connecting`, `camera_blocked` or `left`. **No session has ever reported
`connected` or `playing`.** That is the exact fingerprint of a callback that does not
exist, sitting in a column added a day earlier for precisely this purpose. A telemetry
column is only worth what somebody reads out of it, and the first query anyone runs should
be *which of the words we publish have never once arrived* — a word that never appears is
either a state that never happens or a reporter that cannot fire, and both are findings.

Three general lessons:

- **A callback name is a wire format, and it is checked by nobody.** `--strict-mcp-config`,
  `noUncheckedIndexedAccess`, the whole gate — none of it can see a misspelt prop on a
  component loaded from a CDN at runtime. The page reads its lifecycle off
  `[data-avatar-status]` now, which is `useAvatarStatus()` rendered onto the DOM. **An
  attribute that is missing is visibly missing; a handler that is never called is
  indistinguishable from a thing that never happened.**
- **A watch reached only through a callback does not run when the callback is not real.**
  `watchHer()` is started unconditionally after `root.render`, so the observer's liveness
  does not depend on the thing it is observing.
- **His scroll theory was worth taking seriously and it does not hold.** Measured in
  `OccludedWebViewTests.testShouldKeepThePageRunningWhenItIsScrolledOffTheScreen`: a
  `WKWebView` scrolled three screens past the last visible point keeps `visible`, keeps its
  clocks and keeps playing. It could not arise structurally either — `HomeScreen.faceLayer`
  is a *sibling* of `homeStack`, so the scroll view carrying the day never contains it. He
  was scrolling when the forty-five seconds happened to elapse. **A user's theory about
  cause is data about timing, not about mechanism** — the coincidence he noticed was real
  and pointed at the right second.

#### Cover cannot decapitate her, and the arithmetic says so

The same day, in the other direction: the framing was moved from `object-fit: cover` to a
width-sized `contain` because he had reported she *"filled the phone brow to chin with no
head on her"*. That produced *"a sort of landscape mode live feed"* — a 221pt letterboxed
strip — and a second complaint.

**`cover` was never capable of the first defect.** Cover scales until both axes are
covered, so it binds on the axis the source is short of. A landscape source in a portrait
viewport is bound by HEIGHT: on a 393x852pt phone a 16:9 frame renders 1514x852, every row
of it on screen, 74% of the columns gone. The crop is purely horizontal, and you cannot
lose a hairline that way. Whatever removed the top of her head did it **before the frame
reached the document** — most likely the provider fitting her 1120x832 character portrait
into a 16:9 stream by trimming top and bottom.

So the fix for a provider-side crop was a CSS compromise that made her small *as well as*
cropped, and it was reached without doing the arithmetic. The page is now full-bleed
`cover`, the way the Bridge he named as the reference does it, and it **measures**
`videoWidth`/`videoHeight` off the element and sends them with `playing`. Every framing
rule this file has ever carried was written against "Runway streams 16:9", which nobody had
checked; the next argument about her crop gets a number off his phone instead of a comment.

#### Three things that only became visible once the cause was known

**The wrong frame outlives the wrong answer.** A morning went into *"the page goes silent
after `camera_blocked`"* — looking for something that had **stopped**. Nothing had stopped.
The states after that point were unreachable, so `camera_blocked` was the last word the
page was still *capable* of saying: the high-water mark of a working reporter, read as the
epitaph of a broken one. A fix shipped to make the camera fence report outcomes rather than
intentions, which is correct on its own terms and was aimed at a phantom. **A silence has
two explanations — something stopped, or nothing downstream was ever wired — and the second
leaves identical evidence while being invisible to every instrument pointed at the first.**

**The 45-second backstop is the only reason he has ever seen her face.** It was added that
morning on the principle that silence must never resolve to nothing, argued as a safety net
against a *fragile* report chain. The chain was not fragile; it was never connected. So for
a full day every session on his phone was presented by `LiveFace.readyDeadline` and by
nothing else. **A fallback justified by the wrong reason was carrying the entire feature.**
That is an argument for keeping it, not for retiring it now that the real signals work — it
is what stands behind the next vendor prop that silently does not exist, and there is now a
note on the constant saying so, because it reads as redundant belt-and-braces beside
`audible` and `playing`.

**And the SDK was imported unpinned**, which is what made the defect structurally
unprovable rather than merely unnoticed. `https://esm.sh/@runwayml/avatars-react?bundle…`
resolves to whatever the CDN calls latest, so the question *"does this component accept this
prop"* had no version to be asked about — and a page that bills twenty cents a minute had a
live dependency on somebody else's release process with no build step, no lockfile and no
install in between. It is pinned to `RUNWAY_AVATARS_VERSION` in all three specifiers now,
which is the precondition for the guard below rather than a tidy-up.

#### The guard: assert our props against the vendor's own declaration

`backend/tests/unit/face-page-vendor-props.test.ts` reads the SDK's published `index.d.ts`
— captured verbatim from the npm tarball by
`backend/scripts/capture-avatar-sdk-declaration.mjs` — and asserts that every prop the page
hands `AvatarCall` appears in the parameter list that component actually destructures.
Membership of the *destructured* list is the bar, not of `AvatarCallProps`: a prop that
falls into the `...props` rest is spread onto a `div`, which is harmless for `className` and
catastrophic for a handler.

Two ways it could have been worthless, both closed and both mutation-tested:

- **A fixture for a version nobody runs.** The fixture records the version it came from and
  the test compares it with the page's pin, so bumping one without re-capturing fails.
- **A regex that matches nothing.** Every extraction asserts non-empty against a name known
  to be present. This caught a real bug in the test's own parser on the first run — the
  prop scan returned `[]` and the guard said so instead of passing with no work to do.

Verified by mutation: reintroducing `onConnected` fails with *"the page passes `onConnected`
and AvatarCall@0.17.0 does not destructure it — it will be spread onto a div and silently do
nothing"*; bumping the pin without re-capturing fails; unpinning any one of the three
specifiers fails.

**This is the class, not the instance.** It is the sixth time in this epic something was
wired to nothing, and the first time the class is catchable. The general shape it shares
with the acceptance-helper leak found the same evening — a fake `claude` injected only when
a test remembers to ask — is **a protection that depends on the caller getting it right**.
Those are not protections; they are conventions with good intentions. The fix in both cases
is to make the check structural and let it fail loudly at the boundary.

#### The pin is a supply-chain control, and it is the only one we have

The pin above was landed as a correctness precondition — a declaration-based guard is
worthless unless the page is pinned to the declaration it read. That priced it wrong, and
the bigger half is this:

**`face-page.ts` holds `window.__sylFaceSession` — the session id AND the session key — in
the same JavaScript context as three scripts fetched at runtime from a third party.** No
lockfile, no build step, no integrity hash, no review between somebody else's release and a
live credential on the Commander's phone. It is the one place in this subsystem where an
outside party's code runs beside one of his secrets.

Everything else here is aimed at *us*. The broker exists so the page never holds the org
secret. The credential arrives by user script rather than by query string. `face-page.test.ts`
asserts the document reflects nothing from its URL and carries no credential in its source.
**All of that is defended against us and none of it was defended against `esm.sh`** — and
until this week the specifier had no version in it at all, so the code running next to his
session key was whatever the CDN chose to serve at the moment his phone asked.

What is actually available, measured against esm.sh on 2026-08-23 rather than assumed:

- **A pinned URL is served `cache-control: public, max-age=31536000, immutable`.** That is a
  promise about *caching*, made by the party that serves the bytes. A cold fetch on a phone
  that has never seen the URL gets whatever is served then. **An immutability header is not
  an integrity control**, and it is easy to read as one.
- **SRI does not reach a dynamic `import()`.** It works on `<link rel="modulepreload">` and
  on the stylesheet, but a preload whose hash fails is merely *discarded* — the import
  behind it then re-fetches with no check at all. A hash there is a hint, not a gate. The
  only mechanism covering the import itself is an import map with `integrity`, whose
  `WKWebView` support is unverified and must be measured before it is relied on.
- **The pin does not cover the graph.** `deps=react@18` resolves at esm.sh's discretion:
  today's response reports `react-dom@18.3.1,react@18.3.1` in its `x-esm-path`, chosen by
  them. `syl-chzl.12`.

So the pin removes the *silent* change and leaves the deliberate one. The real answer is a
same-origin bundle (`syl-chzl.13`), which Adjutant has already built for the reliability
reason (`backend/avatar-sdk-build/` → `backend/public/avatar-sdk.js`); we now have a better
one. When it lands, the prop guard gets stronger for free — the declaration can be read from
the installed package instead of a captured fixture.

#### The class: a contract with an outside party that nothing checks

Three defects in one evening, and they are one defect:

- **`onConnected`** — a prop the vendor does not accept. It type-checked, rendered, and did
  nothing.
- **`startLiveService`** — injects the fake `claude` only if a test remembers to pass
  `options.claude`. A test that supplies a `runner` instead spawns the real binary.
- **the SDK itself** — whatever the CDN felt like serving that day.

Each is *a protection that depends on the caller getting it right*, which is not a
protection but a convention with good intentions. They fail silently, they leave evidence
identical to "nothing happened", and every instrument we own is pointed at the wrong thing.
The prop-existence guard is the first mechanism against the class rather than an instance —
which is why the pin matters more than the bug that revealed it.

The generalisation worth keeping: **at every boundary with something we do not build, write
down what we believe the other side accepts, and let a test compare that belief with the
other side's own description of itself.** A comment is not a mechanism; a captured
declaration is.

#### A control that is real, adjacent, and does not cover the thing it appears to cover

The three answers about what actually protects the CDN import were measured, and **two of
them are the dangerous kind**: not wrong, but true about something narrower than they look.

- **`cache-control: … immutable` is not an integrity control.** It is a promise about
  *caching* — how long a client may reuse a response it already has — made by the party
  that serves the bytes. It says nothing about what a **cold** fetch returns, and every
  fetch on a phone that has not opened the page is cold. The word `immutable` in an HTTP
  header is a server describing its own intentions: not a hash, nobody checks it, nothing
  breaks if it is untrue. This was one sentence away from being written up as the answer
  and closing `syl-chzl.13` on it.
- **SRI does not reach a dynamic `import()`.** It is available on `modulepreload` and on
  the stylesheet, so it is entirely possible to add a hash, feel safer, and be wrong: a
  preload whose hash fails is *discarded*, and the import behind it re-fetches unchecked.
  The failure mode is not the missing check — it is that the next reviewer sees a hash and
  stops looking.

**The shared shape is worth more than either instance.** A control that is genuine, sits
right next to the hazard, and stops one step short of it is more dangerous than no control,
because it terminates the search. The question to ask of anything that looks like a
protection is not *is this real* but **what exactly does it cover, and is that the thing I
am worried about**. Both of these pass the first test and fail the second.

Related, and the reason the third finding matters: `deps=react@18` resolving to
`react-dom@18.3.1,react@18.3.1` at the CDN's discretion was read off a live response rather
than suspected, which is what turned `syl-chzl.12` from a hunch into a fact.

#### Two process findings from the same night

**A mutation that silently does not apply reports GREEN, and that is indistinguishable from
a test that does not bite.** Mutation-testing the exact-version assertion, one of four
mutants passed — and the cause was `perl` escaping, not a weak test: the substitution had
never landed. A mutant that never existed proves nothing and looks exactly like proof.
**Verify the mutation is in the file before believing what the run says about it** — one
`grep` for the mutated text, every time.

**An assertion can be answered by the file's own prose, and this repo is unusually exposed
to it.** Twice in `face-page.test.ts` in one evening: a whole-document `toContain` for
`object-fit: contain` was satisfied by the comment explaining why contain was removed, and
a scan for the pinned SDK version matched the camera fence's prose citation of the shipped
bundle. Both would have passed while checking nothing.

It is the house style that does it. Our comments name real identifiers and real URLs in
backticks *on purpose*, because a comment citing the thing it is about is the convention —
so the one codebase where the names are everywhere is the one where a text assertion finds
them. It is the same exposure that makes `git commit -m` eat our backticks, wearing a
different hat.

The rule: **an assertion about a mechanism must match the thing that implements the
mechanism, not the document that contains it.** Slice to the CSS rule, the call site, the
URL — and anchor on something only the real thing has (`https://esm.sh/`, an eight-space
indent, a `declare function` line). Then assert the slice is non-empty, or the narrowing
becomes its own way of checking nothing.

#### Upload state is decided by main, not by your branch

`f9eeed8`'s message says *"0.14.0 was never uploaded, so this is free."* **That is false and
the commit is already on `origin/main`**, so it is corrected here rather than rewritten —
history surgery to recover a message costs more than the message.

0.14.0 *was* uploaded: `3444c58` was pushed at 17:31, the TestFlight job logged
`0.14.0 has never been uploaded — shipping it` at 17:33:09 and
`Successfully uploaded the new binary` at 17:44:39. The bump to 0.15.0 remains correct; the
claim about why it was free was not.

The mechanism, since this will recur: **the job asks App Store Connect whether that version
already exists.** So the answer is a property of what reached `main` and of what is already
in App Store Connect — never of your own branch. A version you have already bumped past can
have shipped from a commit you did not push, while your working tree shows no sign of it.
Do not infer upload state from local history; ask, or read the workflow log.

### Load is the explanation that is always available (2026-08-23, later)

The resolution of the entry above, and the reason it is worth a section rather
than a line: **every wrong answer that evening was a plausible statement about
LOAD, and the true answer was a specific process nobody had looked for.**

A face session had died mid-conversation. The chase went: fleet load (three
agents were working) — dead, it failed again with the fleet idle, and got
twenty-five seconds *slower* while three other files got faster. Agent turn
activity — dead, same run. The live Syl service contending for the
subscription — dead, and killed the cheapest way available: its own log
recorded **zero events** across both failing windows, so there was nothing to
contend with and nobody had to take a live service down to find out. Rate
limiting — dead, the tests do not reach the real API at all. Position in the
run — dead, and the evidence for it had been *misread*: vitest orders files by
size, so the file believed to be running first was running second.

Five explanations, all about the environment, all wrong. **The machine is the
first thing to blame and the last thing to check, because it is the only
hypothesis that is always available and never quite disprovable.** What finally
worked was `process.getActiveResourcesInfo()` in a throwaway file sized to run
immediately after the suspect: eleven `ChildProcess` handles, and printing their
`spawnfile` named them — `/Users/…/.local/bin/claude`. The real binary, in the
test suite, eleven live copies, `killed=false`.

**The decoy is the part worth remembering.** A leaked-process hypothesis had
been offered and there *were* leaked processes: seven `syl-fake-claude` from
nine and fourteen days earlier, plus sixteen abandoned temp directories. Real,
unbounded, worth its own bead — and 0% CPU, 0% memory, about a minute of CPU
time each across a fortnight. Inert. Refusing it was correct and it is also
what fixed the search on the wrong string: the live processes were called
`claude`, and `grep syl-fake-claude` walked straight past them.
**The most dangerous hypothesis is not the wrong one. It is the one that is
true, adjacent, and irrelevant** — it survives scrutiny, satisfies whoever
proposed it, and quietly ends the search.

Two mechanisms came out of it, and both are the same shape as the traps above.

**An orphan is not a child that outlived its timeout. It is a child whose
timeout was cremated with its parent.** `runTurn` bounds a wedged CLI with
SIGTERM and then SIGKILL — correct, and unreachable in the case that happened,
because `setTimeout` lives in the parent. Kill the parent and the child is
reparented to `ppid 1` with no bound at all. Nobody found this by reading the
code, because the ladder is right there and looks fine; the bug is that nothing
calls it. The fix is a registry and `process.once("exit")`, and it is SIGKILL
rather than SIGTERM because the CLI ignores SIGTERM — measured, not assumed.

**A guard enforced by callers is not a guard.** `live-service.ts` said the tests
must never find the real CLI, and enforced it by every caller remembering to
pass a `claudeBin`. Forty-three of forty-six did not — not carelessly, but
because they injected a `runner` instead, which reads as "this test spawns
nothing" and is false: the runner covers the conversation turn and the
extraction turn escapes behind it. The rule moved to the one function that
reaches the real process. That is the third time this repository has written
that sentence down, after the reader's auto-memory and the reader's tool
surface, and the third instance is the one that should make it a habit rather
than a lesson.

**And the argument against bumping the tolerance, which came free.** The
timeout the suite was blowing had a comment deriving it from a real
measurement: the reference file took "~10s alone" against a 20s cap, so 6x left
headroom. Under the leak that file took 79.8s and the headroom was gone, and
the obvious fix — raise the cap — was refused because nobody could say *why*
the new number would be right. After the leak was fixed the file was back under
its original figure and the constant never moved. **The number was never wrong;
the suite had quietly stopped deserving it.** Raising it would have destroyed
the only evidence that anything was wrong, and that is the answer to every
"just increase the tolerance" proposal this project will ever receive.

### Make the rule fail (2026-08-23, the night's last lesson)

A rule that is only written down is the weakest thing you can build. The
evidence is one file: `compact-cli.test.ts`, written that night by an author who
**already knew** about the port collisions, who **wrote a comment saying two
helpers in this repo had already collided with that pool**, who then bound port
0 correctly — and who **kept a guess as the fallback anyway.** The sentence was
there, in the same file, in the same hand, in the same hour. It did not hold.

So: **make the rule fail, by whatever means the defect's shape allows.**

- **A scan, when the defect has a syntactic fingerprint.** `freePort` was
  greppable all along — arithmetic on `Math.random()` producing a port.
  `one-way-to-get-a-port.test.ts` and `quiet-window.test.ts` are this, and it is
  the strongest form available because it goes red rather than hoping to be read.
- **A behaviour test, when it has an observable consequence.** Most defects:
  the heartbeat coupling, the timeout nothing calls, a helper reaching the real
  CLI. None greppable; all catchable by asserting what should happen.
- **Prose, only when it has neither** — ordering, judgement, why a decision was
  made. Those genuinely cannot be tests, and `CLAUDE.md` is their right home.
  The failure is not writing a rule down; it is writing one down for a case
  that had a shape and could have been mechanised.

**And a fourth, for the defects whose signature is SILENCE.** These defeat a
naive behaviour test, because the thing you would assert — *no failure
occurred* — is exactly what the broken version produces:

    the gate comparing assertions          zero assertions compared clean
    the unattended job never loaded        no deploys looks like nothing to deploy
    the attach path logging only failure   healthy and never-ran both logged nothing
    a stub dying into `stdio: "ignore"`    forty seconds of nothing

**You cannot test for the absence of a failure when absence is the failure's own
signature.** Assert a positive trace instead: the job must log "nothing to
deploy", so that quiet proves it ran rather than proving nothing.

Two refinements, because the rule is easy to apply wastefully.

**First: most silence is information DISCARDED, not information absent.** Check
for an existing signal before manufacturing one. The gate did not need a new
trace — vitest was already emitting `status: "failed"` per file and the checker
was reading only `assertionResults`. The stub did not need a new channel — the
kernel was already reporting `EADDRINUSE` and `stdio: "ignore"` was throwing it
away.

In both cases **the information was destroyed by a line somebody wrote for a
good reason.** `assertionResults` is the natural field to read; `stdio: "ignore"`
is the natural thing to write for a stub. That is a nastier failure than an
absent signal, because the discarding line looks correct in isolation and only
the PAIR is wrong.

## Prefer the signal the other side already produces

Two agents reached this the same night, in different subsystems, without
contact, and the pair is worth more than either half.

From the observability side: **a signal the platform emits for you cannot be
forgotten, and one you must remember to emit can.** The kernel will report
`EADDRINUSE` whether or not anyone thought about it; a log line only exists if
someone wrote it and stays only if nobody tidies it away.

From the measurement side, working on compaction: context size must be read from
**the CLI's own usage block** (`ResultEvent.contextTokens`) and never counted
from our own model of the conversation, because *"that would be a consistency
check against ourselves"* — proved, because counting would have been wrong by
2.4x on a transcript with branches. **A value you derive yourself can only ever
check you against you.**

Same rule from two directions: **do not trust your own side of a boundary.**
Three of this night's lessons are really that one — this, the vendor-declaration
guard, and *ask the service, not the ledger*.

So the precedence is: **look for the discarded signal first, manufacture one
only when there is none — and either way, make something red when it goes
missing.**

**Second: a positive trace is only a mechanism if something FAILS when it is
missing.** `face.rpc.attached` now logs on success as well as failure, which is
a real improvement and is *still not a guard* — nothing asserts on it, so it
helps a human already reading the log and nobody else. A trace with no assertion
behind it is prose with a timestamp. Pair it with something that goes red, or be
honest that it is documentation.

**Footnote to the entry above, earned the same evening.** That entry says a
measurement must carry what it counts, when it was taken, and what would make it
stop being true. That is necessary and not sufficient: the deployed commit was
read honestly from `/api/v1/health` at 17:13, quoted at 18:0x as though current,
and was two deploys stale by then. **A timestamped measurement is not safe
either, if the person quoting it drops the timestamp.** The rule needs both
halves or it only protects whoever took the reading.

## Why mechanise it: two authors, one evening, both of them the expert

The argument for the scan is usually *people do not read comments*, and everyone
discounts that version because it sounds like a complaint about other people.
The real argument is narrower and much worse.

**Both of the night's rule-breaks were committed by the person best placed to
apply the rule, at the moment they were most focused on it.**

- The author of `compact-cli.test.ts` **knew.** They wrote a comment saying two
  helpers in this repo had already collided with that pool, bound port 0
  correctly — and kept a guess as the fallback. Same file, same hand, same hour.
- Whoever proposed the positive-trace rule **produced a trace nothing checks**,
  in the same message that proposed it. `face.rpc.attached` logs success and
  fails nothing; it is `syl-chzl.3.11`.

So **prose is weakest exactly where you would expect it to be strongest: with
the person who just wrote it, on the subject they are currently thinking
about.** If it does not hold there, expecting it to hold for a stranger reading
the file in six weeks is not caution. It is a false belief about how rules work.

It is not an attention problem and cannot be fixed by writing more clearly.
**Knowing a rule and applying a rule are different acts, and only one of them
can be automated.**

**What this does NOT license.** The prose still has to exist. Judgement,
ordering, the reason a decision went one way — those cannot be tests, and they
are most of what this document and `CLAUDE.md` are for. What it kills is the
idea that writing it down **discharges** the obligation. Write it down AND make
something red, wherever the shape permits.
