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
> Not yet acted on: `runTurn` still spawns per turn. See `syl-per1`.

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
