# Syl

A personal assistant harness that drives **Claude Code over its native
`stream-json` stdio protocol**, on subscription payment rails.

Named for Sylphrena, the honorspren.

Status: **walking skeleton**. The base layer is proven end to end; the assistant
itself (to-dos, reminders, digest, research) is not built yet.

## Why this shape

Three options were considered for the base layer between app and model:

| Approach | Verdict |
|---|---|
| Third-party harness calling the API directly (Hermes, OpenClaw embedded runtime, Isaac) | Rejected — API key billing, not subscription rails |
| ACP adapter into Claude Code | Rejected — a translation layer buying nothing; ACP exists for editor/agent interop and we are not an editor |
| **Drive the official `claude` binary over its native stdio JSON protocol** | **Chosen** |

The official CLI is what talks to Anthropic, using the existing `claude.ai`
login. Our code never touches credentials.

### Versus the tmux approach

Adjutant currently drives Claude Code by typing into a terminal
(`set-buffer` → `paste-buffer` → `send-keys`) and reading by capturing pane
text. Over stdio we get instead:

- typed events rather than text scraped out of ANSI escapes
- deterministic turn boundaries from the `result` message, rather than
  inferring completion from a pane going quiet
- real error fields — a billing failure arrives as `error: "billing_error"`
  instead of as pixels
- per-turn usage and cost accounting
- no timing races around paste delays

What is given up: there is no terminal to attach to, so human takeover of a
stuck session has to be built on the transcript rather than inherited free.

## Architecture

```
src/protocol.ts   pure codec — JSON lines <-> typed events. No I/O.
src/session.ts    runTurn(): one subprocess per turn
src/agent.ts      SylAgent: continuity across turns via --resume
src/cli/ping.ts   end-to-end smoke test
SOUL.md           standing orders, appended to the system prompt
```

The codec is deliberately I/O-free. The subtle bugs in this layer are wire-format
bugs — chunk boundaries, errors disguised as replies — and keeping them testable
without spawning a process is worth the seam.

### One process per turn

Measured on Claude Code 2.1.226: in `-p` mode with `--input-format stream-json`,
a turn does not complete until **stdin reaches EOF**. Holding the pipe open to
send a second message just stalls — verified by holding stdin open for 25s and
watching the turn complete only on close.

So a turn is: spawn → send one prompt → close stdin → read to completion.
Continuity comes from `--resume <sessionId>` against Claude Code's own session
store.

This lands well for an assistant: no daemon to supervise, a crash costs at most
the turn in flight, and a scheduled heartbeat is just another turn.

## Subscription rails

`runTurn` strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child
environment, and asserts that the init handshake reports `apiKeySource: "none"`.

This is not defensive padding. Anthropic's credential precedence puts a set API
key **ahead of** the `claude.ai` login unconditionally, so a stale exported key
silently moves billing onto the metered API. That failure was hit for real
during this spike and is filed as `adj-t64m9`.

## Verified

```
auth   apiKeySource=none              -> subscription rails
mcp    adjutant=connected             -> fleet bridge attaches automatically
turn   PONG                           -> round trip over stdio
resume Windrunners -> Windrunners     -> context survives across processes
```

## Usage

```sh
npm install
npm test          # 23 unit tests
npm run typecheck
npm run ping -- "your prompt"
```

## Not built yet

To-dos and objectives, the scheduler and heartbeat, comm channels, quiet hours,
the daily digest, and research briefs. See `adj-mzsbi` for the full plan and
`adj-itvob` for this spike.

## Prior art worth stealing

[Isaac](https://github.com/slagyr/isaac) (Clojure) is the closest analogue and
its design is good even though its LLM layer is direct-API and therefore
unsuitable here. Four ideas worth taking: **souls** (standing orders in a
markdown companion), **append-only transcripts with compaction**, **cron plus
heartbeat**, and **hail** — out-of-band cross-session interrupt delivery, which
is exactly the "reminder reaches you mid-task" problem.
