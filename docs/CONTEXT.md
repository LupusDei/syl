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

**Her memory read is one ROUTE, never the router.** `/memory` would have carried
`POST /memory/edges/{id}/feedback` with it, and an assistant that can confirm and
reject her own inferences can groom what she will be shown tomorrow — the `/logs`
argument, one layer in. `withinAgentSurface` matches on segment boundaries, which
is what makes a single-route entry a real boundary rather than a naming
convention. She can now read her own memory and still cannot write it, and that
asymmetry is the decision, not an unfinished half.

The repair is the same every time: make the claim a function of the thing it is
about. `advertisedTools()` from the handler map; `origin` from whether he spoke;
the capability sentence from the surface. **A stated property has a shelf life
and nothing announces its expiry.**

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
